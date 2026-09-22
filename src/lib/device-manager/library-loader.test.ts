import { describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "../diagnostics";
import { DeviceRegistry } from "../device-registry";
import { HttpError } from "../http-client";
import { createTestDevice, lightCapabilities } from "../test-helpers";
import type { CloudCapability, CloudDevice } from "../types";
import { loadDeviceLibraries, loadDeviceScenes, type LibraryLoaderHost } from "./library-loader";

const mockLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
} as unknown as ioBroker.Logger;

/**
 * Host fake: budget runner executes inline (the fire-and-queue semantics of
 * the real runLimited are covered by the rate-limiter suite), diagnostics is
 * the real collector so record calls can't drift from its API.
 */
function makeHost(cloudClient: unknown, apiClient: unknown = null): LibraryLoaderHost {
  return {
    cloudClient: cloudClient as never,
    apiClient: apiClient as never,
    log: mockLog,
    diagnostics: new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } })),
    runLimited: async (fn: () => Promise<void>): Promise<void> => fn(),
  };
}

function snapCap(options: Array<{ name: string; value: number }>): CloudCapability {
  return {
    type: "devices.capabilities.dynamic_scene",
    instance: "snapshot",
    parameters: { dataType: "ENUM", options },
  };
}

function setupMockCloud(snapshotsFromScenes: Array<{ name: string; value: number }>): unknown {
  return {
    getScenes: () =>
      Promise.resolve({
        lightScenes: [{ name: "Aurora", value: { id: 1 } }],
        diyScenes: [],
        snapshots: snapshotsFromScenes.map(s => ({ name: s.name, value: s.value })),
      }),
    getDiyScenes: () => Promise.resolve([]),
  };
}

function cdFor(capabilities: CloudCapability[]): CloudDevice {
  return {
    sku: "H6160",
    device: "AABBCCDDEEFF0011",
    deviceName: "Test Light",
    type: "devices.types.light",
    capabilities,
  };
}

describe("library-loader — loadDeviceScenes snapshot resolution (Issue #13)", () => {
  it("pulls newly-created snapshots from /user/devices when /device/scenes returns empty", async () => {
    const device = createTestDevice({ snapshots: [{ name: "OldSnap", value: 100 }] });
    const host = makeHost(setupMockCloud([]));
    const cd = cdFor([
      ...lightCapabilities(),
      snapCap([
        { name: "OldSnap", value: 100 },
        { name: "NewlyAdded", value: 200 },
      ]),
    ]);

    await loadDeviceScenes(host, device, cd);

    expect(device.snapshots).toHaveLength(2);
    expect(device.snapshots.map(s => s.name)).toEqual(["OldSnap", "NewlyAdded"]);
  });

  it("re-queries the dedicated DIY endpoint even when the DIY cache is non-empty (L2)", async () => {
    const device = createTestDevice({ diyScenes: [{ name: "OldDIY", value: { id: 100, paramId: "old" } }] });
    let diyCalls = 0;
    const host = makeHost({
      getScenes: () => Promise.resolve({ lightScenes: [], diyScenes: [], snapshots: [] }),
      getDiyScenes: () => {
        diyCalls += 1;
        return Promise.resolve([{ name: "NewDIY", value: { id: 200, paramId: "new" } }]);
      },
    });

    await loadDeviceScenes(host, device, cdFor(lightCapabilities()));

    expect(diyCalls).toBe(1);
    expect(device.diyScenes).toEqual([{ name: "NewDIY", value: { id: 200, paramId: "new" } }]);
  });

  it("preserves cached snapshots when /device/scenes is empty AND /user/devices has no snapshot capability", async () => {
    const device = createTestDevice({ snapshots: [{ name: "CachedSnap", value: 100 }] });
    const host = makeHost(setupMockCloud([]));
    const cd = cdFor(lightCapabilities().filter(c => c.instance !== "snapshot"));

    await loadDeviceScenes(host, device, cd);

    expect(device.snapshots).toHaveLength(1);
    expect(device.snapshots[0].name).toBe("CachedSnap");
  });

  it("clears the snapshot list when the user deleted everything in the Govee app", async () => {
    const device = createTestDevice({ snapshots: [{ name: "OldSnap", value: 100 }] });
    const host = makeHost(setupMockCloud([]));
    const cd = cdFor([...lightCapabilities(), snapCap([])]);

    await loadDeviceScenes(host, device, cd);

    expect(device.snapshots).toHaveLength(0);
  });

  it("/device/scenes returning snapshots wins over the capability fallback", async () => {
    const device = createTestDevice({ snapshots: [{ name: "OldSnap", value: 100 }] });
    const host = makeHost(
      setupMockCloud([
        { name: "FromScenesEndpoint1", value: 300 },
        { name: "FromScenesEndpoint2", value: 301 },
      ]),
    );
    const cd = cdFor([...lightCapabilities(), snapCap([{ name: "WouldBeIgnored", value: 999 }])]);

    await loadDeviceScenes(host, device, cd);

    expect(device.snapshots.map(s => s.name)).toEqual(["FromScenesEndpoint1", "FromScenesEndpoint2"]);
  });
});

