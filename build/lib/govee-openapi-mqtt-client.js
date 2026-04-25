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
var govee_openapi_mqtt_client_exports = {};
__export(govee_openapi_mqtt_client_exports, {
  GoveeOpenapiMqttClient: () => GoveeOpenapiMqttClient
});
module.exports = __toCommonJS(govee_openapi_mqtt_client_exports);
var mqtt = __toESM(require("mqtt"));
var import_types = require("./types.js");
const MAX_CONNECT_FAILURES = 5;
const BROKER_URL = "mqtts://mqtt.openapi.govee.com:8883";
class GoveeOpenapiMqttClient {
  apiKey;
  log;
  timers;
  client = null;
  topic;
  reconnectTimer = void 0;
  reconnectAttempts = 0;
  connectFailCount = 0;
  lastErrorCategory = null;
  onEvent = null;
  onRaw = null;
  onConnection = null;
  /**
   * @param apiKey Govee Cloud API key (used as username AND password)
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(apiKey, log, timers) {
    this.apiKey = apiKey;
    this.log = log;
    this.timers = timers;
    this.topic = `GA/${apiKey}`;
  }
  /**
   * Connect to the OpenAPI MQTT broker.
   *
   * @param onEvent Called on incoming sensor events
   * @param onConnection Called on connection state changes
   * @param onRaw Called with raw JSON for diagnostics
   */
  connect(onEvent, onConnection, onRaw) {
    this.onEvent = onEvent;
    this.onConnection = onConnection;
    this.onRaw = onRaw != null ? onRaw : null;
    try {
      this.client = mqtt.connect(BROKER_URL, {
        username: this.apiKey,
        password: this.apiKey,
        clientId: `iob_govee_smart_${Date.now().toString(36)}`,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0,
        rejectUnauthorized: true
      });
      this.client.on("connect", () => {
        var _a;
        this.reconnectAttempts = 0;
        this.connectFailCount = 0;
        if (this.lastErrorCategory) {
          this.log.info("OpenAPI MQTT connection restored");
          this.lastErrorCategory = null;
        } else {
          this.log.info("OpenAPI MQTT connected for sensor events");
        }
        (_a = this.client) == null ? void 0 : _a.subscribe(this.topic, { qos: 0 }, (err) => {
          var _a2;
          if (err) {
            this.log.warn(`OpenAPI MQTT subscribe failed: ${err.message}`);
          } else {
            this.log.debug("OpenAPI MQTT subscribed to event topic");
            (_a2 = this.onConnection) == null ? void 0 : _a2.call(this, true);
          }
        });
      });
      this.client.on("message", (_topic, payload) => {
        this.handleMessage(payload);
      });
      this.client.on("error", (err) => {
        var _a;
        const category = (0, import_types.classifyError)(err);
        if (category === "AUTH") {
          this.connectFailCount++;
          if (this.connectFailCount >= MAX_CONNECT_FAILURES) {
            this.log.warn(
              "OpenAPI MQTT auth failed repeatedly \u2014 check API key"
            );
            (_a = this.onConnection) == null ? void 0 : _a.call(this, false);
            this.disconnect();
            return;
          }
        }
        this.log.debug(`OpenAPI MQTT error: ${err.message}`);
      });
      this.client.on("close", () => {
        var _a;
        (_a = this.onConnection) == null ? void 0 : _a.call(this, false);
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("OpenAPI MQTT disconnected \u2014 will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = (0, import_types.classifyError)(err);
      const msg = `OpenAPI MQTT connection failed: ${err instanceof Error ? err.message : String(err)}`;
      if (category !== this.lastErrorCategory) {
        this.lastErrorCategory = category;
        this.log.warn(msg);
      } else {
        this.log.debug(msg);
      }
      this.scheduleReconnect();
    }
  }
  /** Whether the client is currently connected */
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
   * Parse incoming MQTT event message.
   * Expected format: { sku, device, capabilities: [{ type, instance, state: { value } }] }
   *
   * @param payload Raw MQTT message buffer
   */
  handleMessage(payload) {
    var _a, _b, _c, _d;
    try {
      const rawStr = payload.toString();
      (_a = this.onRaw) == null ? void 0 : _a.call(this, rawStr);
      const raw = JSON.parse(rawStr);
      const sku = (_b = raw.sku) != null ? _b : "";
      const device = (_c = raw.device) != null ? _c : "";
      if (!sku && !device) {
        this.log.debug(
          `OpenAPI MQTT: message without device info: ${payload.toString().slice(0, 200)}`
        );
        return;
      }
      const caps = raw.capabilities;
      if (!caps || !Array.isArray(caps) || caps.length === 0) {
        this.log.debug(
          `OpenAPI MQTT: message without capabilities from ${sku}: ${payload.toString().slice(0, 300)}`
        );
        return;
      }
      const event = { sku, device, capabilities: caps };
      (_d = this.onEvent) == null ? void 0 : _d.call(this, event);
    } catch {
      this.log.debug(
        `OpenAPI MQTT: failed to parse message: ${payload.toString().slice(0, 200)}`
      );
    }
  }
  /** Schedule reconnect with exponential backoff */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    if (this.connectFailCount >= MAX_CONNECT_FAILURES) {
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      5e3 * Math.pow(2, this.reconnectAttempts - 1),
      3e5
    );
    this.log.debug(
      `OpenAPI MQTT: reconnecting in ${delay / 1e3}s (attempt ${this.reconnectAttempts})`
    );
    this.reconnectTimer = this.timers.setTimeout(() => {
      var _a;
      this.reconnectTimer = void 0;
      if (this.onEvent && this.onConnection) {
        this.connect(this.onEvent, this.onConnection, (_a = this.onRaw) != null ? _a : void 0);
      }
    }, delay);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeOpenapiMqttClient
});
//# sourceMappingURL=govee-openapi-mqtt-client.js.map
