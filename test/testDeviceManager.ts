import { expect } from "chai";
import {
    buildCapabilitiesFromAppEntry,
    DeviceManager,
    parseMqttSegmentData,
    resolveSegmentCount,
    SEGMENT_HARD_MAX,
} from "../src/lib/device-manager";
import type { AppDeviceEntry } from "../src/lib/govee-api-client";
import { _resetDeviceRegistry, initDeviceRegistry } from "../src/lib/device-registry";
import type { CloudCapability, GoveeDevice, LanDevice, MqttStatusUpdate } from "../src/lib/types";

/**
 * Quirk-dependent tests (e.g. generateDiagnostics for H6141) need the
 * seed-status entries to be active. Real-world default has them off.
 * beforeEach so other test files cannot leak a reset between cases.
 */
const QUIRK_TEST_REGISTRY = {
    devices: {
        H6141: { name: "LED Strip", type: "light", status: "seed", quirks: { brokenPlatformApi: true } },
    },
};

/** Minimal mock logger */
const mockLog: ioBroker.Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
    level: "debug",
};

/** Mock timer adapter — setTimeout fires immediately so async-await paths
 *  (forceColorMode → 150 ms delay) don't stall the test runner. */
const mockTimers = {
    setInterval: () => undefined,
    clearInterval: () => undefined,
    setTimeout: (cb: () => void) => {
        cb();
        return undefined;
    },
    clearTimeout: () => undefined,
} as never;

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
        { type: "devices.capabilities.segment_color_setting", instance: "segmentedBrightness", parameters: { dataType: "STRUCT" } },
    ];
}

