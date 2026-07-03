import {
  buildCloudRetryHost,
  cloudInitWithTimeout,
  ensureCloudRetry,
  handleCloudFailure,
  type CloudRetryHandlerAdapter,
} from "./cloud-retry-handler";
import type { CloudLoadResult } from "../types";
import { mockLog } from "../test-helpers";

interface TestRig {
  adapter: CloudRetryHandlerAdapter;
  timers: Array<{ cb: () => void; ms: number }>;
  cleared: number[];
  reports: Array<{ key: string; title: string }>;
  resolves: Array<{ key: string; msg?: string }>;
  stateWrites: Array<{ id: string; val: unknown }>;
  groupsOnline: boolean[];
  loadCloudStatesCalls: number[];
  setLoad(fn: () => Promise<CloudLoadResult>): void;
}

function makeRig(): TestRig {
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const cleared: number[] = [];
  const reports: Array<{ key: string; title: string }> = [];
  const resolves: Array<{ key: string; msg?: string }> = [];
  const stateWrites: Array<{ id: string; val: unknown }> = [];
  const groupsOnline: boolean[] = [];
  const loadCloudStatesCalls: number[] = [];
  let load: () => Promise<CloudLoadResult> = async () => ({ ok: true });

  const adapter: CloudRetryHandlerAdapter = {
    log: mockLog,
    deviceManager: { loadFromCloud: () => load() } as never,
    cloudClient: null,
    stateManager: {
      updateGroupsOnline: async (v: boolean) => {
        groupsOnline.push(v);
      },
    } as never,
    cloudInitTimer: undefined,
    cloudRetry: undefined,
    cloudWasConnected: false,
    setState: async (id, state) => {
      stateWrites.push({ id, val: (state as { val: unknown }).val });
    },
    setTimeout: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length as unknown as ioBroker.Timeout;
    },
    clearTimeout: h => {
      cleared.push(h as unknown as number);
    },
    loadCloudStates: async () => {
      loadCloudStatesCalls.push(1);
    },
    actionableProblems: {
      report: (p: { key: string; title: string }) => reports.push({ key: p.key, title: p.title }),
      resolve: (key: string, msg?: string) => resolves.push({ key, msg }),
    } as never,
  };
  return {
    adapter,
    timers,
    cleared,
    reports,
    resolves,
    stateWrites,
    groupsOnline,
    loadCloudStatesCalls,
    setLoad: fn => {
      load = fn;
    },
  };
}

describe("cloudInitWithTimeout", () => {
  it("returns the load result and clears the safety timer when the Cloud answers in time", async () => {
    const rig = makeRig();
    rig.setLoad(async () => ({ ok: true }));
    const result = await cloudInitWithTimeout(rig.adapter);
    expect(result).toEqual({ ok: true });
    expect(rig.cleared).toHaveLength(1);
    expect(rig.adapter.cloudInitTimer).toBeUndefined();
  });

  it("resolves transient when the safety timer fires first (Cloud hangs — startup must not block)", async () => {
    const rig = makeRig();
    rig.setLoad(() => new Promise<CloudLoadResult>(() => {})); // never resolves
    const pending = cloudInitWithTimeout(rig.adapter);
    expect(rig.timers).toHaveLength(1);
    rig.timers[0].cb(); // fire the 60s safety timeout
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "transient" });
  });

  it("maps a thrown loadFromCloud to transient and still clears the timer", async () => {
    const rig = makeRig();
    rig.setLoad(async () => {
      throw new Error("boom");
    });
    const result = await cloudInitWithTimeout(rig.adapter);
    expect(result).toEqual({ ok: false, reason: "transient" });
    expect(rig.cleared).toHaveLength(1);
  });

  it("returns transient when no device manager is wired yet", async () => {
    const rig = makeRig();
    (rig.adapter as { deviceManager: unknown }).deviceManager = null;
    expect(await cloudInitWithTimeout(rig.adapter)).toEqual({ ok: false, reason: "transient" });
  });
});

describe("ensureCloudRetry", () => {
  it("creates ONE loop lazily and reuses it on later calls", () => {
    const rig = makeRig();
    const loop = ensureCloudRetry(rig.adapter);
    expect(rig.adapter.cloudRetry).toBe(loop);
    expect(ensureCloudRetry(rig.adapter)).toBe(loop);
  });

  it("seeds the loop with the adapter's connected flag — a cache-hit start must not arm retries", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true;
    ensureCloudRetry(rig.adapter);
    // Connected loop ignores transient results — observable: no retry timer armed.
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.timers).toHaveLength(0);
  });
});

describe("handleCloudFailure", () => {
  it("auth-failed surfaces the actionable API-key problem and stops the loop (no retry timer)", () => {
    const rig = makeRig();
    handleCloudFailure(rig.adapter, { ok: false, reason: "auth-failed", message: "HTTP 403" });
    expect(rig.reports).toHaveLength(1);
    expect(rig.reports[0].key).toBe("cloud-auth");
    expect(rig.timers).toHaveLength(0);
  });

  it("transient failures do NOT reach the actionable registry (self-healing stays out)", () => {
    const rig = makeRig();
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.reports).toHaveLength(0);
    expect(rig.timers).toHaveLength(1); // retry armed instead
  });
});

describe("buildCloudRetryHost — onCloudRestored", () => {
  it("resolves the cloud-auth problem, flips the connected flags/states and reloads Cloud states", async () => {
    const rig = makeRig();
    const host = buildCloudRetryHost(rig.adapter);
    await host.onCloudRestored();
    expect(rig.resolves.some(r => r.key === "cloud-auth")).toBe(true);
    expect(rig.adapter.cloudWasConnected).toBe(true);
    expect(rig.stateWrites).toContainEqual({ id: "info.cloudConnected", val: true });
    expect(rig.groupsOnline).toEqual([true]);
    expect(rig.loadCloudStatesCalls).toHaveLength(1);
  });
});
