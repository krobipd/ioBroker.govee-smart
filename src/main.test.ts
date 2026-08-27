import { vi } from "vitest";
import * as os from "node:os";
import * as fsReal from "node:fs";
import * as pathReal from "node:path";

// ---------------------------------------------------------------------------
// adapter-core stub — must be installed BEFORE main is imported, otherwise the
// real module calls process.exit outside a js-controller. Mirrors the fleet
// harness (reference_orchestration_test_harness): a minimal Adapter base class
// carrying an in-memory object/state store, so the REAL StateManager /
// DeviceManager / SkuCache / LocalSnapshotStore can run against it. Only the
// network-facing collaborators are replaced via main.ts's factory seams.
// ---------------------------------------------------------------------------
const tmpRoot = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), "govee-main-test-"));
/**
 * Instance data directory handed to the adapter, swapped per setup() call.
 * Every test gets a fresh one: the SKU cache and the credentials file live
 * here, so a shared directory would let one test's leftovers change another
 * test's outcome — invisible in a green run, and it makes the mutation matrix
 * non-reproducible (a mutation reads as caught or survived by test order).
 */
let dataDirName = "instance-0";
/** Absolute path of the data dir the CURRENT test is using. */
function currentDataDir(): string {
  return pathReal.join(tmpRoot, dataDirName);
}
let dataDirSeq = 0;

vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "govee-smart.0";
    public adapterDir = "/tmp/govee-adapter";
    public version = "2.25.0";
    public config: Record<string, unknown> = {};
    /** In-memory object store — the real StateManager writes here. */
    public objects = new Map<string, Record<string, unknown>>();
    /** In-memory state store. */
    public states = new Map<string, { val: unknown; ack: boolean }>();
    /** meta.user file store used by LocalSnapshotStore. */
    public files = new Map<string, string>();
    public on = vi.fn();
    public subscribeStatesAsync = vi.fn(async () => {});
    public sendTo = vi.fn();
    public registerNotification = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}) as unknown);
    public clearTimeout = vi.fn();
    public delay = vi.fn(async () => {});
    public encrypt = (v: string): string => `enc:${v}`;
    public decrypt = (v: string): string => (v.startsWith("enc:") ? v.slice(4) : v);

    public setState = vi.fn(async (id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
    });
    public setStateAsync = this.setState;
    public setStateChangedAsync = vi.fn(async (id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
    });
    public getStateAsync = vi.fn(async (id: string) => this.states.get(id.replace(`${this.namespace}.`, "")) ?? null);
    public getState = this.getStateAsync;
    public extendObject = vi.fn(async (id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      const existing = this.objects.get(key) ?? {};
      this.objects.set(key, {
        ...existing,
        ...obj,
        common: { ...((existing.common as object) ?? {}), ...((obj.common as object) ?? {}) },
      });
    });
    public extendObjectAsync = this.extendObject;
    public setObjectNotExistsAsync = vi.fn(async (id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      if (!this.objects.has(key)) {
        this.objects.set(key, obj);
      }
    });
    public getObjectAsync = vi.fn(async (id: string) => this.objects.get(id.replace(`${this.namespace}.`, "")) ?? null);
    public delObjectAsync = vi.fn(async (id: string, opts?: { recursive?: boolean }) => {
      const key = id.replace(`${this.namespace}.`, "");
      if (opts?.recursive) {
        for (const k of [...this.objects.keys()]) {
          if (k === key || k.startsWith(`${key}.`)) {
            this.objects.delete(k);
          }
        }
      } else {
        this.objects.delete(key);
      }
    });
    public delStateAsync = vi.fn(async (id: string) => {
      this.states.delete(id.replace(`${this.namespace}.`, ""));
    });
    public getObjectViewAsync = vi.fn(async (_d: string, type: string, p: { startkey: string; endkey: string }) => {
      const prefix = p.startkey.replace(`${this.namespace}.`, "");
      const rows: Array<{ id: string; value: unknown }> = [];
      for (const [k, v] of this.objects) {
        if (k.startsWith(prefix) && (v as { type?: string }).type === type) {
          rows.push({ id: `${this.namespace}.${k}`, value: v });
        }
      }
      return { rows };
    });
    public getForeignObjectAsync = vi.fn(async () => ({ native: {} }));
    public extendForeignObjectAsync = vi.fn(async () => {});
    public readDirAsync = vi.fn(async () => [] as { file: string; isDir: boolean }[]);
    public readFileAsync = vi.fn(async (_meta: string, name: string) => {
      const f = this.files.get(name);
      if (f === undefined) {
        throw new Error("not found");
      }
      return { file: f };
    });
    public writeFileAsync = vi.fn(async (_meta: string, name: string, data: string | Buffer) => {
      this.files.set(name, typeof data === "string" ? data : data.toString("utf-8"));
    });
    public delFileAsync = vi.fn(async (_meta: string, name: string) => {
      this.files.delete(name);
    });
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    getAbsoluteInstanceDataDir: () => pathReal.join(tmpRoot, dataDirName),
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: (k: string) => ({ en: k }),
      translate: (k: string, ...args: (string | number)[]) => (args.length > 0 ? `${k}:${args.join(",")}` : k),
    },
  };
});

