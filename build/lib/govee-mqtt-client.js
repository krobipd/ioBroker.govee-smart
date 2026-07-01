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
var crypto = __toESM(require("node:crypto"));
var forge = __toESM(require("node-forge"));
var mqtt = __toESM(require("mqtt"));
var import_http_client = require("./http-client");
var import_govee_constants = require("./govee-constants");
var import_timing_constants = require("./timing-constants");
var import_reconnecting_mqtt_client = require("./reconnecting-mqtt-client");
var import_types = require("./types");
const LOGIN_URL = "https://app2.govee.com/account/rest/account/v2/login";
const IOT_KEY_URL = "https://app2.govee.com/app/v1/account/iot/key";
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
class GoveeMqttClient extends import_reconnecting_mqtt_client.ReconnectingMqttClient {
  email;
  password;
  httpsRequestImpl;
  mqttConnectImpl;
  accountTopic = "";
  _bearerToken = "";
  accountId = "";
  /**
   * Stable session UUID, generated once per adapter process.
   * AWS IoT uses the clientId to track connection ownership — reusing the
   * same id on reconnect lets the broker cleanly take over from a stale
   * socket instead of refusing a new connection while the old one lingers.
   */
  sessionUuid = crypto.randomUUID();
  authFailCount = 0;
  onStatus = null;
  onConnection = null;
  onToken = null;
  /** Channel label used in reconnect log lines. */
  channelLabel = "MQTT";
  /**
   * Diagnostics hook — called for each parsed message with the device id,
   * source topic and either an op.command hex string (BLE bytes) or the
   * raw JSON envelope. The hook is responsible for forwarding to a
   * DiagnosticsCollector if one is set up. v2.9.1: rawJson is always
   * forwarded so state-only pushes (no op.command) are captured too —
   * old shape only fired on op.command BLE strings.
   */
  onPacket = null;
  /** Account-derived client ID (UUIDv5(email)) — stable per account, distinct per user. */
  clientId;
  /** Optional 2FA code — set once after a 454, sent in the next login body, then cleared. */
  verificationCode = "";
  /** Fired after a successful login that consumed a verification code, so the adapter can blank the settings field. */
  onVerificationConsumed = null;
  /** Fired on 454 (pending) or 455 (failed) so the adapter can surface the actionable warning + auto-clear the code on failed. */
  onVerificationFailed = null;
  /** Fired when repeated logins are rejected for bad credentials (not 2FA) so the adapter can surface "check email/password". */
  onAuthFailed = null;
  /** Persisted credentials from a previous run; null until setPersistedCredentials() is called. */
  persisted = null;
  /** Hook fired after a successful login so the adapter can persist the new credentials. */
  onCredentialsRefresh = null;
  /** Pre-scheduled timer for proactive token refresh (5 min before expiry). */
  refreshTimer = void 0;
  /**
   * True between calling mqtt.connect() with persisted creds and the first
   * `connect` event. If `close` fires while this is still true, the cached
   * cert/token are invalid — wipe them so the next attempt does a fresh login.
   */
  persistedAttemptInFlight = false;
  /**
   * Last time `requestVerificationCode` actually issued a request — guards
   * against Govee marking the account as suspicious from rapid-fire user clicks.
   */
  lastVerificationRequestMs = 0;
  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param httpsRequestImpl optional DI for tests — default is the real httpsRequest
   * @param mqttConnectImpl optional DI for tests — default is the real mqtt.connect
   */
  constructor(email, password, log, timers, httpsRequestImpl = import_http_client.httpsRequest, mqttConnectImpl = mqtt.connect) {
    super(log, timers);
    this.email = email;
    this.password = password;
    this.httpsRequestImpl = httpsRequestImpl;
    this.mqttConnectImpl = mqttConnectImpl;
    this.clientId = (0, import_govee_constants.deriveGoveeClientId)(email);
  }
  /**
   * Set the optional 2FA verification code. Empty string clears it.
   *
   * @param code Code from the Govee verification email
   */
  setVerificationCode(code) {
    this.verificationCode = (code != null ? code : "").trim();
  }
  /**
   * Hook called when a login successfully consumed a verification code.
   * Adapter wires this to clear the settings field.
   *
   * @param cb Callback
   */
  setOnVerificationConsumed(cb) {
    this.onVerificationConsumed = cb;
  }
  /**
   * Hook called when Govee returned 454 (pending) or 455 (failed). Reason
   * lets the adapter clear the settings field on `failed` and prompt the
   * user to request a code on `pending`.
   *
   * @param cb Callback
   */
  setOnVerificationFailed(cb) {
    this.onVerificationFailed = cb;
  }
  /**
   * Hook called once repeated logins are rejected for bad credentials (not
   * 2FA) — lets the adapter surface a "check email/password" actionable problem.
   *
   * @param cb Callback
   */
  setOnAuthFailed(cb) {
    this.onAuthFailed = cb;
  }
  /** Bearer token from login — available after connect, used for undocumented API */
  get token() {
    return this._bearerToken;
  }
  /**
   * Short user-facing reason for "MQTT not connected", or null if the
   * client has never seen an error. Used by the adapter ready-summary
   * to give a concrete message instead of "still pending".
   */
  getFailureReason() {
    if (this.connected) {
      return null;
    }
    switch (this.lastErrorCategory) {
      case "VERIFICATION_PENDING":
        return "Govee asked for verification \u2014 request a code in adapter settings";
      case "VERIFICATION_FAILED":
        return "verification code rejected \u2014 request a fresh code";
      case "AUTH":
        return this.authFailCount >= import_timing_constants.MQTT_MAX_AUTH_FAILURES ? "login rejected \u2014 check email/password" : "login failed (will retry)";
      case "RATE_LIMIT":
        return "rate-limited by Govee \u2014 will retry";
      case "NETWORK":
        return "cannot reach Govee servers \u2014 will retry";
      case "TIMEOUT":
        return "connection timeout \u2014 will retry";
      case "UNKNOWN":
        return "login rejected \u2014 see earlier log";
      case null:
      default:
        return null;
    }
  }
  /**
   * Hand the client persisted credentials from a previous successful login.
   * If the bearer token is not yet expired, the next connect() will skip the
   * full login flow and try MQTT with the stored cert directly.
   *
   * @param creds Persisted credentials, or null to clear
   */
  setPersistedCredentials(creds) {
    this.persisted = creds;
  }
  /**
   * Fired after a successful login so the adapter can write the bundle to
   * `encryptedNative`/`native`. Includes the (potentially refreshed) TTL.
   *
   * @param cb Callback
   */
  setOnCredentialsRefresh(cb) {
    this.onCredentialsRefresh = cb;
  }
  /**
   * Connect to Govee MQTT.
   * Flow: Login → Get IoT Key → Extract certs from P12 → Connect MQTT
   *
   * @param onStatus Called on device status updates
   * @param onConnection Called on connection state changes
   * @param onToken Called with every fresh bearer token (initial + each reconnect-login)
   */
  async connect(onStatus, onConnection, onToken) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    this.onStatus = onStatus;
    this.onConnection = onConnection;
    if (onToken) {
      this.onToken = onToken;
    }
    try {
      if (this.tryPersistedReuse()) {
        return;
      }
      const codeWasSent = ((_a = this.verificationCode) != null ? _a : "").trim().length > 0;
      const loginResp = await this.login();
      if (!loginResp.client) {
        const apiStatus = (_b = loginResp.status) != null ? _b : 0;
        const apiMsg = (_c = loginResp.message) != null ? _c : "unknown error";
        const statusStr = `(status ${apiStatus || "?"})`;
        this.log.debug(`MQTT login error response body: ${JSON.stringify(loginResp).slice(0, 300)}`);
        if (apiStatus === 455 || apiStatus === 454 && codeWasSent) {
          throw new Error(`Verification code invalid or expired ${statusStr}`);
        }
        if (apiStatus === 454) {
          throw new Error(`Verification required by Govee \u2014 request a code via Adapter settings ${statusStr}`);
        }
        if (apiStatus === 429 || /too many|rate.?limit|frequent|throttl/i.test(apiMsg)) {
          throw new Error(`Rate limited by Govee: ${apiMsg} ${statusStr}`);
        }
        if (apiStatus === 451 || /not.*registered/i.test(apiMsg)) {
          throw new Error(`Login failed: email not registered ${statusStr}`);
        }
        if (apiStatus === 401 || /password|credential|unauthorized/i.test(apiMsg)) {
          throw new Error(`Login failed: ${apiMsg} ${statusStr}`);
        }
        if (/abnormal|blocked|suspended|disabled/i.test(apiMsg)) {
          throw new Error(`Account temporarily locked by Govee: ${apiMsg} ${statusStr}`);
        }
        throw new Error(`Govee login rejected: ${apiMsg} ${statusStr}`);
      }
      if (codeWasSent) {
        this.verificationCode = "";
        (_d = this.onVerificationConsumed) == null ? void 0 : _d.call(this);
      }
      const accIdRaw = loginResp.client.accountId;
      if (typeof accIdRaw !== "string" && typeof accIdRaw !== "number") {
        throw new Error(`Login response missing accountId (got ${typeof accIdRaw})`);
      }
      const topicRaw = loginResp.client.topic;
      if (typeof topicRaw !== "string" || topicRaw.length === 0) {
        throw new Error(`Login response missing account topic (got ${typeof topicRaw})`);
      }
      this._bearerToken = loginResp.client.token;
      this.accountId = String(accIdRaw);
      this.accountTopic = topicRaw;
      (_e = this.onToken) == null ? void 0 : _e.call(this, this._bearerToken);
      if (this.disposed) {
        return;
      }
      const iotResp = await this.getIotKey();
      if (!((_f = iotResp.data) == null ? void 0 : _f.endpoint)) {
        throw new Error("IoT key response missing endpoint/certificate data");
      }
      const { endpoint, p12, p12Pass } = iotResp.data;
      if (this.disposed) {
        return;
      }
      const { key, cert, ca } = this.extractCertsFromP12(p12, p12Pass);
      const ttlSec = (_h = (_g = loginResp.client.token_expire_cycle) != null ? _g : loginResp.client.tokenExpireCycle) != null ? _h : 3600;
      const expiresAt = Date.now() + ttlSec * 1e3;
      (_i = this.onCredentialsRefresh) == null ? void 0 : _i.call(this, {
        bearerToken: this._bearerToken,
        iotEndpoint: endpoint,
        p12Cert: p12,
        p12Pass,
        accountId: this.accountId,
        accountTopic: this.accountTopic,
        tokenExpiresAt: expiresAt
      });
      this.scheduleProactiveRefresh(expiresAt);
      const clientId = `AP/${this.accountId}/${this.sessionUuid}`;
      this.client = this.mqttConnectImpl(`mqtts://${endpoint}:8883`, {
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
      this.attachClientHandlers();
    } catch (err) {
      const category = (0, import_types.classifyError)(err);
      const msg = `MQTT connection failed: ${(0, import_types.errMessage)(err)}`;
      (_j = this.onConnection) == null ? void 0 : _j.call(this, false);
      if (category === "VERIFICATION_PENDING") {
        const isNew = this.lastErrorCategory !== category;
        this.lastErrorCategory = category;
        if (isNew) {
          this.log.warn(`MQTT not connected: Govee asked for verification \u2014 request a code in adapter settings`);
        } else {
          this.log.debug("MQTT verification still pending (Govee returned 454 again)");
        }
        if (this.onVerificationFailed) {
          this.onVerificationFailed("pending");
        }
        return;
      }
      if (category === "VERIFICATION_FAILED") {
        const isNew = this.lastErrorCategory !== category;
        this.lastErrorCategory = category;
        if (isNew) {
          this.log.warn(`MQTT not connected: verification code rejected \u2014 request a fresh code`);
        } else {
          this.log.debug("MQTT verification code rejected again (Govee returned 455)");
        }
        if (this.onVerificationFailed) {
          this.onVerificationFailed("failed");
        }
        return;
      }
      if (category === "AUTH") {
        this.authFailCount++;
        if (this.authFailCount >= import_timing_constants.MQTT_MAX_AUTH_FAILURES) {
          this.log.warn(`MQTT not connected: login rejected \u2014 check email/password`);
          (_k = this.onAuthFailed) == null ? void 0 : _k.call(this);
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
  /** Stop reconnecting after repeated auth failures (check email/password). */
  reconnectExhausted() {
    return this.authFailCount >= import_timing_constants.MQTT_MAX_AUTH_FAILURES;
  }
  /** Re-enter the full connect()/login flow when a backoff timer fires. */
  reconnect() {
    if (this.onStatus && this.onConnection) {
      void this.connect(this.onStatus, this.onConnection);
    }
  }
  /**
   * Clear the proactive-refresh timer on disconnect — the base disconnect()
   * calls this hook. Otherwise the adapter stop would leave it armed and
   * refreshBearerSilently() would fire login calls against a torn-down adapter.
   */
  disposeExtras() {
    if (this.refreshTimer) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = void 0;
    }
  }
  /**
   * Parse MQTT status message
   *
   * @param payload Raw MQTT message buffer
   * @param topic   AWS-IoT topic the message arrived on
   */
  handleMessage(payload, topic) {
    var _a;
    const rawText = payload.toString();
    try {
      const raw = JSON.parse(rawText);
      const sku = typeof raw.sku === "string" ? raw.sku : "";
      const device = typeof raw.device === "string" ? raw.device : "";
      const state = raw.state && typeof raw.state === "object" ? raw.state : void 0;
      const op = raw.op && typeof raw.op === "object" ? raw.op : void 0;
      if (sku || device) {
        (_a = this.onStatus) == null ? void 0 : _a.call(this, { sku, device, state, op });
        if (this.onPacket && device) {
          if (Array.isArray(op == null ? void 0 : op.command)) {
            for (const cmd of op.command) {
              if (typeof cmd === "string" && cmd) {
                this.onPacket(device, topic, { hex: cmd, rawJson: rawText });
              }
            }
          } else {
            this.onPacket(device, topic, { rawJson: rawText });
          }
        }
      }
    } catch {
      this.log.debug(`MQTT: Failed to parse message: ${rawText.slice(0, 200)}`);
    }
  }
  /**
   * Register a hook called for every parsed MQTT packet. Used by the
   * adapter to forward op.command hex strings + the raw JSON envelope into
   * the DiagnosticsCollector for `diag.export`.
   *
   * @param cb Callback receiving (deviceId, topic, {hex?, rawJson?})
   */
  setPacketHook(cb) {
    this.onPacket = cb;
  }
  /**
   * Reuse path: if a persisted bundle exists and is not expired yet, try
   * MQTT directly with the stored cert. Returns true if a connection was
   * initiated (caller should NOT continue to login).
   *
   * Uses the same ON-event handlers as the full login path — a successful
   * connect publishes `mqttConnected: true` exactly like a fresh login.
   * On failure (cert rejected, token revoked, network) we just return false
   * and the caller falls through to the full login.
   */
  tryPersistedReuse() {
    var _a;
    const creds = this.persisted;
    if (!creds || !creds.bearerToken || !creds.iotEndpoint || !creds.p12Cert) {
      return false;
    }
    if (creds.tokenExpiresAt <= Date.now()) {
      return false;
    }
    let extracted;
    try {
      extracted = this.extractCertsFromP12(creds.p12Cert, creds.p12Pass);
    } catch (e) {
      this.log.debug(`Persisted P12 cert unusable: ${(0, import_types.errMessage)(e)} \u2014 falling back to fresh login`);
      return false;
    }
    this._bearerToken = creds.bearerToken;
    this.accountId = creds.accountId;
    this.accountTopic = creds.accountTopic;
    (_a = this.onToken) == null ? void 0 : _a.call(this, this._bearerToken);
    const clientId = `AP/${creds.accountId}/${this.sessionUuid}`;
    this.log.debug("MQTT: trying cached credentials (no fresh login)");
    this.persistedAttemptInFlight = true;
    this.client = this.mqttConnectImpl(`mqtts://${creds.iotEndpoint}:8883`, {
      clientId,
      key: extracted.key,
      cert: extracted.cert,
      ca: extracted.ca,
      protocolVersion: 4,
      keepalive: 60,
      reconnectPeriod: 0,
      rejectUnauthorized: true
    });
    this.attachClientHandlers();
    this.scheduleProactiveRefresh(creds.tokenExpiresAt);
    return true;
  }
  /**
   * Attach the standard `connect` / `message` / `error` / `close` handlers
   * to the current `this.client`. Extracted so both paths (fresh login and
   * persisted reuse) share exactly the same event wiring.
   */
  attachClientHandlers() {
    if (!this.client) {
      return;
    }
    this.client.on("connect", () => {
      var _a, _b;
      const wasCached = this.persistedAttemptInFlight;
      this.persistedAttemptInFlight = false;
      const broker = (_b = (_a = this.persisted) == null ? void 0 : _a.iotEndpoint) != null ? _b : "?";
      const clientId = `AP/${this.accountId}/${this.sessionUuid}`;
      const authMode = wasCached ? "cached" : "fresh";
      this.log.debug(`MQTT connected (CONNACK): broker=${broker} clientId=${clientId} authMode=${authMode}`);
      this.subscribeOrForceClose(
        this.accountTopic,
        () => {
          var _a2;
          this.reconnectAttempts = 0;
          this.authFailCount = 0;
          if (this.lastErrorCategory) {
            this.log.info(`MQTT connection restored: broker=${broker} clientId=${clientId} authMode=${authMode}`);
            this.lastErrorCategory = null;
          }
          this.log.debug(`MQTT subscribed to account topic: topic=${this.accountTopic} qos=0`);
          (_a2 = this.onConnection) == null ? void 0 : _a2.call(this, true);
        },
        // Subscribe-fail is rare (AWS-IoT policy mismatch, account flagged) but
        // leaves the TCP connection alive — the base forces a close so the
        // close-handler → scheduleReconnect path runs instead of a silent death.
        (msg) => this.log.warn(`MQTT subscribe failed: ${msg} \u2014 forcing reconnect`)
      );
    });
    this.client.on("message", (topic, payload) => {
      this.handleMessage(payload, topic);
    });
    this.client.on("error", (err) => {
      this.lastErrorCategory = (0, import_types.logDedup)(this.log, this.lastErrorCategory, "MQTT", err);
    });
    this.client.on("close", () => {
      var _a;
      (_a = this.onConnection) == null ? void 0 : _a.call(this, false);
      if (this.persistedAttemptInFlight) {
        this.persistedAttemptInFlight = false;
        this.persisted = null;
        this.log.debug("MQTT: cached credentials rejected \u2014 falling back to fresh login");
      }
      if (!this.lastErrorCategory) {
        this.lastErrorCategory = "NETWORK";
        this.log.debug("MQTT disconnected \u2014 will reconnect");
      }
      this.scheduleReconnect();
    });
  }
  /**
   * Schedule a proactive token refresh 5 minutes before bearer expiry.
   *
   * v2.1.0 disconnect+reconnect was disruptive: it killed the live MQTT
   * session, then triggered a fresh login. If Govee responded with 454
   * (e.g. account flagged for re-verification), the user saw the 2FA
   * warning even though MQTT was previously working — and the
   * disconnect dropped status push for the duration of the re-auth.
   *
   * v2.1.1: silent re-login. We just call /v1/login, save the new
   * bearer + cert (so the next adapter restart skips full login), and
   * let the existing MQTT session keep running. The current cert may
   * stay valid past the bearer's expiry — losing the bearer only
   * affects API-key-less REST calls, not the live MQTT push channel.
   *
   * @param expiresAt ms-timestamp at which the bearer token will be rejected
   */
  scheduleProactiveRefresh(expiresAt) {
    if (this.refreshTimer) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = void 0;
    }
    const refreshAt = expiresAt - 5 * 60 * 1e3;
    const delay = refreshAt - Date.now();
    if (delay <= 0) {
      return;
    }
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = void 0;
      void this.refreshBearerSilently();
    }, delay);
  }
  /**
   * Refresh the bearer token without disconnecting MQTT. Called by the
   * proactive-refresh timer. Failures don't disrupt the live session —
   * the next reconnect-cycle (if Govee invalidates the cert) handles
   * recovery via the normal connect() path.
   */
  async refreshBearerSilently() {
    var _a, _b, _c, _d, _e, _f;
    if (this.disposed) {
      return;
    }
    this.log.debug("Proactive MQTT bearer refresh triggered");
    try {
      const loginResp = await this.login();
      if (!loginResp.client) {
        const status = (_a = loginResp.status) != null ? _a : 0;
        this.log.debug(`Silent bearer refresh declined by Govee (status ${status}) \u2014 current session kept`);
        return;
      }
      this._bearerToken = loginResp.client.token;
      (_b = this.onToken) == null ? void 0 : _b.call(this, this._bearerToken);
      const ttlSec = (_d = (_c = loginResp.client.token_expire_cycle) != null ? _c : loginResp.client.tokenExpireCycle) != null ? _d : 3600;
      const newExpiresAt = Date.now() + ttlSec * 1e3;
      try {
        const iotResp = await this.getIotKey();
        if ((_e = iotResp == null ? void 0 : iotResp.data) == null ? void 0 : _e.endpoint) {
          (_f = this.onCredentialsRefresh) == null ? void 0 : _f.call(this, {
            bearerToken: this._bearerToken,
            iotEndpoint: iotResp.data.endpoint,
            p12Cert: iotResp.data.p12,
            p12Pass: iotResp.data.p12Pass,
            accountId: this.accountId,
            accountTopic: this.accountTopic,
            tokenExpiresAt: newExpiresAt
          });
        }
      } catch (e) {
        this.log.debug(`Silent IoT-key refresh failed: ${(0, import_types.errMessage)(e)}`);
      }
      this.scheduleProactiveRefresh(newExpiresAt);
    } catch (e) {
      this.log.debug(`Silent bearer refresh failed: ${(0, import_types.errMessage)(e)} \u2014 current session kept`);
    }
  }
  /** Login to Govee account */
  async login() {
    var _a;
    const body = {
      email: this.email,
      password: this.password,
      client: this.clientId
    };
    const code = ((_a = this.verificationCode) != null ? _a : "").trim();
    if (code) {
      body.code = code;
    }
    const result = await this.httpsRequestImpl({
      method: "POST",
      url: LOGIN_URL,
      headers: {
        appVersion: import_govee_constants.GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: import_govee_constants.GOVEE_CLIENT_TYPE,
        iotVersion: "0",
        timestamp: String(Date.now()),
        "User-Agent": import_govee_constants.GOVEE_USER_AGENT
      },
      body
    });
    if (!result.value) {
      throw new Error(
        `Govee login returned no body (status=${result.statusCode}${result.fallback ? `, fallback=${result.fallback}` : ""}${result.bodySnippet ? `, body=${JSON.stringify(result.bodySnippet)}` : ""})`
      );
    }
    return result.value;
  }
  /**
   * Trigger Govee's verification-code email. Govee sends a one-time code
   * to the account email; the user pastes it into Settings.
   *
   * Status 200 → email queued. The response body is irrelevant for the
   * adapter — Govee may include a tracking token but we don't use it.
   *
   * In-memory throttle of {@link VERIFICATION_REQUEST_THROTTLE_MS} (30 s)
   * mirrors the message-router's user-side throttle but lives here too so
   * other entry points (programmatic restarts, future scripted access)
   * can't bypass it.
   *
   * Throws on non-200, network failure or throttle-block so the caller
   * (onMessage handler) can surface the error to the admin UI.
   */
  async requestVerificationCode() {
    const now = Date.now();
    const elapsed = now - this.lastVerificationRequestMs;
    if (this.lastVerificationRequestMs > 0 && elapsed < import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS) {
      const throttleRemainingSec = Math.ceil((import_timing_constants.VERIFICATION_REQUEST_THROTTLE_MS - elapsed) / 1e3);
      throw new Error(`Verification code request throttled \u2014 wait ${throttleRemainingSec}s before retrying.`);
    }
    this.lastVerificationRequestMs = now;
    const url = "https://app2.govee.com/account/rest/account/v1/verification";
    await this.httpsRequestImpl({
      method: "POST",
      url,
      headers: {
        appVersion: import_govee_constants.GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: import_govee_constants.GOVEE_CLIENT_TYPE,
        iotVersion: "0",
        timestamp: String(Date.now()),
        "User-Agent": import_govee_constants.GOVEE_USER_AGENT
      },
      body: {
        type: 8,
        email: this.email
      }
    });
  }
  /** Get IoT key (P12 certificate) */
  async getIotKey() {
    const result = await this.httpsRequestImpl({
      method: "GET",
      url: IOT_KEY_URL,
      headers: {
        Authorization: `Bearer ${this._bearerToken}`,
        appVersion: import_govee_constants.GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: import_govee_constants.GOVEE_CLIENT_TYPE,
        "User-Agent": import_govee_constants.GOVEE_USER_AGENT
      }
    });
    if (!result.value) {
      throw new Error(
        `Govee IoT-key request returned no body (status=${result.statusCode}${result.fallback ? `, fallback=${result.fallback}` : ""})`
      );
    }
    return result.value;
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
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeMqttClient
});
//# sourceMappingURL=govee-mqtt-client.js.map
