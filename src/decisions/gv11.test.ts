// GV-11 — Temperatures are always in °C, set explicitly. A catalog quirk converts the models whose cloud temperature comes
// in °F, after govee2mqtt's list.
// krobi 2026-09-24 17:14 chose "catalog quirk after govee2mqtt"; 2026-10-07 15:54: "we keep it explicitly fixed on celsius"
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildCloudStateDefs } from "../lib/capability-mapper";
import {
  applyCloudCapabilities,
  writeCloudStateValues,
  type CloudStateLoaderAdapter,
} from "../lib/handlers/cloud-state-loader";
import { sendTargetTemperatureCommand } from "../lib/handlers/state-change-router";
import { DeviceRegistry } from "../lib/device-registry";
import type { CloudCapability, CloudStateCapability, GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

/**
 * govee2mqtt's models whose platform API reports °F — `src/service/quirks.rs`, every
 * `with_platform_temperature_sensor_units(TemperatureUnits::Fahrenheit)` (commit 6f5a844, 2026-04-12).
 */
const GOVEE2MQTT_FAHRENHEIT = [
  "H5051",
  "H5100",
  "H5103",
  "H5179",
  "H7130",
  "H7131",
  "H7132",
  "H7133",
  "H7134",
  "H7135",
  "H713A",
  "H713B",
  "H7170",
  "H7171",
  "H7173",
];

const registry = new DeviceRegistry({
  data: {
    devices: {
      H5179: { name: "Thermo-Hygrometer", type: "thermometer", status: "reported", quirks: { platformTempUnit: "F" } },
      H7130: { name: "Smart Space Heater", type: "heater", status: "reported", quirks: { platformTempUnit: "F" } },
      H5140: { name: "Smart CO2 Monitor", type: "sensor", status: "reported" },
    },
  },
});

function device(sku: string, type: string, capabilities: CloudCapability[]): GoveeDevice {
  return {
    sku,
    deviceId: "AA:BB:CC:DD:EE:FF:00:11",
    name: sku,
    type,
    capabilities,
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

const sensorCap: CloudCapability = { type: "devices.capabilities.property", instance: "sensorTemperature" };

/**
 * A heater's target temperature as Govee declares it — the range in °F, with or without a declared unit.
 *
 * @param declared the unit field Govee declares, or none
 */
function targetCap(declared: "Fahrenheit" | null): CloudCapability {
  const fields: NonNullable<CloudCapability["parameters"]>["fields"] = [
    { fieldName: "temperature", dataType: "INTEGER", range: { min: 41, max: 95, precision: 1 }, required: true },
  ];
  if (declared) {
    fields.push({
      fieldName: "unit",
      defaultValue: declared,
      dataType: "ENUM",
      options: [
        { name: "Celsius", value: "Celsius" },
        { name: "Fahrenheit", value: "Fahrenheit" },
      ],
      required: true,
    });
  }
  return {
    type: "devices.capabilities.temperature_setting",
    instance: "targetTemperature",
    parameters: { dataType: "STRUCT", fields },
  };
}

function loader(values: Map<string, unknown>): CloudStateLoaderAdapter {
  const record = (id: string, state: unknown): Promise<void> => {
    values.set(id, (state as { val: unknown }).val);
    return Promise.resolve();
  };
  return {
    log,
    rateLimiter: null,
    deviceRegistry: registry,
    cloudClient: null,
    deviceManager: null,
    stateManager: {
      devicePrefix: () => "devices.d",
      resolveStatePath: (prefix: string, stateId: string, channel?: string) =>
        `${prefix}.${channel ?? "control"}.${stateId}`,
      ensureSyntheticStateObject: () => Promise.resolve(),
      removeSyntheticStateOnce: () => Promise.resolve(),
    } as never,
    setState: (id, state) => record(id, state),
    setStateChanged: (id, state) => record(id, state),
  };
}

function targetDef(dev: GoveeDevice): { unit?: string; min?: number; max?: number } | undefined {
  return buildCloudStateDefs(dev, log, registry).find(d => d.id === "target_temperature");
}

describe("GV-11 temperatures in °C", () => {
  it("the catalog converts exactly the models govee2mqtt lists as reporting °F", () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), "devices.json"), "utf-8")) as {
      devices: Record<string, { quirks?: { platformTempUnit?: string } }>;
    };
    const fahrenheit = Object.entries(catalog.devices)
      .filter(([, entry]) => entry.quirks?.platformTempUnit === "F")
      .map(([sku]) => sku)
      .sort();
    expect(fahrenheit).toEqual([...GOVEE2MQTT_FAHRENHEIT].sort());
  });

  it("79.52 °F from a model with the platformTempUnit quirk is written as 26.4 °C", async () => {
    const values = new Map<string, unknown>();
    const answer: CloudStateCapability[] = [{ ...sensorCap, state: { value: 79.52 } }];
    await writeCloudStateValues(loader(values), device("H5179", "devices.types.sensor", [sensorCap]), answer, "set");
    expect(values.get("devices.d.sensor.temperature")).toBe(26.4);
  });

  it("the same number from a model without the quirk stays as it is (positive control)", async () => {
    const values = new Map<string, unknown>();
    const answer: CloudStateCapability[] = [{ ...sensorCap, state: { value: 21.5 } }];
    await writeCloudStateValues(loader(values), device("H5140", "devices.types.sensor", [sensorCap]), answer, "set");
    expect(values.get("devices.d.sensor.temperature")).toBe(21.5);
  });

  it("an App API reading of a °F model is °C already and stays as it is — no second conversion", async () => {
    const values = new Map<string, unknown>();
    const reading: CloudStateCapability[] = [{ ...sensorCap, state: { value: 21.5 } }];
    await applyCloudCapabilities(loader(values), device("H5179", "devices.types.sensor", [sensorCap]), reading);
    expect(values.get("devices.d.sensor.temperature")).toBe(21.5);
  });

  it("a heater that declares °F gets a target temperature in °C, its range converted", () => {
    expect(targetDef(device("H7199", "devices.types.heater", [targetCap("Fahrenheit")]))).toMatchObject({
      unit: "°C",
      min: 5,
      max: 35,
    });
  });

  it("a heater the catalog marks °F and that declares no unit gets the same, the unit stated", () => {
    expect(targetDef(device("H7130", "devices.types.heater", [targetCap(null)]))).toMatchObject({
      unit: "°C",
      min: 5,
      max: 35,
    });
  });

  it("a target temperature Govee reports in °F is written in °C", async () => {
    const values = new Map<string, unknown>();
    const answer: CloudStateCapability[] = [
      {
        type: "devices.capabilities.temperature_setting",
        instance: "targetTemperature",
        state: { value: { targetTemperature: 77, unit: "Fahrenheit" } },
      },
    ];
    const heater = device("H7199", "devices.types.heater", [targetCap("Fahrenheit")]);
    await writeCloudStateValues(loader(values), heater, answer, "set");
    expect(values.get("devices.d.control.target_temperature")).toBe(25);
  });

  it("25 °C written by the user goes to a °F heater as 77 °F and is confirmed as 25 °C", async () => {
    const sent: unknown[] = [];
    const adapter = {
      log,
      namespace: "govee-smart.0",
      deviceRegistry: registry,
      getStateAsync: () => Promise.resolve(null),
      deviceManager: {
        sendCapabilityCommand: (_d: unknown, _t: string, _i: string, value: unknown) => {
          sent.push(value);
          return Promise.resolve();
        },
      },
    };
    const heater = device("H7199", "devices.types.heater", [targetCap("Fahrenheit")]);
    const result = await sendTargetTemperatureCommand(
      adapter as never,
      heater,
      "devices.d",
      "control.target_temperature",
      25,
    );
    expect(sent).toEqual([{ temperature: 77, unit: "Fahrenheit" }]);
    expect(result).toEqual({ ack: 25 });
  });
});
