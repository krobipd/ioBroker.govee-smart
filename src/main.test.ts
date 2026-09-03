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
    public setInterval = vi.fn(() => ({}));
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}));
    public clearTimeout = vi.fn();
    public delay = vi.fn(async () => {});
    public encrypt = (v: string): string => `enc:${v}`;
    public decrypt = (v: string): string => (v.startsWith("enc:") ? v.slice(4) : v);

    public setState = vi.fn((id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
      return Promise.resolve();
    });
    public setStateAsync = this.setState;
    public setStateChangedAsync = vi.fn((id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
      return Promise.resolve();
    });
    public getStateAsync = vi.fn((id: string) =>
      Promise.resolve(this.states.get(id.replace(`${this.namespace}.`, "")) ?? null),
    );
    public getState = this.getStateAsync;
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      const existing = this.objects.get(key) ?? {};
      this.objects.set(key, {
        ...existing,
        ...obj,
        common: { ...(existing.common ?? {}), ...(obj.common ?? {}) },
      });
      return Promise.resolve();
    });
    public extendObjectAsync = this.extendObject;
    public setObjectNotExistsAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      if (!this.objects.has(key)) {
        this.objects.set(key, obj);
      }
      return Promise.resolve();
    });
    public getObjectAsync = vi.fn((id: string) =>
      Promise.resolve(this.objects.get(id.replace(`${this.namespace}.`, "")) ?? null),
    );
    public delObjectAsync = vi.fn((id: string, opts?: { recursive?: boolean }) => {
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
      return Promise.resolve();
    });
    public delStateAsync = vi.fn((id: string) => {
      this.states.delete(id.replace(`${this.namespace}.`, ""));
      return Promise.resolve();
    });
    public getObjectViewAsync = vi.fn((_d: string, type: string, p: { startkey: string; endkey: string }) => {
      const prefix = p.startkey.replace(`${this.namespace}.`, "");
      const rows: Array<{ id: string; value: unknown }> = [];
      for (const [k, v] of this.objects) {
        if (k.startsWith(prefix) && (v as { type?: string }).type === type) {
          rows.push({ id: `${this.namespace}.${k}`, value: v });
        }
      }
      return Promise.resolve({ rows });
    });
    public getForeignObjectAsync = vi.fn(() => Promise.resolve({ native: {} }));
    public extendForeignObjectAsync = vi.fn(async () => {});
    public readDirAsync = vi.fn(() => Promise.resolve([] as { file: string; isDir: boolean }[]));
    public readFileAsync = vi.fn((_meta: string, name: string) => {
      const f = this.files.get(name);
      if (f === undefined) {
        return Promise.reject(new Error("not found"));
      }
      return Promise.resolve({ file: f });
    });
    public writeFileAsync = vi.fn((_meta: string, name: string, data: string | Buffer) => {
      this.files.set(name, typeof data === "string" ? data : data.toString("utf-8"));
      return Promise.resolve();
    });
    public delFileAsync = vi.fn((_meta: string, name: string) => {
      this.files.delete(name);
      return Promise.resolve();
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
import { STALE_DEVICE_CLEANUP_DELAY_MS } from "./lib/timing-constants";
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

/**
 * Typed access to the private fields/methods the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 */
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
  groupReachabilityPrimed: boolean;
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
  buildMessageRouterHost: () => Record<string, unknown>;
} {
  return adapter as unknown as ReturnType<typeof internalOf>;
}

/**
 * Let fire-and-forget promise chains settle.
 *
 * @param times How many macrotask turns to wait
 */
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

/**
 * Build an adapter with fake network collaborators + a config.
 *
 * @param configOverrides Instance settings that replace the defaults
 */
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
    getDevices: vi.fn(() => Promise.resolve([])),
    getDeviceState: vi.fn(() => Promise.resolve([])),
    setResponseHook: vi.fn(),
    getFailureReason: vi.fn(() => null),
  };
  const api = {
    setEmail: vi.fn(),
    setBearerToken: vi.fn(),
    hasBearerToken: vi.fn(() => false),
    fetchDeviceList: vi.fn(() => Promise.resolve([])),
    fetchGroupMembers: vi.fn(() => Promise.resolve([])),
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
      // A discovered LAN light carries the reply stamp — reachability for this
      // kind is the LAN reply, not a remembered boolean.
      makeDevice({ lanIp: "10.0.0.5", lastLanReplyAt: Date.now(), state: { online: true } }),
    );
    connectionState.updateConnectionState(
      adapter as unknown as Parameters<typeof connectionState.updateConnectionState>[0],
    );
    expect(i.channelStatus.lan).toBe("on");
    expect(i.states.get("info.connection")).toEqual({ val: true, ack: true });
    // All devices offline → the indicator must drop, LAN stack running or not.
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set(
      "H6172_aabbccddee11",
      // Silent for longer than the freshness window → unreachable.
      makeDevice({ lanIp: "10.0.0.5", lastLanReplyAt: undefined, state: { online: false } }),
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

  it("a pasted trailing space in the e-mail is stripped before the login, the password is not", async () => {
    // The admin card's "Connect" test trims the e-mail; the start-up login used
    // the raw value → "test OK, adapter says check email/password" on the same
    // input. A password may legitimately carry spaces, so it is passed verbatim.
    const { adapter, f } = await setupReady({ goveeEmail: " a@b.c ", goveePassword: " pw " });
    expect(f.calls.mqtt[0].slice(0, 2)).toEqual(["a@b.c", " pw "]);
    expect(f.api.setEmail).toHaveBeenCalledWith("a@b.c");
    void adapter;
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

  it("subscribes to device and group states AND the manual-sync button", async () => {
    // The button lives under `info`, outside both wildcards — without its own
    // subscription a write never reaches onStateChange (dead from 2.17.0 to 2.27.1).
    const { adapter } = await setupReady();
    const sub = (adapter as unknown as { subscribeStatesAsync: ReturnType<typeof vi.fn> }).subscribeStatesAsync;
    expect(sub.mock.calls.map(c => c[0])).toEqual(["devices.*", "groups.*", "info.manualSyncDevices"]);
  });

  it("drops the old snake_case manual-sync object on an upgraded install", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.objects.set("info.manual_sync_devices", { type: "state" });
    await i.onReady();
    expect(i.objects.has("info.manual_sync_devices")).toBe(false);
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

  it("the first online-sync round rebuilds the group rollup even when nothing changed", async () => {
    // The rollup used to ride purely on CHANGES. After a restart on a stable
    // installation nothing ever changes, so info.membersUnreachable kept
    // whatever the last transition had written — measured live on 2026-09-03:
    // the value's timestamp was 28 h older than the running adapter.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const devices = (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices;
    const member = makeDevice({ deviceId: "AA:BB:CC:DD:EE:11", state: { online: false } });
    const group = makeDevice({
      deviceId: "g1",
      sku: "BaseGroup",
      name: "living",
      groupMembers: [{ sku: "H6172", deviceId: "AA:BB:CC:DD:EE:11" }],
    });
    devices.set("H6172_aabbccddee11", member);
    devices.set("BaseGroup_g1", group);
    // A stale value from before the restart — nobody has re-checked it since.
    i.states.set("groups.basegroup_g1.info.membersUnreachable", { val: "", ack: true });

    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    (syncCall![0] as () => void)();
    await settle(5);

    expect(i.states.get("groups.basegroup_g1.info.membersUnreachable")?.val).toBe("h6172_ee11");
  });

  it("a first round before the device list arrived does not burn the priming", async () => {
    // The 20 s tick can fire while the cloud list is still loading. If the flag
    // were spent on that empty round, the group rollup would be back to
    // change-only — the same drift, only harder to see because the code looks
    // primed.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const devices = (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices;
    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);

    // Round 1: no devices at all.
    (syncCall![0] as () => void)();
    await settle(5);
    expect(i.groupReachabilityPrimed, "an empty round must not count as primed").toBe(false);

    // Round 2: the list has arrived, nothing has changed since — the rollup
    // must still be rebuilt.
    devices.set("H6172_aabbccddee11", makeDevice({ deviceId: "AA:BB:CC:DD:EE:11", state: { online: false } }));
    devices.set(
      "BaseGroup_g1",
      makeDevice({
        deviceId: "g1",
        sku: "BaseGroup",
        name: "living",
        groupMembers: [{ sku: "H6172", deviceId: "AA:BB:CC:DD:EE:11" }],
      }),
    );
    i.states.set("groups.basegroup_g1.info.membersUnreachable", { val: "", ack: true });
    (syncCall![0] as () => void)();
    await settle(5);
    expect(i.states.get("groups.basegroup_g1.info.membersUnreachable")?.val).toBe("h6172_ee11");
    expect(i.groupReachabilityPrimed).toBe(true);
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

  it("onUnload clears every timer handle the start-up armed — none is left ticking", async () => {
    const { adapter } = await setupReady({
      apiKey: "12345678-1234-1234-1234-123456789abc",
      goveeEmail: "a@b.c",
      goveePassword: "pw",
    });
    const i = internalOf(adapter);
    // The stub hands out a fresh handle object per call, so identity is exact.
    const armedIntervals = i.setInterval.mock.results.map(r => r.value);
    const armedTimeouts = i.setTimeout.mock.results.map(r => r.value);
    expect(armedIntervals.length).toBeGreaterThanOrEqual(3);
    expect(armedTimeouts.length).toBeGreaterThanOrEqual(3);

    i.onUnload(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));

    const clearedIntervals = i.clearInterval.mock.calls.map(c => c[0]);
    const clearedTimeouts = i.clearTimeout.mock.calls.map(c => c[0]);
    for (const h of armedIntervals) {
      expect(clearedIntervals, "every armed interval is cleared").toContain(h);
    }
    for (const h of armedTimeouts) {
      expect(clearedTimeouts, "every armed timeout is cleared").toContain(h);
    }
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

  it("the startup marks everything offline BEFORE the first LAN scan can answer", async () => {
    // After a crash no shutdown code ran at all — the previous run's values would
    // stand until the 20-second sync catches up, plus 90 seconds of reply timeout
    // for a LAN light. The stamp has to land before any discovery can flip a
    // marker back to true, i.e. before the LAN client is even started.
    // onReady builds a FRESH state manager, so the spy goes on the prototype —
    // patching the existing instance would be discarded and prove nothing.
    const { adapter, f } = setup();
    const order: string[] = [];
    const marked = vi.spyOn(StateManager.prototype, "markAllOffline").mockImplementation(() => {
      order.push("markAllOffline");
      return Promise.resolve([]);
    });
    f.lan.start.mockImplementation((...args: unknown[]) => {
      f.lan.startArgs = args;
      order.push("lan.start");
    });

    await internalOf(adapter).onReady();
    marked.mockRestore();

    expect(order).toEqual(["markAllOffline", "lan.start"]);
  });

  it("onUnload marks the devices offline, not just the connection flags", async () => {
    // Writing only the four connection flags leaves every device standing green.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const marked = vi.fn(() => Promise.resolve([] as string[]));
    i.stateManager!.markAllOffline = marked;

    i.onUnload(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(marked).toHaveBeenCalled();
  });

  it("the 20-second round writes the rollup only AFTER every marker was re-evaluated", async () => {
    // Derived from exactly the markers that were just re-evaluated, so the count
    // can never drift away from what the individual devices say — a rollup
    // written before the markers would show the previous round's numbers.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const devices = (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices;
    devices.set("a", makeDevice({ deviceId: "AA:01" }));
    devices.set("b", makeDevice({ deviceId: "AA:02" }));
    const order: string[] = [];
    (i.stateManager as unknown as { syncInfoOnline: unknown }).syncInfoOnline = () => {
      order.push("marker");
      return Promise.resolve(false);
    };
    i.stateManager!.writeDeviceRollup = () => {
      order.push("rollup");
      return Promise.resolve({ total: 0, online: 0 });
    };
    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    expect(syncCall, "online-sync interval must be armed").toBeDefined();

    (syncCall![0] as () => void)();
    await settle(6);

    expect(order).toEqual(["marker", "marker", "rollup"]);
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
  /**
   * Wire a device into the real DeviceManager and return its state prefix.
   *
   * @param adapter Adapter whose DeviceManager receives the device
   * @param segmentCount Learned segment count, or undefined for none
   */
  function withSegmentDevice(
    adapter: GoveeAdapter,
    segmentCount: number | undefined,
  ): Promise<{ device: GoveeDevice; prefix: string }> {
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", segmentCount });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    return Promise.resolve({ device, prefix: i.stateManager!.devicePrefix(device) });
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

  it("the handler view maps state suffixes to commands (plain + dynamic segment indices)", async () => {
    // The handlers no longer reach into the adapter — they get one host object
    // built over its private runtime. stateToCommand is one of its methods.
    const { adapter } = await setupReady();
    const host = (adapter as unknown as { handlerHost: { stateToCommand(s: string): string | null } }).handlerHost;
    expect(host.stateToCommand("control.power")).toBe("power");
    expect(host.stateToCommand("segments.7.color")).toBe("segmentColor:7");
    expect(host.stateToCommand("segments.7.brightness")).toBe("segmentBrightness:7");
    expect(host.stateToCommand("nope.nothing")).toBeNull();
  });

  it("the handler view exposes live values, not copies — a flag flipped later reads through", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const host = (adapter as unknown as { handlerHost: { readyLogged: boolean; statesReady: boolean } }).handlerHost;
    expect(host.statesReady).toBe(true);
    expect(host.readyLogged).toBe(i.readyLogged);
    host.readyLogged = true; // a handler owns this flag and writes it back
    expect(i.readyLogged).toBe(true);
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

  it("a light with no local API is reachable when Govee's state read says so", async () => {
    // The reported regression (krobi + Joylancer, five models): such a light
    // showed as unreachable while it still controlled fine. The evidence was
    // there all along — Govee's `/device/state` response carries the device's
    // reachability — but the value translator has no `online` branch, so the
    // adapter discarded it and the device had no evidence at all.
    //
    // 2.29.0 tried to close that by inferring reachability from the cloud
    // CHANNEL instead. That reported two unplugged strips as reachable on the
    // live system. This is the honest source.
    const dataDir = currentDataDir();
    fsReal.mkdirSync(pathReal.join(dataDir, "cache"), { recursive: true });
    fsReal.writeFileSync(
      pathReal.join(dataDir, "cache", "h6172_ee11.json"),
      JSON.stringify({
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:11",
        name: "Cloud Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
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
    const ctx = setup({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(ctx.adapter);
    ctx.f.cloud.getDevices.mockResolvedValue([
      {
        sku: "H6172",
        device: "AA:BB:CC:DD:EE:11",
        deviceName: "Cloud Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
      },
    ]);
    // Govee says the device is online — this is the bit that used to be thrown away.
    ctx.f.cloud.getDeviceState.mockResolvedValue([
      { type: "devices.capabilities.online", instance: "online", state: { value: true } },
    ]);
    await i.onReady();
    await settle();

    const device = i.deviceManager!.getDevices()[0];
    expect(device.lanIp).toBeFalsy();

    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    (syncCall![0] as () => void)();
    await settle();

    expect(i.states.get("devices.h6172_ee11.info.online")).toEqual({ val: true, ack: true });
  });

  it("an unplugged light with no local API stays unreachable — no evidence, no green", async () => {
    // Measured on the live system 2026-09-03: two strips of krobi's are
    // physically unplugged. 2.29.0 showed both as reachable.
    const dataDir = currentDataDir();
    fsReal.mkdirSync(pathReal.join(dataDir, "cache"), { recursive: true });
    fsReal.writeFileSync(
      pathReal.join(dataDir, "cache", "h6172_ee11.json"),
      JSON.stringify({
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:11",
        name: "Unplugged Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
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
    const ctx = setup({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(ctx.adapter);
    ctx.f.cloud.getDevices.mockResolvedValue([
      {
        sku: "H6172",
        device: "AA:BB:CC:DD:EE:11",
        deviceName: "Unplugged Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
      },
    ]);
    // Govee returns nothing about reachability — the account knows the device,
    // the device itself says nothing.
    ctx.f.cloud.getDeviceState.mockResolvedValue([]);
    await i.onReady();
    await settle();

    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    (syncCall![0] as () => void)();
    await settle();

    expect(i.states.get("devices.h6172_ee11.info.online")).toEqual({ val: false, ack: true });
  });

  it("an explicit offline from Govee wins over everything else", async () => {
    // The direction that must keep working: when Govee itself says the device
    // is offline, that is the answer — no channel state, no cache value and no
    // later poll may talk it up.
    const dataDir = currentDataDir();
    fsReal.mkdirSync(pathReal.join(dataDir, "cache"), { recursive: true });
    fsReal.writeFileSync(
      pathReal.join(dataDir, "cache", "h6172_ee11.json"),
      JSON.stringify({
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:11",
        name: "Cloud Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
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
    const ctx = setup({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(ctx.adapter);
    ctx.f.cloud.getDevices.mockResolvedValue([
      {
        sku: "H6172",
        device: "AA:BB:CC:DD:EE:11",
        deviceName: "Cloud Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
      },
    ]);
    ctx.f.cloud.getDeviceState.mockResolvedValue([
      { type: "devices.capabilities.online", instance: "online", state: { value: false } },
    ]);
    await i.onReady();
    await settle();

    const syncCall = i.setInterval.mock.calls.find(c => c[1] === 20_000);
    (syncCall![0] as () => void)();
    await settle();

    expect(i.states.get("devices.h6172_ee11.info.online")).toEqual({ val: false, ack: true });
    // …and the device carries Govee's word, so nothing derives around it later.
    expect(i.deviceManager!.getDevices()[0].state.cloudReportedOnline).toBe(false);
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

// ===========================================================================
// Wiring. Every callback main.ts hands to a collaborator is one line of glue —
// and one line of glue is exactly what left the manual-sync button dead for ten
// releases. These pull the registered callbacks back out of the fakes and fire
// them.
// ===========================================================================
describe("GoveeAdapter — callback wiring", () => {
  function fullSetup(): Promise<{ adapter: GoveeAdapter; f: Fakes }> {
    return setupReady({
      apiKey: "12345678-1234-1234-1234-123456789abc",
      goveeEmail: "a@b.c",
      goveePassword: "pw",
    });
  }
  const firstArg = <T>(fn: ReturnType<typeof vi.fn>): T => {
    expect(fn, "callback must have been registered").toHaveBeenCalled();
    return fn.mock.calls[0][0] as T;
  };

  it("MQTT verification: 'pending' opens the code field + nudges, 'consumed' clears the saved code", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const onFailed = firstArg<(reason: string) => void>(f.mqtt.setOnVerificationFailed);
    onFailed("pending");
    await settle();
    expect(i.states.get("info.verificationPending")).toEqual({ val: true, ack: true });
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("requires a verification code"));

    // Govee accepted the code → the setting is wiped so a stale code is never re-sent.
    i.getForeignObjectAsync.mockResolvedValue({ native: { mqttVerificationCode: "123456" } });
    const onConsumed = firstArg<() => void>(f.mqtt.setOnVerificationConsumed);
    onConsumed();
    await settle();
    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith(
      `system.adapter.${i.namespace}`,
      expect.objectContaining({ native: expect.objectContaining({ mqttVerificationCode: "" }) }),
    );
  });

  it("MQTT 'failed' verification also wipes the code and names the rejection", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValue({ native: { mqttVerificationCode: "999999" } });
    firstArg<(reason: string) => void>(f.mqtt.setOnVerificationFailed)("failed");
    await settle();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("rejected the verification code"));
    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith(
      `system.adapter.${i.namespace}`,
      expect.objectContaining({ native: expect.objectContaining({ mqttVerificationCode: "" }) }),
    );
  });

  it("MQTT auth-failed and login-blocked surface as actionable warnings", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    firstArg<() => void>(f.mqtt.setOnAuthFailed)();
    firstArg<() => void>(f.mqtt.setOnLoginBlocked)();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("rejected the account login"));
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("stopped accepting the account login"));
  });

  it("MQTT connection flips: connected writes the flags, resolves the problems and re-checks ready; disconnected clears", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const onConnection = f.mqtt.connect.mock.calls[0][1] as (c: boolean) => void;
    firstArg<() => void>(f.mqtt.setOnAuthFailed)(); // an open problem to be resolved
    onConnection(true);
    await settle();
    expect(i.states.get("info.mqttConnected")).toEqual({ val: true, ack: true });
    expect(i.states.get("info.verificationPending")).toEqual({ val: false, ack: true });
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("account login accepted"));
    onConnection(false);
    await settle();
    expect(i.states.get("info.mqttConnected")).toEqual({ val: false, ack: true });
  });

  it("an MQTT status push reaches the device manager and the packet hook feeds the diagnostics", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", state: { online: true, power: false } });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    const onStatus = f.mqtt.connect.mock.calls[0][0] as (u: unknown) => void;
    onStatus({ sku: "H6172", device: "AA:BB:CC:DD:EE:11", state: { onOff: 1, brightness: 40 } });
    expect(device.state.power).toBe(true);
    expect(device.state.brightness).toBe(40);

    firstArg<(d: string, t: string, p: unknown) => void>(f.mqtt.setPacketHook)("AA:BB:CC:DD:EE:11", "GA/t", {
      hex: "aa01",
    });
    const diag = (
      i.deviceManager as unknown as {
        getDiagnostics(): { generate(d: GoveeDevice, v: string): Promise<Record<string, unknown>> };
      }
    ).getDiagnostics();
    expect((await diag.generate(device, "x")).lastMqttPackets).toEqual([
      expect.objectContaining({ hex: "aa01", topic: "GA/t" }),
    ]);
  });

  it("a fresh bearer token from the MQTT login is handed to the App-API client", async () => {
    const { f } = await fullSetup();
    const onToken = f.mqtt.connect.mock.calls[0][2] as (t: string) => void;
    onToken("fresh-bearer");
    expect(f.api.setBearerToken).toHaveBeenCalledWith("fresh-bearer");
  });

  it("refreshed MQTT credentials are persisted to the instance data directory", async () => {
    const { f } = await fullSetup();
    firstArg<(c: unknown) => void>(f.mqtt.setOnCredentialsRefresh)({
      bearerToken: "bt",
      iotEndpoint: "iot.example",
      p12Cert: "cert",
      p12Pass: "pass",
      accountId: "acc",
      accountTopic: "GA/acc",
      tokenExpiresAt: Date.now() + 3_600_000,
    });
    // The write is asynchronous (temp file + rename) — wait for the file to be complete.
    const file = pathReal.join(currentDataDir(), "mqtt-credentials.json");
    let stored: { bearerToken?: string } | null = null;
    for (let attempt = 0; attempt < 50 && !stored; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try {
        stored = JSON.parse(fsReal.readFileSync(file, "utf-8")) as { bearerToken?: string };
      } catch {
        stored = null;
      }
    }
    expect(stored?.bearerToken).toBe("enc:bt"); // encrypted at rest
  });

  it("Cloud responses and Cloud-events raw payloads land in the per-device diagnostics", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const device = makeDevice({ deviceId: "AA:BB:CC:DD:EE:11" });
    firstArg<(d: string, e: string, b: unknown) => void>(f.cloud.setResponseHook)("AA:BB:CC:DD:EE:11", "/router/x", {
      v: 1,
    });
    const onRaw = f.openapi.connect.mock.calls[0][2] as (raw: string) => void;
    onRaw(JSON.stringify({ sku: "H6172", device: "AA:BB:CC:DD:EE:11", capabilities: [] }));
    onRaw("{ not json"); // must not throw
    const diag = (
      i.deviceManager as unknown as {
        getDiagnostics(): { generate(d: GoveeDevice, v: string): Promise<Record<string, unknown>> };
      }
    ).getDiagnostics();
    const report = await diag.generate(device, "x");
    expect((report.apiHistory as Record<string, unknown[]>)["/router/x"]).toHaveLength(1);
    expect(report.lastMqttPackets).toEqual([expect.objectContaining({ topic: "openapi-events" })]);
  });

  it("Cloud-events connection state is mirrored to info.openapiMqttConnected and events reach the device manager", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const onConnection = f.openapi.connect.mock.calls[0][1] as (c: boolean) => void;
    onConnection(true);
    await settle();
    expect(i.states.get("info.openapiMqttConnected")).toEqual({ val: true, ack: true });

    const sensor = makeDevice({
      sku: "H5179",
      deviceId: "AA:BB:CC:DD:EE:22",
      type: "devices.types.thermometer",
      state: { online: false },
    });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H5179_aabbccddee22", sensor);
    const onEvent = f.openapi.connect.mock.calls[0][0] as (e: unknown) => void;
    onEvent({
      sku: "H5179",
      device: "AA:BB:CC:DD:EE:22",
      capabilities: [{ type: "devices.capabilities.online", instance: "online", state: { value: true } }],
    });
    expect(sensor.state.online).toBe(true);
  });

  it("a LAN status reply is routed by source IP into the device manager", async () => {
    const { adapter, f } = await fullSetup();
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", state: { online: true } });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    const onStatus = f.lan.startArgs[1] as (ip: string, s: unknown) => void;
    onStatus("10.0.0.5", { onOff: 1, brightness: 77, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 });
    expect(device.state.brightness).toBe(77);
    expect(device.state.colorRgb).toBe("#010203");
  });

  it("a segment-count change rebuilds the segment tree with the settled count", async () => {
    const { adapter } = await fullSetup();
    const i = internalOf(adapter);
    const device = makeDevice({ lanIp: "10.0.0.5", segmentCount: 3 });
    (i.deviceManager as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6172_aabbccddee11", device);
    const dm = i.deviceManager as unknown as { onSegmentCountChanged?: (d: GoveeDevice) => void };
    expect(dm.onSegmentCountChanged, "count-change callback must be wired").toBeDefined();
    dm.onSegmentCountChanged!(device);
    await settle(5);
    const prefix = i.stateManager!.devicePrefix(device);
    expect(i.objects.has(`${prefix}.segments.2`)).toBe(true);
    expect(i.objects.has(`${prefix}.segments.3`)).toBe(false);
  });

  it("the stale-device cleanup timer really reaps — object tree cleanup runs with the live list", async () => {
    const { adapter } = await fullSetup();
    const i = internalOf(adapter);
    const cleanup = vi.fn(() => Promise.resolve([] as string[]));
    (i.stateManager as unknown as { cleanupDevices: unknown }).cleanupDevices = cleanup;
    const timer = i.setTimeout.mock.calls.find(c => c[1] === STALE_DEVICE_CLEANUP_DELAY_MS);
    expect(timer, "stale-device cleanup timer must be armed").toBeDefined();
    (timer![0] as () => void)();
    await settle(5);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("GoveeAdapter — the diagnostics export over the REAL host object", () => {
  it("writes a report file when the device button is pressed", async () => {
    // 2.29.0 shipped this broken: the handlers never get `this`, only the host
    // view `buildHost()` assembles, and the file methods were missing from it.
    // Every test passed because each rig declared those methods on its own
    // fake — nothing drove the real host. On the live system the export died
    // with "writeFileAsync is not a function".
    const { adapter, f } = await setupReady({ apiKey: "12345678-1234-1234-1234-123456789abc" });
    const i = internalOf(adapter);
    f.cloud.getDevices.mockResolvedValue([
      {
        sku: "H61BE",
        device: "AA:BB:CC:DD:EE:11",
        deviceName: "Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
      },
    ]);
    await i.syncDevicesManually();
    await settle();

    const device = i.deviceManager!.getDevices()[0];
    const prefix = i.stateManager!.devicePrefix(device);
    await i.onStateChange(`govee-smart.0.${prefix}.diag.export`, { val: true, ack: false });
    await settle(6);

    // The stub keys its file store by name (the meta object is a separate arg).
    const written = [...i.files.keys()].filter(k => k.startsWith("govee-smart_"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^govee-smart_H61BE_ee11_v.*\.json$/);
    // And the datapoint points at exactly that file.
    expect(i.states.get(`${prefix}.diag.lastExport`)?.val).toBe(written[0]);
  });
});
