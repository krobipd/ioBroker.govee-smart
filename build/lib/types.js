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
var types_exports = {};
__export(types_exports, {
  buildUniqueLabelMap: () => buildUniqueLabelMap,
  capMatchesControl: () => capMatchesControl,
  clampByte: () => clampByte,
  classifyError: () => classifyError,
  coerceFiniteNumber: () => coerceFiniteNumber,
  deviceLabel: () => deviceLabel,
  disambiguateLabels: () => disambiguateLabels,
  errMessage: () => errMessage,
  formatGatewayLabel: () => formatGatewayLabel,
  hexToRgb: () => hexToRgb,
  logDedup: () => logDedup,
  maskSecret: () => maskSecret,
  normalizeDeviceId: () => normalizeDeviceId,
  parseSegmentList: () => parseSegmentList,
  resolveStatesValue: () => resolveStatesValue,
  rgbIntToHex: () => rgbIntToHex,
  rgbToHex: () => rgbToHex
});
module.exports = __toCommonJS(types_exports);
function normalizeDeviceId(id) {
  if (typeof id !== "string") {
    return "";
  }
  return id.replace(/:/g, "").toLowerCase();
}
function deviceLabel(device) {
  const name = typeof device.name === "string" ? device.name.trim() : "";
  return name && name !== device.sku ? `${name} (${device.sku})` : device.sku;
}
function formatGatewayLabel(gatewayInfo) {
  if (!gatewayInfo || typeof gatewayInfo !== "object") {
    return void 0;
  }
  const sku = typeof gatewayInfo.sku === "string" ? gatewayInfo.sku.trim() : "";
  if (!sku) {
    return void 0;
  }
  const bleName = typeof gatewayInfo.bleName === "string" ? gatewayInfo.bleName.trim() : "";
  return bleName ? `${sku} (${bleName})` : sku;
}
function classifyError(err) {
  if (err instanceof Error) {
    const code = err.code;
    if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "ENETUNREACH" || code === "ECONNRESET" || code === "EAI_AGAIN") {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
      return "TIMEOUT";
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("ENETUNREACH") || msg.includes("ECONNRESET")) {
    return "NETWORK";
  }
  if (msg.includes("Timeout")) {
    return "TIMEOUT";
  }
  if (msg.includes("429") || msg.includes("Rate limit") || msg.includes("Rate limited")) {
    return "RATE_LIMIT";
  }
  if (msg.includes("Verification required") || msg.includes("status 454") && !msg.includes("invalid")) {
    return "VERIFICATION_PENDING";
  }
  if (msg.includes("Verification code invalid") || msg.includes("status 455")) {
    return "VERIFICATION_FAILED";
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("Login failed") || msg.includes("auth")) {
    return "AUTH";
  }
  return "UNKNOWN";
}
function errMessage(e) {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
function maskSecret(secret) {
  if (typeof secret !== "string" || secret.length <= 4) {
    return "***";
  }
  return `${secret.slice(0, 4)}***`;
}
function coerceFiniteNumber(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function logDedup(log, last, context, err) {
  const category = classifyError(err);
  const msg = errMessage(err);
  if (category !== last) {
    log.warn(`${context}: ${msg}`);
  } else {
    log.debug(`${context}: ${msg} (repeated)`);
  }
  return category;
}
function clampByte(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
function rgbToHex(r, g, b) {
  const rr = clampByte(r).toString(16).padStart(2, "0");
  const gg = clampByte(g).toString(16).padStart(2, "0");
  const bb = clampByte(b).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}
function hexToRgb(hex) {
  if (typeof hex !== "string") {
    return { r: 0, g: 0, b: 0 };
  }
  const cleaned = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return { r: 0, g: 0, b: 0 };
  }
  const num = parseInt(cleaned, 16) || 0;
  return { r: num >> 16 & 255, g: num >> 8 & 255, b: num & 255 };
}
function rgbIntToHex(rgb) {
  return `#${(rgb & 16777215).toString(16).padStart(6, "0")}`;
}
function parseSegmentList(input, maxIndex) {
  const HARD_MAX = 55;
  if (typeof input !== "string") {
    return { indices: [], error: "input must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { indices: [], error: "list is empty" };
  }
  const effectiveMax = Math.min(Number.isFinite(maxIndex) && maxIndex >= 0 ? Math.floor(maxIndex) : HARD_MAX, HARD_MAX);
  const set = /* @__PURE__ */ new Set();
  const parts = trimmed.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") {
      continue;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) {
        return {
          indices: [],
          error: `invalid range "${part}" (start > end)`
        };
      }
      for (let i = start; i <= end; i++) {
        if (i < 0 || i > effectiveMax) {
          return {
            indices: [],
            error: `segment ${i} is outside 0-${effectiveMax} for this device`
          };
        }
        set.add(i);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return {
        indices: [],
        error: `invalid entry "${part}" (only digits and ranges allowed)`
      };
    }
    const idx = parseInt(part, 10);
    if (idx < 0 || idx > effectiveMax) {
      return {
        indices: [],
        error: `segment ${idx} is outside 0-${effectiveMax} for this device`
      };
    }
    set.add(idx);
  }
  if (set.size === 0) {
    return { indices: [], error: "no valid indices in list" };
  }
  return {
    indices: Array.from(set).sort((a, b) => a - b),
    error: null
  };
}
function disambiguateLabels(names) {
  const counts = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  return names.map((name) => {
    var _a;
    let n = (_a = counts.get(name)) != null ? _a : 0;
    let label = n === 0 ? name : `${name} (${n + 1})`;
    while (used.has(label)) {
      n += 1;
      label = `${name} (${n + 1})`;
    }
    counts.set(name, n + 1);
    used.add(label);
    return label;
  });
}
function buildUniqueLabelMap(items, zeroLabel = "---") {
  const labels = disambiguateLabels(items.map((item) => item.name));
  const result = { 0: zeroLabel };
  labels.forEach((label, i) => {
    result[String(i + 1)] = label;
  });
  return result;
}
function resolveStatesValue(input, statesMap) {
  if (typeof input === "number" && Number.isFinite(input)) {
    const key = String(input);
    if (Object.prototype.hasOwnProperty.call(statesMap, key)) {
      return { key, canonical: statesMap[key] };
    }
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(statesMap, trimmed)) {
      return { key: trimmed, canonical: statesMap[trimmed] };
    }
    const needle = trimmed.toLowerCase();
    for (const [key, label] of Object.entries(statesMap)) {
      if (typeof label === "string" && label.trim().toLowerCase() === needle) {
        return { key, canonical: label };
      }
    }
  }
  return null;
}
function capMatchesControl(cap, kind) {
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return false;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");
  const inst = cap.instance;
  switch (kind) {
    case "power":
      return shortType === "on_off";
    case "brightness":
      return shortType === "range" && inst.toLowerCase().includes("brightness");
    case "colorRgb":
      return shortType === "color_setting" && inst === "colorRgb";
    case "colorTemperature":
      return shortType === "color_setting" && inst.includes("colorTem");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildUniqueLabelMap,
  capMatchesControl,
  clampByte,
  classifyError,
  coerceFiniteNumber,
  deviceLabel,
  disambiguateLabels,
  errMessage,
  formatGatewayLabel,
  hexToRgb,
  logDedup,
  maskSecret,
  normalizeDeviceId,
  parseSegmentList,
  resolveStatesValue,
  rgbIntToHex,
  rgbToHex
});
//# sourceMappingURL=types.js.map