import { GoveeAdapter } from "./main";
import * as connectionState from "./lib/handlers/connection-state";
import { StateManager } from "./lib/state-manager";
import type { GoveeDevice } from "./lib/types";

beforeEach(() => {
  // Fresh instance data dir per test — see dataDirName above. Done here (not in
  // setup()) so a test can seed its cache BEFORE the adapter starts.
  dataDirName = `instance-${++dataDirSeq}`;
  fsReal.mkdirSync(currentDataDir(), { recursive: true });
});

afterAll(() => {
  fsReal.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Minimal fakes for the network collaborators main.ts builds via its seams. */
interface Fakes {
  lan: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    requestStatus: ReturnType<typeof vi.fn>;
    setSendHook: ReturnType<typeof vi.fn>;
    setStatusRecordHook: ReturnType<typeof vi.fn>;
    setScanRecordHook: ReturnType<typeof vi.fn>;
    getDiagSnapshot: ReturnType<typeof vi.fn>;
    onInterfaceError: ((m: string) => void) | null;
    onListenReady: (() => void) | null;
    /** Captured (onDiscovery, onStatus, intervalMs, iface) from start(). */
    startArgs: unknown[];
  };
  mqtt: Record<string, ReturnType<typeof vi.fn>> & { connected: boolean };
  openapi: Record<string, ReturnType<typeof vi.fn>> & { connected: boolean };
  cloud: Record<string, ReturnType<typeof vi.fn>>;
  api: Record<string, ReturnType<typeof vi.fn>>;
  limiter: Record<string, ReturnType<typeof vi.fn>>;
  /** Args each factory was called with — proves the wiring passes the config through. */
  calls: { mqtt: unknown[][]; cloud: unknown[][]; openapi: unknown[][]; limiter: unknown[][]; lan: unknown[][] };
}

/** Typed access to the private fields/methods the orchestration tests drive. */
function internalOf(adapter: GoveeAdapter): {
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  files: Map<string, string>;
  config: Record<string, unknown>;
  log: Record<"silly" | "debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  namespace: string;
  deviceManager: { getDevices(): GoveeDevice[]; [k: string]: unknown } | null;
  stateManager: {
    devicePrefix(d: GoveeDevice): string;
    markAllOffline(): Promise<string[]>;
    writeDeviceRollup(): Promise<{ total: number; online: number }>;
    [k: string]: unknown;
  } | null;
  lanClient: unknown;
  mqttClient: unknown;
  openapiMqttClient: unknown;
  cloudClient: unknown;
  rateLimiter: unknown;
  channelStatus: { lan: string; cloud: string; mqtt: string; openapi: string };
  lanScanDone: boolean;
  statesReady: boolean;
  cloudInitDone: boolean;
  appApiInitialPollDone: boolean;
  stateCreationQueue: Promise<void>[];
  readyLogged: boolean;
  cloudWasConnected: boolean;
  unloading: boolean;
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  clearStopInstanceFlag: () => Promise<boolean>;
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  onStateChange: (id: string, s: unknown) => Promise<void>;
  onMessage: (obj: unknown) => void;
  syncDevicesManually: () => Promise<void>;
  applyManualSegments: (d: GoveeDevice, mode: boolean, idx?: number[]) => Promise<void>;
  stateToCommand: (s: string) => string | null;
  buildMessageRouterHost: () => Record<string, unknown>;
} {
  return adapter as unknown as ReturnType<typeof internalOf>;
}

/** Let fire-and-forget promise chains settle. */
async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise(r => setImmediate(r));
  }
}

function makeDevice(o: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6172",
    deviceId: "AA:BB:CC:DD:EE:11",
    name: "Strip",
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: false },
    ...o,
  };
}

