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
var reconciler_exports = {};
__export(reconciler_exports, {
  ABSENT_SOURCE: () => ABSENT_SOURCE,
  DEFAULT_EVICT_THRESHOLD: () => DEFAULT_EVICT_THRESHOLD,
  authoritativeKind: () => authoritativeKind,
  isSensorType: () => isSensorType,
  reconcileAccountMembership: () => reconcileAccountMembership
});
module.exports = __toCommonJS(reconciler_exports);
var import_govee_constants = require("../govee-constants");
const ABSENT_SOURCE = { ok: false, keys: /* @__PURE__ */ new Set() };
const DEFAULT_EVICT_THRESHOLD = 2;
function isSensorType(type) {
  return type === import_govee_constants.GOVEE_DEVICE_TYPE.THERMOMETER || type === import_govee_constants.GOVEE_DEVICE_TYPE.SENSOR || type === "thermometer" || type === "sensor";
}
function authoritativeKind(device) {
  if (device.sku === "BaseGroup") {
    return "group";
  }
  return isSensorType(device.type) ? "app" : "cloud";
}
function reconcileAccountMembership(input) {
  var _a, _b;
  const { sources, devices, keyOf, refreshedSource } = input;
  const threshold = (_a = input.evictThreshold) != null ? _a : DEFAULT_EVICT_THRESHOLD;
  const toEvict = [];
  for (const device of devices) {
    if (device.channels.lan) {
      device.accountMissCount = 0;
      continue;
    }
    const key = keyOf(device.sku, device.deviceId);
    const owned = sources.cloud.ok && sources.cloud.keys.has(key) || sources.app.ok && sources.app.keys.has(key) || sources.group.ok && sources.group.keys.has(key);
    if (owned) {
      device.accountMissCount = 0;
      continue;
    }
    const kind = authoritativeKind(device);
    if (kind !== refreshedSource || !sources[kind].ok) {
      continue;
    }
    device.accountMissCount = ((_b = device.accountMissCount) != null ? _b : 0) + 1;
    if (device.accountMissCount >= threshold) {
      toEvict.push(device);
    }
  }
  return toEvict;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ABSENT_SOURCE,
  DEFAULT_EVICT_THRESHOLD,
  authoritativeKind,
  isSensorType,
  reconcileAccountMembership
});
//# sourceMappingURL=reconciler.js.map
