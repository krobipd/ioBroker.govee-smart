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
  LAN_STATE_IDS: () => LAN_STATE_IDS,
  applyQuirksToStates: () => applyQuirksToStates,
  buildCloudStateDefs: () => buildCloudStateDefs,
  buildLanStateDefs: () => buildLanStateDefs,
  getDefaultLanStates: () => getDefaultLanStates,
  getMusicModeOptions: () => getMusicModeOptions,
  hasDynamicSceneCapability: () => hasDynamicSceneCapability,
  mapCapabilities: () => mapCapabilities,
  mapCloudStateValue: () => mapCloudStateValue,
  musicModeNameUsesRgb: () => musicModeNameUsesRgb,
  planCloudCapabilityWrites: () => planCloudCapabilityWrites
});
module.exports = __toCommonJS(capability_mapper_exports);
var import_types = require("./types");
var import_device_registry = require("./device-registry");
var import_govee_constants = require("./govee-constants");
var import_i18n = require("./i18n");
function coerceBool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}
function safeStringify(v) {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return v.toString();
    case "undefined":
      return "undefined";
    default:
      return JSON.stringify(v);
  }
}
function coerceNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}
function mapCapabilities(capabilities, log) {
  var _a, _b;
  const states = [];
  if (!Array.isArray(capabilities)) {
    return states;
  }
  let mapped = 0;
  let skipped = 0;
  for (const cap of capabilities) {
    const result = mapSingleCapability(cap);
    if (result) {
      states.push(...result);
      mapped++;
    } else {
      skipped++;
      log.debug(
        `Cap skipped: type=${(_a = cap == null ? void 0 : cap.type) != null ? _a : "?"} instance=${(_b = cap == null ? void 0 : cap.instance) != null ? _b : "?"} \u2014 no mapping (capability not handled or malformed)`
      );
    }
  }
  log.debug(`mapCapabilities: ${mapped} mapped, ${skipped} skipped, ${states.length} state def(s) produced`);
  return states;
}
function hasDynamicSceneCapability(capabilities, instance) {
  if (!Array.isArray(capabilities)) {
    return false;
  }
  return capabilities.some(
    (cap) => typeof (cap == null ? void 0 : cap.type) === "string" && typeof (cap == null ? void 0 : cap.instance) === "string" && (cap.type === import_govee_constants.GOVEE_CAP_TYPE.DYNAMIC_SCENE || cap.type === "dynamic_scene") && cap.instance === instance
  );
}
const LAN_STATE_IDS = /* @__PURE__ */ new Set(["power", "brightness", "color_rgb", "color_temperature"]);
function getDefaultLanStates() {
  return [
    {
      id: "power",
      name: (0, import_i18n.tName)("power"),
      type: "boolean",
      role: "switch",
      write: true,
      def: false,
      capabilityType: "lan",
      capabilityInstance: "powerSwitch"
    },
    {
      id: "brightness",
      name: (0, import_i18n.tName)("brightness"),
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
      id: "color_rgb",
      name: (0, import_i18n.tName)("colorRgb"),
      type: "string",
      role: "level.color.rgb",
      write: true,
      def: "#000000",
      capabilityType: "lan",
      capabilityInstance: "colorRgb"
    },
    {
      id: "color_temperature",
      name: (0, import_i18n.tName)("colorTemperature"),
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
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return null;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");
  switch (shortType) {
    case "on_off":
      return [
        {
          id: "power",
          name: (0, import_i18n.tName)("power"),
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
      if (cap.instance === "lightScene" || cap.instance === "diyScene" || cap.instance === "snapshot") {
        return null;
      }
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
    case "work_mode":
      return mapWorkMode(cap);
    case "temperature_setting":
      return mapTemperatureSetting(cap);
    case "event":
      return mapEvent(cap);
    case "music_setting":
      return mapMusicSetting(cap);
    default:
      return null;
  }
}
function mapRange(cap) {
  var _a, _b, _c, _d, _e;
  const range = (_a = cap.parameters) == null ? void 0 : _a.range;
  const isBrightness = cap.instance.toLowerCase().includes("brightness");
  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "number",
      role: isBrightness ? "level.brightness" : "level",
      write: true,
      min: (_b = range == null ? void 0 : range.min) != null ? _b : 0,
      max: (_c = range == null ? void 0 : range.max) != null ? _c : 100,
      unit: normalizeUnit((_d = cap.parameters) == null ? void 0 : _d.unit),
      def: (_e = range == null ? void 0 : range.min) != null ? _e : 0,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapColorSetting(cap) {
  var _a, _b, _c, _d;
  if (cap.instance === "colorRgb") {
    return [
      {
        id: "color_rgb",
        name: (0, import_i18n.tName)("colorRgb"),
        type: "string",
        role: "level.color.rgb",
        write: true,
        def: "#000000",
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  if (cap.instance.includes("colorTem")) {
    const range = (_a = cap.parameters) == null ? void 0 : _a.range;
    return [
      {
        id: "color_temperature",
        name: (0, import_i18n.tName)("colorTemperature"),
        type: "number",
        role: "level.color.temperature",
        write: true,
        min: (_b = range == null ? void 0 : range.min) != null ? _b : 2e3,
        max: (_c = range == null ? void 0 : range.max) != null ? _c : 9e3,
        unit: "K",
        def: (_d = range == null ? void 0 : range.min) != null ? _d : 2e3,
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  return [];
}
function mapMode(cap) {
  var _a;
  if (cap.instance !== "presetScene" || !Array.isArray((_a = cap.parameters) == null ? void 0 : _a.options)) {
    return [];
  }
  const states = {};
  for (const opt of cap.parameters.options) {
    if (!opt || typeof opt.name !== "string") {
      continue;
    }
    const val = safeStringify(opt.value);
    states[val] = opt.name;
  }
  return [
    {
      id: "scene",
      name: (0, import_i18n.tName)("scene"),
      type: "mixed",
      role: "state",
      write: true,
      states,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapProperty(cap) {
  var _a, _b;
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
      unit: (_b = normalizeUnit((_a = cap.parameters) == null ? void 0 : _a.unit)) != null ? _b : unit,
      def: 0,
      // avoid null in vis until the first sensor reading (consistency — B11)
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
      channel: "sensor"
    }
  ];
}
function mapWorkMode(cap) {
  var _a;
  const fields = (_a = cap.parameters) == null ? void 0 : _a.fields;
  if (!fields || fields.length === 0) {
    return [
      {
        id: "work_mode",
        name: (0, import_i18n.tName)("workMode"),
        type: "mixed",
        role: "level.mode.work",
        write: true,
        def: "",
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  const states = [];
  const modeField = fields.find((f) => f && f.fieldName === "workMode");
  if ((modeField == null ? void 0 : modeField.options) && modeField.options.length > 0) {
    const modeStates = {};
    for (const opt of modeField.options) {
      if (opt && typeof opt.name === "string") {
        modeStates[safeStringify(opt.value)] = opt.name;
      }
    }
    states.push({
      id: "work_mode",
      name: (0, import_i18n.tName)("workMode"),
      type: "mixed",
      role: "level.mode.work",
      write: true,
      states: modeStates,
      def: modeField.options[0] ? safeStringify(modeField.options[0].value) : "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  const valueField = fields.find((f) => f && f.fieldName === "modeValue");
  if (valueField) {
    if (valueField.options && valueField.options.length > 0) {
      const valStates = {};
      for (const opt of valueField.options) {
        if (opt && typeof opt.name === "string") {
          valStates[safeStringify(opt.value)] = opt.name;
        }
      }
      states.push({
        id: "mode_value",
        name: (0, import_i18n.tName)("modeValue"),
        type: "mixed",
        role: "state",
        write: true,
        states: valStates,
        def: valueField.options[0] ? safeStringify(valueField.options[0].value) : "",
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      });
    } else if (valueField.range) {
      states.push({
        id: "mode_value",
        name: (0, import_i18n.tName)("modeValue"),
        type: "number",
        role: "level",
        write: true,
        min: valueField.range.min,
        max: valueField.range.max,
        def: valueField.range.min,
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      });
    }
  }
  return states;
}
function mapTemperatureSetting(cap) {
  var _a, _b, _c, _d, _e, _f;
  const fields = (_a = cap.parameters) == null ? void 0 : _a.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    const tempField = fields.find((f) => {
      if (!f || typeof f.fieldName !== "string") {
        return false;
      }
      if (f.fieldName === "targetTemperature") {
        return true;
      }
      return f.fieldName.toLowerCase().includes("temperature");
    });
    if (tempField == null ? void 0 : tempField.range) {
      const unit = (_c = normalizeUnit((_b = cap.parameters) == null ? void 0 : _b.unit)) != null ? _c : "\xB0F";
      return [
        {
          id: "target_temperature",
          name: (0, import_i18n.tName)("targetTemperature"),
          type: "number",
          role: "level.temperature",
          write: true,
          min: tempField.range.min,
          max: tempField.range.max,
          unit,
          def: tempField.range.min,
          capabilityType: cap.type,
          capabilityInstance: cap.instance
        }
      ];
    }
  }
  const range = (_d = cap.parameters) == null ? void 0 : _d.range;
  if (range) {
    const unit = (_f = normalizeUnit((_e = cap.parameters) == null ? void 0 : _e.unit)) != null ? _f : "\xB0F";
    return [
      {
        id: "target_temperature",
        name: (0, import_i18n.tName)("targetTemperature"),
        type: "number",
        role: "level.temperature",
        write: true,
        min: range.min,
        max: range.max,
        unit,
        def: range.min,
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      }
    ];
  }
  return [
    {
      id: "target_temperature",
      name: (0, import_i18n.tName)("targetTemperature"),
      type: "string",
      role: "json",
      write: true,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    }
  ];
}
function mapEvent(cap) {
  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "boolean",
      role: "indicator.alarm",
      write: false,
      def: false,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
      channel: "events"
    }
  ];
}
function musicModeNameUsesRgb(name) {
  if (typeof name !== "string") {
    return false;
  }
  const n = name.trim().toLowerCase();
  return n === "spectrum" || n === "rolling";
}
function getMusicModeOptions(cap) {
  var _a;
  const fields = (_a = cap.parameters) == null ? void 0 : _a.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  const modeField = fields.find((f) => f && typeof f.fieldName === "string" && f.fieldName === "musicMode");
  if (!(modeField == null ? void 0 : modeField.options) || !Array.isArray(modeField.options)) {
    return [];
  }
  return modeField.options.filter((o) => !!o && typeof o.name === "string");
}
function mapMusicSetting(cap) {
  var _a;
  const fields = (_a = cap.parameters) == null ? void 0 : _a.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return [];
  }
  const states = [];
  const modeOptions = getMusicModeOptions(cap);
  if (modeOptions.length > 0) {
    states.push({
      id: "music_mode",
      name: (0, import_i18n.tName)("musicMode"),
      type: "mixed",
      role: "state",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(modeOptions),
      def: "0",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  const sensField = fields.find((f) => f && typeof f.fieldName === "string" && f.fieldName === "sensitivity");
  if (sensField == null ? void 0 : sensField.range) {
    states.push({
      id: "music_sensitivity",
      name: (0, import_i18n.tName)("musicSensitivity"),
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
  const autoColorField = fields.find((f) => f && typeof f.fieldName === "string" && f.fieldName === "autoColor");
  if (autoColorField) {
    states.push({
      id: "music_auto_color",
      name: (0, import_i18n.tName)("musicAutoColor"),
      type: "boolean",
      role: "switch",
      write: true,
      def: true,
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  for (const s of states) {
    s.channel = "music";
  }
  return states;
}
function applyQuirksToStates(sku, states, log) {
  for (const state of states) {
    if (state.id === "color_temperature" && state.min != null && state.max != null) {
      const corrected = (0, import_device_registry.applyColorTempQuirk)(sku, state.min, state.max);
      if (corrected.min !== state.min || corrected.max !== state.max) {
        log.debug(
          `Quirk applied for ${sku}: color_temperature range ${state.min}-${state.max}K \u2192 ${corrected.min}-${corrected.max}K`
        );
      }
      state.min = corrected.min;
      state.max = corrected.max;
      state.def = corrected.min;
    }
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
  return str.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().replace(/^./, (c) => c.toUpperCase());
}
function mapCloudStateValue(cap) {
  var _a, _b, _c, _d;
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return null;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");
  const raw = (_a = cap.state) == null ? void 0 : _a.value;
  if (raw === void 0 || raw === null) {
    return null;
  }
  switch (shortType) {
    case "on_off":
      return { stateId: "power", value: coerceBool(raw) };
    case "range": {
      const n = coerceNum(raw);
      if (n === null) {
        return null;
      }
      return { stateId: sanitizeId(cap.instance), value: n };
    }
    case "color_setting":
      if (cap.instance === "colorRgb") {
        const num = (_b = coerceNum(raw)) != null ? _b : 0;
        return {
          stateId: "color_rgb",
          value: (0, import_types.rgbToHex)(num >> 16 & 255, num >> 8 & 255, num & 255)
        };
      }
      if (cap.instance.includes("colorTem")) {
        const n = coerceNum(raw);
        if (n === null) {
          return null;
        }
        return { stateId: "color_temperature", value: n };
      }
      return null;
    case "toggle":
      return { stateId: sanitizeId(cap.instance), value: coerceBool(raw) };
    case "mode":
      if (cap.instance === "presetScene") {
        return {
          stateId: "scene",
          value: safeStringify(raw)
        };
      }
      return null;
    case "dynamic_scene":
      if (cap.instance === "snapshot") {
        return null;
      }
      return {
        stateId: sanitizeId(cap.instance),
        value: safeStringify(raw)
      };
    case "work_mode": {
      if (typeof raw === "object" && raw !== null) {
        const struct = raw;
        const n = coerceNum(struct.workMode);
        if (n !== null) {
          return { stateId: "work_mode", value: n };
        }
      }
      const direct = coerceNum(raw);
      if (direct !== null) {
        return { stateId: "work_mode", value: direct };
      }
      return null;
    }
    case "temperature_setting": {
      const direct = coerceNum(raw);
      if (direct !== null) {
        return { stateId: "target_temperature", value: direct };
      }
      if (typeof raw === "object" && raw !== null) {
        const struct = raw;
        const temp = (_d = (_c = struct.targetTemperature) != null ? _c : struct.temperature) != null ? _d : struct.temp;
        const n = coerceNum(temp);
        if (n !== null) {
          return { stateId: "target_temperature", value: n };
        }
      }
      return null;
    }
    case "event":
      return {
        stateId: sanitizeId(cap.instance),
        value: coerceBool(raw)
      };
    case "music_setting":
      if (typeof raw === "object" && raw !== null) {
        const struct = raw;
        const mode = coerceNum(struct.musicMode);
        return {
          stateId: "music_mode",
          value: mode !== null ? String(mode) : "0"
        };
      }
      return null;
    case "property": {
      const n = coerceNum(raw);
      if (n === null) {
        return null;
      }
      return { stateId: sanitizeId(cap.instance), value: n };
    }
    default:
      return null;
  }
}
function planCloudCapabilityWrites(caps, hasLanIp, lanStateIds) {
  const writes = [];
  if (!Array.isArray(caps)) {
    return writes;
  }
  for (const cap of caps) {
    const mapped = mapCloudStateValue(cap);
    if (!mapped) {
      continue;
    }
    if (hasLanIp && lanStateIds.has(mapped.stateId)) {
      continue;
    }
    writes.push(mapped);
  }
  return writes;
}
const SCENE_DROPDOWN_RULES = [
  { id: "light_scene", cap: "lightScene", nameKey: "lightScene", channel: "scenes", source: (d) => d.scenes },
  { id: "diy_scene", cap: "diyScene", nameKey: "diyScene", channel: "scenes", source: (d) => d.diyScenes },
  {
    id: "snapshot_cloud",
    cap: "snapshot",
    nameKey: "cloudSnapshot",
    descKey: "cloudSnapshotDesc",
    channel: "snapshots",
    source: (d) => d.snapshots
  }
];
function buildLanStateDefs(device, log) {
  if (!device.lanIp) {
    return [];
  }
  const stateDefs = getDefaultLanStates();
  applyQuirksToStates(device.sku, stateDefs, log);
  return stateDefs;
}
function buildDiagStateDefs(tierDef) {
  const defs = [
    {
      id: "export",
      name: (0, import_i18n.tName)("exportDiagnostics"),
      type: "boolean",
      role: "button",
      write: true,
      def: false,
      capabilityType: "local",
      capabilityInstance: "diagnosticsExport",
      channel: "diag"
    },
    {
      id: "result",
      name: (0, import_i18n.tName)("diagnosticsJson"),
      type: "string",
      role: "json",
      write: false,
      def: "",
      capabilityType: "local",
      capabilityInstance: "diagnosticsResult",
      channel: "diag"
    }
  ];
  if (tierDef !== null) {
    defs.push({
      id: "tier",
      name: (0, import_i18n.tName)("deviceTier"),
      type: "string",
      role: "text",
      write: false,
      def: tierDef,
      states: {
        verified: (0, import_i18n.resolveLabel)("deviceTierVerified"),
        reported: (0, import_i18n.resolveLabel)("deviceTierReported"),
        seed: (0, import_i18n.resolveLabel)("deviceTierSeed"),
        unknown: (0, import_i18n.resolveLabel)("deviceTierUnknown")
      },
      capabilityType: "local",
      capabilityInstance: "diagnosticsTier",
      channel: "diag"
    });
  }
  return defs;
}
function buildCloudStateDefs(device, log, localSnapshots, memberDevices) {
  if (device.sku === "BaseGroup") {
    return buildGroupStateDefs(memberDevices || []);
  }
  const quirks = (0, import_device_registry.getDeviceQuirks)(device.sku);
  const skipCapabilities = (quirks == null ? void 0 : quirks.brokenPlatformApi) === true;
  const noLanPhase = !device.lanIp;
  const stateDefs = skipCapabilities ? [] : mapCapabilities(device.capabilities, log).filter((d) => noLanPhase || !LAN_STATE_IDS.has(d.id));
  if (skipCapabilities) {
    log.debug(`${device.sku}: brokenPlatformApi quirk active \u2014 skipping capability-derived states + dropdowns`);
  }
  applyQuirksToStates(device.sku, stateDefs, log);
  const isLight = device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT;
  for (const r of SCENE_DROPDOWN_RULES) {
    if (skipCapabilities || !isLight || !hasDynamicSceneCapability(device.capabilities, r.cap)) {
      continue;
    }
    stateDefs.push({
      id: r.id,
      name: (0, import_i18n.tName)(r.nameKey),
      desc: r.descKey ? (0, import_i18n.tDesc)(r.descKey) : void 0,
      // mixed lets users write the index ("1"), the index as number (1),
      // or the entry name ("Aurora") — the onStateChange handler resolves
      // all three forms via the common.states map.
      type: "mixed",
      role: "state",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(r.source(device)),
      def: "0",
      capabilityType: import_govee_constants.GOVEE_CAP_TYPE.DYNAMIC_SCENE,
      capabilityInstance: r.cap,
      channel: r.channel
    });
  }
  const maxSpeedLevel = device.sceneLibrary.reduce((max, entry) => {
    var _a;
    if (((_a = entry.speedInfo) == null ? void 0 : _a.supSpeed) && entry.speedInfo.config) {
      try {
        const parsed = JSON.parse(entry.speedInfo.config);
        if (!Array.isArray(parsed)) {
          return max;
        }
        for (const cfg of parsed) {
          if (cfg && Array.isArray(cfg.moveIn) && cfg.moveIn.length - 1 > max) {
            max = cfg.moveIn.length - 1;
          }
        }
      } catch (e) {
        log.debug(`${device.sku}: speed-config parse failed for scene "${entry.name}": ${(0, import_types.errMessage)(e)}`);
      }
    }
    return max;
  }, -1);
  if (isLight && maxSpeedLevel > 0) {
    stateDefs.push({
      id: "scene_speed",
      name: (0, import_i18n.tName)("sceneSpeed"),
      type: "number",
      role: "level",
      write: true,
      min: 0,
      max: maxSpeedLevel,
      def: 0,
      capabilityType: "local",
      capabilityInstance: "sceneSpeed",
      channel: "scenes"
    });
  }
  if (!skipCapabilities && isLight && (hasDynamicSceneCapability(device.capabilities, "lightScene") || hasDynamicSceneCapability(device.capabilities, "diyScene") || hasDynamicSceneCapability(device.capabilities, "snapshot"))) {
    stateDefs.push({
      id: "refresh_cloud",
      name: (0, import_i18n.tName)("refreshCloud"),
      desc: (0, import_i18n.tDesc)("refreshCloudDesc"),
      type: "boolean",
      role: "button",
      write: true,
      def: false,
      capabilityType: "local",
      capabilityInstance: "refreshCloud",
      channel: "snapshots"
    });
  }
  if (isLight) {
    stateDefs.push({
      id: "snapshot_local",
      name: (0, import_i18n.tName)("localSnapshot"),
      desc: (0, import_i18n.tDesc)("localSnapshotDesc"),
      type: "mixed",
      role: "state",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(localSnapshots != null ? localSnapshots : []),
      def: "0",
      capabilityType: "local",
      capabilityInstance: "snapshotLocal",
      channel: "snapshots"
    });
    stateDefs.push({
      id: "snapshot_save",
      name: (0, import_i18n.tName)("saveLocalSnapshot"),
      desc: (0, import_i18n.tDesc)("saveLocalSnapshotDesc"),
      type: "string",
      role: "text",
      write: true,
      def: "",
      capabilityType: "local",
      capabilityInstance: "snapshotSave",
      channel: "snapshots"
    });
    stateDefs.push({
      id: "snapshot_delete",
      name: (0, import_i18n.tName)("deleteLocalSnapshot"),
      desc: (0, import_i18n.tDesc)("deleteLocalSnapshotDesc"),
      type: "string",
      role: "text",
      write: true,
      def: "",
      capabilityType: "local",
      capabilityInstance: "snapshotDelete",
      channel: "snapshots"
    });
  }
  stateDefs.push(...buildDiagStateDefs("unknown"));
  return stateDefs;
}
const CONTROL_STATE_ID_TO_KIND = {
  power: "power",
  brightness: "brightness",
  color_rgb: "colorRgb",
  color_temperature: "colorTemperature"
};
function memberHasControlState(member, stateId) {
  if (member.lanIp) {
    return true;
  }
  const kind = CONTROL_STATE_ID_TO_KIND[stateId];
  if (!kind) {
    return false;
  }
  const caps = Array.isArray(member.capabilities) ? member.capabilities : [];
  return caps.some((c) => (0, import_types.capMatchesControl)(c, kind));
}
function buildGroupStateDefs(members) {
  const controllable = members.filter((m) => m.lanIp || m.channels.cloud);
  if (controllable.length === 0) {
    return [];
  }
  const stateDefs = [];
  for (const ld of getDefaultLanStates()) {
    if (controllable.every((m) => memberHasControlState(m, ld.id))) {
      stateDefs.push(ld);
    }
  }
  if (controllable.every((m) => m.scenes.length > 0)) {
    const firstNames = controllable[0].scenes.map((s) => s.name);
    const commonNames = firstNames.filter((name) => controllable.every((m) => m.scenes.some((s) => s.name === name)));
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "light_scene",
        name: (0, import_i18n.tName)("lightScene"),
        type: "mixed",
        role: "state",
        write: true,
        states: (0, import_types.buildUniqueLabelMap)(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: import_govee_constants.GOVEE_CAP_TYPE.DYNAMIC_SCENE,
        capabilityInstance: "lightScene",
        channel: "scenes"
      });
    }
  }
  if (controllable.every((m) => m.musicLibrary.length > 0)) {
    const firstNames = controllable[0].musicLibrary.map((m) => m.name);
    const commonNames = firstNames.filter((name) => controllable.every((m) => m.musicLibrary.some((ml) => ml.name === name)));
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "music_mode",
        name: (0, import_i18n.tName)("musicMode"),
        type: "mixed",
        role: "state",
        write: true,
        states: (0, import_types.buildUniqueLabelMap)(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: import_govee_constants.GOVEE_CAP_TYPE.MUSIC_SETTING,
        capabilityInstance: "musicMode",
        channel: "music"
      });
    }
  }
  stateDefs.push(...buildDiagStateDefs(null));
  return stateDefs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LAN_STATE_IDS,
  applyQuirksToStates,
  buildCloudStateDefs,
  buildLanStateDefs,
  getDefaultLanStates,
  getMusicModeOptions,
  hasDynamicSceneCapability,
  mapCapabilities,
  mapCloudStateValue,
  musicModeNameUsesRgb,
  planCloudCapabilityWrites
});
//# sourceMappingURL=capability-mapper.js.map