/** Build an adapter with fake network collaborators + a config. */
function setup(configOverrides: Record<string, unknown> = {}): { adapter: GoveeAdapter; f: Fakes } {
  const adapter = new GoveeAdapter();
  const i = internalOf(adapter);
  Object.assign(i.config, { networkInterface: "", experimentalQuirks: false }, configOverrides);

  const calls: Fakes["calls"] = { mqtt: [], cloud: [], openapi: [], limiter: [], lan: [] };
  const lan: Fakes["lan"] = {
    start: vi.fn((...args: unknown[]) => {
      lan.startArgs = args;
    }),
    stop: vi.fn(),
    requestStatus: vi.fn(),
    setSendHook: vi.fn(),
    setStatusRecordHook: vi.fn(),
    setScanRecordHook: vi.fn(),
    getDiagSnapshot: vi.fn(() => ({ seenDeviceIps: [], lastCommandSentMs: {} })),
    onInterfaceError: null,
    onListenReady: null,
    startArgs: [],
  };
  const mqtt = Object.assign(
    {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      setPacketHook: vi.fn(),
      setVerificationCode: vi.fn(),
      setOnVerificationConsumed: vi.fn(),
      setOnVerificationFailed: vi.fn(),
      setOnAuthFailed: vi.fn(),
      setOnLoginBlocked: vi.fn(),
      setPersistedCredentials: vi.fn(),
      setOnCredentialsRefresh: vi.fn(),
      getFailureReason: vi.fn(() => null),
    },
    { connected: false },
  );
  const openapi = Object.assign({ connect: vi.fn(), disconnect: vi.fn() }, { connected: false });
  const cloud = {
    getDevices: vi.fn(async () => []),
    getDeviceState: vi.fn(async () => []),
    setResponseHook: vi.fn(),
    getFailureReason: vi.fn(() => null),
  };
  const api = {
    setEmail: vi.fn(),
    setBearerToken: vi.fn(),
    hasBearerToken: vi.fn(() => false),
    fetchDeviceList: vi.fn(async () => []),
    fetchGroupMembers: vi.fn(async () => []),
  };
  const limiter = {
    start: vi.fn(),
    stop: vi.fn(),
    tryExecute: vi.fn(async (fn: () => Promise<void>) => {
      await fn();
      return true;
    }),
    executeTracked: vi.fn(async (fn: () => Promise<void>) => fn()),
    getUsageSnapshot: vi.fn(() => null),
  };

  const seams = adapter as unknown as Record<string, unknown>;
  seams.makeLanClient = (...args: unknown[]) => {
    calls.lan.push(args);
    return lan;
  };
  seams.makeMqttClient = (...args: unknown[]) => {
    calls.mqtt.push(args);
    return mqtt;
  };
  seams.makeOpenapiMqttClient = (...args: unknown[]) => {
    calls.openapi.push(args);
    return openapi;
  };
  seams.makeCloudClient = (...args: unknown[]) => {
    calls.cloud.push(args);
    return cloud;
  };
  seams.makeApiClient = () => api;
  seams.makeRateLimiter = (...args: unknown[]) => {
    calls.limiter.push(args);
    return limiter;
  };

  return { adapter, f: { lan, mqtt, openapi, cloud, api, limiter, calls } as unknown as Fakes };
}

async function setupReady(configOverrides: Record<string, unknown> = {}): Promise<{ adapter: GoveeAdapter; f: Fakes }> {
  const ctx = setup(configOverrides);
  await internalOf(ctx.adapter).onReady();
  return ctx;
}

