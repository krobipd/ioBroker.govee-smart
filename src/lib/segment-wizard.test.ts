import { vi } from "vitest";

// Resolve wizard strings against the real en.json so the content assertions
// below still hold; the wizard's own format() then substitutes {placeholders}.
vi.mock("@iobroker/adapter-core", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const enJson = JSON.parse(readFileSync(join(__dirname, "../../admin/i18n/en.json"), "utf8")) as Record<
    string,
    string
  >;
  return {
    I18n: {
      getTranslatedObject: vi.fn((key: string) => ({ en: key })),
      translate: vi.fn((key: string) => enJson[key] ?? key),
    },
  };
});

import { SegmentWizard, type WizardHost, type WizardResult } from "./segment-wizard";
import { SEGMENT_HARD_MAX } from "./device-manager/lookups";
import type { CloudCapability, GoveeDevice } from "./types";

// A sliced test harness — mirrors enough of the adapter that the wizard
// cannot tell the difference. Every external call is recorded so tests can
// assert on the exact sequence (did flashSegment(0) happen before the first
// question? does finish() pass the right WizardResult to the host?).
interface HostCall {
  kind: "sendCommand";
  device: GoveeDevice;
  command: string;
  value: unknown;
}

class TestHost implements WizardHost {
  public readonly calls: HostCall[] = [];
  public readonly stateReads: string[] = [];
  public readonly logs: { level: string; msg: string }[] = [];
  public readonly timerCallbacks: { cb: () => void; ms: number }[] = [];
  public readonly appliedResults: {
    device: GoveeDevice;
    result: WizardResult;
  }[] = [];
  public clearedTimers = 0;

  public states = new Map<string, unknown>();
  public devices = new Map<string, GoveeDevice>();
  public namespace = "govee-smart.0";

  public log = {
    debug: (m: string): void => {
      this.logs.push({ level: "debug", msg: m });
    },
    info: (m: string): void => {
      this.logs.push({ level: "info", msg: m });
    },
    warn: (m: string): void => {
      this.logs.push({ level: "warn", msg: m });
    },
    error: (m: string): void => {
      this.logs.push({ level: "error", msg: m });
    },
  };

  public getState(id: string): Promise<{ val: unknown } | null> {
    this.stateReads.push(id);
    if (this.states.has(id)) {
      return Promise.resolve({ val: this.states.get(id) });
    }
    return Promise.resolve(null);
  }

  public sendCommand(device: GoveeDevice, command: string, value: unknown): Promise<void> {
    this.calls.push({ kind: "sendCommand", device, command, value });
    return Promise.resolve();
  }

  /** Filter host.calls down to only the segmentBatch commands. */
  public segmentBatchCalls(): HostCall[] {
    return this.calls.filter(c => c.command === "segmentBatch");
  }

  public atomicFlashUsed = false;
  public atomicRestoreUsed = false;
  public atomicEnabled = false;

  public flashSegmentAtomic(_device: GoveeDevice, _idx: number): Promise<boolean> {
    this.atomicFlashUsed = true;
    return Promise.resolve(this.atomicEnabled);
  }

  public restoreStripAtomic(
    _device: GoveeDevice,
    _total: number,
    _color: number,
    _brightness: number,
  ): Promise<boolean> {
    this.atomicRestoreUsed = true;
    return Promise.resolve(this.atomicEnabled);
  }

  public findDevice(key: string): GoveeDevice | undefined {
    return this.devices.get(key);
  }

  public devicePrefix(device: GoveeDevice): string {
    return `devices.${device.sku.toLowerCase()}_${device.deviceId.slice(-4)}`;
  }

  public setTimeout(cb: () => void, ms: number): unknown {
    const idx = this.timerCallbacks.length;
    this.timerCallbacks.push({ cb, ms });
    return idx;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number" && this.timerCallbacks[handle]) {
      this.timerCallbacks[handle] = { cb: (): void => {}, ms: 0 };
    }
    this.clearedTimers += 1;
  }

  public fireLatestTimer(): void {
    const last = this.timerCallbacks[this.timerCallbacks.length - 1];
    if (last) {
      last.cb();
    }
  }

  public applyWizardResult(device: GoveeDevice, result: WizardResult): Promise<void> {
    this.appliedResults.push({ device, result });
    // Mimic the host's runtime side-effect so subsequent logic that
    // reads device.segmentCount (e.g. restoreBaseline) sees the update.
    device.segmentCount = result.segmentCount;
    return Promise.resolve();
  }
}

