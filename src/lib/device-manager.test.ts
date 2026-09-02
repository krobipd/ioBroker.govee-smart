import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { DeviceManager } from "./device-manager";
import {
  parseMqttSegmentData,
  plausibleSegmentCount,
  resolveSegmentCount as resolveSegmentCountRaw,
} from "./device-manager/lookups";
import { buildCapabilitiesFromAppEntry } from "./device-manager/mapping";
import type { AppDeviceEntry } from "./govee-api-client";
import { HttpError } from "./http-client";
import { DeviceRegistry } from "./device-registry";
import { mockLog, mockTimers } from "./test-helpers";
import type { CloudCapability, DeviceState, GoveeDevice, LanDevice, MqttStatusUpdate } from "./types";
import type { MqttSegmentData } from "./device-manager/lookups";

/** A catalog with no entries — tests that don't care about quirks. */
const emptyRegistry = (): DeviceRegistry => new DeviceRegistry({ data: { devices: {} } });
/** The catalog the constructed modules read — reassigned per suite where quirks matter. */
let registry: DeviceRegistry = emptyRegistry();
/**
 * resolveSegmentCount against the suite's current catalog.
 *
 * @param device Device whose segment count is resolved
 */
const resolveSegmentCount = (device: GoveeDevice): number => resolveSegmentCountRaw(device, registry);

/**
 * Quirk-dependent tests (e.g. generateDiagnostics for H6141) need the
 * seed-status entries to be active. Real-world default has them off.
 * beforeEach so other test files cannot leak a reset between cases.
 *
 * createTestDevice / lightCapabilities stay local on purpose: this suite pins
 * the colon-less device id + the map key `H6160_aabbccddeeff0011` in dozens of
 * places, and its capability fixtures carry no segment ranges (the segment
 * tests set the count explicitly).
 */
const QUIRK_TEST_REGISTRY = {
  devices: {
    H6141: { name: "LED Strip", type: "light", status: "seed", quirks: { brokenPlatformApi: true } },
    H5179: { name: "Thermometer", type: "sensor", status: "verified" },
    H61BE: { name: "LED Strip", type: "light", status: "verified" },
    H6056: { name: "LED Strip", type: "light", status: "verified" },
    H70D1: { name: "LED Strip", type: "light", status: "verified" },
    // H9999 is a SYNTHETIC test SKU (not in devices.json) — only exercises the segmentCount quirk.
    H9999: { name: "Segment Quirk Strip", type: "light", status: "verified", quirks: { segmentCount: 5 } },
  },
};

function lightCapabilities(): CloudCapability[] {
  return [
    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
    {
      type: "devices.capabilities.range",
      instance: "brightness",
      parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } },
    },
    { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
    {
      type: "devices.capabilities.color_setting",
      instance: "colorTemperatureK",
      parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
    },
    { type: "devices.capabilities.dynamic_scene", instance: "lightScene", parameters: { dataType: "STRUCT" } },
    { type: "devices.capabilities.dynamic_scene", instance: "snapshot", parameters: { dataType: "STRUCT" } },
    { type: "devices.capabilities.dynamic_scene", instance: "diyScene", parameters: { dataType: "STRUCT" } },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedColorRgb",
      parameters: { dataType: "STRUCT" },
    },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedBrightness",
      parameters: { dataType: "STRUCT" },
    },
  ];
}

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
    diyScenes: [{ name: "MyDIY", value: { id: 100, paramId: "xyz" } }],
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

interface CallRecord {
  method: string;
  args: unknown[];
}

function createCallTracker(): { calls: CallRecord[]; track: (method: string) => (...args: unknown[]) => unknown } {
  const calls: CallRecord[] = [];
  return {
    calls,
    track:
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return true;
      },
  };
}

/**
 * Build a 20-byte AA A5 packet with 4 segment slots
 *
 * @param packetNum Packet sequence number written to byte 2
 * @param slots Up to four [brightness, r, g, b] segment slots
 */
function buildAaA5Packet(packetNum: number, slots: Array<[number, number, number, number]>): string {
  const bytes = new Uint8Array(20);
  bytes[0] = 0xaa;
  bytes[1] = 0xa5;
  bytes[2] = packetNum;
  for (let i = 0; i < slots.length && i < 4; i++) {
    bytes[3 + i * 4] = slots[i][0]; // brightness
    bytes[4 + i * 4] = slots[i][1]; // r
    bytes[5 + i * 4] = slots[i][2]; // g
    bytes[6 + i * 4] = slots[i][3]; // b
  }
  // XOR checksum
  let xor = 0;
  for (let i = 0; i < 19; i++) {
    xor ^= bytes[i];
  }
  bytes[19] = xor;
  return Buffer.from(bytes).toString("base64");
}

