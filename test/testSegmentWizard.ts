import { expect } from "chai";
import { SegmentWizard, type WizardHost } from "../src/lib/segment-wizard";
import type { GoveeDevice } from "../src/lib/types";

// A sliced test harness — mirrors enough of the adapter that the wizard
// cannot tell the difference. Every external call is recorded so tests can
// assert on the exact sequence (did flashSegment(0) happen before the first
// question? does finish() really write manual_list BEFORE manual_mode?).
interface HostCall {
    kind: "sendCommand";
    device: GoveeDevice;
    command: string;
    value: unknown;
}
interface StateCall {
    id: string;
    val: unknown;
    ack: boolean;
}

class TestHost implements WizardHost {
    public readonly calls: HostCall[] = [];
    public readonly stateWrites: StateCall[] = [];
    public readonly stateReads: string[] = [];
    public readonly logs: { level: string; msg: string }[] = [];
    public readonly timerCallbacks: { cb: () => void; ms: number }[] = [];
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

    public async getState(id: string): Promise<{ val: unknown } | null> {
        this.stateReads.push(id);
        if (this.states.has(id)) {
            return { val: this.states.get(id) };
        }
        return null;
    }

    public async setState(
        id: string,
        state: { val: unknown; ack: boolean },
    ): Promise<unknown> {
        this.stateWrites.push({ id, val: state.val, ack: state.ack });
        this.states.set(id, state.val);
        return undefined;
    }

    public async sendCommand(
        device: GoveeDevice,
        command: string,
        value: unknown,
    ): Promise<void> {
        this.calls.push({ kind: "sendCommand", device, command, value });
    }

    /** Filter host.calls down to only the segmentBatch commands (drops the
     *  preparation calls like `power` and `brightness` that the wizard now
     *  issues before flashing segment 0). */
    public segmentBatchCalls(): HostCall[] {
        return this.calls.filter((c) => c.command === "segmentBatch");
    }

    // Default: return false so sendCommand fallback path runs — most tests
    // assert on host.calls. Individual tests can override to true to exercise
    // the atomic path.
    public atomicFlashUsed = false;
    public atomicRestoreUsed = false;
    public atomicEnabled = false;

    public async flashSegmentAtomic(
        _device: GoveeDevice,
        _total: number,
        _idx: number,
    ): Promise<boolean> {
        this.atomicFlashUsed = true;
        return this.atomicEnabled;
    }

    public async restoreStripAtomic(
        _device: GoveeDevice,
        _total: number,
        _color: number,
        _brightness: number,
    ): Promise<boolean> {
        this.atomicRestoreUsed = true;
        return this.atomicEnabled;
    }

    public findDevice(key: string): GoveeDevice | undefined {
        return this.devices.get(key);
    }

    public devicePrefix(device: GoveeDevice): string {
        return `devices.${device.sku.toLowerCase()}_${device.deviceId.slice(-4)}`;
    }

    // setTimeout returns an index into the timerCallbacks array. Tests can
    // later call fireTimer(idx) to synchronously invoke what the real
    // timeout would fire asynchronously.
    public setTimeout(cb: () => void, ms: number): unknown {
        const idx = this.timerCallbacks.length;
        this.timerCallbacks.push({ cb, ms });
        return idx;
    }

    public clearTimeout(handle: unknown): void {
        if (typeof handle === "number" && this.timerCallbacks[handle]) {
            // Mark as consumed by replacing with a no-op so double-fire is safe
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
}

function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
    const base: GoveeDevice = {
        sku: "H6160",
        deviceId: "AABBCCDDEEFF0011",
        name: "Strip Living",
        type: "devices.types.light",
        segmentCount: 5,
        capabilities: [],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        snapshotBleCmds: undefined,
    } as unknown as GoveeDevice;
    return { ...base, ...overrides };
}

function seedBaseline(host: TestHost, prefix: string, segs: number): void {
    host.states.set(`${host.namespace}.${prefix}.control.power`, true);
    host.states.set(`${host.namespace}.${prefix}.control.brightness`, 75);
    host.states.set(`${host.namespace}.${prefix}.control.colorRgb`, "#ff6600");
    for (let i = 0; i < segs; i++) {
        host.states.set(
            `${host.namespace}.${prefix}.segments.${i}.color`,
            "#112233",
        );
        host.states.set(
            `${host.namespace}.${prefix}.segments.${i}.brightness`,
            50,
        );
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
            expect(r.error).to.be.a("string").and.include("nicht gefunden");
            expect(wizard.isActive()).to.be.false;
        });