function segmentCapability(segmentMax: number): CloudCapability {
  return {
    type: "devices.capabilities.segment_color_setting",
    instance: "segmentedColorRgb",
    parameters: {
      dataType: "STRUCT",
      fields: [
        {
          fieldName: "segment",
          dataType: "Array",
          elementRange: { min: 0, max: segmentMax },
        },
      ],
    },
  };
}

function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  const base: GoveeDevice = {
    sku: "H6160",
    deviceId: "AABBCCDDEEFF0011",
    name: "Strip Living",
    type: "devices.types.light",
    segmentCount: 5,
    capabilities: [segmentCapability(4)],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: false },
    snapshotBleCmds: undefined,
  };
  return { ...base, ...overrides };
}

function seedBaseline(host: TestHost, prefix: string, segs: number): void {
  host.states.set(`${host.namespace}.${prefix}.control.power`, true);
  host.states.set(`${host.namespace}.${prefix}.control.brightness`, 75);
  host.states.set(`${host.namespace}.${prefix}.control.color_rgb`, "#ff6600");
  for (let i = 0; i < segs; i++) {
    host.states.set(`${host.namespace}.${prefix}.segments.${i}.color`, "#112233");
    host.states.set(`${host.namespace}.${prefix}.segments.${i}.brightness`, 50);
  }
}

