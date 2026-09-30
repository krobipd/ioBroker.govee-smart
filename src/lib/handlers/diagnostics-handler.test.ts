import {
  handleDiagnosticsExport,
  readHostVersions,
  readObjectTree,
  wireDiagnosticsProviders,
  type DiagnosticsHandlerAdapter,
  type DiagnosticsProvidersHost,
} from "./diagnostics-handler";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS } from "../timing-constants";
import { sessionKey } from "../device-key";
import type { DeviceManager } from "../device-manager";
import { createTestDevice, mockLog } from "../test-helpers";

function makeAdapter(): {
  adapter: DiagnosticsHandlerAdapter;
  writes: Array<{ id: string; val: unknown; ack: boolean }>;
} {
  const writes: Array<{ id: string; val: unknown; ack: boolean }> = [];
  // No file store on the surface, on purpose: 2.29.0–2.36.0 also wrote every
  // report into a `diagnostics` meta object at the root of the instance —
  // the copy nobody asked for. The contract no longer has a way to do that.
  return {
    writes,
    adapter: {
      log: mockLog,
      namespace: "govee-smart.0",
      version: "9.9.9",
      setState: (id, state) => {
        const s = state as { val: unknown; ack: boolean };
        writes.push({ id, val: s.val, ack: s.ack });
        return Promise.resolve();
      },
    },
  };
}

function makeDeviceManager(): { dm: DeviceManager; generateCalls: string[] } {
  const generateCalls: string[] = [];
  const dm = {
    generateDiagnostics: (device: { sku: string }, version: string) => {
      generateCalls.push(version);
      return Promise.resolve({ adapter: "iobroker.govee-smart", sku: device.sku });
    },
  } as unknown as DeviceManager;
  return { dm, generateCalls };
}

const device = createTestDevice();
const PREFIX = "devices.h6160_0011";
describe("handleDiagnosticsExport", () => {
  it("answers the report as text under its file name and stamps the datapoint", async () => {
    // The report measured 67,917 characters on an H61BE — past GitHub's issue
    // limit, so it could not be pasted into the issue it exists for, and as a
    // state value it sat in the state database and flowed through every
    // history subscription on the device. So it travels in the answer: the
    // card turns it into a download, and nothing is kept in the instance.
    const { adapter, writes } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const report = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);

    expect(generateCalls).toEqual(["9.9.9"]);
    expect(report).not.toBeNull();
    expect(JSON.parse(report!.content).sku).toBe("H6160");

    // The datapoint carries WHEN the report was taken. The name would say
    // nothing a moment later — the card hands the report over on the spot —
    // while "was a report taken since the fault?" stays answerable in the
    // object tree.
    const pointer = writes.find(w => w.id === `govee-smart.0.${PREFIX}.diag.lastExport`);
    expect(pointer?.ack).toBe(true);
    expect(pointer?.val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Neither predecessor is written any more: the fat report datapoint (≤2.28.0)
    // nor the file name (≤2.30.0).
    expect(writes.find(w => w.id.endsWith(".diag.result"))).toBeUndefined();
    expect(pointer?.val).not.toBe(report!.fileName);
    // And nothing writes to the button datapoint, which no longer exists.
    expect(writes.find(w => w.id.endsWith(".diag.export"))).toBeUndefined();
  });

  it("an app group gets its report but no stamp — its tree has no diag channel", async () => {
    // Measured on 2.39.2: exporting a group's report wrote
    // `groups.basegroup_1280.diag.lastExport`, and js-controller warned that the
    // state has no object.
    const { adapter, writes } = makeAdapter();
    const { dm } = makeDeviceManager();
    const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781280" });
    const report = await handleDiagnosticsExport(adapter, dm, new Map(), group, "groups.basegroup_1280");
    expect(report).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it("the file name tells a stranger which device it is about", async () => {
    // The recipient has none of our context, and a reporter with two Govee
    // devices attaches two of these.
    const { adapter } = makeAdapter();
    const { dm } = makeDeviceManager();
    const report = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(report?.fileName).toMatch(/^govee-smart_H6160_0011_v9\.9\.9_\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
  });

  it("the report warns that its markers do not travel between files", async () => {
    // The privacy statement itself lives at the export button (gsw_diagPrivacy,
    // 11 languages) where it decides whether to upload at all. What only the
    // file can say is that `device-1` in a second export is a different device.
    const { adapter } = makeAdapter();
    const dm = {
      generateDiagnostics: () =>
        Promise.resolve({
          readMe: { markers: "Markers (device-1, …) are stable INSIDE this file only" },
          sku: "H6160",
        }),
    } as unknown as DeviceManager;
    const report = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(JSON.parse(report!.content).readMe.markers).toContain("INSIDE this file only");
  });

  it("hands over exactly one copy — nothing is written anywhere", async () => {
    // Every write the handler makes goes through `setState`; a report that
    // lands anywhere else would need a method the surface does not offer.
    const { adapter, writes } = makeAdapter();
    const { dm } = makeDeviceManager();
    await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(writes.map(w => w.id)).toEqual([`govee-smart.0.${PREFIX}.diag.lastExport`]);
    expect("writeFileAsync" in adapter).toBe(false);
  });

  it("a failing export answers null and leaves the timestamp alone", async () => {
    // The card turns the null into its own error message; the datapoint must not
    // claim a report was taken when none was.
    const { adapter, writes } = makeAdapter();
    const dm = {
      generateDiagnostics: () => Promise.reject(new Error("object db down")),
    } as unknown as DeviceManager;
    const report = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(report).toBeNull();
    expect(writes.find(w => w.id.endsWith(".diag.lastExport"))).toBeUndefined();
  });

  it("throttles a second click inside the window — nothing generated, nothing stamped", async () => {
    const { adapter, writes } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS / 2);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);

    expect(generateCalls).toHaveLength(0);
    expect(writes.find(w => w.id.endsWith(".diag.lastExport"))).toBeUndefined();
  });

  it("allows a re-export once the throttle window has elapsed", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS - 1);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);
    expect(generateCalls).toHaveLength(1);
  });

  it("throttle is keyed per device — a second device exports immediately", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);

    const other = createTestDevice({ deviceId: "BB:22" });
    await handleDiagnosticsExport(adapter, dm, lastRun, other, "devices.h6160_bb22");
    expect(generateCalls).toHaveLength(2);
  });
});