// ===========================================================================
describe("GoveeAdapter onReady — channel wiring", () => {
  it("LAN-only start: no cloud, no MQTT, LAN listener armed", async () => {
    const { adapter, f } = await setupReady();
    const i = internalOf(adapter);
    expect(f.lan.start).toHaveBeenCalledTimes(1);
    expect(i.cloudClient).toBeNull();
    expect(i.mqttClient).toBeNull();
    expect(i.openapiMqttClient).toBeNull();
    // "n/a" = channel not configured at all; only "on"/"off" are flipped by
    // the connection-state pass. LAN is always configured, so it is "off"
    // (no device discovered yet), never "n/a" — see the next test for "on".
    expect(i.channelStatus).toEqual({ lan: "off", cloud: "n/a", mqtt: "n/a", openapi: "n/a" });
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("Starting (LAN)"));
  });

  it("a discovered online device flips the LAN channel to on", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    expect(i.channelStatus.lan).toBe("off");
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set(
      "H6172_aabbccddee11",
      makeDevice({ lanIp: "10.0.0.5", state: { online: true } }),
    );
    connectionState.updateConnectionState(
      adapter as unknown as Parameters<typeof connectionState.updateConnectionState>[0],
    );
    expect(i.channelStatus.lan).toBe("on");
    expect(i.states.get("info.connection")).toEqual({ val: true, ack: true });
    // All devices offline → the indicator must drop, LAN stack running or not.
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set(
      "H6172_aabbccddee11",
      makeDevice({ lanIp: "10.0.0.5", state: { online: false } }),
    );
    connectionState.updateConnectionState(
      adapter as unknown as Parameters<typeof connectionState.updateConnectionState>[0],
    );
    // channelStatus.lan tracks "LAN produced devices", not their online state —
    // it stays "on". The indicator follows the devices and drops to false.
    expect(i.channelStatus.lan).toBe("on");
    expect(i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("with an API key: cloud + cloud-events + rate limiter come up, budget passed through", async () => {
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    expect(i.cloudClient).not.toBeNull();
    expect(i.openapiMqttClient).not.toBeNull();
    expect(f.limiter.start).toHaveBeenCalled();
    // 8/min + 9000/day — the documented safety margin below Govee's 10/10000.
    expect(f.calls.limiter[0].slice(2)).toEqual([8, 9000]);
    // The fake cloud client comes up → the channel must report "on".
    expect(i.channelStatus.cloud).toBe("on");
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("Starting (LAN, Cloud)"));
  });

  it("account credentials are trimmed before the MQTT login (issue #39)", async () => {
    // A stray space in the settings must NOT start a login with junk data.
    const blank = await setupReady({ goveeEmail: "   ", goveePassword: "  " });
    expect(internalOf(blank.adapter).mqttClient).toBeNull();
    expect(blank.f.calls.mqtt).toHaveLength(0);

    const real = await setupReady({ goveeEmail: "a@b.c", goveePassword: "pw" });
    expect(internalOf(real.adapter).mqttClient).not.toBeNull();
    expect(real.f.calls.mqtt[0].slice(0, 2)).toEqual(["a@b.c", "pw"]);
  });

  it("warns about an API key that is not a UUID (typo / stale encryption)", async () => {
    const { adapter } = await setupReady({ apiKey: "not-a-uuid" });
    expect(internalOf(adapter).log.error).toHaveBeenCalledWith(
      expect.stringContaining("does not look like a valid key"),
    );
  });

  it("accepts a well-formed API key without the warning", async () => {
    const { adapter } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    expect(internalOf(adapter).log.error).not.toHaveBeenCalledWith(
      expect.stringContaining("does not look like a valid key"),
    );
  });

  it("initialises the four info states and clears a stale verification flag", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    // Seed the flag a previous run could have left behind — without this the
    // assertion below would also pass on an adapter that never writes the
    // state at all (the "already satisfied before the tested path ran" trap).
    i.states.set("info.verificationPending", { val: true, ack: true });
    await i.onReady();
    for (const id of ["info.mqttConnected", "info.cloudConnected", "info.openapiMqttConnected"]) {
      expect(i.states.get(id)).toEqual({ val: false, ack: true });
    }
    // Post-onReady value: updateConnectionState runs at the end of onReady.
    // Without devices the indicator follows the LAN stack (connection-state.ts
    // "Without devices: connected = true when the LAN stack is running").
    expect(i.states.get("info.connection")).toEqual({ val: true, ack: true });
    // A leftover `true` would keep the connection card's code field open forever.
    expect(i.states.get("info.verificationPending")).toEqual({ val: false, ack: true });
  });

  it("drops the three removed orphan objects on an upgraded install", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.objects.set("info.refresh_cloud_data", { type: "state" });
    i.objects.set("info.appVersionDrift", { type: "state" });
    i.objects.set("info.wizardStatus", { type: "state" });
    await i.onReady();
    expect(i.objects.has("info.refresh_cloud_data")).toBe(false);
    expect(i.objects.has("info.appVersionDrift")).toBe(false);
    expect(i.objects.has("info.wizardStatus")).toBe(false);
  });

  it("subscribes to device and group states", async () => {
    const { adapter } = await setupReady();
    const sub = (adapter as unknown as { subscribeStatesAsync: ReturnType<typeof vi.fn> }).subscribeStatesAsync;
    expect(sub.mock.calls.map(c => c[0])).toEqual(["devices.*", "groups.*"]);
  });

  it("logs the boot failure instead of crashing when a step throws", async () => {
    const { adapter, f } = setup();
    const i = internalOf(adapter);
    f.lan.start.mockImplementation(() => {
      throw new Error("socket exploded");
    });
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed"));
  });
});

