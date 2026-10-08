import {
  readHostVersions,
  readObjectTree,
  wireDiagnosticsProviders,
  type DiagnosticsProvidersHost,
} from "./diagnostics-handler";
import type { DeviceManager } from "../device-manager";
import { createTestDevice } from "../../../test/test-helpers";

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
