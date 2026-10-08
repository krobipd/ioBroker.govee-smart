// B1 — Every device can need quirks, no matter whether it is connected through the cloud, locally or any other way.
// krobi 2026-10-08 09:39: "basically every device can need quirks, it makes no difference whether cloud, local or via the moon"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildCloudStateDefs, buildLanStateDefs } from "../lib/capability-mapper";
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

const registry = new DeviceRegistry({
  data: {
    devices: {
      H9Q02: { name: "Lamp", type: "light", status: "reported", quirks: { colorTempRange: { min: 2700, max: 6500 } } },
    },
  },
});

function light(lanIp: string | undefined): GoveeDevice {
  return {
    sku: "H9Q02",
    deviceId: "AA:BB:CC:DD:EE:FF:00:B1",
    name: "Lamp",
    type: "devices.types.light",
    lanIp,
    capabilities: [
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

function range(defs: { id: string; min?: number; max?: number }[]): { min?: number; max?: number } {
  const ct = defs.find(d => d.id === "color_temperature");
  return { min: ct?.min, max: ct?.max };
}

describe("B1 quirks apply whatever the connection", () => {
  it("a cloud-only light (no LAN) takes the catalog's colour-temperature range", () => {
    expect(range(buildCloudStateDefs(light(undefined), log, registry))).toEqual({ min: 2700, max: 6500 });
  });

  it("the same quirk applies to the same model on LAN", () => {
    expect(range(buildLanStateDefs(light("192.168.1.31"), log, registry))).toEqual({ min: 2700, max: 6500 });
  });
});
