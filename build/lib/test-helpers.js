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
var test_helpers_exports = {};
__export(test_helpers_exports, {
  createCallTracker: () => createCallTracker,
  createTestDevice: () => createTestDevice,
  lightCapabilities: () => lightCapabilities,
  mockLog: () => mockLog,
  mockTimers: () => mockTimers
});
module.exports = __toCommonJS(test_helpers_exports);
const mockLog = {
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  },
  debug: () => {
  },
  silly: () => {
  },
  level: "info"
};
const mockTimers = {
  setInterval: () => void 0,
  clearInterval: () => void 0,
  setTimeout: (cb) => {
    cb();
    return void 0;
  },
  clearTimeout: () => void 0,
  delay: () => Promise.resolve()
};
function lightCapabilities() {
  return [
    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
    {
      type: "devices.capabilities.range",
      instance: "brightness",
      parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } }
    },
    { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
    {
      type: "devices.capabilities.color_setting",
      instance: "colorTemperatureK",
      parameters: { dataType: "INTEGER", range: { min: 2e3, max: 9e3, precision: 1 } }
    },
    { type: "devices.capabilities.dynamic_scene", instance: "lightScene" },
    { type: "devices.capabilities.dynamic_scene", instance: "diyScene" },
    { type: "devices.capabilities.dynamic_scene", instance: "snapshot" },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedColorRgb",
      parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", range: { min: 0, max: 14 } }] }
    },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedBrightness",
      parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", range: { min: 0, max: 14 } }] }
    }
  ];
}
function createTestDevice(overrides = {}) {
  return {
    sku: "H6160",
    deviceId: "AA:BB:CC:DD:EE:FF:00:11",
    name: "Test Device",
    type: "devices.types.light",
    lanIp: "192.168.1.100",
    capabilities: lightCapabilities(),
    scenes: [
      { name: "Sunrise", value: { id: 1, paramId: "sunrise" } },
      { name: "Sunset", value: { id: 2, paramId: "sunset" } }
    ],
    diyScenes: [
      { name: "DIY1", value: { id: 100, paramId: "diy1" } },
      { name: "DIY2", value: { id: 101, paramId: "diy2" } }
    ],
    snapshots: [
      { name: "Snap1", value: 1 },
      { name: "Snap2", value: 2 }
    ],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    lastSeenOnNetwork: Date.now(),
    // A LAN light that counts as reachable has answered — the production paths
    // always set both together (LAN discovery and devStatus). Without the reply
    // stamp this factory produced a device that no real code path can create,
    // and `resolveDeviceReachability` would rightly call it unreachable.
    lastLanReplyAt: Date.now(),
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: false },
    segmentCount: 15,
    ...overrides
  };
}
function createCallTracker() {
  const calls = [];
  return {
    calls,
    track: (method) => (...args) => {
      calls.push({ method, args });
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createCallTracker,
  createTestDevice,
  lightCapabilities,
  mockLog,
  mockTimers
});
//# sourceMappingURL=test-helpers.js.map