/** Create a test device with all channels available */
function createTestDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
    return {
        sku: "H6160",
        deviceId: "AABBCCDDEEFF0011",
        name: "Test Light",
        type: "devices.types.light",
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
    beforeEach(() => {
        initDeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
    });
    afterEach(() => _resetDeviceRegistry());

    let dm: DeviceManager;

    beforeEach(() => {
        dm = new DeviceManager(mockLog, mockTimers);
    });

    describe("handleLanDiscovery", () => {
        it("should add a new LAN-only device", () => {
            const lanDevice: LanDevice = {
                ip: "192.168.1.100",
                device: "AA:BB:CC:DD:EE:FF:00:11",
                sku: "H6160",
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
            };
            const lanDevice2: LanDevice = {
                ip: "192.168.1.101",
                device: "11:22:33:44:55:66:77:88",
                sku: "H61BE",
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

        it("should fall back to Cloud when LAN is not available", async () => {
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

        it("should route segment color via LAN ptReal (after forcing color mode)", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setColor: lanTracker.track("setColor"),
                setSegmentColor: lanTracker.track("setSegmentColor"),
                setSegmentBrightness: lanTracker.track("setSegmentBrightness"),
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

            await dm.sendCommand(device, "segmentColor:3", "#ff0000");
            // v1.7.1: colorwc pre-amble forces color mode before the ptReal burst
            expect(lanTracker.calls.map((c) => c.method)).to.deep.equal([
                "setColor",
                "setSegmentColor",
            ]);
            const segCall = lanTracker.calls[1];
            expect(segCall.args[0]).to.equal("192.168.1.100");
            expect(segCall.args[1]).to.equal(255); // R
            expect(segCall.args[2]).to.equal(0);   // G
            expect(segCall.args[3]).to.equal(0);   // B
            // Cloud should NOT be called
            expect(cloudTracker.calls).to.have.lengthOf(0);
        });

        it("should route segment brightness via LAN ptReal (after forcing color mode)", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setColor: lanTracker.track("setColor"),
                setSegmentColor: lanTracker.track("setSegmentColor"),
                setSegmentBrightness: lanTracker.track("setSegmentBrightness"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "segmentBrightness:5", 50);
            expect(lanTracker.calls.map((c) => c.method)).to.deep.equal([
                "setColor",
                "setSegmentBrightness",
            ]);
            expect(lanTracker.calls[1].args[1]).to.equal(50);
        });

        // Regression: v1.6.0-1.6.2 shipped with sendCommand(segmentBatch, object)
        // crashing at parseSegmentBatch → cmd.split. Wizard passes objects directly.
        it("should accept pre-parsed object for segmentBatch (wizard path)", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setColor: lanTracker.track("setColor"),
                setSegmentColor: lanTracker.track("setSegmentColor"),
                setSegmentBrightness: lanTracker.track("setSegmentBrightness"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            // This is how the detection wizard + restoreWizardBaseline call it
            await dm.sendCommand(device, "segmentBatch", {
                segments: [0, 1, 2],
                color: 0xff0000,
                brightness: 80,
            } as any);

            // Must not throw, must call LAN setSegmentColor + setSegmentBrightness
            const colorCalls = lanTracker.calls.filter(
                (c) => c.method === "setSegmentColor",
            );
            const brightCalls = lanTracker.calls.filter(
                (c) => c.method === "setSegmentBrightness",
            );
            expect(colorCalls).to.have.lengthOf(1);
            expect(colorCalls[0].args[4]).to.deep.equal([0, 1, 2]);
            expect(brightCalls).to.have.lengthOf(1);
            expect(brightCalls[0].args[1]).to.equal(80);
        });

        it("should not crash on sendCommand(segmentBatch, null)", async () => {
            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);
            // No assertion on side effects — just that it doesn't throw
            await dm.sendCommand(device, "segmentBatch", null as any);
        });

        it("should not crash on sendCommand(segmentBatch, undefined)", async () => {
            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);
            await dm.sendCommand(device, "segmentBatch", undefined as any);
        });

        it("should fall back to Cloud for segment color without LAN", async () => {
            const cloudTracker = createCallTracker();
            const mockCloud = {
                controlDevice: (...args: unknown[]) => {
                    cloudTracker.calls.push({ method: "controlDevice", args });
                    return Promise.resolve();
                },
            };
            dm.setCloudClient(mockCloud as any);

            const device = createTestDevice({ lanIp: undefined });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "segmentColor:0", "#00ff00");
            expect(cloudTracker.calls).to.have.lengthOf(1);
        });

        it("should route snapshot via LAN ptReal when BLE data available", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                sendPtReal: lanTracker.track("sendPtReal"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice({
                snapshotBleCmds: [
                    [["cGFja2V0MQ==", "cGFja2V0Mg=="]], // Snap1
                    [], // Snap2 has no BLE data
                ],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "snapshot", 1);
            expect(lanTracker.calls).to.have.lengthOf(1);
            expect(lanTracker.calls[0].method).to.equal("sendPtReal");
            expect(lanTracker.calls[0].args[1]).to.deep.equal(["cGFja2V0MQ==", "cGFja2V0Mg=="]);
        });

        it("should fall back to Cloud for snapshot without BLE data", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                sendPtReal: lanTracker.track("sendPtReal"),
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
                snapshotBleCmds: [[], []], // no BLE data
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "snapshot", 1);
            expect(lanTracker.calls).to.have.lengthOf(0);
            expect(cloudTracker.calls).to.have.lengthOf(1);
        });

        it("should route gradient toggle via LAN ptReal", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
                setGradient: lanTracker.track("setGradient"),
                setScene: lanTracker.track("setScene"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice();
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "gradientToggle", true);
            expect(lanTracker.calls).to.have.lengthOf(1);
            expect(lanTracker.calls[0].method).to.equal("setGradient");
            expect(lanTracker.calls[0].args[1]).to.equal(true);
        });
    });

    describe("toCloudValue — value conversions", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice();
        });

        it("should convert power true to 1", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "power", true);
            expect(result).to.equal(1);
        });

        it("should convert power false to 0", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "power", false);
            expect(result).to.equal(0);
        });

        it("should pass brightness through unchanged", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "brightness", 75);
            expect(result).to.equal(75);
        });

        it("should convert colorRgb hex to packed integer", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#ff8000");
            expect(result).to.equal(0xff8000);
        });

        it("should convert black color", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#000000");
            expect(result).to.equal(0);
        });

        it("should convert white color", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#ffffff");
            expect(result).to.equal(0xffffff);
        });

        it("should resolve lightScene index to scene value", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "1");
            expect(result).to.deep.equal({ id: 1, paramId: "abc" }); // Sunset
        });

        it("should resolve lightScene index 2", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "2");
            expect(result).to.deep.equal({ id: 2, paramId: "def" }); // Rainbow
        });

        it("should fall back to raw value for invalid lightScene index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "99");
            expect(result).to.equal("99");
        });

        it("should resolve snapshot index to integer value", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "1");
            expect(result).to.equal(3782580);
        });

        it("should resolve snapshot index 2", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "2");
            expect(result).to.equal(3782581);
        });

        it("should resolve diyScene index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "diyScene", "1");
            expect(result).to.deep.equal({ id: 100, paramId: "xyz" });
        });

        it("should convert segmentColor to struct", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "segmentColor:3", "#ff0000");
            expect(result).to.deep.equal({ segment: [3], rgb: 0xff0000 });
        });

        it("should convert segmentBrightness to struct", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "segmentBrightness:5", 80);
            expect(result).to.deep.equal({ segment: [5], brightness: 80 });
        });

        it("should pass unknown commands through", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "unknownCommand", 42);
            expect(result).to.equal(42);
        });
    });

    describe("parseSegmentBatch", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice({ segmentCount: 15 });
        });

        it("should parse range with color and brightness", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "1-5:#ff0000:20");
            expect(result).to.not.be.null;
            expect(result.segments).to.deep.equal([1, 2, 3, 4, 5]);
            expect(result.color).to.equal(0xff0000);
            expect(result.brightness).to.equal(20);
        });

        it("should parse 'all' keyword", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#00ff00:50");
            expect(result.segments).to.have.lengthOf(15);
            expect(result.segments[0]).to.equal(0);
            expect(result.segments[14]).to.equal(14);
            expect(result.color).to.equal(0x00ff00);
            expect(result.brightness).to.equal(50);
        });

        it("should parse comma-separated indices", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "0,3,7:#0000ff");
            expect(result.segments).to.deep.equal([0, 3, 7]);
            expect(result.color).to.equal(0x0000ff);
            expect(result.brightness).to.be.undefined;
        });

        it("should parse brightness only (empty color)", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "all::50");
            expect(result.segments).to.have.lengthOf(15);
            expect(result.color).to.be.undefined;
            expect(result.brightness).to.equal(50);
        });

        it("should parse color without # prefix", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "0:ff8000");
            expect(result.color).to.equal(0xff8000);
        });

        it("should clamp segments to segmentCount", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "10-20:#ff0000");
            // Only 10-14 should be included (segmentCount=15)
            expect(result.segments).to.deep.equal([10, 11, 12, 13, 14]);
        });

        it("should return null for empty command", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "");
            expect(result).to.be.null;
        });

        it("should return null when no color or brightness given", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "1-5");
            expect(result).to.be.null;
        });

        it("should return null for invalid segment indices", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "abc:#ff0000");
            expect(result).to.be.null;
        });

        it("should handle mixed ranges and indices", () => {
            const result = (dm as any).commandRouter.parseSegmentBatch(device, "0,3-5,10:#ffffff");
            expect(result.segments).to.deep.equal([0, 3, 4, 5, 10]);
        });

        describe("manual segment override", () => {
            it("should honor manualSegments for 'all'", () => {
                device.manualMode = true;
                device.manualSegments = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
                const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#ff0000");
                expect(result).to.not.be.null;
                expect(result.segments).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            });

            it("should honor non-contiguous manualSegments for 'all'", () => {
                device.manualMode = true;
                device.manualSegments = [0, 1, 2, 5, 6, 7]; // gap at 3,4
                const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#00ff00");
                expect(result.segments).to.deep.equal([0, 1, 2, 5, 6, 7]);
            });

            it("should filter out invalid indices when manual mode active", () => {
                device.manualMode = true;
                device.manualSegments = [0, 1, 2, 5, 6]; // user says 3,4,7..14 not physical
                const result = (dm as any).commandRouter.parseSegmentBatch(device, "0-14:#0000ff");
                expect(result.segments).to.deep.equal([0, 1, 2, 5, 6]);
            });

            it("should return null if no valid indices after filtering", () => {
                device.manualMode = true;
                device.manualSegments = [0, 1, 2];
                const result = (dm as any).commandRouter.parseSegmentBatch(device, "10-14:#ff0000");
                expect(result).to.be.null;
            });

            it("should fall back to segmentCount when manualMode=false", () => {
                device.manualMode = false;
                device.manualSegments = [0, 1, 2]; // list ignored when mode off
                const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#ff0000");
                expect(result.segments).to.have.lengthOf(15);
            });
        });

        describe("non-string input guards (wizard/internal callers)", () => {
            it("parseSegmentBatch returns null for object input (defensive)", () => {
                const result = (dm as any).commandRouter.parseSegmentBatch(
                    device,
                    { segments: [0, 1], color: 0xff0000 } as any,
                );
                expect(result).to.be.null;
            });

            it("parseSegmentBatch returns null for null/undefined", () => {
                expect((dm as any).commandRouter.parseSegmentBatch(device, null)).to.be.null;
                expect((dm as any).commandRouter.parseSegmentBatch(device, undefined)).to.be.null;
            });

            it("coerceParsedBatch accepts valid object", () => {
                const result = (dm as any).commandRouter.coerceParsedBatch({
                    segments: [0, 1, 2],
                    color: 0xff0000,
                    brightness: 50,
                });
                expect(result).to.deep.equal({
                    segments: [0, 1, 2],
                    color: 0xff0000,
                    brightness: 50,
                });
            });

            it("coerceParsedBatch clamps brightness to 0-100", () => {
                const result = (dm as any).commandRouter.coerceParsedBatch({
                    segments: [0],
                    brightness: 150,
                });
                expect(result.brightness).to.equal(100);
            });

            it("coerceParsedBatch rejects empty segments", () => {
                expect((dm as any).commandRouter.coerceParsedBatch({ segments: [], color: 0 })).to.be.null;
            });

            it("coerceParsedBatch rejects missing segments field", () => {
                expect((dm as any).commandRouter.coerceParsedBatch({ color: 0 })).to.be.null;
            });

            it("coerceParsedBatch rejects non-object", () => {
                expect((dm as any).commandRouter.coerceParsedBatch("string")).to.be.null;
                expect((dm as any).commandRouter.coerceParsedBatch(null)).to.be.null;
                expect((dm as any).commandRouter.coerceParsedBatch(42)).to.be.null;
            });

            it("coerceParsedBatch filters non-numeric segment entries", () => {
                const result = (dm as any).commandRouter.coerceParsedBatch({
                    segments: [0, "bad", -1, 2, NaN, 3],
                    color: 0,
                });
                expect(result.segments).to.deep.equal([0, 2, 3]);
            });

            it("coerceParsedBatch requires at least color or brightness", () => {
                expect(
                    (dm as any).commandRouter.coerceParsedBatch({ segments: [0, 1] }),
                ).to.be.null;
            });
        });
    });

    describe("findCapabilityForCommand", () => {
        let device: GoveeDevice;

        beforeEach(() => {
            device = createTestDevice();
        });

        it("should find on_off for power", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "power");
            expect(result).to.not.be.undefined;
            expect(result.type).to.equal("devices.capabilities.on_off");
        });

        it("should find range brightness for brightness", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "brightness");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("brightness");
        });

        it("should find colorRgb for colorRgb", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "colorRgb");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("colorRgb");
        });

        it("should find colorTemperatureK for colorTemperature", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "colorTemperature");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.include("colorTem");
        });

        it("should find dynamic_scene lightScene for lightScene", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "lightScene");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("lightScene");
        });

        it("should find dynamic_scene snapshot for snapshot", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "snapshot");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("snapshot");
        });

        it("should find dynamic_scene diyScene for diyScene", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "diyScene");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("diyScene");
        });

        it("should find segmentedColorRgb for segmentColor", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "segmentColor:0");
            expect(result).to.not.be.undefined;
            expect(result.type).to.include("segment_color_setting");
            expect(result.instance).to.equal("segmentedColorRgb");
        });

        it("should find segmentedBrightness for segmentBrightness", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "segmentBrightness:3");
            expect(result).to.not.be.undefined;
            expect(result.type).to.include("segment_color_setting");
            expect(result.instance).to.equal("segmentedBrightness");
        });

        it("should return undefined for unknown commands", () => {
            const result = (dm as any).commandRouter.findCapabilityForCommand(device, "unknownCommand");
            expect(result).to.be.undefined;
        });

        it("should return undefined for device without capabilities", () => {
            const emptyDevice = createTestDevice({ capabilities: [] });
            const result = (dm as any).commandRouter.findCapabilityForCommand(emptyDevice, "power");
            expect(result).to.be.undefined;
        });

        it("should not throw when capabilities is non-array", () => {
            const badDevice = createTestDevice({
                capabilities: undefined as unknown as CloudCapability[],
            });
            expect(() => (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power")).to.not.throw();
            const result = (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power");
            expect(result).to.be.undefined;
        });

        it("should skip malformed capability entries", () => {
            const badDevice = createTestDevice({
                capabilities: [
                    null,
                    { type: null, instance: "foo" },
                    { type: "devices.capabilities.on_off", instance: 42 },
                    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
                ] as unknown as CloudCapability[],
            });
            expect(() => (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power")).to.not.throw();
            const result = (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power");
            expect(result).to.not.be.undefined;
            expect(result.instance).to.equal("powerSwitch");
        });
    });

    describe("Drift: malformed cloud device list", () => {
        it("mergeCloudDevices should skip devices with non-string sku", () => {
            const bad = [
                { sku: null, device: "abc", deviceName: "x", type: "devices.types.light", capabilities: [] },
                { sku: "H6160", device: "good123", deviceName: "Good", type: "devices.types.light", capabilities: [] },
            ];
            expect(() => (dm as any).mergeCloudDevices(bad)).to.not.throw();
            (dm as any).mergeCloudDevices(bad);
            const devices = dm.getDevices();
            const skus = devices.map((d) => d.sku);
            expect(skus).to.include("H6160");
            expect(skus).to.not.include(null);
        });

        it("mergeCloudDevices should skip devices with non-string device id", () => {
            const bad = [
                { sku: "H6160", device: 123, deviceName: "x", type: "devices.types.light", capabilities: [] },
            ];
            expect(() => (dm as any).mergeCloudDevices(bad)).to.not.throw();
        });

        it("mergeCloudDevices should not throw when capabilities is non-array", () => {
            const bad = [
                { sku: "H6160", device: "abc", deviceName: "x", type: "devices.types.light", capabilities: "oops" },
            ];
            expect(() => (dm as any).mergeCloudDevices(bad)).to.not.throw();
            const devices = dm.getDevices();
            const dev = devices.find((d) => d.sku === "H6160");
            if (dev) {
                expect(Array.isArray(dev.capabilities)).to.be.true;
            }
        });

        it("mergeCloudDevices should not throw when cloudDevices is non-array", () => {
            expect(() => (dm as any).mergeCloudDevices(null)).to.not.throw();
            expect(() => (dm as any).mergeCloudDevices(undefined)).to.not.throw();
            expect(() => (dm as any).mergeCloudDevices({} as any)).to.not.throw();
        });

        it("mergeCloudDevices should skip null entries", () => {
            const bad = [null, undefined, { sku: "H6160", device: "abc", deviceName: "x", type: "devices.types.light", capabilities: [] }];
            expect(() => (dm as any).mergeCloudDevices(bad)).to.not.throw();
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

            const dedupDm = new DeviceManager(dedupLog, mockTimers);

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

    describe("handleMqttStatus — edge cases", () => {
        function setupDevice(): void {
            const lanDevice: LanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
            };
            dm.handleLanDiscovery(lanDevice);
        }

        it("should handle partial state update (power only)", () => {
            setupDevice();
            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => {});

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                state: { onOff: 0 },
            });
            expect(updatedState).to.not.be.null;
            expect(updatedState!.power).to.be.false;
            expect(updatedState!.brightness).to.be.undefined;
            expect(updatedState!.colorRgb).to.be.undefined;
        });

        it("should handle color temperature from MQTT", () => {
            setupDevice();
            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => {});

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                state: { colorTemInKelvin: 5000 },
            });
            expect(updatedState!.colorTemperature).to.equal(5000);
        });

        it("should set mqtt channel to true on status update", () => {
            setupDevice();
            dm.setCallbacks(() => {}, () => {});

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                state: { onOff: 1 },
            });

            const device = dm.getDevices()[0];
            expect(device.channels.mqtt).to.be.true;
        });

        it("should handle empty state object", () => {
            setupDevice();
            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => {});

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
            });
            // Should still get online: true
            expect(updatedState).to.not.be.null;
            expect(updatedState!.online).to.be.true;
        });
    });

    describe("handleLanStatus — edge cases", () => {
        function setupDevice(): void {
            const lanDevice: LanDevice = {
                ip: "192.168.1.100",
                device: "AABBCCDDEEFF0011",
                sku: "H6160",
            };
            dm.handleLanDiscovery(lanDevice);
        }

        it("should handle zero brightness", () => {
            setupDevice();
            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => {});

            dm.handleLanStatus("192.168.1.100", {
                onOff: 1,
                brightness: 0,
                color: { r: 0, g: 0, b: 0 },
                colorTemInKelvin: 0,
            });
            expect(updatedState!.brightness).to.equal(0);
        });

        it("should handle colorTemInKelvin 0 as no color temp", () => {
            setupDevice();
            let updatedState: Partial<import("../src/lib/types").DeviceState> | null = null;
            dm.setCallbacks((_dev, state) => { updatedState = state; }, () => {});

            dm.handleLanStatus("192.168.1.100", {
                onOff: 1,
                brightness: 50,
                color: { r: 255, g: 0, b: 0 },
                colorTemInKelvin: 0,
            });
            // colorTemInKelvin 0 means RGB mode, not color temp
            expect(updatedState!.colorTemperature).to.be.undefined;
        });
    });

    describe("sendCommand — DIY scene via LAN", () => {
        it("should route DIY scene via ptReal when library match found", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
                setScene: lanTracker.track("setScene"),
                setGradient: lanTracker.track("setGradient"),
                setDiyScene: lanTracker.track("setDiyScene"),
            };
            dm.setLanClient(mockLan as any);

            const device = createTestDevice({
                diyScenes: [{ name: "MyDIY", value: { id: 100, paramId: "xyz" } }],
                diyLibrary: [{ name: "MyDIY", diyCode: 50, scenceParam: "ABCD" }],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "diyScene", "1");
            expect(lanTracker.calls).to.have.lengthOf(1);
            expect(lanTracker.calls[0].method).to.equal("setDiyScene");
            expect(lanTracker.calls[0].args[1]).to.equal("ABCD");
        });

        it("should fall back to Cloud for DIY scene not in library", async () => {
            const lanTracker = createCallTracker();
            const mockLan = {
                setPower: lanTracker.track("setPower"),
                setBrightness: lanTracker.track("setBrightness"),
                setColor: lanTracker.track("setColor"),
                setColorTemperature: lanTracker.track("setColorTemperature"),
                setScene: lanTracker.track("setScene"),
                setGradient: lanTracker.track("setGradient"),
                setDiyScene: lanTracker.track("setDiyScene"),
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
                diyScenes: [{ name: "MyDIY", value: { id: 100, paramId: "xyz" } }],
                diyLibrary: [{ name: "OtherDIY", diyCode: 50, scenceParam: "ABCD" }],
            });
            (dm as any).devices.set("H6160_aabbccddeeff0011", device);

            await dm.sendCommand(device, "diyScene", "1");
            // LAN setDiyScene should NOT be called
            expect(lanTracker.calls.filter(c => c.method === "setDiyScene")).to.have.lengthOf(0);
            // Cloud should be called
            expect(cloudTracker.calls).to.have.lengthOf(1);
        });
    });

    describe("sendCommand — colorTemperature via LAN", () => {
        it("should route colorTemperature to LAN", async () => {
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

            await dm.sendCommand(device, "colorTemperature", 4500);
            expect(tracker.calls).to.have.lengthOf(1);
            expect(tracker.calls[0].method).to.equal("setColorTemperature");
            expect(tracker.calls[0].args).to.deep.equal(["192.168.1.100", 4500]);
        });
    });

    describe("sendCommand — no channel available", () => {
        it("should warn when no channel is available", async () => {
            const warnings: string[] = [];
            const warnLog: ioBroker.Logger = {
                debug: () => {},
                info: () => {},
                warn: (msg: string) => { warnings.push(msg); },
                error: () => {},
                silly: () => {},
                level: "debug",
            };
            const noDm = new DeviceManager(warnLog, mockTimers);

            const device = createTestDevice({
                lanIp: undefined,
                channels: { lan: false, mqtt: false, cloud: false },
            });
            (noDm as any).devices.set("H6160_aabbccddeeff0011", device);

            await noDm.sendCommand(device, "power", true);
            expect(warnings.some(w => w.includes("No channel available"))).to.be.true;
        });
    });

    describe("generateDiagnostics", () => {
        it("should include all device data in diagnostics export", () => {
            const device = createTestDevice({
                sceneLibrary: [
                    { name: "Sunset", sceneCode: 42, speedInfo: { supSpeed: true, speedIndex: 0, config: "[{},{}]" } },
                ],
                musicLibrary: [
                    { name: "Energic", musicCode: 1, mode: 0 },
                ],
                diyLibrary: [
                    { name: "MyDIY", diyCode: 10 },
                ],
            });

            const result = dm.generateDiagnostics(device, "1.0.1");
            expect(result.adapter).to.equal("iobroker.govee-smart");
            expect(result.version).to.equal("1.0.1");
            expect(result.exportedAt).to.be.a("string");
            expect((result.device as any).sku).to.equal("H6160");
            expect((result.device as any).channels).to.deep.equal({ lan: true, mqtt: true, cloud: true });
            expect((result.scenes as any).count).to.equal(2);
            expect((result.scenes as any).names).to.deep.equal(["Sunset", "Rainbow"]);
            expect((result.sceneLibrary as any).count).to.equal(1);
            expect((result.sceneLibrary as any).entries[0].speedSupported).to.be.true;
            expect((result.musicLibrary as any).count).to.equal(1);
            expect((result.diyLibrary as any).count).to.equal(1);
            expect(result.quirks).to.be.null; // H6160 has no quirks
            expect(result.state).to.deep.equal({ online: true });
        });

        it("should include quirks for known SKU", () => {
            const device = createTestDevice({ sku: "H6141" });
            const result = dm.generateDiagnostics(device, "1.0.1");
            expect((result.quirks as any).brokenPlatformApi).to.be.true;
        });
    });

    describe("toCloudValue — bounds checks", () => {
        const device = createTestDevice();

        it("should return raw value for NaN diyScene index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "diyScene", "abc");
            expect(result).to.equal("abc");
        });

        it("should return raw value for zero snapshot index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "0");
            expect(result).to.equal("0");
        });

        it("should return raw value for out-of-range snapshot index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "999");
            expect(result).to.equal("999");
        });

        it("should return raw value for invalid segment index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "segmentColor:-1", "#ff0000");
            expect(result).to.equal("#ff0000");
        });

        it("should return raw value for NaN segment brightness index", () => {
            const result = (dm as any).commandRouter.toCloudValue(device, "segmentBrightness:abc", 50);
            expect(result).to.equal(50);
        });
    });

    describe("parseMqttSegmentData", () => {
        /** Build a 20-byte AA A5 packet with 4 segment slots */
        function buildAaA5Packet(packetNum: number, slots: Array<[number, number, number, number]>): string {
            const bytes = new Uint8Array(20);
            bytes[0] = 0xAA;
            bytes[1] = 0xA5;
            bytes[2] = packetNum;
            for (let i = 0; i < slots.length && i < 4; i++) {
                bytes[3 + i * 4] = slots[i][0]; // brightness
                bytes[4 + i * 4] = slots[i][1]; // r
                bytes[5 + i * 4] = slots[i][2]; // g
                bytes[6 + i * 4] = slots[i][3]; // b
            }
            // XOR checksum
            let xor = 0;
            for (let i = 0; i < 19; i++) xor ^= bytes[i];
            bytes[19] = xor;
            return Buffer.from(bytes).toString("base64");
        }

        it("should parse single AA A5 packet with 4 segments", () => {
            const pkt = buildAaA5Packet(1, [
                [100, 255, 0, 0],   // seg 0: brightness 100, red
                [50, 0, 255, 0],    // seg 1: brightness 50, green
                [75, 0, 0, 255],    // seg 2: brightness 75, blue
                [1, 128, 128, 128], // seg 3: brightness 1 (not padding), grey
            ]);
            const result = parseMqttSegmentData([pkt]);
            expect(result).to.have.lengthOf(4);
            expect(result[0]).to.deep.equal({ index: 0, brightness: 100, r: 255, g: 0, b: 0 });
            expect(result[1]).to.deep.equal({ index: 1, brightness: 50, r: 0, g: 255, b: 0 });
            expect(result[2]).to.deep.equal({ index: 2, brightness: 75, r: 0, g: 0, b: 255 });
            expect(result[3]).to.deep.equal({ index: 3, brightness: 1, r: 128, g: 128, b: 128 });
        });

        it("should parse multiple packets and compute correct segment indices", () => {
            const pkt1 = buildAaA5Packet(1, [[100, 255, 0, 0], [100, 0, 255, 0], [100, 0, 0, 255], [100, 255, 255, 0]]);
            const pkt2 = buildAaA5Packet(2, [[80, 10, 20, 30], [60, 40, 50, 60], [40, 70, 80, 90], [20, 100, 110, 120]]);
            const result = parseMqttSegmentData([pkt1, pkt2]);
            expect(result).to.have.lengthOf(8);
            // Packet 2 starts at segment index 4
            expect(result[4]).to.deep.equal({ index: 4, brightness: 80, r: 10, g: 20, b: 30 });
            expect(result[7]).to.deep.equal({ index: 7, brightness: 20, r: 100, g: 110, b: 120 });
        });

        it("should trim trailing all-zero padding slots from the final packet", () => {
            // Packet with 2 real segments + 2 padding slots (Govee often pads
            // a short final packet to 4 slots with zero bytes). The parser
            // must NOT advertise 4 segments here — only 2.
            const pkt = buildAaA5Packet(1, [
                [100, 255, 0, 0],
                [50, 0, 255, 0],
                [0, 0, 0, 0], // padding
                [0, 0, 0, 0], // padding
            ]);
            const result = parseMqttSegmentData([pkt]);
            expect(result).to.have.lengthOf(2);
            expect(result[0].index).to.equal(0);
            expect(result[1].index).to.equal(1);
        });

        it("should keep zero-slots that have real data AFTER them", () => {
            // A lit segment followed by an unlit (genuine) segment followed
            // by a lit one — the middle zero slot must not be trimmed.
            const pkt = buildAaA5Packet(1, [
                [100, 255, 0, 0],
                [0, 0, 0, 0],      // genuine off segment
                [100, 0, 255, 0],
                [1, 128, 128, 128], // non-padding last
            ]);
            const result = parseMqttSegmentData([pkt]);
            expect(result).to.have.lengthOf(4);
            expect(result[1]).to.deep.equal({ index: 1, brightness: 0, r: 0, g: 0, b: 0 });
        });

        it("should ignore non-AA-A5 packets", () => {
            const modeBytes = new Uint8Array(20);
            modeBytes[0] = 0xAA;
            modeBytes[1] = 0x05;
            modeBytes[2] = 0x15;
            const modePkt = Buffer.from(modeBytes).toString("base64");

            const segPkt = buildAaA5Packet(1, [[100, 255, 0, 0], [50, 0, 255, 0], [75, 128, 128, 128], [1, 1, 1, 1]]);
            const result = parseMqttSegmentData([modePkt, segPkt]);
            expect(result).to.have.lengthOf(4);
            expect(result[0].index).to.equal(0);
        });

        it("should return empty array for empty commands", () => {
            const result = parseMqttSegmentData([]);
            expect(result).to.have.lengthOf(0);
        });

        it("should skip packets with invalid packet number", () => {
            const bytes = new Uint8Array(20);
            bytes[0] = 0xAA;
            bytes[1] = 0xA5;
            bytes[2] = 6; // invalid: must be 1-5
            const pkt = Buffer.from(bytes).toString("base64");
            const result = parseMqttSegmentData([pkt]);
            expect(result).to.have.lengthOf(0);
        });

        it("should skip packets shorter than 20 bytes", () => {
            const shortBytes = new Uint8Array(10);
            shortBytes[0] = 0xAA;
            shortBytes[1] = 0xA5;
            shortBytes[2] = 1;
            const pkt = Buffer.from(shortBytes).toString("base64");
            const result = parseMqttSegmentData([pkt]);
            expect(result).to.have.lengthOf(0);
        });

        it("should decode all 5 packets for a 20-segment strip", () => {
            // 0x64 = 100 decimal brightness, warm white: FF CA 91
            const pkts = [];
            for (let p = 1; p <= 5; p++) {
                pkts.push(buildAaA5Packet(p, [[0x64, 0xFF, 0xCA, 0x91], [0x64, 0xFF, 0xCA, 0x91], [0x64, 0xFF, 0xCA, 0x91], [0x64, 0xFF, 0xCA, 0x91]]));
            }
            const result = parseMqttSegmentData(pkts);
            expect(result).to.have.lengthOf(20);
            expect(result[0].index).to.equal(0);
            expect(result[19].index).to.equal(19);
            for (const seg of result) {
                expect(seg.brightness).to.equal(100);
                expect(seg.r).to.equal(255);
                expect(seg.g).to.equal(202);
                expect(seg.b).to.equal(145);
            }
        });

        // Drift guards — MQTT payload structure could change unexpectedly.
        it("should return [] for non-array commands input", () => {
            const result = parseMqttSegmentData(null as unknown as string[]);
            expect(result).to.deep.equal([]);
        });

        it("should return [] for undefined commands input", () => {
            const result = parseMqttSegmentData(undefined as unknown as string[]);
            expect(result).to.deep.equal([]);
        });

        it("should return [] for object instead of array", () => {
            const result = parseMqttSegmentData({} as unknown as string[]);
            expect(result).to.deep.equal([]);
        });

        it("should skip non-string entries in commands array", () => {
            const goodPkt = buildAaA5Packet(1, [[0x50, 0xFF, 0x00, 0x00], [0x10, 0x00, 0xFF, 0x00], [0x10, 0x00, 0x00, 0xFF], [0x10, 0xFF, 0xFF, 0x00]]);
            const result = parseMqttSegmentData(
                [null as unknown as string, 42 as unknown as string, goodPkt, {} as unknown as string],
            );
            expect(result.length).to.equal(4);
            expect(result[0].index).to.equal(0);
            expect(result[0].r).to.equal(255);
        });
    });

    describe("handleMqttStatus — segment state sync", () => {
        it("should call onMqttSegmentUpdate when op.command contains AA A5 packets", () => {
            const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
            dm.handleLanDiscovery(lanDevice);

            // Set segmentCount on the device
            const device = dm.getDevices()[0];
            device.segmentCount = 15;

            let segmentUpdates: import("../src/lib/device-manager").MqttSegmentData[] | null = null;
            dm.setCallbacks(() => {}, () => {});
            dm.onMqttSegmentUpdate = (_dev, segs) => { segmentUpdates = segs; };

            // Build an AA A5 packet
            const bytes = new Uint8Array(20);
            bytes[0] = 0xAA; bytes[1] = 0xA5; bytes[2] = 1;
            bytes[3] = 100; bytes[4] = 255; bytes[5] = 0; bytes[6] = 0; // seg 0
            bytes[7] = 50; bytes[8] = 0; bytes[9] = 255; bytes[10] = 0; // seg 1
            let xor = 0;
            for (let i = 0; i < 19; i++) xor ^= bytes[i];
            bytes[19] = xor;
            const pkt = Buffer.from(bytes).toString("base64");

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                state: { onOff: 1 },
                op: { command: [pkt] },
            });

            expect(segmentUpdates).to.not.be.null;
            // Trailing zero slots (slots 2-3) are trimmed as packet padding.
            expect(segmentUpdates).to.have.lengthOf(2);
            expect(segmentUpdates![0]).to.deep.equal({ index: 0, brightness: 100, r: 255, g: 0, b: 0 });
            expect(segmentUpdates![1]).to.deep.equal({ index: 1, brightness: 50, r: 0, g: 255, b: 0 });
        });

        it("should discover segmentCount and call onSegmentCountGrown on first AA A5", () => {
            const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
            dm.handleLanDiscovery(lanDevice);
            // Device starts with segmentCount undefined — LAN-only, no Cloud data yet

            let grownDevice: GoveeDevice | null = null;
            dm.setCallbacks(() => {}, () => {});
            dm.onSegmentCountGrown = (d) => { grownDevice = d; };
            dm.onMqttSegmentUpdate = () => { /* we're testing the bump path */ };

            // Single AA A5 packet with 2 visible segments
            const bytes = new Uint8Array(20);
            bytes[0] = 0xAA; bytes[1] = 0xA5; bytes[2] = 1;
            bytes[3] = 100; bytes[4] = 255; bytes[5] = 0; bytes[6] = 0; // seg 0
            bytes[7] = 50; bytes[8] = 0; bytes[9] = 255; bytes[10] = 0; // seg 1
            let xor = 0;
            for (let i = 0; i < 19; i++) xor ^= bytes[i];
            bytes[19] = xor;
            const pkt = Buffer.from(bytes).toString("base64");

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                op: { command: [pkt] },
            });

            expect(grownDevice).to.not.be.null;
            expect(dm.getDevices()[0].segmentCount).to.equal(2);
        });

        it("should grow segmentCount when MQTT reports more than Cloud said", () => {
            const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H61BE" };
            dm.handleLanDiscovery(lanDevice);
            const device = dm.getDevices()[0];
            // Cloud says 15, simulate that starting state
            device.segmentCount = 15;

            let grownDevice: GoveeDevice | null = null;
            dm.setCallbacks(() => {}, () => {});
            dm.onSegmentCountGrown = (d) => { grownDevice = d; };

            // Build 5 AA A5 packets = 20 segments total
            const packets: string[] = [];
            for (let p = 1; p <= 5; p++) {
                const b = new Uint8Array(20);
                b[0] = 0xAA; b[1] = 0xA5; b[2] = p;
                for (let slot = 0; slot < 4; slot++) {
                    b[3 + slot * 4] = 50;      // brightness
                    b[3 + slot * 4 + 1] = 255; // r
                }
                let xor = 0;
                for (let i = 0; i < 19; i++) xor ^= b[i];
                b[19] = xor;
                packets.push(Buffer.from(b).toString("base64"));
            }

            dm.handleMqttStatus({
                sku: "H61BE",
                device: "AABBCCDDEEFF0011",
                op: { command: packets },
            });

            expect(grownDevice).to.not.be.null;
            expect(dm.getDevices()[0].segmentCount).to.equal(20);
        });

        it("should not call onMqttSegmentUpdate when no AA A5 packets in command", () => {
            const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
            dm.handleLanDiscovery(lanDevice);
            const device = dm.getDevices()[0];
            device.segmentCount = 15;

            let called = false;
            dm.setCallbacks(() => {}, () => {});
            dm.onMqttSegmentUpdate = () => { called = true; };

            // AA 05 mode packet (not AA A5)
            const bytes = new Uint8Array(20);
            bytes[0] = 0xAA; bytes[1] = 0x05; bytes[2] = 0x15;
            const pkt = Buffer.from(bytes).toString("base64");

            dm.handleMqttStatus({
                sku: "H6160",
                device: "AABBCCDDEEFF0011",
                op: { command: [pkt] },
            });

            expect(called).to.be.false;
        });
    });
});