describe("DeviceManager", () => {
  beforeEach(() => {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
  });
  afterEach(() => {
    registry = emptyRegistry();
  });

  let dm: DeviceManager;

  beforeEach(() => {
    dm = new DeviceManager(mockLog, mockTimers, registry);
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
      expect(devices).toHaveLength(1);
      expect(devices[0].sku).toBe("H6160");
      expect(devices[0].name).toBe("H6160_0011");
      expect(devices[0].lanIp).toBe("192.168.1.100");
      expect(devices[0].channels.lan).toBe(true);
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
      expect(devices).toHaveLength(2);
      expect(devices[0].name).not.toBe(devices[1].name);
      expect(devices[0].name).toBe("H61BE_0011");
      expect(devices[1].name).toBe("H61BE_7788");
    });

    it("should update LAN IP for existing device", () => {
      // Pre-populate from "cloud"
      const lanDevice1: LanDevice = {
        ip: "192.168.1.100",
        device: "AABBCCDDEEFF0011",
        sku: "H6160",
      };

      dm.handleLanDiscovery(lanDevice1);
      expect(dm.getDevices()[0].lanIp).toBe("192.168.1.100");

      // Same device, new IP
      const lanDevice2: LanDevice = { ...lanDevice1, ip: "192.168.1.200" };
      dm.handleLanDiscovery(lanDevice2);

      const devices = dm.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].lanIp).toBe("192.168.1.200");
    });

    it("should flip cache-loaded matched device from offline to online + emit onDeviceUpdate", () => {
      // Simulate a device pre-loaded from cache via SkuCache. loadFromCache
      // always sets state.online=false (sku-cache.ts does not persist the
      // runtime online flag), so the matched-branch of handleLanDiscovery
      // is the only place that can flip it to true on next discovery.
      const mockCache = {
        loadAll: () =>
          [
            {
              sku: "H6160",
              deviceId: "AABBCCDDEEFF0011",
              name: "cached H6160",
              type: "devices.types.light",
              capabilities: [],
              scenes: [],
              diyScenes: [],
              snapshots: [],
              sceneLibrary: [],
              musicLibrary: [],
              diyLibrary: [],
              skuFeatures: null,
              lastSeenOnNetwork: 0,
            },
          ] as never,
        save: () => {},
        pruneStale: () => 0,
        clear: () => {},
      };
      dm.setSkuCache(mockCache as never);
      dm.loadFromCache();
      expect(dm.getDevices()[0].state.online).toBe(false);

      let updateCount = 0;
      let lastUpdate: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updateCount++;
          lastUpdate = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      // First Discovery — must flip online to true and emit one update
      dm.handleLanDiscovery({ ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" });
      expect(dm.getDevices()[0].state.online).toBe(true);
      expect(updateCount).toBe(1);
      expect(lastUpdate).toEqual({ online: true });

      // Second Discovery — must NOT emit again (idempotent)
      dm.handleLanDiscovery({ ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" });
      expect(updateCount).toBe(1);
    });

    it("should fire onLanDeviceReady when cloud-known device gets LAN IP for the first time", () => {
      (dm as any).mergeCloudDevices([
        {
          sku: "H607C",
          device: "AA:BB:CC:DD:EE:FF:00:22",
          deviceName: "Floor Lamp 2",
          type: "devices.types.light",
          capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: {} }],
        },
      ]);
      const device = dm.getDevices().find(d => d.sku === "H607C");
      expect(device).toBeDefined();
      expect(device!.lanIp).toBeUndefined();

      let lanReadyCount = 0;
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {
          lanReadyCount++;
        },
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleLanDiscovery({ ip: "192.168.1.50", device: "AABBCCDDEEFF0022", sku: "H607C" });
      expect(lanReadyCount).toBe(1);
      expect(device!.lanIp).toBe("192.168.1.50");

      dm.handleLanDiscovery({ ip: "192.168.1.50", device: "AABBCCDDEEFF0022", sku: "H607C" });
      expect(lanReadyCount).toBe(1);
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

      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

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
      expect(updatedState).not.toBeNull();
      expect(updatedState!.power).toBe(true);
      expect(updatedState!.brightness).toBe(75);
      expect(updatedState!.colorRgb).toBe("#ff8000");
    });

    it("should ignore unknown devices", () => {
      let updateCalled = false;
      dm.setCallbacks({
        onUpdate: () => {
          updateCalled = true;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleMqttStatus({
        sku: "UNKNOWN",
        device: "0000000000000000",
        state: { onOff: 1 },
      });

      expect(updateCalled).toBe(false);
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

      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleLanStatus("192.168.1.100", {
        onOff: 0,
        brightness: 50,
        color: { r: 0, g: 255, b: 0 },
        colorTemInKelvin: 4000,
      });

      expect(updatedState).not.toBeNull();
      expect(updatedState!.power).toBe(false);
      expect(updatedState!.brightness).toBe(50);
      expect(updatedState!.colorRgb).toBe("#00ff00");
      expect(updatedState!.colorTemperature).toBe(4000);
    });

    it("should ignore unknown IP addresses", () => {
      let updateCalled = false;
      dm.setCallbacks({
        onUpdate: () => {
          updateCalled = true;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleLanStatus("10.0.0.1", {
        onOff: 1,
        brightness: 50,
        color: { r: 255, g: 255, b: 255 },
        colorTemInKelvin: 4000,
      });

      expect(updateCalled).toBe(false);
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
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].method).toBe("setPower");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", true]);
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
      expect(tracker.calls[0].method).toBe("setBrightness");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", 75]);
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
      expect(tracker.calls[0].method).toBe("setColor");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", 255, 128, 0]);
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
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].method).toBe("controlDevice");
      // Cloud receives: sku, deviceId, capType, capInstance, value(1 for on)
      expect(tracker.calls[0].args[0]).toBe("H6160");
      expect(tracker.calls[0].args[1]).toBe("AABBCCDDEEFF0011");
      expect(tracker.calls[0].args[4]).toBe(1); // power on = 1
    });

    it("removes a cloud-only light no longer in the account after the debounce, keeps LAN-present ones", async () => {
      const deleted = createTestDevice({
        sku: "H61BE",
        deviceId: "DEADBEEF01",
        name: "Sold Light",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: true },
      });
      const lanKept = createTestDevice({
        sku: "H6160",
        deviceId: "AABBCCDDEEFF0011",
        channels: { lan: true, mqtt: false, cloud: true },
      });
      (dm as any).devices.set((dm as any).deviceKey("H61BE", "DEADBEEF01"), deleted);
      (dm as any).devices.set((dm as any).deviceKey("H6160", "AABBCCDDEEFF0011"), lanKept);
      dm.accountReconcileEnabled = true; // main enables this once lanScanDone
      dm.setCloudClient({
        getDevices: () =>
          Promise.resolve([
            {
              sku: "H5100",
              device: "PRESENT0001",
              deviceName: "Present Light",
              type: "devices.types.light",
              capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
            },
          ]),
      } as any);

      // Pass 1 — debounce: one miss, device NOT yet removed (transient guard).
      await dm.loadFromCloud();
      expect(dm.getDevices().map(d => d.deviceId)).toContain("DEADBEEF01");
      expect(deleted.accountMissCount).toBe(1);

      // Pass 2 — second consecutive miss crosses the threshold → removed.
      await dm.loadFromCloud();
      const ids = dm.getDevices().map(d => d.deviceId);
      expect(ids).not.toContain("DEADBEEF01"); // account-deleted light → removed
      expect(ids).toContain("AABBCCDDEEFF0011"); // LAN-present → kept (LAN-first)
    });

    it("does not reconcile before accountReconcileEnabled (LAN-scan window guard)", async () => {
      const cloudOnly = createTestDevice({
        sku: "H61BE",
        deviceId: "DEADBEEF02",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: true },
      });
      (dm as any).devices.set((dm as any).deviceKey("H61BE", "DEADBEEF02"), cloudOnly);
      // accountReconcileEnabled stays false (default)
      dm.setCloudClient({
        getDevices: () =>
          Promise.resolve([
            {
              sku: "H5100",
              device: "PRESENT0001",
              type: "devices.types.light",
              capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
            },
          ]),
      } as any);
      await dm.loadFromCloud();
      await dm.loadFromCloud();
      expect(dm.getDevices().map(d => d.deviceId)).toContain("DEADBEEF02");
      expect(cloudOnly.accountMissCount ?? 0).toBe(0); // gated → never touched
    });

    it("loadFromCloud classifies a 429 as rate-limited with the Retry-After delay (L29)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.setCloudClient({
        getDevices: () => Promise.reject(new HttpError("Rate limited", 429, { "retry-after": "30" })),
      } as any);
      expect(await dm2.loadFromCloud()).toMatchObject({ ok: false, reason: "rate-limited", retryAfterMs: 30000 });
    });

    it("loadFromCloud classifies a 401 with a non-'auth' body as auth-failed — no retry loop on a bad key (L29)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.setCloudClient({ getDevices: () => Promise.reject(new HttpError("Access denied", 401, {})) } as any);
      expect(await dm2.loadFromCloud()).toMatchObject({ ok: false, reason: "auth-failed" });
    });

    it("loadFromCloud classifies a generic network error as transient (L29)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.setCloudClient({ getDevices: () => Promise.reject(new Error("network boom")) } as any);
      expect(await dm2.loadFromCloud()).toMatchObject({ ok: false, reason: "transient" });
    });

    it("loadGroupMembers returns false without an api client / without a bearer token (L29)", async () => {
      const noClient = new DeviceManager(mockLog, mockTimers, registry);
      expect(await noClient.loadGroupMembers()).toBe(false);
      const noBearer = new DeviceManager(mockLog, mockTimers, registry);
      noBearer.setApiClient({ hasBearerToken: () => false } as any);
      expect(await noBearer.loadGroupMembers()).toBe(false);
    });

    it("removes a BaseGroup deleted from the account after the debounce (non-empty group list)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      const deletedGroup = createTestDevice({
        sku: "BaseGroup",
        deviceId: "9001",
        name: "Old Group",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: false },
      });
      (dm2 as any).devices.set((dm2 as any).deviceKey("BaseGroup", "9001"), deletedGroup);
      dm2.accountReconcileEnabled = true;
      // Group list is non-empty (a different group still exists) but the deleted
      // group is absent → reconcilable via the group authority, evicted after N.
      dm2.setApiClient({
        hasBearerToken: () => true,
        fetchGroupMembers: () => Promise.resolve([{ groupId: 8888, devices: [] }]),
      } as any);

      await dm2.loadGroupMembers(); // pass 1 → miss 1, kept
      expect(dm2.getDevices().map(d => d.deviceId)).toContain("9001");
      expect(deletedGroup.accountMissCount).toBe(1);

      await dm2.loadGroupMembers(); // pass 2 → miss 2 → evicted
      expect(dm2.getDevices().map(d => d.deviceId)).not.toContain("9001");
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
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].method).toBe("setScene");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", 42, "AQID"]);
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
        scenes: [{ name: "Aurora-B", value: { id: 1 } }],
        sceneLibrary: [{ name: "Aurora", sceneCode: 215 }],
      });
      (dm as any).devices.set("H6160_aabbccddeeff0011", device);

      // "Aurora-B" → base name "Aurora" → matches library
      await dm.sendCommand(device, "lightScene", "1");
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].method).toBe("setScene");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", 215, ""]);
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
        sceneLibrary: [{ name: "Aurora", sceneCode: 99 }],
      });
      (dm as any).devices.set("H6160_aabbccddeeff0011", device);

      // Select scene index 1 = "Sunset" → NOT in library (library only has "Aurora")
      await dm.sendCommand(device, "lightScene", "1");
      // LAN setScene should NOT be called
      expect(lanTracker.calls).toHaveLength(0);
      // Cloud should be called
      expect(cloudTracker.calls).toHaveLength(1);
      expect(cloudTracker.calls[0].method).toBe("controlDevice");
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
      expect(lanTracker.calls.map(c => c.method)).toEqual(["setColor", "setSegmentColor"]);
      const segCall = lanTracker.calls[1];
      expect(segCall.args[0]).toBe("192.168.1.100");
      expect(segCall.args[1]).toBe(255); // R
      expect(segCall.args[2]).toBe(0); // G
      expect(segCall.args[3]).toBe(0); // B
      // Cloud should NOT be called
      expect(cloudTracker.calls).toHaveLength(0);
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
      expect(lanTracker.calls.map(c => c.method)).toEqual(["setColor", "setSegmentBrightness"]);
      expect(lanTracker.calls[1].args[1]).toBe(50);
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
      });

      // Must not throw, must call LAN setSegmentColor + setSegmentBrightness
      const colorCalls = lanTracker.calls.filter(c => c.method === "setSegmentColor");
      const brightCalls = lanTracker.calls.filter(c => c.method === "setSegmentBrightness");
      expect(colorCalls).toHaveLength(1);
      expect(colorCalls[0].args[4]).toEqual([0, 1, 2]);
      expect(brightCalls).toHaveLength(1);
      expect(brightCalls[0].args[1]).toBe(80);
    });

    it("sendCommand(segmentBatch, null/undefined) sends nothing and does not throw", async () => {
      // Internal callers (wizard, restore) hand over objects; a null/undefined
      // value carries no segments — dropped without a LAN frame, without a crash.
      const lanTracker = createCallTracker();
      dm.setLanClient({
        setColor: lanTracker.track("setColor"),
        setSegmentColor: lanTracker.track("setSegmentColor"),
        setSegmentBrightness: lanTracker.track("setSegmentBrightness"),
      } as any);
      const device = createTestDevice();
      (dm as any).devices.set("H6160_aabbccddeeff0011", device);
      await dm.sendCommand(device, "segmentBatch", null);
      await dm.sendCommand(device, "segmentBatch", undefined);
      expect(lanTracker.calls).toHaveLength(0);
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
      expect(cloudTracker.calls).toHaveLength(1);
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
      expect(lanTracker.calls).toHaveLength(1);
      expect(lanTracker.calls[0].method).toBe("sendPtReal");
      expect(lanTracker.calls[0].args[1]).toEqual(["cGFja2V0MQ==", "cGFja2V0Mg=="]);
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
      expect(lanTracker.calls).toHaveLength(0);
      expect(cloudTracker.calls).toHaveLength(1);
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
      expect(lanTracker.calls).toHaveLength(1);
      expect(lanTracker.calls[0].method).toBe("setGradient");
      expect(lanTracker.calls[0].args[1]).toBe(true);
    });
  });

  describe("toCloudValue — value conversions", () => {
    let device: GoveeDevice;

    beforeEach(() => {
      device = createTestDevice();
    });

    it("should convert power true to 1", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "power", true);
      expect(result).toBe(1);
    });

    it("should convert power false to 0", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "power", false);
      expect(result).toBe(0);
    });

    it("should pass brightness through unchanged", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "brightness", 75);
      expect(result).toBe(75);
    });

    it("should convert colorRgb hex to packed integer", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#ff8000");
      expect(result).toBe(0xff8000);
    });

    it("should convert black color", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#000000");
      expect(result).toBe(0);
    });

    it("should convert white color", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "colorRgb", "#ffffff");
      expect(result).toBe(0xffffff);
    });

    it("should resolve lightScene index to scene value", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "1");
      expect(result).toEqual({ id: 1, paramId: "abc" }); // Sunset
    });

    it("should resolve lightScene index 2", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "2");
      expect(result).toEqual({ id: 2, paramId: "def" }); // Rainbow
    });

    it("should fall back to raw value for invalid lightScene index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "lightScene", "99");
      expect(result).toBe("99");
    });

    it("should resolve snapshot index to integer value", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "1");
      expect(result).toBe(3782580);
    });

    it("should resolve snapshot index 2", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "2");
      expect(result).toBe(3782581);
    });

    it("should resolve diyScene index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "diyScene", "1");
      expect(result).toEqual({ id: 100, paramId: "xyz" });
    });

    it("should convert segmentColor to struct", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "segmentColor:3", "#ff0000");
      expect(result).toEqual({ segment: [3], rgb: 0xff0000 });
    });

    it("should convert segmentBrightness to struct", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "segmentBrightness:5", 80);
      expect(result).toEqual({ segment: [5], brightness: 80 });
    });

    it("should pass unknown commands through", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "unknownCommand", 42);
      expect(result).toBe(42);
    });
  });

  describe("parseSegmentBatch", () => {
    let device: GoveeDevice;

    beforeEach(() => {
      device = createTestDevice({ segmentCount: 15 });
    });

    it("should parse range with color and brightness", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "1-5:#ff0000:20");
      expect(result).not.toBeNull();
      expect(result.segments).toEqual([1, 2, 3, 4, 5]);
      expect(result.color).toBe(0xff0000);
      expect(result.brightness).toBe(20);
    });

    it("should parse 'all' keyword", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#00ff00:50");
      expect(result.segments).toHaveLength(15);
      expect(result.segments[0]).toBe(0);
      expect(result.segments[14]).toBe(14);
      expect(result.color).toBe(0x00ff00);
      expect(result.brightness).toBe(50);
    });

    it("should parse comma-separated indices", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "0,3,7:#0000ff");
      expect(result.segments).toEqual([0, 3, 7]);
      expect(result.color).toBe(0x0000ff);
      expect(result.brightness).toBeUndefined();
    });

    it("should parse brightness only (empty color)", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "all::50");
      expect(result.segments).toHaveLength(15);
      expect(result.color).toBeUndefined();
      expect(result.brightness).toBe(50);
    });

    it("should parse color without # prefix", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "0:ff8000");
      expect(result.color).toBe(0xff8000);
    });

    it("should clamp segments to segmentCount", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "10-20:#ff0000");
      // Only 10-14 should be included (segmentCount=15)
      expect(result.segments).toEqual([10, 11, 12, 13, 14]);
    });

    it("should return null for empty command", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "");
      expect(result).toBeNull();
    });

    it("should return null when no color or brightness given", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "1-5");
      expect(result).toBeNull();
    });

    it("should return null for invalid segment indices", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "abc:#ff0000");
      expect(result).toBeNull();
    });

    it("should handle mixed ranges and indices", () => {
      const result = (dm as any).commandRouter.parseSegmentBatch(device, "0,3-5,10:#ffffff");
      expect(result.segments).toEqual([0, 3, 4, 5, 10]);
    });

    describe("manual segment override", () => {
      it("should honor manualSegments for 'all'", () => {
        device.manualMode = true;
        device.manualSegments = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#ff0000");
        expect(result).not.toBeNull();
        expect(result.segments).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      });

      it("should honor non-contiguous manualSegments for 'all'", () => {
        device.manualMode = true;
        device.manualSegments = [0, 1, 2, 5, 6, 7]; // gap at 3,4
        const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#00ff00");
        expect(result.segments).toEqual([0, 1, 2, 5, 6, 7]);
      });

      it("should filter out invalid indices when manual mode active", () => {
        device.manualMode = true;
        device.manualSegments = [0, 1, 2, 5, 6]; // user says 3,4,7..14 not physical
        const result = (dm as any).commandRouter.parseSegmentBatch(device, "0-14:#0000ff");
        expect(result.segments).toEqual([0, 1, 2, 5, 6]);
      });

      it("should return null if no valid indices after filtering", () => {
        device.manualMode = true;
        device.manualSegments = [0, 1, 2];
        const result = (dm as any).commandRouter.parseSegmentBatch(device, "10-14:#ff0000");
        expect(result).toBeNull();
      });

      it("should fall back to segmentCount when manualMode=false", () => {
        device.manualMode = false;
        device.manualSegments = [0, 1, 2]; // list ignored when mode off
        const result = (dm as any).commandRouter.parseSegmentBatch(device, "all:#ff0000");
        expect(result.segments).toHaveLength(15);
      });
    });

    describe("non-string input guards (wizard/internal callers)", () => {
      it("parseSegmentBatch returns null for object input (defensive)", () => {
        const result = (dm as any).commandRouter.parseSegmentBatch(device, {
          segments: [0, 1],
          color: 0xff0000,
        } as any);
        expect(result).toBeNull();
      });

      it("parseSegmentBatch returns null for null/undefined", () => {
        expect((dm as any).commandRouter.parseSegmentBatch(device, null)).toBeNull();
        expect((dm as any).commandRouter.parseSegmentBatch(device, undefined)).toBeNull();
      });

      it("coerceParsedBatch accepts valid object", () => {
        const result = (dm as any).commandRouter.coerceParsedBatch({
          segments: [0, 1, 2],
          color: 0xff0000,
          brightness: 50,
        });
        expect(result).toEqual({
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
        expect(result.brightness).toBe(100);
      });

      it("coerceParsedBatch rejects empty segments", () => {
        expect((dm as any).commandRouter.coerceParsedBatch({ segments: [], color: 0 })).toBeNull();
      });

      it("coerceParsedBatch rejects missing segments field", () => {
        expect((dm as any).commandRouter.coerceParsedBatch({ color: 0 })).toBeNull();
      });

      it("coerceParsedBatch rejects non-object", () => {
        expect((dm as any).commandRouter.coerceParsedBatch("string")).toBeNull();
        expect((dm as any).commandRouter.coerceParsedBatch(null)).toBeNull();
        expect((dm as any).commandRouter.coerceParsedBatch(42)).toBeNull();
      });

      it("coerceParsedBatch filters non-numeric segment entries", () => {
        const result = (dm as any).commandRouter.coerceParsedBatch({
          segments: [0, "bad", -1, 2, NaN, 3],
          color: 0,
        });
        expect(result.segments).toEqual([0, 2, 3]);
      });

      it("coerceParsedBatch requires at least color or brightness", () => {
        expect((dm as any).commandRouter.coerceParsedBatch({ segments: [0, 1] })).toBeNull();
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
      expect(result).toBeDefined();
      expect(result.type).toBe("devices.capabilities.on_off");
    });

    it("should find range brightness for brightness", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "brightness");
      expect(result).toBeDefined();
      expect(result.instance).toBe("brightness");
    });

    it("should find colorRgb for colorRgb", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "colorRgb");
      expect(result).toBeDefined();
      expect(result.instance).toBe("colorRgb");
    });

    it("should find colorTemperatureK for colorTemperature", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "colorTemperature");
      expect(result).toBeDefined();
      expect(result.instance).toContain("colorTem");
    });

    it("should find dynamic_scene lightScene for lightScene", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "lightScene");
      expect(result).toBeDefined();
      expect(result.instance).toBe("lightScene");
    });

    it("should find dynamic_scene snapshot for snapshot", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "snapshot");
      expect(result).toBeDefined();
      expect(result.instance).toBe("snapshot");
    });

    it("should find dynamic_scene diyScene for diyScene", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "diyScene");
      expect(result).toBeDefined();
      expect(result.instance).toBe("diyScene");
    });

    it("should find segmentedColorRgb for segmentColor", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "segmentColor:0");
      expect(result).toBeDefined();
      expect(result.type).toContain("segment_color_setting");
      expect(result.instance).toBe("segmentedColorRgb");
    });

    it("should find segmentedBrightness for segmentBrightness", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "segmentBrightness:3");
      expect(result).toBeDefined();
      expect(result.type).toContain("segment_color_setting");
      expect(result.instance).toBe("segmentedBrightness");
    });

    it("should return undefined for unknown commands", () => {
      const result = (dm as any).commandRouter.findCapabilityForCommand(device, "unknownCommand");
      expect(result).toBeUndefined();
    });

    it("should return undefined for device without capabilities", () => {
      const emptyDevice = createTestDevice({ capabilities: [] });
      const result = (dm as any).commandRouter.findCapabilityForCommand(emptyDevice, "power");
      expect(result).toBeUndefined();
    });

    it("should not throw when capabilities is non-array", () => {
      const badDevice = createTestDevice({
        capabilities: undefined as unknown as CloudCapability[],
      });
      expect(() => (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power")).not.toThrow();
      const result = (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power");
      expect(result).toBeUndefined();
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
      expect(() => (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power")).not.toThrow();
      const result = (dm as any).commandRouter.findCapabilityForCommand(badDevice, "power");
      expect(result).toBeDefined();
      expect(result.instance).toBe("powerSwitch");
    });
  });

  describe("Drift: malformed cloud device list", () => {
    it("mergeCloudDevices should skip devices with non-string sku", () => {
      const bad = [
        { sku: null, device: "abc", deviceName: "x", type: "devices.types.light", capabilities: [] },
        { sku: "H6160", device: "good123", deviceName: "Good", type: "devices.types.light", capabilities: [] },
      ];
      expect(() => (dm as any).mergeCloudDevices(bad)).not.toThrow();
      (dm as any).mergeCloudDevices(bad);
      const devices = dm.getDevices();
      const skus = devices.map(d => d.sku);
      expect(skus).toContain("H6160");
      expect(skus).not.toContain(null);
    });

    it("mergeCloudDevices should skip devices with non-string device id", () => {
      const bad = [{ sku: "H6160", device: 123, deviceName: "x", type: "devices.types.light", capabilities: [] }];
      expect(() => (dm as any).mergeCloudDevices(bad)).not.toThrow();
      expect(dm.getDevices()).toEqual([]); // really skipped, not added under a garbage id
    });

    it("mergeCloudDevices should not throw when capabilities is non-array", () => {
      const bad = [{ sku: "H6160", device: "abc", deviceName: "x", type: "devices.types.light", capabilities: "oops" }];
      expect(() => (dm as any).mergeCloudDevices(bad)).not.toThrow();
      const dev = dm.getDevices().find(d => d.sku === "H6160");
      expect(dev, "the device is kept — only the broken capability list is normalised").toBeDefined();
      expect(dev!.capabilities).toEqual([]);
    });

    it("mergeCloudDevices should not throw when cloudDevices is non-array", () => {
      expect(() => (dm as any).mergeCloudDevices(null)).not.toThrow();
      expect(() => (dm as any).mergeCloudDevices(undefined)).not.toThrow();
      expect(() => (dm as any).mergeCloudDevices({} as any)).not.toThrow();
    });

    it("mergeCloudDevices should skip null entries", () => {
      const bad = [
        null,
        undefined,
        { sku: "H6160", device: "abc", deviceName: "x", type: "devices.types.light", capabilities: [] },
      ];
      expect(() => (dm as any).mergeCloudDevices(bad)).not.toThrow();
    });

    it("mergeCloudDevices should not create a phantom device for a SameModeGroup pseudo-entry", () => {
      // Govee's OpenAPI /user/devices returns app device-groups as pseudo-devices
      // (sku "BaseGroup" or "SameModeGroup"). We support BaseGroup (member fan-out
      // resolved via the app-API group list), but a SameModeGroup has no member-
      // resolution path here — merging it verbatim would build a generic light out
      // of its capabilities and leave an orphaned control tree that never works.
      const list = [
        {
          sku: "SameModeGroup",
          device: "9100",
          deviceName: "Living Room Same Mode",
          type: "devices.types.light",
          capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 0 } }],
        },
        { sku: "H6160", device: "real123", deviceName: "Real Strip", type: "devices.types.light", capabilities: [] },
      ];
      (dm as any).mergeCloudDevices(list);
      const skus = dm.getDevices().map(d => d.sku);
      expect(skus).toContain("H6160");
      expect(skus).not.toContain("SameModeGroup");
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
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { onOff: 0 },
      });
      expect(updatedState).not.toBeNull();
      expect(updatedState!.power).toBe(false);
      expect(updatedState!.brightness).toBeUndefined();
      expect(updatedState!.colorRgb).toBeUndefined();
    });

    it("should handle color temperature from MQTT", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { colorTemInKelvin: 5000 },
      });
      expect(updatedState!.colorTemperature).toBe(5000);
    });

    it("should set mqtt channel to true on status update", () => {
      setupDevice();
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { onOff: 1 },
      });

      const device = dm.getDevices()[0];
      expect(device.channels.mqtt).toBe(true);
    });

    it("should handle empty state object", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
      });
      // For Lights, handleMqttStatus no longer carries online=true — MQTT-push
      // is not a valid info.online source (broker buffering risk). The callback
      // still fires (other state could be updated) but with an empty/sparse
      // state object when nothing else came in.
      expect(updatedState).not.toBeNull();
      expect(updatedState!.online).toBeUndefined();
    });

    it("should coerce string brightness from spoofed Govee push", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      // Govee occasionally sends `brightness: "50"` (string) — the adapter must
      // coerce it to 50 (number) via coerceFiniteNumber and not propagate the
      // string unchanged into the number-typed state.
      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { brightness: "50" as unknown as number },
      });
      expect(updatedState).not.toBeNull();
      expect(updatedState!.brightness).toBe(50);
      expect(typeof updatedState!.brightness).toBe("number");
    });

    it("should drop completely garbage brightness (NaN, object, null)", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { brightness: "NaN" as unknown as number, onOff: "garbage" as unknown as number },
      });
      // Lights: MQTT-push does not write online (LAN-only resolver owns it).
      // Garbage brightness/power are still rejected by coerce — both undefined.
      expect(updatedState).not.toBeNull();
      expect(updatedState!.online).toBeUndefined();
      expect(updatedState!.brightness).toBeUndefined();
      expect(updatedState!.power).toBeUndefined();
    });

    it("should drop colorTemInKelvin=0 (Govee 'no colortemp mode' marker)", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { colorTemInKelvin: 0 },
      });
      expect(updatedState).not.toBeNull();
      expect(updatedState!.colorTemperature).toBeUndefined();
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
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleLanStatus("192.168.1.100", {
        onOff: 1,
        brightness: 0,
        color: { r: 0, g: 0, b: 0 },
        colorTemInKelvin: 0,
      });
      expect(updatedState!.brightness).toBe(0);
    });

    it("should handle colorTemInKelvin 0 as no color temp", () => {
      setupDevice();
      let updatedState: Partial<DeviceState> | null = null;
      dm.setCallbacks({
        onUpdate: (_dev, state) => {
          updatedState = state;
        },
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm.handleLanStatus("192.168.1.100", {
        onOff: 1,
        brightness: 50,
        color: { r: 255, g: 0, b: 0 },
        colorTemInKelvin: 0,
      });
      // colorTemInKelvin 0 means RGB mode, not color temp
      expect(updatedState!.colorTemperature).toBeUndefined();
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
      expect(lanTracker.calls).toHaveLength(1);
      expect(lanTracker.calls[0].method).toBe("setDiyScene");
      expect(lanTracker.calls[0].args[1]).toBe("ABCD");
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
      expect(lanTracker.calls.filter(c => c.method === "setDiyScene")).toHaveLength(0);
      // Cloud should be called
      expect(cloudTracker.calls).toHaveLength(1);
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
      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].method).toBe("setColorTemperature");
      expect(tracker.calls[0].args).toEqual(["192.168.1.100", 4500]);
    });
  });

  describe("sendCommand — no channel available", () => {
    it("should warn when no channel is available", async () => {
      const warnings: string[] = [];
      const warnLog: ioBroker.Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
        error: () => {},
        silly: () => {},
        level: "debug",
      };
      const noDm = new DeviceManager(warnLog, mockTimers, registry);

      const device = createTestDevice({
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: false },
      });
      (noDm as any).devices.set("H6160_aabbccddeeff0011", device);

      await noDm.sendCommand(device, "power", true);
      expect(warnings.some(w => w.includes("No channel available"))).toBe(true);
    });
  });

  describe("generateDiagnostics", () => {
    it("should include all device data in diagnostics export", () => {
      const device = createTestDevice({
        sceneLibrary: [
          { name: "Sunset", sceneCode: 42, speedInfo: { supSpeed: true, speedIndex: 0, config: "[{},{}]" } },
        ],
        musicLibrary: [{ name: "Energic", musicCode: 1, mode: 0 }],
        diyLibrary: [{ name: "MyDIY", diyCode: 10 }],
      });

      const result = dm.generateDiagnostics(device, "1.0.1");
      expect(result.adapter).toBe("iobroker.govee-smart");
      expect(result.version).toBe("1.0.1");
      expect(typeof result.exportedAt).toBe("string");
      expect((result.device as any).sku).toBe("H6160");
      expect((result.device as any).channels).toEqual({ lan: true, mqtt: true, cloud: true });
      expect((result.scenes as any).count).toBe(2);
      expect((result.scenes as any).names).toEqual(["Sunset", "Rainbow"]);
      expect((result.sceneLibrary as any).count).toBe(1);
      // v2.9.1 — sceneLibrary now exports full entries (incl. scenceParam +
      // speedInfo). Old shape projected `speedSupported: boolean` only.
      expect((result.sceneLibrary as any).entries[0].speedInfo.supSpeed).toBe(true);
      expect((result.musicLibrary as any).count).toBe(1);
      expect((result.diyLibrary as any).count).toBe(1);
      expect(result.quirks).toBeNull(); // H6160 has no quirks
      expect(result.state).toEqual({ online: true });
    });

    it("should include quirks for known SKU", () => {
      const device = createTestDevice({ sku: "H6141" });
      const result = dm.generateDiagnostics(device, "1.0.1");
      expect((result.quirks as any).brokenPlatformApi).toBe(true);
    });
  });

  describe("toCloudValue — bounds checks", () => {
    const device = createTestDevice();

    it("should return raw value for NaN diyScene index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "diyScene", "abc");
      expect(result).toBe("abc");
    });

    it("should return raw value for zero snapshot index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "0");
      expect(result).toBe("0");
    });

    it("should return raw value for out-of-range snapshot index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "snapshot", "999");
      expect(result).toBe("999");
    });

    it("should return raw value for invalid segment index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "segmentColor:-1", "#ff0000");
      expect(result).toBe("#ff0000");
    });

    it("should return raw value for NaN segment brightness index", () => {
      const result = (dm as any).commandRouter.toCloudValue(device, "segmentBrightness:abc", 50);
      expect(result).toBe(50);
    });
  });

  describe("parseMqttSegmentData", () => {
    it("rejects a packet whose XOR checksum does not match (spoofed / corrupt)", () => {
      const good = buildAaA5Packet(1, [
        [100, 255, 0, 0],
        [50, 0, 255, 0],
        [75, 0, 0, 255],
        [1, 128, 128, 128],
      ]);
      expect(parseMqttSegmentData([good]).segments).toHaveLength(4);

      // Flip the checksum byte only — everything else stays a valid packet, so
      // an unchecked parser would happily persist a wrong segment count.
      const bytes = Buffer.from(good, "base64");
      bytes[19] = bytes[19] ^ 0xff;
      expect(parseMqttSegmentData([bytes.toString("base64")]).segments).toHaveLength(0);

      // A flipped payload byte invalidates the checksum too.
      const tampered = Buffer.from(good, "base64");
      tampered[5] = tampered[5] ^ 0x0f;
      expect(parseMqttSegmentData([tampered.toString("base64")]).segments).toHaveLength(0);
    });

    it("should parse single AA A5 packet with 4 segments", () => {
      const pkt = buildAaA5Packet(1, [
        [100, 255, 0, 0], // seg 0: brightness 100, red
        [50, 0, 255, 0], // seg 1: brightness 50, green
        [75, 0, 0, 255], // seg 2: brightness 75, blue
        [1, 128, 128, 128], // seg 3: brightness 1 (not padding), grey
      ]);
      const result = parseMqttSegmentData([pkt]).segments;
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ index: 0, brightness: 100, r: 255, g: 0, b: 0 });
      expect(result[1]).toEqual({ index: 1, brightness: 50, r: 0, g: 255, b: 0 });
      expect(result[2]).toEqual({ index: 2, brightness: 75, r: 0, g: 0, b: 255 });
      expect(result[3]).toEqual({ index: 3, brightness: 1, r: 128, g: 128, b: 128 });
    });

    it("should parse multiple packets and compute correct segment indices", () => {
      const pkt1 = buildAaA5Packet(1, [
        [100, 255, 0, 0],
        [100, 0, 255, 0],
        [100, 0, 0, 255],
        [100, 255, 255, 0],
      ]);
      const pkt2 = buildAaA5Packet(2, [
        [80, 10, 20, 30],
        [60, 40, 50, 60],
        [40, 70, 80, 90],
        [20, 100, 110, 120],
      ]);
      const result = parseMqttSegmentData([pkt1, pkt2]).segments;
      expect(result).toHaveLength(8);
      // Packet 2 starts at segment index 4
      expect(result[4]).toEqual({ index: 4, brightness: 80, r: 10, g: 20, b: 30 });
      expect(result[7]).toEqual({ index: 7, brightness: 20, r: 100, g: 110, b: 120 });
    });

    it("dedupes/caps packets so a flood can't explode the segments list (SEC-GC1)", () => {
      const nz: [number, number, number, number] = [100, 10, 20, 30]; // non-zero → not trailing-trimmed
      const dup = buildAaA5Packet(1, [nz, nz, nz, nz]);
      const flood = Array.from({ length: 5000 }, () => dup); // 5000 duplicate packet-1's
      const result = parseMqttSegmentData(flood).segments;
      expect(result.length).toBeLessThanOrEqual(20); // deduped, not 5000×4
      expect(result).toHaveLength(4); // one packet-1 = 4 segments
    });

    it("still parses all 5 distinct packets after the dedupe/cap (SEC-GC1 no regression)", () => {
      const nz: [number, number, number, number] = [50, 1, 2, 3];
      const msg = [1, 2, 3, 4, 5].map(n => buildAaA5Packet(n, [nz, nz, nz, nz]));
      expect(parseMqttSegmentData(msg).segments).toHaveLength(20);
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
      const result = parseMqttSegmentData([pkt]).segments;
      expect(result).toHaveLength(2);
      expect(result[0].index).toBe(0);
      expect(result[1].index).toBe(1);
    });

    it("should keep zero-slots that have real data AFTER them", () => {
      // A lit segment followed by an unlit (genuine) segment followed
      // by a lit one — the middle zero slot must not be trimmed.
      const pkt = buildAaA5Packet(1, [
        [100, 255, 0, 0],
        [0, 0, 0, 0], // genuine off segment
        [100, 0, 255, 0],
        [1, 128, 128, 128], // non-padding last
      ]);
      const result = parseMqttSegmentData([pkt]).segments;
      expect(result).toHaveLength(4);
      expect(result[1]).toEqual({ index: 1, brightness: 0, r: 0, g: 0, b: 0 });
    });

    it("should ignore non-AA-A5 packets", () => {
      const modeBytes = new Uint8Array(20);
      modeBytes[0] = 0xaa;
      modeBytes[1] = 0x05;
      modeBytes[2] = 0x15;
      const modePkt = Buffer.from(modeBytes).toString("base64");

      const segPkt = buildAaA5Packet(1, [
        [100, 255, 0, 0],
        [50, 0, 255, 0],
        [75, 128, 128, 128],
        [1, 1, 1, 1],
      ]);
      const result = parseMqttSegmentData([modePkt, segPkt]).segments;
      expect(result).toHaveLength(4);
      expect(result[0].index).toBe(0);
    });

    it("should return empty array for empty commands", () => {
      const result = parseMqttSegmentData([]).segments;
      expect(result).toHaveLength(0);
    });

    it("should skip packets with invalid packet number", () => {
      const bytes = new Uint8Array(20);
      bytes[0] = 0xaa;
      bytes[1] = 0xa5;
      bytes[2] = 6; // invalid: must be 1-5
      const pkt = Buffer.from(bytes).toString("base64");
      const result = parseMqttSegmentData([pkt]).segments;
      expect(result).toHaveLength(0);
    });

    it("should skip packets shorter than 20 bytes", () => {
      const shortBytes = new Uint8Array(10);
      shortBytes[0] = 0xaa;
      shortBytes[1] = 0xa5;
      shortBytes[2] = 1;
      const pkt = Buffer.from(shortBytes).toString("base64");
      const result = parseMqttSegmentData([pkt]).segments;
      expect(result).toHaveLength(0);
    });

    it("should decode all 5 packets for a 20-segment strip", () => {
      // 0x64 = 100 decimal brightness, warm white: FF CA 91
      const pkts = [];
      for (let p = 1; p <= 5; p++) {
        pkts.push(
          buildAaA5Packet(p, [
            [0x64, 0xff, 0xca, 0x91],
            [0x64, 0xff, 0xca, 0x91],
            [0x64, 0xff, 0xca, 0x91],
            [0x64, 0xff, 0xca, 0x91],
          ]),
        );
      }
      const result = parseMqttSegmentData(pkts).segments;
      expect(result).toHaveLength(20);
      expect(result[0].index).toBe(0);
      expect(result[19].index).toBe(19);
      for (const seg of result) {
        expect(seg.brightness).toBe(100);
        expect(seg.r).toBe(255);
        expect(seg.g).toBe(202);
        expect(seg.b).toBe(145);
      }
    });

    // Drift guards — MQTT payload structure could change unexpectedly.
    it("should return [] for non-array commands input", () => {
      const result = parseMqttSegmentData(null as unknown as string[]).segments;
      expect(result).toEqual([]);
    });

    it("should return [] for undefined commands input", () => {
      const result = parseMqttSegmentData(undefined as unknown as string[]).segments;
      expect(result).toEqual([]);
    });

    it("should return [] for object instead of array", () => {
      const result = parseMqttSegmentData({} as unknown as string[]).segments;
      expect(result).toEqual([]);
    });

    it("should skip non-string entries in commands array", () => {
      const goodPkt = buildAaA5Packet(1, [
        [0x50, 0xff, 0x00, 0x00],
        [0x10, 0x00, 0xff, 0x00],
        [0x10, 0x00, 0x00, 0xff],
        [0x10, 0xff, 0xff, 0x00],
      ]);
      const result = parseMqttSegmentData([
        null as unknown as string,
        42 as unknown as string,
        goodPkt,
        {} as unknown as string,
      ]).segments;
      expect(result.length).toBe(4);
      expect(result[0].index).toBe(0);
      expect(result[0].r).toBe(255);
    });

    it("strips a >100 padding slot and reports complete (H6076: 7 real + 1 junk)", () => {
      // The H6076 has 7 segments; the 8th slot in packet 2 is filler with an
      // impossible brightness (0x92 = 146). It must be stripped and the result
      // flagged complete — the device ended its list, so 7 is authoritative.
      const real: [number, number, number, number] = [100, 255, 206, 146];
      const pkt1 = buildAaA5Packet(1, [real, real, real, real]);
      const pkt2 = buildAaA5Packet(2, [real, real, real, [146, 100, 100, 100]]);
      const { segments, complete } = parseMqttSegmentData([pkt1, pkt2]);
      expect(segments).toHaveLength(7);
      expect(segments[6].index).toBe(6);
      expect(complete).toBe(true);
    });

    it("does NOT strip a >100 slot mid-list — trailing-only (no mid-list filter)", () => {
      const pkt = buildAaA5Packet(1, [
        [100, 1, 2, 3],
        [146, 4, 5, 6], // impossible brightness in the MIDDLE — must stay
        [100, 7, 8, 9],
        [50, 10, 11, 12], // valid trailing → nothing gets stripped
      ]);
      const { segments, complete } = parseMqttSegmentData([pkt]);
      expect(segments).toHaveLength(4);
      expect(segments[1].brightness).toBe(146);
      expect(complete).toBe(false); // nothing stripped → not authoritative
    });

    it("reports NOT complete for a full packet with no padding (may be truncated)", () => {
      const pkt = buildAaA5Packet(1, [
        [100, 1, 1, 1],
        [100, 2, 2, 2],
        [100, 3, 3, 3],
        [100, 4, 4, 4],
      ]);
      const { segments, complete } = parseMqttSegmentData([pkt]);
      expect(segments).toHaveLength(4);
      expect(complete).toBe(false);
    });
  });

  describe("handleMqttStatus — segment state sync", () => {
    it("should call onMqttSegmentUpdate when op.command contains AA A5 packets", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
      dm.handleLanDiscovery(lanDevice);

      // Match segmentCount to what this packet reports (2), so the push takes
      // the per-segment-sync path rather than a count change (which would skip
      // the sync to rebuild first — that path has its own dedicated tests).
      const device = dm.getDevices()[0];
      device.segmentCount = 2;

      let segmentUpdates: MqttSegmentData[] | null = null;
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.onMqttSegmentUpdate = (_dev, segs) => {
        segmentUpdates = segs;
      };

      // Build an AA A5 packet
      const bytes = new Uint8Array(20);
      bytes[0] = 0xaa;
      bytes[1] = 0xa5;
      bytes[2] = 1;
      bytes[3] = 100;
      bytes[4] = 255;
      bytes[5] = 0;
      bytes[6] = 0; // seg 0
      bytes[7] = 50;
      bytes[8] = 0;
      bytes[9] = 255;
      bytes[10] = 0; // seg 1
      let xor = 0;
      for (let i = 0; i < 19; i++) {
        xor ^= bytes[i];
      }
      bytes[19] = xor;
      const pkt = Buffer.from(bytes).toString("base64");

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        state: { onOff: 1 },
        op: { command: [pkt] },
      });

      expect(segmentUpdates).not.toBeNull();
      // Trailing zero slots (slots 2-3) are trimmed as packet padding.
      expect(segmentUpdates).toHaveLength(2);
      expect(segmentUpdates![0]).toEqual({ index: 0, brightness: 100, r: 255, g: 0, b: 0 });
      expect(segmentUpdates![1]).toEqual({ index: 1, brightness: 50, r: 0, g: 255, b: 0 });
    });

    it("should discover segmentCount and call onSegmentCountChanged on first AA A5", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
      dm.handleLanDiscovery(lanDevice);
      // Device starts with segmentCount undefined — LAN-only, no Cloud data yet

      let grownDevice: GoveeDevice | null = null;
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.onSegmentCountChanged = d => {
        grownDevice = d;
      };
      dm.onMqttSegmentUpdate = () => {
        /* we're testing the bump path */
      };

      // Single AA A5 packet with 2 visible segments
      const bytes = new Uint8Array(20);
      bytes[0] = 0xaa;
      bytes[1] = 0xa5;
      bytes[2] = 1;
      bytes[3] = 100;
      bytes[4] = 255;
      bytes[5] = 0;
      bytes[6] = 0; // seg 0
      bytes[7] = 50;
      bytes[8] = 0;
      bytes[9] = 255;
      bytes[10] = 0; // seg 1
      let xor = 0;
      for (let i = 0; i < 19; i++) {
        xor ^= bytes[i];
      }
      bytes[19] = xor;
      const pkt = Buffer.from(bytes).toString("base64");

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        op: { command: [pkt] },
      });

      expect(grownDevice).not.toBeNull();
      expect(dm.getDevices()[0].segmentCount).toBe(2);
    });

    it("should grow segmentCount when MQTT reports more than Cloud said", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H61BE" };
      dm.handleLanDiscovery(lanDevice);
      const device = dm.getDevices()[0];
      // Cloud says 15, simulate that starting state
      device.segmentCount = 15;

      let grownDevice: GoveeDevice | null = null;
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.onSegmentCountChanged = d => {
        grownDevice = d;
      };

      // Build 5 AA A5 packets = 20 segments total
      const packets: string[] = [];
      for (let p = 1; p <= 5; p++) {
        const b = new Uint8Array(20);
        b[0] = 0xaa;
        b[1] = 0xa5;
        b[2] = p;
        for (let slot = 0; slot < 4; slot++) {
          b[3 + slot * 4] = 50; // brightness
          b[3 + slot * 4 + 1] = 255; // r
        }
        let xor = 0;
        for (let i = 0; i < 19; i++) {
          xor ^= b[i];
        }
        b[19] = xor;
        packets.push(Buffer.from(b).toString("base64"));
      }

      dm.handleMqttStatus({
        sku: "H61BE",
        device: "AABBCCDDEEFF0011",
        op: { command: packets },
      });

      expect(grownDevice).not.toBeNull();
      expect(dm.getDevices()[0].segmentCount).toBe(20);
    });

    it("shrinks segmentCount when a COMPLETE push proves Cloud over-reported (H6076 15→7)", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6076" };
      dm.handleLanDiscovery(lanDevice);
      dm.getDevices()[0].segmentCount = 15; // Cloud's lie for the H6076
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      let changed: GoveeDevice | null = null;
      dm.onSegmentCountChanged = d => {
        changed = d;
      };
      dm.onMqttSegmentUpdate = () => {};

      // 7 real segments (4 + 3) + a padding slot with brightness 146 > 100.
      const real: [number, number, number, number] = [100, 255, 206, 146];
      const pkt1 = buildAaA5Packet(1, [real, real, real, real]);
      const pkt2 = buildAaA5Packet(2, [real, real, real, [146, 100, 100, 100]]);

      dm.handleMqttStatus({ sku: "H6076", device: "AABBCCDDEEFF0011", op: { command: [pkt1, pkt2] } });

      expect(changed).not.toBeNull();
      expect(dm.getDevices()[0].segmentCount).toBe(7);
    });

    it("does NOT shrink on an incomplete push — a 20-slot cap can't prove a 30-strip is only 20", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H61BE" };
      dm.handleLanDiscovery(lanDevice);
      dm.getDevices()[0].segmentCount = 30; // a genuine 30-segment strip
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      let changed: GoveeDevice | null = null;
      dm.onSegmentCountChanged = d => {
        changed = d;
      };
      dm.onMqttSegmentUpdate = () => {};

      // 5 full packets = 20 valid slots, NO padding → complete=false → grow-only.
      const packets = [1, 2, 3, 4, 5].map(p =>
        buildAaA5Packet(p, [
          [50, 255, 0, 0],
          [50, 255, 0, 0],
          [50, 255, 0, 0],
          [50, 255, 0, 0],
        ]),
      );

      dm.handleMqttStatus({ sku: "H61BE", device: "AABBCCDDEEFF0011", op: { command: packets } });

      expect(changed).toBeNull(); // must NOT rebuild — segments 20-29 would be deleted
      expect(dm.getDevices()[0].segmentCount).toBe(30);
    });

    it("a segmentCount quirk locks the count — even a complete packet can't change it", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H9999" };
      dm.handleLanDiscovery(lanDevice);
      dm.getDevices()[0].segmentCount = 5; // the quirk-locked value
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      let changed: GoveeDevice | null = null;
      dm.onSegmentCountChanged = d => {
        changed = d;
      };
      dm.onMqttSegmentUpdate = () => {};

      // A complete push reporting 7 real segments — would normally grow 5→7,
      // but the segmentCount quirk is a hard override and must win.
      const real: [number, number, number, number] = [100, 255, 206, 146];
      const pkt1 = buildAaA5Packet(1, [real, real, real, real]);
      const pkt2 = buildAaA5Packet(2, [real, real, real, [146, 100, 100, 100]]);

      dm.handleMqttStatus({ sku: "H9999", device: "AABBCCDDEEFF0011", op: { command: [pkt1, pkt2] } });

      expect(changed).toBeNull(); // quirk-locked — no rebuild
      expect(dm.getDevices()[0].segmentCount).toBe(5);
    });

    it("resolveSegmentCount: a segmentCount quirk hard-overrides a cached value", () => {
      expect(resolveSegmentCount({ sku: "H9999", segmentCount: 15 } as GoveeDevice)).toBe(5);
    });

    it("resolveSegmentCount: without a quirk, falls back to the cached value", () => {
      expect(resolveSegmentCount({ sku: "H61BE", segmentCount: 12 } as GoveeDevice)).toBe(12);
    });

    it("resolveSegmentCount: a learned/lowered count wins over Cloud caps (no shrink→rebuild flip-flop)", () => {
      // After a downward correction device.segmentCount=7 while the Cloud caps
      // still advertise 15. The rebuild (state-manager) consumes resolveSegmentCount,
      // which must return 7 — not re-derive 15 — else every status packet would
      // shrink-then-rebuild-to-15 forever, churning the state tree.
      const device = {
        sku: "H61BE",
        segmentCount: 7,
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedBrightness",
            parameters: { fields: [{ fieldName: "segment", elementRange: { min: 0, max: 14 } }] },
          },
        ],
      } as unknown as GoveeDevice;
      expect(resolveSegmentCount(device)).toBe(7);
    });

    it("should not call onMqttSegmentUpdate when no AA A5 packets in command", () => {
      const lanDevice: LanDevice = { ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6160" };
      dm.handleLanDiscovery(lanDevice);
      const device = dm.getDevices()[0];
      device.segmentCount = 15;

      let called = false;
      dm.setCallbacks({
        onUpdate: () => {},
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm.onMqttSegmentUpdate = () => {
        called = true;
      };

      // AA 05 mode packet (not AA A5)
      const bytes = new Uint8Array(20);
      bytes[0] = 0xaa;
      bytes[1] = 0x05;
      bytes[2] = 0x15;
      const pkt = Buffer.from(bytes).toString("base64");

      dm.handleMqttStatus({
        sku: "H6160",
        device: "AABBCCDDEEFF0011",
        op: { command: [pkt] },
      });

      expect(called).toBe(false);
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

  function deviceWith(caps: CloudCapability[], segmentCount?: number): GoveeDevice {
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
    expect(resolveSegmentCount(device)).toBe(20);
  });

  it("ignores a Cloud capability advertising more slots than the protocol has (API boundary)", () => {
    // A lying capability is a malformed field, not a bigger strip.
    expect(resolveSegmentCount(deviceWith([segCap("segmentedColorRgb", 4999), segCap("segmentedBrightness", 9)]))).toBe(
      10,
    );
    expect(resolveSegmentCount(deviceWith([segCap("segmentedColorRgb", 4999)]))).toBe(0);
  });

  it("ignores an implausible stored count (corrupt cache) and falls back to the capabilities", () => {
    const device = deviceWith([segCap("segmentedColorRgb", 14)], 1_000_000_000);
    expect(resolveSegmentCount(device)).toBe(15);
  });

  it("plausibleSegmentCount accepts 1..56 and rejects everything else", () => {
    expect(plausibleSegmentCount(1)).toBe(1);
    expect(plausibleSegmentCount(56)).toBe(56);
    for (const bad of [0, -1, 57, 1_000_000_000, 2.5, NaN, Infinity, "5", null, undefined]) {
      expect(plausibleSegmentCount(bad)).toBeUndefined();
    }
  });

  it("returns 0 when no segment capability and no learned count", () => {
    const device = deviceWith([]);
    expect(resolveSegmentCount(device)).toBe(0);
  });

  it("uses min of positive capability counts (H70D1: brightness=10, colorRgb=15 → 10)", () => {
    // This is the Icicle-lights case — one cap honest, other inflated.
    const device = deviceWith([
      segCap("segmentedBrightness", 9), // 10 segments
      segCap("segmentedColorRgb", 14), // 15 segments (lie)
    ]);
    expect(resolveSegmentCount(device)).toBe(10);
  });

  it("ignores caps without positive count", () => {
    const device = deviceWith([
      segCap("segmentedBrightness", -1), // 0 segments
      segCap("segmentedColorRgb", 14), // 15 segments
    ]);
    expect(resolveSegmentCount(device)).toBe(15);
  });

  it("defensive: handles non-array capabilities", () => {
    const device = {
      ...deviceWith([]),
      capabilities: null as unknown as CloudCapability[],
    };
    expect(resolveSegmentCount(device)).toBe(0);
  });

  it("defensive: handles cap without parameters", () => {
    const device = deviceWith([
      {
        type: "devices.capabilities.segment_color_setting",
        instance: "x",
      },
    ]);
    expect(resolveSegmentCount(device)).toBe(0);
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
      },
    ]);
    expect(resolveSegmentCount(device)).toBe(0);
  });
});

