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
var device_baseline_exports = {};
__export(device_baseline_exports, {
  readDeviceBaseline: () => readDeviceBaseline,
  restoreSegmentsGrouped: () => restoreSegmentsGrouped
});
module.exports = __toCommonJS(device_baseline_exports);
async function readDeviceBaseline(surface, device, segDefault) {
  var _a;
  const prefix = surface.devicePrefix(device);
  const ns = surface.namespace;
  const segCount = (_a = device.segmentCount) != null ? _a : 0;
  const segIds = [];
  for (let i = 0; i < segCount; i++) {
    segIds.push(`${ns}.${prefix}.segments.${i}.color`, `${ns}.${prefix}.segments.${i}.brightness`);
  }
  const [power, brightness, colorRgb, colorTemperature, ...segValues] = await Promise.all([
    surface.getState(`${ns}.${prefix}.control.power`).then((s) => s == null ? void 0 : s.val),
    surface.getState(`${ns}.${prefix}.control.brightness`).then((s) => s == null ? void 0 : s.val),
    surface.getState(`${ns}.${prefix}.control.color_rgb`).then((s) => s == null ? void 0 : s.val),
    surface.getState(`${ns}.${prefix}.control.color_temperature`).then((s) => s == null ? void 0 : s.val),
    ...segIds.map((id) => surface.getState(id).then((s) => s == null ? void 0 : s.val))
  ]);
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const c = segValues[i * 2];
    const b = segValues[i * 2 + 1];
    segments.push({
      color: typeof c === "string" ? c : segDefault.color,
      brightness: typeof b === "number" ? b : segDefault.brightness
    });
  }
  return {
    power: typeof power === "boolean" ? power : void 0,
    brightness: typeof brightness === "number" ? brightness : void 0,
    colorRgb: typeof colorRgb === "string" ? colorRgb : void 0,
    colorTemperature: typeof colorTemperature === "number" ? colorTemperature : void 0,
    segments
  };
}
async function restoreSegmentsGrouped(sendCommand, device, segments) {
  const groups = /* @__PURE__ */ new Map();
  for (const seg of segments) {
    const hex = typeof seg.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(seg.color) ? seg.color : "#000000";
    const color = parseInt(hex.replace("#", ""), 16);
    const brightness = typeof seg.brightness === "number" ? seg.brightness : 100;
    const key = `${color}:${brightness}`;
    const existing = groups.get(key);
    if (existing) {
      existing.segments.push(seg.idx);
    } else {
      groups.set(key, { segments: [seg.idx], color, brightness });
    }
  }
  for (const group of groups.values()) {
    await sendCommand(device, "segmentBatch", group);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  readDeviceBaseline,
  restoreSegmentsGrouped
});
//# sourceMappingURL=device-baseline.js.map