describe("resolveSegmentCount", () => {
    function segCap(instance: string, segmentMax: number): CloudCapability {
        return {
            type: "devices.capabilities.segment_color_setting",
            instance,
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

    function deviceWith(
        caps: CloudCapability[],
        segmentCount?: number,
    ): GoveeDevice {
        return {
            sku: "H6160",
            deviceId: "AABBCCDDEEFF0011",
            name: "T",
            type: "devices.types.light",
            capabilities: caps,
            scenes: [],
            diyScenes: [],
            snapshots: [],
            sceneLibrary: [],
            musicLibrary: [],
            diyLibrary: [],
            skuFeatures: null,
            segmentCount,
            state: { online: true },
            channels: { lan: false, mqtt: false, cloud: false },
        };
    }

    it("returns device.segmentCount when already set (cache wins)", () => {
        const device = deviceWith([segCap("segmentedColorRgb", 14)], 20);
        expect(resolveSegmentCount(device)).to.equal(20);
    });

    it("returns 0 when no segment capability and no learned count", () => {
        const device = deviceWith([]);
        expect(resolveSegmentCount(device)).to.equal(0);
    });

    it("uses min of positive capability counts (H70D1: brightness=10, colorRgb=15 → 10)", () => {
        // This is the Icicle-lights case — one cap honest, other inflated.
        const device = deviceWith([
            segCap("segmentedBrightness", 9), // 10 segments
            segCap("segmentedColorRgb", 14),  // 15 segments (lie)
        ]);
        expect(resolveSegmentCount(device)).to.equal(10);
    });

    it("ignores caps without positive count", () => {
        const device = deviceWith([
            segCap("segmentedBrightness", -1), // 0 segments
            segCap("segmentedColorRgb", 14),   // 15 segments
        ]);
        expect(resolveSegmentCount(device)).to.equal(15);
    });

    it("defensive: handles non-array capabilities", () => {
        const device = {
            ...deviceWith([]),
            capabilities: null as unknown as CloudCapability[],
        };
        expect(resolveSegmentCount(device)).to.equal(0);
    });

    it("defensive: handles cap without parameters", () => {
        const device = deviceWith([
            {
                type: "devices.capabilities.segment_color_setting",
                instance: "x",
            } as CloudCapability,
        ]);
        expect(resolveSegmentCount(device)).to.equal(0);
    });

    it("defensive: handles non-segment field names", () => {
        const device = deviceWith([
            {
                type: "devices.capabilities.segment_color_setting",
                instance: "x",
                parameters: {
                    dataType: "STRUCT",
                    fields: [
                        {
                            fieldName: "brightness",
                            elementRange: { min: 0, max: 100 },
                        },
                    ],
                },
            } as CloudCapability,
        ]);
        expect(resolveSegmentCount(device)).to.equal(0);
    });

    it("SEGMENT_HARD_MAX is the protocol ceiling (55)", () => {
        expect(SEGMENT_HARD_MAX).to.equal(55);
    });
});

describe("DeviceManager — loadFromCache merge", () => {
    /**
     * Regression test for v1.7.6 bug: when a device is already present in
     * the device-map via LAN discovery (the normal case on every adapter
     * start, because LAN scan runs before cache load), the existing-branch
     * merge dropped segmentCount, manualMode and manualSegments. Every
     * restart threw away the wizard/MQTT-learned segment state and fell
     * back to Cloud's min-advertised count.
     */
    function makeMockSkuCache(entries: Array<Record<string, unknown>>) {
        return {
            loadAll: () => entries as never,
            save: () => {},
            pruneStale: () => 0,
            clear: () => {},
        };
    }

    it("merges segmentCount + manualMode + manualSegments into existing LAN-discovered device", () => {
        const dm = new DeviceManager(mockLog, mockTimers);
        // Simulate LAN discovery — device gets created without segment data.
        dm.handleLanDiscovery({
            sku: "H61BE",
            device: "AA:BB:CC:DD:EE:FF:12:34",
            ip: "192.168.1.50",
        } as LanDevice);

        const cached = [{
            sku: "H61BE",
            deviceId: "AA:BB:CC:DD:EE:FF:12:34",
            name: "Eating Room",
            type: "devices.types.light",
            capabilities: lightCapabilities(),
            scenes: [],
            diyScenes: [],
            snapshots: [],
            sceneLibrary: [],
            musicLibrary: [],
            diyLibrary: [],
            skuFeatures: null,
            segmentCount: 22,
            manualMode: true,
            manualSegments: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
            scenesChecked: true,
            cachedAt: Date.now(),
        }];
        dm.setSkuCache(makeMockSkuCache(cached) as never);

        dm.loadFromCache();

        const [device] = dm.getDevices();
        expect(device.sku).to.equal("H61BE");
        expect(device.segmentCount).to.equal(22);
        expect(device.manualMode).to.equal(true);
        expect(device.manualSegments).to.deep.equal([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    });

    it("leaves merged fields undefined when cache entry has none (no segment data ever captured)", () => {
        const dm = new DeviceManager(mockLog, mockTimers);
        dm.handleLanDiscovery({
            sku: "H6102",
            device: "00:11:22:33:44:55:66:77",
            ip: "192.168.1.51",
        } as LanDevice);

        const cached = [{
            sku: "H6102",
            deviceId: "00:11:22:33:44:55:66:77",
            name: "Plain Light",
            type: "devices.types.light",
            capabilities: lightCapabilities(),
            scenes: [],
            diyScenes: [],
            snapshots: [],
            sceneLibrary: [],
            musicLibrary: [],
            diyLibrary: [],
            skuFeatures: null,
            scenesChecked: true,
            cachedAt: Date.now(),
            // no segmentCount / manualMode / manualSegments
        }];
        dm.setSkuCache(makeMockSkuCache(cached) as never);

        dm.loadFromCache();

        const [device] = dm.getDevices();
        expect(device.segmentCount).to.equal(undefined);
        expect(device.manualMode).to.equal(undefined);
        expect(device.manualSegments).to.equal(undefined);
    });

    describe("buildCapabilitiesFromAppEntry", () => {
        it("synthesises sensor caps from a complete H5179 lastData payload", () => {
            const entry: AppDeviceEntry = {
                sku: "H5179",
                device: "AA:BB:CC:DD:EE:FF",
                deviceName: "Wohnzimmer",
                lastData: {
                    online: true,
                    tem: 2370, // 23.70 °C
                    hum: 4290, // 42.90 % RH
                    lastTime: 1776704461000,
                },
                settings: {
                    battery: 87,
                },
            };
            const caps = buildCapabilitiesFromAppEntry(entry);
            expect(caps).to.have.lengthOf(4);
            expect(caps[0]).to.deep.equal({
                type: "devices.capabilities.online",
                instance: "online",
                state: { value: true },
            });
            expect(caps[1]).to.deep.equal({
                type: "devices.capabilities.property",
                instance: "sensorTemperature",
                state: { value: 23.7 },
            });
            expect(caps[2]).to.deep.equal({
                type: "devices.capabilities.property",
                instance: "sensorHumidity",
                state: { value: 42.9 },
            });
            expect(caps[3]).to.deep.equal({
                type: "devices.capabilities.property",
                instance: "battery",
                state: { value: 87 },
            });
        });

        it("returns empty array when lastData is missing", () => {
            const entry: AppDeviceEntry = {
                sku: "H5179",
                device: "AA:BB:CC:DD:EE:FF",
                deviceName: "x",
            };
            expect(buildCapabilitiesFromAppEntry(entry)).to.deep.equal([]);
        });

        it("prefers lastData.battery over settings.battery", () => {
            const entry: AppDeviceEntry = {
                sku: "H5179",
                device: "AA:BB:CC:DD:EE:FF",
                deviceName: "x",
                lastData: { battery: 50 },
                settings: { battery: 99 },
            };
            const caps = buildCapabilitiesFromAppEntry(entry);
            expect(caps).to.have.lengthOf(1);
            expect(caps[0].state?.value).to.equal(50);
        });

        it("falls back to settings.battery when lastData has none", () => {
            const entry: AppDeviceEntry = {
                sku: "H5179",
                device: "AA:BB:CC:DD:EE:FF",
                deviceName: "x",
                lastData: { tem: 2000 },
                settings: { battery: 75 },
            };
            const caps = buildCapabilitiesFromAppEntry(entry);
            const battery = caps.find((c) => c.instance === "battery");
            expect(battery?.state?.value).to.equal(75);
        });

        it("ignores non-finite tem/hum values defensively", () => {
            const entry: AppDeviceEntry = {
                sku: "H5179",
                device: "AA:BB:CC:DD:EE:FF",
                deviceName: "x",
                lastData: { tem: NaN, hum: Infinity, online: false },
            };
            const caps = buildCapabilitiesFromAppEntry(entry);
            expect(caps).to.have.lengthOf(1);
            expect(caps[0].instance).to.equal("online");
        });
    });

    describe("pollAppApi", () => {
        function makeApiMock(opts: {
            hasBearer?: boolean;
            entries?: AppDeviceEntry[];
            throws?: boolean;
        }): unknown {
            return {
                hasBearerToken: () => opts.hasBearer ?? true,
                fetchDeviceList: async () => {
                    if (opts.throws) {
                        throw new Error("App API down");
                    }
                    return opts.entries ?? [];
                },
            };
        }

        it("returns 0 without an api client", async () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            expect(await dm2.pollAppApi()).to.equal(0);
        });

        it("returns 0 when bearer token missing", async () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            dm2.setApiClient(makeApiMock({ hasBearer: false }) as never);
            expect(await dm2.pollAppApi()).to.equal(0);
        });

        it("ignores app entries for unknown devices", async () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            dm2.setApiClient(makeApiMock({
                entries: [{
                    sku: "H5179",
                    device: "AA:BB:CC:DD:EE:FF",
                    deviceName: "Unknown",
                    lastData: { tem: 2000 },
                }],
            }) as never);
            expect(await dm2.pollAppApi()).to.equal(0);
        });

        it("forwards synthetic caps for known devices via onCloudCapabilities", async () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            dm2.handleLanDiscovery({
                ip: "192.168.1.50",
                device: "AABBCCDDEEFF0001",
                sku: "H5179",
            } as LanDevice);
            const seen: Array<{ device: GoveeDevice; caps: unknown[] }> = [];
            dm2.setOnCloudCapabilities((device, caps) => {
                seen.push({ device, caps });
            });
            dm2.setApiClient(makeApiMock({
                entries: [{
                    sku: "H5179",
                    device: "AABBCCDDEEFF0001",
                    deviceName: "Wohnzimmer",
                    lastData: { online: true, tem: 2150, hum: 4500 },
                }],
            }) as never);
            expect(await dm2.pollAppApi()).to.equal(1);
            expect(seen).to.have.lengthOf(1);
            expect(seen[0].caps).to.have.lengthOf(3);
        });

        it("returns 0 on fetch error and does not throw", async () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            dm2.setApiClient(makeApiMock({ throws: true }) as never);
            expect(await dm2.pollAppApi()).to.equal(0);
        });
    });

    describe("handleOpenApiEvent", () => {
        it("ignores events for unknown devices", () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            let called = 0;
            dm2.setOnCloudCapabilities(() => { called++; });
            dm2.handleOpenApiEvent({
                sku: "H5179",
                device: "ZZ:ZZ:ZZ:ZZ:ZZ:ZZ",
                capabilities: [{ type: "x", instance: "y", state: { value: 1 } }],
            });
            expect(called).to.equal(0);
        });

        it("forwards caps to onCloudCapabilities for known devices", () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            dm2.handleLanDiscovery({
                ip: "192.168.1.51",
                device: "AABBCCDDEEFF0002",
                sku: "H5179",
            } as LanDevice);
            const seen: unknown[][] = [];
            dm2.setOnCloudCapabilities((_, caps) => seen.push(caps));
            dm2.handleOpenApiEvent({
                sku: "H5179",
                device: "AABBCCDDEEFF0002",
                capabilities: [{ type: "devices.capabilities.event", instance: "lackWaterEvent", state: { value: true } }],
            });
            expect(seen).to.have.lengthOf(1);
            expect((seen[0] as Array<{ instance: string }>)[0].instance).to.equal("lackWaterEvent");
        });

        it("ignores malformed input defensively", () => {
            const dm2 = new DeviceManager(mockLog, mockTimers);
            let called = 0;
            dm2.setOnCloudCapabilities(() => { called++; });
            // Empty, missing fields, non-array caps, empty caps
            dm2.handleOpenApiEvent({} as never);
            dm2.handleOpenApiEvent({ sku: 1 as never, device: "x", capabilities: [] });
            dm2.handleOpenApiEvent({ sku: "H5179", device: "x", capabilities: null as never });
            dm2.handleOpenApiEvent({ sku: "H5179", device: "x", capabilities: [] });
            expect(called).to.equal(0);
        });
    });
});