describe("library-loader — loadDeviceLibraries", () => {
  it("returns false without an apiClient (LAN-only / no account)", async () => {
    const device = createTestDevice();
    const host = makeHost(setupMockCloud([]), null);
    expect(await loadDeviceLibraries(host, device, device.sku)).toBe(false);
  });

  it("force=true refetches snapshotBleCmds even when already cached (Issue #13 v2.8.2)", async () => {
    const device = createTestDevice({
      snapshots: [
        { name: "Snap1", value: 1 },
        { name: "Snap2", value: 2 },
      ],
      snapshotBleCmds: [[["STALE_CACHE_PACKET_A"]], [["STALE_CACHE_PACKET_B"]]],
    });

    let fetchSnapshotsCallCount = 0;
    const mockApi = {
      hasBearerToken: () => true,
      fetchSceneLibrary: () => Promise.resolve([]),
      fetchMusicLibrary: () => Promise.resolve([]),
      fetchDiyLibrary: () => Promise.resolve([]),
      fetchSkuFeatures: () => Promise.resolve(null),
      fetchSnapshots: () => {
        fetchSnapshotsCallCount++;
        return Promise.resolve([
          { name: "Snap1", bleCmds: [["FRESH_PACKET_1"]] },
          { name: "Snap2", bleCmds: [["FRESH_PACKET_2"]] },
        ]);
      },
    };
    const host = makeHost(setupMockCloud([]), mockApi);

    // Without force: the sticky gate must keep the cache untouched.
    await loadDeviceLibraries(host, device, device.sku, /* force */ false);
    expect(fetchSnapshotsCallCount).toBe(0);
    expect(device.snapshotBleCmds).toEqual([[["STALE_CACHE_PACKET_A"]], [["STALE_CACHE_PACKET_B"]]]);

    // With force: refetch and replace.
    await loadDeviceLibraries(host, device, device.sku, /* force */ true);
    expect(fetchSnapshotsCallCount).toBe(1);
    expect(device.snapshotBleCmds).toEqual([[["FRESH_PACKET_1"]], [["FRESH_PACKET_2"]]]);
  });
});

