import * as crypto from "node:crypto";
import * as forge from "node-forge";
import * as mqtt from "mqtt";
import { httpsRequest } from "./http-client.js";
import {
  GOVEE_APP_VERSION,
  GOVEE_CLIENT_ID,
  GOVEE_CLIENT_TYPE,
  GOVEE_USER_AGENT,
} from "./govee-constants.js";
import {
  classifyError,
  type ErrorCategory,
  type GoveeIotKeyResponse,
  type GoveeLoginResponse,
  type MqttStatusUpdate,
  type TimerAdapter,
} from "./types.js";

/** Max consecutive auth failures before giving up */
const MAX_AUTH_FAILURES = 3;

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
export class GoveeMqttClient {
  private readonly email: string;
  private readonly password: string;
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private client: mqtt.MqttClient | null = null;
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
  private reconnectTimer: ioBroker.Timeout | undefined = undefined;
  private reconnectAttempts = 0;
  private authFailCount = 0;
  private lastErrorCategory: ErrorCategory | null = null;
  private onStatus: MqttStatusCallback | null = null;
  private onConnection: MqttConnectionCallback | null = null;
  private onToken: MqttTokenCallback | null = null;

  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(
    email: string,
    password: string,
    log: ioBroker.Logger,
    timers: TimerAdapter,
  ) {
    this.email = email;
    this.password = password;
    this.log = log;
    this.timers = timers;
  }