describe("DeviceManager — loadFromCache merge", () => {
  // Same registry setup as the outer DeviceManager block — without it,
  // getDeviceTier() returns "unknown" for every SKU and the v2.1.0
  // tier-based unknown-SKU warning fires on every LAN-discovered device,
  // breaking the warn-counter assertions in the pollAppApi suite.
  beforeEach(() => {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
  });
  afterEach(() => {
    registry = emptyRegistry();
  });

  /**
   * Regression test for v1.7.6 bug: when a device is already present in
   * the device-map via LAN discovery (the normal case on every adapter
   * start, because LAN scan runs before cache load), the existing-branch
   * merge dropped segmentCount, manualMode and manualSegments. Every
   * restart threw away the wizard/MQTT-learned segment state and fell
   * back to Cloud's min-advertised count.
   *
   * @param entries Cached device entries the mock hands back from loadAll()
   */
  function makeMockSkuCache(entries: Array<Record<string, unknown>>): {
    loadAll: () => never;
    save: () => void;
    pruneStale: () => number;
    clear: () => void;
  } {
    return {
      loadAll: () => entries as never,
      save: () => {},
      pruneStale: () => 0,
      clear: () => {},
    };
  }

  it("merges segmentCount + manualMode + manualSegments into existing LAN-discovered device", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    // Simulate LAN discovery — device gets created without segment data.
    dm.handleLanDiscovery({
      sku: "H61BE",
      device: "AA:BB:CC:DD:EE:FF:12:34",
      ip: "192.168.1.50",
    });

    const cached = [
      {
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
      },
    ];
    dm.setSkuCache(makeMockSkuCache(cached) as never);

    dm.loadFromCache();

    const [device] = dm.getDevices();
    expect(device.sku).toBe("H61BE");
    expect(device.segmentCount).toBe(22);
    expect(device.manualMode).toBe(true);
    expect(device.manualSegments).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("never restores a SameModeGroup pseudo-device from an older cache", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const cached = [
      {
        sku: "SameModeGroup",
        deviceId: "9100",
        name: "Living Room Same Mode",
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
      },
      {
        sku: "H6102",
        deviceId: "00:11:22:33:44:55:66:88",
        name: "Real Light",
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
      },
    ];
    dm.setSkuCache(makeMockSkuCache(cached) as never);

    dm.loadFromCache();

    const skus = dm.getDevices().map(d => d.sku);
    expect(skus).toContain("H6102");
    expect(skus).not.toContain("SameModeGroup");
  });

  it("leaves merged fields undefined when cache entry has none (no segment data ever captured)", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    dm.handleLanDiscovery({
      sku: "H6102",
      device: "00:11:22:33:44:55:66:77",
      ip: "192.168.1.51",
    });

    const cached = [
      {
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
      },
    ];
    dm.setSkuCache(makeMockSkuCache(cached) as never);

    dm.loadFromCache();

    const [device] = dm.getDevices();
    expect(device.segmentCount).toBe(undefined);
    expect(device.manualMode).toBe(undefined);
    expect(device.manualSegments).toBe(undefined);
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
      expect(caps).toHaveLength(4);
      expect(caps[0]).toEqual({
        type: "devices.capabilities.online",
        instance: "online",
        state: { value: true },
      });
      expect(caps[1]).toEqual({
        type: "devices.capabilities.property",
        instance: "sensorTemperature",
        state: { value: 23.7 },
      });
      expect(caps[2]).toEqual({
        type: "devices.capabilities.property",
        instance: "sensorHumidity",
        state: { value: 42.9 },
      });
      expect(caps[3]).toEqual({
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
      expect(buildCapabilitiesFromAppEntry(entry)).toEqual([]);
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
      expect(caps).toHaveLength(1);
      expect(caps[0].state?.value).toBe(50);
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
      const battery = caps.find(c => c.instance === "battery");
      expect(battery?.state?.value).toBe(75);
    });

    it("ignores non-finite tem/hum values defensively", () => {
      const entry: AppDeviceEntry = {
        sku: "H5179",
        device: "AA:BB:CC:DD:EE:FF",
        deviceName: "x",
        lastData: { tem: NaN, hum: Infinity, online: false },
      };
      const caps = buildCapabilitiesFromAppEntry(entry);
      expect(caps).toHaveLength(1);
      expect(caps[0].instance).toBe("online");
    });

    it("derives online=true from fresh readings even when Govee reports online:false (ISSUE-2 / H5109)", () => {
      const now = 1_800_000_000_000;
      const entry: AppDeviceEntry = {
        sku: "H5109",
        device: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        deviceName: "Pool",
        // Govee's gateway sensors report online:false while readings keep flowing.
        lastData: { online: false, tem: 3197, lastTime: now - 5 * 60 * 1000 },
        settings: { uploadRate: 10 }, // 10-min upload → 30-min freshness window
      };
      const caps = buildCapabilitiesFromAppEntry(entry, now);
      const onlineCap = caps.find(c => c.instance === "online");
      expect(onlineCap?.state?.value).toBe(true);
    });

    it("keeps online=false when the last reading is stale (past the freshness window)", () => {
      const now = 1_800_000_000_000;
      const entry: AppDeviceEntry = {
        sku: "H5109",
        device: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        deviceName: "Pool",
        lastData: { online: false, tem: 3197, lastTime: now - 60 * 60 * 1000 }, // 60 min ago
        settings: { uploadRate: 10 },
      };
      const caps = buildCapabilitiesFromAppEntry(entry, now);
      const onlineCap = caps.find(c => c.instance === "online");
      expect(onlineCap?.state?.value).toBe(false);
    });

    it("does not fabricate online-ness without a reading timestamp", () => {
      const now = 1_800_000_000_000;
      const entry: AppDeviceEntry = {
        sku: "H5109",
        device: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        deviceName: "Pool",
        lastData: { online: false, tem: 3197 }, // no lastTime
        settings: { uploadRate: 10 },
      };
      const caps = buildCapabilitiesFromAppEntry(entry, now);
      const onlineCap = caps.find(c => c.instance === "online");
      expect(onlineCap?.state?.value).toBe(false);
    });

    it("suppresses a phantom humidity cap for a temp-only sensor (hum:0, no humidity capability) — #31", () => {
      const entry: AppDeviceEntry = {
        sku: "H5109",
        device: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        deviceName: "Pool",
        lastData: { tem: 3197, hum: 0, battery: 100 }, // hum:0 = Govee's "no humidity sensor" sentinel
      };
      const caps = buildCapabilitiesFromAppEntry(entry, 1_800_000_000_000, /* hasHumidityCapability */ false);
      expect(caps.find(c => c.instance === "sensorHumidity")).toBeUndefined();
      // temperature + battery must still come through
      expect(caps.find(c => c.instance === "sensorTemperature")).toBeDefined();
      expect(caps.find(c => c.instance === "battery")).toBeDefined();
    });

    it("keeps humidity for a real hygrometer even at a transient 0 reading (has humidity capability)", () => {
      const entry: AppDeviceEntry = {
        sku: "H5179",
        device: "AA:BB:CC:DD:EE:FF",
        deviceName: "x",
        lastData: { tem: 2000, hum: 0 },
      };
      const caps = buildCapabilitiesFromAppEntry(entry, 1_800_000_000_000, /* hasHumidityCapability */ true);
      expect(caps.find(c => c.instance === "sensorHumidity")?.state?.value).toBe(0);
    });

    it("keeps a non-zero humidity reading even without a declared capability (defensive)", () => {
      const entry: AppDeviceEntry = {
        sku: "H5179",
        device: "AA:BB:CC:DD:EE:FF",
        deviceName: "x",
        lastData: { hum: 4500 }, // 45 %
      };
      const caps = buildCapabilitiesFromAppEntry(entry, 1_800_000_000_000, false);
      expect(caps.find(c => c.instance === "sensorHumidity")?.state?.value).toBe(45);
    });
  });

  describe("pollAppApi", () => {
    function makeApiMock(opts: { hasBearer?: boolean; entries?: AppDeviceEntry[]; throws?: boolean }): unknown {
      return {
        hasBearerToken: () => opts.hasBearer ?? true,
        fetchDeviceList: () => {
          if (opts.throws) {
            return Promise.reject(new Error("App API down"));
          }
          return Promise.resolve(opts.entries ?? []);
        },
      };
    }

    it("returns 0 without an api client", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      expect(await dm2.pollAppApi()).toBe(0);
    });

    it("returns 0 when bearer token missing", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.setApiClient(makeApiMock({ hasBearer: false }) as never);
      expect(await dm2.pollAppApi()).toBe(0);
    });

    it("ignores app entries for unknown devices even when known devices exist (L24)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      // A KNOWN device so the registry isn't empty — the unknown entry must be
      // ignored on identity, not via an empty-registry early return.
      dm2.handleLanDiscovery({ ip: "192.168.1.50", device: "AABBCCDDEEFF0001", sku: "H5179" });
      dm2.getDevices()[0].type = "devices.types.thermometer"; // pollAppApi gates on non-light
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5179",
              device: "AA:BB:CC:DD:EE:FF", // different id → unknown
              deviceName: "Unknown",
              lastData: { tem: 2000 },
            },
          ],
        }) as never,
      );
      expect(await dm2.pollAppApi()).toBe(0); // unknown entry ignored despite a known device present
    });

    it("gateway is sticky — set when gatewayInfo is present, never cleared on a poll that omits it", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      const dev = createTestDevice({
        sku: "H5109",
        deviceId: "AABBCCDDEEFF0002",
        type: "devices.types.thermometer",
        lanIp: undefined,
      });
      (dm2 as any).devices.set((dm2 as any).deviceKey("H5109", "AABBCCDDEEFF0002"), dev);

      // Poll 1: Govee reports the gateway.
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5109",
              device: "AABBCCDDEEFF0002",
              deviceName: "Pool",
              lastData: { tem: 2341 },
              settings: { gatewayInfo: { sku: "H5042", bleName: "ihoment_H5042_3795" } },
            },
          ],
        }) as never,
      );
      await dm2.pollAppApi();
      expect(dev.gateway).toBe("H5042 (ihoment_H5042_3795)");

      // Poll 2: a flaky/partial response omits gatewayInfo — the gateway must
      // NOT be cleared (set-only, so no create/delete churn on the object tree).
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5109",
              device: "AABBCCDDEEFF0002",
              deviceName: "Pool",
              lastData: { tem: 2350 },
              settings: { uploadRate: 10 },
            },
          ],
        }) as never,
      );
      await dm2.pollAppApi();
      expect(dev.gateway).toBe("H5042 (ihoment_H5042_3795)");
    });

    it("removes a sold sensor absent from the App-API account list after the debounce (reported H5179 bug)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      // A cache-restored, sold thermometer: no LAN, not in any account list.
      const sold = createTestDevice({
        sku: "H5179",
        deviceId: "SOLD0001",
        name: "Sold Thermo",
        type: "devices.types.thermometer",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: false },
      });
      (dm2 as any).devices.set((dm2 as any).deviceKey("H5179", "SOLD0001"), sold);
      dm2.accountReconcileEnabled = true;
      // App-API returns a DIFFERENT still-owned sensor → list non-empty (ok=true),
      // the sold sensor is absent → reconcilable via the App-API authority.
      dm2.setApiClient(
        makeApiMock({
          entries: [{ sku: "H5075", device: "OWNED0001", deviceName: "Kept", lastData: { online: true, tem: 2100 } }],
        }) as never,
      );

      await dm2.pollAppApi(); // pass 1 → miss 1, kept
      expect(dm2.getDevices().map(d => d.deviceId)).toContain("SOLD0001");
      expect(sold.accountMissCount).toBe(1);

      await dm2.pollAppApi(); // pass 2 → miss 2 → evicted
      expect(dm2.getDevices().map(d => d.deviceId)).not.toContain("SOLD0001");
    });

    it("forwards synthetic caps for known devices via onCloudCapabilities", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({
        ip: "192.168.1.50",
        device: "AABBCCDDEEFF0001",
        sku: "H5179",
      });
      // pollAppApi gates on a non-light device type — flip the type
      // since LAN-discovery defaults to "devices.types.light".
      const devices = dm2.getDevices();
      devices[0].type = "devices.types.thermometer";
      const seen: Array<{ device: GoveeDevice; caps: unknown[] }> = [];
      dm2.setOnCloudCapabilities((device, caps) => {
        seen.push({ device, caps });
      });
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5179",
              device: "AABBCCDDEEFF0001",
              deviceName: "Wohnzimmer",
              lastData: { online: true, tem: 2150, hum: 4500 },
            },
          ],
        }) as never,
      );
      expect(await dm2.pollAppApi()).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0].caps).toHaveLength(3);
    });

    it("flips a sensor to info.online via data-freshness even when Govee reports offline (ISSUE-2)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.51", device: "AABBCCDDEEFF1109", sku: "H5109" });
      const dev = dm2.getDevices()[0];
      dev.type = "devices.types.thermometer";
      dev.state.online = false; // currently flagged offline (the bug)
      const updates: Array<Partial<DeviceState>> = [];
      dm2.setCallbacks({
        onUpdate: (_d, patch) => updates.push(patch),
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5109",
              device: "AABBCCDDEEFF1109",
              deviceName: "Pool",
              lastData: { online: false, tem: 3197, lastTime: Date.now() - 5 * 60 * 1000 },
              settings: { uploadRate: 10 },
            },
          ],
        }) as never,
      );
      expect(await dm2.pollAppApi()).toBe(1);
      expect(dev.state.online).toBe(true); // final info.online through applyOnlineCap
      expect(updates.some(u => u.online === true)).toBe(true); // propagated to main → info.online
    });

    it("keeps a sensor offline when its last reading is stale (ISSUE-2 negative)", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.52", device: "AABBCCDDEEFF110A", sku: "H5109" });
      const dev = dm2.getDevices()[0];
      dev.type = "devices.types.thermometer";
      dev.state.online = true; // currently online
      dm2.setApiClient(
        makeApiMock({
          entries: [
            {
              sku: "H5109",
              device: "AABBCCDDEEFF110A",
              deviceName: "Pool",
              lastData: { online: false, tem: 3197, lastTime: Date.now() - 60 * 60 * 1000 },
              settings: { uploadRate: 10 },
            },
          ],
        }) as never,
      );
      expect(await dm2.pollAppApi()).toBe(1);
      expect(dev.state.online).toBe(false); // stale readings → genuinely offline
    });

    it("returns 0 on fetch error and does not throw", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      // device must need App-API for fetch to be attempted
      dm2.handleLanDiscovery({ ip: "192.168.1.99", device: "AABBCCDDEEFF0099", sku: "H5179" });
      dm2.getDevices()[0].type = "devices.types.thermometer";
      dm2.setApiClient(makeApiMock({ throws: true }) as never);
      expect(await dm2.pollAppApi()).toBe(0);
    });

    it("logs success-after-failure as warn again instead of debug-deduping it", async () => {
      const warnings: string[] = [];
      const trackingLog = {
        ...mockLog,
        warn: (msg: string) => warnings.push(msg),
      };
      const dm2 = new DeviceManager(trackingLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.97", device: "AABBCCDDEEFF0097", sku: "H5179" });
      dm2.getDevices()[0].type = "devices.types.thermometer";

      // Failing client (raises NETWORK each call)
      let fail = true;
      const failingClient = {
        hasBearerToken: () => true,
        fetchDeviceList: () => {
          if (fail) {
            return Promise.reject(new Error("ECONNRESET"));
          }
          return Promise.resolve([]);
        },
      };
      dm2.setApiClient(failingClient as never);

      await dm2.pollAppApi();
      expect(warnings, "first failure warns").toHaveLength(1);
      await dm2.pollAppApi();
      expect(warnings, "repeated same-category failure stays at debug").toHaveLength(1);

      // Success in between resets the dedup slot.
      fail = false;
      await dm2.pollAppApi();
      fail = true;
      await dm2.pollAppApi();
      expect(warnings, "failure after success warns again").toHaveLength(2);
    });
  });

  describe("handleOpenApiEvent", () => {
    it("ignores events for unknown devices", () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      let called = 0;
      dm2.setOnCloudCapabilities(() => {
        called++;
      });
      dm2.handleOpenApiEvent({
        sku: "H5179",
        device: "ZZ:ZZ:ZZ:ZZ:ZZ:ZZ",
        capabilities: [{ type: "x", instance: "y", state: { value: 1 } }],
      });
      expect(called).toBe(0);
    });

    it("forwards caps to onCloudCapabilities for known devices", () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({
        ip: "192.168.1.51",
        device: "AABBCCDDEEFF0002",
        sku: "H5179",
      });
      const seen: unknown[][] = [];
      dm2.setOnCloudCapabilities((_, caps) => seen.push(caps));
      dm2.handleOpenApiEvent({
        sku: "H5179",
        device: "AABBCCDDEEFF0002",
        capabilities: [{ type: "devices.capabilities.event", instance: "lackWaterEvent", state: { value: true } }],
      });
      expect(seen).toHaveLength(1);
      expect((seen[0] as Array<{ instance: string }>)[0].instance).toBe("lackWaterEvent");
    });

    it("ignores malformed input defensively", () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      let called = 0;
      dm2.setOnCloudCapabilities(() => {
        called++;
      });
      // Empty, missing fields, non-array caps, empty caps
      dm2.handleOpenApiEvent({} as never);
      dm2.handleOpenApiEvent({ sku: 1 as never, device: "x", capabilities: [] });
      dm2.handleOpenApiEvent({ sku: "H5179", device: "x", capabilities: null as never });
      dm2.handleOpenApiEvent({ sku: "H5179", device: "x", capabilities: [] });
      expect(called).toBe(0);
    });
  });

  describe("applyOnlineCap (Pkt 12 — info.online for App-API + OpenAPI-MQTT)", () => {
    it("flips device.state.online when App-API delivers online:true", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.81", device: "AABBCCDDEEFF0081", sku: "H5179" });
      const dev = dm2.getDevices()[0];
      dev.type = "devices.types.thermometer";
      dev.state.online = false;

      const updates: Array<Partial<DeviceState>> = [];
      dm2.setCallbacks({
        onUpdate: (_, s) => updates.push(s),
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      const apiClient = {
        hasBearerToken: () => true,
        fetchDeviceList: () =>
          Promise.resolve([
            {
              sku: "H5179",
              device: "AABBCCDDEEFF0081",
              lastData: { online: true, tem: 2150, hum: 4500 },
            },
          ]),
      };
      dm2.setApiClient(apiClient as never);
      await dm2.pollAppApi();

      expect(dev.state.online).toBe(true);
      expect(
        updates.some(u => u.online === true),
        "onDeviceUpdate fires for online flip",
      ).toBe(true);
    });

    it("flips device.state.online when App-API delivers online:false", async () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.82", device: "AABBCCDDEEFF0082", sku: "H5179" });
      const dev = dm2.getDevices()[0];
      dev.type = "devices.types.thermometer";
      dev.state.online = true;

      const updates: Array<Partial<DeviceState>> = [];
      dm2.setCallbacks({
        onUpdate: (_, s) => updates.push(s),
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      const apiClient = {
        hasBearerToken: () => true,
        fetchDeviceList: () =>
          Promise.resolve([
            {
              sku: "H5179",
              device: "AABBCCDDEEFF0082",
              lastData: { online: false, tem: 2150 },
            },
          ]),
      };
      dm2.setApiClient(apiClient as never);
      await dm2.pollAppApi();

      expect(dev.state.online).toBe(false);
      expect(
        updates.some(u => u.online === false),
        "onDeviceUpdate fires for offline flip",
      ).toBe(true);
    });

    it("OpenAPI-MQTT events drive info.online via applyOnlineCap", () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.83", device: "AABBCCDDEEFF0083", sku: "H5179" });
      const dev = dm2.getDevices()[0];
      // H5179 is a thermometer — LAN-Discovery defaults type to Light because
      // Cloud-data hasn't arrived yet. In the real flow mergeCloudDevices
      // updates the type before pollAppApi/handleOpenApiEvent fire. Simulate
      // that here so applyOnlineCap actually runs (it's gated to non-Lights).
      dev.type = "devices.types.thermometer";
      dev.state.online = false;

      const updates: Array<Partial<DeviceState>> = [];
      dm2.setCallbacks({
        onUpdate: (_, s) => updates.push(s),
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm2.handleOpenApiEvent({
        sku: "H5179",
        device: "AABBCCDDEEFF0083",
        capabilities: [
          { type: "devices.capabilities.online", instance: "online", state: { value: true } },
          { type: "devices.capabilities.event", instance: "lackWaterEvent", state: { value: true } },
        ],
      });

      expect(dev.state.online).toBe(true);
      expect(
        updates.some(u => u.online === true),
        "onDeviceUpdate fires for OpenAPI-MQTT online",
      ).toBe(true);
    });

    it("treats data-without-online-flag as online (matches LAN/MQTT convention)", () => {
      const dm2 = new DeviceManager(mockLog, mockTimers, registry);
      dm2.handleLanDiscovery({ ip: "192.168.1.84", device: "AABBCCDDEEFF0084", sku: "H5179" });
      const dev = dm2.getDevices()[0];
      // Same as above — set non-Light type so applyOnlineCap is not skipped.
      dev.type = "devices.types.thermometer";
      dev.state.online = false;

      const updates: Array<Partial<DeviceState>> = [];
      dm2.setCallbacks({
        onUpdate: (_, s) => updates.push(s),
        onLanDeviceReady: () => {},
        onCloudDataReady: () => {},
        onGroupMembersReady: () => {},
      });

      dm2.handleOpenApiEvent({
        sku: "H5179",
        device: "AABBCCDDEEFF0084",
        // No `online` cap — just a sensor reading. LAN/MQTT treat
        // "fresh data arrived" as implicit online; do the same here.
        capabilities: [
          { type: "devices.capabilities.property", instance: "sensorTemperature", state: { value: 21.5 } },
        ],
      });

      expect(dev.state.online).toBe(true);
      expect(updates.some(u => u.online === true)).toBe(true);
    });
  });
});

/**
 * Issue #13 (tukey42): snapshots created in the Govee Home app were stuck on
 * the cached value because `loadDeviceScenes` gated the /user/devices
 * capability fallback on `device.snapshots.length === 0`. After a cache load
 * that condition was never true again. v2.7.0 reorders the snapshot path so
 * /user/devices capabilities are the authoritative source whenever
 * /device/scenes comes back empty.
 */
describe("DeviceManager — loadDeviceScenes snapshot resolution (Issue #13)", () => {
  let dm: DeviceManager;
  beforeEach(() => {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
    dm = new DeviceManager(mockLog, mockTimers, registry);
  });
  afterEach(() => {
    registry = emptyRegistry();
  });

  function snapCap(options: Array<{ name: string; value: number }>): CloudCapability {
    return {
      type: "devices.capabilities.dynamic_scene",
      instance: "snapshot",
      parameters: { dataType: "ENUM", options },
    };
  }

  // The loadDeviceScenes/loadDeviceLibraries behaviour tests moved to
  // device-manager/library-loader.test.ts with the M12 extraction.
  it("refreshSceneDataForDevice refetches /user/devices before re-running loadDeviceScenes", async () => {
    // Fix B: without this call, the manual refresh used stale capabilities
    // from the in-memory device — meaning the snapshot fallback in
    // loadDeviceScenes couldn't see new entries from the Govee app.
    const device = createTestDevice({
      snapshots: [{ name: "OldSnap", value: 100 }],
    });
    (dm as any).devices.set("H6160_aabbccddeeff0011", device);

    let getDevicesCallCount = 0;
    let getScenesCallCount = 0;
    const mockCloud = {
      getDevices: () => {
        getDevicesCallCount++;
        // Simulate /user/devices delivering an updated capability list with
        // the new snapshot the user just created.
        return Promise.resolve([
          {
            sku: "H6160",
            device: "AABBCCDDEEFF0011",
            deviceName: "Test Light",
            type: "devices.types.light",
            capabilities: [
              ...lightCapabilities(),
              snapCap([
                { name: "OldSnap", value: 100 },
                { name: "NewSnap", value: 200 },
              ]),
            ],
          },
        ]);
      },
      getScenes: () => {
        getScenesCallCount++;
        return Promise.resolve({ lightScenes: [], diyScenes: [], snapshots: [] });
      },
      getDiyScenes: () => Promise.resolve([]),
    };
    dm.setCloudClient(mockCloud as any);

    const changed = await dm.refreshSceneDataForDevice("AABBCCDDEEFF0011");

    expect(getDevicesCallCount, "getDevices must be called by refreshSceneDataForDevice").toBe(1);
    expect(getScenesCallCount, "getScenes must be called after device-list refresh").toBe(1);
    expect(device.snapshots.map(s => s.name)).toEqual(["OldSnap", "NewSnap"]);
    expect(changed).toBe(true);
  });
});

describe("DeviceManager — internal logic helpers", () => {
  it("removeDevice deletes the device and returns its deviceId, or null if absent", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ sku: "H61BE", deviceId: "AA:BB:CC:DD" });
    const key = (dm as any).deviceKey("H61BE", "AA:BB:CC:DD");
    (dm as any).devices.set(key, device);
    expect(dm.removeDevice("H61BE", "AA:BB:CC:DD")).toBe("AA:BB:CC:DD");
    expect((dm as any).devices.has(key)).toBe(false);
    expect(dm.removeDevice("H61BE", "AA:BB:CC:DD")).toBeNull(); // already gone
  });

  it("getErrorCategorySnapshot mirrors the per-source error trackers", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    expect(dm.getErrorCategorySnapshot()).toEqual({ deviceManager: null, appApi: null, groupMembers: null });
    (dm as any).lastErrorCategory = "TIMEOUT";
    (dm as any).lastAppApiErrorCategory = "RATE_LIMIT";
    expect(dm.getErrorCategorySnapshot()).toEqual({
      deviceManager: "TIMEOUT",
      appApi: "RATE_LIMIT",
      groupMembers: null,
    });
  });
});