describe("GoveeAdapter onReady — timers", () => {
  it("arms every recurring timer with its documented interval", async () => {
    const { adapter } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const intervals = internalOf(adapter).setInterval.mock.calls.map(c => c[1]);
    expect(intervals).toContain(2 * 60 * 1000); // App-API poll
    expect(intervals).toContain(20_000); // info.online sync
    expect(intervals).toContain(24 * 60 * 60 * 1000); // app-version refresh
  });

  it("the App-API poll callback really polls — and marks the initial poll done", async () => {
    // A test that only asserts setInterval was called leaves the recurring poll
    // completely unguarded (fleet lesson: parcelapp M8 / beszel M1).
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    f.api.hasBearerToken.mockReturnValue(true);
    // pollAppApi short-circuits unless a non-light device needs the App API —
    // without this the fetch below never happens and the assertion is empty.
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set(
      "H5179_aabbccddee22",
      makeDevice({ sku: "H5179", type: "devices.types.thermometer", deviceId: "AA:BB:CC:DD:EE:22" }),
    );

    // 1) the recurring interval callback must reach the client.
    const pollCall = i.setInterval.mock.calls.find(c => c[1] === 2 * 60 * 1000);
    expect(pollCall, "App-API poll interval must be armed").toBeDefined();
    f.api.fetchDeviceList.mockClear();
    (pollCall![0] as () => void)();
    await settle();
    expect(f.api.fetchDeviceList).toHaveBeenCalledTimes(1);

    // 2) the initial delayed poll is a SECOND, independent trigger — sensors
    // would stay offline for the first two minutes without it.
    const initialCall = i.setTimeout.mock.calls.find(c => c[1] === 5_000);
    expect(initialCall, "initial App-API poll must be armed").toBeDefined();
    f.api.fetchDeviceList.mockClear();
    (initialCall![0] as () => void)();
    await settle();
    expect(f.api.fetchDeviceList).toHaveBeenCalledTimes(1);
    expect(i.appApiInitialPollDone).toBe(true);
  });

  it("the online-sync callback re-evaluates every device's info.online", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", lastLanReplyAt: Date.now() });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    await (i.stateManager as unknown as { createInfoStates(d: GoveeDevice): Promise<void> }).createInfoStates(device);
    i.states.set("devices.h6172_ee11.info.online", { val: false, ack: true });

    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    (syncCall![0] as () => void)();
    await settle(5);
    expect(i.states.get("devices.h6172_ee11.info.online")?.val).toBe(true);
  });

  it("onUnload clears every timer, stops the sub-clients and always calls back", async () => {
    const { adapter, f } = await setupReady({
      apiKey: "12345678-1234-1234-1234-123456789abc",
      goveeEmail: "a@b.c",
      goveePassword: "pw",
    });
    const i = internalOf(adapter);
    i.clearInterval.mockClear();
    i.clearTimeout.mockClear();
    const cb = vi.fn();
    i.onUnload(cb);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(i.unloading).toBe(true);
    // 3 intervals (app-api poll, online sync, app-version) + the one-shot timers.
    expect(i.clearInterval.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(i.clearTimeout.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.lan.stop).toHaveBeenCalled();
    expect(f.mqtt.disconnect).toHaveBeenCalled();
    expect(f.openapi.disconnect).toHaveBeenCalled();
    expect(f.limiter.stop).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("onUnload still calls back when a sub-client throws", async () => {
    const { adapter, f } = await setupReady();
    const i = internalOf(adapter);
    f.lan.stop.mockImplementation(() => {
      throw new Error("already gone");
    });
    const cb = vi.fn();
    i.onUnload(cb);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a leftover stopInstance flag is corrected once and the startup stops there", async () => {
    // The entry lives in the manifest AND as a copy in the instance object; an update
    // merges and never removes, so without this the whole shutdown path stays dead on
    // every installation that once ran a version carrying it. Writing the object makes
    // the host restart us — carrying on would arm timers of a dying process.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValueOnce({
      common: { supportedMessages: { stopInstance: true } },
    });
    i.extendForeignObjectAsync.mockClear();
    i.setInterval.mockClear();

    await i.onReady();

    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith(`system.adapter.${i.namespace}`, {
      common: { supportedMessages: { stopInstance: false } },
    });
    expect(i.setInterval).not.toHaveBeenCalled();
  });

  it("no leftover flag means the startup carries on", async () => {
    // Writing on every start would restart the instance every start — a loop.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.extendForeignObjectAsync.mockClear();

    await i.onReady();

    expect(i.extendForeignObjectAsync).not.toHaveBeenCalledWith(
      `system.adapter.${i.namespace}`,
      expect.objectContaining({ common: expect.objectContaining({ supportedMessages: expect.anything() }) }),
    );
  });

  it("the startup marks everything offline before anything was asked", async () => {
    // After a crash no shutdown code ran at all — the previous run's values would
    // stand until the 20-second sync catches up, plus 90 seconds of reply timeout
    // for a LAN light.
    // onReady builds a FRESH state manager, so the spy goes on the prototype —
    // patching the existing instance would be discarded and prove nothing.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const marked = vi.spyOn(StateManager.prototype, "markAllOffline").mockResolvedValue([]);

    await i.onReady();

    expect(marked).toHaveBeenCalled();
    marked.mockRestore();
  });

  it("onUnload marks the devices offline, not just the connection flags", async () => {
    // Writing only the four connection flags leaves every device standing green.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const marked = vi.fn(async () => [] as string[]);
    i.stateManager!.markAllOffline = marked;

    i.onUnload(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(marked).toHaveBeenCalled();
  });

  it("the 20-second round refreshes the rollup right after the markers", async () => {
    // Derived from exactly the markers that were just re-evaluated, so the count
    // can never drift away from what the individual devices say.
    const { adapter, f } = await setupReady();
    const i = internalOf(adapter);
    const rollup = vi.fn(async () => ({ total: 0, online: 0 }));
    i.stateManager!.writeDeviceRollup = rollup;
    const tick = i.setInterval.mock.calls.map(c => c[0] as () => void);
    rollup.mockClear();

    for (const run of tick) {
      run();
    }
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(rollup).toHaveBeenCalled();
    void f;
  });

  it("onUnload writes the final states BEFORE it reports back", async () => {
    // Fire-and-forget plus an immediate callback loses the write: the process is
    // gone before the value reaches the database, and every device keeps standing
    // green in the object tree while the instance is switched off.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const order: string[] = [];
    const realSetState = adapter.setState.bind(adapter);
    adapter.setState = ((id: string, val: unknown) =>
      new Promise(resolve =>
        setTimeout(() => {
          order.push(`write:${id}`);
          void realSetState(id as never, val as never);
          resolve(undefined);
        }, 1),
      )) as unknown as typeof adapter.setState;

    i.onUnload(() => order.push("callback"));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(order[order.length - 1]).toBe("callback");
    expect(order).toContain("write:info.connection");
  });
});

describe("GoveeAdapter — LAN discovery wiring", () => {
  it("polls devStatus only while MQTT is down (no duplicate traffic)", async () => {
    const { adapter, f } = await setupReady({ goveeEmail: "a@b.c", goveePassword: "pw" });
    const onDiscovery = f.lan.startArgs[0] as (d: { ip: string; device: string; sku: string }) => void;

    f.mqtt.connected = false;
    onDiscovery({ ip: "10.0.0.5", device: "AA:BB:CC:DD:EE:11", sku: "H6172" });
    expect(f.lan.requestStatus).toHaveBeenCalledWith("10.0.0.5");

    f.lan.requestStatus.mockClear();
    f.mqtt.connected = true;
    onDiscovery({ ip: "10.0.0.6", device: "AA:BB:CC:DD:EE:22", sku: "H6172" });
    expect(f.lan.requestStatus).not.toHaveBeenCalled();
    void adapter;
  });

  it("the LAN-scan settle timer enables the account reconcile only afterwards", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const dm = i.deviceManager as unknown as { accountReconcileEnabled: boolean };
    expect(i.lanScanDone).toBe(false);
    expect(dm.accountReconcileEnabled).toBe(false);

    const scanTimer = i.setTimeout.mock.calls.find(c => c[1] === 3_000);
    expect(scanTimer, "LAN scan settle timer must be armed").toBeDefined();
    (scanTimer![0] as () => void)();
    expect(i.lanScanDone).toBe(true);
    expect(dm.accountReconcileEnabled).toBe(true);
  });

  it("a socket error on a pinned interface becomes a user-actionable problem", async () => {
    const { adapter, f } = await setupReady({ networkInterface: "192.168.1.9" });
    const i = internalOf(adapter);
    f.lan.onInterfaceError!("selected IP is gone");
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("LAN unavailable"));
    f.lan.onListenReady!();
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("LAN listening"));
  });
});

