// GV-02 — For a LAN light, everything that works locally comes locally. Only what only the cloud can do comes from the cloud.
// krobi 2026-10-06 17:47: "for a local colour we need no cloud. we get all the information locally." — 17:48: "except the
// things only the cloud can do"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import {
  applyCloudCapabilities,
  writeCloudStateValues,
  type CloudStateLoaderAdapter,
} from "../lib/handlers/cloud-state-loader";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import { onDeviceStateUpdate } from "../lib/handlers/device-events";
import { StateManager } from "../lib/state-manager";
import type { CloudStateCapability, GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

function lanLight(): GoveeDevice {
  return {
    sku: "H6172",
    deviceId: "AA:BB:CC:DD:EE:FF:00:02",
    name: "Desk",
    type: "devices.types.light",
    lanIp: "192.168.1.20",
    capabilities: [
      { type: "devices.capabilities.on_off", instance: "powerSwitch" },
      { type: "devices.capabilities.range", instance: "brightness" },
      { type: "devices.capabilities.color_setting", instance: "colorRgb" },
      { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
      { type: "devices.capabilities.toggle", instance: "gradientToggle" },
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
  };
}

/** Govee's answer for that light: the four local values plus one value only the cloud has. */
const answer: CloudStateCapability[] = [
  { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
  { type: "devices.capabilities.range", instance: "brightness", state: { value: 55 } },
  { type: "devices.capabilities.color_setting", instance: "colorRgb", state: { value: 0xff0000 } },
  { type: "devices.capabilities.color_setting", instance: "colorTemperatureK", state: { value: 4000 } },
  { type: "devices.capabilities.toggle", instance: "gradientToggle", state: { value: 1 } },
];

function rig(): { adapter: CloudStateLoaderAdapter; written: string[] } {
  const written: string[] = [];
  const record = (id: string): Promise<void> => {
    written.push(id);
    return Promise.resolve();
  };
  const adapter: CloudStateLoaderAdapter = {
    log,
    rateLimiter: null,
    deviceRegistry: new DeviceRegistry({ data: { devices: {} } }),
    cloudClient: null,
    deviceManager: null,
    stateManager: {
      devicePrefix: () => "devices.h6172-0002",
      resolveStatePath: (prefix: string, stateId: string) => `${prefix}.control.${stateId}`,
      ensureSyntheticStateObject: () => Promise.resolve(),
    } as never,
    setState: id => record(id),
    setStateChanged: id => record(id),
  };
  return { adapter, written };
}

const LOCAL = ["power", "brightness", "color_rgb", "color_temperature"].map(id => `devices.h6172-0002.control.${id}`);

describe("GV-02 a LAN light takes its local values only locally", () => {
  it("the cloud state read writes none of power, brightness, colour or colour temperature — but the cloud-only value", async () => {
    const { adapter, written } = rig();
    await writeCloudStateValues(adapter, lanLight(), answer, "set");
    expect(written).toContain("devices.h6172-0002.control.gradient_toggle");
    for (const id of LOCAL) {
      expect(written).not.toContain(id);
    }
  });

  it("a cloud event or App-API reading writes none of the four either — but the cloud-only value", async () => {
    const { adapter, written } = rig();
    await applyCloudCapabilities(adapter, lanLight(), answer);
    expect(written).toContain("devices.h6172-0002.control.gradient_toggle");
    for (const id of LOCAL) {
      expect(written).not.toContain(id);
    }
  });

  it("the same answer for a light without LAN writes the four (positive control)", async () => {
    const { adapter, written } = rig();
    const cloudOnly = { ...lanLight(), lanIp: undefined, channels: { lan: false, mqtt: false, cloud: true } };
    await writeCloudStateValues(adapter, cloudOnly, answer, "set");
    expect(written).toEqual(expect.arrayContaining(LOCAL));
  });

  it("the light's own LAN status answer delivers power, brightness, colour and colour temperature to the datapoints", async () => {
    const written = new Map<string, unknown>();
    const record = (id: string, state: { val: unknown }): Promise<void> => {
      written.set(id.replace("govee-smart.0.", ""), state.val);
      return Promise.resolve();
    };
    const timers = {
      setInterval: () => undefined,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
      setTimeout: () => undefined,
      delay: () => Promise.resolve(),
    } as never;
    const registry = new DeviceRegistry({ data: { devices: {} } });
    const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", lanLight());
    const host = {
      log,
      namespace: "govee-smart.0",
      config: {},
      statesReady: true,
      deviceManager: dm,
      cloudClient: null,
      cloudWasConnected: false,
      cloudOutage: { confirmed: false },
      mqttClient: null,
      openapiMqttClient: null,
      lanClient: { isListening: () => true },
      lastConnectionState: null,
      groupReachabilityPrimed: true,
      setState: record,
      setStateChangedAsync: record,
      getObjectViewAsync: () => Promise.resolve({ rows: [] }),
    };
    (host as { stateManager?: StateManager }).stateManager = new StateManager(host as never, registry);
    dm.setCallbacks({
      onUpdate: (dev, state, changes) => onDeviceStateUpdate(host as never, dev, state, changes),
      onLanDeviceReady: () => {},
      onCloudDataReady: () => {},
      onGroupMembersReady: () => {},
    });
    // An RGB answer delivers the colour, a colour-temperature answer the Kelvin — each answer names its colour mode, the
    // other colour datapoint gets no value in it (GV-32). Together they deliver all four datapoints locally.
    dm.handleLanStatus("192.168.1.20", {
      onOff: 1,
      brightness: 55,
      color: { r: 255, g: 0, b: 0 },
      colorTemInKelvin: 0,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Object.fromEntries(LOCAL.map(id => [id, written.get(id)]))).toEqual({
      "devices.h6172-0002.control.power": true,
      "devices.h6172-0002.control.brightness": 55,
      "devices.h6172-0002.control.color_rgb": "#ff0000",
      "devices.h6172-0002.control.color_temperature": null,
    });
    dm.handleLanStatus("192.168.1.20", {
      onOff: 1,
      brightness: 55,
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: 4000,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(written.get("devices.h6172-0002.control.color_temperature")).toBe(4000);
    expect(written.get("devices.h6172-0002.control.color_rgb")).toBeNull();
  });
});
