// GV-11 — Temperatures are always in °C, set explicitly. A catalog quirk converts the models whose cloud temperature comes
// in °F, after govee2mqtt's list.
// krobi 2026-09-24 17:14 chose "catalog quirk after govee2mqtt"; 2026-10-07 15:54: "we keep it explicitly fixed on celsius"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { writeCloudStateValues, type CloudStateLoaderAdapter } from "../lib/handlers/cloud-state-loader";
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

function sensor(sku: string): GoveeDevice {
  return {
    sku,
    deviceId: "AA:BB:CC:DD:EE:FF:00:11",
    name: "Monitor",
    type: "devices.types.sensor",
    capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature" }],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: true },
  };
}

/** Govee's own example answer for an °F model (`get-devices-status`). */
const answer: CloudStateCapability[] = [
  { type: "devices.capabilities.property", instance: "sensorTemperature", state: { value: 79.52 } },
];

const registry = new DeviceRegistry({
  data: {
    devices: {
      H5140: { name: "Smart CO2 Monitor", type: "sensor", status: "reported", quirks: { platformTempUnit: "F" } },
      H5179: { name: "Thermo-Hygrometer", type: "thermometer", status: "reported" },
    },
  },
});

async function writtenTemperature(sku: string): Promise<unknown> {
  const values = new Map<string, unknown>();
  const adapter: CloudStateLoaderAdapter = {
    log,
    rateLimiter: null,
    deviceRegistry: registry,
    cloudClient: null,
    deviceManager: null,
    stateManager: {
      devicePrefix: () => "devices.monitor",
      resolveStatePath: (prefix: string, stateId: string, channel?: string) =>
        `${prefix}.${channel ?? "control"}.${stateId}`,
    } as never,
    setState: (id, state) => {
      values.set(id, (state as { val: unknown }).val);
      return Promise.resolve();
    },
    setStateChanged: (id, state) => {
      values.set(id, (state as { val: unknown }).val);
      return Promise.resolve();
    },
  };
  await writeCloudStateValues(adapter, sensor(sku), answer, "set");
  return values.get("devices.monitor.sensor.temperature");
}

describe("GV-11 temperatures in °C", () => {
  it("79.52 °F from a model with the platformTempUnit quirk is written as 26.4 °C", async () => {
    expect(await writtenTemperature("H5140")).toBe(26.4);
  });

  it("the same number from a model without the quirk stays as it is", async () => {
    expect(await writtenTemperature("H5179")).toBe(79.52);
  });
});