describe("DeviceManager — invariants without a test (mutation audit)", () => {
  beforeEach(() => {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
  });
  afterEach(() => {
    registry = emptyRegistry();
  });

  it("binds a LAN reply to a same-SKU device only when exactly one candidate exists", () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    // Two cloud-only devices of the same SKU: the discovery frame's deviceId
    // matches neither, so a SKU fallback would bind the wrong one.
    const a = createTestDevice({ sku: "H61BE", deviceId: "AAAA0001", name: "Strip A", lanIp: undefined });
    const b = createTestDevice({ sku: "H61BE", deviceId: "BBBB0002", name: "Strip B", lanIp: undefined });
    (dm2 as any).devices.set((dm2 as any).deviceKey("H61BE", "AAAA0001"), a);
    (dm2 as any).devices.set((dm2 as any).deviceKey("H61BE", "BBBB0002"), b);

    dm2.handleLanDiscovery({ ip: "192.168.1.50", device: "CC:CC:CC:CC:CC:CC:00:03", sku: "H61BE" });

    expect(a.lanIp).toBeUndefined();
    expect(b.lanIp).toBeUndefined();
    // Unmatched frame → a NEW device record, never a hijacked existing one.
    expect(dm2.getDevices()).toHaveLength(3);

    // With exactly one candidate the fallback is allowed to bind.
    const dm3 = new DeviceManager(mockLog, mockTimers, registry);
    const only = createTestDevice({ sku: "H61BE", deviceId: "AAAA0001", lanIp: undefined });
    (dm3 as any).devices.set((dm3 as any).deviceKey("H61BE", "AAAA0001"), only);
    dm3.handleLanDiscovery({ ip: "192.168.1.50", device: "CC:CC:CC:CC:CC:CC:00:03", sku: "H61BE" });
    expect(only.lanIp).toBe("192.168.1.50");
    expect(dm3.getDevices()).toHaveLength(1);
  });

  it("ignores Cloud entries without capabilities (stale/deleted registrations)", async () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    dm2.setCloudClient({
      getDevices: () =>
        Promise.resolve([
          {
            sku: "H5100",
            device: "REAL0001",
            deviceName: "Real Light",
            type: "devices.types.light",
            capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
          },
          // Govee /user/devices also returns historical registrations of devices
          // the user deleted — they carry an empty capability list.
          {
            sku: "H6160",
            device: "GHOST0001",
            deviceName: "Deleted Light",
            type: "devices.types.light",
            capabilities: [],
          },
          { sku: "H6160", device: "GHOST0002", deviceName: "No caps at all", type: "devices.types.light" },
        ]),
    } as never);

    await dm2.loadFromCloud();
    const ids = dm2.getDevices().map(d => d.deviceId);
    expect(ids).toEqual(["REAL0001"]);
  });

  it("an empty Cloud device list never counts as a valid account list", async () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const cloudOnly = createTestDevice({
      sku: "H61BE",
      deviceId: "DEADBEEF03",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
    });
    (dm2 as any).devices.set((dm2 as any).deviceKey("H61BE", "DEADBEEF03"), cloudOnly);
    dm2.accountReconcileEnabled = true;
    let pruneCalls = 0;
    dm2.setSkuCache({
      loadAll: () => [],
      save: () => {},
      pruneStale: () => {
        pruneCalls++;
        return 0;
      },
    } as never);
    // Govee answers HTTP 200 with an empty body on hiccups — treating that as
    // "your account is empty" would delete every device and prune the cache.
    dm2.setCloudClient({ getDevices: () => Promise.resolve([]) } as never);

    await dm2.loadFromCloud();
    await dm2.loadFromCloud();

    expect(dm2.getDevices().map(d => d.deviceId)).toContain("DEADBEEF03");
    expect(cloudOnly.accountMissCount ?? 0).toBe(0);
    expect(pruneCalls).toBe(0);
  });

  it("prunes the cache only after a plausible non-empty Cloud response", async () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    let pruneCalls = 0;
    dm2.setSkuCache({
      loadAll: () => [],
      save: () => {},
      pruneStale: () => {
        pruneCalls++;
        return 0;
      },
    } as never);
    dm2.setCloudClient({
      getDevices: () =>
        Promise.resolve([
          {
            sku: "H5100",
            device: "PRESENT0001",
            type: "devices.types.light",
            capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
          },
        ]),
    } as never);
    await dm2.loadFromCloud();
    expect(pruneCalls).toBe(1);
  });

  it("a Cloud online flag never overrides a LAN-capable light", () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const lanLight = createTestDevice({ sku: "H61BE", deviceId: "AABBCCDDEEFF0011", lanIp: "192.168.1.100" });
    lanLight.state.online = true;
    const cloudLight = createTestDevice({ sku: "H6056", deviceId: "CCDD00000001", lanIp: undefined });
    cloudLight.state.online = true;
    (dm2 as any).devices.set((dm2 as any).deviceKey("H61BE", "AABBCCDDEEFF0011"), lanLight);
    (dm2 as any).devices.set((dm2 as any).deviceKey("H6056", "CCDD00000001"), cloudLight);

    const offlineEvent = (sku: string, device: string): never =>
      ({
        sku,
        device,
        capabilities: [{ type: "devices.capabilities.online", instance: "online", state: { value: false } }],
      }) as never;

    // Govee's cloud cache lags real LAN reachability — a false "offline" must
    // not reach a light we can talk to directly.
    dm2.handleOpenApiEvent(offlineEvent("H61BE", "AABBCCDDEEFF0011"));
    expect(lanLight.state.online).toBe(true);

    // A cloud-only light has no other truth source, so it must follow.
    dm2.handleOpenApiEvent(offlineEvent("H6056", "CCDD00000001"));
    expect(cloudLight.state.online).toBe(false);
  });

  it("an unchanged online state fires no update (no group-reachability churn)", () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const sensor = createTestDevice({
      sku: "H5179",
      deviceId: "EEFF00000001",
      type: "devices.types.thermometer",
      lanIp: undefined,
    });
    sensor.state.online = true;
    (dm2 as any).devices.set((dm2 as any).deviceKey("H5179", "EEFF00000001"), sensor);
    const updates: unknown[] = [];
    dm2.onDeviceUpdate = (_d, s) => updates.push(s);

    const onlineEvent = {
      sku: "H5179",
      device: "EEFF00000001",
      capabilities: [{ type: "devices.capabilities.online", instance: "online", state: { value: true } }],
    } as never;
    dm2.handleOpenApiEvent(onlineEvent);
    expect(updates).toHaveLength(0);
    expect(sensor.lastSeenOnNetwork).toBeGreaterThan(0);

    // A real transition still reports.
    sensor.state.online = false;
    dm2.handleOpenApiEvent(onlineEvent);
    expect(updates).toEqual([{ online: true }]);
  });

  it("a repeated LAN discovery of an already-online device reports no transition", () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const updates: unknown[] = [];
    dm2.onDeviceUpdate = (_d, s) => updates.push(s);
    const frame = { ip: "192.168.1.100", device: "AA:BB:CC:DD:EE:FF:00:11", sku: "H61BE" };

    dm2.handleLanDiscovery(frame);
    const dev = dm2.getDevices()[0];
    dev.state.online = false;
    updates.length = 0;

    dm2.handleLanDiscovery(frame); // offline → online: one transition
    expect(updates).toEqual([{ online: true }]);

    updates.length = 0;
    dm2.handleLanDiscovery(frame); // already online: silent
    dm2.handleLanDiscovery(frame);
    expect(updates).toHaveLength(0);
  });

  it("a devStatus reply carries `online` only on a real offline→online flip", () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const dev = createTestDevice({ sku: "H61BE", deviceId: "AABBCCDDEEFF0011", lanIp: "192.168.1.100" });
    dev.state.online = false;
    (dm2 as any).devices.set((dm2 as any).deviceKey("H61BE", "AABBCCDDEEFF0011"), dev);
    const patches: Partial<DeviceState>[] = [];
    dm2.onDeviceUpdate = (_d, s) => patches.push(s);
    const reply = { onOff: 1, brightness: 50, color: { r: 255, g: 0, b: 0 }, colorTemInKelvin: 0 };

    dm2.handleLanStatus("192.168.1.100", reply);
    expect(patches).toHaveLength(1);
    expect(patches[0].online).toBe(true); // the flip is reported

    // Steady LAN: every further poll reply would otherwise carry online:true
    // and trigger a group-reachability pass + per-group write on each poll.
    dm2.handleLanStatus("192.168.1.100", reply);
    dm2.handleLanStatus("192.168.1.100", reply);
    expect(patches).toHaveLength(3);
    expect(patches[1].online).toBeUndefined();
    expect(patches[2].online).toBeUndefined();
  });

  it("skips the App-API poll entirely in a lights-only installation", async () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    (dm2 as any).devices.set(
      (dm2 as any).deviceKey("H61BE", "AABBCCDDEEFF0011"),
      createTestDevice({ sku: "H61BE", deviceId: "AABBCCDDEEFF0011" }),
    );
    let fetches = 0;
    dm2.setApiClient({
      hasBearerToken: () => true,
      fetchDeviceList: () => {
        fetches++;
        return Promise.resolve([]);
      },
    } as never);

    expect(await dm2.pollAppApi()).toBe(0);
    expect(fetches).toBe(0); // lights never need the App API — no request at all

    // One sensor is enough to arm the poll.
    (dm2 as any).devices.set(
      (dm2 as any).deviceKey("H5179", "EEFF00000001"),
      createTestDevice({ sku: "H5179", deviceId: "EEFF00000001", type: "devices.types.thermometer" }),
    );
    await dm2.pollAppApi();
    expect(fetches).toBe(1);
  });

  it("re-reports a gateway only when it actually changes", async () => {
    const dm2 = new DeviceManager(mockLog, mockTimers, registry);
    const dev = createTestDevice({
      sku: "H5109",
      deviceId: "AABBCCDDEEFF0002",
      type: "devices.types.thermometer",
      lanIp: undefined,
    });
    (dm2 as any).devices.set((dm2 as any).deviceKey("H5109", "AABBCCDDEEFF0002"), dev);
    const rebuilds: string[] = [];
    dm2.onCloudDataReady = d => rebuilds.push(d.deviceId);

    const entry = (bleName: string): unknown => ({
      sku: "H5109",
      device: "AABBCCDDEEFF0002",
      deviceName: "Pool",
      lastData: { tem: 2341 },
      settings: { gatewayInfo: { sku: "H5042", bleName } },
    });
    dm2.setApiClient({
      hasBearerToken: () => true,
      fetchDeviceList: () => Promise.resolve([entry("ihoment_H5042_3795")]),
    } as never);

    await dm2.pollAppApi();
    expect(rebuilds).toEqual(["AABBCCDDEEFF0002"]); // first sighting rebuilds
    await dm2.pollAppApi();
    await dm2.pollAppApi();
    expect(rebuilds).toHaveLength(1); // same gateway → no object-tree churn

    dm2.setApiClient({
      hasBearerToken: () => true,
      fetchDeviceList: () => Promise.resolve([entry("ihoment_H5042_9999")]),
    } as never);
    await dm2.pollAppApi();
    expect(rebuilds).toHaveLength(2); // moved to another gateway → rebuild
  });
});

