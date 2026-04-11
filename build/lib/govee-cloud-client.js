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
var govee_cloud_client_exports = {};
__export(govee_cloud_client_exports, {
  CloudApiError: () => CloudApiError,
  GoveeCloudClient: () => GoveeCloudClient
});
module.exports = __toCommonJS(govee_cloud_client_exports);
var import_http_client = require("./http-client.js");
const BASE_URL = "https://openapi.api.govee.com";
const CloudApiError = import_http_client.HttpError;
class GoveeCloudClient {
  apiKey;
  log;
  /**
   * @param apiKey Govee API key
   * @param log ioBroker logger
   */
  constructor(apiKey, log) {
    this.apiKey = apiKey;
    this.log = log;
  }
  /** Fetch all devices with their capabilities */
  async getDevices() {
    var _a;
    const resp = await this.request(
      "GET",
      "/router/api/v1/user/devices"
    );
    return (_a = resp.data) != null ? _a : [];
  }
  /**
   * Fetch current state of a device
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getDeviceState(sku, device) {
    var _a, _b;
    const resp = await this.request(
      "POST",
      "/router/api/v1/device/state",
      {
        requestId: `state_${Date.now()}`,
        payload: { sku, device }
      }
    );
    return (_b = (_a = resp.data) == null ? void 0 : _a.capabilities) != null ? _b : [];
  }
  /**
   * Send a control command to a device
   *
   * @param sku Product model
   * @param device Device ID
   * @param capabilityType Full capability type string
   * @param instance Capability instance name
   * @param value Value to set
   */
  async controlDevice(sku, device, capabilityType, instance, value) {
    await this.request("POST", "/router/api/v1/device/control", {
      requestId: `ctrl_${Date.now()}`,
      payload: {
        sku,
        device,
        capability: {
          type: capabilityType,
          instance,
          value
        }
      }
    });
  }
  /**
   * Fetch dynamic scenes and snapshots for a device.
   * The scenes endpoint returns capabilities with options.
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getScenes(sku, device) {
    var _a, _b, _c, _d, _e;
    const resp = await this.request(
      "POST",
      "/router/api/v1/device/scenes",
      {
        requestId: "scenes",
        payload: { sku, device }
      }
    );
    const lightScenes = [];
    const diyScenes = [];
    const snapshots = [];
    for (const cap of (_b = (_a = resp.payload) == null ? void 0 : _a.capabilities) != null ? _b : []) {
      this.log.debug(
        `Scenes endpoint: instance=${cap.instance}, options=${(_d = (_c = cap.parameters.options) == null ? void 0 : _c.length) != null ? _d : 0}`
      );
      const opts = (_e = cap.parameters.options) != null ? _e : [];
      const mapped = opts.filter(
        (o) => typeof o.name === "string" && typeof o.value === "object"
      ).map((o) => ({
        name: o.name,
        value: o.value
      }));
      if (cap.instance === "lightScene") {
        lightScenes.push(...mapped);
      } else if (cap.instance === "diyScene") {
        diyScenes.push(...mapped);
      } else if (cap.instance === "snapshot") {
        snapshots.push(...mapped);
      }
    }
    return { lightScenes, diyScenes, snapshots };
  }
  /**
   * Fetch DIY scenes for a device from the dedicated diy-scenes endpoint.
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getDiyScenes(sku, device) {
    var _a, _b, _c, _d, _e;
    const resp = await this.request(
      "POST",
      "/router/api/v1/device/diy-scenes",
      {
        requestId: "diy-scenes",
        payload: { sku, device }
      }
    );
    const scenes = [];
    for (const cap of (_b = (_a = resp.payload) == null ? void 0 : _a.capabilities) != null ? _b : []) {
      this.log.debug(
        `DIY-Scenes endpoint: instance=${cap.instance}, options=${(_d = (_c = cap.parameters.options) == null ? void 0 : _c.length) != null ? _d : 0}`
      );
      const opts = (_e = cap.parameters.options) != null ? _e : [];
      scenes.push(
        ...opts.filter(
          (o) => typeof o.name === "string" && typeof o.value === "object"
        ).map((o) => ({ name: o.name, value: o.value }))
      );
    }
    return scenes;
  }
  /**
   * Make an HTTPS request to the Govee Cloud API
   *
   * @param method HTTP method (GET, POST)
   * @param path API endpoint path
   * @param body Optional request body
   */
  async request(method, path, body) {
    var _a;
    this.log.debug(`Cloud API: ${method} ${path}`);
    try {
      return await (0, import_http_client.httpsRequest)({
        method,
        url: new URL(path, BASE_URL).toString(),
        headers: { "Govee-API-Key": this.apiKey },
        body
      });
    } catch (err) {
      if (err instanceof import_http_client.HttpError && err.statusCode === 429) {
        const retryAfter = String((_a = err.headers["retry-after"]) != null ? _a : "unknown");
        throw new import_http_client.HttpError(
          `Rate limited \u2014 retry after ${retryAfter}s`,
          429,
          err.headers
        );
      }
      throw err;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CloudApiError,
  GoveeCloudClient
});
//# sourceMappingURL=govee-cloud-client.js.map
