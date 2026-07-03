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
var govee_constants_exports = {};
__export(govee_constants_exports, {
  GOVEE_APP_BASE_URL: () => GOVEE_APP_BASE_URL,
  GOVEE_APP_VERSION: () => GOVEE_APP_VERSION,
  GOVEE_CAP_TYPE: () => GOVEE_CAP_TYPE,
  GOVEE_CLIENT_TYPE: () => GOVEE_CLIENT_TYPE,
  GOVEE_DEVICE_TYPE: () => GOVEE_DEVICE_TYPE,
  buildGoveeAppHeaders: () => buildGoveeAppHeaders,
  deriveGoveeClientId: () => deriveGoveeClientId,
  getAppVersion: () => getAppVersion,
  goveeUserAgent: () => goveeUserAgent,
  setAppVersion: () => setAppVersion
});
module.exports = __toCommonJS(govee_constants_exports);
var import_uuid = require("uuid");
const GOVEE_CAP_TYPE = {
  DYNAMIC_SCENE: "devices.capabilities.dynamic_scene",
  PROPERTY: "devices.capabilities.property",
  MUSIC_SETTING: "devices.capabilities.music_setting",
  ONLINE: "devices.capabilities.online"
};
const GOVEE_DEVICE_TYPE = {
  LIGHT: "devices.types.light",
  THERMOMETER: "devices.types.thermometer",
  SENSOR: "devices.types.sensor",
  HEATER: "devices.types.heater",
  HUMIDIFIER: "devices.types.humidifier",
  DEHUMIDIFIER: "devices.types.dehumidifier",
  FAN: "devices.types.fan",
  AIR_PURIFIER: "devices.types.air_purifier",
  SOCKET: "devices.types.socket",
  KETTLE: "devices.types.kettle",
  ICE_MAKER: "devices.types.ice_maker",
  AROMA_DIFFUSER: "devices.types.aroma_diffuser"
};
const GOVEE_APP_VERSION = "7.5.20";
const GOVEE_CLIENT_TYPE = "1";
let currentAppVersion = GOVEE_APP_VERSION;
function getAppVersion() {
  return currentAppVersion;
}
function setAppVersion(version) {
  if (typeof version === "string" && /^\d+(\.\d+)+$/.test(version)) {
    currentAppVersion = version;
  }
}
function goveeUserAgent() {
  return `GoveeHome/${currentAppVersion} (com.ihoment.GoVeeSensor; build:8; iOS 26.5.0) Alamofire/5.11.0`;
}
function buildGoveeAppHeaders(clientId, opts = {}) {
  const headers = {
    appVersion: currentAppVersion,
    clientId,
    clientType: GOVEE_CLIENT_TYPE,
    "User-Agent": goveeUserAgent()
  };
  if (opts.withTimestamp) {
    headers.iotVersion = "0";
    headers.timestamp = String(Date.now());
  }
  if (opts.bearer) {
    headers.Authorization = `Bearer ${opts.bearer}`;
  }
  return headers;
}
const GOVEE_APP_BASE_URL = "https://app2.govee.com";
function deriveGoveeClientId(email) {
  const seed = (email != null ? email : "").trim().toLowerCase() || "anonymous";
  return (0, import_uuid.v5)(seed, import_uuid.NIL).replace(/-/g, "");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GOVEE_APP_BASE_URL,
  GOVEE_APP_VERSION,
  GOVEE_CAP_TYPE,
  GOVEE_CLIENT_TYPE,
  GOVEE_DEVICE_TYPE,
  buildGoveeAppHeaders,
  deriveGoveeClientId,
  getAppVersion,
  goveeUserAgent,
  setAppVersion
});
//# sourceMappingURL=govee-constants.js.map
