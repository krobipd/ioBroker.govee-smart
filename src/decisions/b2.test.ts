// B2 — The datapoints for colour and colour temperature are named color_rgb and color_temperature.
// krobi 2026-07-01 (note, no wording kept): "hard cut, decided by krobi"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildCloudStateDefs, buildLanStateDefs, mapCloudStateValue } from "../lib/capability-mapper";
import { DeviceRegistry } from "../lib/device-registry";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};
const registry = new DeviceRegistry({ data: { devices: {} } });

function light(lanIp: string | undefined): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:B2",
    name: "Strip",
    type: "devices.types.light",
    lanIp,
    capabilities: [
      {
        type: "devices.capabilities.color_setting",
        instance: "colorRgb",
        parameters: { dataType: "INTEGER", range: { min: 0, max: 16777215, precision: 1 } },
      },
      {
        type: "devices.capabilities.color_setting",
        instance: "colorTemperatureK",
        parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 }, unit: "unit.kelvin" },
      },
    ],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: Boolean(lanIp), mqtt: false, cloud: true },
  };
}

describe("B2 datapoint names for colour and colour temperature", () => {
  it("a LAN light gets control datapoints color_rgb and color_temperature", () => {
    const ids = buildLanStateDefs(light("192.168.1.32"), log, registry).map(d => d.id);
    expect(ids).toEqual(expect.arrayContaining(["color_rgb", "color_temperature"]));
  });

  it("a cloud-only light gets the same two names from Govee's colorRgb and colorTemperatureK", () => {
    const defs = buildCloudStateDefs(light(undefined), log, registry).filter(
      d => d.id === "color_rgb" || d.id === "color_temperature",
    );
    expect(defs.map(d => d.id).sort()).toEqual(["color_rgb", "color_temperature"]);
  });

  it("Govee's state values land on the same two names", () => {
    expect(
      mapCloudStateValue({
        type: "devices.capabilities.color_setting",
        instance: "colorRgb",
        state: { value: 0x00ff00 },
      })?.stateId,
    ).toBe("color_rgb");
    expect(
      mapCloudStateValue({
        type: "devices.capabilities.color_setting",
        instance: "colorTemperatureK",
        state: { value: 4000 },
      })?.stateId,
    ).toBe("color_temperature");
  });
});
