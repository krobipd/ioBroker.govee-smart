"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_quirks_exports = {};
__export(device_quirks_exports, {
  applyColorTempQuirk: () => applyColorTempQuirk,
  getDeviceQuirks: () => getDeviceQuirks,
  loadCommunityQuirks: () => loadCommunityQuirks
});
module.exports = __toCommonJS(device_quirks_exports);
var fs = __toESM(require("node:fs"));
const BUILTIN_QUIRKS = {
  // Color temperature overrides (API claims 2000-9000K)
  H60A1: { colorTempRange: { min: 2200, max: 6500 } },
  H6022: { colorTempRange: { min: 2700, max: 6500 } },
  // Broken platform API metadata
  H6141: { brokenPlatformApi: true },
  H6159: { brokenPlatformApi: true },
  H6003: { brokenPlatformApi: true },
  H6102: { brokenPlatformApi: true },
  H6053: { brokenPlatformApi: true },
  H617C: { brokenPlatformApi: true },
  H617E: { brokenPlatformApi: true },
  H617F: { brokenPlatformApi: true },
  H6119: { brokenPlatformApi: true },
  // No MQTT support despite being light-type
  H6121: { noMqtt: true },
  H6154: { noMqtt: true },
  H6176: { noMqtt: true }
};
let mergedQuirks = { ...BUILTIN_QUIRKS };
function loadCommunityQuirks(filePath, log) {
  var _a;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (!data.quirks || typeof data.quirks !== "object") {
      log == null ? void 0 : log.debug("Community quirks file has no valid 'quirks' object");
      return;
    }
    mergedQuirks = { ...BUILTIN_QUIRKS };
    let count = 0;
    for (const [sku, quirk] of Object.entries(data.quirks)) {
      mergedQuirks[sku.toUpperCase()] = quirk;
      count++;
    }
    log == null ? void 0 : log.debug(`Loaded ${count} community quirks (v${(_a = data.version) != null ? _a : "?"})`);
  } catch (err) {
    if (err.code === "ENOENT") {
      log == null ? void 0 : log.debug("No community quirks file found \u2014 using built-in only");
    } else {
      log == null ? void 0 : log.info(
        `Could not load community quirks: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
function getDeviceQuirks(sku) {
  return mergedQuirks[sku.toUpperCase()];
}
function applyColorTempQuirk(sku, min, max) {
  const quirks = getDeviceQuirks(sku);
  if (quirks == null ? void 0 : quirks.colorTempRange) {
    return quirks.colorTempRange;
  }
  return { min, max };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyColorTempQuirk,
  getDeviceQuirks,
  loadCommunityQuirks
});
//# sourceMappingURL=device-quirks.js.map
