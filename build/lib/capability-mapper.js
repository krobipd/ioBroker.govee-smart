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
  applyQuirksToStates: () => applyQuirksToStates,
  buildDeviceStateDefs: () => buildDeviceStateDefs,
  getDefaultLanStates: () => getDefaultLanStates,
  mapCapabilities: () => mapCapabilities,
  mapCloudStateValue: () => mapCloudStateValue,
  planCloudCapabilityWrites: () => planCloudCapabilityWrites
});
module.exports = __toCommonJS(capability_mapper_exports);
var import_types = require("./types.js");
var import_device_registry = require("./device-registry.js");
function coerceBool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
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
function mapCapabilities(capabilities) {
  const states = [];
  if (!Array.isArray(capabilities)) {
    return states;
  }
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
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return null;
  }
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
    const range = (_a = cap.parameters) == null ? void 0 : _a.range;
    return [
      {
        id: "colorTemperature",
        name: "Color Temperature",
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
    const val = typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value);
    states[val] = opt.name;
  }
  return [
    {
      id: "scene",
      name: "Scene",
      type: "mixed",
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
        name: "Work Mode",
        type: "mixed",
        role: "level.mode",
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
        modeStates[typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value)] = opt.name;
      }
    }
    states.push({
      id: "work_mode",
      name: "Work Mode",
      type: "mixed",
      role: "level.mode",
      write: true,
      states: modeStates,
      def: modeField.options[0] ? String(modeField.options[0].value) : "",
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
          valStates[typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value)] = opt.name;
        }
      }
      states.push({
        id: "mode_value",
        name: "Mode Value",
        type: "mixed",
        role: "level",
        write: true,
        states: valStates,
        def: valueField.options[0] ? String(valueField.options[0].value) : "",
        capabilityType: cap.type,
        capabilityInstance: cap.instance
      });
    } else if (valueField.range) {
      states.push({
        id: "mode_value",
        name: "Mode Value",
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
          name: "Target Temperature",
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
        name: "Target Temperature",
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
      name: "Target Temperature",
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
function mapMusicSetting(cap) {
  var _a;
  const fields = (_a = cap.parameters) == null ? void 0 : _a.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return [];
  }
  const states = [];
  const modeField = fields.find(
    (f) => f && typeof f.fieldName === "string" && f.fieldName === "musicMode"
  );
  if ((modeField == null ? void 0 : modeField.options) && Array.isArray(modeField.options) && modeField.options.length > 0) {
    const modeStates = { 0: "---" };
    for (const opt of modeField.options) {
      if (!opt || typeof opt.name !== "string") {
        continue;
      }
      modeStates[typeof opt.value === "object" ? JSON.stringify(opt.value) : String(opt.value)] = opt.name;
    }
    states.push({
      id: "music_mode",
      name: "Music Mode",
      type: "mixed",
      role: "text",
      write: true,
      states: modeStates,
      def: "0",
      capabilityType: cap.type,
      capabilityInstance: cap.instance
    });
  }
  const sensField = fields.find(
    (f) => f && typeof f.fieldName === "string" && f.fieldName === "sensitivity"
  );
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
  const autoColorField = fields.find(
    (f) => f && typeof f.fieldName === "string" && f.fieldName === "autoColor"
  );
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
  for (const s of states) {
    s.channel = "music";
  }
  return states;
}
function applyQuirksToStates(sku, states) {
  for (const state of states) {
    if (state.id === "colorTemperature" && state.min != null && state.max != null) {
      const corrected = (0, import_device_registry.applyColorTempQuirk)(sku, state.min, state.max);
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
  return str.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
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
          stateId: "colorRgb",
          value: (0, import_types.rgbToHex)(num >> 16 & 255, num >> 8 & 255, num & 255)
        };
      }
      if (cap.instance.includes("colorTem")) {
        const n = coerceNum(raw);
        if (n === null) {
          return null;
        }
        return { stateId: "colorTemperature", value: n };
      }
      return null;
    case "toggle":
      return { stateId: sanitizeId(cap.instance), value: coerceBool(raw) };
    case "mode":
      if (cap.instance === "presetScene") {
        return {
          stateId: "scene",
          value: typeof raw === "object" || typeof raw === "function" ? JSON.stringify(raw) : String(raw)
        };
      }
      return null;
    case "dynamic_scene":
      return {
        stateId: sanitizeId(cap.instance),
        value: typeof raw === "object" || typeof raw === "function" ? JSON.stringify(raw) : String(raw)
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
function buildDeviceStateDefs(device, localSnapshots, memberDevices) {
  if (device.sku === "BaseGroup") {
    return buildGroupStateDefs(memberDevices || []);
  }
  let stateDefs;
  if (device.lanIp) {
    stateDefs = getDefaultLanStates();
    if (device.capabilities.length > 0) {
      const lanIds = new Set(stateDefs.map((d) => d.id));
      const cloudDefs = mapCapabilities(device.capabilities);
      for (const cd of cloudDefs) {
        if (!lanIds.has(cd.id)) {
          stateDefs.push(cd);
        }
      }
    }
  } else {
    stateDefs = mapCapabilities(device.capabilities);
  }
  applyQuirksToStates(device.sku, stateDefs);
  const isLight = device.type === "devices.types.light";
  if (isLight && device.scenes.length > 0) {
    stateDefs.push({
      id: "light_scene",
      name: "Light Scene",
      // mixed lets users write the index ("1"), the index as number (1),
      // or the scene name ("Aurora") — the onStateChange handler resolves
      // all three forms via the common.states map.
      type: "mixed",
      role: "text",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(device.scenes),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "lightScene",
      channel: "scenes"
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
      } catch {
      }
    }
    return max;
  }, -1);
  if (isLight && maxSpeedLevel > 0) {
    stateDefs.push({
      id: "scene_speed",
      name: "Scene Speed",
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
  if (isLight && device.diyScenes.length > 0) {
    stateDefs.push({
      id: "diy_scene",
      name: "DIY Scene",
      type: "mixed",
      role: "text",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(device.diyScenes),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "diyScene",
      channel: "scenes"
    });
  }
  if (isLight && device.snapshots.length > 0) {
    stateDefs.push({
      id: "snapshot_cloud",
      name: "Cloud Snapshot",
      desc: "Snapshots you saved in the Govee Home app. Selecting one replays that state on the device.",
      type: "mixed",
      role: "text",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(device.snapshots),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "snapshot",
      channel: "snapshots"
    });
  }
  if (isLight) {
    stateDefs.push({
      id: "snapshot_local",
      name: "Local Snapshot",
      desc: "Snapshots saved by this adapter on the ioBroker server. Independent of the Govee Home app.",
      type: "mixed",
      role: "text",
      write: true,
      states: (0, import_types.buildUniqueLabelMap)(localSnapshots != null ? localSnapshots : []),
      def: "0",
      capabilityType: "local",
      capabilityInstance: "snapshotLocal",
      channel: "snapshots"
    });
    stateDefs.push({
      id: "snapshot_save",
      name: "Save Local Snapshot",
      desc: "Write a name to save the current device state (power, brightness, colour, per-segment colours) as a new local snapshot.",
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
      name: "Delete Local Snapshot",
      desc: "Write a local snapshot name to delete it. Does not affect Govee Home app snapshots.",
      type: "string",
      role: "text",
      write: true,
      def: "",
      capabilityType: "local",
      capabilityInstance: "snapshotDelete",
      channel: "snapshots"
    });
  }
  stateDefs.push({
    id: "diagnostics_export",
    name: "Export Diagnostics",
    type: "boolean",
    role: "button",
    write: true,
    def: false,
    capabilityType: "local",
    capabilityInstance: "diagnosticsExport",
    channel: "info"
  });
  stateDefs.push({
    id: "diagnostics_result",
    name: "Diagnostics JSON",
    type: "string",
    role: "json",
    write: false,
    def: "",
    capabilityType: "local",
    capabilityInstance: "diagnosticsResult",
    channel: "info"
  });
  return stateDefs;
}
function memberHasControlState(member, stateId) {
  if (member.lanIp) {
    return true;
  }
  const caps = Array.isArray(member.capabilities) ? member.capabilities : [];
  switch (stateId) {
    case "power":
      return caps.some(
        (c) => c && typeof c.type === "string" && c.type.endsWith("on_off")
      );
    case "brightness":
      return caps.some(
        (c) => c && typeof c.type === "string" && typeof c.instance === "string" && c.type.endsWith("range") && c.instance === "brightness"
      );
    case "colorRgb":
      return caps.some(
        (c) => c && typeof c.type === "string" && typeof c.instance === "string" && c.type.endsWith("color_setting") && c.instance === "colorRgb"
      );
    case "colorTemperature":
      return caps.some(
        (c) => c && typeof c.type === "string" && typeof c.instance === "string" && c.type.endsWith("color_setting") && (c.instance === "colorTem" || c.instance === "colorTemperatureK")
      );
    default:
      return false;
  }
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
    const commonNames = firstNames.filter(
      (name) => controllable.every((m) => m.scenes.some((s) => s.name === name))
    );
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "light_scene",
        name: "Light Scene",
        type: "mixed",
        role: "text",
        write: true,
        states: (0, import_types.buildUniqueLabelMap)(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: "devices.capabilities.dynamic_scene",
        capabilityInstance: "lightScene",
        channel: "scenes"
      });
    }
  }
  if (controllable.every((m) => m.musicLibrary.length > 0)) {
    const firstNames = controllable[0].musicLibrary.map((m) => m.name);
    const commonNames = firstNames.filter(
      (name) => controllable.every((m) => m.musicLibrary.some((ml) => ml.name === name))
    );
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "music_mode",
        name: "Music Mode",
        type: "mixed",
        role: "text",
        write: true,
        states: (0, import_types.buildUniqueLabelMap)(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: "devices.capabilities.music_setting",
        capabilityInstance: "musicMode",
        channel: "music"
      });
    }
  }
  return stateDefs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyQuirksToStates,
  buildDeviceStateDefs,
  getDefaultLanStates,
  mapCapabilities,
  mapCloudStateValue,
  planCloudCapabilityWrites
});
//# sourceMappingURL=capability-mapper.js.map
