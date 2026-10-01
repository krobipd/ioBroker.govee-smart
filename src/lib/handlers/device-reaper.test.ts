import { reapStaleDevices, type DeviceReaperAdapter } from "./device-reaper";
import { sessionKey } from "../device-key";
import type { GoveeDevice } from "../types";
import { createTestDevice } from "../../../test/test-helpers";

function makeRig(opts: {
  devices?: GoveeDevice[];
  populationKnown?: boolean;
  listedPrefixes?: Set<string>;
  gapReload?: boolean;
}): {
  adapter: DeviceReaperAdapter;
  logs: Record<string, string[]>;
  cleanupCalls: GoveeDevice[][];
  cleanupProtected: Array<Set<string> | undefined>;
  prunedWith: Array<Set<string>>;
} {
  const logs: Record<string, string[]> = { debug: [], info: [], warn: [], error: [] };
  const cleanupCalls: GoveeDevice[][] = [];
  const cleanupProtected: Array<Set<string> | undefined> = [];
  const prunedWith: Array<Set<string>> = [];
  const devices = opts.devices ?? [];
  const adapter: DeviceReaperAdapter = {
    log: {
      debug: (m: string) => logs.debug.push(m),
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
      silly: () => {},
      level: "debug",
    } as unknown as ioBroker.Logger,
    deviceManager: {
      getDevices: () => devices,
      hasKnownPopulation: () => opts.populationKnown ?? true,
      accountListedPrefixes: () => opts.listedPrefixes ?? new Set<string>(),
      reloadForAccountGap: () => opts.gapReload ?? false,
      getDiagnostics: () => ({
        pruneOrphans: (live: Set<string>) => prunedWith.push(live),
      }),
    } as never,
    stateManager: {
      cleanupDevices: (current: GoveeDevice[], listed?: Set<string>) => {
        cleanupCalls.push(current);
        cleanupProtected.push(listed);
        return Promise.resolve([]);
      },
    } as never,
    diagnosticsLastRun: new Map<string, number>(),
  };
  return { adapter, logs, cleanupCalls, cleanupProtected, prunedWith };
}

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

  it("hands the prefixes an account list names to the cleanup — they are kept (H6)", async () => {
    const listed = new Set(["devices.h600d_0009"]);
    const rig = makeRig({ devices: [], listedPrefixes: listed });
    await reapStaleDevices(rig.adapter);
    expect(rig.cleanupProtected).toEqual([listed]);
  });

  it("waits while the Cloud list is re-read for an account gap — no cleanup this pass (H6)", async () => {
    const rig = makeRig({ devices: [], gapReload: true });
    await reapStaleDevices(rig.adapter);
    expect(rig.cleanupCalls).toEqual([]);
    expect(rig.prunedWith).toEqual([]);
  });

  it("deletes nothing while no account list has answered (cloud down)", async () => {
    // The 30 s cleanup timer in onReady fires regardless of what any channel
    // achieved. Without an account list the device map holds only what LAN
    // discovery and the cache produced — reaping against that deleted 249 of
    // 249 device objects of a seeded installation with an empty cache, and 132
    // of 249 with a partial one (measured 2026-09-07 against the real adapter).
    const rig = makeRig({ devices: [], populationKnown: false });
    rig.adapter.diagnosticsLastRun.set(sessionKey("H9999", "GO:NE"), 456);

    await reapStaleDevices(rig.adapter);

    expect(rig.cleanupCalls).toEqual([]);
    expect(rig.prunedWith).toEqual([]);
    // The throttle entry survives too — it is keyed on a device whose objects
    // are still there.
    expect(rig.adapter.diagnosticsLastRun.has(sessionKey("H9999", "GO:NE"))).toBe(true);
    expect(rig.logs.debug.some(m => m.includes("Device cleanup skipped"))).toBe(true);
  });
});
