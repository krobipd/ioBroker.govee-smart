import * as crypto from "node:crypto";
import * as forge from "node-forge";
import * as mqtt from "mqtt";
import { httpsRequest, type HttpsRequestFn } from "./http-client";
import { GOVEE_APP_VERSION, GOVEE_CLIENT_TYPE, GOVEE_USER_AGENT, deriveGoveeClientId } from "./govee-constants";
import { MQTT_MAX_AUTH_FAILURES, VERIFICATION_REQUEST_THROTTLE_MS } from "./timing-constants";
import { ReconnectingMqttClient } from "./reconnecting-mqtt-client";
import {
  classifyError,
  logDedup,
  type GoveeIotKeyResponse,
  type GoveeLoginResponse,
  type MqttStatusUpdate,
  type PersistedMqttCredentials,
  type TimerAdapter,
  errMessage,
} from "./types";

const LOGIN_URL = "https://app2.govee.com/account/rest/account/v2/login";
const IOT_KEY_URL = "https://app2.govee.com/app/v1/account/iot/key";

/** Amazon Root CA 1 — required for AWS IoT Core TLS */
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

/**
 * Signature for the `mqtt.connect` factory — tests can inject a FakeMqttClient
 * without starting the real network lib. Default = `mqtt.connect`.
 */
export type MqttConnectFn = (url: string, opts: mqtt.IClientOptions) => mqtt.MqttClient;

/** Callback for MQTT status updates */
export type MqttStatusCallback = (update: MqttStatusUpdate) => void;

/** Callback for MQTT connection state changes */
export type MqttConnectionCallback = (connected: boolean) => void;

/** Callback fired each time the login hands us a fresh bearer token */
export type MqttTokenCallback = (token: string) => void;

/**
 * Govee AWS IoT MQTT client for real-time status and control.
 * Authenticates via Govee account, connects to AWS IoT Core with mutual TLS.
 */
export class GoveeMqttClient extends ReconnectingMqttClient {
  private readonly email: string;
  private readonly password: string;
  private readonly httpsRequestImpl: HttpsRequestFn;
  private readonly mqttConnectImpl: MqttConnectFn;
  private accountTopic = "";
  private _bearerToken = "";
  private accountId = "";
  /**
   * Stable session UUID, generated once per adapter process.
   * AWS IoT uses the clientId to track connection ownership — reusing the
   * same id on reconnect lets the broker cleanly take over from a stale
   * socket instead of refusing a new connection while the old one lingers.
   */
  private readonly sessionUuid: string = crypto.randomUUID();
  private authFailCount = 0;
  private onStatus: MqttStatusCallback | null = null;
  private onConnection: MqttConnectionCallback | null = null;
  private onToken: MqttTokenCallback | null = null;

  /** Channel label used in reconnect log lines. */
  protected readonly channelLabel = "MQTT";
  /**
   * Diagnostics hook — called for each parsed message with the device id,
   * source topic and either an op.command hex string (BLE bytes) or the
   * raw JSON envelope. The hook is responsible for forwarding to a
   * DiagnosticsCollector if one is set up. v2.9.1: rawJson is always
   * forwarded so state-only pushes (no op.command) are captured too —
   * old shape only fired on op.command BLE strings.
   */
  private onPacket: ((deviceId: string, topic: string, payload: { hex?: string; rawJson?: string }) => void) | null =
    null;

  /** Account-derived client ID (UUIDv5(email)) — stable per account, distinct per user. */
  private readonly clientId: string;

  /** Optional 2FA code — set once after a 454, sent in the next login body, then cleared. */
  private verificationCode: string = "";

  /** Fired after a successful login that consumed a verification code, so the adapter can blank the settings field. */
  private onVerificationConsumed: (() => void) | null = null;

  /** Fired on 454 (pending) or 455 (failed) so the adapter can surface the actionable warning + auto-clear the code on failed. */
  private onVerificationFailed: ((reason: "pending" | "failed") => void) | null = null;

  /** Fired when repeated logins are rejected for bad credentials (not 2FA) so the adapter can surface "check email/password". */
  private onAuthFailed: (() => void) | null = null;

