import { expect } from "chai";
import { DeviceManager } from "../src/lib/device-manager";
import type { LanDevice, MqttStatusUpdate } from "../src/lib/types";

/** Minimal mock logger */
const mockLog: ioBroker.Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
    level: "debug",
};

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
            // Add a device first
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
    });
});
