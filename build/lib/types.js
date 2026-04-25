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
  classifyError: () => classifyError,
  disambiguateLabels: () => disambiguateLabels,
  hexToRgb: () => hexToRgb,
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
  if (msg.includes("401") || msg.includes("403") || msg.includes("Login failed") || msg.includes("auth")) {
    return "AUTH";
  }
  return "UNKNOWN";
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
  const num = parseInt(hex.replace("#", ""), 16) || 0;
  return { r: num >> 16 & 255, g: num >> 8 & 255, b: num & 255 };
}
function rgbIntToHex(rgb) {
  return `#${(rgb & 16777215).toString(16).padStart(6, "0")}`;
}
function parseSegmentList(input, maxIndex) {
  const HARD_MAX = 99;
  if (typeof input !== "string") {
    return { indices: [], error: "Input muss ein String sein" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { indices: [], error: "Liste ist leer" };
  }
  const effectiveMax = Math.min(
    Number.isFinite(maxIndex) && maxIndex >= 0 ? Math.floor(maxIndex) : HARD_MAX,
    HARD_MAX
  );
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
          error: `Ung\xFCltiger Bereich "${part}" (Start > Ende)`
        };
      }
      for (let i = start; i <= end; i++) {
        if (i < 0 || i > effectiveMax) {
          return {
            indices: [],
            error: `Segment ${i} liegt au\xDFerhalb 0-${effectiveMax} f\xFCr dieses Ger\xE4t`
          };
        }
        set.add(i);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return {
        indices: [],
        error: `Ung\xFCltiger Eintrag "${part}" (nur Zahlen und Ranges erlaubt)`
      };
    }
    const idx = parseInt(part, 10);
    if (idx < 0 || idx > effectiveMax) {
      return {
        indices: [],
        error: `Segment ${idx} liegt au\xDFerhalb 0-${effectiveMax} f\xFCr dieses Ger\xE4t`
      };
    }
    set.add(idx);
  }
  if (set.size === 0) {
    return { indices: [], error: "Keine g\xFCltigen Indices in der Liste" };
  }
  return {
    indices: Array.from(set).sort((a, b) => a - b),
    error: null
  };
}
function disambiguateLabels(names) {
  const counts = /* @__PURE__ */ new Map();
  return names.map((name) => {
    var _a;
    const seen = (_a = counts.get(name)) != null ? _a : 0;
    counts.set(name, seen + 1);
    return seen === 0 ? name : `${name} (${seen + 1})`;
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
    const canonical = statesMap[key];
    if (canonical !== void 0) {
      return { key, canonical };
    }
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      return null;
    }
    const directLabel = statesMap[trimmed];
    if (directLabel !== void 0) {
      return { key: trimmed, canonical: directLabel };
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildUniqueLabelMap,
  classifyError,
  disambiguateLabels,
  hexToRgb,
  normalizeDeviceId,
  parseSegmentList,
  resolveStatesValue,
  rgbIntToHex,
  rgbToHex
});
//# sourceMappingURL=types.js.map
