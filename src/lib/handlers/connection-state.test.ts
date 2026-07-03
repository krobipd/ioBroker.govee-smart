import { vi } from "vitest";

// checkAppVersionDrift calls the module-level httpsRequest (no DI) — mock it.
vi.mock("../http-client", () => ({ httpsRequest: vi.fn() }));

import {
  checkAllReady,
  checkAppVersionDrift,
  logDeviceSummary,
  reapStaleDevices,
  updateConnectionState,
  type ConnectionStateAdapter,
} from "./connection-state";
import { httpsRequest } from "../http-client";
import { GOVEE_APP_VERSION } from "../govee-constants";
import { sessionKey } from "../device-key";
import type { ChannelStatusSnapshot } from "../log-prefix";
import type { GoveeDevice } from "../types";
import { createTestDevice } from "../test-helpers";

const mockHttp = vi.mocked(httpsRequest);

interface Rig {
  adapter: ConnectionStateAdapter;
  stateWrites: Array<{ id: string; val: unknown }>;
  logs: Record<string, string[]>;
  saveToCacheCalls: number[];
  cleanupCalls: GoveeDevice[][];
  prunedWith: Array<Set<string>>;
}

function makeRig(opts: {
  devices?: GoveeDevice[];
  lanClient?: boolean;
  cloudClient?: boolean;
  cloudWasConnected?: boolean;
  mqttConnected?: boolean | null; // null = no mqtt client
  openapiConnected?: boolean | null;
  lanScanDone?: boolean;
  statesReady?: boolean;
  cloudInitDone?: boolean;
  appApiInitialPollDone?: boolean;
  needsAppApi?: boolean;
  channelStatus?: ChannelStatusSnapshot;
}): Rig {
  const stateWrites: Array<{ id: string; val: unknown }> = [];
  const logs: Record<string, string[]> = { debug: [], info: [], warn: [], error: [] };
  const saveToCacheCalls: number[] = [];
  const cleanupCalls: GoveeDevice[][] = [];
  const prunedWith: Array<Set<string>> = [];
  const devices = opts.devices ?? [];

  const adapter: ConnectionStateAdapter = {
    log: {
      debug: (m: string) => logs.debug.push(m),
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
      silly: () => {},
      level: "debug",
    } as ioBroker.Logger,
    deviceManager: {
      getDevices: () => devices,
      hasDeviceNeedingAppApi: () => opts.needsAppApi ?? false,
      saveDevicesToCache: () => saveToCacheCalls.push(1),
      getDiagnostics: () => ({
        pruneOrphans: (live: Set<string>) => prunedWith.push(live),
      }),
    } as never,
    cloudClient: opts.cloudClient ? ({ getFailureReason: () => "API key rejected" } as never) : null,
    cloudWasConnected: opts.cloudWasConnected ?? false,
    diagnosticsLastRun: new Map<string, number>(),
    mqttClient:
      opts.mqttConnected === null || opts.mqttConnected === undefined
        ? null
        : ({ connected: opts.mqttConnected, getFailureReason: () => "login rejected" } as never),
    openapiMqttClient:
      opts.openapiConnected === null || opts.openapiConnected === undefined
        ? null
        : ({ connected: opts.openapiConnected } as never),
    lanClient: opts.lanClient === false ? null : ({} as never),
    stateManager: {
      cleanupDevices: async (current: GoveeDevice[]) => {
        cleanupCalls.push(current);
        return [];
      },
    } as never,
    lanScanDone: opts.lanScanDone ?? true,
    statesReady: opts.statesReady ?? true,
    cloudInitDone: opts.cloudInitDone ?? true,
    appApiInitialPollDone: opts.appApiInitialPollDone ?? true,
    readyLogged: false,
    lastConnectionState: null,
    channelStatus: opts.channelStatus,
    setState: async (id, state) => {
      stateWrites.push({ id, val: (state as { val: unknown }).val });
      return undefined;
    },
  };
  return { adapter, stateWrites, logs, saveToCacheCalls, cleanupCalls, prunedWith };
}