        it("should refuse when device has 0 segments", async () => {
            host.devices.set(key, makeDevice({ segmentCount: 0 }));
            const r = await wizard.start(key);
            expect(r.error).to.be.a("string").and.include("segmentCount=0");
            expect(wizard.isActive()).to.be.false;
        });

        it("should ensure strip is on + full brightness before flashing", async () => {
            await wizard.start(key);
            // First two calls must be the strip-preparation step
            expect(host.calls[0].command).to.equal("power");
            expect(host.calls[0].value).to.equal(true);
            expect(host.calls[1].command).to.equal("brightness");
            expect(host.calls[1].value).to.equal(100);
        });

        it("should open a session and flash segment 0", async () => {
            const r = await wizard.start(key);
            expect(r.error).to.be.undefined;
            expect(r.active).to.be.true;
            expect(r.progress).to.equal("1 / 5");
            expect(wizard.isActive()).to.be.true;

            // Two segmentBatch calls: others→dim, target→bright
            const batches = host.segmentBatchCalls();
            expect(batches).to.have.lengthOf(2);
            expect(batches[0].value).to.deep.equal({
                segments: [1, 2, 3, 4],
                color: 0,
                brightness: 0,
            });
            expect(batches[1].value).to.deep.equal({
                segments: [0],
                color: 0xffffff,
                brightness: 100,
            });
        });

        it("should send segmentBatch value as an OBJECT (not string)", async () => {
            // This is the exact regression from v1.6.2 where parseSegmentBatch
            // called cmd.split(":") on a non-string value and crashed.
            await wizard.start(key);
            const batches = host.segmentBatchCalls();
            expect(batches.length).to.be.greaterThan(0);
            for (const c of batches) {
                expect(c.value).to.be.an("object");
                expect(c.value).to.not.be.a("string");
                const v = c.value as { segments: number[] };
                expect(Array.isArray(v.segments)).to.be.true;
            }
        });

        it("should capture baseline from existing states", async () => {
            await wizard.start(key);
            // Baseline is private but observable via restore-on-abort
            await wizard.abort();
            // Restore writes one segmentBatch with the baseline color
            const restoreCall = host.calls[host.calls.length - 1];
            expect(restoreCall.command).to.equal("segmentBatch");
            const v = restoreCall.value as {
                segments: number[];
                color: number;
                brightness: number;
            };
            expect(v.color).to.equal(0xff6600);
            expect(v.brightness).to.equal(75);
            expect(v.segments).to.deep.equal([0, 1, 2, 3, 4]);
        });

        it("should refuse a second start while active (session lock)", async () => {
            const first = await wizard.start(key);
            expect(first.active).to.be.true;
            const second = await wizard.start(key);
            expect(second.error).to.be.a("string").and.include("bereits aktiv");
            expect(wizard.isActive()).to.be.true;
        });