describe("GoveeAdapter — segment echo caps", () => {
  /** Wire a device into the real DeviceManager and return its state prefix. */
  async function withSegmentDevice(
    adapter: GoveeAdapter,
    segmentCount: number | undefined,
  ): Promise<{ device: GoveeDevice; prefix: string }> {
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", segmentCount });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    return { device, prefix: i.stateManager!.devicePrefix(device) };
  }

  it("drops batch echo indices above the learned physical count", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const { device, prefix } = await withSegmentDevice(adapter, 3);
    // DeviceManager exposes onSegmentBatchUpdate as a write-only setter that
    // forwards into the CommandRouter — read the installed callback from there.
    const router = (
      i.deviceManager as unknown as {
        commandRouter: {
          onSegmentBatchUpdate?: (
            d: GoveeDevice,
            b: { segments: number[]; color?: number; brightness?: number },
          ) => void;
        };
      }
    ).commandRouter;
    router.onSegmentBatchUpdate!(device, { segments: [0, 2, 7, 40], color: 0xff0000, brightness: 50 });
    await settle();
    expect(i.states.has(`${prefix}.segments.0.color`)).toBe(true);
    expect(i.states.has(`${prefix}.segments.2.color`)).toBe(true);
    // 7 and 40 are above the real strip length — writing them produces the
    // js-controller "has no existing object" WARN for every echo index.
    expect(i.states.has(`${prefix}.segments.7.color`)).toBe(false);
    expect(i.states.has(`${prefix}.segments.40.color`)).toBe(false);
  });

  it("writes nothing at all while the physical count is still unknown", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const { device, prefix } = await withSegmentDevice(adapter, undefined);
    const router = (
      i.deviceManager as unknown as {
        commandRouter: { onSegmentBatchUpdate?: (d: GoveeDevice, b: { segments: number[]; color?: number }) => void };
      }
    ).commandRouter;
    router.onSegmentBatchUpdate!(device, { segments: [0, 1], color: 0x00ff00 });
    await settle();
    expect([...i.states.keys()].filter(k => k.startsWith(`${prefix}.segments.`))).toEqual([]);
  });

  it("applies the same cap to the MQTT per-segment push", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const { device, prefix } = await withSegmentDevice(adapter, 2);
    const dm = i.deviceManager as unknown as {
      onMqttSegmentUpdate: (
        d: GoveeDevice,
        s: { index: number; brightness: number; r: number; g: number; b: number }[],
      ) => void;
    };
    dm.onMqttSegmentUpdate(device, [
      { index: 0, brightness: 80, r: 255, g: 0, b: 0 },
      { index: 5, brightness: 80, r: 0, g: 255, b: 0 },
    ]);
    await settle();
    expect(i.states.get(`${prefix}.segments.0.color`)?.val).toBe("#ff0000");
    expect(i.states.has(`${prefix}.segments.5.color`)).toBe(false);
  });
});

