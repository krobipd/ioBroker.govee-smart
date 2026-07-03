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
var crypto = __toESM(require("node:crypto"));
var mqtt = __toESM(require("mqtt"));
var import_timing_constants = require("./timing-constants");
var import_reconnecting_mqtt_client = require("./reconnecting-mqtt-client");
var import_types = require("./types");
const BROKER_URL = "mqtts://mqtt.openapi.govee.com:8883";
class GoveeOpenapiMqttClient extends import_reconnecting_mqtt_client.ReconnectingMqttClient {
  apiKey;
  /**
   * Stable client ID for the lifetime of the adapter instance. Generated once
   * in the constructor so reconnects keep the same identity — Govee's broker
   * can then take over the previous socket cleanly instead of rejecting the
   * new connection as a duplicate. Reusing Date.now() per connect() created a
   * fresh ID on every reconnect.
   */
  sessionUuid = crypto.randomUUID();
  topic;
  /** Masked form of {@link topic} for logging — never exposes the raw API key (H1). */
  topicLabel;
  /** Consecutive connect/auth failures — caps reconnect via reconnectExhausted(). */
  connectFailCount = 0;
  onEvent = null;
  onRaw = null;
  onConnection = null;
  /** Channel label used in reconnect log lines. */
  channelLabel = "Cloud-events";
  /**
   * @param apiKey Govee Cloud API key (used as username AND password)
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(apiKey, log, timers) {
    super(log, timers);
    this.apiKey = apiKey;
    this.topic = `GA/${apiKey}`;
    this.topicLabel = `GA/${(0, import_types.maskSecret)(apiKey)}`;
  }
  /** Stop reconnecting once the API key has been rejected too many times. */
  reconnectExhausted() {
    return this.connectFailCount >= import_timing_constants.OPENAPI_MQTT_MAX_AUTH_FAILURES;
  }
  /** Re-enter connect() with the stored callbacks when a backoff timer fires. */
  reconnect() {
    var _a;
    if (this.onEvent && this.onConnection) {
      this.connect(this.onEvent, this.onConnection, (_a = this.onRaw) != null ? _a : void 0);
    }
  }
  /**
   * Connect to the Cloud-events broker.
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
        clientId: `iob_govee_smart_${this.sessionUuid}`,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0,
        rejectUnauthorized: true
      });
      const clientId = `iob_govee_smart_${this.sessionUuid}`;
      this.log.debug(`Cloud-events connecting: broker=${BROKER_URL} clientId=${clientId} authMode=apiKey`);
      this.client.on("connect", () => {
        this.log.debug(
          `Cloud-events connected (CONNACK): broker=${BROKER_URL} clientId=${clientId} topic=${this.topicLabel}`
        );
        this.subscribeOrForceClose(
          this.topic,
          () => {
            var _a;
            this.reconnectAttempts = 0;
            this.connectFailCount = 0;
            if (this.lastErrorCategory) {
              this.log.info(
                `Cloud-events connection restored: broker=${BROKER_URL} clientId=${clientId} topic=${this.topicLabel}`
              );
              this.lastErrorCategory = null;
            }
            this.log.debug(`Cloud-events subscribed to event topic: topic=${this.topicLabel} qos=0`);
            (_a = this.onConnection) == null ? void 0 : _a.call(this, true);
          },
          (msg) => this.log.warn(`Cloud-events subscribe failed: topic=${this.topicLabel} err="${msg}" \u2014 forcing reconnect`)
        );
      });
      this.client.on("message", (_topic, payload) => {
        this.handleMessage(payload);
      });
      this.client.on("error", (err) => {
        var _a, _b;
        const category = (0, import_types.classifyError)(err);
        if (category === "AUTH") {
          this.connectFailCount++;
          if (this.connectFailCount >= import_timing_constants.OPENAPI_MQTT_MAX_AUTH_FAILURES) {
            this.log.warn(`Cloud-events auth failed repeatedly \u2014 check API key`);
            (_a = this.onConnection) == null ? void 0 : _a.call(this, false);
            this.disconnect();
            return;
          }
        }
        this.log.debug(`Cloud-events error: ${err.message}`);
        if (category === "NETWORK" || category === "TIMEOUT") {
          try {
            (_b = this.client) == null ? void 0 : _b.end(true);
          } catch {
          }
        }
      });
      this.client.on("close", () => {
        var _a;
        (_a = this.onConnection) == null ? void 0 : _a.call(this, false);
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("Cloud-events disconnected \u2014 will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = (0, import_types.classifyError)(err);
      const msg = `Cloud-events connection failed: ${(0, import_types.errMessage)(err)}`;
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
   * Parse incoming MQTT event message.
   * Expected format: { sku, device, capabilities: [{ type, instance, state: { value } }] }
   *
   * @param payload Raw MQTT message buffer
   */
  handleMessage(payload) {
    var _a, _b;
    if (payload.length > 64 * 1024) {
      this.log.debug(`Cloud-events: dropping oversized MQTT message (${payload.length} bytes)`);
      return;
    }
    try {
      const rawStr = payload.toString();
      (_a = this.onRaw) == null ? void 0 : _a.call(this, rawStr);
      const raw = JSON.parse(rawStr);
      const sku = typeof raw.sku === "string" ? raw.sku : "";
      const device = typeof raw.device === "string" ? raw.device : "";
      if (!sku && !device) {
        this.log.debug(`Cloud-events: message without device info: ${payload.toString().slice(0, 200)}`);
        return;
      }
      const rawCaps = raw.capabilities;
      if (!Array.isArray(rawCaps) || rawCaps.length === 0) {
        this.log.debug(`Cloud-events: message without capabilities from ${sku}: ${payload.toString().slice(0, 300)}`);
        return;
      }
      const caps = rawCaps.filter(
        (c) => c !== null && typeof c === "object" && typeof c.type === "string" && typeof c.instance === "string"
      );
      if (caps.length === 0) {
        this.log.debug(`Cloud-events: capabilities all malformed from ${sku}`);
        return;
      }
      const event = { sku, device, capabilities: caps };
      (_b = this.onEvent) == null ? void 0 : _b.call(this, event);
    } catch {
      this.log.debug(`Cloud-events: failed to parse message: ${payload.toString().slice(0, 200)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeOpenapiMqttClient
});
//# sourceMappingURL=govee-openapi-mqtt-client.js.map