  /** Persisted credentials from a previous run; null until setPersistedCredentials() is called. */
  private persisted: PersistedMqttCredentials | null = null;
  /** Hook fired after a successful login so the adapter can persist the new credentials. */
  private onCredentialsRefresh: ((creds: PersistedMqttCredentials) => void) | null = null;
  /** Pre-scheduled timer for proactive token refresh (5 min before expiry). */
  private refreshTimer: ioBroker.Timeout | undefined = undefined;
  /**
   * True between calling mqtt.connect() with persisted creds and the first
   * `connect` event. If `close` fires while this is still true, the cached
   * cert/token are invalid — wipe them so the next attempt does a fresh login.
   */
  private persistedAttemptInFlight = false;
  /**
   * Last time `requestVerificationCode` actually issued a request — guards
   * against Govee marking the account as suspicious from rapid-fire user clicks.
   */
  private lastVerificationRequestMs = 0;

  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param httpsRequestImpl optional DI for tests — default is the real httpsRequest
   * @param mqttConnectImpl optional DI for tests — default is the real mqtt.connect
   */
  constructor(
    email: string,
    password: string,
    log: ioBroker.Logger,
    timers: TimerAdapter,
    httpsRequestImpl: HttpsRequestFn = httpsRequest,
    mqttConnectImpl: MqttConnectFn = mqtt.connect,
  ) {
    super(log, timers);
    this.email = email;
    this.password = password;
    this.httpsRequestImpl = httpsRequestImpl;
    this.mqttConnectImpl = mqttConnectImpl;
    this.clientId = deriveGoveeClientId(email);
  }

  /**
   * Set the optional 2FA verification code. Empty string clears it.
   *
   * @param code Code from the Govee verification email
   */
  setVerificationCode(code: string): void {
    this.verificationCode = (code ?? "").trim();
  }

  /**
   * Hook called when a login successfully consumed a verification code.
   * Adapter wires this to clear the settings field.
   *
   * @param cb Callback
   */
  setOnVerificationConsumed(cb: (() => void) | null): void {
    this.onVerificationConsumed = cb;
  }

  /**
   * Hook called when Govee returned 454 (pending) or 455 (failed). Reason
   * lets the adapter clear the settings field on `failed` and prompt the
   * user to request a code on `pending`.
   *
   * @param cb Callback
   */
  setOnVerificationFailed(cb: ((reason: "pending" | "failed") => void) | null): void {
    this.onVerificationFailed = cb;
  }

  /**
   * Hook called once repeated logins are rejected for bad credentials (not
   * 2FA) — lets the adapter surface a "check email/password" actionable problem.
   *
   * @param cb Callback
   */
  setOnAuthFailed(cb: (() => void) | null): void {
    this.onAuthFailed = cb;
  }

  /** Bearer token from login — available after connect, used for undocumented API */
  get token(): string {
    return this._bearerToken;
  }