describe("SegmentWizard", () => {
  let host: TestHost;
  let wizard: SegmentWizard;
  let device: GoveeDevice;
  const key = "H6160:AABBCCDDEEFF0011";

  beforeEach(() => {
    host = new TestHost();
    device = makeDevice();
    host.devices.set(key, device);
    seedBaseline(host, host.devicePrefix(device), device.segmentCount ?? 0);
    wizard = new SegmentWizard(host);
  });

  describe("start", () => {
    it("should refuse when device key is unknown", async () => {
      const r = await wizard.start("H9999:NOPE");
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("not found");
      expect(wizard.getSessionSnapshot()).toBeNull();
    });

    it("should refuse when device has no segment capability", async () => {
      host.devices.set(key, makeDevice({ capabilities: [] }));
      const r = await wizard.start(key);
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("no segments");
      expect(wizard.getSessionSnapshot()).toBeNull();
    });

    it("should refuse an unreachable device — nothing would answer the flashes", async () => {
      // Until 2.31.0 the wizard had a device list of its own and that list
      // filtered on reachability, so an offline device could not get here. One
      // shared list now serves both halves of the Expert tab and the CARD
      // filters it — which means a device that drops off between loading the
      // list and pressing start reaches this point. Without the guard the
      // wizard would flash segments at something that cannot answer and the
      // user would watch a dark strip with nothing on screen to explain it.
      host.devices.set(key, makeDevice({ state: { online: false } }));
      const r = await wizard.start(key);
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("not reachable");
      expect(wizard.getSessionSnapshot()).toBeNull();
    });

    it("should start even when device.segmentCount=0 (first-measurement case)", async () => {
      // Fresh device without any learned count — wizard still runs so
      // the user CAN measure it for the first time.
      host.devices.set(key, makeDevice({ segmentCount: 0, capabilities: [segmentCapability(14)] }));
      const r = await wizard.start(key);
      expect(r.error).toBeUndefined();
      expect(r.active).toBe(true);
    });

    it("should ensure strip is on + full brightness before flashing", async () => {
      await wizard.start(key);
      expect(host.calls[0].command).toBe("power");
      expect(host.calls[0].value).toBe(true);
      expect(host.calls[1].command).toBe("brightness");
      expect(host.calls[1].value).toBe(100);
    });

    it("rejects a concurrent second start() before the first finishes capturing (L6)", async () => {
      // onMessage is fire-and-forget, so two start() calls can overlap. The
      // session slot must be reserved synchronously — before captureBaseline's
      // await — or both slip past the guard and open a double session.
      const p1 = wizard.start(key); // in flight (not awaited) — captures baseline
      const r2 = await wizard.start(key); // second start while the first is capturing
      await p1;
      expect(r2.error).toBeDefined();
      expect(r2.active).not.toBe(true);
    });

    it("should open a session and flash segment 0 over the FULL protocol range", async () => {
      const r = await wizard.start(key);
      expect(r.error).toBeUndefined();
      expect(r.active).toBe(true);
      expect(wizard.getSessionSnapshot()?.current).toBe(0);

      // Two segmentBatch calls: others→dim, target→bright.
      // "others" must now cover 1..SEGMENT_HARD_MAX (not just 1..4),
      // because we can't know the real strip length yet.
      const batches = host.segmentBatchCalls();
      expect(batches).toHaveLength(2);
      const dimBatch = batches[0].value as { segments: number[] };
      expect(dimBatch.segments).toHaveLength(SEGMENT_HARD_MAX);
      expect(dimBatch.segments[0]).toBe(1);
      expect(dimBatch.segments[SEGMENT_HARD_MAX - 1]).toBe(SEGMENT_HARD_MAX);
      const brightBatch = batches[1].value as {
        segments: number[];
        color: number;
      };
      expect(brightBatch.segments).toEqual([0]);
      expect(brightBatch.color).toBe(0xffffff);
    });

    it("should send segmentBatch value as an OBJECT (not string)", async () => {
      await wizard.start(key);
      for (const c of host.segmentBatchCalls()) {
        expect(c.value).toBeTypeOf("object");
        expect(typeof c.value).not.toBe("string");
      }
    });

    it("should capture baseline from existing states", async () => {
      await wizard.start(key);
      await wizard.abort();
      const restoreCall = host.calls[host.calls.length - 1];
      expect(restoreCall.command).toBe("segmentBatch");
      const v = restoreCall.value as {
        segments: number[];
        color: number;
        brightness: number;
      };
      expect(v.color).toBe(0xff6600);
      expect(v.brightness).toBe(75);
      // Restore scopes to device.segmentCount — the pre-measurement value
      expect(v.segments).toEqual([0, 1, 2, 3, 4]);
    });

    it("should refuse a second start while active (session lock)", async () => {
      const first = await wizard.start(key);
      expect(first.active).toBe(true);
      const second = await wizard.start(key);
      expect(typeof second.error).toBe("string");
      expect(second.error).toContain("already active");
      expect(wizard.getSessionSnapshot()).not.toBeNull();
    });

    it("should schedule an idle timeout of 5 minutes", async () => {
      await wizard.start(key);
      expect(host.timerCallbacks).toHaveLength(1);
      expect(host.timerCallbacks[0].ms).toBe(5 * 60_000);
    });
  });

  describe("answer", () => {
    it("should return error when no session active", async () => {
      const r = await wizard.answer(true);
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("No wizard active");
    });

    it("should record 'yes' answers into the visible list", async () => {
      await wizard.start(key);
      host.calls.length = 0;
      await wizard.answer(true); // seg 0 visible, advances to 1
      expect(host.calls).toHaveLength(2); // dim others + bright target
      const bright = host.calls[1].value as { segments: number[] };
      expect(bright.segments).toEqual([1]);
    });

    it("should skip 'no' answers but still advance", async () => {
      await wizard.start(key);
      host.calls.length = 0;
      const r = await wizard.answer(false);
      expect(r.active).toBe(true);
      expect(wizard.getSessionSnapshot()?.current).toBe(1);
      const bright = host.calls[1].value as { segments: number[] };
      expect(bright.segments).toEqual([1]);
    });

    it("should NOT auto-finish at device.segmentCount — keeps going", async () => {
      // Old behaviour: auto-finish at segmentCount=5. New behaviour:
      // keep flashing until the user says done() or we hit HARD_MAX.
      await wizard.start(key);
      for (let i = 0; i < 10; i++) {
        const r = await wizard.answer(true);
        expect(r.active).toBe(true);
      }
      expect(wizard.getSessionSnapshot()).not.toBeNull();
    });

    it("should auto-finish when the protocol limit is reached", async () => {
      await wizard.start(key);
      let final: unknown;
      for (let i = 0; i <= SEGMENT_HARD_MAX; i++) {
        final = await wizard.answer(true);
      }
      expect((final as { done?: boolean }).done).toBe(true);
      expect(wizard.getSessionSnapshot()).toBeNull();
    });
  });

  describe("finalize (apply / protocol-limit auto-finish)", () => {
    // The React flow ends a measurement with `apply` and its review-corrected
    // map; the old "done" action (pre-React sendTo buttons) is gone.
    it("rejects the retired 'done' action like any unknown action", async () => {
      await wizard.start(key);
      const r = await wizard.runStep("done", key);
      expect(r.error).toContain("Unknown action");
      expect(wizard.getSessionSnapshot()).not.toBeNull();
    });

    it("should finalize with contiguous result (all visible, no gaps)", async () => {
      await wizard.start(key);
      await wizard.answer(true); // 0
      await wizard.answer(true); // 1
      await wizard.answer(true); // 2
      const r = await wizard.runStep("apply", key, { indices: [0, 1, 2] });
      expect(r.applied).toBe(true);
      expect(r.segmentCount).toBe(3);
      expect(r.list).toBe("");
      expect(r.hasGaps).toBe(false);

      expect(host.appliedResults).toHaveLength(1);
      const applied = host.appliedResults[0];
      expect(applied.device).toBe(device);
      expect(applied.result).toEqual({
        segmentCount: 3,
        manualList: "",
        hasGaps: false,
      });
    });

    it("should detect gaps and build a compact manual list", async () => {
      await wizard.start(key);
      await wizard.answer(true); // 0 visible
      await wizard.answer(true); // 1 visible
      await wizard.answer(false); // 2 dark (gap)
      await wizard.answer(true); // 3 visible
      await wizard.answer(true); // 4 visible
      const confirmed = wizard.getSessionSnapshot()!.visible;
      expect(confirmed).toEqual([0, 1, 3, 4]);
      const r = await wizard.runStep("apply", key, { indices: confirmed });
      expect(r.segmentCount).toBe(5);
      expect(r.list).toBe("0-1,3-4");
      expect(r.hasGaps).toBe(true);

      const applied = host.appliedResults[0];
      expect(applied.result.hasGaps).toBe(true);
      expect(applied.result.manualList).toBe("0-1,3-4");
    });

    it("should handle a 20-segment strip when cloud said 15 (the Esszimmer case)", async () => {
      // The classic under-reported case: cloud capabilities say 15,
      // real strip has 20, user runs wizard and confirms all 20.
      await wizard.start(key);
      for (let i = 0; i < 20; i++) {
        await wizard.answer(true);
      }
      // User sees segment 20 is dark (past end of strip) → applies the 20 confirmed
      const r = await wizard.runStep("apply", key, { indices: wizard.getSessionSnapshot()!.visible });
      expect(r.segmentCount).toBe(20);
      expect(r.hasGaps).toBe(false);
      expect(r.list).toBe("");
    });

    it("finalizes on its own when the measurement reaches the protocol limit", async () => {
      await wizard.start(key);
      let last: Record<string, unknown> = {};
      for (let i = 0; i <= SEGMENT_HARD_MAX; i++) {
        last = await wizard.answer(true);
      }
      // The answer for index 55 is the last the bitmask can address — the
      // session closes with the measured map, no separate apply needed.
      expect(last.done).toBe(true);
      expect(last.segmentCount).toBe(SEGMENT_HARD_MAX + 1);
      expect(last.hasGaps).toBe(false);
      expect(host.appliedResults).toHaveLength(1);
      expect(wizard.getSessionSnapshot()).toBeNull();
    });

    it("should restore baseline after applying the result", async () => {
      await wizard.start(key);
      await wizard.answer(true);
      await wizard.answer(true);
      host.calls.length = 0;
      await wizard.runStep("apply", key, { indices: [0, 1] });
      // Last sendCommand should be the restore segmentBatch
      const last = host.calls[host.calls.length - 1];
      expect(last.command).toBe("segmentBatch");
      const v = last.value as { color: number; brightness: number };
      expect(v.color).toBe(0xff6600);
      expect(v.brightness).toBe(75);
    });

    it("should clear the idle timer on apply", async () => {
      await wizard.start(key);
      await wizard.answer(true);
      const clearedBefore = host.clearedTimers;
      await wizard.runStep("apply", key, { indices: [0] });
      expect(wizard.getSessionSnapshot()).toBeNull();
      // The armed idle timer is really cancelled — a stale one firing later
      // would run the abort path against a session that no longer exists.
      expect(host.clearedTimers).toBeGreaterThan(clearedBefore);
      expect(() => host.fireLatestTimer()).not.toThrow();
      expect(host.appliedResults).toHaveLength(1); // still exactly the one apply
    });
  });

  describe("abort", () => {
    it("should error when no session active", async () => {
      const r = await wizard.abort();
      expect(typeof r.error).toBe("string");
    });

    it("should restore baseline on abort", async () => {
      await wizard.start(key);
      host.calls.length = 0;
      await wizard.abort();
      expect(host.calls).toHaveLength(1);
      const v = host.calls[0].value as {
        color: number;
        brightness: number;
      };
      expect(v.color).toBe(0xff6600);
      expect(v.brightness).toBe(75);
    });

    it("should NOT apply a result on abort", async () => {
      await wizard.start(key);
      await wizard.answer(true);
      await wizard.abort();
      expect(host.appliedResults).toHaveLength(0);
    });

    it("should release the session lock", async () => {
      await wizard.start(key);
      await wizard.abort();
      expect(wizard.getSessionSnapshot()).toBeNull();
      const again = await wizard.start(key);
      expect(again.active).toBe(true);
    });

    it("should skip restore when baseline color is missing", async () => {
      host.states.delete(`${host.namespace}.${host.devicePrefix(device)}.control.color_rgb`);
      await wizard.start(key);
      host.calls.length = 0;
      await wizard.abort();
      expect(host.calls).toHaveLength(0);
    });

    it("restores the original power state — turns the strip back off if it was off (L8)", async () => {
      // The wizard forces the strip ON to flash segments; a device that was OFF
      // beforehand must be turned back off on restore. The baseline is captured
      // BEFORE start() powers it on, so power=false is what we recorded.
      host.states.set(`${host.namespace}.${host.devicePrefix(device)}.control.power`, false);
      await wizard.start(key);
      host.calls.length = 0;
      await wizard.abort();
      const powerCall = host.calls.find(c => c.command === "power");
      expect(powerCall).toBeDefined();
      expect(powerCall!.value).toBe(false);
    });

    it("restores the captured per-segment gradient instead of flattening it to one colour (L8)", async () => {
      const prefix = host.devicePrefix(device);
      // A real 3-zone gradient in the per-segment state, distinct from the uniform control colour.
      ["#ff0000", "#ff0000", "#00ff00", "#00ff00", "#0000ff"].forEach((c, i) => {
        host.states.set(`${host.namespace}.${prefix}.segments.${i}.color`, c);
        host.states.set(`${host.namespace}.${prefix}.segments.${i}.brightness`, 60);
      });
      await wizard.start(key);
      host.calls.length = 0; // drop the flash calls — keep only the restore
      await wizard.abort();
      const batches = host
        .segmentBatchCalls()
        .map(c => c.value as { segments: number[]; color: number; brightness: number });
      // Grouped by (colour,brightness): 3 zones → 3 batches, gradient preserved.
      expect(batches).toContainEqual({ segments: [0, 1], color: 0xff0000, brightness: 60 });
      expect(batches).toContainEqual({ segments: [2, 3], color: 0x00ff00, brightness: 60 });
      expect(batches).toContainEqual({ segments: [4], color: 0x0000ff, brightness: 60 });
      // Never flattened to the uniform control colour (#ff6600).
      expect(batches.some(b => b.color === 0xff6600)).toBe(false);
    });

    it("still uses the uniform colour when the captured segments are all identical (no false gradient)", async () => {
      // seedBaseline already sets every segment to #112233 — a uniform strip
      // must restore via the single control colour, not a per-segment replay.
      await wizard.start(key);
      host.calls.length = 0;
      await wizard.abort();
      const batches = host
        .segmentBatchCalls()
        .map(c => c.value as { segments: number[]; color: number; brightness: number });
      expect(batches).toHaveLength(1);
      expect(batches[0].color).toBe(0xff6600); // control.color_rgb, not the segment colour
    });
  });

  describe("runStep dispatch", () => {
    it("should route 'start' to start()", async () => {
      const r = await wizard.runStep("start", key);
      expect(r.active).toBe(true);
    });

    it("should reject yes/no/apply/abort without a session", async () => {
      for (const a of ["yes", "no", "apply", "abort"]) {
        const r = await wizard.runStep(a, "");
        expect(r.error).toContain("No wizard");
      }
    });

    it("should reject unknown actions", async () => {
      await wizard.start(key);
      const r = await wizard.runStep("maybe", "");
      expect(r.error).toContain("Unknown action");
    });

    it("should route 'yes'/'no'/'apply'/'abort'", async () => {
      await wizard.start(key);
      await wizard.runStep("yes", "");
      await wizard.runStep("no", "");
      await wizard.runStep("yes", "");
      const r = await wizard.runStep("apply", "", { indices: [0, 2] });
      expect(r.applied).toBe(true);
      expect(r.list).toBe("0,2");

      // New session — abort works too
      await wizard.runStep("start", key);
      const aborted = await wizard.runStep("abort", "");
      expect(aborted.aborted).toBe(true);
    });
  });

  describe("snapshot + apply (React grid)", () => {
    it("folds a grid snapshot into every runStep response", async () => {
      await wizard.runStep("start", key);
      const res = await wizard.runStep("yes", key); // segment 0 visible, advance to 1
      const snap = res.snapshot as {
        phase: string;
        total: number;
        currentIndex: number;
        confirmed: number[];
      };
      expect(snap).toMatchObject({ phase: "measuring", confirmed: [0] });
      expect(typeof snap.currentIndex).toBe("number");
      expect(snap.currentIndex).toBe(1);
      expect(snap.total).toBeGreaterThan(0);
    });

    it("reports an idle snapshot when no session is active", async () => {
      const res = await wizard.runStep("yes", key); // no session started
      expect(res.snapshot).toMatchObject({ phase: "idle", confirmed: [], currentIndex: 0 });
    });

    it("apply(indices) routes the review-corrected map through applyWizardResult", async () => {
      await wizard.runStep("start", key);
      const res = await wizard.runStep("apply", key, { indices: [0, 1, 2, 4] }); // gap at 3
      expect(res.applied).toBe(true);
      expect(host.appliedResults).toHaveLength(1);
      expect(host.appliedResults[0].result).toEqual({
        segmentCount: 5,
        manualList: "0-2,4",
        hasGaps: true,
      });
    });

    it("apply with a contiguous map reports no gaps", async () => {
      await wizard.runStep("start", key);
      await wizard.runStep("apply", key, { indices: [0, 1, 2] });
      expect(host.appliedResults[0].result).toEqual({
        segmentCount: 3,
        manualList: "",
        hasGaps: false,
      });
    });

    it("apply finalizes the session — restores baseline and releases the lock", async () => {
      await wizard.runStep("start", key);
      host.calls.length = 0; // drop the flash calls — keep only the restore
      await wizard.runStep("apply", key, { indices: [0, 1, 2] });
      // baseline restored: last sendCommand is the restore segmentBatch
      const last = host.calls[host.calls.length - 1];
      expect(last.command).toBe("segmentBatch");
      // session released → a fresh start succeeds (would be "already active" if leaked)
      expect(wizard.getSessionSnapshot()).toBeNull();
      const again = await wizard.runStep("start", key);
      expect(again.active).toBe(true);
    });

    it("apply without an active session errors and applies nothing", async () => {
      const res = await wizard.runStep("apply", key, { indices: [0, 1] });
      expect(typeof res.error).toBe("string");
      expect(res.error).toContain("No wizard");
      expect(host.appliedResults).toHaveLength(0);
    });

    it("apply drops indices the protocol cannot address instead of turning them into the count", async () => {
      // The payload comes straight from the admin socket: an oversized index
      // used to become segmentCount and build that many channels.
      await wizard.runStep("start", key);
      const res = await wizard.runStep("apply", key, { indices: [0, 1, 1_000_000_000, -3, 2.5] });
      expect(res.applied).toBe(true);
      expect(host.appliedResults[0].result).toEqual({ segmentCount: 2, manualList: "", hasGaps: false });
    });

    it("apply with an empty map errors and keeps the session open", async () => {
      await wizard.runStep("start", key);
      const res = await wizard.runStep("apply", key, { indices: [] });
      expect(typeof res.error).toBe("string");
      expect(host.appliedResults).toHaveLength(0);
      expect(wizard.getSessionSnapshot()).not.toBeNull();
    });
  });

  describe("idle timeout", () => {
    it("should abort the session when the timer fires", async () => {
      await wizard.start(key);
      expect(wizard.getSessionSnapshot()).not.toBeNull();
      host.fireLatestTimer();
      await new Promise(resolve => setImmediate(resolve));
      expect(wizard.getSessionSnapshot()).toBeNull();
      const warns = host.logs.filter(l => l.level === "warn");
      expect(warns.some(l => l.msg.toLowerCase().includes("idle timeout"))).toBe(true);
    });

    it("should do nothing if the session is already gone when firing", async () => {
      await wizard.start(key);
      await wizard.abort();
      expect(() => host.fireLatestTimer()).not.toThrow();
    });

    it("should reset the timer on each answer", async () => {
      await wizard.start(key);
      const before = host.timerCallbacks.length;
      await wizard.answer(true);
      await wizard.answer(false);
      expect(host.timerCallbacks.length).toBe(before + 2);
      expect(host.clearedTimers).toBeGreaterThanOrEqual(2);
    });
  });

  describe("device disappears mid-session", () => {
    it("should clean up when device vanishes between answers", async () => {
      await wizard.start(key);
      host.devices.delete(key);
      const r = await wizard.answer(true);
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("disappeared");
      expect(wizard.getSessionSnapshot()).toBeNull();
    });

    it("should handle device missing at apply", async () => {
      await wizard.start(key);
      await wizard.answer(true);
      host.devices.delete(key);
      const r = await wizard.runStep("apply", key, { indices: [0] });
      expect(typeof r.error).toBe("string");
      expect(r.error).toContain("disappeared");
      expect(wizard.getSessionSnapshot()).toBeNull();
    });
  });

  describe("dispose", () => {
    it("should cancel pending timer and drop session", async () => {
      await wizard.start(key);
      wizard.dispose();
      expect(wizard.getSessionSnapshot()).toBeNull();
      expect(host.clearedTimers).toBeGreaterThan(0);
    });

    it("should be safe to call without a session", () => {
      expect(() => wizard.dispose()).not.toThrow();
    });
  });

  describe("localization", () => {
    // Per-language rendering moved to adapter-core I18n (driven by
    // system.config.language) — the 11-language key + placeholder coverage
    // lives in i18n.test.ts. Here the I18n mock resolves to en.json, so this
    // just asserts the wizard wires its keys through I18n + format() correctly.
    it("renders resolved error strings with interpolated placeholders", async () => {
      // The only localized text left in the responses are the error lines —
      // the React component carries its own translations for everything else.
      const r = await wizard.start("H9999:NOPE");
      expect(r.error).toBe("Device not found: H9999:NOPE");
    });
  });

  describe("flashSegment integration", () => {
    it("should always pass an object (not a string) for segmentBatch", async () => {
      await wizard.start(key);
      await wizard.answer(true);
      await wizard.answer(true);
      await wizard.answer(true);
      await wizard.runStep("apply", key, { indices: [0, 1, 2] });
      for (const c of host.segmentBatchCalls()) {
        expect(c.value).toBeTypeOf("object");
        expect(typeof c.value).not.toBe("string");
      }
    });

    it("should use atomic flash when the host reports it available", async () => {
      host.atomicEnabled = true;
      await wizard.start(key);
      // No segmentBatch fallback calls when atomic succeeded
      const batches = host.segmentBatchCalls();
      expect(batches).toHaveLength(0);
      expect(host.atomicFlashUsed).toBe(true);
    });
  });
});
