import { expect } from "chai";
import {
    SegmentWizard,
    type WizardHost,
    type WizardResult,
} from "../src/lib/segment-wizard";
import { SEGMENT_HARD_MAX } from "../src/lib/device-manager";
import type { CloudCapability, GoveeDevice } from "../src/lib/types";

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

    public async getState(id: string): Promise<{ val: unknown } | null> {
        this.stateReads.push(id);
        if (this.states.has(id)) {
            return { val: this.states.get(id) };
        }
        return null;
    }

    public async sendCommand(
        device: GoveeDevice,
        command: string,
        value: unknown,
    ): Promise<void> {
        this.calls.push({ kind: "sendCommand", device, command, value });
    }

    /** Filter host.calls down to only the segmentBatch commands. */
    public segmentBatchCalls(): HostCall[] {
        return this.calls.filter((c) => c.command === "segmentBatch");
    }

    public atomicFlashUsed = false;
    public atomicRestoreUsed = false;
    public atomicEnabled = false;

    public async flashSegmentAtomic(
        _device: GoveeDevice,
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

    public async applyWizardResult(
        device: GoveeDevice,
        result: WizardResult,
    ): Promise<void> {
        this.appliedResults.push({ device, result });
        // Mimic the host's runtime side-effect so subsequent logic that
        // reads device.segmentCount (e.g. restoreBaseline) sees the update.
        device.segmentCount = result.segmentCount;
    }

    public language = "en";

    public getLanguage(): string {
        return this.language;
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
            expect(r.error).to.be.a("string").and.include("not found");
            expect(wizard.isActive()).to.be.false;
        });

        it("should refuse when device has no segment capability", async () => {
            host.devices.set(key, makeDevice({ capabilities: [] }));
            const r = await wizard.start(key);
            expect(r.error)
                .to.be.a("string")
                .and.include("no segments");
            expect(wizard.isActive()).to.be.false;
        });

        it("should start even when device.segmentCount=0 (first-measurement case)", async () => {
            // Fresh device without any learned count — wizard still runs so
            // the user CAN measure it for the first time.
            host.devices.set(
                key,
                makeDevice({ segmentCount: 0, capabilities: [segmentCapability(14)] }),
            );
            const r = await wizard.start(key);
            expect(r.error).to.be.undefined;
            expect(r.active).to.be.true;
        });

        it("should ensure strip is on + full brightness before flashing", async () => {
            await wizard.start(key);
            expect(host.calls[0].command).to.equal("power");
            expect(host.calls[0].value).to.equal(true);
            expect(host.calls[1].command).to.equal("brightness");
            expect(host.calls[1].value).to.equal(100);
        });

        it("should open a session and flash segment 0 over the FULL protocol range", async () => {
            const r = await wizard.start(key);
            expect(r.error).to.be.undefined;
            expect(r.active).to.be.true;
            expect(r.progress).to.equal("Segment 0");
            expect(wizard.isActive()).to.be.true;

            // Two segmentBatch calls: others→dim, target→bright.
            // "others" must now cover 1..SEGMENT_HARD_MAX (not just 1..4),
            // because we can't know the real strip length yet.
            const batches = host.segmentBatchCalls();
            expect(batches).to.have.lengthOf(2);
            const dimBatch = batches[0].value as { segments: number[] };
            expect(dimBatch.segments).to.have.lengthOf(SEGMENT_HARD_MAX);
            expect(dimBatch.segments[0]).to.equal(1);
            expect(dimBatch.segments[SEGMENT_HARD_MAX - 1]).to.equal(
                SEGMENT_HARD_MAX,
            );
            const brightBatch = batches[1].value as {
                segments: number[];
                color: number;
            };
            expect(brightBatch.segments).to.deep.equal([0]);
            expect(brightBatch.color).to.equal(0xffffff);
        });

        it("should send segmentBatch value as an OBJECT (not string)", async () => {
            await wizard.start(key);
            for (const c of host.segmentBatchCalls()) {
                expect(c.value).to.be.an("object");
                expect(c.value).to.not.be.a("string");
            }
        });

        it("should capture baseline from existing states", async () => {
            await wizard.start(key);
            await wizard.abort();
            const restoreCall = host.calls[host.calls.length - 1];
            expect(restoreCall.command).to.equal("segmentBatch");
            const v = restoreCall.value as {
                segments: number[];
                color: number;
                brightness: number;
            };
            expect(v.color).to.equal(0xff6600);
            expect(v.brightness).to.equal(75);
            // Restore scopes to device.segmentCount — the pre-measurement value
            expect(v.segments).to.deep.equal([0, 1, 2, 3, 4]);
        });

        it("should refuse a second start while active (session lock)", async () => {
            const first = await wizard.start(key);
            expect(first.active).to.be.true;
            const second = await wizard.start(key);
            expect(second.error).to.be.a("string").and.include("already active");
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
            expect(r.error).to.be.a("string").and.include("No wizard active");
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
            expect(r.progress).to.equal("Segment 1");
            const bright = host.calls[1].value as { segments: number[] };
            expect(bright.segments).to.deep.equal([1]);
        });

        it("should NOT auto-finish at device.segmentCount — keeps going", async () => {
            // Old behaviour: auto-finish at segmentCount=5. New behaviour:
            // keep flashing until the user says done() or we hit HARD_MAX.
            await wizard.start(key);
            for (let i = 0; i < 10; i++) {
                const r = await wizard.answer(true);
                expect(r.active).to.be.true;
            }
            expect(wizard.isActive()).to.be.true;
        });

        it("should auto-finish when the protocol limit is reached", async () => {
            await wizard.start(key);
            let final: unknown;
            for (let i = 0; i <= SEGMENT_HARD_MAX; i++) {
                final = await wizard.answer(true);
            }
            expect((final as { done?: boolean }).done).to.be.true;
            expect(wizard.isActive()).to.be.false;
        });
    });

    describe("done", () => {
        it("should error when no session active", async () => {
            const r = await wizard.done();
            expect(r.error).to.be.a("string").and.include("No wizard");
        });

        it("should error when no answer has been given yet", async () => {
            await wizard.start(key);
            const r = await wizard.done();
            expect(r.error)
                .to.be.a("string")
                .and.include("at least once first");
            expect(wizard.isActive()).to.be.true;
        });

        it("should finalize with contiguous result (all visible, no gaps)", async () => {
            await wizard.start(key);
            await wizard.answer(true); // 0
            await wizard.answer(true); // 1
            await wizard.answer(true); // 2
            const r = await wizard.done();
            expect(r.done).to.be.true;
            expect(r.segmentCount).to.equal(3);
            expect(r.list).to.equal("");
            expect(r.hasGaps).to.be.false;

            expect(host.appliedResults).to.have.lengthOf(1);
            const applied = host.appliedResults[0];
            expect(applied.device).to.equal(device);
            expect(applied.result).to.deep.equal({
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
            const r = await wizard.done();
            expect(r.segmentCount).to.equal(5);
            expect(r.list).to.equal("0-1,3-4");
            expect(r.hasGaps).to.be.true;

            const applied = host.appliedResults[0];
            expect(applied.result.hasGaps).to.be.true;
            expect(applied.result.manualList).to.equal("0-1,3-4");
        });

        it("should handle a 20-segment strip when cloud said 15 (the Esszimmer case)", async () => {
            // The classic under-reported case: cloud capabilities say 15,
            // real strip has 20, user runs wizard and confirms all 20.
            await wizard.start(key);
            for (let i = 0; i < 20; i++) {
                await wizard.answer(true);
            }
            // User sees segment 20 is dark (past end of strip) → done
            const r = await wizard.done();
            expect(r.segmentCount).to.equal(20);
            expect(r.hasGaps).to.be.false;
            expect(r.list).to.equal("");
        });

        it("should restore baseline after applying the result", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            await wizard.answer(true);
            host.calls.length = 0;
            await wizard.done();
            // Last sendCommand should be the restore segmentBatch
            const last = host.calls[host.calls.length - 1];
            expect(last.command).to.equal("segmentBatch");
            const v = last.value as { color: number; brightness: number };
            expect(v.color).to.equal(0xff6600);
            expect(v.brightness).to.equal(75);
        });

        it("should clear the idle timer on done", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            await wizard.done();
            expect(wizard.isActive()).to.be.false;
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

        it("should NOT apply a result on abort", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            await wizard.abort();
            expect(host.appliedResults).to.have.lengthOf(0);
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

        it("should reject yes/no/done/abort without a session", async () => {
            for (const a of ["yes", "no", "done", "abort"]) {
                const r = await wizard.runStep(a, "");
                expect(r.error).to.include("No wizard");
            }
        });

        it("should reject unknown actions", async () => {
            await wizard.start(key);
            const r = await wizard.runStep("maybe", "");
            expect(r.error).to.include("Unknown action");
        });

        it("should route 'yes'/'no'/'done'/'abort'", async () => {
            await wizard.start(key);
            await wizard.runStep("yes", "");
            await wizard.runStep("no", "");
            await wizard.runStep("yes", "");
            const r = await wizard.runStep("done", "");
            expect(r.done).to.be.true;
            expect(r.list).to.equal("0,2");

            // New session — abort works too
            await wizard.runStep("start", key);
            const aborted = await wizard.runStep("abort", "");
            expect(aborted.aborted).to.be.true;
        });
    });

    describe("idle timeout", () => {
        it("should abort the session when the timer fires", async () => {
            await wizard.start(key);
            expect(wizard.isActive()).to.be.true;
            host.fireLatestTimer();
            await new Promise((resolve) => setImmediate(resolve));
            expect(wizard.isActive()).to.be.false;
            const warns = host.logs.filter((l) => l.level === "warn");
            expect(warns.some((l) => l.msg.toLowerCase().includes("idle timeout")))
                .to.be.true;
        });

        it("should do nothing if the session is already gone when firing", async () => {
            await wizard.start(key);
            await wizard.abort();
            expect(() => host.fireLatestTimer()).to.not.throw();
        });

        it("should reset the timer on each answer", async () => {
            await wizard.start(key);
            const before = host.timerCallbacks.length;
            await wizard.answer(true);
            await wizard.answer(false);
            expect(host.timerCallbacks.length).to.equal(before + 2);
            expect(host.clearedTimers).to.be.greaterThanOrEqual(2);
        });
    });

    describe("device disappears mid-session", () => {
        it("should clean up when device vanishes between answers", async () => {
            await wizard.start(key);
            host.devices.delete(key);
            const r = await wizard.answer(true);
            expect(r.error).to.be.a("string").and.include("disappeared");
            expect(wizard.isActive()).to.be.false;
        });

        it("should handle device missing at done", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            host.devices.delete(key);
            const r = await wizard.done();
            expect(r.error).to.be.a("string").and.include("disappeared");
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

    describe("localization", () => {
        it("should render English strings by default", async () => {
            const r = await wizard.start(key);
            expect(r.message).to.be.a("string").and.include("Wizard started");
            expect(wizard.getStatusText()).to.include("Can you see");
        });

        it("should render German strings when language is 'de'", async () => {
            host.language = "de";
            const r = await wizard.start(key);
            expect(r.message).to.be.a("string").and.include("gestartet");
            expect(wizard.getStatusText()).to.include("Siehst du");
        });

        it("should fall back to English for unknown languages", async () => {
            host.language = "fr"; // not in WIZARD_STRINGS
            const r = await wizard.start(key);
            expect(r.message).to.be.a("string").and.include("Wizard started");
        });
    });

    describe("flashSegment integration", () => {
        it("should always pass an object (not a string) for segmentBatch", async () => {
            await wizard.start(key);
            await wizard.answer(true);
            await wizard.answer(true);
            await wizard.answer(true);
            await wizard.done();
            for (const c of host.segmentBatchCalls()) {
                expect(c.value).to.be.an("object");
                expect(c.value).to.not.be.a("string");
            }
        });

        it("should use atomic flash when the host reports it available", async () => {
            host.atomicEnabled = true;
            await wizard.start(key);
            // No segmentBatch fallback calls when atomic succeeded
            const batches = host.segmentBatchCalls();
            expect(batches).to.have.lengthOf(0);
            expect(host.atomicFlashUsed).to.be.true;
        });
    });
});
