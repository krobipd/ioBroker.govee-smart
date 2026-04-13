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
var govee_api_client_exports = {};
__export(govee_api_client_exports, {
  GoveeApiClient: () => GoveeApiClient
});
module.exports = __toCommonJS(govee_api_client_exports);
var import_http_client = require("./http-client.js");
const APP_VERSION = "7.3.30";
const USER_AGENT = "GoveeHome/7.3.30 (com.ihoment.GoVeeSensor; build:3; iOS 26.3.1) Alamofire/5.11.1";
const CLIENT_ID = "d39f7b0732a24e58acf771103ebefc04";
const CLIENT_TYPE = "1";
class GoveeApiClient {
  bearerToken = null;
  /**
   * Update the bearer token (obtained from MQTT login).
   *
   * @param token Bearer token string
   */
  setBearerToken(token) {
    this.bearerToken = token;
  }
  /**
   * Fetch scene library for a specific SKU from undocumented API.
   * Public endpoint — no authentication required, only AppVersion header.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSceneLibrary(sku) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const url = `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await (0, import_http_client.httpsRequest)({
      method: "GET",
      url,
      headers: { appVersion: APP_VERSION, "User-Agent": USER_AGENT }
    });
    const scenes = [];
    for (const cat of (_b = (_a = resp.data) == null ? void 0 : _a.categories) != null ? _b : []) {
      for (const s of (_c = cat.scenes) != null ? _c : []) {
        if (!s.sceneName) {
          continue;
        }
        const effect = (_d = s.lightEffects) == null ? void 0 : _d[0];
        const code = (_f = (_e = effect == null ? void 0 : effect.sceneCode) != null ? _e : s.sceneCode) != null ? _f : 0;
        if (code > 0) {
          const si = effect == null ? void 0 : effect.speedInfo;
          scenes.push({
            name: s.sceneName,
            sceneCode: code,
            scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0,
            speedInfo: (si == null ? void 0 : si.supSpeed) ? {
              supSpeed: true,
              speedIndex: (_g = si.speedIndex) != null ? _g : 0,
              config: (_h = si.config) != null ? _h : ""
            } : void 0
          });
        }
      }
    }
    return scenes;
  }
  /** Headers for authenticated undocumented API endpoints */
  authHeaders() {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      appVersion: APP_VERSION,
      clientId: CLIENT_ID,
      clientType: CLIENT_TYPE,
      "User-Agent": USER_AGENT
    };
  }
  /**
   * Fetch music effect library for a specific SKU (requires auth).
   * Returns music modes with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchMusicLibrary(sku) {
    var _a, _b, _c, _d, _e, _f;
    if (!this.bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/music-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    const modes = [];
    let modeIdx = 0;
    for (const cat of (_b = (_a = resp.data) == null ? void 0 : _a.categories) != null ? _b : []) {
      for (const s of (_c = cat.scenes) != null ? _c : []) {
        if (!s.sceneName) {
          continue;
        }
        const effect = (_d = s.lightEffects) == null ? void 0 : _d[0];
        const code = (_f = (_e = effect == null ? void 0 : effect.sceneCode) != null ? _e : s.sceneCode) != null ? _f : 0;
        if (code > 0) {
          modes.push({
            name: s.sceneName,
            musicCode: code,
            scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0,
            mode: modeIdx
          });
        }
        modeIdx++;
      }
    }
    return modes;
  }
  /**
   * Fetch DIY light effect library for a specific SKU (requires auth).
   * Returns DIY scene definitions with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchDiyLibrary(sku) {
    var _a, _b, _c, _d, _e, _f;
    if (!this.bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/diy-light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    const diys = [];
    for (const cat of (_b = (_a = resp.data) == null ? void 0 : _a.categories) != null ? _b : []) {
      for (const s of (_c = cat.scenes) != null ? _c : []) {
        if (!s.sceneName) {
          continue;
        }
        const effect = (_d = s.lightEffects) == null ? void 0 : _d[0];
        const code = (_f = (_e = effect == null ? void 0 : effect.sceneCode) != null ? _e : s.sceneCode) != null ? _f : 0;
        if (code > 0) {
          diys.push({
            name: s.sceneName,
            diyCode: code,
            scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0
          });
        }
      }
    }
    return diys;
  }
  /**
   * Fetch supported features for a specific SKU (requires auth).
   * Returns feature flags indicating what the device supports.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSkuFeatures(sku) {
    var _a;
    if (!this.bearerToken) {
      return null;
    }
    const url = `https://app2.govee.com/appsku/v1/sku-supported-feature?sku=${encodeURIComponent(sku)}`;
    const resp = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    return (_a = resp.data) != null ? _a : null;
  }
  /**
   * Fetch group membership from undocumented exec-plat/home endpoint.
   * Returns groups with their member device references.
   */
  async fetchGroupMembers() {
    var _a, _b, _c, _d, _e;
    if (!this.bearerToken) {
      return [];
    }
    const url = "https://app2.govee.com/bff-app/v1/exec-plat/home";
    const resp = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    const groups = [];
    for (const comp of (_b = (_a = resp.data) == null ? void 0 : _a.components) != null ? _b : []) {
      for (const g of (_c = comp.groups) != null ? _c : []) {
        if (g.groupId == null) {
          continue;
        }
        const devices = [];
        for (const d of (_d = g.devices) != null ? _d : []) {
          const sku = d.sku;
          const deviceId = d.device || ((_e = d.deviceExt) == null ? void 0 : _e.deviceId);
          if (sku && deviceId) {
            devices.push({ sku, deviceId });
          }
        }
        if (devices.length > 0) {
          groups.push({ groupId: g.groupId, name: g.groupName || "", devices });
        }
      }
    }
    return groups;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeApiClient
});
//# sourceMappingURL=govee-api-client.js.map
