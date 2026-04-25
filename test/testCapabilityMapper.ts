import { expect } from "chai";
import { applyQuirksToStates, buildDeviceStateDefs, getDefaultLanStates, mapCapabilities, mapCloudStateValue } from "../src/lib/capability-mapper";
import type { CloudCapability, CloudStateCapability, GoveeDevice } from "../src/lib/types";

describe("CapabilityMapper", () => {
    describe("mapCapabilities", () => {
        it("should map on_off to boolean power state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.on_off",
                    instance: "powerSwitch",
                    parameters: { dataType: "ENUM", options: [{ name: "off", value: 0 }, { name: "on", value: 1 }] },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("power");
            expect(result[0].type).to.equal("boolean");
            expect(result[0].role).to.equal("switch");
            expect(result[0].write).to.be.true;
        });

        it("should map range brightness with min/max", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.range",
                    instance: "brightness",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 }, unit: "%" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("brightness");
            expect(result[0].type).to.equal("number");
            expect(result[0].role).to.equal("level.brightness");
            expect(result[0].min).to.equal(0);
            expect(result[0].max).to.equal(100);
        });

        it("should map colorRgb to string state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.color_setting",
                    instance: "colorRgb",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 16777215, precision: 1 } },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("colorRgb");
            expect(result[0].type).to.equal("string");
            expect(result[0].role).to.equal("level.color.rgb");
        });

        it("should map colorTemperatureK to number state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.color_setting",
                    instance: "colorTemperatureK",
                    parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("colorTemperature");
            expect(result[0].min).to.equal(2000);
            expect(result[0].max).to.equal(9000);
            expect(result[0].unit).to.equal("K");
        });

        it("should map presetScene with dropdown states", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.mode",
                    instance: "presetScene",
                    parameters: {
                        dataType: "ENUM",
                        options: [
                            { name: "Sunset", value: 1 },
                            { name: "Rainbow", value: 2 },
                            { name: "Movie", value: 3 },
                        ],
                    },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("scene");
            expect(result[0].states).to.deep.equal({ "1": "Sunset", "2": "Rainbow", "3": "Movie" });
            expect(result[0].write).to.be.true;
        });

        it("should map property as read-only", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.property",
                    instance: "sensorTemperature",
                    parameters: { dataType: "INTEGER", range: { min: -20, max: 60, precision: 1 }, unit: "°C" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].write).to.be.false;
            expect(result[0].role).to.equal("value.temperature");
        });

        it("should map toggle to boolean switch", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.toggle",
                    instance: "oscillationToggle",
                    parameters: { dataType: "ENUM", options: [{ name: "off", value: 0 }, { name: "on", value: 1 }] },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].type).to.equal("boolean");
            expect(result[0].role).to.equal("switch");
        });

        it("should skip online capability", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.online",
                    instance: "online",
                    parameters: { dataType: "ENUM" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should handle multiple capabilities for a typical light", () => {
            const caps: CloudCapability[] = [
                { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
                { type: "devices.capabilities.range", instance: "brightness", parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } } },
                { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
                { type: "devices.capabilities.color_setting", instance: "colorTemperatureK", parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } } },
                { type: "devices.capabilities.online", instance: "online", parameters: { dataType: "ENUM" } },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(4);
            expect(result.map((r) => r.id)).to.deep.equal(["power", "brightness", "colorRgb", "colorTemperature"]);
        });
    });

    describe("getDefaultLanStates", () => {
        it("should return power, brightness, colorRgb, colorTemperature", () => {
            const defs = getDefaultLanStates();
            expect(defs).to.have.lengthOf(4);
            expect(defs.map((d) => d.id)).to.deep.equal(["power", "brightness", "colorRgb", "colorTemperature"]);
        });

        it("should have correct types and roles", () => {
            const defs = getDefaultLanStates();
            const power = defs.find((d) => d.id === "power")!;
            expect(power.type).to.equal("boolean");
            expect(power.role).to.equal("switch");
            expect(power.write).to.be.true;

            const brightness = defs.find((d) => d.id === "brightness")!;
            expect(brightness.type).to.equal("number");
            expect(brightness.role).to.equal("level.brightness");
            expect(brightness.min).to.equal(0);
            expect(brightness.max).to.equal(100);

            const color = defs.find((d) => d.id === "colorRgb")!;
            expect(color.type).to.equal("string");
            expect(color.role).to.equal("level.color.rgb");

            const temp = defs.find((d) => d.id === "colorTemperature")!;
            expect(temp.type).to.equal("number");
            expect(temp.min).to.equal(2000);
            expect(temp.max).to.equal(9000);
            expect(temp.unit).to.equal("K");
        });
    });

    describe("mapCapabilities — additional branches", () => {
        it("should map segment_color_setting to JSON state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.segment_color_setting",
                    instance: "segmentedColorRgb",
                    parameters: { dataType: "STRUCT" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("_segment_segmented_color_rgb");
            expect(result[0].type).to.equal("string");
            expect(result[0].role).to.equal("json");
        });

        it("should skip dynamic_scene for lightScene/diyScene/snapshot (handled by buildDeviceStateDefs)", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.dynamic_scene",
                    instance: "lightScene",
                    parameters: { dataType: "STRUCT" },
                },
                {
                    type: "devices.capabilities.dynamic_scene",
                    instance: "diyScene",
                    parameters: { dataType: "STRUCT" },
                },
                {
                    type: "devices.capabilities.dynamic_scene",
                    instance: "snapshot",
                    parameters: { dataType: "STRUCT" },
                },
            ];
            // These three instances become real dropdowns in buildDeviceStateDefs
            // fed from device.scenes / diyScenes / snapshots — mapCapabilities
            // returns nothing so no generic stub has to be filtered out later.
            expect(mapCapabilities(caps)).to.have.lengthOf(0);
        });

        it("should skip music_setting without fields", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.music_setting",
                    instance: "musicMode",
                    parameters: { dataType: "STRUCT" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should map music_setting with fields to dropdown + slider + toggle", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.music_setting",
                    instance: "musicMode",
                    parameters: {
                        dataType: "STRUCT",
                        fields: [
                            {
                                fieldName: "musicMode",
                                dataType: "ENUM",
                                options: [
                                    { name: "Energic", value: 5 },
                                    { name: "Rhythm", value: 3 },
                                    { name: "Spectrum", value: 6 },
                                ],
                            },
                            {
                                fieldName: "sensitivity",
                                dataType: "INTEGER",
                                range: { min: 0, max: 100, precision: 1 },
                            },
                            {
                                fieldName: "autoColor",
                                dataType: "ENUM",
                                options: [
                                    { name: "on", value: 1 },
                                    { name: "off", value: 0 },
                                ],
                            },
                        ],
                    },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(3);

            // Mode dropdown
            expect(result[0].id).to.equal("music_mode");
            expect(result[0].role).to.equal("text");
            // mixed lets users write the mode key ("5") or the label ("Energic")
            expect(result[0].type).to.equal("mixed");
            expect(result[0].states).to.deep.include({ 5: "Energic", 3: "Rhythm", 6: "Spectrum" });

            // Sensitivity slider
            expect(result[1].id).to.equal("music_sensitivity");
            expect(result[1].type).to.equal("number");
            expect(result[1].min).to.equal(0);
            expect(result[1].max).to.equal(100);

            // Auto color toggle
            expect(result[2].id).to.equal("music_auto_color");
            expect(result[2].type).to.equal("boolean");
        });

        it("should map work_mode to JSON state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.work_mode",
                    instance: "workMode",
                    parameters: { dataType: "STRUCT" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("work_mode");
        });

        it("should skip mode with non-presetScene instance", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.mode",
                    instance: "someOtherMode",
                    parameters: { dataType: "ENUM", options: [{ name: "A", value: 1 }] },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should return empty for unknown color_setting instance", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.color_setting",
                    instance: "unknownColorMode",
                    parameters: { dataType: "INTEGER" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should skip unknown capability types", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.completely_unknown",
                    instance: "foo",
                    parameters: { dataType: "ENUM" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should normalize unit.percent to %", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.range",
                    instance: "brightness",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 }, unit: "unit.percent" },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result[0].unit).to.equal("%");
        });

        it("should map property humidity with correct role", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.property",
                    instance: "sensorHumidity",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } },
                },
            ];
            const result = mapCapabilities(caps);
            expect(result[0].role).to.equal("value.humidity");
            expect(result[0].unit).to.equal("%");
        });

        it("should handle empty capabilities array", () => {
            const result = mapCapabilities([]);
            expect(result).to.have.lengthOf(0);
        });
    });

    describe("mapCloudStateValue", () => {
        it("should map on_off to power boolean", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.on_off",
                instance: "powerSwitch",
                state: { value: 1 },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.not.be.null;
            expect(result!.stateId).to.equal("power");
            expect(result!.value).to.be.true;
        });

        it("should map on_off 0 to false", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.on_off",
                instance: "powerSwitch",
                state: { value: 0 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.value).to.be.false;
        });

        it("should map colorRgb integer to hex string", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.color_setting",
                instance: "colorRgb",
                state: { value: 0xff8000 }, // orange
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("colorRgb");
            expect(result!.value).to.equal("#ff8000");
        });

        it("should map colorRgb 0 to black", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.color_setting",
                instance: "colorRgb",
                state: { value: 0 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.value).to.equal("#000000");
        });

        it("should map colorRgb white (16777215)", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.color_setting",
                instance: "colorRgb",
                state: { value: 16777215 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.value).to.equal("#ffffff");
        });

        it("should map colorTemperatureK to number", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.color_setting",
                instance: "colorTemperatureK",
                state: { value: 4000 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("colorTemperature");
            expect(result!.value).to.equal(4000);
        });

        it("should map range brightness to number", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.range",
                instance: "brightness",
                state: { value: 75 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("brightness");
            expect(result!.value).to.equal(75);
        });

        it("should map toggle to boolean", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.toggle",
                instance: "gradientToggle",
                state: { value: 1 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("gradient_toggle");
            expect(result!.value).to.be.true;
        });

        it("should map toggle 0 to false", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.toggle",
                instance: "gradientToggle",
                state: { value: 0 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.value).to.be.false;
        });

        it("should map dynamic_scene object to JSON string", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.dynamic_scene",
                instance: "lightScene",
                state: { value: { id: 123, paramId: "abc" } },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("light_scene");
            expect(result!.value).to.equal('{"id":123,"paramId":"abc"}');
        });

        it("should map property to number", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.property",
                instance: "sensorTemperature",
                state: { value: 22.5 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("sensor_temperature");
            expect(result!.value).to.equal(22.5);
        });

        it("should map presetScene to string", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.mode",
                instance: "presetScene",
                state: { value: 42 },
            };
            const result = mapCloudStateValue(cap);
            expect(result!.stateId).to.equal("scene");
            expect(result!.value).to.equal("42");
        });

        it("should return null for null state value", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.on_off",
                instance: "powerSwitch",
                state: { value: null },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.be.null;
        });

        it("should return null for undefined state value", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.on_off",
                instance: "powerSwitch",
                state: { value: undefined },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.be.null;
        });

        it("should return null for unknown capability type", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.completely_unknown",
                instance: "foo",
                state: { value: 1 },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.be.null;
        });

        it("should return null for non-presetScene mode", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.mode",
                instance: "someOtherMode",
                state: { value: 1 },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.be.null;
        });

        it("should return null for unknown color_setting instance", () => {
            const cap: CloudStateCapability = {
                type: "devices.capabilities.color_setting",
                instance: "unknownColor",
                state: { value: 100 },
            };
            const result = mapCloudStateValue(cap);
            expect(result).to.be.null;
        });
    });

    describe("applyQuirksToStates", () => {
        it("should correct colorTemperature range for known SKU", () => {
            const states = getDefaultLanStates();
            applyQuirksToStates("H60A1", states);
            const ct = states.find((s) => s.id === "colorTemperature");
            expect(ct).to.not.be.undefined;
            expect(ct!.min).to.equal(2200);
            expect(ct!.max).to.equal(6500);
            expect(ct!.def).to.equal(2200);
        });

        it("should not change colorTemperature range for unknown SKU", () => {
            const states = getDefaultLanStates();
            applyQuirksToStates("H9999", states);
            const ct = states.find((s) => s.id === "colorTemperature");
            expect(ct!.min).to.equal(2000);
            expect(ct!.max).to.equal(9000);
        });

        it("should not affect non-colorTemperature states", () => {
            const states = getDefaultLanStates();
            applyQuirksToStates("H60A1", states);
            const brightness = states.find((s) => s.id === "brightness");
            expect(brightness!.min).to.equal(0);
            expect(brightness!.max).to.equal(100);
        });
    });

    describe("buildDeviceStateDefs dropdown contract (Blockly dual-write)", () => {
        function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
            return {
                sku: "H61BE",
                deviceId: "AABBCCDDEEFF0011",
                name: "Test Light",
                type: "devices.types.light",
                lanIp: "192.168.1.100",
                capabilities: [
                    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
                ],
                scenes: [],
                diyScenes: [],
                snapshots: [],
                sceneLibrary: [],
                musicLibrary: [],
                diyLibrary: [],
                skuFeatures: null,
                state: { online: true },
                channels: { lan: true, mqtt: false, cloud: true },
                ...overrides,
            };
        }

        it("light_scene must be type:mixed with disambiguated labels", () => {
            const device = makeDevice({
                scenes: [
                    { name: "Aurora", value: { id: 1 } },
                    { name: "Movie", value: { id: 2 } },
                    { name: "Movie", value: { id: 3 } },  // duplicate
                ],
            });
            const defs = buildDeviceStateDefs(device);
            const sceneDef = defs.find((d) => d.id === "light_scene");
            expect(sceneDef).to.exist;
            expect(sceneDef!.type).to.equal("mixed");
            expect(sceneDef!.states).to.deep.equal({
                0: "---",
                1: "Aurora",
                2: "Movie",
                3: "Movie (2)",
            });
        });

        it("diy_scene must be type:mixed", () => {
            const device = makeDevice({
                diyScenes: [{ name: "MyDIY", value: { id: 99 } }],
            });
            const defs = buildDeviceStateDefs(device);
            const diyDef = defs.find((d) => d.id === "diy_scene");
            expect(diyDef).to.exist;
            expect(diyDef!.type).to.equal("mixed");
        });

        it("snapshot_cloud must be type:mixed", () => {
            const device = makeDevice({
                snapshots: [{ name: "My Snap", value: { id: 7 } }],
            });
            const defs = buildDeviceStateDefs(device);
            const snapDef = defs.find((d) => d.id === "snapshot_cloud");
            expect(snapDef).to.exist;
            expect(snapDef!.type).to.equal("mixed");
        });

        it("snapshot_local must be type:mixed even with empty list", () => {
            const device = makeDevice();
            const defs = buildDeviceStateDefs(device, undefined);
            const localDef = defs.find((d) => d.id === "snapshot_local");
            expect(localDef).to.exist;
            expect(localDef!.type).to.equal("mixed");
            expect(localDef!.states).to.deep.equal({ 0: "---" });
        });
    });

    describe("buildDeviceStateDefs for groups", () => {
        function createMember(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
            return {
                sku: "H61BE",
                deviceId: "AABBCCDDEEFF0011",
                name: "Test Light",
                type: "devices.types.light",
                lanIp: "192.168.1.100",
                capabilities: [],
                scenes: [
                    { name: "Sunset", value: { id: 1 } },
                    { name: "Rainbow", value: { id: 2 } },
                ],
                diyScenes: [],
                snapshots: [],
                sceneLibrary: [],
                musicLibrary: [
                    { name: "Energic", musicCode: 1 },
                    { name: "Rhythm", musicCode: 2 },
                ],
                diyLibrary: [],
                skuFeatures: null,
                state: { online: true },
                channels: { lan: true, mqtt: false, cloud: false },
                ...overrides,
            };
        }

        function createGroup(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
            return {
                sku: "BaseGroup",
                deviceId: "6781311",
                name: "living",
                type: "unknown",
                capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } }],
                scenes: [],
                diyScenes: [],
                snapshots: [],
                sceneLibrary: [],
                musicLibrary: [],
                diyLibrary: [],
                skuFeatures: null,
                state: { online: true },
                channels: { lan: false, mqtt: false, cloud: true },
                ...overrides,
            };
        }

        it("should return empty for group with no members", () => {
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, []);
            expect(result).to.have.lengthOf(0);
        });

        it("should return control states from LAN member intersection", () => {
            const group = createGroup();
            const m1 = createMember({ sku: "H61BE", lanIp: "192.168.1.1" });
            const m2 = createMember({ sku: "H61BC", lanIp: "192.168.1.2" });
            const result = buildDeviceStateDefs(group, undefined, [m1, m2]);
            const ids = result.map((d) => d.id);
            expect(ids).to.include("power");
            expect(ids).to.include("brightness");
            expect(ids).to.include("colorRgb");
            expect(ids).to.include("colorTemperature");
        });

        it("should not include snapshots or diagnostics for groups", () => {
            const group = createGroup();
            const m1 = createMember();
            const result = buildDeviceStateDefs(group, undefined, [m1]);
            const ids = result.map((d) => d.id);
            expect(ids).to.not.include("snapshot_local");
            expect(ids).to.not.include("snapshot_save");
            expect(ids).to.not.include("snapshot_delete");
            expect(ids).to.not.include("snapshot");
            expect(ids).to.not.include("diagnostics_export");
            expect(ids).to.not.include("diagnostics_result");
        });

        it("should compute scene intersection across members", () => {
            const m1 = createMember({ scenes: [
                { name: "Sunset", value: { id: 1 } },
                { name: "Rainbow", value: { id: 2 } },
                { name: "Ocean", value: { id: 3 } },
            ] });
            const m2 = createMember({ scenes: [
                { name: "Rainbow", value: { id: 5 } },
                { name: "Ocean", value: { id: 6 } },
            ] });
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, [m1, m2]);
            const sceneDef = result.find((d) => d.id === "light_scene");
            expect(sceneDef).to.exist;
            // "---" + 2 common scenes (Rainbow, Ocean)
            expect(Object.keys(sceneDef!.states!)).to.have.lengthOf(3);
            expect(Object.values(sceneDef!.states!)).to.include("Rainbow");
            expect(Object.values(sceneDef!.states!)).to.include("Ocean");
            expect(Object.values(sceneDef!.states!)).to.not.include("Sunset");
            // Dropdown writability: type must be "mixed" so users can write
            // either the index ("1"/1) or the scene name from Blockly.
            expect(sceneDef!.type).to.equal("mixed");
        });

        it("should compute music intersection across members", () => {
            const m1 = createMember({ musicLibrary: [
                { name: "Energic", musicCode: 1 },
                { name: "Rhythm", musicCode: 2 },
            ] });
            const m2 = createMember({ musicLibrary: [
                { name: "Rhythm", musicCode: 3 },
                { name: "Spectrum", musicCode: 4 },
            ] });
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, [m1, m2]);
            const musicDef = result.find((d) => d.id === "music_mode");
            expect(musicDef).to.exist;
            expect(Object.values(musicDef!.states!)).to.include("Rhythm");
            expect(Object.values(musicDef!.states!)).to.not.include("Energic");
            expect(Object.values(musicDef!.states!)).to.not.include("Spectrum");
        });

        it("should skip scenes when a member has no scenes", () => {
            const m1 = createMember({ scenes: [{ name: "Sunset", value: { id: 1 } }] });
            const m2 = createMember({ scenes: [] });
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, [m1, m2]);
            expect(result.find((d) => d.id === "light_scene")).to.be.undefined;
        });

        it("should filter control states by Cloud caps when no LAN", () => {
            const m1 = createMember({
                lanIp: undefined,
                capabilities: [
                    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
                    { type: "devices.capabilities.range", instance: "brightness", parameters: { dataType: "INTEGER" } },
                ],
                channels: { lan: false, mqtt: false, cloud: true },
            });
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, [m1]);
            const ids = result.map((d) => d.id);
            expect(ids).to.include("power");
            expect(ids).to.include("brightness");
            expect(ids).to.not.include("colorRgb");
            expect(ids).to.not.include("colorTemperature");
        });

        it("should skip unreachable members (no LAN, no Cloud)", () => {
            const m1 = createMember({ lanIp: undefined, channels: { lan: false, mqtt: false, cloud: false } });
            const group = createGroup();
            const result = buildDeviceStateDefs(group, undefined, [m1]);
            expect(result).to.have.lengthOf(0);
        });
    });

    describe("Drift: API schema violations", () => {
        describe("mapCapabilities non-array / malformed input", () => {
            it("should return empty for non-array input", () => {
                const result = mapCapabilities(undefined as unknown as CloudCapability[]);
                expect(result).to.deep.equal([]);
            });

            it("should return empty for null input", () => {
                const result = mapCapabilities(null as unknown as CloudCapability[]);
                expect(result).to.deep.equal([]);
            });

            it("should return empty for object-instead-of-array", () => {
                const result = mapCapabilities({} as unknown as CloudCapability[]);
                expect(result).to.deep.equal([]);
            });

            it("should skip capability with non-string type", () => {
                const caps = [
                    { type: null, instance: "foo", parameters: {} },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("should skip capability with non-string instance", () => {
                const caps = [
                    { type: "devices.capabilities.on_off", instance: 42, parameters: {} },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("should skip null/undefined capability entries", () => {
                const caps = [null, undefined] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });
        });

        describe("missing parameters field (Cloud API drift)", () => {
            it("mapRange should not throw when parameters is missing", () => {
                const caps = [
                    { type: "devices.capabilities.range", instance: "brightness" },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                const result = mapCapabilities(caps);
                expect(result).to.have.lengthOf(1);
                expect(result[0].min).to.equal(0);
                expect(result[0].max).to.equal(100);
            });

            it("mapColorSetting colorTem should not throw when parameters is missing", () => {
                const caps = [
                    { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                const result = mapCapabilities(caps);
                expect(result).to.have.lengthOf(1);
                expect(result[0].min).to.equal(2000);
                expect(result[0].max).to.equal(9000);
            });

            it("mapMode should return empty when parameters is missing", () => {
                const caps = [
                    { type: "devices.capabilities.mode", instance: "presetScene" },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("mapMode should return empty when options is not an array", () => {
                const caps = [
                    {
                        type: "devices.capabilities.mode",
                        instance: "presetScene",
                        parameters: { dataType: "ENUM", options: "not-an-array" },
                    },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("mapProperty should not throw when parameters is missing", () => {
                const caps = [
                    { type: "devices.capabilities.property", instance: "sensorTemperature" },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                const result = mapCapabilities(caps);
                expect(result).to.have.lengthOf(1);
                expect(result[0].unit).to.equal("°C");
            });

            it("mapMusicSetting should return empty when parameters is missing", () => {
                const caps = [
                    { type: "devices.capabilities.music_setting", instance: "musicMode" },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("mapMusicSetting should return empty when fields is non-array", () => {
                const caps = [
                    {
                        type: "devices.capabilities.music_setting",
                        instance: "musicMode",
                        parameters: { dataType: "STRUCT", fields: "oops" },
                    },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("mapMusicSetting should skip fields with non-string fieldName", () => {
                const caps = [
                    {
                        type: "devices.capabilities.music_setting",
                        instance: "musicMode",
                        parameters: {
                            dataType: "STRUCT",
                            fields: [
                                { fieldName: null, options: [{ name: "x", value: 1 }] },
                                { fieldName: 123, range: { min: 0, max: 100, precision: 1 } },
                            ],
                        },
                    },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                expect(mapCapabilities(caps)).to.deep.equal([]);
            });

            it("mapMode should skip options with non-string name", () => {
                const caps = [
                    {
                        type: "devices.capabilities.mode",
                        instance: "presetScene",
                        parameters: {
                            dataType: "ENUM",
                            options: [
                                { name: "Valid", value: 1 },
                                { name: 999, value: 2 },
                                { name: null, value: 3 },
                            ],
                        },
                    },
                ] as unknown as CloudCapability[];
                expect(() => mapCapabilities(caps)).to.not.throw();
                const result = mapCapabilities(caps);
                expect(result).to.have.lengthOf(1);
                expect(Object.values(result[0].states!)).to.include("Valid");
                expect(Object.values(result[0].states!)).to.not.include("999");
            });
        });

        describe("mapCloudStateValue coercion and drift", () => {
            it("should coerce on_off raw='1' (string) to true", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.on_off",
                    instance: "powerSwitch",
                    state: { value: "1" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.be.true;
            });

            it("should coerce on_off raw='true' to true", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.on_off",
                    instance: "powerSwitch",
                    state: { value: "true" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.be.true;
            });

            it("should coerce on_off raw='0' to false", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.on_off",
                    instance: "powerSwitch",
                    state: { value: "0" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.be.false;
            });

            it("should coerce toggle raw='1' to true", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.toggle",
                    instance: "gradientToggle",
                    state: { value: "1" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.be.true;
            });

            it("should coerce range numeric-string to number", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.range",
                    instance: "brightness",
                    state: { value: "75" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.equal(75);
            });

            it("should return null for range non-numeric string", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.range",
                    instance: "brightness",
                    state: { value: "abc" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result).to.be.null;
            });

            it("should coerce colorTemperature numeric-string to number", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.color_setting",
                    instance: "colorTemperatureK",
                    state: { value: "5000" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.equal(5000);
            });

            it("should coerce property numeric-string to number", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.property",
                    instance: "sensorTemperature",
                    state: { value: "22.5" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.equal(22.5);
            });

            it("should return null for property garbage string", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.property",
                    instance: "sensorTemperature",
                    state: { value: "garbage" as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result).to.be.null;
            });

            it("should return null when cap.type is non-string", () => {
                const cap = {
                    type: null,
                    instance: "powerSwitch",
                    state: { value: 1 },
                } as unknown as CloudStateCapability;
                expect(() => mapCloudStateValue(cap)).to.not.throw();
                expect(mapCloudStateValue(cap)).to.be.null;
            });

            it("should return null when cap.instance is non-string", () => {
                const cap = {
                    type: "devices.capabilities.on_off",
                    instance: 42,
                    state: { value: 1 },
                } as unknown as CloudStateCapability;
                expect(() => mapCloudStateValue(cap)).to.not.throw();
                expect(mapCloudStateValue(cap)).to.be.null;
            });

            it("should not throw on undefined cap", () => {
                expect(() => mapCloudStateValue(undefined as unknown as CloudStateCapability)).to.not.throw();
                expect(mapCloudStateValue(undefined as unknown as CloudStateCapability)).to.be.null;
            });

            it("should coerce music_setting mode when musicMode is string", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.music_setting",
                    instance: "musicMode",
                    state: { value: { musicMode: "7" } as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.stateId).to.equal("music_mode");
                expect(result!.value).to.equal("7");
            });

            it("should default music_setting to '0' when musicMode is garbage", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.music_setting",
                    instance: "musicMode",
                    state: { value: { musicMode: "abc" } as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.equal("0");
            });

            it("should coerce colorRgb numeric-string to hex", () => {
                const cap: CloudStateCapability = {
                    type: "devices.capabilities.color_setting",
                    instance: "colorRgb",
                    state: { value: String(0xff8000) as unknown as number },
                };
                const result = mapCloudStateValue(cap);
                expect(result!.value).to.equal("#ff8000");
            });
        });
    });
});
