import { expect } from "chai";
import { StateManager } from "../src/lib/state-manager";
import type { GoveeDevice } from "../src/lib/types";
import type { StateDefinition } from "../src/lib/capability-mapper";

/** Track adapter method calls */
interface CallRecord {
    method: string;
    args: unknown[];
}

/** Create a mock adapter with call tracking */
function createMockAdapter(): {
    adapter: Record<string, unknown>;
    calls: CallRecord[];
    objects: Map<string, Record<string, unknown>>;
    states: Map<string, ioBroker.State>;
} {
    const calls: CallRecord[] = [];
    const objects = new Map<string, Record<string, unknown>>();
    const states = new Map<string, ioBroker.State>();

    const adapter = {
        namespace: "govee-smart.0",
        log: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            silly: () => {},
            level: "debug",
        },
        extendObjectAsync: async (id: string, obj: Record<string, unknown>) => {
            calls.push({ method: "extendObjectAsync", args: [id, obj] });
            objects.set(id, obj);
        },
        setStateAsync: async (id: string, val: Record<string, unknown>) => {
            calls.push({ method: "setStateAsync", args: [id, val] });
            states.set(id, val as unknown as ioBroker.State);
        },
        getStateAsync: async (id: string) => {
            calls.push({ method: "getStateAsync", args: [id] });
            return states.get(id) ?? null;
        },
        getObjectAsync: async (id: string) => {
            calls.push({ method: "getObjectAsync", args: [id] });
            return objects.get(id) ?? null;
        },
        delObjectAsync: async (id: string, _opts?: Record<string, unknown>) => {
            calls.push({ method: "delObjectAsync", args: [id] });
            // Remove all matching keys
            for (const key of objects.keys()) {
                if (key === id || key.startsWith(id + ".")) {
                    objects.delete(key);
                }
            }
        },
        delStateAsync: async (id: string) => {
            calls.push({ method: "delStateAsync", args: [id] });
            states.delete(id);
        },
        getObjectViewAsync: async (
            _type: string,
            viewType: string,
            opts: { startkey: string; endkey: string },
        ) => {
            calls.push({ method: "getObjectViewAsync", args: [_type, viewType, opts] });
            const rows: Array<{ id: string; value: unknown }> = [];
            const prefix = opts.startkey.replace("govee-smart.0.", "");
            for (const [key, obj] of objects.entries()) {
                if (key.startsWith(prefix)) {
                    // Filter by object type if viewType is specified (device, state, channel)
                    const objType = (obj as Record<string, unknown>)?.type as string;
                    if (objType && objType !== viewType) {
                        continue;
                    }
                    rows.push({ id: `govee-smart.0.${key}`, value: obj });
                }
            }
            return { rows };
        },
    };
    return { adapter, calls, objects, states };
}

/** Create a test device */
function createTestDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
    return {
        sku: "H6160",
        deviceId: "AABBCCDDEEFF0011",
        name: "Test Light",
        type: "light",
        lanIp: "192.168.1.100",
        capabilities: [],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false },
        ...overrides,
    };
}

/** Basic control state definitions */
function basicControlDefs(): StateDefinition[] {
    return [
        { id: "power", name: "Power", type: "boolean", role: "switch", write: true, def: false, capabilityType: "on_off", capabilityInstance: "powerSwitch" },
        { id: "brightness", name: "Brightness", type: "number", role: "level.brightness", write: true, min: 0, max: 100, unit: "%", def: 0, capabilityType: "range", capabilityInstance: "brightness" },
    ];
}

