import {
  buildCloudRetryHost,
  cloudInitWithTimeout,
  ensureCloudRetry,
  handleCloudFailure,
  onCloudContact,
  setCloudConnected,
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
  groupMemberLoads: number[];
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
  const groupMemberLoads: number[] = [];
  let load: () => Promise<CloudLoadResult> = () => Promise.resolve({ ok: true });

  const adapter: CloudRetryHandlerAdapter = {
    log: mockLog,
    deviceManager: {
      loadFromCloud: () => load(),
      loadGroupMembers: () => {
        groupMemberLoads.push(1);
        return Promise.resolve(false);
      },
    } as never,
    cloudClient: null,
    stateManager: {
      updateGroupsOnline: (v: boolean) => {
        groupsOnline.push(v);
        return Promise.resolve();
      },
    } as never,
    cloudInitTimer: undefined,
    cloudRetry: undefined,
    cloudWasConnected: false,
    cloudConnectedShown: false,
    setState: (id, state) => {
      stateWrites.push({ id, val: (state as { val: unknown }).val });
      return Promise.resolve();
    },
    setTimeout: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length as unknown as ioBroker.Timeout;
    },
    clearTimeout: h => {
      cleared.push(h as unknown as number);
    },
    loadCloudStates: () => {
      loadCloudStatesCalls.push(1);
      return Promise.resolve();
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
    groupMemberLoads,
    setLoad: fn => {
      load = fn;
    },
  };
}

describe("cloudInitWithTimeout", () => {
  it("returns the load result and clears the safety timer when the Cloud answers in time", async () => {
    const rig = makeRig();
    rig.setLoad(() => Promise.resolve({ ok: true }));
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
    rig.setLoad(() => {
      return Promise.reject(new Error("boom"));
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
    const loop = ensureCloudRetry(rig.adapter);
    // Connected loop ignores transient results — observable: no retry timer armed.
    loop.handleResult({ ok: false, reason: "transient" });
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

  it("a failed load of a running adapter (manual sync) arms a retry although the loop counted as connected", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true;
    ensureCloudRetry(rig.adapter).setConnected(true);
    handleCloudFailure(rig.adapter, { ok: false, reason: "rate-limited", retryAfterMs: 120_000 });
    expect(rig.timers).toHaveLength(1);
    expect(rig.timers[0].ms).toBe(120_000);
  });

  it("a failed load shows the Cloud unreachable — both datapoints and the reachability flag", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true;
    rig.adapter.cloudConnectedShown = true;
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.adapter.cloudWasConnected).toBe(false);
    expect(rig.stateWrites).toEqual([{ id: "info.cloudConnected", val: false }]);
    expect(rig.groupsOnline).toEqual([false]);
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
    // The failed start-up list never reached its group-member step (M9).
    expect(rig.groupMemberLoads).toHaveLength(1);
  });
});

describe("setCloudConnected", () => {
  it("writes both datapoints on a change only — the per-call hook must not write on every answer", () => {
    const rig = makeRig();
    setCloudConnected(rig.adapter, true);
    setCloudConnected(rig.adapter, true);
    expect(rig.stateWrites).toEqual([{ id: "info.cloudConnected", val: true }]);
    expect(rig.groupsOnline).toEqual([true]);
    setCloudConnected(rig.adapter, false);
    expect(rig.stateWrites.map(w => w.val)).toEqual([true, false]);
    expect(rig.groupsOnline).toEqual([true, false]);
  });

  it("an unchanged value still updates the reachability flag", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true;
    setCloudConnected(rig.adapter, false);
    expect(rig.adapter.cloudWasConnected).toBe(false);
    expect(rig.stateWrites).toEqual([]);
  });
});

describe("onCloudContact", () => {
  it("an accepted call after a cache start shows the Cloud reachable and resolves the key problem", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true; // cache start: assumed, not shown
    onCloudContact(rig.adapter, "ok");
    expect(rig.stateWrites).toEqual([{ id: "info.cloudConnected", val: true }]);
    expect(rig.groupsOnline).toEqual([true]);
    expect(rig.resolves.some(r => r.key === "cloud-auth")).toBe(true);
  });

  it("an accepted call does not cancel a pending list retry", () => {
    const rig = makeRig();
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.timers).toHaveLength(1);
    onCloudContact(rig.adapter, "ok");
    expect(rig.cleared).toHaveLength(0);
    expect(rig.adapter.cloudConnectedShown).toBe(true);
  });

  it("a 401 on a state query of a reachable Cloud reports the key once, repeats stay silent", () => {
    const rig = makeRig();
    setCloudConnected(rig.adapter, true);
    onCloudContact(rig.adapter, "auth-failed");
    onCloudContact(rig.adapter, "auth-failed");
    expect(rig.reports.map(r => r.key)).toEqual(["cloud-auth"]);
    expect(rig.adapter.cloudConnectedShown).toBe(false);
    expect(rig.adapter.cloudWasConnected).toBe(false);
  });

  it("a 401 after a cache start (Cloud assumed, never shown) is reported too", () => {
    const rig = makeRig();
    rig.adapter.cloudWasConnected = true;
    onCloudContact(rig.adapter, "auth-failed");
    expect(rig.reports.map(r => r.key)).toEqual(["cloud-auth"]);
  });

  it("the 401 of a failing initial list load stays with that load's own result", () => {
    const rig = makeRig();
    onCloudContact(rig.adapter, "auth-failed");
    expect(rig.reports).toHaveLength(0);
  });

  it("an accepted call after an auth stop lets a later failed list query arm a retry again", () => {
    const rig = makeRig();
    handleCloudFailure(rig.adapter, { ok: false, reason: "auth-failed", message: "HTTP 401" });
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.timers).toHaveLength(0); // auth stop holds
    onCloudContact(rig.adapter, "ok");
    handleCloudFailure(rig.adapter, { ok: false, reason: "transient" });
    expect(rig.timers).toHaveLength(1);
  });
});
