"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const device_manager_1 = require("../src/lib/device-manager");
/** Minimal mock logger */
const mockLog = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    silly: () => { },
    level: "debug",
};
/** Standard light capabilities for testing */
function lightCapabilities() {
    return [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
        { type: "devices.capabilities.range", instance: "brightness", parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } } },
        { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
        { type: "devices.capabilities.color_setting", instance: "colorTemperatureK", parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } } },
        { type: "devices.capabilities.dynamic_scene", instance: "lightScene", parameters: { dataType: "STRUCT" } },
        { type: "devices.capabilities.dynamic_scene", instance: "snapshot", parameters: { dataType: "STRUCT" } },
        { type: "devices.capabilities.dynamic_scene", instance: "diyScene", parameters: { dataType: "STRUCT" } },
        { type: "devices.capabilities.segment_color_setting", instance: "segmentedColorRgb", parameters: { dataType: "STRUCT" } },
    ];
}
/** Create a test device with all channels available */
function createTestDevice(overrides = {}) {
    return {
        sku: "H6160",
        deviceId: "AABBCCDDEEFF0011",
        name: "Test Light",
        type: "light",
        lanIp: "192.168.1.100",
        capabilities: lightCapabilities(),
        scenes: [
            { name: "Sunset", value: { id: 1, paramId: "abc" } },
            { name: "Rainbow", value: { id: 2, paramId: "def" } },
        ],
        diyScenes: [
            { name: "MyDIY", value: { id: 100, paramId: "xyz" } },
        ],
        snapshots: [
            { name: "Snap1", value: 3782580 },
            { name: "Snap2", value: 3782581 },
        ],
        sceneLibrary: [],
        segmentCount: 15,
        state: { online: true },
        channels: { lan: true, mqtt: true, cloud: true },
        ...overrides,
    };
}
function createCallTracker() {
    const calls = [];
    return {
        calls,
        track: (method) => (...args) => {
            calls.push({ method, args });
            return true; // MQTT methods return boolean
        },
    };
}
describe("DeviceManager", () => {
    let dm;
    beforeEach(() => {
        dm = new device_manager_1.DeviceManager(mockLog);
    });
    describe("handleLanDiscovery", () => {
        it("should add a new LAN-only device", () => {
            const lanDevice = {
                ip: "192.168.1.100",
                device: "AA:BB:CC:DD:EE:FF:00:11",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice);
            const devices = dm.getDevices();
            (0, chai_1.expect)(devices).to.have.lengthOf(1);
            (0, chai_1.expect)(devices[0].sku).to.equal("H6160");
            (0, chai_1.expect)(devices[0].name).to.equal("H6160_0011");
            (0, chai_1.expect)(devices[0].lanIp).to.equal("192.168.1.100");
            (0, chai_1.expect)(devices[0].channels.lan).to.be.true;
        });
        it("should create unique names for devices with same SKU", () => {
            const lanDevice1 = {
                ip: "192.168.1.100",
                device: "AA:BB:CC:DD:EE:FF:00:11",
                sku: "H61BE",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            const lanDevice2 = {
                ip: "192.168.1.101",
                device: "11:22:33:44:55:66:77:88",
                sku: "H61BE",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice1);
            dm.handleLanDiscovery(lanDevice2);
            const devices = dm.getDevices();
            (0, chai_1.expect)(devices).to.have.lengthOf(2);
            (0, chai_1.expect)(devices[0].name).to.not.equal(devices[1].name);
            (0, chai_1.expect)(devices[0].name).to.equal("H61BE_0011");
            (0, chai_1.expect)(devices[1].name).to.equal("H61BE_7788");
        });
        it("should update LAN IP for existing device", () => {
            // Pre-populate from "cloud"
            const lanDevice1 = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice1);
            (0, chai_1.expect)(dm.getDevices()[0].lanIp).to.equal("192.168.1.100");
            // Same device, new IP
            const lanDevice2 = { ...lanDevice1, ip: "192.168.1.200" };
            dm.handleLanDiscovery(lanDevice2);
            const devices = dm.getDevices();
            (0, chai_1.expect)(devices).to.have.lengthOf(1);
            (0, chai_1.expect)(devices[0].lanIp).to.equal("192.168.1.200");
        });
    });
    describe("handleMqttStatus", () => {
        it("should update device state from MQTT", () => {
            const lanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice);
            let updatedState = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => { });
            const update = {
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                state: {
                    onOff: 1,
                    brightness: 75,
                    color: { r: 255, g: 128, b: 0 },
                    colorTemInKelvin: 0,
                },
            };
            dm.handleMqttStatus(update);
            (0, chai_1.expect)(updatedState).to.not.be.null;
            (0, chai_1.expect)(updatedState.power).to.be.true;
            (0, chai_1.expect)(updatedState.brightness).to.equal(75);
            (0, chai_1.expect)(updatedState.colorRgb).to.equal("#ff8000");
        });
        it("should ignore unknown devices", () => {
            let updateCalled = false;
            dm.setCallbacks(() => { updateCalled = true; }, () => { });
            dm.handleMqttStatus({
                sku: "UNKNOWN",
                device: "0000000000000000",
                state: { onOff: 1 },
            });
            (0, chai_1.expect)(updateCalled).to.be.false;
        });
    });
    describe("handleLanStatus", () => {
        it("should update device by IP", () => {
            const lanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice);
            let updatedState = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => { });
            dm.handleLanStatus("192.168.1.100", {
                onOff: 0,
                brightness: 50,
                color: { r: 0, g: 255, b: 0 },
                colorTemInKelvin: 4000,
            });
            (0, chai_1.expect)(updatedState).to.not.be.null;
            (0, chai_1.expect)(updatedState.power).to.be.false;
            (0, chai_1.expect)(updatedState.brightness).to.equal(50);
            (0, chai_1.expect)(updatedState.colorRgb).to.equal("#00ff00");
            (0, chai_1.expect)(updatedState.colorTemperature).to.equal(4000);
        });
        it("should ignore unknown IP addresses", () => {
            let updateCalled = false;
            dm.setCallbacks(() => { updateCalled = true; }, () => { });
            dm.handleLanStatus("10.0.0.1", {
                onOff: 1,
                brightness: 50,
                color: { r: 255, g: 255, b: 255 },
                colorTemInKelvin: 4000,
            });
            (0, chai_1.expect)(updateCalled).to.be.false;
        });
    });
    describe("sendCommand — channel routing", () => {
        it("should route to LAN when LAN is available", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
                requestStatus: tracker.track("requestStatus"),
            };
            dm.setLanClient(mockLan);
            const device = createTestDevice();
            // Inject device into internal map
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "power", true);
            (0, chai_1.expect)(tracker.calls).to.have.lengthOf(1);
            (0, chai_1.expect)(tracker.calls[0].method).to.equal("setPower");
            (0, chai_1.expect)(tracker.calls[0].args).to.deep.equal(["192.168.1.100", true]);
        });
        it("should route brightness to LAN", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan);
            const device = createTestDevice();
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "brightness", 75);
            (0, chai_1.expect)(tracker.calls[0].method).to.equal("setBrightness");
            (0, chai_1.expect)(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 75]);
        });
        it("should route colorRgb to LAN with parsed RGB values", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan);
            const device = createTestDevice();
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "colorRgb", "#ff8000");
            (0, chai_1.expect)(tracker.calls[0].method).to.equal("setColor");
            (0, chai_1.expect)(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 255, 128, 0]);
        });
        it("should fall back to MQTT when LAN is not available", async () => {
            const tracker = createCallTracker();
            const mockMqtt = {
                connected: true,
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
            };
            dm.setMqttClient(mockMqtt);
            const device = createTestDevice({ lanIp: undefined, channels: { lan: false, mqtt: true, cloud: true } });
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "power", false);
            (0, chai_1.expect)(tracker.calls).to.have.lengthOf(1);
            (0, chai_1.expect)(tracker.calls[0].method).to.equal("setPower");
            (0, chai_1.expect)(tracker.calls[0].args).to.deep.equal(["AABBCCDDEEFF0011", false]);
        });
        it("should fall back to Cloud when LAN and MQTT are not available", async () => {
            const tracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args) => {
                    tracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud);
            const device = createTestDevice({
                lanIp: undefined,
                channels: { lan: false, mqtt: false, cloud: true },
            });
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "power", true);
            (0, chai_1.expect)(tracker.calls).to.have.lengthOf(1);
            (0, chai_1.expect)(tracker.calls[0].method).to.equal("controlDevice");
            // Cloud receives: sku, deviceId, capType, capInstance, value(1 for on)
            (0, chai_1.expect)(tracker.calls[0].args[0]).to.equal("H6160");
            (0, chai_1.expect)(tracker.calls[0].args[1]).to.equal("AABBCCDDEEFF0011");
            (0, chai_1.expect)(tracker.calls[0].args[4]).to.equal(1); // power on = 1
        });
        it("should always route segment commands via Cloud", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan);
            const cloudTracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args) => {
                    cloudTracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud);
            const device = createTestDevice();
            dm.devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "segmentColor:0", "#ff0000");
            // LAN should NOT be called
            (0, chai_1.expect)(lanTracker.calls).to.have.lengthOf(0);
            // Cloud should be called
            (0, chai_1.expect)(cloudTracker.calls).to.have.lengthOf(1);
            (0, chai_1.expect)(cloudTracker.calls[0].method).to.equal("controlDevice");
        });
    });
    describe("toCloudValue — value conversions", () => {
        let device;
        beforeEach(() => {
            device = createTestDevice();
        });
        it("should convert power true to 1", () => {
            const result = dm.toCloudValue(device, "power", true);
            (0, chai_1.expect)(result).to.equal(1);
        });
        it("should convert power false to 0", () => {
            const result = dm.toCloudValue(device, "power", false);
            (0, chai_1.expect)(result).to.equal(0);
        });
        it("should pass brightness through unchanged", () => {
            const result = dm.toCloudValue(device, "brightness", 75);
            (0, chai_1.expect)(result).to.equal(75);
        });
        it("should convert colorRgb hex to packed integer", () => {
            const result = dm.toCloudValue(device, "colorRgb", "#ff8000");
            (0, chai_1.expect)(result).to.equal(0xff8000);
        });
        it("should convert black color", () => {
            const result = dm.toCloudValue(device, "colorRgb", "#000000");
            (0, chai_1.expect)(result).to.equal(0);
        });
        it("should convert white color", () => {
            const result = dm.toCloudValue(device, "colorRgb", "#ffffff");
            (0, chai_1.expect)(result).to.equal(0xffffff);
        });
        it("should resolve lightScene index to scene value", () => {
            const result = dm.toCloudValue(device, "lightScene", "1");
            (0, chai_1.expect)(result).to.deep.equal({ id: 1, paramId: "abc" }); // Sunset
        });
        it("should resolve lightScene index 2", () => {
            const result = dm.toCloudValue(device, "lightScene", "2");
            (0, chai_1.expect)(result).to.deep.equal({ id: 2, paramId: "def" }); // Rainbow
        });
        it("should fall back to raw value for invalid lightScene index", () => {
            const result = dm.toCloudValue(device, "lightScene", "99");
            (0, chai_1.expect)(result).to.equal("99");
        });
        it("should resolve snapshot index to integer value", () => {
            const result = dm.toCloudValue(device, "snapshot", "1");
            (0, chai_1.expect)(result).to.equal(3782580);
        });
        it("should resolve snapshot index 2", () => {
            const result = dm.toCloudValue(device, "snapshot", "2");
            (0, chai_1.expect)(result).to.equal(3782581);
        });
        it("should resolve diyScene index", () => {
            const result = dm.toCloudValue(device, "diyScene", "1");
            (0, chai_1.expect)(result).to.deep.equal({ id: 100, paramId: "xyz" });
        });
        it("should convert segmentColor to struct", () => {
            const result = dm.toCloudValue(device, "segmentColor:3", "#ff0000");
            (0, chai_1.expect)(result).to.deep.equal({ segment: [3], rgb: 0xff0000 });
        });
        it("should convert segmentBrightness to struct", () => {
            const result = dm.toCloudValue(device, "segmentBrightness:5", 80);
            (0, chai_1.expect)(result).to.deep.equal({ segment: [5], brightness: 80 });
        });
        it("should pass unknown commands through", () => {
            const result = dm.toCloudValue(device, "unknownCommand", 42);
            (0, chai_1.expect)(result).to.equal(42);
        });
    });
    describe("parseSegmentBatch", () => {
        let device;
        beforeEach(() => {
            device = createTestDevice({ segmentCount: 15 });
        });
        it("should parse range with color and brightness", () => {
            const result = dm.parseSegmentBatch(device, "1-5:#ff0000:20");
            (0, chai_1.expect)(result).to.not.be.null;
            (0, chai_1.expect)(result.segments).to.deep.equal([1, 2, 3, 4, 5]);
            (0, chai_1.expect)(result.color).to.equal(0xff0000);
            (0, chai_1.expect)(result.brightness).to.equal(20);
        });
        it("should parse 'all' keyword", () => {
            const result = dm.parseSegmentBatch(device, "all:#00ff00:50");
            (0, chai_1.expect)(result.segments).to.have.lengthOf(15);
            (0, chai_1.expect)(result.segments[0]).to.equal(0);
            (0, chai_1.expect)(result.segments[14]).to.equal(14);
            (0, chai_1.expect)(result.color).to.equal(0x00ff00);
            (0, chai_1.expect)(result.brightness).to.equal(50);
        });
        it("should parse comma-separated indices", () => {
            const result = dm.parseSegmentBatch(device, "0,3,7:#0000ff");
            (0, chai_1.expect)(result.segments).to.deep.equal([0, 3, 7]);
            (0, chai_1.expect)(result.color).to.equal(0x0000ff);
            (0, chai_1.expect)(result.brightness).to.be.undefined;
        });
        it("should parse brightness only (empty color)", () => {
            const result = dm.parseSegmentBatch(device, "all::50");
            (0, chai_1.expect)(result.segments).to.have.lengthOf(15);
            (0, chai_1.expect)(result.color).to.be.undefined;
            (0, chai_1.expect)(result.brightness).to.equal(50);
        });
        it("should parse color without # prefix", () => {
            const result = dm.parseSegmentBatch(device, "0:ff8000");
            (0, chai_1.expect)(result.color).to.equal(0xff8000);
        });
        it("should clamp segments to segmentCount", () => {
            const result = dm.parseSegmentBatch(device, "10-20:#ff0000");
            // Only 10-14 should be included (segmentCount=15)
            (0, chai_1.expect)(result.segments).to.deep.equal([10, 11, 12, 13, 14]);
        });
        it("should return null for empty command", () => {
            const result = dm.parseSegmentBatch(device, "");
            (0, chai_1.expect)(result).to.be.null;
        });
        it("should return null when no color or brightness given", () => {
            const result = dm.parseSegmentBatch(device, "1-5");
            (0, chai_1.expect)(result).to.be.null;
        });
        it("should return null for invalid segment indices", () => {
            const result = dm.parseSegmentBatch(device, "abc:#ff0000");
            (0, chai_1.expect)(result).to.be.null;
        });
        it("should handle mixed ranges and indices", () => {
            const result = dm.parseSegmentBatch(device, "0,3-5,10:#ffffff");
            (0, chai_1.expect)(result.segments).to.deep.equal([0, 3, 4, 5, 10]);
        });
    });
    describe("findCapabilityForCommand", () => {
        let device;
        beforeEach(() => {
            device = createTestDevice();
        });
        it("should find on_off for power", () => {
            const result = dm.findCapabilityForCommand(device, "power");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.type).to.equal("devices.capabilities.on_off");
        });
        it("should find range brightness for brightness", () => {
            const result = dm.findCapabilityForCommand(device, "brightness");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.equal("brightness");
        });
        it("should find colorRgb for colorRgb", () => {
            const result = dm.findCapabilityForCommand(device, "colorRgb");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.equal("colorRgb");
        });
        it("should find colorTemperatureK for colorTemperature", () => {
            const result = dm.findCapabilityForCommand(device, "colorTemperature");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.include("colorTem");
        });
        it("should find dynamic_scene lightScene for lightScene", () => {
            const result = dm.findCapabilityForCommand(device, "lightScene");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.equal("lightScene");
        });
        it("should find dynamic_scene snapshot for snapshot", () => {
            const result = dm.findCapabilityForCommand(device, "snapshot");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.equal("snapshot");
        });
        it("should find dynamic_scene diyScene for diyScene", () => {
            const result = dm.findCapabilityForCommand(device, "diyScene");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.instance).to.equal("diyScene");
        });
        it("should find segment_color_setting for segmentColor", () => {
            const result = dm.findCapabilityForCommand(device, "segmentColor:0");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.type).to.include("segment_color_setting");
        });
        it("should find segment_color_setting for segmentBrightness", () => {
            const result = dm.findCapabilityForCommand(device, "segmentBrightness:3");
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.type).to.include("segment_color_setting");
        });
        it("should return undefined for unknown commands", () => {
            const result = dm.findCapabilityForCommand(device, "unknownCommand");
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it("should return undefined for device without capabilities", () => {
            const emptyDevice = createTestDevice({ capabilities: [] });
            const result = dm.findCapabilityForCommand(emptyDevice, "power");
            (0, chai_1.expect)(result).to.be.undefined;
        });
    });
    describe("parseColor", () => {
        it("should parse #RRGGBB hex string", () => {
            const result = dm.parseColor("#ff8000");
            (0, chai_1.expect)(result).to.deep.equal({ r: 255, g: 128, b: 0 });
        });
        it("should parse without # prefix", () => {
            const result = dm.parseColor("00ff00");
            (0, chai_1.expect)(result).to.deep.equal({ r: 0, g: 255, b: 0 });
        });
        it("should parse black", () => {
            const result = dm.parseColor("#000000");
            (0, chai_1.expect)(result).to.deep.equal({ r: 0, g: 0, b: 0 });
        });
        it("should parse white", () => {
            const result = dm.parseColor("#ffffff");
            (0, chai_1.expect)(result).to.deep.equal({ r: 255, g: 255, b: 255 });
        });
        it("should handle invalid hex as black", () => {
            const result = dm.parseColor("invalid");
            (0, chai_1.expect)(result).to.deep.equal({ r: 0, g: 0, b: 0 });
        });
    });
    describe("logDedup", () => {
        it("should change category on different error types", () => {
            const warnings = [];
            const debugs = [];
            const dedupLog = {
                debug: (msg) => { debugs.push(msg); },
                info: () => { },
                warn: (msg) => { warnings.push(msg); },
                error: () => { },
                silly: () => { },
                level: "debug",
            };
            const dedupDm = new device_manager_1.DeviceManager(dedupLog);
            // First call — new category, should warn
            dedupDm.logDedup("Cloud failed", new Error("ECONNREFUSED"));
            (0, chai_1.expect)(warnings).to.have.lengthOf(1);
            (0, chai_1.expect)(debugs).to.have.lengthOf(0);
            // Same category — should debug (repeated)
            dedupDm.logDedup("Cloud failed", new Error("ENOTFOUND"));
            (0, chai_1.expect)(warnings).to.have.lengthOf(1); // no new warning
            (0, chai_1.expect)(debugs).to.have.lengthOf(1);
            // Different category — should warn again
            dedupDm.logDedup("Cloud failed", new Error("HTTP 401"));
            (0, chai_1.expect)(warnings).to.have.lengthOf(2);
        });
    });
});
//# sourceMappingURL=testDeviceManager.js.map