  /**
   * Short user-facing reason for "MQTT not connected", or null if the
   * client has never seen an error. Used by the adapter ready-summary
   * to give a concrete message instead of "still pending".
   */
  getFailureReason(): string | null {
    if (this.connected) {
      return null;
    }
    switch (this.lastErrorCategory) {
      case "VERIFICATION_PENDING":
        return "Govee asked for verification — request a code in adapter settings";
      case "VERIFICATION_FAILED":
        return "verification code rejected — request a fresh code";
      case "AUTH":
        return this.authFailCount >= MQTT_MAX_AUTH_FAILURES
          ? "login rejected — check email/password"
          : "login failed (will retry)";
      case "RATE_LIMIT":
        return "rate-limited by Govee — will retry";
      case "NETWORK":
        return "cannot reach Govee servers — will retry";
      case "TIMEOUT":
        return "connection timeout — will retry";
      case "UNKNOWN":
        return "login rejected — see earlier log";
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
  setPersistedCredentials(creds: PersistedMqttCredentials | null): void {
    this.persisted = creds;
  }

  /**
   * Fired after a successful login so the adapter can write the bundle to
   * `encryptedNative`/`native`. Includes the (potentially refreshed) TTL.
   *
   * @param cb Callback
   */
  setOnCredentialsRefresh(cb: ((creds: PersistedMqttCredentials) => void) | null): void {
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
  async connect(
    onStatus: MqttStatusCallback,
    onConnection: MqttConnectionCallback,
    onToken?: MqttTokenCallback,
  ): Promise<void> {
    this.onStatus = onStatus;
    this.onConnection = onConnection;
    if (onToken) {
      this.onToken = onToken;
    }

    try {
      // Step 0: Try the persisted credentials first. If the cached bearer
      // token is still inside its TTL and the stored P12 cert lets us connect,
      // skip the full login flow — that avoids spamming the user's email
      // with a 2FA verification request on every adapter restart.
      if (this.tryPersistedReuse()) {
        return;
      }

      // Step 1: Login
      const codeWasSent = (this.verificationCode ?? "").trim().length > 0;
      const loginResp = await this.login();
      if (!loginResp.client) {
        const apiStatus = loginResp.status ?? 0;
        const apiMsg = loginResp.message ?? "unknown error";
        const statusStr = `(status ${apiStatus || "?"})`;
        // Dump the full response body (capped) so a bug report with
        // debug log shows exactly what Govee returned — useful when
        // they change error semantics or add new status codes.
        this.log.debug(`MQTT login error response body: ${JSON.stringify(loginResp).slice(0, 300)}`);
        // Classify the Govee response to avoid misleading error messages.
        // 454/455 (2FA) MUST come before generic AUTH so the user gets the
        // correct "request a code" hint instead of "check email/password".
        if (apiStatus === 455 || (apiStatus === 454 && codeWasSent)) {
          throw new Error(`Verification code invalid or expired ${statusStr}`);
        }
        if (apiStatus === 454) {
          throw new Error(`Verification required by Govee — request a code via Adapter settings ${statusStr}`);
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
        // Account temporarily locked — NOT a credential error, keep reconnecting
        if (/abnormal|blocked|suspended|disabled/i.test(apiMsg)) {
          throw new Error(`Account temporarily locked by Govee: ${apiMsg} ${statusStr}`);
        }
        // Other account issues, maintenance, etc.
        throw new Error(`Govee login rejected: ${apiMsg} ${statusStr}`);
      }
      // Login OK — if a verification code was used, signal the adapter to
      // clear the settings field AND clear the in-memory copy so a
      // subsequent reconnect-login doesn't replay a now-consumed code (Govee
      // would reject it as `Verification code invalid` and trip the
      // VERIFICATION_FAILED branch unnecessarily).
      if (codeWasSent) {
        this.verificationCode = "";
        this.onVerificationConsumed?.();
      }
      // H11 — login-response validation. Govee sends accountId + topic on a
      // successful login. If either is missing the clientId would be
      // `AP/undefined/<uuid>` and the Govee broker rejects with an unclear
      // disconnect. Validate early with a clear error.
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
      // Notify dependents (e.g. api-client for authenticated library endpoints)
      // so they don't keep a stale token after a long-delay reconnect.
      this.onToken?.(this._bearerToken);

      // Bail if the adapter unloaded while login was in flight — otherwise we'd
      // keep going and open a live TLS socket after onUnload (L12).
      if (this.disposed) {
        return;
      }

      // Step 2: Get IoT credentials
      const iotResp = await this.getIotKey();
      if (!iotResp.data?.endpoint) {
        throw new Error("IoT key response missing endpoint/certificate data");
      }
      const { endpoint, p12, p12Pass } = iotResp.data;

      // Same guard before the socket actually opens — getIotKey is another await
      // during which onUnload can fire (L12).
      if (this.disposed) {
        return;
      }

      // Step 3: Extract key + cert from P12
      const { key, cert, ca } = this.extractCertsFromP12(p12, p12Pass);

      // Persist the fresh credentials so the next adapter restart skips this
      // whole login dance (and avoids the 2FA email storm). TTL comes from
      // Govee — `token_expire_cycle` (snake) or `tokenExpireCycle` (camel),
      // depending on the response variant. 1h fallback if Govee sends nothing.
      const ttlSec = loginResp.client.token_expire_cycle ?? loginResp.client.tokenExpireCycle ?? 3600;
      const expiresAt = Date.now() + ttlSec * 1000;
      this.onCredentialsRefresh?.({
        bearerToken: this._bearerToken,
        iotEndpoint: endpoint,
        p12Cert: p12,
        p12Pass,
        accountId: this.accountId,
        accountTopic: this.accountTopic,
        tokenExpiresAt: expiresAt,
      });
      this.scheduleProactiveRefresh(expiresAt);

      // Step 4: Connect MQTT with mutual TLS
      const clientId = `AP/${this.accountId}/${this.sessionUuid}`;
      this.client = this.mqttConnectImpl(`mqtts://${endpoint}:8883`, {
        clientId,
        key,
        cert,
        ca,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0, // We handle reconnect ourselves
        rejectUnauthorized: true,
      });

      this.attachClientHandlers();
    } catch (err) {
      const category = classifyError(err);
      const msg = `MQTT connection failed: ${errMessage(err)}`;

      // State sync: a connect() throw = not connected, regardless of error type
      this.onConnection?.(false);

      // Govee verification 454: pause reconnect until the user submits a
      // code via Settings (which triggers an adapter restart). Don't
      // increment auth-failure counter — this is not a credential error.
      //
      // Wording: Govee returns 454 the first time a particular client-id
      // tries to log in, regardless of whether the user enabled 2FA on
      // their account. It's a "new client, please verify once" handshake
      // — not "you have 2FA enabled". Earlier wording was scaring users
      // whose accounts are 2FA-free. The actual message says: this is a
      // one-time setup per client.
      //
      // Dedup: only warn on the FIRST occurrence of this category (per
      // adapter lifetime). Subsequent reconnect attempts that hit the
      // same 454 are demoted to debug.
      if (category === "VERIFICATION_PENDING") {
        const isNew = this.lastErrorCategory !== category;
        this.lastErrorCategory = category;
        if (isNew) {
          this.log.warn(`MQTT not connected: Govee asked for verification — request a code in adapter settings`);
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
          this.log.warn(`MQTT not connected: verification code rejected — request a fresh code`);
        } else {
          this.log.debug("MQTT verification code rejected again (Govee returned 455)");
        }
        if (this.onVerificationFailed) {
          this.onVerificationFailed("failed");
        }
        return;
      }

      // Auth backoff — stop reconnecting after repeated auth failures
      if (category === "AUTH") {
        this.authFailCount++;
        if (this.authFailCount >= MQTT_MAX_AUTH_FAILURES) {
          this.log.warn(`MQTT not connected: login rejected — check email/password`);
          this.onAuthFailed?.();
          return;
        }
      } else {
        this.authFailCount = 0;
      }

      // Error dedup — warn on first/new category, debug on repeat
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
  protected reconnectExhausted(): boolean {
    return this.authFailCount >= MQTT_MAX_AUTH_FAILURES;
  }

  /** Re-enter the full connect()/login flow when a backoff timer fires. */
  protected reconnect(): void {
    if (this.onStatus && this.onConnection) {
      void this.connect(this.onStatus, this.onConnection);
    }
  }

  /**
   * Clear the proactive-refresh timer on disconnect — the base disconnect()
   * calls this hook. Otherwise the adapter stop would leave it armed and
   * refreshBearerSilently() would fire login calls against a torn-down adapter.
   */
  protected disposeExtras(): void {
    if (this.refreshTimer) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Parse MQTT status message
   *
   * @param payload Raw MQTT message buffer
   * @param topic   AWS-IoT topic the message arrived on
   */
  private handleMessage(payload: Buffer, topic: string): void {
    const rawText = payload.toString();
    try {
      const raw = JSON.parse(rawText) as Record<string, unknown>;

      // Defensive — blind casts would crash downstream if Govee pushes
      // unexpected types. Validate each field before constructing the update.
      const sku = typeof raw.sku === "string" ? raw.sku : "";
      const device = typeof raw.device === "string" ? raw.device : "";
      const state = raw.state && typeof raw.state === "object" ? (raw.state as MqttStatusUpdate["state"]) : undefined;
      const op = raw.op && typeof raw.op === "object" ? (raw.op as MqttStatusUpdate["op"]) : undefined;

      if (sku || device) {
        this.onStatus?.({ sku, device, state, op });
        if (this.onPacket && device) {
          // v2.9.1 — always forward the raw envelope so state-only pushes
          // (state with no op.command) are visible in diag. Previously the
          // hook only fired on op.command BLE bytes — state changes from
          // the Govee app / physical remote went uncaptured.
          if (Array.isArray(op?.command)) {
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
  setPacketHook(
    cb: ((deviceId: string, topic: string, payload: { hex?: string; rawJson?: string }) => void) | null,
  ): void {
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
  private tryPersistedReuse(): boolean {
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
      this.log.debug(`Persisted P12 cert unusable: ${errMessage(e)} — falling back to fresh login`);
      return false;
    }
    this._bearerToken = creds.bearerToken;
    this.accountId = creds.accountId;
    this.accountTopic = creds.accountTopic;
    this.onToken?.(this._bearerToken);
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
      rejectUnauthorized: true,
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
  private attachClientHandlers(): void {
    if (!this.client) {
      return;
    }
    this.client.on("connect", () => {
      const wasCached = this.persistedAttemptInFlight;
      this.persistedAttemptInFlight = false;
      const broker = this.persisted?.iotEndpoint ?? "?";
      const clientId = `AP/${this.accountId}/${this.sessionUuid}`;
      const authMode = wasCached ? "cached" : "fresh";
      // CONNACK only — do NOT reset the backoff/fail counters or clear the
      // error category yet. A persistent post-CONNACK subscribe failure must
      // let the backoff climb toward its cap instead of a tight ~5-10s relogin
      // loop (M3). Success handling lives in the onSubscribed callback below.
      this.log.debug(`MQTT connected (CONNACK): broker=${broker} clientId=${clientId} authMode=${authMode}`);
      this.subscribeOrForceClose(
        this.accountTopic,
        () => {
          this.reconnectAttempts = 0;
          this.authFailCount = 0;
          if (this.lastErrorCategory) {
            this.log.info(`MQTT connection restored: broker=${broker} clientId=${clientId} authMode=${authMode}`);
            this.lastErrorCategory = null;
          }
          this.log.debug(`MQTT subscribed to account topic: topic=${this.accountTopic} qos=0`);
          this.onConnection?.(true);
        },
        // Subscribe-fail is rare (AWS-IoT policy mismatch, account flagged) but
        // leaves the TCP connection alive — the base forces a close so the
        // close-handler → scheduleReconnect path runs instead of a silent death.
        msg => this.log.warn(`MQTT subscribe failed: ${msg} — forcing reconnect`),
      );
    });
    this.client.on("message", (topic, payload) => {
      this.handleMessage(payload, topic);
    });
    this.client.on("error", err => {
      // H10 — classify error events, otherwise the user only sees debug. The
      // close-event fallback catches a lot, but not spurious network errors
      // that don't lead to a disconnect.
      this.lastErrorCategory = logDedup(this.log, this.lastErrorCategory, "MQTT", err);
    });
    this.client.on("close", () => {
      this.onConnection?.(false);
      // Cached cert/token failed before producing a single successful
      // connect — assume the bundle is stale (cert revoked, token
      // expired before our TTL guess, account topic changed). Wipe it
      // so scheduleReconnect → connect() falls through to a fresh login.
      if (this.persistedAttemptInFlight) {
        this.persistedAttemptInFlight = false;
        this.persisted = null;
        this.log.debug("MQTT: cached credentials rejected — falling back to fresh login");
      }
      if (!this.lastErrorCategory) {
        this.lastErrorCategory = "NETWORK";
        this.log.debug("MQTT disconnected — will reconnect");
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
  private scheduleProactiveRefresh(expiresAt: number): void {
    if (this.refreshTimer) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const refreshAt = expiresAt - 5 * 60 * 1000;
    const delay = refreshAt - Date.now();
    if (delay <= 0) {
      return;
    }
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshBearerSilently();
    }, delay);
  }

  /**
   * Refresh the bearer token without disconnecting MQTT. Called by the
   * proactive-refresh timer. Failures don't disrupt the live session —
   * the next reconnect-cycle (if Govee invalidates the cert) handles
   * recovery via the normal connect() path.
   */
  private async refreshBearerSilently(): Promise<void> {
    if (this.disposed) {
      // Adapter was stopped between timer-schedule and timer-fire — no more
      // logging and no more login call.
      return;
    }
    this.log.debug("Proactive MQTT bearer refresh triggered");
    try {
      const loginResp = await this.login();
      if (!loginResp.client) {
        // Login was rejected (454 / 455 / locked / rate-limited). Keep
        // the current MQTT connection alive. If the bearer is needed
        // for a REST call later, that call's catch path will surface
        // the actual error to the user.
        const status = loginResp.status ?? 0;
        this.log.debug(`Silent bearer refresh declined by Govee (status ${status}) — current session kept`);
        return;
      }
      this._bearerToken = loginResp.client.token;
      this.onToken?.(this._bearerToken);
      // Persist the new bearer + cert so the next restart skips full
      // login. Cert may be the same as before (unchanged P12) — js-controller
      // re-encrypts identical bytes anyway, no harm done.
      const ttlSec = loginResp.client.token_expire_cycle ?? loginResp.client.tokenExpireCycle ?? 3600;
      const newExpiresAt = Date.now() + ttlSec * 1000;
      try {
        const iotResp = await this.getIotKey();
        if (iotResp?.data?.endpoint) {
          this.onCredentialsRefresh?.({
            bearerToken: this._bearerToken,
            iotEndpoint: iotResp.data.endpoint,
            p12Cert: iotResp.data.p12,
            p12Pass: iotResp.data.p12Pass,
            accountId: this.accountId,
            accountTopic: this.accountTopic,
            tokenExpiresAt: newExpiresAt,
          });
        }
      } catch (e) {
        this.log.debug(`Silent IoT-key refresh failed: ${errMessage(e)}`);
      }
      this.scheduleProactiveRefresh(newExpiresAt);
    } catch (e) {
      // Network error / 5xx — not a release-blocker. The live MQTT
      // session continues; the next reconnect-cycle (if needed) will
      // try a full login.
      this.log.debug(`Silent bearer refresh failed: ${errMessage(e)} — current session kept`);
    }
  }

  /** Login to Govee account */
  private async login(): Promise<GoveeLoginResponse> {
    const body: Record<string, string> = {
      email: this.email,
      password: this.password,
      client: this.clientId,
    };
    const code = (this.verificationCode ?? "").trim();
    if (code) {
      body.code = code;
    }
    const result = await this.httpsRequestImpl<GoveeLoginResponse>({
      method: "POST",
      url: LOGIN_URL,
      headers: {
        appVersion: GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: GOVEE_CLIENT_TYPE,
        iotVersion: "0",
        timestamp: String(Date.now()),
        "User-Agent": GOVEE_USER_AGENT,
      },
      body,
    });
    if (!result.value) {
      throw new Error(
        `Govee login returned no body (status=${result.statusCode}${result.fallback ? `, fallback=${result.fallback}` : ""}${result.bodySnippet ? `, body=${JSON.stringify(result.bodySnippet)}` : ""})`,
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
  async requestVerificationCode(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastVerificationRequestMs;
    if (this.lastVerificationRequestMs > 0 && elapsed < VERIFICATION_REQUEST_THROTTLE_MS) {
      const throttleRemainingSec = Math.ceil((VERIFICATION_REQUEST_THROTTLE_MS - elapsed) / 1000);
      throw new Error(`Verification code request throttled — wait ${throttleRemainingSec}s before retrying.`);
    }
    this.lastVerificationRequestMs = now;
    const url = "https://app2.govee.com/account/rest/account/v1/verification";
    await this.httpsRequestImpl<unknown>({
      method: "POST",
      url,
      headers: {
        appVersion: GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: GOVEE_CLIENT_TYPE,
        iotVersion: "0",
        timestamp: String(Date.now()),
        "User-Agent": GOVEE_USER_AGENT,
      },
      body: {
        type: 8,
        email: this.email,
      },
    });
  }

  /** Get IoT key (P12 certificate) */
  private async getIotKey(): Promise<GoveeIotKeyResponse> {
    const result = await this.httpsRequestImpl<GoveeIotKeyResponse>({
      method: "GET",
      url: IOT_KEY_URL,
      headers: {
        Authorization: `Bearer ${this._bearerToken}`,
        appVersion: GOVEE_APP_VERSION,
        clientId: this.clientId,
        clientType: GOVEE_CLIENT_TYPE,
        "User-Agent": GOVEE_USER_AGENT,
      },
    });
    if (!result.value) {
      throw new Error(
        `Govee IoT-key request returned no body (status=${result.statusCode}${result.fallback ? `, fallback=${result.fallback}` : ""})`,
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
  private extractCertsFromP12(p12Base64: string, password: string): { key: string; cert: string; ca: string } {
    const p12Der = forge.util.decode64(p12Base64);
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

    // Extract private key
    const keyBags = p12.getBags({
      bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
    if (!keyBag?.key) {
      throw new Error("No private key found in P12");
    }
    const key = forge.pki.privateKeyToPem(keyBag.key);

    // Extract certificate
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag]?.[0];
    if (!certBag?.cert) {
      throw new Error("No certificate found in P12");
    }
    const cert = forge.pki.certificateToPem(certBag.cert);

    // AWS IoT uses Amazon Root CA
    const ca = AMAZON_ROOT_CA1;

    return { key, cert, ca };
  }
}