        it("should schedule an idle timeout of 5 minutes", async () => {
            await wizard.start(key);
            expect(host.timerCallbacks).to.have.lengthOf(1);
            expect(host.timerCallbacks[0].ms).to.equal(5 * 60_000);
        });
    });

    describe("answer", () => {
        it("should return error when no session active", async () => {
            const r = await wizard.answer(true);
            expect(r.error).to.be.a("string").and.include("Kein Wizard aktiv");
        });

        it("should record 'yes' answers into the visible list", async () => {
            await wizard.start(key);
            host.calls.length = 0;
            await wizard.answer(true); // seg 0 visible, advances to 1
            expect(host.calls).to.have.lengthOf(2); // dim others + bright target
            const bright = host.calls[1].value as { segments: number[] };
            expect(bright.segments).to.deep.equal([1]);
        });

        it("should skip 'no' answers but still advance", async () => {
            await wizard.start(key);
            host.calls.length = 0;
            const r = await wizard.answer(false);
            expect(r.active).to.be.true;
            expect(r.progress).to.equal("2 / 5");
            const bright = host.calls[1].value as { segments: number[] };
            expect(bright.segments).to.deep.equal([1]);
        });

        it("should finish automatically after the last segment", async () => {
            await wizard.start(key); // seg 0
            await wizard.answer(true); // seg 0 visible, flash 1
            await wizard.answer(false); // skip 1, flash 2
            await wizard.answer(true); // seg 2 visible, flash 3
            await wizard.answer(true); // seg 3 visible, flash 4
            const final = await wizard.answer(false); // skip 4 → finish
            expect(final.done).to.be.true;
            expect(final.result).to.equal(3);
            expect(final.list).to.equal("0,2,3");
            expect(wizard.isActive()).to.be.false;
        });
    });

    describe("finish (via last answer)", () => {
        it("should write manual_list BEFORE manual_mode", async () => {
            await wizard.start(key);
            for (let i = 0; i < 5; i++) {
                await wizard.answer(true);
            }
            const prefix = host.devicePrefix(device);
            const writes = host.stateWrites.filter((w) =>
                w.id.startsWith(`${host.namespace}.${prefix}.segments.`),
            );
            expect(writes).to.have.lengthOf(2);
            expect(writes[0].id).to.include("manual_list");
            expect(writes[0].val).to.equal("0,1,2,3,4");
            expect(writes[0].ack).to.be.false;
            expect(writes[1].id).to.include("manual_mode");
            expect(writes[1].val).to.be.true;
            expect(writes[1].ack).to.be.false;
        });

        it("should restore baseline after writing settings", async () => {
            await wizard.start(key);
            for (let i = 0; i < 5; i++) {
                await wizard.answer(false);
            }
            // Last sendCommand is the baseline restore
            const last = host.calls[host.calls.length - 1];
            const v = last.value as {
                color: number;
                brightness: number;
            };
            expect(v.color).to.equal(0xff6600);
            expect(v.brightness).to.equal(75);
        });

        it("should clear the idle timer", async () => {
            await wizard.start(key);
            const before = host.clearedTimers;
            for (let i = 0; i < 5; i++) {
                await wizard.answer(true);
            }
            // scheduleIdleTimeout clears each step (4×) + finish clears once
            expect(host.clearedTimers).to.be.greaterThan(before);
            expect(wizard.isActive()).to.be.false;
        });

        it("should produce empty list when no segments confirmed", async () => {
            await wizard.start(key);
            let final;
            for (let i = 0; i < 5; i++) {
                final = await wizard.answer(false);
            }
            expect(final!.list).to.equal("");
            expect(final!.result).to.equal(0);
        });
    });

    describe("abort", () => {
        it("should error when no session active", async () => {
            const r = await wizard.abort();
            expect(r.error).to.be.a("string");
        });

        it("should restore baseline on abort", async () => {
            await wizard.start(key);
            host.calls.length = 0;
            await wizard.abort();
            expect(host.calls).to.have.lengthOf(1);
            const v = host.calls[0].value as {
                color: number;
                brightness: number;
            };
            expect(v.color).to.equal(0xff6600);
            expect(v.brightness).to.equal(75);
        });

        it("should not write manual_mode/manual_list on abort", async () => {
            await wizard.start(key);
            host.stateWrites.length = 0;
            await wizard.abort();
            expect(host.stateWrites).to.have.lengthOf(0);
        });

        it("should release the session lock", async () => {
            await wizard.start(key);
            await wizard.abort();
            expect(wizard.isActive()).to.be.false;
            const again = await wizard.start(key);
            expect(again.active).to.be.true;
        });

        it("should skip restore when baseline color is missing", async () => {
            host.states.delete(
                `${host.namespace}.${host.devicePrefix(device)}.control.colorRgb`,
            );
            await wizard.start(key);
            host.calls.length = 0;
            await wizard.abort();
            expect(host.calls).to.have.lengthOf(0);
        });
    });

    describe("runStep dispatch", () => {
        it("should route 'start' to start()", async () => {
            const r = await wizard.runStep("start", key);
            expect(r.active).to.be.true;
        });

        it("should reject all non-start actions without a session", async () => {
            expect((await wizard.runStep("yes", "")).error).to.include(
                "Kein Wizard",
            );
            expect((await wizard.runStep("no", "")).error).to.include(
                "Kein Wizard",
            );
            expect((await wizard.runStep("abort", "")).error).to.include(
                "Kein Wizard",
            );
        });

        it("should reject unknown actions", async () => {
            await wizard.start(key);
            const r = await wizard.runStep("maybe", "");
            expect(r.error).to.include("Unbekannte Aktion");
        });

        it("should route 'yes' to answer(true) and 'no' to answer(false)", async () => {
            await wizard.start(key);
            await wizard.runStep("yes", ""); // seg 0 → visible
            await wizard.runStep("no", ""); // seg 1 → skip
            await wizard.runStep("yes", ""); // seg 2 → visible
            await wizard.runStep("no", ""); // seg 3 → skip
            const final = await wizard.runStep("no", ""); // seg 4 → finish
            expect(final.list).to.equal("0,2");
        });

        it("should route 'abort' to abort()", async () => {
            await wizard.start(key);
            const r = await wizard.runStep("abort", "");
            expect(r.aborted).to.be.true;
        });
    });

    describe("idle timeout", () => {
        it("should abort the session when the timer fires", async () => {
            await wizard.start(key);
            expect(wizard.isActive()).to.be.true;
            // Allow the promise from abort() inside the timer callback to settle
            host.fireLatestTimer();
            await new Promise((resolve) => setImmediate(resolve));
            expect(wizard.isActive()).to.be.false;
            const warns = host.logs.filter((l) => l.level === "warn");
            expect(warns.some((l) => l.msg.includes("Idle-Timeout"))).to.be
                .true;
        });

        it("should do nothing if the session is already gone when firing", async () => {
            await wizard.start(key);
            await wizard.abort();
            // Fire the timer that was scheduled for the (now-closed) session
            expect(() => host.fireLatestTimer()).to.not.throw();
        });

        it("should reset the timer on each answer", async () => {
            await wizard.start(key);
            const before = host.timerCallbacks.length;
            await wizard.answer(true);
            await wizard.answer(false);
            expect(host.timerCallbacks.length).to.equal(before + 2);
            // Previous timers cleared
            expect(host.clearedTimers).to.be.greaterThanOrEqual(2);
        });
    });

    describe("device disappears mid-session", () => {
        it("should clean up when device vanishes between answers", async () => {
            await wizard.start(key);
            host.devices.delete(key);
            const r = await wizard.answer(true);
            expect(r.error).to.be.a("string").and.include("verschwunden");
            expect(wizard.isActive()).to.be.false;
        });

        it("should handle device missing at finish", async () => {
            // Use 1-segment device so finish is one answer away
            const single = makeDevice({ segmentCount: 1 });
            const k2 = "H6160:SINGLE001";
            single.deviceId = "SINGLE001";
            host.devices.set(k2, single);
            seedBaseline(host, host.devicePrefix(single), 1);

            await wizard.start(k2);
            host.devices.delete(k2);
            const r = await wizard.answer(true);
            expect(r.error).to.be.a("string").and.include("verschwunden");
            expect(wizard.isActive()).to.be.false;
        });
    });

    describe("dispose", () => {
        it("should cancel pending timer and drop session", async () => {
            await wizard.start(key);
            wizard.dispose();
            expect(wizard.isActive()).to.be.false;
            expect(host.clearedTimers).to.be.greaterThan(0);
        });

        it("should be safe to call without a session", () => {
            expect(() => wizard.dispose()).to.not.throw();
        });
    });

    describe("flashSegment integration", () => {
        // This is the regression the v1.6.2 crash exposed — sendCommand
        // ("segmentBatch", {...object}) must pass through without string ops.
        it("should always pass an object (not a string) for segmentBatch", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            await wizard.answer(true);
            await wizard.answer(true);
            await wizard.answer(true);
            await wizard.answer(true);
            for (const c of host.segmentBatchCalls()) {
                expect(c.value).to.be.an("object");
                expect(c.value).to.not.be.a("string");
            }
        });

        it("should only send the bright-packet when device has 1 segment", async () => {
            const single = makeDevice({ segmentCount: 1 });
            single.deviceId = "ONLY0001";
            const k2 = "H6160:ONLY0001";
            host.devices.set(k2, single);
            seedBaseline(host, host.devicePrefix(single), 1);

            host.calls.length = 0;
            await wizard.start(k2);
            // Only 1 segment → no "others" to dim → single segmentBatch call
            const batches = host.segmentBatchCalls();
            expect(batches).to.have.lengthOf(1);
            const v = batches[0].value as { segments: number[] };
            expect(v.segments).to.deep.equal([0]);
        });
    });
});
