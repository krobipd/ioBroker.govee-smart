// GV-32 — Govee reports the colour mode with every colour report (Kelvin > 0 = colour temperature, 0 = RGB); govee-smart
// follows it. In colour-temperature mode color_temperature carries the value and color_rgb null, in RGB mode color_rgb the
// colour and color_temperature null. An RGB report that exactly matches an entry of Govee's colour-temperature table is a
// colour temperature, then both carry their value. Only a report carrying both fields decides, never silence.
// krobi 2026-10-20 02:00: "but isn't your analysis incomplete? what really speaks against it? isn't that rather
// consistent?" — 02:16 on the colour-mode plan: "perfect, then do it"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { withCloudColorMode } from "../lib/capability-mapper";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import type { CloudStateCapability, DeviceState, GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

const timers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  clearTimeout: () => undefined,
  setTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

/** The H6199 of issue #57: a light without a local interface, reporting over the account push. */
function cloudLight(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:23:5C",
    name: "TV",
    type: "devices.types.light",
    capabilities: [
      { type: "devices.capabilities.color_setting", instance: "colorRgb" },
      { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
    ],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: true, cloud: true },
  };
}

/**
 * A device manager holding one device; returns the state each report hands to the datapoints.
 *
 * @param device The device it holds
 */
function rig(device: GoveeDevice): { dm: DeviceManager; last: () => Partial<DeviceState> } {
  const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
  (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", device);
  const updates: Array<Partial<DeviceState>> = [];
  dm.setCallbacks({
    onUpdate: (_d, state) => updates.push(state),
    onLanDeviceReady: () => {},
    onCloudDataReady: () => {},
    onGroupMembersReady: () => {},
  });
  return { dm, last: () => updates[updates.length - 1] };
}

/**
 * The account push of the #57 H6199 with the given state.
 *
 * @param dm The device manager
 * @param device The device the push is from
 * @param state The push's state object
 */
function push(dm: DeviceManager, device: GoveeDevice, state: Record<string, unknown>): void {
  dm.handleMqttStatus({ sku: device.sku, device: device.deviceId, cmd: "status", state });
}

describe("GV-32 the colour mode Govee reports decides both colour datapoints", () => {
  it("colour-temperature mode (Kelvin > 0): color_temperature carries the value and color_rgb null", () => {
    // #57 16:25:52: 255/255/255 with 6667 K — the white beside the Kelvin is Govee's placeholder
    const device = cloudLight();
    const { dm, last } = rig(device);
    push(dm, device, { onOff: 1, color: { r: 255, g: 255, b: 255 }, colorTemInKelvin: 6667 });
    expect(last()).toMatchObject({ colorTemperature: 6667, colorRgb: null });
  });

  it("RGB mode (Kelvin 0): color_rgb carries the colour and color_temperature null", () => {
    // #57 16:25:44: 255/0/0 with Kelvin 0
    const device = cloudLight();
    const { dm, last } = rig(device);
    push(dm, device, { onOff: 1, color: { r: 255, g: 0, b: 0 }, colorTemInKelvin: 0 });
    expect(last()).toMatchObject({ colorRgb: "#ff0000", colorTemperature: null });
  });

  it("an RGB report exactly on Govee's colour-temperature table is a colour temperature: both carry their value", () => {
    // #57 16:26:15: the app's 4500 K sent as 255/223/184 with Kelvin 0
    const device = cloudLight();
    const { dm, last } = rig(device);
    push(dm, device, { color: { r: 255, g: 223, b: 184 }, colorTemInKelvin: 0 });
    expect(last()).toMatchObject({ colorRgb: "#ffdfb8", colorTemperature: 4500 });
  });

  it("only a report carrying both fields decides — a report without them leaves both datapoints alone", () => {
    const device = cloudLight();
    const { dm, last } = rig(device);
    // positive control: the push path runs and delivers what the packet carries
    push(dm, device, { brightness: 98 });
    expect(last()).toMatchObject({ brightness: 98 });
    expect(last()).not.toHaveProperty("colorRgb");
    expect(last()).not.toHaveProperty("colorTemperature");
    // a colour without the Kelvin field decides no mode: the colour temperature is not cleared
    push(dm, device, { color: { r: 0, g: 0, b: 255 } });
    expect(last()).toMatchObject({ colorRgb: "#0000ff" });
    expect(last()).not.toHaveProperty("colorTemperature");
  });

  it("the LAN status answer follows the same mode", () => {
    const device = { ...cloudLight(), lanIp: "192.168.1.20", channels: { lan: true, mqtt: false, cloud: true } };
    const { dm, last } = rig(device);
    dm.handleLanStatus("192.168.1.20", {
      onOff: 1,
      brightness: 50,
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: 2700,
    });
    expect(last()).toMatchObject({ colorTemperature: 2700, colorRgb: null });
    dm.handleLanStatus("192.168.1.20", {
      onOff: 1,
      brightness: 50,
      color: { r: 255, g: 0, b: 0 },
      colorTemInKelvin: 0,
    });
    expect(last()).toMatchObject({ colorRgb: "#ff0000", colorTemperature: null });
  });

  it("the cloud state answer follows the same mode — and Govee's empty value decides nothing", () => {
    // the fresh cloud state of #57: colorRgb 16768952 (255/223/184), colorTemperatureK 0
    const caps = (rgb: unknown, kelvin: unknown): CloudStateCapability[] => [
      { type: "devices.capabilities.color_setting", instance: "colorRgb", state: { value: rgb } },
      { type: "devices.capabilities.color_setting", instance: "colorTemperatureK", state: { value: kelvin } },
    ];
    expect(withCloudColorMode(caps(16768952, 0), [])).toEqual([
      { stateId: "color_rgb", value: "#ffdfb8" },
      { stateId: "color_temperature", value: 4500 },
    ]);
    expect(withCloudColorMode(caps(0xffffff, 3000), [])).toEqual([
      { stateId: "color_rgb", value: null },
      { stateId: "color_temperature", value: 3000 },
    ]);
    const before = [{ stateId: "color_rgb", value: "#ff0000" }];
    expect(withCloudColorMode(caps(0xff0000, ""), before)).toEqual(before);
  });
});
