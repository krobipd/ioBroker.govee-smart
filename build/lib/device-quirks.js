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
var device_quirks_exports = {};
__export(device_quirks_exports, {
  applyColorTempQuirk: () => applyColorTempQuirk,
  getDeviceQuirks: () => getDeviceQuirks
});
module.exports = __toCommonJS(device_quirks_exports);
const QUIRKS = {
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
function getDeviceQuirks(sku) {
  return QUIRKS[sku.toUpperCase()];
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
  getDeviceQuirks
});
//# sourceMappingURL=device-quirks.js.map