describe("StateManager", () => {
    describe("devicePrefix", () => {
        it("should generate prefix from SKU + last 4 hex chars of device ID", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ sku: "H61BE", deviceId: "AA:BB:CC:DD:EE:FF:1D:6F" });
            expect(sm.devicePrefix(dev)).to.equal("devices.h61be_1d6f");
        });

        it("should put BaseGroup under groups/ folder", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ sku: "BaseGroup", deviceId: "1280" });
            expect(sm.devicePrefix(dev)).to.equal("groups.basegroup_1280");
        });

        it("should sanitize special characters in SKU", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ sku: "H6-XY.Z", deviceId: "ABCD" });
            expect(sm.devicePrefix(dev)).to.equal("devices.h6-xy_z_abcd");
        });

        it("should handle device ID with colons", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ deviceId: "AA:BB:CC:DD:EE:FF:52:5F" });
            expect(sm.devicePrefix(dev)).to.equal("devices.h6160_525f");
        });
    });

    describe("createDeviceStates", () => {
        it("should create device, info channel, and info states", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            await sm.createDeviceStates(dev, []);

            // Device object
            expect(objects.has("devices.h6160_0011")).to.be.true;
            // Info channel
            expect(objects.has("devices.h6160_0011.info")).to.be.true;
            // Info states
            expect(objects.has("devices.h6160_0011.info.name")).to.be.true;
            expect(objects.has("devices.h6160_0011.info.model")).to.be.true;
            expect(objects.has("devices.h6160_0011.info.serial")).to.be.true;
            expect(objects.has("devices.h6160_0011.info.online")).to.be.true;
            expect(objects.has("devices.h6160_0011.info.ip")).to.be.true;
        });

        it("should set info state values from device", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ name: "Living Room", sku: "H612F", lanIp: "10.0.0.5" });

            await sm.createDeviceStates(dev, []);

            expect(states.get("devices.h612f_0011.info.name")).to.deep.include({ val: "Living Room" });
            expect(states.get("devices.h612f_0011.info.model")).to.deep.include({ val: "H612F" });
            expect(states.get("devices.h612f_0011.info.ip")).to.deep.include({ val: "10.0.0.5" });
            expect(states.get("devices.h612f_0011.info.online")).to.deep.include({ val: true });
        });

        it("should create control channel and states from definitions", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            await sm.createDeviceStates(dev, basicControlDefs());

            expect(objects.has("devices.h6160_0011.control")).to.be.true;
            expect(objects.has("devices.h6160_0011.control.power")).to.be.true;
            expect(objects.has("devices.h6160_0011.control.brightness")).to.be.true;
        });

        it("should set native capabilityType/Instance on control states", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            await sm.createDeviceStates(dev, basicControlDefs());

            const powerObj = objects.get("devices.h6160_0011.control.power") as Record<string, unknown>;
            const native = powerObj?.native as Record<string, unknown>;
            expect(native?.capabilityType).to.equal("on_off");
            expect(native?.capabilityInstance).to.equal("powerSwitch");
        });

        it("should set default value only if no current value exists", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // First call: should set default
            await sm.createDeviceStates(dev, basicControlDefs());
            expect(states.get("devices.h6160_0011.control.power")).to.deep.include({ val: false });

            // Simulate user setting the value
            states.set("devices.h6160_0011.control.power", { val: true, ack: false } as ioBroker.State);

            // Second call: should NOT overwrite existing value
            await sm.createDeviceStates(dev, basicControlDefs());
            expect(states.get("devices.h6160_0011.control.power")).to.deep.include({ val: true });
        });

        it("should not create control channel if no control definitions", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            await sm.createDeviceStates(dev, []);

            expect(objects.has("devices.h6160_0011.control")).to.be.false;
        });

        it("should include unit, min, max, states in common", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [{
                id: "brightness",
                name: "Brightness",
                type: "number",
                role: "level.brightness",
                write: true,
                min: 0,
                max: 100,
                unit: "%",
                def: 50,
                capabilityType: "range",
                capabilityInstance: "brightness",
            }];

            await sm.createDeviceStates(dev, defs);

            const obj = objects.get("devices.h6160_0011.control.brightness") as Record<string, unknown>;
            const common = obj?.common as Record<string, unknown>;
            expect(common?.min).to.equal(0);
            expect(common?.max).to.equal(100);
            expect(common?.unit).to.equal("%");
        });

        it("should route light_scene to scenes channel", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [{
                id: "light_scene",
                name: "Scene",
                type: "string",
                role: "text",
                write: true,
                states: { "0": "---", "1": "Sunset", "2": "Rainbow" },
                def: "0",
                capabilityType: "dynamic_scene",
                capabilityInstance: "lightScene",
                channel: "scenes",
            }];

            await sm.createDeviceStates(dev, defs);

            // Must be in scenes channel, not control
            expect(objects.has("devices.h6160_0011.scenes")).to.be.true;
            expect(objects.has("devices.h6160_0011.scenes.light_scene")).to.be.true;
            expect(objects.has("devices.h6160_0011.control.light_scene")).to.be.false;

            const obj = objects.get("devices.h6160_0011.scenes.light_scene") as Record<string, unknown>;
            const common = obj?.common as Record<string, unknown>;
            const objStates = common?.states as Record<string, string>;
            expect(objStates?.["1"]).to.equal("Sunset");
            expect(objStates?.["2"]).to.equal("Rainbow");
        });

        it("should route music states to music channel", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [
                { id: "music_mode", name: "Music Mode", type: "string", role: "text", write: true, def: "0", capabilityType: "music_setting", capabilityInstance: "musicMode", channel: "music" },
                { id: "music_sensitivity", name: "Sensitivity", type: "number", role: "level", write: true, min: 0, max: 100, def: 100, capabilityType: "music_setting", capabilityInstance: "musicMode", channel: "music" },
            ];

            await sm.createDeviceStates(dev, defs);

            expect(objects.has("devices.h6160_0011.music")).to.be.true;
            expect(objects.has("devices.h6160_0011.music.music_mode")).to.be.true;
            expect(objects.has("devices.h6160_0011.music.music_sensitivity")).to.be.true;
            expect(objects.has("devices.h6160_0011.control.music_mode")).to.be.false;
        });

        it("should route snapshot states to snapshots channel", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [
                { id: "snapshot", name: "Snapshot", type: "string", role: "text", write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "snapshot", channel: "snapshots" },
                { id: "snapshot_local", name: "Local Snapshot", type: "string", role: "text", write: true, def: "0", capabilityType: "local", capabilityInstance: "snapshotLocal", channel: "snapshots" },
                { id: "snapshot_save", name: "Save", type: "string", role: "text", write: true, def: "", capabilityType: "local", capabilityInstance: "snapshotSave", channel: "snapshots" },
                { id: "snapshot_delete", name: "Delete", type: "string", role: "text", write: true, def: "", capabilityType: "local", capabilityInstance: "snapshotDelete", channel: "snapshots" },
            ];

            await sm.createDeviceStates(dev, defs);

            expect(objects.has("devices.h6160_0011.snapshots")).to.be.true;
            expect(objects.has("devices.h6160_0011.snapshots.snapshot")).to.be.true;
            expect(objects.has("devices.h6160_0011.snapshots.snapshot_local")).to.be.true;
            expect(objects.has("devices.h6160_0011.snapshots.snapshot_save")).to.be.true;
            expect(objects.has("devices.h6160_0011.snapshots.snapshot_delete")).to.be.true;
            expect(objects.has("devices.h6160_0011.control.snapshot")).to.be.false;
        });

        it("should create multiple channels simultaneously", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [
                ...basicControlDefs(),
                { id: "light_scene", name: "Scene", type: "string", role: "text", write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "lightScene", channel: "scenes" },
                { id: "music_mode", name: "Music", type: "string", role: "text", write: true, def: "0", capabilityType: "music_setting", capabilityInstance: "musicMode", channel: "music" },
                { id: "snapshot_save", name: "Save", type: "string", role: "text", write: true, def: "", capabilityType: "local", capabilityInstance: "snapshotSave", channel: "snapshots" },
            ];

            await sm.createDeviceStates(dev, defs);

            expect(objects.has("devices.h6160_0011.control")).to.be.true;
            expect(objects.has("devices.h6160_0011.scenes")).to.be.true;
            expect(objects.has("devices.h6160_0011.music")).to.be.true;
            expect(objects.has("devices.h6160_0011.snapshots")).to.be.true;
        });

        it("should set ip to empty string when no LAN IP", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ lanIp: undefined });

            await sm.createDeviceStates(dev, []);

            expect(states.get("devices.h6160_0011.info.ip")).to.deep.include({ val: "" });
        });

        it("should not create model/serial/ip/online for BaseGroup", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ sku: "BaseGroup", deviceId: "1280" });

            await sm.createDeviceStates(dev, []);

            expect(objects.has("groups.basegroup_1280.info.name")).to.be.true;
            expect(objects.has("groups.basegroup_1280.info.online")).to.be.false;
            expect(objects.has("groups.basegroup_1280.info.model")).to.be.false;
            expect(objects.has("groups.basegroup_1280.info.serial")).to.be.false;
            expect(objects.has("groups.basegroup_1280.info.ip")).to.be.false;
        });
    });

    describe("createGroupsOnlineState", () => {
        it("should create groups.info.online state", async () => {
            const { adapter, objects, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);

            await sm.createGroupsOnlineState(true);

            expect(objects.has("groups")).to.be.true;
            expect(objects.has("groups.info")).to.be.true;
            expect(objects.has("groups.info.online")).to.be.true;
            expect(states.get("groups.info.online")).to.deep.include({ val: true });
        });

        it("should update groups online state", async () => {
            const { adapter, objects, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);

            await sm.createGroupsOnlineState(false);
            expect(states.get("groups.info.online")).to.deep.include({ val: false });

            // Simulate object exists for setStateIfExists
            objects.set("groups.info.online", { type: "state" } as never);
            await sm.updateGroupsOnline(true);
            expect(states.get("groups.info.online")).to.deep.include({ val: true });
        });
    });

    describe("group members", () => {
        it("should create info.members for BaseGroup with groupMembers", async () => {
            const { adapter, objects, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                sku: "BaseGroup",
                deviceId: "6781311",
                name: "living",
                groupMembers: [
                    { sku: "H61BE", deviceId: "22:78:CA:39:32:35:52:5F" },
                    { sku: "H61BC", deviceId: "AA:BB:CC:DD:EE:FF:1A:2B" },
                ],
            });

            await sm.createDeviceStates(dev, []);

            expect(objects.has("groups.basegroup_1311.info.members")).to.be.true;
            const val = states.get("groups.basegroup_1311.info.members");
            expect(val).to.exist;
            expect(val!.val).to.equal("h61be_525f, h61bc_1a2b");
        });

        it("should create empty info.members for BaseGroup without groupMembers", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                sku: "BaseGroup",
                deviceId: "6781280",
                name: "test group",
            });

            await sm.createDeviceStates(dev, []);

            const val = states.get("groups.basegroup_1280.info.members");
            expect(val).to.exist;
            expect(val!.val).to.equal("");
        });

        it("should clean up diagnostics states for BaseGroup", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });

            await sm.createDeviceStates(dev, []);

            const delCalls = calls
                .filter((c) => c.method === "delObjectAsync")
                .map((c) => c.args[0] as string);
            expect(delCalls).to.include("groups.basegroup_1311.info.diagnostics_export");
            expect(delCalls).to.include("groups.basegroup_1311.info.diagnostics_result");
        });
    });

    describe("updateGroupMembersUnreachable", () => {
        it("should create state when unreachable members exist", async () => {
            const { adapter, objects, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
            const m1 = createTestDevice({ sku: "H61BE", deviceId: "AABB0011", state: { online: false } });
            const m2 = createTestDevice({ sku: "H61BC", deviceId: "CCDD2233", state: { online: true } });

            await sm.updateGroupMembersUnreachable(group, [m1, m2]);

            expect(objects.has("groups.basegroup_1311.info.membersUnreachable")).to.be.true;
            const val = states.get("groups.basegroup_1311.info.membersUnreachable");
            expect(val!.val).to.equal("h61be_0011");
        });

        it("should delete state when all members are reachable", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
            const m1 = createTestDevice({ state: { online: true } });

            await sm.updateGroupMembersUnreachable(group, [m1]);

            const delCalls = calls
                .filter((c) => c.method === "delObjectAsync")
                .map((c) => c.args[0] as string);
            expect(delCalls).to.include("groups.basegroup_1311.info.membersUnreachable");
        });
    });

    describe("resolveStatePath", () => {
        it("should route control states to control channel", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            expect(sm.resolveStatePath("devices.h6160_0011", "power")).to.equal("devices.h6160_0011.control.power");
            expect(sm.resolveStatePath("devices.h6160_0011", "brightness")).to.equal("devices.h6160_0011.control.brightness");
        });

        it("should route scene states to scenes channel", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, [
                { id: "light_scene", name: "Scene", type: "string", role: "text", write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "lightScene", channel: "scenes" },
                { id: "diy_scene", name: "DIY", type: "string", role: "text", write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "diyScene", channel: "scenes" },
                { id: "scene_speed", name: "Speed", type: "number", role: "level", write: true, def: 0, capabilityType: "local", capabilityInstance: "sceneSpeed", channel: "scenes" },
            ]);
            expect(sm.resolveStatePath("devices.h6160_0011", "light_scene")).to.equal("devices.h6160_0011.scenes.light_scene");
            expect(sm.resolveStatePath("devices.h6160_0011", "diy_scene")).to.equal("devices.h6160_0011.scenes.diy_scene");
            expect(sm.resolveStatePath("devices.h6160_0011", "scene_speed")).to.equal("devices.h6160_0011.scenes.scene_speed");
        });

        it("should route music states to music channel", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, [
                { id: "music_mode", name: "Music", type: "string", role: "text", write: true, def: "0", capabilityType: "music_setting", capabilityInstance: "musicMode", channel: "music" },
            ]);
            expect(sm.resolveStatePath("devices.h6160_0011", "music_mode")).to.equal("devices.h6160_0011.music.music_mode");
        });

        it("should route snapshot states to snapshots channel", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, [
                { id: "snapshot", name: "Snapshot", type: "string", role: "text", write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "snapshot", channel: "snapshots" },
                { id: "snapshot_local", name: "Local", type: "string", role: "text", write: true, def: "0", capabilityType: "local", capabilityInstance: "snapshotLocal", channel: "snapshots" },
            ]);
            expect(sm.resolveStatePath("devices.h6160_0011", "snapshot")).to.equal("devices.h6160_0011.snapshots.snapshot");
            expect(sm.resolveStatePath("devices.h6160_0011", "snapshot_local")).to.equal("devices.h6160_0011.snapshots.snapshot_local");
        });

        it("should route diagnostics states to info channel", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, [
                { id: "diagnostics_export", name: "Export", type: "boolean", role: "button", write: true, def: false, capabilityType: "local", capabilityInstance: "diagnosticsExport", channel: "info" },
                { id: "diagnostics_result", name: "Result", type: "string", role: "json", write: false, def: "", capabilityType: "local", capabilityInstance: "diagnosticsResult", channel: "info" },
            ]);
            expect(sm.resolveStatePath("devices.h6160_0011", "diagnostics_export")).to.equal("devices.h6160_0011.info.diagnostics_export");
            expect(sm.resolveStatePath("devices.h6160_0011", "diagnostics_result")).to.equal("devices.h6160_0011.info.diagnostics_result");
        });

        it("should route unknown states to control channel", () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            expect(sm.resolveStatePath("devices.h6160_0011", "gradient_toggle")).to.equal("devices.h6160_0011.control.gradient_toggle");
        });
    });

    describe("updateDeviceState", () => {
        it("should update power state", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // Create the object so setStateIfExists finds it
            await sm.createDeviceStates(dev, basicControlDefs());

            await sm.updateDeviceState(dev, { power: true });
            expect(states.get("devices.h6160_0011.control.power")).to.deep.include({ val: true });
        });

        it("should update multiple state fields at once", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, basicControlDefs());

            await sm.updateDeviceState(dev, { power: true, brightness: 75 });

            expect(states.get("devices.h6160_0011.control.power")).to.deep.include({ val: true });
            expect(states.get("devices.h6160_0011.control.brightness")).to.deep.include({ val: 75 });
        });

        it("should update online status", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, []);

            await sm.updateDeviceState(dev, { online: false });
            expect(states.get("devices.h6160_0011.info.online")).to.deep.include({ val: false });
        });

        it("should not update fields that are undefined", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            await sm.createDeviceStates(dev, basicControlDefs());

            const before = calls.filter((c) => c.method === "getObjectAsync").length;
            await sm.updateDeviceState(dev, {});
            const after = calls.filter((c) => c.method === "getObjectAsync").length;
            // No getObjectAsync calls means nothing was checked
            expect(after - before).to.equal(0);
        });

        it("should skip if object does not exist", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();
            // Don't create states first

            await sm.updateDeviceState(dev, { colorRgb: "#ff0000" });
            // No state should have been set (object doesn't exist)
            const setStateCalls = [...states.keys()];
            expect(setStateCalls).to.not.include("devices.h6160_0011.control.colorRgb");
        });
    });

    describe("cleanupDevices", () => {
        it("should remove devices not in current list", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);

            // Create two devices
            const dev1 = createTestDevice({ sku: "H6160", deviceId: "AABB1111" });
            const dev2 = createTestDevice({ sku: "H6161", deviceId: "AABB2222" });
            await sm.createDeviceStates(dev1, []);
            await sm.createDeviceStates(dev2, []);

            // Cleanup with only dev1 as current
            await sm.cleanupDevices([dev1]);

            const delCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && (c.args[0] as string).includes("h6161"),
            );
            expect(delCalls.length).to.be.greaterThan(0);
        });

        it("should not remove devices that still exist", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);

            const dev = createTestDevice();
            await sm.createDeviceStates(dev, []);

            await sm.cleanupDevices([dev]);

            // No delObjectAsync calls should target the device prefix
            const delDeviceCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && (c.args[0] as string).startsWith("devices.h6160"),
            );
            expect(delDeviceCalls.length).to.equal(0);
        });
    });

    describe("cleanupAllChannelStates", () => {
        it("should remove stale control states not in current definitions", async () => {
            const { adapter, calls, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // Create with power + brightness
            await sm.createDeviceStates(dev, basicControlDefs());
            expect(objects.has("devices.h6160_0011.control.brightness")).to.be.true;

            // Recreate with only power — brightness should be cleaned up
            const powerOnly: StateDefinition[] = [basicControlDefs()[0]];
            await sm.createDeviceStates(dev, powerOnly);

            const delCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && (c.args[0] as string).includes("brightness"),
            );
            expect(delCalls.length).to.be.greaterThan(0);
        });

        it("should remove empty channel when all states deleted", async () => {
            const { adapter, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // Create with one state
            await sm.createDeviceStates(dev, [basicControlDefs()[0]]);

            // Recreate with no states — control channel should be removed
            await sm.createDeviceStates(dev, []);

            // The cleanup finds the previously created "control.power" and deletes it
            const delCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && (c.args[0] as string).includes("control"),
            );
            expect(delCalls.length).to.be.greaterThan(0);
        });

        it("should migrate states from old control to new channel", async () => {
            const { adapter, objects, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // Simulate old layout: light_scene in control channel
            objects.set("devices.h6160_0011.control.light_scene", { type: "state" });

            // Create with light_scene in scenes channel
            const defs: StateDefinition[] = [{
                id: "light_scene", name: "Scene", type: "string", role: "text",
                write: true, def: "0", capabilityType: "dynamic_scene", capabilityInstance: "lightScene",
                channel: "scenes",
            }];
            await sm.createDeviceStates(dev, defs);

            // Old control.light_scene should be deleted (it's stale in control)
            const delCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && (c.args[0] as string) === "devices.h6160_0011.control.light_scene",
            );
            expect(delCalls.length).to.be.greaterThan(0);
            // New scenes.light_scene should exist
            expect(objects.has("devices.h6160_0011.scenes.light_scene")).to.be.true;
        });

        it("should reset dropdown to default when current value is no longer in states map", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            // Create with 3 scenes: {0: "---", 1: "Scene A", 2: "Scene B"}
            const defs: StateDefinition[] = [{
                id: "light_scene", name: "Scene", type: "string", role: "text",
                write: true, def: "0", states: { 0: "---", 1: "Scene A", 2: "Scene B" },
                capabilityType: "dynamic_scene", capabilityInstance: "lightScene",
                channel: "scenes",
            }];
            await sm.createDeviceStates(dev, defs);

            // Simulate user selected scene 2
            states.set("devices.h6160_0011.scenes.light_scene", { val: "2", ack: true } as ioBroker.State);

            // Re-create with only 1 scene — scene 2 no longer valid
            const newDefs: StateDefinition[] = [{
                id: "light_scene", name: "Scene", type: "string", role: "text",
                write: true, def: "0", states: { 0: "---", 1: "Scene A" },
                capabilityType: "dynamic_scene", capabilityInstance: "lightScene",
                channel: "scenes",
            }];
            await sm.createDeviceStates(dev, newDefs);

            // Value should be reset to default "0"
            const final = states.get("devices.h6160_0011.scenes.light_scene");
            expect(final?.val).to.equal("0");
        });

        it("should keep dropdown value when it is still valid in states map", async () => {
            const { adapter, states } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice();

            const defs: StateDefinition[] = [{
                id: "light_scene", name: "Scene", type: "string", role: "text",
                write: true, def: "0", states: { 0: "---", 1: "Scene A", 2: "Scene B" },
                capabilityType: "dynamic_scene", capabilityInstance: "lightScene",
                channel: "scenes",
            }];
            await sm.createDeviceStates(dev, defs);

            // Simulate user selected scene 1
            states.set("devices.h6160_0011.scenes.light_scene", { val: "1", ack: true } as ioBroker.State);

            // Re-create with same scenes — value should remain
            await sm.createDeviceStates(dev, defs);

            const final = states.get("devices.h6160_0011.scenes.light_scene");
            expect(final?.val).to.equal("1");
        });
    });

    describe("createSegmentStates", () => {
        it("should create segment channel and per-segment states", async () => {
            const { adapter, objects } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                capabilities: [{
                    type: "devices.capabilities.segment_color_setting",
                    instance: "segmentedColorRgb",
                    parameters: {
                        dataType: "STRUCT",
                        fields: [{ fieldName: "segment", elementRange: { min: 0, max: 9 } }],
                    },
                }],
            });

            const segmentDefs: StateDefinition[] = [{
                id: "_segment_color",
                name: "Segment",
                type: "string",
                role: "level.color.rgb",
                write: true,
                capabilityType: "segment",
                capabilityInstance: "segmentColor",
            }];

            await sm.createDeviceStates(dev, segmentDefs);

            expect(objects.has("devices.h6160_0011.segments")).to.be.true;
            expect(objects.has("devices.h6160_0011.segments.0")).to.be.true;
            expect(objects.has("devices.h6160_0011.segments.0.color")).to.be.true;
            expect(objects.has("devices.h6160_0011.segments.0.brightness")).to.be.true;
            expect(objects.has("devices.h6160_0011.segments.9")).to.be.true;
            expect(objects.has("devices.h6160_0011.segments.command")).to.be.true;
            expect(dev.segmentCount).to.equal(10);
        });

        it("should return 0 segments when field has no elementRange", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                capabilities: [{
                    type: "devices.capabilities.segment_color_setting",
                    instance: "segmentedColorRgb",
                    parameters: {
                        dataType: "STRUCT" as const,
                        fields: [{ fieldName: "segment" }],
                    },
                }],
            });

            const segmentDefs: StateDefinition[] = [{
                id: "_segment_color",
                name: "Segment",
                type: "string",
                role: "level.color.rgb",
                write: true,
                capabilityType: "segment",
                capabilityInstance: "segmentColor",
            }];

            await sm.createDeviceStates(dev, segmentDefs);

            expect(dev.segmentCount).to.equal(0);
        });

        it("should remove excess segment channels from previous runs", async () => {
            const { adapter, objects, calls } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                capabilities: [{
                    type: "devices.capabilities.segment_color_setting",
                    instance: "segmentedColorRgb",
                    parameters: {
                        dataType: "STRUCT",
                        fields: [{ fieldName: "segment", elementRange: { min: 0, max: 4 } }],
                    },
                }],
            });

            // Simulate old segment channels 0-14 existing
            for (let i = 0; i < 15; i++) {
                objects.set(`devices.h6160_0011.segments.${i}`, { type: "channel" });
            }

            const segmentDefs: StateDefinition[] = [{
                id: "_segment_color",
                name: "Segment",
                type: "string",
                role: "level.color.rgb",
                write: true,
                capabilityType: "segment",
                capabilityInstance: "segmentColor",
            }];

            await sm.createDeviceStates(dev, segmentDefs);

            expect(dev.segmentCount).to.equal(5);
            // Segments 5-14 should be deleted
            const delCalls = calls.filter(
                (c) => c.method === "delObjectAsync" && /segments\.\d+$/.test(c.args[0] as string),
            );
            expect(delCalls.length).to.equal(10);
        });

        it("should return 0 segments when capability has no fields", async () => {
            const { adapter } = createMockAdapter();
            const sm = new StateManager(adapter as never);
            const dev = createTestDevice({
                capabilities: [{
                    type: "devices.capabilities.segment_color_setting",
                    instance: "segmentedColorRgb",
                    parameters: { dataType: "STRUCT" as const },
                }],
            });

            const segmentDefs: StateDefinition[] = [{
                id: "_segment_color",
                name: "Segment",
                type: "string",
                role: "level.color.rgb",
                write: true,
                capabilityType: "segment",
                capabilityInstance: "segmentColor",
            }];

            await sm.createDeviceStates(dev, segmentDefs);

            expect(dev.segmentCount).to.equal(0);
        });
    });
});