describe("diagnostics providers — what the report reads from the running adapter", () => {
  function providersHost(overrides: Partial<DiagnosticsProvidersHost> = {}): {
    host: DiagnosticsProvidersHost;
    providers: Record<string, (...args: never[]) => unknown>;
  } {
    const providers: Record<string, (...args: never[]) => unknown> = {};
    const diag = new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (fn: (...args: never[]) => unknown): void => {
            providers[name] = fn;
          },
      },
    );
    const device = createTestDevice();
    const host: DiagnosticsProvidersHost = {
      namespace: "govee-smart.0",
      hostName: "iobroker-host",
      deviceManager: {
        getDiagnostics: () => diag,
        getDevices: () => [device],
        getErrorCategorySnapshot: () => ({ deviceManager: null, appApi: null, groupMembers: null }),
      } as unknown as DeviceManager,
      skuCache: { loadOne: (sku: string, id: string) => ({ sku, id }) } as never,
      localSnapshots: null,
      cloudClient: null,
      mqttClient: null,
      rateLimiter: null,
      lanClient: null,
      segmentWizard: null,
      channelStatus: { lan: "on", cloud: "n/a", mqtt: "n/a", openapi: "n/a" },
      hostVersions: { jsController: "7.2.2", admin: "8.0.14" },
      startedAt: Date.UTC(2026, 9, 1, 0, 0, 0),
      compactMode: true,
      getForeignObjectAsync: () => Promise.resolve(null),
      getObjectViewAsync: () => Promise.resolve(null),
      getStateAsync: () => Promise.resolve(null),
      ...overrides,
    };
    return { host, providers };
  }

  it("the environment names the installation — versions, compact mode, start time, credential tier", () => {
    const { host, providers } = providersHost();
    wireDiagnosticsProviders(host);
    const env = (providers.setEnvironmentProvider as () => Record<string, unknown>)();
    expect(env).toMatchObject({
      jsController: "7.2.2",
      admin: "8.0.14",
      compactMode: true,
      credentialTier: "lan",
      deviceCount: 1,
      startedAt: "2026-10-01T00:00:00.000Z",
      channels: { lan: "on", cloud: "n/a", mqtt: "n/a", openapi: "n/a" },
    });
  });

  it("the cache snapshot comes from the SKU cache of the instance", () => {
    const { host, providers } = providersHost();
    wireDiagnosticsProviders(host);
    expect((providers.setCacheSnapshotProvider as (s: string, d: string) => unknown)("H6160", "AA")).toEqual({
      sku: "H6160",
      id: "AA",
    });
  });

  it("reads the js-controller version of its own host and the admin version", async () => {
    const asked: string[] = [];
    const { host } = providersHost({
      getForeignObjectAsync: (id: string) => {
        asked.push(id);
        return Promise.resolve(
          (id === "system.host.iobroker-host"
            ? { common: { installedVersion: "7.2.2" } }
            : { common: { version: "8.0.14" } }) as unknown as ioBroker.Object,
        );
      },
    });
    expect(await readHostVersions(host)).toEqual({ jsController: "7.2.2", admin: "8.0.14" });
    expect(asked).toEqual(["system.host.iobroker-host", "system.adapter.admin"]);
  });

  it("a failed version read leaves the fields empty", async () => {
    const { host } = providersHost({ getForeignObjectAsync: () => Promise.reject(new Error("down")) });
    expect(await readHostVersions(host)).toEqual({ jsController: undefined, admin: undefined });
  });

  it("the object tree is ONE device prefix, ids relative to it, with the current value", async () => {
    const views: Array<{ startkey: string; endkey: string }> = [];
    const { host } = providersHost({
      getObjectViewAsync: (_d, _s, params) => {
        views.push(params);
        return Promise.resolve({
          rows: [
            {
              id: "govee-smart.0.devices.h6160-0011.control.power",
              value: { common: { type: "boolean", role: "switch", write: true } } as unknown as ioBroker.Object,
            },
          ],
        });
      },
      getStateAsync: () => Promise.resolve({ val: true, ack: true } as ioBroker.State),
    });
    expect(await readObjectTree(host, "devices.h6160-0011")).toEqual([
      { id: "control.power", type: "boolean", role: "switch", unit: undefined, write: true, val: true, ack: true },
    ]);
    expect(views[0].startkey).toBe("govee-smart.0.devices.h6160-0011.");
  });

  it("an unreadable tree is an empty list, not a failed report", async () => {
    const { host } = providersHost();
    expect(await readObjectTree(host, "devices.h6160-0011")).toEqual([]);
  });
});
