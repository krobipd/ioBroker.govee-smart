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
var message_router_exports = {};
__export(message_router_exports, {
  MessageRouter: () => MessageRouter
});
module.exports = __toCommonJS(message_router_exports);
var import_types = require("./types");
var import_timing_constants = require("./timing-constants");
var import_i18n = require("./i18n");
class MessageRouter {
  /**
   * @param host Adapter dependencies via the host interface
   * @param probeConnectTimeoutMs How long the "Test login" probe waits for the
   *   MQTT connect edge after login succeeds (default {@link MQTT_PROBE_CONNECT_MS};
   *   tests inject a small value)
   */
  constructor(host, probeConnectTimeoutMs = import_timing_constants.MQTT_PROBE_CONNECT_MS) {
    this.host = host;
    this.probeConnectTimeoutMs = probeConnectTimeoutMs;
  }
  /** Last time `requestCode` was triggered — guards against double-click email spam. */
  lastVerificationRequestMs = 0;
  /** Separate throttle for the `test` action so it doesn't share the requestCode window (SEC-I1). */
  lastTestRequestMs = 0;
  /**
   * Sync entry-point — registered as `this.on("message", ...)`. Wraps the
   * async handler in a catch so unhandled rejections can't crash the adapter.
   *
   * @param obj Incoming ioBroker message
   */
  onMessage(obj) {
    if (!(obj == null ? void 0 : obj.command)) {
      return;
    }
    this.handleMessage(obj).catch((e) => {
      this.host.log.warn(`onMessage handler crashed for ${obj.command}: ${(0, import_types.errMessage)(e)}`);
      this.host.sendResponse(obj, { error: e instanceof Error ? e.message : String(e) });
    });
  }
  /**
   * Async handler — dispatches to the 3 sub-handlers.
   *
   * @param obj Incoming ioBroker message
   */
  async handleMessage(obj) {
    var _a, _b, _c, _d, _e;
    try {
      if (obj.command === "getSegmentDevices") {
        this.host.sendResponse(obj, this.host.getSegmentDeviceList());
        return;
      }
      if (obj.command === "segmentWizard") {
        const payload = (_a = obj.message) != null ? _a : {};
        const response = await this.host.runWizardStep((_b = payload.action) != null ? _b : "", (_c = payload.device) != null ? _c : "");
        this.host.sendResponse(obj, response);
        return;
      }
      if (obj.command === "mqttAuth") {
        const payload = (_d = obj.message) != null ? _d : {};
        const response = await this.runMqttAuthAction((_e = payload.action) != null ? _e : "");
        this.host.sendResponse(obj, response);
        return;
      }
      this.host.log.debug(`onMessage: unknown command '${obj.command}'`);
      this.host.sendResponse(obj, { error: `Unknown command '${obj.command}'` });
    } catch (e) {
      this.host.log.warn(`onMessage failed for ${obj.command}: ${(0, import_types.errMessage)(e)}`);
      this.host.sendResponse(obj, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  /**
   * Handle the `mqttAuth` onMessage commands.
   *
   * Two actions:
   *   - `test`        — try a one-shot login with the current settings combo
   *                     and return a single user-readable result.
   *   - `requestCode` — POST to /verification, Govee mails a fresh code.
   *                     30s in-memory throttle against double-click email spam.
   *
   * @param action Action name from the jsonConfig sendTo button
   */
  async runMqttAuthAction(action) {
    var _a;
    const config = this.host.getConfig();
    if (!config.goveeEmail || !config.goveePassword) {
      return { result: (0, import_i18n.resolveLabel)("mqttAuthNeedCredentials") };
    }
    if (action === "test") {
      const now = Date.now();
      if (now - this.lastTestRequestMs < import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil((import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastTestRequestMs)) / 1e3);
        return { result: (0, import_i18n.resolveLabel)("mqttAuthThrottled", remainingSec) };
      }
      this.lastTestRequestMs = now;
      const probe = this.host.createMqttProbeClient();
      probe.setVerificationCode((_a = config.mqttVerificationCode) != null ? _a : "");
      let probeTimer;
      try {
        let signalConnected = () => {
        };
        const connectedEdge = new Promise((resolve) => {
          signalConnected = resolve;
        });
        await probe.connect(
          () => {
          },
          (isConnected) => {
            if (isConnected) {
              signalConnected(true);
            }
          }
        );
        const connected = await Promise.race([
          connectedEdge,
          new Promise((resolve) => {
            probeTimer = this.host.setTimeout(() => resolve(false), this.probeConnectTimeoutMs);
          })
        ]);
        return {
          result: connected ? (0, import_i18n.resolveLabel)("mqttAuthLoginOk") : (0, import_i18n.resolveLabel)("mqttAuthLoginNoMqtt")
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Verification required/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthVerifyRequired") };
        }
        if (/Verification code invalid/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthCodeInvalid") };
        }
        if (/email not registered/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthEmailNotRegistered") };
        }
        if (/Login failed/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthPasswordRejected") };
        }
        if (/Rate limited/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthRateLimited") };
        }
        if (/Account temporarily locked/i.test(msg)) {
          return { result: (0, import_i18n.resolveLabel)("mqttAuthAccountLocked") };
        }
        return { result: (0, import_i18n.resolveLabel)("mqttAuthLoginFailed", msg) };
      } finally {
        if (probeTimer) {
          this.host.clearTimeout(probeTimer);
        }
        probe.disconnect();
      }
    }
    if (action === "requestCode") {
      const now = Date.now();
      if (now - this.lastVerificationRequestMs < import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil(
          (import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastVerificationRequestMs)) / 1e3
        );
        return { result: (0, import_i18n.resolveLabel)("mqttAuthThrottled", remainingSec) };
      }
      this.lastVerificationRequestMs = now;
      const probe = this.host.createMqttProbeClient();
      try {
        await probe.requestVerificationCode();
        return { result: (0, import_i18n.resolveLabel)("mqttAuthCodeSent") };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { result: (0, import_i18n.resolveLabel)("mqttAuthCodeRejected", msg) };
      }
    }
    return { result: (0, import_i18n.resolveLabel)("mqttAuthUnknownAction", action) };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MessageRouter
});
//# sourceMappingURL=message-router.js.map