  /** Bearer token from login — available after connect, used for undocumented API */
  get token(): string {
    return this._bearerToken;
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
      // Step 1: Login
      const loginResp = await this.login();
      if (!loginResp.client) {
        const apiStatus = loginResp.status ?? 0;
        const apiMsg = loginResp.message ?? "unknown error";
        const statusStr = `(status ${apiStatus || "?"})`;
        // Classify the Govee response to avoid misleading error messages
        if (
          apiStatus === 429 ||
          /too many|rate.?limit|frequent|throttl/i.test(apiMsg)
        ) {
          throw new Error(`Rate limited by Govee: ${apiMsg} ${statusStr}`);
        }
        if (
          apiStatus === 401 ||
          /password|credential|unauthorized/i.test(apiMsg)
        ) {
          throw new Error(`Login failed: ${apiMsg} ${statusStr}`);
        }
        // Account temporarily locked — NOT a credential error, keep reconnecting
        if (/abnormal|blocked|suspended|disabled/i.test(apiMsg)) {
          throw new Error(
            `Account temporarily locked by Govee: ${apiMsg} ${statusStr}`,
          );
        }
        // Other account issues, maintenance, etc.
        throw new Error(`Govee login rejected: ${apiMsg} ${statusStr}`);
      }
      this._bearerToken = loginResp.client.token;
      this.accountId = String(loginResp.client.accountId);
      this.accountTopic = loginResp.client.topic;
      // Notify dependents (e.g. api-client for authenticated library endpoints)
      // so they don't keep a stale token after a long-delay reconnect.
      this.onToken?.(this._bearerToken);

      // Step 2: Get IoT credentials
      const iotResp = await this.getIotKey();
      if (!iotResp.data?.endpoint) {
        throw new Error("IoT key response missing endpoint/certificate data");
      }
      const { endpoint, p12, p12Pass } = iotResp.data;

      // Step 3: Extract key + cert from P12
      const { key, cert, ca } = this.extractCertsFromP12(p12, p12Pass);

      // Step 4: Connect MQTT with mutual TLS
      const clientId = `AP/${this.accountId}/${this.sessionUuid}`;
      this.client = mqtt.connect(`mqtts://${endpoint}:8883`, {
        clientId,
        key,
        cert,
        ca,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0, // We handle reconnect ourselves
        rejectUnauthorized: true,
      });

      this.client.on("connect", () => {
        this.reconnectAttempts = 0;
        this.authFailCount = 0;
        if (this.lastErrorCategory) {
          this.log.info("MQTT connection restored");
          this.lastErrorCategory = null;
        } else {
          this.log.info("MQTT connected to AWS IoT");
        }

        // Subscribe to account topic for status updates
        this.client?.subscribe(this.accountTopic, { qos: 0 }, (err) => {
          if (err) {
            this.log.warn(`MQTT subscribe failed: ${err.message}`);
          } else {
            this.log.debug(`MQTT subscribed to account topic`);
            this.onConnection?.(true);
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
        this.onConnection?.(false);
        // Only warn on first disconnect, debug on repeated
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("MQTT disconnected — will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = classifyError(err);
      const msg = `MQTT connection failed: ${err instanceof Error ? err.message : String(err)}`;

      // State-Sync: connect() throw = not connected, unabhängig von Fehlertyp
      this.onConnection?.(false);

      // Auth backoff — stop reconnecting after repeated auth failures
      if (category === "AUTH") {
        this.authFailCount++;
        if (this.authFailCount >= MAX_AUTH_FAILURES) {
          this.log.warn(
            `MQTT login failed ${this.authFailCount} times — check email/password in adapter settings`,
          );
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

  /** Whether MQTT is currently connected */
  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Disconnect and cleanup */
  disconnect(): void {
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on("error", () => {
        /* ignore late errors */
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
  private handleMessage(payload: Buffer): void {
    try {
      const raw = JSON.parse(payload.toString()) as Record<string, unknown>;

      // Defensive — blind casts would crash downstream if Govee pushes
      // unexpected types. Validate each field before constructing the update.
      const sku = typeof raw.sku === "string" ? raw.sku : "";
      const device = typeof raw.device === "string" ? raw.device : "";
      const state =
        raw.state && typeof raw.state === "object"
          ? (raw.state as MqttStatusUpdate["state"])
          : undefined;
      const op =
        raw.op && typeof raw.op === "object"
          ? (raw.op as MqttStatusUpdate["op"])
          : undefined;

      if (sku || device) {
        this.onStatus?.({ sku, device, state, op });
      }
    } catch {
      this.log.debug(
        `MQTT: Failed to parse message: ${payload.toString().slice(0, 200)}`,
      );
    }
  }

  /** Schedule reconnect with exponential backoff */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    if (this.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      5_000 * Math.pow(2, this.reconnectAttempts - 1),
      300_000,
    );
    this.log.debug(
      `MQTT: Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.onStatus && this.onConnection) {
        void this.connect(this.onStatus, this.onConnection);
      }
    }, delay);
  }

  /** Login to Govee account */
  private login(): Promise<GoveeLoginResponse> {
    return httpsRequest<GoveeLoginResponse>({
      method: "POST",
      url: LOGIN_URL,
      headers: {
        appVersion: GOVEE_APP_VERSION,
        clientId: GOVEE_CLIENT_ID,
        clientType: GOVEE_CLIENT_TYPE,
        "User-Agent": GOVEE_USER_AGENT,
        timezone: "Europe/Berlin",
        country: "DE",
        envid: "0",
        iotversion: "0",
      },
      body: {
        email: this.email,
        password: this.password,
        client: GOVEE_CLIENT_ID,
      },
    });
  }

  /** Get IoT key (P12 certificate) */
  private getIotKey(): Promise<GoveeIotKeyResponse> {
    return httpsRequest<GoveeIotKeyResponse>({
      method: "GET",
      url: IOT_KEY_URL,
      headers: {
        Authorization: `Bearer ${this._bearerToken}`,
        appVersion: GOVEE_APP_VERSION,
        clientId: GOVEE_CLIENT_ID,
        clientType: GOVEE_CLIENT_TYPE,
        "User-Agent": GOVEE_USER_AGENT,
      },
    });
  }

  /**
   * Extract PEM key + cert from PKCS12
   *
   * @param p12Base64 Base64-encoded PKCS12 data
   * @param password PKCS12 password
   */
  private extractCertsFromP12(
    p12Base64: string,
    password: string,
  ): { key: string; cert: string; ca: string } {
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