describe("updateConnectionState", () => {
  it("connected=true when at least one device is online", () => {
    const online = createTestDevice({ state: { online: true } });
    const offline = createTestDevice({ deviceId: "BB:02", state: { online: false } });
    const rig = makeRig({ devices: [online, offline] });
    updateConnectionState(rig.adapter);
    expect(rig.stateWrites).toEqual([{ id: "info.connection", val: true }]);
  });

  it("a cloud-only Light counts as reachable while the Cloud is up (v2.13.0 contract)", () => {
    const cloudOnly = createTestDevice({
      lanIp: undefined,
      state: { online: false },
      channels: { lan: false, mqtt: false, cloud: true },
    });
    const rig = makeRig({ devices: [cloudOnly], cloudWasConnected: true });
    updateConnectionState(rig.adapter);
    expect(rig.stateWrites).toEqual([{ id: "info.connection", val: true }]);
  });

  it("without devices the LAN stack decides (bind error → false)", () => {
    const up = makeRig({ devices: [], lanClient: true });
    updateConnectionState(up.adapter);
    expect(up.stateWrites).toEqual([{ id: "info.connection", val: true }]);

    const down = makeRig({ devices: [], lanClient: false });
    updateConnectionState(down.adapter);
    expect(down.stateWrites).toEqual([{ id: "info.connection", val: false }]);
  });

  it("writes only on change — repeated evaluation with the same result is silent (H4)", () => {
    const online = createTestDevice({ state: { online: true } });
    const rig = makeRig({ devices: [online] });
    updateConnectionState(rig.adapter);
    updateConnectionState(rig.adapter);
    updateConnectionState(rig.adapter);
    expect(rig.stateWrites).toHaveLength(1);
  });

  it("syncs the log-prefix snapshot but never overrides 'n/a' (not-configured stays not-configured)", () => {
    const cs: ChannelStatusSnapshot = { lan: "off", cloud: "n/a", mqtt: "off", openapi: "n/a" };
    const rig = makeRig({
      devices: [createTestDevice({ state: { online: true } })],
      mqttConnected: true,
      cloudWasConnected: true,
      channelStatus: cs,
    });
    updateConnectionState(rig.adapter);
    expect(cs.lan).toBe("on");
    expect(cs.mqtt).toBe("on");
    expect(cs.cloud).toBe("n/a"); // configured-ness is decided once in onReady
    expect(cs.openapi).toBe("n/a");
  });
});

describe("checkAllReady", () => {
  it("logs ready + persists the cache exactly once when every gate is open", () => {
    const rig = makeRig({ devices: [createTestDevice()] });
    checkAllReady(rig.adapter);
    expect(rig.adapter.readyLogged).toBe(true);
    expect(rig.logs.info.some(m => m.includes("ready"))).toBe(true);
    expect(rig.saveToCacheCalls).toHaveLength(1);
    // Second call is a no-op — no double ready-log, no second cache save.
    checkAllReady(rig.adapter);
    expect(rig.saveToCacheCalls).toHaveLength(1);
  });

  it.each([
    ["lanScanDone", { lanScanDone: false }],
    ["statesReady", { statesReady: false }],
    ["cloudInitDone (with cloud client)", { cloudClient: true, cloudInitDone: false }],
    ["mqtt connected", { mqttConnected: false }],
    ["openapi connected", { openapiConnected: false }],
    ["appApi initial poll (with sensor device)", { needsAppApi: true, appApiInitialPollDone: false }],
  ] as Array<[string, Parameters<typeof makeRig>[0]]>)("gate blocks while %s is pending", (_name, opts) => {
    const rig = makeRig(opts);
    checkAllReady(rig.adapter);
    expect(rig.adapter.readyLogged).toBe(false);
    expect(rig.saveToCacheCalls).toHaveLength(0);
  });
});