describe("GoveeAdapter — gateway sensors", () => {
  it("never writes info.ip for a gateway-connected sensor", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const sensor = makeDevice({
      sku: "H5109",
      deviceId: "11:22:33:44:55:66",
      type: "devices.types.thermometer",
      gateway: "H5042 (ihoment_H5042_3795)",
    });
    const dm = i.deviceManager as unknown as { onLanIpChanged: (d: GoveeDevice, ip: string) => void };
    dm.onLanIpChanged(sensor, "10.0.0.9");
    await settle();
    const prefix = i.stateManager!.devicePrefix(sensor);
    // A gateway sensor shows info.gateway; an info.ip value here would be an
    // orphan (the state object does not exist for this device).
    expect(i.states.has(`${prefix}.info.ip`)).toBe(false);
  });

  it("writes info.ip for a normal LAN device", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const light = makeDevice();
    const dm = i.deviceManager as unknown as { onLanIpChanged: (d: GoveeDevice, ip: string) => void };
    dm.onLanIpChanged(light, "10.0.0.5");
    await settle();
    expect(i.states.get(`${i.stateManager!.devicePrefix(light)}.info.ip`)?.val).toBe("10.0.0.5");
  });
});

describe("GoveeAdapter — message handling", () => {
  it("answers an unknown sendTo command instead of leaving the caller hanging", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.onMessage({ command: "totallyUnknown", from: "system.adapter.admin.0", callback: { id: 1 } });
    await settle();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "totallyUnknown",
      expect.objectContaining({ error: expect.stringContaining("Unknown command") }),
      expect.anything(),
    );
  });

  it("stays silent when the message carries no callback (broadcast)", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.onMessage({ command: "totallyUnknown", from: "system.adapter.admin.0" });
    await settle();
    expect(i.sendTo).not.toHaveBeenCalled();
  });

  it("the segment-device list offers only online devices that actually have segments", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const devices = (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices;
    devices.set("a", makeDevice({ deviceId: "a", name: "WithSegments", segmentCount: 10 }));
    devices.set("b", makeDevice({ deviceId: "b", name: "NoSegments", segmentCount: 0 }));
    devices.set("c", makeDevice({ deviceId: "c", name: "Offline", segmentCount: 5, state: { online: false } }));
    devices.set("d", makeDevice({ deviceId: "d", sku: "BaseGroup", name: "Group", segmentCount: 5 }));

    const host = i.buildMessageRouterHost();
    const list = (host.getSegmentDeviceList as () => { value: string; label: string }[])();
    expect(list.map(e => e.value)).toEqual(["H6172:a"]);
  });

  it("a sendTo response is only sent when the caller expects one", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const host = i.buildMessageRouterHost();
    const send = host.sendResponse as (obj: unknown, data: unknown) => void;

    send({ command: "x", from: "system.adapter.admin.0", callback: { id: 1 } }, { ok: true });
    expect(i.sendTo).toHaveBeenCalledTimes(1);

    i.sendTo.mockClear();
    send({ command: "x", from: "system.adapter.admin.0" }, { ok: true });
    send({ command: "x", callback: { id: 1 } }, { ok: true });
    expect(i.sendTo).not.toHaveBeenCalled();
  });
});

describe("GoveeAdapter — manual segments + manual sync", () => {
  it("applyManualSegments stores the indices and rebuilds the segment tree", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const device = makeDevice({ segmentCount: 6 });
    await i.applyManualSegments(device, true, [0, 1, 4]);
    expect(device.manualMode).toBe(true);
    expect(device.manualSegments).toEqual([0, 1, 4]);
    const prefix = i.stateManager!.devicePrefix(device);
    expect(i.states.get(`${prefix}.segments.manual_mode`)?.val).toBe(true);
    expect(i.states.get(`${prefix}.segments.manual_list`)?.val).toBe("0,1,4");
    // Gap index 2/3/5 must not exist as a channel.
    expect(i.objects.has(`${prefix}.segments.2`)).toBe(false);
    expect(i.objects.has(`${prefix}.segments.4`)).toBe(true);
  });

  it("turning manual mode off clears the list", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const device = makeDevice({ segmentCount: 3, manualMode: true, manualSegments: [0, 2] });
    await i.applyManualSegments(device, false);
    expect(device.manualMode).toBe(false);
    expect(device.manualSegments).toBeUndefined();
    const prefix = i.stateManager!.devicePrefix(device);
    expect(i.states.get(`${prefix}.segments.manual_list`)?.val).toBe("");
  });

  it("the manual-sync button reports a failed account refresh instead of failing silently", async () => {
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    f.cloud.getDevices.mockRejectedValue(new Error("network down"));
    i.log.warn.mockClear();
    await i.syncDevicesManually();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Manual device sync failed"));
  });

  it("stateToCommand maps plain suffixes and dynamic segment indices", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    expect(i.stateToCommand("control.power")).toBe("power");
    expect(i.stateToCommand("segments.7.color")).toBe("segmentColor:7");
    expect(i.stateToCommand("segments.7.brightness")).toBe("segmentBrightness:7");
    expect(i.stateToCommand("nope.nothing")).toBeNull();
  });
});

