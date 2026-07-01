import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => key),
  },
}));

import {
  applyQuirksToStates as applyQuirksToStatesRaw,
  buildCloudStateDefs as buildCloudStateDefsRaw,
  buildLanStateDefs as buildLanStateDefsRaw,
  getDefaultLanStates,
  LAN_STATE_IDS,
  mapCapabilities as mapCapabilitiesRaw,
  mapCloudStateValue,
  musicModeNameUsesRgb,
  planCloudCapabilityWrites,
  type StateDefinition,
} from "./capability-mapper";
import { _resetDeviceRegistry, initDeviceRegistry } from "./device-registry";
import { mockLog } from "./test-helpers";
import type { CloudCapability, CloudStateCapability, GoveeDevice } from "./types";

// Test-side wrappers that auto-inject `mockLog` so the existing 60+ tests
// don't each have to thread the logger through. The production callers
// pass their real adapter logger — v2.8.3 required logger DI for the
// capability-mapper functions so per-cap skip-decisions land in the
// debug log.
const mapCapabilities = (caps: CloudCapability[]): StateDefinition[] => mapCapabilitiesRaw(caps, mockLog);
const applyQuirksToStates = (sku: string, states: StateDefinition[]): StateDefinition[] =>
  applyQuirksToStatesRaw(sku, states, mockLog);
const buildLanStateDefs = (device: GoveeDevice): StateDefinition[] => buildLanStateDefsRaw(device, mockLog);
const buildCloudStateDefs = (
  device: GoveeDevice,
  localSnapshots?: { name: string }[],
  memberDevices?: GoveeDevice[],
): StateDefinition[] => buildCloudStateDefsRaw(device, mockLog, localSnapshots, memberDevices);

/**
 * Concat helper for tests that need the full state-def set (LAN + Cloud).
 * Mirrors what the old buildDeviceStateDefs used to do — kept inline in
 * tests so we don't reintroduce a wrapper in the production module.
 */
function buildAllStateDefsForTest(
  device: GoveeDevice,
  localSnapshots?: { name: string }[],
  memberDevices?: GoveeDevice[],
): StateDefinition[] {
  return [...buildLanStateDefs(device), ...buildCloudStateDefs(device, localSnapshots, memberDevices)];
}

/**
 * Quirk-dependent tests need a registry where the seed-status entries
 * (H60A1, H6141, …) are also active. Real-world default has them off
 * unless the user toggles experimental support — tests force the flag on.
 * Inserted via beforeEach so subsequent test files cannot leak a reset.
 */
const TEST_REGISTRY = {
  devices: {
    H60A1: { name: "LED Bulb", type: "light", status: "seed", quirks: { colorTempRange: { min: 2200, max: 6500 } } },
    H6022: {
      name: "LED Bulb (RGBWW)",
      type: "light",
      status: "seed",
      quirks: { colorTempRange: { min: 2700, max: 6500 } },
    },
    H6141: { name: "LED Strip", type: "light", status: "seed", quirks: { brokenPlatformApi: true } },
  },
};

