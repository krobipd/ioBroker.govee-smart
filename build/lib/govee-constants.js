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
  GOVEE_APP_VERSION: () => GOVEE_APP_VERSION,
  GOVEE_CLIENT_ID: () => GOVEE_CLIENT_ID,
  GOVEE_CLIENT_TYPE: () => GOVEE_CLIENT_TYPE,
  GOVEE_USER_AGENT: () => GOVEE_USER_AGENT
});
module.exports = __toCommonJS(govee_constants_exports);
const GOVEE_APP_VERSION = "7.3.30";
const GOVEE_CLIENT_ID = "d39f7b0732a24e58acf771103ebefc04";
const GOVEE_CLIENT_TYPE = "1";
const GOVEE_USER_AGENT = "GoveeHome/7.3.30 (com.ihoment.GoVeeSensor; build:3; iOS 26.3.1) Alamofire/5.11.1";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GOVEE_APP_VERSION,
  GOVEE_CLIENT_ID,
  GOVEE_CLIENT_TYPE,
  GOVEE_USER_AGENT
});
//# sourceMappingURL=govee-constants.js.map
