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
var reconnecting_mqtt_client_exports = {};
__export(reconnecting_mqtt_client_exports, {
  ReconnectingMqttClient: () => ReconnectingMqttClient,
  computeBackoffDelay: () => computeBackoffDelay
});
module.exports = __toCommonJS(reconnecting_mqtt_client_exports);
function computeBackoffDelay(attempt, opts, rand = Math.random()) {
  const base = Math.min(opts.base * Math.pow(2, attempt - 1), opts.cap);
  const jitter = rand * Math.min(base, opts.jitterCap);
  return Math.round(base + jitter);
}
class ReconnectingMqttClient {
  /**
   * @param log ioBroker logger
   * @param timers Timer adapter (managed setTimeout/clearTimeout)
   */
  constructor(log, timers) {
    this.log = log;
    this.timers = timers;
  }
  log;
  timers;
  /** Live mqtt client, or null while disconnected. */
  client = null;
  /** Armed backoff timer between a failed attempt and the next reconnect. */
  reconnectTimer = void 0;
  /** Consecutive reconnect attempts; reset to 0 by the subclass on a successful connect. */
  reconnectAttempts = 0;
  /** Last classified error category, for warn-once / debug-on-repeat dedup. */
  lastErrorCategory = null;
  /**
   * Raw message of the last connect failure — kept alongside the category so
   * probes can distinguish sub-cases (e.g. "email not registered" within AUTH).
   */
  lastErrorMessage = null;
  /** Set in disconnect(); reconnect paths bail on it so timers that fire after stop are no-ops. */
  disposed = false;
  /** Whether the underlying client is currently connected. */
  get connected() {
    var _a, _b;
    return (_b = (_a = this.client) == null ? void 0 : _a.connected) != null ? _b : false;
  }
  /** Hook for subclass-specific timer teardown (e.g. proactive-refresh timer). No-op by default. */
  disposeExtras() {
  }
  /**
   * Schedule the next reconnect with exponential backoff + jitter. No-op if
   * disposed, already armed, or the subclass's failure cap is reached. M6:
   * jitter guards against a thundering herd — during a distributed Govee outage
   * thousands of adapters would otherwise sync to the exact second.
   */
  scheduleReconnect() {
    if (this.disposed) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    if (this.reconnectExhausted()) {
      return;
    }
    this.reconnectAttempts++;
    const delay = computeBackoffDelay(this.reconnectAttempts, { base: 5e3, cap: 3e5, jitterCap: 3e4 });
    this.log.debug(`${this.channelLabel}: reconnecting in ${delay / 1e3}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = void 0;
      if (this.disposed) {
        return;
      }
      this.reconnect();
    }, delay);
  }
  /** Disconnect and clean up: stop reconnect, run subclass teardown, end the client. */
  disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    this.disposeExtras();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on("error", () => {
      });
      this.client.end(true);
      this.client = null;
    }
  }
  /**
   * Subscribe to `topic` (qos 0). On subscribe-failure force a close so the
   * close-handler's scheduleReconnect runs: a failed subscribe leaves the TCP
   * socket alive (keepalive pings keep answering), so `close` would never fire
   * on its own — a permanent silent death without the forced close.
   *
   * @param topic Topic to subscribe to
   * @param onSubscribed Called once the subscribe succeeds
   * @param onSubscribeFail Called with the error message just before the forced close
   */
  subscribeOrForceClose(topic, onSubscribed, onSubscribeFail) {
    var _a;
    (_a = this.client) == null ? void 0 : _a.subscribe(topic, { qos: 0 }, (err) => {
      var _a2;
      if (err) {
        onSubscribeFail(err.message);
        try {
          (_a2 = this.client) == null ? void 0 : _a2.end(true);
        } catch {
        }
      } else {
        onSubscribed();
      }
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ReconnectingMqttClient,
  computeBackoffDelay
});
//# sourceMappingURL=reconnecting-mqtt-client.js.map
