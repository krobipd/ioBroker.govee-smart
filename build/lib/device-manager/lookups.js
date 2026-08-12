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
var lookups_exports = {};
__export(lookups_exports, {
  SEGMENT_BRIGHTNESS_BITMASK_BYTES: () => SEGMENT_BRIGHTNESS_BITMASK_BYTES,
  SEGMENT_COLOR_BITMASK_BYTES: () => SEGMENT_COLOR_BITMASK_BYTES,
  SEGMENT_COUNT_MAX: () => SEGMENT_COUNT_MAX,
  SEGMENT_HARD_MAX: () => SEGMENT_HARD_MAX,
  deviceKey: () => deviceKey,
  findDeviceBySkuAndId: () => findDeviceBySkuAndId,
  parseMqttSegmentData: () => parseMqttSegmentData,
  resolveSegmentCount: () => resolveSegmentCount
});
module.exports = __toCommonJS(lookups_exports);
var import_types = require("../types");
var import_device_key = require("../device-key");
var import_device_registry = require("../device-registry");
function parseMqttSegmentData(commands) {
  if (!Array.isArray(commands)) {
    return { segments: [], complete: false };
  }
  const segments = [];
  const seenPackets = /* @__PURE__ */ new Set();
  const MAX_SCAN = 512;
  let scanned = 0;
  for (const cmd of commands) {
    if (seenPackets.size >= 5 || scanned >= MAX_SCAN) {
      break;
    }
    scanned++;
    if (typeof cmd !== "string") {
      continue;
    }
    const bytes = Buffer.from(cmd, "base64");
    if (bytes.length < 20 || bytes[0] !== 170 || bytes[1] !== 165) {
      continue;
    }
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= bytes[i];
    }
    if (xor !== bytes[19]) {
      continue;
    }
    const packetNum = bytes[2];
    if (packetNum < 1 || packetNum > 5) {
      continue;
    }
    if (seenPackets.has(packetNum)) {
      continue;
    }
    seenPackets.add(packetNum);
    const baseIndex = (packetNum - 1) * 4;
    for (let slot = 0; slot < 4; slot++) {
      const segIdx = baseIndex + slot;
      const offset = 3 + slot * 4;
      segments.push({
        index: segIdx,
        brightness: bytes[offset],
        r: bytes[offset + 1],
        g: bytes[offset + 2],
        b: bytes[offset + 3]
      });
    }
  }
  let strippedPadding = false;
  while (segments.length > 0) {
    const tail = segments[segments.length - 1];
    const allZero = tail.brightness === 0 && tail.r === 0 && tail.g === 0 && tail.b === 0;
    if (allZero || tail.brightness > 100) {
      segments.pop();
      strippedPadding = true;
    } else {
      break;
    }
  }
  return { segments, complete: strippedPadding };
}
function resolveSegmentCount(device) {
  var _a;
  const override = (_a = (0, import_device_registry.getDeviceQuirks)(device.sku)) == null ? void 0 : _a.segmentCount;
  if (typeof override === "number" && override > 0) {
    return override;
  }
  if (typeof device.segmentCount === "number" && device.segmentCount > 0) {
    return device.segmentCount;
  }
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  let min = Number.POSITIVE_INFINITY;
  for (const c of caps) {
    if (!c || typeof c.type !== "string" || !c.type.includes("segment_color_setting")) {
      continue;
    }
    const params = c.parameters;
    const fields = Array.isArray(params == null ? void 0 : params.fields) ? params.fields : [];
    for (const f of fields) {
      if (!f || typeof f !== "object") {
        continue;
      }
      const fn = f.fieldName;
      const er = f.elementRange;
      const rawMax = er && typeof er.max === "number" ? er.max : -1;
      if (fn === "segment" && rawMax >= 0) {
        const n = rawMax + 1;
        if (n > 0 && n < min) {
          min = n;
        }
      }
    }
  }
  return Number.isFinite(min) ? min : 0;
}
const SEGMENT_HARD_MAX = 55;
const SEGMENT_COUNT_MAX = SEGMENT_HARD_MAX + 1;
const SEGMENT_COLOR_BITMASK_BYTES = 7;
const SEGMENT_BRIGHTNESS_BITMASK_BYTES = 14;
function deviceKey(sku, deviceId) {
  return (0, import_device_key.mapKey)(sku, deviceId);
}
function findDeviceBySkuAndId(devices, sku, deviceId) {
  const direct = devices.get(deviceKey(sku, deviceId));
  if (direct) {
    return direct;
  }
  const normalizedId = (0, import_types.normalizeDeviceId)(deviceId);
  for (const dev of devices.values()) {
    if (dev.sku === sku && (0, import_types.normalizeDeviceId)(dev.deviceId) === normalizedId) {
      return dev;
    }
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SEGMENT_BRIGHTNESS_BITMASK_BYTES,
  SEGMENT_COLOR_BITMASK_BYTES,
  SEGMENT_COUNT_MAX,
  SEGMENT_HARD_MAX,
  deviceKey,
  findDeviceBySkuAndId,
  parseMqttSegmentData,
  resolveSegmentCount
});
//# sourceMappingURL=lookups.js.map
