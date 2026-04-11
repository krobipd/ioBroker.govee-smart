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
var govee_cloud_client_exports = {};
__export(govee_cloud_client_exports, {
  CloudApiError: () => CloudApiError,
  GoveeCloudClient: () => GoveeCloudClient
});
module.exports = __toCommonJS(govee_cloud_client_exports);
var https = __toESM(require("node:https"));
const BASE_URL = "https://openapi.api.govee.com";
class CloudApiError extends Error {
  /** HTTP status code */
  statusCode;
  /**
   * @param message Error message
   * @param statusCode HTTP status code
   */
  constructor(message, statusCode) {
    super(message);
    this.name = "CloudApiError";
    this.statusCode = statusCode;
  }
}
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
  request(method, path, body) {
    this.log.debug(`Cloud API: ${method} ${path}`);
    return new Promise((resolve, reject) => {
      const url = new URL(path, BASE_URL);
      const postData = body ? JSON.stringify(body) : void 0;
      const options = {
        method,
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "Govee-API-Key": this.apiKey,
          ...postData ? { "Content-Length": Buffer.byteLength(postData) } : {}
        },
        timeout: 15e3
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          var _a;
          const raw = Buffer.concat(chunks).toString();
          const statusCode = (_a = res.statusCode) != null ? _a : 0;
          if (statusCode === 429) {
            const retryAfter = res.headers["retry-after"];
            reject(
              new CloudApiError(
                `Rate limited \u2014 retry after ${retryAfter != null ? retryAfter : "unknown"}s`,
                429
              )
            );
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new CloudApiError(
                `HTTP ${statusCode}: ${raw.slice(0, 200)}`,
                statusCode
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Request timed out"));
      });
      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CloudApiError,
  GoveeCloudClient
});
//# sourceMappingURL=govee-cloud-client.js.map