describe("GoveeAdapter — state-change boundary", () => {
  it("a crashing state-change handler is caught and logged, not thrown", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5" });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    const prefix = i.stateManager!.devicePrefix(device);
    // Blow up inside the router (not at a call site that has its own catch) —
    // the boundary in main.onStateChange must turn it into one warn line.
    (i.stateManager as unknown as { devicePrefix: unknown }).devicePrefix = () => {
      throw new Error("objects db down");
    };
    await i.onStateChange(`${i.namespace}.${prefix}.control.power`, { val: true, ack: false });
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("onStateChange crashed"));
  });
});

describe("GoveeAdapter onReady — state-creation drain", () => {
  it("waits for state-creation promises that are queued WHILE it is draining", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    let secondBatchRan = false;
    let statesReadyDuringSecondBatch: boolean | null = null;

    // A late LAN discovery pushes a fresh promise into the queue while onReady
    // awaits the first batch. A single Promise.all would flip statesReady with
    // that work still pending → an incomplete initial state tree.
    i.stateCreationQueue.push(
      Promise.resolve().then(() => {
        i.stateCreationQueue.push(
          new Promise<void>(resolve =>
            setTimeout(() => {
              secondBatchRan = true;
              statesReadyDuringSecondBatch = i.statesReady;
              resolve();
            }, 0),
          ),
        );
      }),
    );

    await i.onReady();
    expect(secondBatchRan).toBe(true);
    expect(statesReadyDuringSecondBatch).toBe(false);
    expect(i.statesReady).toBe(true);
    expect(i.stateCreationQueue).toHaveLength(0);
  });

  it("announces the legacy cloud-state cleanup only when it removed something", async () => {
    const dataDir = currentDataDir();
    fsReal.mkdirSync(pathReal.join(dataDir, "cache"), { recursive: true });
    // A pure-LAN light (no API key ever): matches the migration condition on
    // EVERY start, so an unconditional info line is permanent log noise for
    // exactly the credential-less target group.
    fsReal.writeFileSync(
      pathReal.join(dataDir, "cache", "h6172_ee11.json"),
      JSON.stringify({
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:11",
        name: "Strip",
        type: "devices.types.light",
        capabilities: [],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        lanIp: "10.0.0.5",
        cachedAt: Date.now(),
        lastSeenOnNetwork: Date.now(),
      }),
    );
    const ctx = setup({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(ctx.adapter);
    // The cached lanIp is deliberately NOT trusted on load — feed a discovery
    // frame from start() so the device really is LAN-bound when the migration
    // block runs later in onReady.
    ctx.f.lan.start.mockImplementation((...args: unknown[]) => {
      ctx.f.lan.startArgs = args;
      (args[0] as (d: { ip: string; device: string; sku: string }) => void)({
        ip: "10.0.0.5",
        device: "AA:BB:CC:DD:EE:11",
        sku: "H6172",
      });
    });
    await i.onReady();

    expect(i.deviceManager!.getDevices()[0].lanIp).toBe("10.0.0.5");
    const removedLines = i.log.info.mock.calls.filter(c => String(c[0]).includes("legacy cloud-owned state"));
    expect(removedLines).toHaveLength(0);
  });
});

describe("GoveeAdapter — cache vs cloud start", () => {
  it("a cache hit skips the cloud device fetch and marks cloud connected", async () => {
    // Pre-seed a cache file so DeviceManager.loadFromCache() finds a device.
    const dataDir = currentDataDir();
    fsReal.mkdirSync(pathReal.join(dataDir, "cache"), { recursive: true });
    fsReal.writeFileSync(
      pathReal.join(dataDir, "cache", "h5179_ee11.json"),
      JSON.stringify({
        sku: "H5179",
        deviceId: "AA:BB:CC:DD:EE:11",
        name: "Thermo",
        type: "devices.types.thermometer",
        capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature" }],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        cachedAt: Date.now(),
        lastSeenOnNetwork: Date.now(),
      }),
    );
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("Loaded 1 device(s) from cache"));
    // No lights in the cache → no cloud refetch needed.
    expect(f.cloud.getDevices).not.toHaveBeenCalled();
    expect(i.cloudWasConnected).toBe(true);
    expect(i.states.get("info.cloudConnected")).toEqual({ val: true, ack: true });
    expect(i.cloudInitDone).toBe(true);
  });

  it("an empty cache goes to the cloud and records the outcome", async () => {
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    expect(f.cloud.getDevices).toHaveBeenCalled();
    // Empty account → loadFromCloud resolves ok, so cloudConnected is true.
    expect(i.states.get("info.cloudConnected")?.val).toBe(true);
    expect(i.statesReady).toBe(true);
  });
});