describe("CapabilityMapper", () => {
  beforeEach(() => {
    initDeviceRegistry({ data: TEST_REGISTRY as never, experimental: true });
  });
  afterEach(() => _resetDeviceRegistry());

  describe("mapCapabilities", () => {
    it("should map on_off to boolean power state", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          parameters: {
            dataType: "ENUM",
            options: [
              { name: "off", value: 0 },
              { name: "on", value: 1 },
            ],
          },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("power");
      expect(result[0].type).toBe("boolean");
      expect(result[0].role).toBe("switch");
      expect(result[0].write).toBe(true);
    });

    it("should map range brightness with min/max", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.range",
          instance: "brightness",
          parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 }, unit: "%" },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("brightness");
      expect(result[0].type).toBe("number");
      expect(result[0].role).toBe("level.brightness");
      expect(result[0].min).toBe(0);
      expect(result[0].max).toBe(100);
    });

    it("should map colorRgb to string state", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.color_setting",
          instance: "colorRgb",
          parameters: { dataType: "INTEGER", range: { min: 0, max: 16777215, precision: 1 } },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("color_rgb");
      expect(result[0].type).toBe("string");
      expect(result[0].role).toBe("level.color.rgb");
    });

    it("should map colorTemperatureK to number state", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.color_setting",
          instance: "colorTemperatureK",
          parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("color_temperature");
      expect(result[0].min).toBe(2000);
      expect(result[0].max).toBe(9000);
      expect(result[0].unit).toBe("K");
    });

    it("should map presetScene with dropdown states", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.mode",
          instance: "presetScene",
          parameters: {
            dataType: "ENUM",
            options: [
              { name: "Sunset", value: 1 },
              { name: "Rainbow", value: 2 },
              { name: "Movie", value: 3 },
            ],
          },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("scene");
      expect(result[0].states).toEqual({ "1": "Sunset", "2": "Rainbow", "3": "Movie" });
      expect(result[0].write).toBe(true);
    });

    it("should map property as read-only", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.property",
          instance: "sensorTemperature",
          parameters: { dataType: "INTEGER", range: { min: -20, max: 60, precision: 1 }, unit: "°C" },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].write).toBe(false);
      expect(result[0].role).toBe("value.temperature");
    });

    it("should map toggle to boolean switch", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.toggle",
          instance: "oscillationToggle",
          parameters: {
            dataType: "ENUM",
            options: [
              { name: "off", value: 0 },
              { name: "on", value: 1 },
            ],
          },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("boolean");
      expect(result[0].role).toBe("switch");
    });

    it("should skip online capability", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.online",
          instance: "online",
          parameters: { dataType: "ENUM" },
        },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(0);
    });

    it("should handle multiple capabilities for a typical light", () => {
      const caps: CloudCapability[] = [
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
        { type: "devices.capabilities.online", instance: "online", parameters: { dataType: "ENUM" } },
      ];

      const result = mapCapabilities(caps);
      expect(result).toHaveLength(4);
      expect(result.map(r => r.id)).toEqual(["power", "brightness", "color_rgb", "color_temperature"]);
    });
  });

  describe("getDefaultLanStates", () => {
    it("should return power, brightness, colorRgb, colorTemperature", () => {
      const defs = getDefaultLanStates();
      expect(defs).toHaveLength(4);
      expect(defs.map(d => d.id)).toEqual(["power", "brightness", "color_rgb", "color_temperature"]);
    });

    it("should have correct types and roles", () => {
      const defs = getDefaultLanStates();
      const power = defs.find(d => d.id === "power")!;
      expect(power.type).toBe("boolean");
      expect(power.role).toBe("switch");
      expect(power.write).toBe(true);

      const brightness = defs.find(d => d.id === "brightness")!;
      expect(brightness.type).toBe("number");
      expect(brightness.role).toBe("level.brightness");
      expect(brightness.min).toBe(0);
      expect(brightness.max).toBe(100);

      const color = defs.find(d => d.id === "color_rgb")!;
      expect(color.type).toBe("string");
      expect(color.role).toBe("level.color.rgb");

      const temp = defs.find(d => d.id === "color_temperature")!;
      expect(temp.type).toBe("number");
      expect(temp.min).toBe(2000);
      expect(temp.max).toBe(9000);
      expect(temp.unit).toBe("K");
    });
  });

  describe("mapCapabilities — additional branches", () => {
    it("should map segment_color_setting to JSON state", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.segment_color_setting",
          instance: "segmentedColorRgb",
          parameters: { dataType: "STRUCT" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("_segment_segmented_color_rgb");
      expect(result[0].type).toBe("string");
      expect(result[0].role).toBe("json");
    });

    it("should skip dynamic_scene for lightScene/diyScene/snapshot (handled by buildCloudStateDefs SCENE_DROPDOWN_RULES)", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.dynamic_scene",
          instance: "lightScene",
          parameters: { dataType: "STRUCT" },
        },
        {
          type: "devices.capabilities.dynamic_scene",
          instance: "diyScene",
          parameters: { dataType: "STRUCT" },
        },
        {
          type: "devices.capabilities.dynamic_scene",
          instance: "snapshot",
          parameters: { dataType: "STRUCT" },
        },
      ];
      // These three instances become real dropdowns in buildCloudStateDefs (SCENE_DROPDOWN_RULES)
      // fed from device.scenes / diyScenes / snapshots — mapCapabilities
      // returns nothing so no generic stub has to be filtered out later.
      expect(mapCapabilities(caps)).toHaveLength(0);
    });

    it("should skip music_setting without fields", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          parameters: { dataType: "STRUCT" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(0);
    });

    it("should map music_setting with fields to dropdown + slider + toggle", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "musicMode",
                dataType: "ENUM",
                options: [
                  { name: "Energic", value: 5 },
                  { name: "Rhythm", value: 3 },
                  { name: "Spectrum", value: 6 },
                ],
              },
              {
                fieldName: "sensitivity",
                dataType: "INTEGER",
                range: { min: 0, max: 100, precision: 1 },
              },
              {
                fieldName: "autoColor",
                dataType: "ENUM",
                options: [
                  { name: "on", value: 1 },
                  { name: "off", value: 0 },
                ],
              },
            ],
          },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(3);

      // Mode dropdown
      expect(result[0].id).toBe("music_mode");
      expect(result[0].role).toBe("state");
      // mixed lets users write the index ("1") or the label ("Energic")
      expect(result[0].type).toBe("mixed");
      // Index-based (0 = "---" sentinel), decoupled from the device value:
      // 1→Energic(value 5), 2→Rhythm(value 3), 3→Spectrum(value 6). The send
      // path resolves the index back through getMusicModeOptions, so even these
      // non-contiguous values map correctly (A1).
      expect(result[0].states).toMatchObject({ 0: "---", 1: "Energic", 2: "Rhythm", 3: "Spectrum" });

      // Sensitivity slider
      expect(result[1].id).toBe("music_sensitivity");
      expect(result[1].type).toBe("number");
      expect(result[1].min).toBe(0);
      expect(result[1].max).toBe(100);

      // Auto color toggle
      expect(result[2].id).toBe("music_auto_color");
      expect(result[2].type).toBe("boolean");
    });

    it("music_setting: 0-based option values keep the '---' sentinel (A1)", () => {
      // h612f-class SKU: options start at value 0. The old value-keyed scheme
      // let the value-0 option overwrite modeStates["0"] = "---", so the sentinel
      // vanished and the first mode was unreachable. Index-based keeps 0 = "---"
      // and exposes every mode at 1..N.
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "musicMode",
                dataType: "ENUM",
                options: [
                  { name: "Rhythm", value: 0 },
                  { name: "Sprouting", value: 1 },
                  { name: "Shiny", value: 2 },
                ],
              },
            ],
          },
        },
      ];
      const mode = mapCapabilities(caps).find(r => r.id === "music_mode");
      expect(mode?.states).toEqual({ 0: "---", 1: "Rhythm", 2: "Sprouting", 3: "Shiny" });
      expect(mode?.def).toBe("0");
    });

    it("should fall back to mixed work_mode state when STRUCT has no fields", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          parameters: { dataType: "STRUCT" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("work_mode");
      expect(result[0].type).toBe("mixed");
      expect(result[0].role).toBe("level.mode.work");
    });

    it("should map work_mode STRUCT with workMode field options to dropdown", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "workMode",
                dataType: "ENUM",
                options: [
                  { name: "Manual", value: 1 },
                  { name: "Auto", value: 2 },
                  { name: "Sleep", value: 3 },
                ],
              },
            ],
          },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("work_mode");
      expect(result[0].type).toBe("mixed");
      expect(result[0].states).toEqual({ "1": "Manual", "2": "Auto", "3": "Sleep" });
      expect(result[0].def).toBe("1");
    });

    it("should map work_mode STRUCT with modeValue options as dropdown", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "workMode",
                dataType: "ENUM",
                options: [{ name: "Heat", value: 1 }],
              },
              {
                fieldName: "modeValue",
                dataType: "ENUM",
                options: [
                  { name: "Low", value: 1 },
                  { name: "High", value: 2 },
                ],
              },
            ],
          },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(2);
      const modeValue = result.find(s => s.id === "mode_value");
      expect(modeValue).toBeDefined();
      expect(modeValue!.states).toEqual({ "1": "Low", "2": "High" });
      expect(modeValue!.type).toBe("mixed");
    });

    it("should map work_mode STRUCT with modeValue range as slider", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "workMode",
                dataType: "ENUM",
                options: [{ name: "Auto", value: 1 }],
              },
              {
                fieldName: "modeValue",
                dataType: "INTEGER",
                range: { min: 0, max: 100, precision: 1 },
              },
            ],
          },
        },
      ];
      const result = mapCapabilities(caps);
      const modeValue = result.find(s => s.id === "mode_value");
      expect(modeValue).toBeDefined();
      expect(modeValue!.type).toBe("number");
      expect(modeValue!.min).toBe(0);
      expect(modeValue!.max).toBe(100);
    });

    it("should map temperature_setting STRUCT with targetTemperature field", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.temperature_setting",
          instance: "targetTemperature",
          parameters: {
            dataType: "STRUCT",
            unit: "unit.celsius",
            fields: [
              {
                fieldName: "targetTemperature",
                dataType: "INTEGER",
                range: { min: 16, max: 32, precision: 1 },
              },
            ],
          },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("target_temperature");
      expect(result[0].type).toBe("number");
      expect(result[0].role).toBe("level.temperature");
      expect(result[0].min).toBe(16);
      expect(result[0].max).toBe(32);
      expect(result[0].unit).toBe("°C");
    });

    it("should map temperature_setting with simple range to slider", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.temperature_setting",
          instance: "targetTemperature",
          parameters: {
            dataType: "INTEGER",
            range: { min: 60, max: 90, precision: 1 },
            unit: "unit.fahrenheit",
          },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("target_temperature");
      expect(result[0].type).toBe("number");
      expect(result[0].min).toBe(60);
      expect(result[0].max).toBe(90);
    });

    it("should fall back to JSON state when temperature_setting has no schema", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.temperature_setting",
          instance: "targetTemperature",
          parameters: { dataType: "STRUCT" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("target_temperature");
      expect(result[0].type).toBe("string");
      expect(result[0].role).toBe("json");
    });

    it("should map event capability to boolean indicator in events channel", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.event",
          instance: "lackWater",
          parameters: { dataType: "ENUM" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("lack_water");
      expect(result[0].type).toBe("boolean");
      expect(result[0].role).toBe("indicator.alarm");
      expect(result[0].write).toBe(false);
      expect(result[0].channel).toBe("events");
    });

    it("should route property/temperature into sensor channel", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.property",
          instance: "sensorTemperature",
          parameters: { dataType: "INTEGER", unit: "unit.celsius" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("sensor_temperature");
      expect(result[0].role).toBe("value.temperature");
      expect(result[0].channel).toBe("sensor");
    });

    it("should route property/battery into sensor channel with %", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.property",
          instance: "battery",
          parameters: { dataType: "INTEGER" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result[0].role).toBe("value.battery");
      expect(result[0].unit).toBe("%");
      expect(result[0].channel).toBe("sensor");
    });

    it("should route property/humidity into sensor channel with %", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.property",
          instance: "sensorHumidity",
          parameters: { dataType: "INTEGER" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result[0].role).toBe("value.humidity");
      expect(result[0].unit).toBe("%");
      expect(result[0].channel).toBe("sensor");
    });

    it("should skip mode with non-presetScene instance", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.mode",
          instance: "someOtherMode",
          parameters: { dataType: "ENUM", options: [{ name: "A", value: 1 }] },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(0);
    });

    it("should return empty for unknown color_setting instance", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.color_setting",
          instance: "unknownColorMode",
          parameters: { dataType: "INTEGER" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(0);
    });

    it("should skip unknown capability types", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.completely_unknown",
          instance: "foo",
          parameters: { dataType: "ENUM" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result).toHaveLength(0);
    });

    it("should normalize unit.percent to %", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.range",
          instance: "brightness",
          parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 }, unit: "unit.percent" },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result[0].unit).toBe("%");
    });

    it("should map property humidity with correct role", () => {
      const caps: CloudCapability[] = [
        {
          type: "devices.capabilities.property",
          instance: "sensorHumidity",
          parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } },
        },
      ];
      const result = mapCapabilities(caps);
      expect(result[0].role).toBe("value.humidity");
      expect(result[0].unit).toBe("%");
    });

    it("should handle empty capabilities array", () => {
      const result = mapCapabilities([]);
      expect(result).toHaveLength(0);
    });
  });

  describe("mapCloudStateValue", () => {
    it("should map on_off to power boolean", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        state: { value: 1 },
      };
      const result = mapCloudStateValue(cap);
      expect(result).not.toBeNull();
      expect(result!.stateId).toBe("power");
      expect(result!.value).toBe(true);
    });

    it("should map on_off 0 to false", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        state: { value: 0 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.value).toBe(false);
    });

    it("skips the action-only snapshot dynamic_scene state (no phantom write) — B12", () => {
      // snapshot has no persistent "current snapshot" status and its real state
      // id is snapshot_cloud (not "snapshot"), so writing here only produced a
      // "has no existing object" warning. It must decode to null.
      const cap: CloudStateCapability = {
        type: "devices.capabilities.dynamic_scene",
        instance: "snapshot",
        state: { value: 5 },
      };
      expect(mapCloudStateValue(cap)).toBeNull();
    });

    it("maps lightScene/diyScene dynamic_scene to their real snake_case state ids", () => {
      const ls = mapCloudStateValue({
        type: "devices.capabilities.dynamic_scene",
        instance: "lightScene",
        state: { value: 3 },
      } as CloudStateCapability);
      expect(ls?.stateId).toBe("light_scene"); // matches SCENE_DROPDOWN_RULES + the real state
      const diy = mapCloudStateValue({
        type: "devices.capabilities.dynamic_scene",
        instance: "diyScene",
        state: { value: 2 },
      } as CloudStateCapability);
      expect(diy?.stateId).toBe("diy_scene");
    });

    it("decodes a work_mode cloud state — STRUCT and direct number (L28)", () => {
      expect(
        mapCloudStateValue({
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          state: { value: { workMode: 3 } },
        } as CloudStateCapability),
      ).toEqual({ stateId: "work_mode", value: 3 });
      expect(
        mapCloudStateValue({
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          state: { value: 2 },
        } as CloudStateCapability),
      ).toEqual({ stateId: "work_mode", value: 2 });
    });

    it("decodes a temperature_setting cloud state — STRUCT and direct number (L28)", () => {
      expect(
        mapCloudStateValue({
          type: "devices.capabilities.temperature_setting",
          instance: "targetTemperature",
          state: { value: { targetTemperature: 22 } },
        } as CloudStateCapability),
      ).toEqual({ stateId: "target_temperature", value: 22 });
      expect(
        mapCloudStateValue({
          type: "devices.capabilities.temperature_setting",
          instance: "targetTemperature",
          state: { value: 18 },
        } as CloudStateCapability),
      ).toEqual({ stateId: "target_temperature", value: 18 });
    });

    it("should map colorRgb integer to hex string", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.color_setting",
        instance: "colorRgb",
        state: { value: 0xff8000 }, // orange
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("color_rgb");
      expect(result!.value).toBe("#ff8000");
    });

    it("should map colorRgb 0 to black", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.color_setting",
        instance: "colorRgb",
        state: { value: 0 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.value).toBe("#000000");
    });

    it("should map colorRgb white (16777215)", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.color_setting",
        instance: "colorRgb",
        state: { value: 16777215 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.value).toBe("#ffffff");
    });

    it("should map colorTemperatureK to number", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.color_setting",
        instance: "colorTemperatureK",
        state: { value: 4000 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("color_temperature");
      expect(result!.value).toBe(4000);
    });

    it("should map range brightness to number", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.range",
        instance: "brightness",
        state: { value: 75 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("brightness");
      expect(result!.value).toBe(75);
    });

    it("should map toggle to boolean", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.toggle",
        instance: "gradientToggle",
        state: { value: 1 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("gradient_toggle");
      expect(result!.value).toBe(true);
    });

    it("should map toggle 0 to false", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.toggle",
        instance: "gradientToggle",
        state: { value: 0 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.value).toBe(false);
    });

    it("should map dynamic_scene object to JSON string", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.dynamic_scene",
        instance: "lightScene",
        state: { value: { id: 123, paramId: "abc" } },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("light_scene");
      expect(result!.value).toBe('{"id":123,"paramId":"abc"}');
    });

    it("should map property to number", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.property",
        instance: "sensorTemperature",
        state: { value: 22.5 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("sensor_temperature");
      expect(result!.value).toBe(22.5);
    });

    it("should map presetScene to string", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.mode",
        instance: "presetScene",
        state: { value: 42 },
      };
      const result = mapCloudStateValue(cap);
      expect(result!.stateId).toBe("scene");
      expect(result!.value).toBe("42");
    });

    it("should return null for null state value", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        state: { value: null },
      };
      const result = mapCloudStateValue(cap);
      expect(result).toBeNull();
    });

    it("should return null for undefined state value", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        state: { value: undefined },
      };
      const result = mapCloudStateValue(cap);
      expect(result).toBeNull();
    });

    it("should return null for unknown capability type", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.completely_unknown",
        instance: "foo",
        state: { value: 1 },
      };
      const result = mapCloudStateValue(cap);
      expect(result).toBeNull();
    });

    it("should return null for non-presetScene mode", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.mode",
        instance: "someOtherMode",
        state: { value: 1 },
      };
      const result = mapCloudStateValue(cap);
      expect(result).toBeNull();
    });

    it("should return null for unknown color_setting instance", () => {
      const cap: CloudStateCapability = {
        type: "devices.capabilities.color_setting",
        instance: "unknownColor",
        state: { value: 100 },
      };
      const result = mapCloudStateValue(cap);
      expect(result).toBeNull();
    });
  });

  describe("applyQuirksToStates", () => {
    it("should correct colorTemperature range for known SKU", () => {
      const states = getDefaultLanStates();
      applyQuirksToStates("H60A1", states);
      const ct = states.find(s => s.id === "color_temperature");
      expect(ct).toBeDefined();
      expect(ct!.min).toBe(2200);
      expect(ct!.max).toBe(6500);
      expect(ct!.def).toBe(2200);
    });

    it("should not change colorTemperature range for unknown SKU", () => {
      const states = getDefaultLanStates();
      applyQuirksToStates("H9999", states);
      const ct = states.find(s => s.id === "color_temperature");
      expect(ct!.min).toBe(2000);
      expect(ct!.max).toBe(9000);
    });

    it("should not affect non-colorTemperature states", () => {
      const states = getDefaultLanStates();
      applyQuirksToStates("H60A1", states);
      const brightness = states.find(s => s.id === "brightness");
      expect(brightness!.min).toBe(0);
      expect(brightness!.max).toBe(100);
    });
  });

  describe("brokenPlatformApi quirk (v2.10.0 — Boolean-Flag pattern wired live)", () => {
    // The catalog above marks H6141 as brokenPlatformApi:true with status:seed.
    // We initialize the registry with experimental:true so the quirk activates,
    // then verify buildCloudStateDefs returns an empty/minimal list for that
    // SKU even when the device claims a full capability tree.
    it("returns empty cloud-cap states when brokenPlatformApi is active", () => {
      initDeviceRegistry({ data: TEST_REGISTRY as never, experimental: true });
      const device: GoveeDevice = {
        sku: "H6141",
        deviceId: "AA:BB:CC:DD:EE:FF",
        name: "Broken Strip",
        type: "devices.types.light",
        // Claims a full capability set — but the quirk says don't trust it
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch" },
          { type: "devices.capabilities.range", instance: "brightness" },
          { type: "devices.capabilities.color_setting", instance: "colorRgb" },
          { type: "devices.capabilities.dynamic_scene", instance: "lightScene" },
        ],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: false, mqtt: false, cloud: true },
        segmentCount: 0,
      };
      const defs = buildCloudStateDefs(device);
      // brokenPlatformApi gate also short-circuits SCENE_DROPDOWN_RULES
      // because hasDynamicSceneCapability falls back on the platform-cap
      // tree which the quirk says we shouldn't trust. State id is
      // `light_scene` (snake_case) — the dropdown synthesizer's contract.
      const lightSceneDropdown = defs.find(d => d.id === "light_scene");
      expect(
        lightSceneDropdown,
        "light_scene dropdown should not appear when brokenPlatformApi is set",
      ).toBeUndefined();
      const brightness = defs.find(d => d.id === "brightness");
      expect(brightness, "capability-derived brightness should not come through buildCloudStateDefs").toBeUndefined();
    });

    it("normal SKU without brokenPlatformApi: scene dropdown appears as expected", () => {
      initDeviceRegistry({ data: TEST_REGISTRY as never });
      const device: GoveeDevice = {
        sku: "H61BE", // verified, no quirks
        deviceId: "AA:BB:CC:DD:EE:FF",
        name: "Normal Strip",
        type: "devices.types.light",
        capabilities: [{ type: "devices.capabilities.dynamic_scene", instance: "lightScene" }],
        scenes: [{ name: "Aurora", value: { paramId: 1 } }],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: false, mqtt: false, cloud: true },
        segmentCount: 10,
      };
      const defs = buildCloudStateDefs(device);
      const lightSceneDropdown = defs.find(d => d.id === "light_scene");
      expect(lightSceneDropdown, "light_scene dropdown should appear for normal SKU").toBeDefined();
    });
  });

  describe("cloud-only light control states (local-first, no longer local-only)", () => {
    // A light whose owner has not enabled the local API (lanIp === null) must
    // still get control.power/brightness/colorRgb/colorTemperature — built from
    // its real cloud capabilities and cloud-routed. LAN-capable lights keep
    // letting the LAN phase own those ids; sensors/appliances are unaffected.
    function lightCaps(): CloudCapability[] {
      return [
        { type: "devices.capabilities.on_off", instance: "powerSwitch" },
        { type: "devices.capabilities.range", instance: "brightness", parameters: { range: { min: 1, max: 100 } } },
        { type: "devices.capabilities.color_setting", instance: "colorRgb" },
        {
          type: "devices.capabilities.color_setting",
          instance: "colorTemperatureK",
          parameters: { range: { min: 2000, max: 9000 } },
        },
      ] as CloudCapability[];
    }
    function baseLight(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
      return {
        sku: "H6058",
        deviceId: "D5:F7:CC:34:38:39:28:31",
        name: "Dream2",
        type: "devices.types.light",
        capabilities: lightCaps(),
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: false },
        channels: { lan: false, mqtt: false, cloud: true },
        segmentCount: 15,
        ...overrides,
      };
    }

    it("cloud-only light (no lanIp): control states come through buildCloudStateDefs", () => {
      const defs = buildCloudStateDefs(baseLight());
      for (const id of ["power", "brightness", "color_rgb", "color_temperature"]) {
        const def = defs.find(d => d.id === id);
        expect(def, `cloud-only light must expose control.${id}`).toBeDefined();
        expect(def?.write, `control.${id} must be writable`).toBe(true);
        expect(def?.channel ?? "control", `control.${id} lives in the control channel`).toBe("control");
      }
      // Cloud-routed: carries the real cloud capability, not the "lan" marker.
      expect(defs.find(d => d.id === "power")?.capabilityType).toBe("devices.capabilities.on_off");
      // Range comes from the device's actual capability, not the LAN default.
      expect(defs.find(d => d.id === "brightness")?.min).toBe(1);
    });

    it("LAN-capable light (has lanIp): LAN phase owns control, cloud excludes them", () => {
      const defs = buildCloudStateDefs(baseLight({ lanIp: "192.168.1.50" }));
      for (const id of ["power", "brightness", "color_rgb", "color_temperature"]) {
        expect(defs.find(d => d.id === id), `LAN light: cloud must not duplicate control.${id}`).toBeUndefined();
      }
    });

    it("cloud appliance (on_off, no lanIp): control.power comes through too", () => {
      // Appliances never have a LAN phase, so the same LAN_STATE_IDS filter was
      // silently swallowing their on/off. With no lanIp there is nothing to
      // double-create — keep it so the heater/humidifier can be switched.
      const heater = baseLight({
        type: "devices.types.heater",
        capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }] as CloudCapability[],
      });
      const defs = buildCloudStateDefs(heater);
      const power = defs.find(d => d.id === "power");
      expect(power, "appliance on/off must be controllable").toBeDefined();
      expect(power?.write).toBe(true);
    });

    it("sensor without an on_off cap: still no control.power (nothing to map, not a filter side-effect)", () => {
      const sensor = baseLight({
        type: "devices.types.thermometer",
        capabilities: [
          { type: "devices.capabilities.property", instance: "sensorTemperature" },
          { type: "devices.capabilities.property", instance: "sensorHumidity" },
        ] as CloudCapability[],
      });
      const defs = buildCloudStateDefs(sensor);
      expect(defs.find(d => d.id === "power"), "sensor has no on_off → no power state").toBeUndefined();
    });
  });

  describe("buildLanStateDefs + buildCloudStateDefs dropdown contract (Blockly dual-write)", () => {
    function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
      return {
        sku: "H61BE",
        deviceId: "AABBCCDDEEFF0011",
        name: "Test Light",
        type: "devices.types.light",
        lanIp: "192.168.1.100",
        // Caps include the three dynamic_scene instances so the dropdown
        // gating (capability-driven since v2.1.0) creates the states even
        // when the scenes/snapshots arrays start empty.
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
          { type: "devices.capabilities.dynamic_scene", instance: "lightScene", parameters: { dataType: "ENUM" } },
          { type: "devices.capabilities.dynamic_scene", instance: "diyScene", parameters: { dataType: "ENUM" } },
          { type: "devices.capabilities.dynamic_scene", instance: "snapshot", parameters: { dataType: "ENUM" } },
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
        ...overrides,
      };
    }

    it("light_scene must be type:mixed with disambiguated labels", () => {
      const device = makeDevice({
        scenes: [
          { name: "Aurora", value: { id: 1 } },
          { name: "Movie", value: { id: 2 } },
          { name: "Movie", value: { id: 3 } }, // duplicate
        ],
      });
      const defs = buildAllStateDefsForTest(device);
      const sceneDef = defs.find(d => d.id === "light_scene");
      expect(sceneDef).toBeDefined();
      expect(sceneDef!.type).toBe("mixed");
      expect(sceneDef!.states).toEqual({
        0: "---",
        1: "Aurora",
        2: "Movie",
        3: "Movie (2)",
      });
    });

    it("diy_scene must be type:mixed", () => {
      const device = makeDevice({
        diyScenes: [{ name: "MyDIY", value: { id: 99 } }],
      });
      const defs = buildAllStateDefsForTest(device);
      const diyDef = defs.find(d => d.id === "diy_scene");
      expect(diyDef).toBeDefined();
      expect(diyDef!.type).toBe("mixed");
    });

    it("snapshot_cloud must be type:mixed", () => {
      const device = makeDevice({
        snapshots: [{ name: "My Snap", value: { id: 7 } }],
      });
      const defs = buildAllStateDefsForTest(device);
      const snapDef = defs.find(d => d.id === "snapshot_cloud");
      expect(snapDef).toBeDefined();
      expect(snapDef!.type).toBe("mixed");
    });

    it("snapshot_local must be type:mixed even with empty list", () => {
      const device = makeDevice();
      const defs = buildAllStateDefsForTest(device, undefined);
      const localDef = defs.find(d => d.id === "snapshot_local");
      expect(localDef).toBeDefined();
      expect(localDef!.type).toBe("mixed");
      expect(localDef!.states).toEqual({ 0: "---" });
    });

    it("light_scene/diy_scene/snapshot_cloud created from capability even with empty arrays", () => {
      // First-run case: device exposes the dynamic_scene capability but
      // /device/scenes hasn't been queried yet, so scenes/diyScenes/snapshots
      // are still empty. Pre-v2.1.0 the dropdowns weren't created and the
      // datapoints were missing for the user. Capability-driven gating
      // creates the states with just `0: "---"`, ready to be filled later.
      const device = makeDevice({
        scenes: [],
        diyScenes: [],
        snapshots: [],
      });
      const defs = buildAllStateDefsForTest(device);
      const sceneDef = defs.find(d => d.id === "light_scene");
      const diyDef = defs.find(d => d.id === "diy_scene");
      const snapDef = defs.find(d => d.id === "snapshot_cloud");
      expect(sceneDef, "light_scene must exist").toBeDefined();
      expect(diyDef, "diy_scene must exist").toBeDefined();
      expect(snapDef, "snapshot_cloud must exist").toBeDefined();
      expect(sceneDef!.states).toEqual({ 0: "---" });
      expect(diyDef!.states).toEqual({ 0: "---" });
      expect(snapDef!.states).toEqual({ 0: "---" });
    });

    it("dropdown states NOT created when device lacks dynamic_scene capability", () => {
      // Sensor / appliance with no dynamic_scene capability — must NOT get
      // a phantom scene dropdown.
      const device = makeDevice({
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
        ],
      });
      const defs = buildAllStateDefsForTest(device);
      expect(
        defs.find(d => d.id === "light_scene"),
        "light_scene must NOT exist",
      ).toBeUndefined();
      expect(
        defs.find(d => d.id === "diy_scene"),
        "diy_scene must NOT exist",
      ).toBeUndefined();
      expect(
        defs.find(d => d.id === "snapshot_cloud"),
        "snapshot_cloud must NOT exist",
      ).toBeUndefined();
    });

    it("refresh_cloud button is created for lights with any dynamic_scene capability", () => {
      const device = makeDevice();
      const defs = buildAllStateDefsForTest(device);
      const refreshDef = defs.find(d => d.id === "refresh_cloud");
      expect(refreshDef, "refresh_cloud must exist on a light with dynamic_scene caps").toBeDefined();
      expect(refreshDef!.type).toBe("boolean");
      expect(refreshDef!.role).toBe("button");
      expect(refreshDef!.channel).toBe("snapshots");
      expect(refreshDef!.write).toBe(true);
      expect(refreshDef!.def).toBe(false);
    });

    it("refresh_cloud is created when only lightScene cap is present (no snapshot/diy)", () => {
      const device = makeDevice({
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
          { type: "devices.capabilities.dynamic_scene", instance: "lightScene", parameters: { dataType: "ENUM" } },
        ],
      });
      const defs = buildAllStateDefsForTest(device);
      expect(
        defs.find(d => d.id === "refresh_cloud"),
        "refresh_cloud must exist for lightScene-only",
      ).toBeDefined();
    });

    it("refresh_cloud is NOT created when device has no dynamic_scene capability", () => {
      // Thermometer / heater / sensor — refresh button would be inert noise.
      const device = makeDevice({
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
        ],
      });
      const defs = buildAllStateDefsForTest(device);
      expect(defs.find(d => d.id === "refresh_cloud")).toBeUndefined();
    });
  });

  describe("buildCloudStateDefs for groups", () => {
    function createMember(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
      return {
        sku: "H61BE",
        deviceId: "AABBCCDDEEFF0011",
        name: "Test Light",
        type: "devices.types.light",
        lanIp: "192.168.1.100",
        capabilities: [],
        scenes: [
          { name: "Sunset", value: { id: 1 } },
          { name: "Rainbow", value: { id: 2 } },
        ],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [
          { name: "Energic", musicCode: 1 },
          { name: "Rhythm", musicCode: 2 },
        ],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false },
        ...overrides,
      };
    }

    function createGroup(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
      return {
        sku: "BaseGroup",
        deviceId: "6781311",
        name: "living",
        type: "unknown",
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
        ],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: false, mqtt: false, cloud: true },
        ...overrides,
      };
    }

    it("should return empty for group with no members", () => {
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, []);
      expect(result).toHaveLength(0);
    });

    it("should return control states from LAN member intersection", () => {
      const group = createGroup();
      const m1 = createMember({ sku: "H61BE", lanIp: "192.168.1.1" });
      const m2 = createMember({ sku: "H61BC", lanIp: "192.168.1.2" });
      const result = buildAllStateDefsForTest(group, undefined, [m1, m2]);
      const ids = result.map(d => d.id);
      expect(ids).toContain("power");
      expect(ids).toContain("brightness");
      expect(ids).toContain("color_rgb");
      expect(ids).toContain("color_temperature");
    });

    it("should not include local snapshots for groups but DOES include diag states (v2.9.1)", () => {
      const group = createGroup();
      const m1 = createMember();
      const result = buildAllStateDefsForTest(group, undefined, [m1]);
      const ids = result.map(d => d.id);
      // No snapshots for groups — group-fan-out for snapshots wasn't built.
      expect(ids).not.toContain("snapshot_local");
      expect(ids).not.toContain("snapshot_save");
      expect(ids).not.toContain("snapshot_delete");
      expect(ids).not.toContain("snapshot");
      // v2.9.1 — BaseGroups get diag.export/result so users can export
      // group-specific issues ("fan-out doesn't reach member X")…
      expect(ids).toContain("export");
      expect(ids).toContain("result");
      // …but NOT diag.tier: the trust tier is a per-SKU catalog attribute and a
      // BaseGroup is not a real device (it used to show a hard-coded "verified") — B4.
      expect(ids).not.toContain("tier");
    });

    it("should compute scene intersection across members", () => {
      const m1 = createMember({
        scenes: [
          { name: "Sunset", value: { id: 1 } },
          { name: "Rainbow", value: { id: 2 } },
          { name: "Ocean", value: { id: 3 } },
        ],
      });
      const m2 = createMember({
        scenes: [
          { name: "Rainbow", value: { id: 5 } },
          { name: "Ocean", value: { id: 6 } },
        ],
      });
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, [m1, m2]);
      const sceneDef = result.find(d => d.id === "light_scene");
      expect(sceneDef).toBeDefined();
      // "---" + 2 common scenes (Rainbow, Ocean)
      expect(Object.keys(sceneDef!.states!)).toHaveLength(3);
      expect(Object.values(sceneDef!.states!)).toContain("Rainbow");
      expect(Object.values(sceneDef!.states!)).toContain("Ocean");
      expect(Object.values(sceneDef!.states!)).not.toContain("Sunset");
      // Dropdown writability: type must be "mixed" so users can write
      // either the index ("1"/1) or the scene name from Blockly.
      expect(sceneDef!.type).toBe("mixed");
    });

    it("should compute music intersection across members", () => {
      const m1 = createMember({
        musicLibrary: [
          { name: "Energic", musicCode: 1 },
          { name: "Rhythm", musicCode: 2 },
        ],
      });
      const m2 = createMember({
        musicLibrary: [
          { name: "Rhythm", musicCode: 3 },
          { name: "Spectrum", musicCode: 4 },
        ],
      });
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, [m1, m2]);
      const musicDef = result.find(d => d.id === "music_mode");
      expect(musicDef).toBeDefined();
      expect(Object.values(musicDef!.states!)).toContain("Rhythm");
      expect(Object.values(musicDef!.states!)).not.toContain("Energic");
      expect(Object.values(musicDef!.states!)).not.toContain("Spectrum");
    });

    it("should skip scenes when a member has no scenes", () => {
      const m1 = createMember({ scenes: [{ name: "Sunset", value: { id: 1 } }] });
      const m2 = createMember({ scenes: [] });
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, [m1, m2]);
      expect(result.find(d => d.id === "light_scene")).toBeUndefined();
    });

    it("should filter control states by Cloud caps when no LAN", () => {
      const m1 = createMember({
        lanIp: undefined,
        capabilities: [
          { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
          { type: "devices.capabilities.range", instance: "brightness", parameters: { dataType: "INTEGER" } },
        ],
        channels: { lan: false, mqtt: false, cloud: true },
      });
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, [m1]);
      const ids = result.map(d => d.id);
      expect(ids).toContain("power");
      expect(ids).toContain("brightness");
      expect(ids).not.toContain("color_rgb");
      expect(ids).not.toContain("color_temperature");
    });

    it("should skip unreachable members (no LAN, no Cloud)", () => {
      const m1 = createMember({ lanIp: undefined, channels: { lan: false, mqtt: false, cloud: false } });
      const group = createGroup();
      const result = buildAllStateDefsForTest(group, undefined, [m1]);
      expect(result).toHaveLength(0);
    });
  });

  describe("Drift: API schema violations", () => {
    describe("mapCapabilities non-array / malformed input", () => {
      it("should return empty for non-array input", () => {
        const result = mapCapabilities(undefined as unknown as CloudCapability[]);
        expect(result).toEqual([]);
      });

      it("should return empty for null input", () => {
        const result = mapCapabilities(null as unknown as CloudCapability[]);
        expect(result).toEqual([]);
      });

      it("should return empty for object-instead-of-array", () => {
        const result = mapCapabilities({} as unknown as CloudCapability[]);
        expect(result).toEqual([]);
      });

      it("should skip capability with non-string type", () => {
        const caps = [{ type: null, instance: "foo", parameters: {} }] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("should skip capability with non-string instance", () => {
        const caps = [
          { type: "devices.capabilities.on_off", instance: 42, parameters: {} },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("should skip null/undefined capability entries", () => {
        const caps = [null, undefined] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });
    });

    describe("missing parameters field (Cloud API drift)", () => {
      it("mapRange should not throw when parameters is missing", () => {
        const caps = [{ type: "devices.capabilities.range", instance: "brightness" }] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        const result = mapCapabilities(caps);
        expect(result).toHaveLength(1);
        expect(result[0].min).toBe(0);
        expect(result[0].max).toBe(100);
      });

      it("mapColorSetting colorTem should not throw when parameters is missing", () => {
        const caps = [
          { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        const result = mapCapabilities(caps);
        expect(result).toHaveLength(1);
        expect(result[0].min).toBe(2000);
        expect(result[0].max).toBe(9000);
      });

      it("mapMode should return empty when parameters is missing", () => {
        const caps = [{ type: "devices.capabilities.mode", instance: "presetScene" }] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("mapMode should return empty when options is not an array", () => {
        const caps = [
          {
            type: "devices.capabilities.mode",
            instance: "presetScene",
            parameters: { dataType: "ENUM", options: "not-an-array" },
          },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("mapProperty should not throw when parameters is missing", () => {
        const caps = [
          { type: "devices.capabilities.property", instance: "sensorTemperature" },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        const result = mapCapabilities(caps);
        expect(result).toHaveLength(1);
        expect(result[0].unit).toBe("°C");
      });

      it("mapMusicSetting should return empty when parameters is missing", () => {
        const caps = [
          { type: "devices.capabilities.music_setting", instance: "musicMode" },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("mapMusicSetting should return empty when fields is non-array", () => {
        const caps = [
          {
            type: "devices.capabilities.music_setting",
            instance: "musicMode",
            parameters: { dataType: "STRUCT", fields: "oops" },
          },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("mapMusicSetting should skip fields with non-string fieldName", () => {
        const caps = [
          {
            type: "devices.capabilities.music_setting",
            instance: "musicMode",
            parameters: {
              dataType: "STRUCT",
              fields: [
                { fieldName: null, options: [{ name: "x", value: 1 }] },
                { fieldName: 123, range: { min: 0, max: 100, precision: 1 } },
              ],
            },
          },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        expect(mapCapabilities(caps)).toEqual([]);
      });

      it("mapMode should skip options with non-string name", () => {
        const caps = [
          {
            type: "devices.capabilities.mode",
            instance: "presetScene",
            parameters: {
              dataType: "ENUM",
              options: [
                { name: "Valid", value: 1 },
                { name: 999, value: 2 },
                { name: null, value: 3 },
              ],
            },
          },
        ] as unknown as CloudCapability[];
        expect(() => mapCapabilities(caps)).not.toThrow();
        const result = mapCapabilities(caps);
        expect(result).toHaveLength(1);
        expect(Object.values(result[0].states!)).toContain("Valid");
        expect(Object.values(result[0].states!)).not.toContain("999");
      });
    });

    describe("mapCloudStateValue coercion and drift", () => {
      it("should coerce on_off raw='1' (string) to true", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: { value: "1" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(true);
      });

      it("should coerce on_off raw='true' to true", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: { value: "true" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(true);
      });

      it("should coerce on_off raw='0' to false", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: { value: "0" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(false);
      });

      it("should coerce toggle raw='1' to true", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.toggle",
          instance: "gradientToggle",
          state: { value: "1" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(true);
      });

      it("should coerce range numeric-string to number", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.range",
          instance: "brightness",
          state: { value: "75" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(75);
      });

      it("should return null for range non-numeric string", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.range",
          instance: "brightness",
          state: { value: "abc" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result).toBeNull();
      });

      it("should coerce colorTemperature numeric-string to number", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.color_setting",
          instance: "colorTemperatureK",
          state: { value: "5000" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(5000);
      });

      it("should coerce property numeric-string to number", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.property",
          instance: "sensorTemperature",
          state: { value: "22.5" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe(22.5);
      });

      it("should return null for property garbage string", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.property",
          instance: "sensorTemperature",
          state: { value: "garbage" as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result).toBeNull();
      });

      it("should return null when cap.type is non-string", () => {
        const cap = {
          type: null,
          instance: "powerSwitch",
          state: { value: 1 },
        } as unknown as CloudStateCapability;
        expect(() => mapCloudStateValue(cap)).not.toThrow();
        expect(mapCloudStateValue(cap)).toBeNull();
      });

      it("should return null when cap.instance is non-string", () => {
        const cap = {
          type: "devices.capabilities.on_off",
          instance: 42,
          state: { value: 1 },
        } as unknown as CloudStateCapability;
        expect(() => mapCloudStateValue(cap)).not.toThrow();
        expect(mapCloudStateValue(cap)).toBeNull();
      });

      it("should not throw on undefined cap", () => {
        expect(() => mapCloudStateValue(undefined as unknown as CloudStateCapability)).not.toThrow();
        expect(mapCloudStateValue(undefined as unknown as CloudStateCapability)).toBeNull();
      });

      it("should coerce music_setting mode when musicMode is string", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          state: { value: { musicMode: "7" } as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.stateId).toBe("music_mode");
        expect(result!.value).toBe("7");
      });

      it("should default music_setting to '0' when musicMode is garbage", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          state: { value: { musicMode: "abc" } as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe("0");
      });

      it("should coerce colorRgb numeric-string to hex", () => {
        const cap: CloudStateCapability = {
          type: "devices.capabilities.color_setting",
          instance: "colorRgb",
          state: { value: String(0xff8000) as unknown as number },
        };
        const result = mapCloudStateValue(cap);
        expect(result!.value).toBe("#ff8000");
      });
    });
  });

  describe("planCloudCapabilityWrites", () => {
    const lanStateIds = new Set(["power", "brightness", "color_rgb", "color_temperature"]);

    it("returns the resolved (stateId, value) pairs for every decoded capability", () => {
      const caps: CloudStateCapability[] = [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
        { type: "devices.capabilities.range", instance: "brightness", state: { value: 50 } },
      ];
      const result = planCloudCapabilityWrites(caps, false, lanStateIds);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ stateId: "power", value: true });
      expect(result[1]).toEqual({ stateId: "brightness", value: 50 });
    });

    it("skips LAN-shadowed states when the device has a LAN IP", () => {
      const caps: CloudStateCapability[] = [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
        { type: "devices.capabilities.property", instance: "battery", state: { value: 75 } },
      ];
      const result = planCloudCapabilityWrites(caps, true, lanStateIds);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ stateId: "battery", value: 75 });
    });

    it("includes every state when the device has no LAN IP (sensors / appliances)", () => {
      const caps: CloudStateCapability[] = [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
        { type: "devices.capabilities.range", instance: "brightness", state: { value: 50 } },
        { type: "devices.capabilities.property", instance: "battery", state: { value: 75 } },
      ];
      const result = planCloudCapabilityWrites(caps, false, lanStateIds);
      expect(result).toHaveLength(3);
    });

    it("silently drops capabilities that mapCloudStateValue rejects", () => {
      const caps: CloudStateCapability[] = [
        { type: "devices.capabilities.unknown_type", instance: "foo", state: { value: 1 } },
        { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
      ];
      const result = planCloudCapabilityWrites(caps, false, lanStateIds);
      expect(result).toHaveLength(1);
      expect(result[0].stateId).toBe("power");
    });

    it("handles non-array input defensively", () => {
      const result = planCloudCapabilityWrites(null as never, false, lanStateIds);
      expect(result).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      expect(planCloudCapabilityWrites([], false, lanStateIds)).toEqual([]);
    });
  });

  describe("Architektur-Invarianten — LAN_STATE_IDS", () => {
    // These two tests guard the three-link chain that makes the v2.7.0
    // wipe-bug structurally impossible. Each test fails when a future
    // refactor breaks the corresponding link.

    it("Invariant 1: LAN_STATE_IDS covers all getDefaultLanStates entries", () => {
      // If someone adds a fifth field to getDefaultLanStates but doesn't extend
      // LAN_STATE_IDS: the new field runs into the cloud-owned cleanup → gets
      // deleted on the next restart.
      for (const def of getDefaultLanStates()) {
        expect(LAN_STATE_IDS.has(def.id), `LAN_STATE_IDS missing entry for ${def.id}`).toBe(true);
      }
      expect(
        LAN_STATE_IDS.size,
        "LAN_STATE_IDS has entries not backed by getDefaultLanStates — drift in the other direction",
      ).toBe(getDefaultLanStates().length);
    });

    it("Invariant 2: buildCloudStateDefs has no overlap with LAN_STATE_IDS", () => {
      // If someone forgets the LAN_STATE_IDS dedup filter in buildCloudStateDefs:
      // power/brightness/etc. are created twice — once from the LAN phase, once
      // from the cloud cap. Cleanup wipes one, the other stays; the state value
      // jumps between sources.
      const device: GoveeDevice = {
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:FF",
        name: "Test Light",
        type: "devices.types.light",
        lanIp: "192.168.1.10",
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: true },
        capabilities: [
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
          {
            type: "devices.capabilities.toggle",
            instance: "gradientToggle",
            parameters: { dataType: "ENUM" },
          },
        ],
      } as never;
      const cloudDefs = buildCloudStateDefs(device);
      for (const def of cloudDefs) {
        expect(LAN_STATE_IDS.has(def.id), `buildCloudStateDefs emitted LAN-owned id ${def.id}`).toBe(false);
      }
      // Sanity: cap-derived non-LAN states (gradient_toggle) DO make it through
      expect(cloudDefs.some(d => d.id === "gradient_toggle")).toBe(true);
      // B2 coupling: the LAN device must NOT get a cloud colour duplicate — the
      // colour caps have to be shadowed away entirely (not just "not a
      // LAN_STATE_IDS member", which a drifted id would falsely satisfy).
      expect(cloudDefs.some(d => d.id === "color_rgb" || d.id === "color_temperature")).toBe(false);
    });

    it("Invariant 3: mapColorSetting ids for cloud colour caps are all LAN-owned (B2 shadowing)", () => {
      // The colour states are LAN-default. mapColorSetting must emit the SAME
      // ids LAN_STATE_IDS carries (color_rgb / color_temperature) — else a LAN
      // device gets BOTH the LAN colour state and an un-shadowed cloud duplicate.
      const colorCaps: CloudCapability[] = [
        { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
        {
          type: "devices.capabilities.color_setting",
          instance: "colorTemperatureK",
          parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
        },
      ];
      const ids = mapCapabilities(colorCaps).map(d => d.id);
      expect(ids).toEqual(["color_rgb", "color_temperature"]);
      for (const cid of ids) {
        expect(LAN_STATE_IDS.has(cid), `mapColorSetting id ${cid} not shadowed by LAN_STATE_IDS`).toBe(true);
      }
    });
  });

  describe("common.states plain-string invariant (React #31, v2.8.4)", () => {
    // Admin renders states-values as React children — a translation object
    // triggers React Error #31 → fatal "Error in GUI". These tests guard
    // that every state-def emitted has plain-string VALUES, irrespective of
    // language.

    it("diag.tier VALUES are plain-string in default (en) language", () => {
      const device: GoveeDevice = {
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:FF",
        name: "Test",
        type: "devices.types.light",
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: false, mqtt: false, cloud: true },
        capabilities: [],
      } as never;
      const cloudDefs = buildCloudStateDefs(device);
      const tier = cloudDefs.find(d => d.id === "tier");
      expect(tier, "tier state-def must exist for non-group devices").toBeDefined();
      expect(tier!.states, "tier state-def must have common.states").toBeDefined();
      for (const [k, v] of Object.entries(tier!.states!)) {
        expect(typeof v, `tier states[${k}] must be plain-string, got ${typeof v}`).toBe("string");
      }
    });

    it("all common.states VALUES across cloud-defs are plain-string", () => {
      const device: GoveeDevice = {
        sku: "H6172",
        deviceId: "AA:BB:CC:DD:EE:FF",
        name: "Test",
        type: "devices.types.light",
        lanIp: "192.168.1.10",
        scenes: [
          { name: "Sunset", value: { id: 1 } },
          { name: "Rainbow", value: { id: 2 } },
        ],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: true },
        capabilities: [],
      } as never;
      const defs = buildCloudStateDefs(device);
      for (const def of defs) {
        if (!def.states) continue;
        for (const [k, v] of Object.entries(def.states)) {
          expect(typeof v, `${def.id} states[${k}] must be plain-string, got ${typeof v}`).toBe("string");
        }
      }
    });
  });
});

describe("musicModeNameUsesRgb (A2 — colour modes keyed on name, not value)", () => {
  it("returns true for Spectrum and Rolling, case-insensitive + trimmed", () => {
    expect(musicModeNameUsesRgb("Spectrum")).toBe(true);
    expect(musicModeNameUsesRgb("Rolling")).toBe(true);
    expect(musicModeNameUsesRgb("spectrum")).toBe(true);
    expect(musicModeNameUsesRgb("  ROLLING  ")).toBe(true);
  });

  it("returns false for auto-colour modes and unknown/exotic modes (safe default = no RGB)", () => {
    for (const n of ["Energic", "Energetic", "Rhythm", "Sprouting", "Shiny", "", "Spectrums"]) {
      expect(musicModeNameUsesRgb(n)).toBe(false);
    }
  });

  it("returns false for a non-string name (defensive)", () => {
    expect(musicModeNameUsesRgb(undefined)).toBe(false);
    expect(musicModeNameUsesRgb(123 as unknown as string)).toBe(false);
  });
});