describe("library-loader — one library fetch per SKU and run, an empty answer remembered with an expiry (issue #46, 2026-09-22)", () => {
  // Eight bulbs of one SKU fetched the same three libraries eight times per
  // start, and an empty answer (music/DIY library `[]`, sku-features `null`)
  // was never remembered — every start repeated the calls to an endpoint the
  // loader's own comment asks to spare. Remembered WITH an expiry (7 days):
  // the #13 trap was "once empty, empty forever", not "remembered at all".
  function countingApi(): { api: unknown; calls: Record<string, number> } {
    const calls: Record<string, number> = { scene: 0, music: 0, diy: 0, features: 0 };
    return {
      calls,
      api: {
        hasBearerToken: () => true,
        fetchSceneLibrary: () => {
          calls.scene++;
          return Promise.resolve([{ name: "Sunrise", sceneCode: 1, scenceParam: "AA==" }]);
        },
        fetchMusicLibrary: () => {
          calls.music++;
          return Promise.resolve([]);
        },
        fetchDiyLibrary: () => {
          calls.diy++;
          return Promise.resolve([]);
        },
        fetchSkuFeatures: () => {
          calls.features++;
          return Promise.resolve(null);
        },
        fetchSnapshots: () => Promise.resolve([]),
      },
    };
  }

  it("skips an empty library while its check is fresh, fetches again once it expired, and always on force", async () => {
    const { api, calls } = countingApi();
    const host = makeHost(setupMockCloud([]), api);
    const now = Date.now();
    const fresh = createTestDevice({
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
      librariesCheckedAt: now - 60_000,
    });
    await loadDeviceLibraries(host, fresh, fresh.sku, false, now);
    expect(calls).toEqual({ scene: 0, music: 0, diy: 0, features: 0 }); // every empty library was confirmed empty a minute ago

    const expired = createTestDevice({
      sceneLibrary: [{ name: "Sunrise", sceneCode: 1, scenceParam: "AA==" }],
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
      librariesCheckedAt: now - 8 * 24 * 60 * 60 * 1000,
    });
    await loadDeviceLibraries(host, expired, expired.sku, false, now);
    expect(calls).toEqual({ scene: 0, music: 1, diy: 1, features: 1 }); // the filled scene library is kept, the empty ones are asked again

    await loadDeviceLibraries(host, expired, expired.sku, /* force */ true, now);
    expect(calls).toEqual({ scene: 1, music: 2, diy: 2, features: 2 });
  });

  it("devices of one SKU share one fetch per endpoint within a run — every device gets the library, a second run fetches again", async () => {
    const { api, calls } = countingApi();
    const run = new Map();
    const host = { ...makeHost(setupMockCloud([]), api), sharedFetches: run };
    const a = createTestDevice({ deviceId: "AA:01", sceneLibrary: [] });
    const b = createTestDevice({ deviceId: "AA:02", sceneLibrary: [] });
    const c = createTestDevice({ deviceId: "AA:03", sceneLibrary: [] });
    await Promise.all([
      loadDeviceLibraries(host, a, "H6160"),
      loadDeviceLibraries(host, b, "H6160"),
      loadDeviceLibraries(host, c, "H6160"),
    ]);
    expect(calls.scene).toBe(1);
    expect(a.sceneLibrary.map(s => s.name)).toEqual(["Sunrise"]);
    expect(b.sceneLibrary.map(s => s.name)).toEqual(["Sunrise"]);
    expect(c.sceneLibrary.map(s => s.name)).toEqual(["Sunrise"]);
    // Another SKU is another fetch; a new run map is a new fetch.
    const other = createTestDevice({ sku: "H6199", deviceId: "BB:01", sceneLibrary: [] });
    await loadDeviceLibraries(host, other, "H6199");
    expect(calls.scene).toBe(2);
    const d = createTestDevice({ deviceId: "AA:04", sceneLibrary: [] });
    await loadDeviceLibraries({ ...host, sharedFetches: new Map() }, d, "H6160");
    expect(calls.scene).toBe(3);
  });

  it("a failed shared fetch leaves every device of the SKU with what it had and rejects nothing", async () => {
    const { api } = countingApi();
    (api as { fetchSceneLibrary: () => Promise<unknown> }).fetchSceneLibrary = () =>
      Promise.reject(new HttpError("HTTP 500", 500, {}));
    const host = { ...makeHost(setupMockCloud([]), api), sharedFetches: new Map() };
    const a = createTestDevice({ deviceId: "AA:01", sceneLibrary: [{ name: "Old", sceneCode: 9, scenceParam: "" }] });
    const b = createTestDevice({ deviceId: "AA:02", sceneLibrary: [] });
    await expect(
      Promise.all([loadDeviceLibraries(host, a, "H6160", true), loadDeviceLibraries(host, b, "H6160", true)]),
    ).resolves.toEqual([false, false]);
    expect(a.sceneLibrary.map(s => s.name)).toEqual(["Old"]);
    expect(b.sceneLibrary).toEqual([]);
  });

  it("a shared fetch the limiter never ran marks every sharer as not checked", async () => {
    const { api, calls } = countingApi();
    const cancelled: string[] = [];
    const run = new Map();
    const base = makeHost(setupMockCloud([]), api);
    const hostFor = (id: string): LibraryLoaderHost => ({
      ...base,
      sharedFetches: run,
      runLimited: (): Promise<void> => Promise.resolve(), // the call is dropped — never runs
      noteCancelled: () => {
        cancelled.push(id);
      },
    });
    const a = createTestDevice({ deviceId: "AA:01", sceneLibrary: [] });
    const b = createTestDevice({ deviceId: "AA:02", sceneLibrary: [] });
    await Promise.all([loadDeviceLibraries(hostFor("a"), a, "H6160"), loadDeviceLibraries(hostFor("b"), b, "H6160")]);
    expect(calls.scene).toBe(0);
    expect(cancelled).toContain("a");
    expect(cancelled).toContain("b");
  });

  it("a dropped LIBRARY call reports the cancellation on its own — not only the sku-features one", () => {
    // The device already has its SKU features, so that branch is skipped: the
    // only call left is the library fetch. Its cancellation must still reach
    // the host, or the job stamps an answer it never got.
    const { api } = countingApi();
    const cancelled: string[] = [];
    const host: LibraryLoaderHost = {
      ...makeHost(setupMockCloud([]), api),
      sharedFetches: new Map(),
      runLimited: (): Promise<void> => Promise.resolve(), // dropped — never runs
      noteCancelled: () => {
        cancelled.push("x");
      },
    };
    const d = createTestDevice({ sceneLibrary: [], skuFeatures: { already: "there" } });
    return loadDeviceLibraries(host, d, "H6160").then(() => {
      expect(cancelled.length).toBeGreaterThan(0);
    });
  });
});

