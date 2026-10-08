// GV-01 — A new device goes into the catalog and is adapted through the quirk system. No device is written into the code.
// krobi 2026-09-10 21:06: "… whether one hardcodes it — which is not the point of the adapter — or uses the quirk system"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildLanStateDefs } from "../lib/capability-mapper";
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

/** A model no line of the adapter knows — only the catalog entry below can change how it behaves. */
const UNKNOWN_SKU = "H9Q01";

function light(): GoveeDevice {
  return {
    sku: UNKNOWN_SKU,
    deviceId: "AA:BB:CC:DD:EE:FF:00:01",
    name: "New lamp",
    type: "devices.types.light",
    lanIp: "192.168.1.30",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: false },
  };
}

function colourTemperatureRange(registry: DeviceRegistry): { min?: number; max?: number } {
  const ct = buildLanStateDefs(light(), log, registry).find(d => d.id === "color_temperature");
  return { min: ct?.min, max: ct?.max };
}

describe("GV-01 a catalog quirk adapts a model without code for it", () => {
  it("a colorTempRange entry for an unknown model sets its colour-temperature range", () => {
    const registry = new DeviceRegistry({
      data: {
        devices: {
          [UNKNOWN_SKU]: {
            name: "New lamp",
            type: "light",
            status: "reported",
            quirks: { colorTempRange: { min: 2700, max: 6500 } },
          },
        },
      },
    });
    expect(colourTemperatureRange(registry)).toEqual({ min: 2700, max: 6500 });
  });

  it("without the catalog entry the same model keeps the generic LAN range (positive control)", () => {
    const registry = new DeviceRegistry({ data: { devices: {} } });
    expect(colourTemperatureRange(registry)).not.toEqual({ min: 2700, max: 6500 });
  });
});
