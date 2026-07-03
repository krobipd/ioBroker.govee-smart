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
  GoveeApiClient: () => GoveeApiClient,
  parseLastData: () => parseLastData,
  parseSettings: () => parseSettings
});
module.exports = __toCommonJS(govee_api_client_exports);
var import_http_client = require("./http-client");
var import_govee_constants = require("./govee-constants");
class GoveeApiClient {
  /**
   * @param log Adapter logger. Each fetch method emits a debug-line for the
   *   request and a debug-line summarising the result — this is what made
   *   Issue #13 v2.8.2 hard to triage from the log alone (the App-API path
   *   was completely silent before v2.8.3).
   */
  constructor(log) {
    this.log = log;
  }
  bearerToken = null;
  /** Account-derived client ID. Defaults to anonymous fallback until setEmail() is called. */
  clientId = (0, import_govee_constants.deriveGoveeClientId)(void 0);
  /**
   * Update the bearer token (obtained from MQTT login).
   *
   * @param token Bearer token string
   */
  setBearerToken(token) {
    this.bearerToken = token;
  }
  /**
   * Update the account email so subsequent requests use the matching
   * UUIDv5-derived client ID. Public endpoints (scene/music/DIY libraries)
   * still work with the anonymous fallback, but the bearer-token endpoints
   * (sensor /device/rest/devices/v1/list) match better when the clientId
   * mirrors the one used during the MQTT login.
   *
   * @param email Govee account email
   */
  setEmail(email) {
    this.clientId = (0, import_govee_constants.deriveGoveeClientId)(email);
  }
  /** Check if bearer token is available (set after MQTT login) */
  hasBearerToken() {
    return !!this.bearerToken;
  }
  /**
   * Auth headers for the bearer-token-protected sensor endpoints.
   * Caller-side guard: check hasBearerToken() before calling.
   */
  authHeaders() {
    if (!this.bearerToken) {
      throw new Error("Bearer token required \u2014 call hasBearerToken() first");
    }
    return (0, import_govee_constants.buildGoveeAppHeaders)(this.clientId, { bearer: this.bearerToken });
  }
  /**
   * Log a non-JSON fallback (empty / plain-text-status body) for an App-API
   * endpoint on debug — shared by every fetch method so the "why is this null?"
   * trace reads the same everywhere.
   *
   * @param endpoint Endpoint label for the log line (e.g. "/devices/snapshots sku=H61BE")
   * @param result HttpResult envelope from httpsRequest
   */
  logFallback(endpoint, result) {
    if (result.fallback) {
      this.log.debug(`App API ${endpoint}: ${(0, import_http_client.formatFallback)(result)}`);
    }
  }
  /**
   * Guard for bearer-token endpoints: returns true when a token is present,
   * otherwise logs a uniform "no bearer token" skip line and returns false.
   * Callers do `if (!this.requireBearer(endpoint)) return [];` (or `null`).
   *
   * @param endpoint Endpoint label for the skip log line
   */
  requireBearer(endpoint) {
    if (this.bearerToken) {
      return true;
    }
    this.log.debug(`App API skip ${endpoint}: no bearer token`);
    return false;
  }
  /**
   * Fetch the per-account device list from the undocumented sensor
   * endpoint. One call returns every device the Govee Home app sees for
   * this account, with `lastDeviceData` + `deviceSettings` embedded as
   * stringified JSON. Cheap and safe to poll on a conservative schedule.
   *
   * Endpoint: `POST /device/rest/devices/v1/list` (empty body).
   * Auth: bearer token only.
   *
   * Used primarily for SKUs where OpenAPI v2 `/device/state` returns
   * empty (H5179 et al.). Returns `[]` when no token is set.
   *
   * @returns Parsed entries; never throws on a single malformed entry.
   */
  async fetchDeviceList() {
    if (!this.requireBearer(`/device/rest/devices/v1/list`)) {
      return [];
    }
    this.log.debug(`App API POST /device/rest/devices/v1/list bearer=yes`);
    const result = await (0, import_http_client.httpsRequest)({
      method: "POST",
      url: `${import_govee_constants.GOVEE_APP_BASE_URL}/device/rest/devices/v1/list`,
      headers: this.authHeaders(),
      body: {}
    });
    this.logFallback(`/device/rest/devices/v1/list`, result);
    const resp = result.value;
    const out = [];
    const list = Array.isArray(resp == null ? void 0 : resp.devices) ? resp.devices : [];
    for (const d of list) {
      if (!d || typeof d.sku !== "string" || typeof d.device !== "string") {
        continue;
      }
      const entry = {
        sku: d.sku,
        device: d.device,
        deviceName: typeof d.deviceName === "string" ? d.deviceName : d.sku,
        deviceId: typeof d.deviceId === "number" ? d.deviceId : void 0,
        versionHard: typeof d.versionHard === "string" ? d.versionHard : void 0,
        versionSoft: typeof d.versionSoft === "string" ? d.versionSoft : void 0
      };
      const ext = d.deviceExt;
      if (ext && typeof ext === "object") {
        entry.lastData = parseLastData(ext.lastDeviceData);
        entry.settings = parseSettings(ext.deviceSettings);
      }
      out.push(entry);
    }
    return out;
  }
  /**
   * Iterate every valid scene across all categories of an app-library response.
   * Shared by the scene / music / DIY library walkers — invokes `perScene` for
   * each scene whose `sceneName` is a non-empty string; the per-walker effect
   * extraction stays in the callback. Defensive against missing / non-array
   * categories and scenes.
   *
   * @param categories The `data.categories` array from the library response
   * @param perScene Callback invoked with each scene that has a string sceneName
   */
  walkCategories(categories, perScene) {
    const cats = Array.isArray(categories) ? categories : [];
    for (const cat of cats) {
      const scenes = Array.isArray(cat == null ? void 0 : cat.scenes) ? cat.scenes : [];
      for (const s of scenes) {
        if (!s || typeof s.sceneName !== "string" || !s.sceneName) {
          continue;
        }
        perScene(s);
      }
    }
  }
  /**
   * Fetch scene library for a specific SKU from undocumented API.
   * Public endpoint — no authentication required, only AppVersion header.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSceneLibrary(sku) {
    var _a;
    this.log.debug(`App API GET /light-effect-libraries sku=${sku} bearer=no (public endpoint)`);
    const url = `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await (0, import_http_client.httpsRequest)({
      method: "GET",
      url,
      headers: {
        appVersion: (0, import_govee_constants.getAppVersion)(),
        "User-Agent": (0, import_govee_constants.goveeUserAgent)()
      }
    });
    this.logFallback(`/light-effect-libraries sku=${sku}`, result);
    const resp = result.value;
    const scenes = [];
    this.walkCategories((_a = resp == null ? void 0 : resp.data) == null ? void 0 : _a.categories, (s) => {
      var _a2, _b, _c, _d, _e;
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      if (effects.length === 0) {
        const code = (_a2 = s.sceneCode) != null ? _a2 : 0;
        if (code > 0) {
          scenes.push({ name: s.sceneName, sceneCode: code });
        }
        return;
      }
      const multiVariant = effects.length > 1;
      for (const effect of effects) {
        const code = (_c = (_b = effect.sceneCode) != null ? _b : s.sceneCode) != null ? _c : 0;
        if (code <= 0) {
          continue;
        }
        const name = multiVariant && effect.scenceName ? `${s.sceneName}-${effect.scenceName}` : s.sceneName;
        const si = effect.speedInfo;
        scenes.push({
          name,
          sceneCode: code,
          scenceParam: effect.scenceParam || void 0,
          speedInfo: (si == null ? void 0 : si.supSpeed) ? {
            supSpeed: true,
            speedIndex: (_d = si.speedIndex) != null ? _d : 0,
            config: (_e = si.config) != null ? _e : ""
          } : void 0
        });
      }
    });
    return scenes;
  }
  /**
   * Fetch music effect library for a specific SKU (requires auth).
   * Returns music modes with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchMusicLibrary(sku) {
    var _a;
    if (!this.requireBearer(`/music-effect-libraries sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /music-effect-libraries sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/music-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/music-effect-libraries sku=${sku}`, result);
    const resp = result.value;
    const modes = [];
    let modeIdx = 0;
    this.walkCategories((_a = resp == null ? void 0 : resp.data) == null ? void 0 : _a.categories, (s) => {
      var _a2, _b;
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      const effect = effects[0];
      const code = (_b = (_a2 = effect == null ? void 0 : effect.sceneCode) != null ? _a2 : s.sceneCode) != null ? _b : 0;
      if (code > 0) {
        modes.push({
          name: s.sceneName,
          musicCode: code,
          scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0,
          mode: modeIdx
        });
      }
      modeIdx++;
    });
    return modes;
  }
  /**
   * Fetch DIY light effect library for a specific SKU (requires auth).
   * Returns DIY scene definitions with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchDiyLibrary(sku) {
    var _a;
    if (!this.requireBearer(`/diy-light-effect-libraries sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /diy-light-effect-libraries sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/diy-light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/diy-light-effect-libraries sku=${sku}`, result);
    const resp = result.value;
    const diys = [];
    this.walkCategories((_a = resp == null ? void 0 : resp.data) == null ? void 0 : _a.categories, (s) => {
      var _a2, _b;
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      const effect = effects[0];
      const code = (_b = (_a2 = effect == null ? void 0 : effect.sceneCode) != null ? _a2 : s.sceneCode) != null ? _b : 0;
      if (code > 0) {
        diys.push({
          name: s.sceneName,
          diyCode: code,
          scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0
        });
      }
    });
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
    if (!this.requireBearer(`/sku-supported-feature sku=${sku}`)) {
      return null;
    }
    this.log.debug(`App API GET /sku-supported-feature sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/sku-supported-feature?sku=${encodeURIComponent(sku)}`;
    const result = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/sku-supported-feature sku=${sku}`, result);
    const resp = result.value;
    if (!resp || typeof resp !== "object") {
      return null;
    }
    return (_a = resp.data) != null ? _a : null;
  }
  /**
   * Fetch snapshot BLE commands for local activation via ptReal.
   * Each snapshot contains one or more cmds with Base64 BLE packets.
   *
   * @param sku Product model
   * @param deviceId Device identifier (colon-separated)
   */
  async fetchSnapshots(sku, deviceId) {
    var _a;
    if (!this.requireBearer(`/devices/snapshots sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /devices/snapshots sku=${sku} device=${deviceId} bearer=yes`);
    const url = `https://app2.govee.com/bff-app/v1/devices/snapshots?sku=${encodeURIComponent(sku)}&device=${encodeURIComponent(deviceId)}&snapshotId=-1`;
    const result = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/devices/snapshots sku=${sku}`, result);
    const resp = result.value;
    const results = [];
    const snaps = Array.isArray((_a = resp == null ? void 0 : resp.data) == null ? void 0 : _a.snapshots) ? resp.data.snapshots : [];
    for (const snap of snaps) {
      if (!snap || typeof snap.name !== "string" || !snap.name) {
        continue;
      }
      const allCmdPackets = [];
      const cmds = Array.isArray(snap.cmds) ? snap.cmds : [];
      for (const cmd of cmds) {
        if (!cmd || typeof cmd.bleCmds !== "string" || !cmd.bleCmds) {
          continue;
        }
        try {
          const parsed = JSON.parse(cmd.bleCmds);
          if (typeof (parsed == null ? void 0 : parsed.bleCmd) === "string" && parsed.bleCmd.length > 0) {
            allCmdPackets.push(parsed.bleCmd.split(","));
          }
        } catch {
        }
      }
      if (allCmdPackets.length > 0) {
        results.push({ name: snap.name, bleCmds: allCmdPackets });
      }
    }
    return results;
  }
  /**
   * Fetch group membership from undocumented exec-plat/home endpoint.
   * Returns groups with their member device references.
   */
  async fetchGroupMembers() {
    var _a;
    if (!this.requireBearer(`/exec-plat/home`)) {
      return [];
    }
    this.log.debug(`App API GET /exec-plat/home bearer=yes`);
    const url = "https://app2.govee.com/bff-app/v1/exec-plat/home";
    const result = await (0, import_http_client.httpsRequest)({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/exec-plat/home`, result);
    const resp = result.value;
    const groups = [];
    const components = Array.isArray((_a = resp == null ? void 0 : resp.data) == null ? void 0 : _a.components) ? resp.data.components : [];
    for (const comp of components) {
      const compGroups = Array.isArray(comp == null ? void 0 : comp.groups) ? comp.groups : [];
      for (const g of compGroups) {
        if (!g || typeof g.gId !== "number") {
          continue;
        }
        const devices = [];
        const gDevices = Array.isArray(g.devices) ? g.devices : [];
        for (const d of gDevices) {
          if (d && typeof d.sku === "string" && typeof d.device === "string" && d.sku && d.device) {
            devices.push({ sku: d.sku, deviceId: d.device });
          }
        }
        if (devices.length > 0) {
          groups.push({
            groupId: g.gId,
            name: typeof g.name === "string" ? g.name : "",
            devices
          });
        }
      }
    }
    return groups;
  }
}
function parseLastData(raw) {
  if (typeof raw !== "string" || !raw) {
    return void 0;
  }
  try {
    const obj = JSON.parse(raw);
    const out = {};
    if (typeof obj.online === "boolean") {
      out.online = obj.online;
    } else if (obj.online === 1 || obj.online === 0) {
      out.online = obj.online === 1;
    }
    if (typeof obj.tem === "number" && Number.isFinite(obj.tem)) {
      out.tem = obj.tem;
    }
    if (typeof obj.hum === "number" && Number.isFinite(obj.hum)) {
      out.hum = obj.hum;
    }
    if (typeof obj.battery === "number" && Number.isFinite(obj.battery)) {
      out.battery = obj.battery;
    }
    if (typeof obj.lastTime === "number" && Number.isFinite(obj.lastTime)) {
      out.lastTime = obj.lastTime;
    }
    return out;
  } catch {
    return void 0;
  }
}
function parseSettings(raw) {
  if (typeof raw !== "string" || !raw) {
    return void 0;
  }
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : void 0;
  } catch {
    return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeApiClient,
  parseLastData,
  parseSettings
});
//# sourceMappingURL=govee-api-client.js.map