describe("library-loader — undocumented-API failures are diagnosable, not silent", () => {
  it("a rejected library fetch lands as one debug line with endpoint, status and bearer state, and in the diag history", async () => {
    const debugs: string[] = [];
    const log = { ...mockLog, debug: (m: string) => debugs.push(m) } as unknown as ioBroker.Logger;
    const diagnostics = new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } }));
    const host: LibraryLoaderHost = {
      cloudClient: setupMockCloud([]) as never,
      apiClient: {
        hasBearerToken: () => true,
        fetchSceneLibrary: () => Promise.reject(new HttpError("HTTP 403", 403, {}, "forbidden")),
        fetchMusicLibrary: () => Promise.resolve([]),
        fetchDiyLibrary: () => Promise.resolve([]),
        fetchSkuFeatures: () => Promise.resolve(null),
        fetchSnapshots: () => Promise.resolve([]),
      } as never,
      log,
      diagnostics,
      runLimited: async (fn: () => Promise<void>): Promise<void> => fn(),
    };
    const device = createTestDevice();

    await loadDeviceLibraries(host, device, device.sku, true);

    const line = debugs.find(m => m.startsWith("Could not load scene library for H6160"));
    expect(line).toBeDefined();
    expect(line).toContain("endpoint=/light-effect-libraries?sku=H6160");
    expect(line).toContain("httpStatus=403");
    expect(line).toContain("bearer=yes");
    expect(device.sceneLibrary).toEqual([]); // the old library is not replaced by garbage
    const hist = (await diagnostics.generate(device, "x")).apiHistory as Record<
      string,
      Array<{ ok: boolean; statusCode?: number }>
    >;
    expect(hist["/light-effect-libraries?sku=H6160"][0]).toMatchObject({ ok: false, statusCode: 403 });
  });

  it("quotes the body snippet when Govee answered 200 with a non-JSON page", async () => {
    const debugs: string[] = [];
    const log = { ...mockLog, debug: (m: string) => debugs.push(m) } as unknown as ioBroker.Logger;
    const host: LibraryLoaderHost = {
      cloudClient: setupMockCloud([]) as never,
      apiClient: {
        hasBearerToken: () => false,
        fetchSceneLibrary: () =>
          Promise.reject(
            new Error("Invalid JSON in HTTP 200 response: x — body starts with: <html>maintenance</html>"),
          ),
        fetchMusicLibrary: () => Promise.resolve([]),
        fetchDiyLibrary: () => Promise.resolve([]),
        fetchSkuFeatures: () => Promise.resolve(null),
        fetchSnapshots: () => Promise.resolve([]),
      } as never,
      log,
      diagnostics: new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } })),
      runLimited: async (fn: () => Promise<void>): Promise<void> => fn(),
    };
    await loadDeviceLibraries(host, createTestDevice(), "H6160", true);
    const line = debugs.find(m => m.startsWith("Could not load scene library"));
    expect(line).toContain('body="<html>maintenance</html>"');
    expect(line).toContain("bearer=no");
  });
});
