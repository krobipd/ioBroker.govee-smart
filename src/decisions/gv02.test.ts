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
import { DeviceRegistry } from "../lib/device-registry";
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
});
