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
var govee_mqtt_client_exports = {};
__export(govee_mqtt_client_exports, {
  GoveeMqttClient: () => GoveeMqttClient
});
module.exports = __toCommonJS(govee_mqtt_client_exports);
var https = __toESM(require("node:https"));
var forge = __toESM(require("node-forge"));
var mqtt = __toESM(require("mqtt"));
var import_types = require("./types.js");
const MAX_AUTH_FAILURES = 3;
const LOGIN_URL = "https://app2.govee.com/account/rest/account/v2/login";
const IOT_KEY_URL = "https://app2.govee.com/app/v1/account/iot/key";
const APP_VERSION = "7.3.30";
const CLIENT_TYPE = "1";
const CLIENT_ID = "d39f7b0732a24e58acf771103ebefc04";
const USER_AGENT = "GoveeHome/7.3.30 (com.ihoment.GoVeeSensor; build:3; iOS 26.3.1) Alamofire/5.11.1";
const AMAZON_ROOT_CA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----`;
class GoveeMqttClient {
  email;
  password;
  log;
  timers;
  client = null;
  accountTopic = "";
  _bearerToken = "";
  accountId = "";
  reconnectTimer = void 0;
  reconnectAttempts = 0;
  authFailCount = 0;
  lastErrorCategory = null;
  onStatus = null;
  onConnection = null;
  /** Map of device ID → MQTT topic for publishing commands */
  deviceTopics = /* @__PURE__ */ new Map();
  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(email, password, log, timers) {
    this.email = email;
    this.password = password;
    this.log = log;
    this.timers = timers;
  }
  /** Bearer token from login — available after connect, used for undocumented API */
  get token() {
    return this._bearerToken;
  }
  /**
   * Connect to Govee MQTT.
   * Flow: Login → Get IoT Key → Extract certs from P12 → Connect MQTT
   *
   * @param onStatus Called on device status updates
   * @param onConnection Called on connection state changes
   */
  async connect(onStatus, onConnection) {
    var _a, _b, _c, _d;
    this.onStatus = onStatus;
    this.onConnection = onConnection;
    try {
      const loginResp = await this.login();
      if (!loginResp.client) {
        const apiStatus = (_a = loginResp.status) != null ? _a : 0;
        const apiMsg = (_b = loginResp.message) != null ? _b : "unknown error";
        const statusStr = `(status ${apiStatus || "?"})`;
        if (apiStatus === 429 || /too many|rate.?limit|frequent|throttl/i.test(apiMsg)) {
          throw new Error(`Rate limited by Govee: ${apiMsg} ${statusStr}`);
        }
        if (apiStatus === 401 || /password|credential|unauthorized/i.test(apiMsg)) {
          throw new Error(`Login failed: ${apiMsg} ${statusStr}`);
        }
        if (/abnormal|blocked|suspended|disabled/i.test(apiMsg)) {
          throw new Error(`Login failed: ${apiMsg} ${statusStr}`);
        }
        throw new Error(`Govee login rejected: ${apiMsg} ${statusStr}`);
      }
      this._bearerToken = loginResp.client.token;
      this.accountId = String(loginResp.client.accountId);
      this.accountTopic = loginResp.client.topic;
      const iotResp = await this.getIotKey();
      if (!((_c = iotResp.data) == null ? void 0 : _c.endpoint)) {
        throw new Error("IoT key response missing endpoint/certificate data");
      }
      const { endpoint, p12, p12Pass } = iotResp.data;
      const { key, cert, ca } = this.extractCertsFromP12(p12, p12Pass);
      const clientId = `AP/${this.accountId}/${this.generateUuid()}`;
      this.client = mqtt.connect(`mqtts://${endpoint}:8883`, {
        clientId,
        key,
        cert,
        ca,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0,
        // We handle reconnect ourselves
        rejectUnauthorized: true
      });
      this.client.on("connect", () => {
        var _a2;
        this.reconnectAttempts = 0;
        this.authFailCount = 0;
        if (this.lastErrorCategory) {
          this.log.info("MQTT connection restored");
          this.lastErrorCategory = null;
        }
        this.log.debug("MQTT connected to AWS IoT");
        (_a2 = this.client) == null ? void 0 : _a2.subscribe(this.accountTopic, { qos: 0 }, (err) => {
          var _a3;
          if (err) {
            this.log.warn(`MQTT subscribe failed: ${err.message}`);
          } else {
            this.log.debug(`MQTT subscribed to account topic`);
            (_a3 = this.onConnection) == null ? void 0 : _a3.call(this, true);
          }
        });
      });
      this.client.on("message", (_topic, payload) => {
        this.handleMessage(payload);
      });
      this.client.on("error", (err) => {
        this.log.debug(`MQTT error: ${err.message}`);
      });
      this.client.on("close", () => {
        var _a2;
        (_a2 = this.onConnection) == null ? void 0 : _a2.call(this, false);
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("MQTT disconnected \u2014 will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = (0, import_types.classifyError)(err);
      const msg = `MQTT connection failed: ${err instanceof Error ? err.message : String(err)}`;
      if (category === "AUTH") {
        this.authFailCount++;
        if (this.authFailCount >= MAX_AUTH_FAILURES) {
          this.log.warn(
            `MQTT login failed ${this.authFailCount} times \u2014 check email/password in adapter settings`
          );
          (_d = this.onConnection) == null ? void 0 : _d.call(this, false);
          return;
        }
      } else {
        this.authFailCount = 0;
      }
      if (category !== this.lastErrorCategory) {
        this.lastErrorCategory = category;
        this.log.warn(msg);
      } else {
        this.log.debug(msg);
      }
      this.scheduleReconnect();
    }
  }
  /**
   * Register a device topic for MQTT command publishing
   *
   * @param deviceId Device identifier
   * @param topic MQTT topic for this device
   */
  registerDeviceTopic(deviceId, topic) {
    this.deviceTopics.set(deviceId, topic);
  }
  /**
   * Send a control command via MQTT
   *
   * @param deviceId Device ID
   * @param cmd Command name (turn, brightness, colorwc)
   * @param data Command data
   */
  sendCommand(deviceId, cmd, data) {
    var _a;
    const topic = this.deviceTopics.get(deviceId);
    if (!topic || !((_a = this.client) == null ? void 0 : _a.connected)) {
      return false;
    }
    const message = {
      msg: {
        cmd,
        data,
        cmdVersion: 0,
        transaction: `v_${Date.now()}000`,
        type: 1
      }
    };
    this.client.publish(topic, JSON.stringify(message), { qos: 0 });
    this.log.debug(`MQTT command sent: ${cmd} to ${deviceId}`);
    return true;
  }
  /**
   * Send power command
   *
   * @param deviceId Device identifier
   * @param on Power state
   */
  setPower(deviceId, on) {
    return this.sendCommand(deviceId, "turn", { val: on ? 1 : 0 });
  }
  /**
   * Send brightness command
   *
   * @param deviceId Device identifier
   * @param brightness Brightness 0-100
   */
  setBrightness(deviceId, brightness) {
    return this.sendCommand(deviceId, "brightness", { val: brightness });
  }
  /**
   * Send color command
   *
   * @param deviceId Device identifier
   * @param r Red channel 0-255
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setColor(deviceId, r, g, b) {
    return this.sendCommand(deviceId, "colorwc", {
      color: { r, g, b },
      colorTemInKelvin: 0
    });
  }
  /**
   * Send color temperature command
   *
   * @param deviceId Device identifier
   * @param kelvin Color temperature in Kelvin
   */
  setColorTemperature(deviceId, kelvin) {
    return this.sendCommand(deviceId, "colorwc", {
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: kelvin
    });
  }
  /**
   * Request device status via MQTT
   *
   * @param deviceId Device identifier
   */
  requestStatus(deviceId) {
    var _a;
    const topic = this.deviceTopics.get(deviceId);
    if (!topic || !((_a = this.client) == null ? void 0 : _a.connected)) {
      return false;
    }
    const message = {
      msg: {
        cmd: "status",
        cmdVersion: 2,
        transaction: `v_${Date.now()}000`,
        type: 0,
        data: {},
        accountTopic: this.accountTopic
      }
    };
    this.client.publish(topic, JSON.stringify(message), { qos: 0 });
    return true;
  }
  /** Whether MQTT is currently connected */
  get connected() {
    var _a, _b;
    return (_b = (_a = this.client) == null ? void 0 : _a.connected) != null ? _b : false;
  }
  /** Disconnect and cleanup */
  disconnect() {
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on("error", () => {
      });
      this.client.end(true);
      this.client = null;
    }
  }
  /**
   * Parse MQTT status message
   *
   * @param payload Raw MQTT message buffer
   */
  handleMessage(payload) {
    var _a, _b, _c;
    try {
      const raw = JSON.parse(payload.toString());
      const update = {
        sku: (_a = raw.sku) != null ? _a : "",
        device: (_b = raw.device) != null ? _b : "",
        state: raw.state,
        op: raw.op
      };
      if (update.sku || update.device) {
        (_c = this.onStatus) == null ? void 0 : _c.call(this, update);
      }
    } catch {
      this.log.debug(
        `MQTT: Failed to parse message: ${payload.toString().slice(0, 200)}`
      );
    }
  }
  /** Schedule reconnect with exponential backoff */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    if (this.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      5e3 * Math.pow(2, this.reconnectAttempts - 1),
      3e5
    );
    this.log.debug(
      `MQTT: Reconnecting in ${delay / 1e3}s (attempt ${this.reconnectAttempts})`
    );
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = void 0;
      if (this.onStatus && this.onConnection) {
        void this.connect(this.onStatus, this.onConnection);
      }
    }, delay);
  }
  /** Login to Govee account */
  login() {
    return this.httpsPost(
      LOGIN_URL,
      {
        email: this.email,
        password: this.password,
        client: CLIENT_ID
      },
      {
        appVersion: APP_VERSION,
        clientId: CLIENT_ID,
        clientType: CLIENT_TYPE,
        "User-Agent": USER_AGENT,
        timezone: "Europe/Berlin",
        country: "DE",
        envid: "0",
        iotversion: "0"
      }
    );
  }
  /** Get IoT key (P12 certificate) */
  getIotKey() {
    return this.httpsGet(IOT_KEY_URL, {
      Authorization: `Bearer ${this._bearerToken}`,
      appVersion: APP_VERSION,
      clientId: CLIENT_ID,
      clientType: CLIENT_TYPE,
      "User-Agent": USER_AGENT
    });
  }
  /**
   * Fetch scene library for a specific SKU from undocumented API.
   * Public endpoint — no authentication required, only AppVersion header.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSceneLibrary(sku) {
    var _a, _b, _c, _d, _e, _f;
    const url = `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await this.httpsGet(url, {
      appVersion: APP_VERSION,
      "User-Agent": USER_AGENT
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
          scenes.push({
            name: s.sceneName,
            sceneCode: code,
            scenceParam: (effect == null ? void 0 : effect.scenceParam) || void 0
          });
        }
      }
    }
    return scenes;
  }
  /** Headers for authenticated undocumented API endpoints */
  authHeaders() {
    return {
      Authorization: `Bearer ${this._bearerToken}`,
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
    if (!this._bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/music-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await this.httpsGet(url, this.authHeaders());
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
    if (!this._bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/diy-light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await this.httpsGet(url, this.authHeaders());
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
    if (!this._bearerToken) {
      return null;
    }
    const url = `https://app2.govee.com/appsku/v1/sku-supported-feature?sku=${encodeURIComponent(sku)}`;
    const resp = await this.httpsGet(url, this.authHeaders());
    return (_a = resp.data) != null ? _a : null;
  }
  /**
   * Extract PEM key + cert from PKCS12
   *
   * @param p12Base64 Base64-encoded PKCS12 data
   * @param password PKCS12 password
   */
  extractCertsFromP12(p12Base64, password) {
    var _a, _b;
    const p12Der = forge.util.decode64(p12Base64);
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    const keyBags = p12.getBags({
      bagType: forge.pki.oids.pkcs8ShroudedKeyBag
    });
    const keyBag = (_a = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]) == null ? void 0 : _a[0];
    if (!(keyBag == null ? void 0 : keyBag.key)) {
      throw new Error("No private key found in P12");
    }
    const key = forge.pki.privateKeyToPem(keyBag.key);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = (_b = certBags[forge.pki.oids.certBag]) == null ? void 0 : _b[0];
    if (!(certBag == null ? void 0 : certBag.cert)) {
      throw new Error("No certificate found in P12");
    }
    const cert = forge.pki.certificateToPem(certBag.cert);
    const ca = AMAZON_ROOT_CA1;
    return { key, cert, ca };
  }
  /** Generate UUID v4 */
  generateUuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  /**
   * HTTPS POST helper
   *
   * @param url Full URL to POST to
   * @param body Request body object
   * @param extraHeaders Additional HTTP headers
   */
  httpsPost(url, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const postData = JSON.stringify(body);
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          path: u.pathname,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            ...extraHeaders
          },
          timeout: 15e3
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            var _a;
            const raw = Buffer.concat(chunks).toString();
            if (((_a = res.statusCode) != null ? _a : 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Timeout")));
      req.write(postData);
      req.end();
    });
  }
  /**
   * HTTPS GET helper
   *
   * @param url Full URL to GET
   * @param headers HTTP headers
   */
  httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          method: "GET",
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers,
          timeout: 15e3
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            var _a;
            const raw = Buffer.concat(chunks).toString();
            if (((_a = res.statusCode) != null ? _a : 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Timeout")));
      req.end();
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeMqttClient
});
//# sourceMappingURL=govee-mqtt-client.js.map
