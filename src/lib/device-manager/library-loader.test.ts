import { describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "../diagnostics";
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
    diagnostics: new DiagnosticsCollector(),
    runLimited: async (fn: () => Promise<void>): Promise<void> => fn(),
  };
}

function snapCap(options: Array<{ name: string; value: number }>): CloudCapability {
  return {
    type: "devices.capabilities.dynamic_scene",
    instance: "snapshot",
    parameters: { dataType: "ENUM", options },
  } as CloudCapability;
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