describe("DeviceManager.syncSegmentCount — the one writer of device.segmentCount from the tree path", () => {
  beforeEach(() => {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental: true });
  });
  afterEach(() => {
    registry = emptyRegistry();
  });
  const segCap = (max: number): CloudCapability => ({
    type: "devices.capabilities.segment_color_setting",
    instance: "segmentedColorRgb",
    parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", elementRange: { min: 0, max } }] },
  });

  it("derives the count from the capabilities and stores it on the device", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ segmentCount: undefined, capabilities: [segCap(9)] });
    expect(dm.syncSegmentCount(device)).toBe(10);
    expect(device.segmentCount).toBe(10);
  });

  it("a manual list beyond the known range raises the stored count (cut-strip case)", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ segmentCount: 10, manualMode: true, manualSegments: [0, 5, 13] });
    expect(dm.syncSegmentCount(device)).toBe(14);
    expect(device.segmentCount).toBe(14);
  });

  it("an implausible stored count is replaced by the capability-derived one, never propagated", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ segmentCount: 1_000_000_000, capabilities: [segCap(14)] });
    expect(dm.syncSegmentCount(device)).toBe(15);
    expect(device.segmentCount).toBe(15);
  });

  it("a segmentCount quirk wins over everything the device or the Cloud say", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ sku: "H9999", segmentCount: 20, capabilities: [segCap(14)] });
    expect(dm.syncSegmentCount(device)).toBe(5);
    expect(device.segmentCount).toBe(5);
  });

  it("returns 0 and stores 0 for a device without segments", () => {
    const dm = new DeviceManager(mockLog, mockTimers, registry);
    const device = createTestDevice({ segmentCount: undefined, capabilities: [] });
    expect(dm.syncSegmentCount(device)).toBe(0);
    expect(device.segmentCount).toBe(0);
  });
});

