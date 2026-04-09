"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var capability_mapper_exports = {};
__export(capability_mapper_exports, {
  getDefaultLanStates: () => getDefaultLanStates,
  mapCapabilities: () => mapCapabilities,
  mapCloudStateValue: () => mapCloudStateValue
});
module.exports = __toCommonJS(capability_mapper_exports);
function mapCapabilities(capabilities) {
  const states = [];
  for (const cap of capabilities) {
    const mapped = mapSingleCapability(cap);
    if (mapped) {
      states.push(...mapped);
    }
  }
  return states;
}
function getDefaultLanStates() {
  return [
    {
      id: "power",
      name: "Power",
      type: "boolean",
      role: "switch",
      write: true,
      def: false,
      capabilityType: "lan",
      capabilityInstance: "powerSwitch"
    },
    {
      id: "brightness",
      name: "Brightness",
      type: "number",
      role: "level.brightness",
      write: true,
      min: 0,
      max: 100,
      unit: "%",
      def: 0,
      capabilityType: "lan",
      capabilityInstance: "brightness"
    },
    {
      id: "colorRgb",
      name: "Color RGB",
      type: "string",
      role: "level.color.rgb",
      write: true,
      def: "#000000",
      capabilityType: "lan",
      capabilityInstance: "colorRgb"
    },
    {
      id: "colorTemperature",
      name: "Color Temperature",
      type: "number",
      role: "level.color.temperature",
      write: true,
      min: 2e3,
      max: 9e3,
      unit: "K",
      def: 2e3,
      capabilityType: "lan",
      capabilityInstance: "colorTemperatureK"
    }
  ];
}
function mapSingleCapability(cap) {
  const shortType = cap.type.replace("devices.capabilities.", "");
  switch (shortType) {
    case "on_off":
      return [
        {
          id: "power",
          name: "Power",
          type: "boolean",
          role: "switch",
          write: true,
          def: false,
          capabilityType: cap.type,
          capabilityInstance: cap.instance
        }
      ];
    case "range":
      return mapRange(cap);
    case "color_setting":
      return mapColorSetting(cap);
    case "toggle":
      return [
        {
          id: sanitizeId(cap.instance),
          name: humanize(cap.instance),
          type: "boolean",
          role: "switch",
          write: true,
          def: false,
          capabilityType: cap.type,
          capabilityInstance: cap.instance
        }
      ];
    case "mode":
      return mapMode(cap);
    case "property":
      return mapProperty(cap);
    case "online":
      return null;
    case "segment_color_setting":
      return [
        {
          id: `_segment_${sanitizeId(cap.instance)}`,
          name: humanize(cap.instance),
          type: "string",
          role: "json",
          write: true,
          capabilityType: cap.type,
          capabilityInstance: cap.instance
        }
      ];
    case "dynamic_scene":
    case "work_mode":
    case "temperature_setting":
      return [
        {
          id: sanitizeId(cap.instance),
          name: humanize(cap.instance),
          type: "string",
          role: "json",
          write: true,
          def: "",
          capabilityType: cap.type,
          capabilityInstance: cap.instance
        }
      ];
    case "music_setting":
      return mapMusicSetting(cap);
    default:
      return null;
  }
}
function mapRange(cap) {
  var _a, _b, _c;
  const range = cap.parameters.range;
  const isBrightness = cap.instance.toLowerCase().includes("brightness");
  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "number",
      role: isBrightness ? "level.brightness" : "level",
      write: true,
      min: (_a = range == null ? void 0 : range.min) != null ? _a : 0,
      max: (_b = range == null ? void 0 : range.max) != null ? _b : 100,
      unit: normalizeUnit(cap.parameters.unit),
      def: (_c = range == null ? void 0 : range.min) != null ? _c : 0,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapColorSetting(cap) {
  var _a, _b, _c;
  if (cap.instance === "colorRgb") {
    return [
      {
        id: "colorRgb",
        name: "Color RGB",
        type: "string",
        role: "level.color.rgb",
        write: true,
        def: "#000000",
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  if (cap.instance === "colorTemperatureK" || cap.instance.includes("colorTem")) {
    const range = cap.parameters.range;
    return [
      {
        id: "colorTemperature",
        name: "Color Temperature",
        type: "number",
        role: "level.color.temperature",
        write: true,
        min: (_a = range == null ? void 0 : range.min) != null ? _a : 2e3,
        max: (_b = range == null ? void 0 : range.max) != null ? _b : 9e3,
        unit: "K",
        def: (_c = range == null ? void 0 : range.min) != null ? _c : 2e3,
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  return [];
}
function mapMode(cap) {
  if (cap.instance !== "presetScene" || !cap.parameters.options) {
    return [];
  }
  const states = {};
  for (const opt of cap.parameters.options) {
    const val = typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value);
    states[val] = opt.name;
  }
  return [
    {
      id: "scene",
      name: "Scene",
      type: "string",
      role: "text",
      write: true,
      states,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapProperty(cap) {
  var _a;
  const instance = cap.instance.toLowerCase();
  let role = "value";
  let unit;
  if (instance.includes("temperature")) {
    role = "value.temperature";
    unit = "\xB0C";
  } else if (instance.includes("humidity")) {
    role = "value.humidity";
    unit = "%";
  } else if (instance.includes("battery")) {
    role = "value.battery";
    unit = "%";
  } else if (instance.includes("co2") || instance.includes("carbondioxide")) {
    role = "value.co2";
    unit = "ppm";
  }
  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "number",
      role,
      write: false,
      unit: (_a = normalizeUnit(cap.parameters.unit)) != null ? _a : unit,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapMusicSetting(cap) {
  const fields = cap.parameters.fields;
  if (!fields || fields.length === 0) {
    return [];
  }
  const states = [];
  const modeField = fields.find((f) => f.fieldName === "musicMode");
  if ((modeField == null ? void 0 : modeField.options) && modeField.options.length > 0) {
    const modeStates = { 0: "---" };
    for (const opt of modeField.options) {
      modeStates[typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value)] = opt.name;
    }
    states.push({
      id: "music_mode",
      name: "Music Mode",
      type: "string",
      role: "text",
      write: true,
      states: modeStates,
      def: "0",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  const sensField = fields.find((f) => f.fieldName === "sensitivity");
  if (sensField == null ? void 0 : sensField.range) {
    states.push({
      id: "music_sensitivity",
      name: "Music Sensitivity",
      type: "number",
      role: "level",
      write: true,
      min: sensField.range.min,
      max: sensField.range.max,
      unit: "%",
      def: sensField.range.max,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  const autoColorField = fields.find((f) => f.fieldName === "autoColor");
  if (autoColorField) {
    states.push({
      id: "music_auto_color",
      name: "Music Auto Color",
      type: "boolean",
      role: "switch",
      write: true,
      def: true,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  return states;
}
const UNIT_MAP = {
  "unit.percent": "%",
  "unit.kelvin": "K",
  "unit.celsius": "\xB0C",
  "unit.fahrenheit": "\xB0F"
};
function normalizeUnit(unit) {
  var _a;
  if (!unit) {
    return void 0;
  }
  return (_a = UNIT_MAP[unit]) != null ? _a : unit;
}
function sanitizeId(str) {
  return str.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}
function humanize(str) {
  return str.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
function mapCloudStateValue(cap) {
  var _a;
  const shortType = cap.type.replace("devices.capabilities.", "");
  const raw = (_a = cap.state) == null ? void 0 : _a.value;
  if (raw === void 0 || raw === null) {
    return null;
  }
  switch (shortType) {
    case "on_off":
      return { stateId: "power", value: raw === 1 };
    case "range":
      return { stateId: sanitizeId(cap.instance), value: raw };
    case "color_setting":
      if (cap.instance === "colorRgb") {
        const num = typeof raw === "number" ? raw : 0;
        const r = num >> 16 & 255;
        const g = num >> 8 & 255;
        const b = num & 255;
        return {
          stateId: "colorRgb",
          value: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
        };
      }
      if (cap.instance.includes("colorTem")) {
        return { stateId: "colorTemperature", value: raw };
      }
      return null;
    case "toggle":
      return { stateId: sanitizeId(cap.instance), value: raw === 1 };
    case "mode":
      if (cap.instance === "presetScene") {
        return {
          stateId: "scene",
          value: typeof raw === "object" || typeof raw === "function" ? JSON.stringify(raw) : String(raw)
        };
      }
      return null;
    case "dynamic_scene":
    case "work_mode":
    case "temperature_setting":
      return {
        stateId: sanitizeId(cap.instance),
        value: typeof raw === "object" || typeof raw === "function" ? JSON.stringify(raw) : String(raw)
      };
    case "music_setting":
      if (typeof raw === "object" && raw !== null) {
        const struct = raw;
        const mode = struct.musicMode;
        return {
          stateId: "music_mode",
          value: typeof mode === "number" ? String(mode) : "0"
        };
      }
      return null;
    case "property":
      return { stateId: sanitizeId(cap.instance), value: raw };
    default:
      return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getDefaultLanStates,
  mapCapabilities,
  mapCloudStateValue
});
//# sourceMappingURL=capability-mapper.js.map