describe("logDeviceSummary", () => {
  it("shows LAN ✗ with the enable-instructions warn + a per-device hint for every LAN-less light", () => {
    const noLan = createTestDevice({ lanIp: undefined });
    const rig = makeRig({ devices: [noLan] });
    logDeviceSummary(rig.adapter);
    expect(rig.logs.info.some(m => m.includes("LAN ✗"))).toBe(true);
    expect(rig.logs.warn.some(m => m.includes("Enable the local API"))).toBe(true);
    expect(rig.logs.info.some(m => m.includes(noLan.name))).toBe(true);
  });

  it("shows LAN ✓ when at least one light answers locally and lists only configured channels", () => {
    const lanLight = createTestDevice();
    const rig = makeRig({ devices: [lanLight] }); // no cloud/mqtt clients configured
    logDeviceSummary(rig.adapter);
    const ready = rig.logs.info.find(m => m.includes("ready"))!;
    expect(ready).toContain("LAN ✓");
    expect(ready).not.toContain("Cloud REST");
    expect(ready).not.toContain("Lights Push");
  });

  it("a failed channel gets its ✗ marker plus the concrete failure reason as warn", () => {
    const rig = makeRig({ devices: [createTestDevice()], cloudClient: true, cloudWasConnected: false });
    logDeviceSummary(rig.adapter);
    const ready = rig.logs.info.find(m => m.includes("ready"))!;
    expect(ready).toContain("Cloud REST ✗");
    expect(rig.logs.warn.some(m => m.includes("API key rejected"))).toBe(true);
  });
});

describe("reapStaleDevices", () => {
  it("cleans the object tree, prunes diag buffers and the throttle map down to live devices", async () => {
    const live = createTestDevice({ deviceId: "AA:01" });
    const rig = makeRig({ devices: [live] });
    rig.adapter.diagnosticsLastRun.set(sessionKey(live.sku, live.deviceId), 123);
    rig.adapter.diagnosticsLastRun.set(sessionKey("H9999", "GO:NE"), 456);

    await reapStaleDevices(rig.adapter);

    expect(rig.cleanupCalls).toEqual([[live]]);
    expect(rig.prunedWith[0].has("AA:01")).toBe(true);
    expect(rig.adapter.diagnosticsLastRun.has(sessionKey(live.sku, live.deviceId))).toBe(true);
    expect(rig.adapter.diagnosticsLastRun.has(sessionKey("H9999", "GO:NE"))).toBe(false);
  });
});

describe("checkAppVersionDrift", () => {
  // NOTE: no beforeEach(mockReset) here — vitest 4's mockReset drops the
  // handled-marker of stored rejected mock results, re-reporting an already
  // CAUGHT rejection as unhandled at test end. Each test installs its own
  // implementation, which is isolation enough.

  function itunesVersion(version: string): never {
    return { value: { resultCount: 1, results: [{ version }] }, statusCode: 200 } as never;
  }

  it("warns + flags STALE when the live app is more than 2 minor versions ahead", async () => {
    const [major, minor] = GOVEE_APP_VERSION.split(".").map(Number);
    mockHttp.mockResolvedValue(itunesVersion(`${major}.${minor + 3}.0`));
    const rig = makeRig({});
    await checkAppVersionDrift(rig.adapter);
    expect(rig.logs.warn.some(m => m.includes("app version drift"))).toBe(true);
    const write = rig.stateWrites.find(w => w.id === "info.appVersionDrift");
    expect(String(write?.val)).toContain("STALE");
  });

  it("stays quiet (debug + state only) while the local version is current", async () => {
    mockHttp.mockResolvedValue(itunesVersion(GOVEE_APP_VERSION));
    const rig = makeRig({});
    await checkAppVersionDrift(rig.adapter);
    expect(rig.logs.warn).toHaveLength(0);
    const write = rig.stateWrites.find(w => w.id === "info.appVersionDrift");
    expect(String(write?.val)).toContain("current");
  });

  it("network failures are silent debug — the daily check must never alarm the user", async () => {
    mockHttp.mockImplementation(async () => {
      throw new Error("ENOTFOUND itunes.apple.com");
    });
    const rig = makeRig({});
    await checkAppVersionDrift(rig.adapter);
    expect(rig.logs.warn).toHaveLength(0);
    expect(rig.logs.debug.some(m => m.includes("App version check failed"))).toBe(true);
  });

  it("ignores a malformed store response without writing the state", async () => {
    mockHttp.mockResolvedValue({ value: { results: [] }, statusCode: 200 } as never);
    const rig = makeRig({});
    await checkAppVersionDrift(rig.adapter);
    expect(rig.stateWrites).toHaveLength(0);
  });
});
