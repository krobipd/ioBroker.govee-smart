import { expect } from "chai";
import { DeviceManager } from "../src/lib/device-manager";
import type { CloudCapability, GoveeDevice, LanDevice, MqttStatusUpdate } from "../src/lib/types";

/** Minimal mock logger */
const mockLog: ioBroker.Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
    level: "debug",
};

/** Standard light capabilities for testing */
function lightCapabilities(): CloudCapability[] {
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
function createTestDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
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
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        segmentCount: 15,
        state: { online: true },
        channels: { lan: true, mqtt: true, cloud: true },
        ...overrides,
    };
}

/** Simple call tracker for mock methods */
interface CallRecord {
    method: string;
    args: unknown[];
}

function createCallTracker(): { calls: CallRecord[]; track: (method: string) => (...args: unknown[]) => unknown } {
    const calls: CallRecord[] = [];
    return {
        calls,
        track: (method: string) => (...args: unknown[]) => {
            calls.push({ method, args });
            return true; // MQTT methods return boolean
        },
    };
}

describe("DeviceManager", () => {
    let dm: DeviceManager;

    beforeEach(() => {
        dm = new DeviceManager(mockLog);
    });

    describe("handleLanDiscovery", () => {
        it("should add a new LAN-only device", () => {
            const lanDevice: LanDevice = {
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
            expect(devices).to.have.lengthOf(1);
            expect(devices[0].sku).to.equal("H6160");
            expect(devices[0].name).to.equal("H6160_0011");
            expect(devices[0].lanIp).to.equal("192.168.1.100");
            expect(devices[0].channels.lan).to.be.true;
        });

        it("should create unique names for devices with same SKU", () => {
            const lanDevice1: LanDevice = {
                ip: "192.168.1.100",
                device: "AA:BB:CC:DD:EE:FF:00:11",
                sku: "H61BE",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            const lanDevice2: LanDevice = {
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
            expect(devices).to.have.lengthOf(2);
            expect(devices[0].name).to.not.equal(devices[1].name);
            expect(devices[0].name).to.equal("H61BE_0011");
            expect(devices[1].name).to.equal("H61BE_7788");
        });

        it("should update LAN IP for existing device", () => {
            // Pre-populate from "cloud"
            const lanDevice1: LanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };

            dm.handleLanDiscovery(lanDevice1);
            expect(dm.getDevices()[0].lanIp).to.equal("192.168.1.100");

            // Same device, new IP
            const lanDevice2: LanDevice = { ...lanDevice1, ip: "192.168.1.200" };
            dm.handleLanDiscovery(lanDevice2);

            const devices = dm.getDevices();
            expect(devices).to.have.lengthOf(1);
            expect(devices[0].lanIp).to.equal("192.168.1.200");
        });
    });

    describe("handleMqttStatus", () => {
        it("should update device state from MQTT", () => {
            const lanDevice: LanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice);

            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks(
                (_dev, state) => { updatedState = state; },
                () => {},
            );

            const update: MqttStatusUpdate = {
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
            expect(updatedState).to.not.be.null;
            expect(updatedState!.power).to.be.true;
            expect(updatedState!.brightness).to.equal(75);
            expect(updatedState!.colorRgb).to.equal("#ff8000");
        });

        it("should ignore unknown devices", () => {
            let updateCalled = false;
            dm.setCallbacks(
                () => { updateCalled = true; },
                () => {},
            );

            dm.handleMqttStatus({
                sku: "UNKNOWN",
                device: "0000000000000000",
                state: { onOff: 1 },
            });

            expect(updateCalled).to.be.false;
        });
    });

    describe("handleLanStatus", () => {
        it("should update device by IP", () => {
            const lanDevice: LanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
                bleVersionHard: "",
                bleVersionSoft: "",
                wifiVersionHard: "",
                wifiVersionSoft: "",
            };
            dm.handleLanDiscovery(lanDevice);

            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks(
                (_dev, state) => { updatedState = state; },
                () => {},
            );

            dm.handleLanStatus("192.168.1.100", {
                onOff: 0,
                brightness: 50,
                color: { r: 0, g: 255, b: 0 },
                colorTemInKelvin: 4000,
            });

            expect(updatedState).to.not.be.null;
            expect(updatedState!.power).to.be.false;
            expect(updatedState!.brightness).to.equal(50);
            expect(updatedState!.colorRgb).to.equal("#00ff00");
            expect(updatedState!.colorTemperature).to.equal(4000);
        });

        it("should ignore unknown IP addresses", () => {
            let updateCalled = false;
            dm.setCallbacks(
                () => { updateCalled = true; },
                () => {},
            );

            dm.handleLanStatus("10.0.0.1", {
                onOff: 1,
                brightness: 50,
                color: { r: 255, g: 255, b: 255 },
                colorTemInKelvin: 4000,
            });

            expect(updateCalled).to.be.false;
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
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            // Inject device into internal map
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "power", true);
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("setPower");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", true]);
        });

        it("should route brightness to LAN", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "brightness", 75);
            expect(tracker.calls[0].method).to.equal("setBrightness");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 75]);
        });

        it("should route colorRgb to LAN with parsed RGB values", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "colorRgb", "#ff8000");
            expect(tracker.calls[0].method).to.equal("setColor");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 255, 128, 0]);
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
            dm.setMqttClient(mockMqtt as any);

            const device = createTestDevice({ lanIp: undefined, channels: { lan: false, mqtt: true, cloud: true } });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "power", false);
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("setPower");
            expect(tracker.calls[0].args).to.deep.equal(["AABBCCDDEEFF0011", false]);
        });

        it("should fall back to Cloud when LAN and MQTT are not available", async () => {
            const tracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args: unknown[]) => {
                    tracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud as any);

            const device = createTestDevice({
                lanIp: undefined,
                channels: { lan: false, mqtt: false, cloud: true },
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "power", true);
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("controlDevice");
            // Cloud receives: sku, deviceId, capType, capInstance, value(1 for on)
            expect(tracker.calls[0].args[0]).to.equal("H6160");
            expect(tracker.calls[0].args[1]).to.equal("AABBCCDDEEFF0011");
            expect(tracker.calls[0].args[4]).to.equal(1); // power on = 1
        });

        it("should route lightScene via ptReal when scene is in library", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
                setScene: tracker.track("setScene"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice({
                sceneLibrary: [
                    { name: "Sunset", sceneCode: 42, scenceParam: "AQID" },
                    { name: "Aurora", sceneCode: 99 },
                ],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            // Select scene index 1 = "Sunset" → matches library entry
            await dm.sendCommand(device, "lightScene", "1");
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("setScene");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 42, "AQID"]);
        });

        it("should match ptReal by base name (strip -A/-B suffix)", async () => {
            const tracker = createCallTracker();
            const mockLan = {
                setPower: tracker.track("setPower"),
                setBrightness: tracker.track("setBrightness"),
                setColor: tracker.track("setColor"),
                setColorTemperature: tracker.track("setColorTemperature"),
                setScene: tracker.track("setScene"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice({
                scenes: [
                    { name: "Aurora-B", value: { id: 1 } },
                ],
                sceneLibrary: [
                    { name: "Aurora", sceneCode: 215 },
                ],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            // "Aurora-B" → base name "Aurora" → matches library
            await dm.sendCommand(device, "lightScene", "1");
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("setScene");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 215, ""]);
        });

        it("should fall back to Cloud for lightScene not in library", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
                setScene: lanTracker.track("setScene"),
            };
            dm.setLanClient(mockLan as any);

            const cloudTracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args: unknown[]) => {
                    cloudTracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud as any);

            const device = createTestDevice({
                sceneLibrary: [
                    { name: "Aurora", sceneCode: 99 },
                ],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            // Select scene index 1 = "Sunset" → NOT in library (library only has "Aurora")
            await dm.sendCommand(device, "lightScene", "1");
            // LAN setScene should NOT be called
            expect(lanTracker.calls).to.have.lengthOf(0);
            // Cloud should be called
            expect(cloudTracker.calls).to.have.lengthOf(1);
            expect(cloudTracker.calls[0].method).to.equal("controlDevice");
        });

        it("should always route segment commands via Cloud", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
            };
            dm.setLanClient(mockLan as any);

            const cloudTracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args: unknown[]) => {
                    cloudTracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "segmentColor:0", "#ff0000");
            // LAN should NOT be called
            expect(lanTracker.calls).to.have.lengthOf(0);
            // Cloud should be called
            expect(cloudTracker.calls).to.have.lengthOf(1);
            expect(cloudTracker.calls[0].method).to.equal("controlDevice");
        });
    });

    describe("toCloudValue — value conversions", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice();
        });

        it("should convert power true to 1", () => {
            const result = (dm as any).toCloudValue(device, "power", true);
            expect(result).to.equal(1);
        });

        it("should convert power false to 0", () => {
            const result = (dm as any).toCloudValue(device, "power", false);
            expect(result).to.equal(0);
        });

        it("should pass brightness through unchanged", () => {
            const result = (dm as any).toCloudValue(device, "brightness", 75);
            expect(result).to.equal(75);
        });

        it("should convert colorRgb hex to packed integer", () => {
            const result = (dm as any).toCloudValue(device, "colorRgb", "#ff8000");
            expect(result).to.equal(0xff8000);
        });

        it("should convert black color", () => {
            const result = (dm as any).toCloudValue(device, "colorRgb", "#000000");
            expect(result).to.equal(0);
        });

        it("should convert white color", () => {
            const result = (dm as any).toCloudValue(device, "colorRgb", "#ffffff");
            expect(result).to.equal(0xffffff);
        });

        it("should resolve lightScene index to scene value", () => {
            const result = (dm as any).toCloudValue(device, "lightScene", "1");
            expect(result).to.deep.equal({ id: 1, paramId: "abc" }); // Sunset
        });

        it("should resolve lightScene index 2", () => {
            const result = (dm as any).toCloudValue(device, "lightScene", "2");
            expect(result).to.deep.equal({ id: 2, paramId: "def" }); // Rainbow
        });

        it("should fall back to raw value for invalid lightScene index", () => {
            const result = (dm as any).toCloudValue(device, "lightScene", "99");
            expect(result).to.equal("99");
        });

        it("should resolve snapshot index to integer value", () => {
            const result = (dm as any).toCloudValue(device, "snapshot", "1");
            expect(result).to.equal(3782580);
        });

        it("should resolve snapshot index 2", () => {
            const result = (dm as any).toCloudValue(device, "snapshot", "2");
            expect(result).to.equal(3782581);
        });

        it("should resolve diyScene index", () => {
            const result = (dm as any).toCloudValue(device, "diyScene", "1");
            expect(result).to.deep.equal({ id: 100, paramId: "xyz" });
        });

        it("should convert segmentColor to struct", () => {
            const result = (dm as any).toCloudValue(device, "segmentColor:3", "#ff0000");
            expect(result).to.deep.equal({ segment: [3], rgb: 0xff0000 });
        });

        it("should convert segmentBrightness to struct", () => {
            const result = (dm as any).toCloudValue(device, "segmentBrightness:5", 80);
            expect(result).to.deep.equal({ segment: [5], brightness: 80 });
        });

        it("should pass unknown commands through", () => {
            const result = (dm as any).toCloudValue(device, "unknownCommand", 42);
            expect(result).to.equal(42);
        });
    });

    describe("parseSegmentBatch", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice({ segmentCount: 15 });
        });

        it("should parse range with color and brightness", () => {
            const result = (dm as any).parseSegmentBatch(device, "1-5:#ff0000:20");
            expect(result).to.not.be.null;
            expect(result.segments).to.deep.equal([1, 2, 3, 4, 5]);
            expect(result.color).to.equal(0xff0000);
            expect(result.brightness).to.equal(20);
        });

        it("should parse 'all' keyword", () => {
            const result = (dm as any).parseSegmentBatch(device, "all:#00ff00:50");
            expect(result.segments).to.have.lengthOf(15);
            expect(result.segments[0]).to.equal(0);
            expect(result.segments[14]).to.equal(14);
            expect(result.color).to.equal(0x00ff00);
            expect(result.brightness).to.equal(50);
        });

        it("should parse comma-separated indices", () => {
            const result = (dm as any).parseSegmentBatch(device, "0,3,7:#0000ff");
            expect(result.segments).to.deep.equal([0, 3, 7]);
            expect(result.color).to.equal(0x0000ff);
            expect(result.brightness).to.be.undefined;
        });

        it("should parse brightness only (empty color)", () => {
            const result = (dm as any).parseSegmentBatch(device, "all::50");
            expect(result.segments).to.have.lengthOf(15);
            expect(result.color).to.be.undefined;
            expect(result.brightness).to.equal(50);
        });

        it("should parse color without # prefix", () => {
            const result = (dm as any).parseSegmentBatch(device, "0:ff8000");
            expect(result.color).to.equal(0xff8000);
        });

        it("should clamp segments to segmentCount", () => {
            const result = (dm as any).parseSegmentBatch(device, "10-20:#ff0000");
            // Only 10-14 should be included (segmentCount=15)
            expect(result.segments).to.deep.equal([10, 11, 12, 13, 14]);
        });

        it("should return null for empty command", () => {
            const result = (dm as any).parseSegmentBatch(device, "");
            expect(result).to.be.null;
        });

        it("should return null when no color or brightness given", () => {
            const result = (dm as any).parseSegmentBatch(device, "1-5");
            expect(result).to.be.null;
        });

        it("should return null for invalid segment indices", () => {
            const result = (dm as any).parseSegmentBatch(device, "abc:#ff0000");
            expect(result).to.be.null;
        });

        it("should handle mixed ranges and indices", () => {
            const result = (dm as any).parseSegmentBatch(device, "0,3-5,10:#ffffff");
            expect(result.segments).to.deep.equal([0, 3, 4, 5, 10]);
        });
    });

    describe("findCapabilityForCommand", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice();
        });

        it("should find on_off for power", () => {
            const result = (dm as any).findCapabilityForCommand(device, "power");
            expect(result).to.not.be.undefined;
            expect(result.type).to.equal("devices.capabilities.on_off");
        });

        it("should find range brightness for brightness", () => {
            const result = (dm as any).findCapabilityForCommand(device, "brightness");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("brightness");
        });

        it("should find colorRgb for colorRgb", () => {
            const result = (dm as any).findCapabilityForCommand(device, "colorRgb");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("colorRgb");
        });

        it("should find colorTemperatureK for colorTemperature", () => {
            const result = (dm as any).findCapabilityForCommand(device, "colorTemperature");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.include("colorTem");
        });

        it("should find dynamic_scene lightScene for lightScene", () => {
            const result = (dm as any).findCapabilityForCommand(device, "lightScene");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("lightScene");
        });

        it("should find dynamic_scene snapshot for snapshot", () => {
            const result = (dm as any).findCapabilityForCommand(device, "snapshot");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("snapshot");
        });

        it("should find dynamic_scene diyScene for diyScene", () => {
            const result = (dm as any).findCapabilityForCommand(device, "diyScene");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("diyScene");
        });

        it("should find segment_color_setting for segmentColor", () => {
            const result = (dm as any).findCapabilityForCommand(device, "segmentColor:0");
            expect(result).to.not.be.undefined;
            expect(result.type).to.include("segment_color_setting");
        });

        it("should find segment_color_setting for segmentBrightness", () => {
            const result = (dm as any).findCapabilityForCommand(device, "segmentBrightness:3");
            expect(result).to.not.be.undefined;
            expect(result.type).to.include("segment_color_setting");
        });

        it("should return undefined for unknown commands", () => {
            const result = (dm as any).findCapabilityForCommand(device, "unknownCommand");
            expect(result).to.be.undefined;
        });

        it("should return undefined for device without capabilities", () => {
            const emptyDevice = createTestDevice({ capabilities: [] });
            const result = (dm as any).findCapabilityForCommand(emptyDevice, "power");
            expect(result).to.be.undefined;
        });
    });

    describe("parseColor", () => {
        it("should parse #RRGGBB hex string", () => {
            const result = (dm as any).parseColor("#ff8000");
            expect(result).to.deep.equal({ r: 255, g: 128, b: 0 });
        });

        it("should parse without # prefix", () => {
            const result = (dm as any).parseColor("00ff00");
            expect(result).to.deep.equal({ r: 0, g: 255, b: 0 });
        });

        it("should parse black", () => {
            const result = (dm as any).parseColor("#000000");
            expect(result).to.deep.equal({ r: 0, g: 0, b: 0 });
        });

        it("should parse white", () => {
            const result = (dm as any).parseColor("#ffffff");
            expect(result).to.deep.equal({ r: 255, g: 255, b: 255 });
        });

        it("should handle invalid hex as black", () => {
            const result = (dm as any).parseColor("invalid");
            expect(result).to.deep.equal({ r: 0, g: 0, b: 0 });
        });
    });

    describe("logDedup", () => {
        it("should change category on different error types", () => {
            const warnings: string[] = [];
            const debugs: string[] = [];
            const dedupLog: ioBroker.Logger = {
                debug: (msg: string) => { debugs.push(msg); },
                info: () => {},
                warn: (msg: string) => { warnings.push(msg); },
                error: () => {},
                silly: () => {},
                level: "debug",
            };

            const dedupDm = new DeviceManager(dedupLog);

            // First call — new category, should warn
            (dedupDm as any).logDedup("Cloud failed", new Error("ECONNREFUSED"));
            expect(warnings).to.have.lengthOf(1);
            expect(debugs).to.have.lengthOf(0);

            // Same category — should debug (repeated)
            (dedupDm as any).logDedup("Cloud failed", new Error("ENOTFOUND"));
            expect(warnings).to.have.lengthOf(1); // no new warning
            expect(debugs).to.have.lengthOf(1);

            // Different category — should warn again
            (dedupDm as any).logDedup("Cloud failed", new Error("HTTP 401"));
            expect(warnings).to.have.lengthOf(2);
        });
    });
});