describe("DeviceManager.maybeNudgeSeedSku — the experimental-toggle hint", () => {
  afterEach(() => {
    registry = emptyRegistry();
  });
  function nudgeDm(experimental: boolean): { dm: DeviceManager; warns: string[]; infos: string[] } {
    registry = new DeviceRegistry({ data: QUIRK_TEST_REGISTRY as never, experimental });
    const warns: string[] = [];
    const infos: string[] = [];
    const dm = new DeviceManager(
      { ...mockLog, warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) },
      mockTimers,
      registry,
    );
    return { dm, warns, infos };
  }

  it("a seed model with the toggle OFF gets the targeted warn ONCE per model", () => {
    const { dm, warns } = nudgeDm(false);
    dm.maybeNudgeSeedSku("H6141", "Strip");
    dm.maybeNudgeSeedSku("h6141", "Strip");
    expect(warns).toEqual([
      'Device Strip (H6141) is in beta and needs the "Enable experimental device support" toggle in adapter settings to apply known per-SKU corrections.',
    ]);
  });

  it("a seed model with the toggle ON is only mentioned on info", () => {
    const { dm, warns, infos } = nudgeDm(true);
    dm.maybeNudgeSeedSku("H6141", undefined);
    expect(warns).toEqual([]);
    expect(infos).toEqual(["Device H6141 is in beta — experimental quirks are active."]);
  });

  it("verified / reported models stay silent, an unknown model asks for a diag export", () => {
    const { dm, warns, infos } = nudgeDm(false);
    dm.maybeNudgeSeedSku("H61BE", "Wall");
    dm.maybeNudgeSeedSku("H5179", "Thermo");
    expect(warns).toEqual([]);
    expect(infos).toEqual([]);
    dm.maybeNudgeSeedSku("HZZZZ", "Mystery");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("not in the supported device list");
    expect(warns[0]).toContain("diag.export");
  });
});
