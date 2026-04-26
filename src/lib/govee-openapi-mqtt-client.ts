import * as mqtt from "mqtt";
import {
  classifyError,
  type ErrorCategory,
  type OpenApiMqttEvent,
  type CloudStateCapability,
  type TimerAdapter,
} from "./types.js";

/** Max consecutive connection failures before giving up */
const MAX_CONNECT_FAILURES = 5;

const BROKER_URL = "mqtts://mqtt.openapi.govee.com:8883";

/** Callback for incoming sensor events */
export type OpenApiEventCallback = (event: OpenApiMqttEvent) => void;

/** Callback for raw MQTT messages (for diagnostics) */
export type OpenApiRawCallback = (rawJson: string) => void;

/** Callback for connection state changes */
export type OpenApiConnectionCallback = (connected: boolean) => void;

/**
 * Govee OpenAPI MQTT client for real-time sensor events.
 * Connects to mqtt.openapi.govee.com:8883 using the API key for auth.
 * Receives event capabilities (lackWater, iceFull, bodyAppeared etc.)
 * without consuming Cloud API budget.
 */
export class GoveeOpenapiMqttClient {
  private readonly apiKey: string;
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private client: mqtt.MqttClient | null = null;
  private topic: string;
  private reconnectTimer: ioBroker.Timeout | undefined = undefined;
  private reconnectAttempts = 0;
  private connectFailCount = 0;
  private lastErrorCategory: ErrorCategory | null = null;
  private onEvent: OpenApiEventCallback | null = null;
  private onRaw: OpenApiRawCallback | null = null;
  private onConnection: OpenApiConnectionCallback | null = null;

  /**
   * @param apiKey Govee Cloud API key (used as username AND password)
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(apiKey: string, log: ioBroker.Logger, timers: TimerAdapter) {
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
  connect(
    onEvent: OpenApiEventCallback,
    onConnection: OpenApiConnectionCallback,
    onRaw?: OpenApiRawCallback,
  ): void {
    this.onEvent = onEvent;
    this.onConnection = onConnection;
    this.onRaw = onRaw ?? null;

    try {
      this.client = mqtt.connect(BROKER_URL, {
        username: this.apiKey,
        password: this.apiKey,
        clientId: `iob_govee_smart_${Date.now().toString(36)}`,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0,
        rejectUnauthorized: true,
      });

      this.client.on("connect", () => {
        this.reconnectAttempts = 0;
        this.connectFailCount = 0;
        if (this.lastErrorCategory) {
          // Only log on transition out of an error state — the routine
          // first-connect message is redundant with the adapter-level
          // "Govee adapter ready — N devices, M groups (channels: …)"
          // line and was just noise.
          this.log.info("OpenAPI MQTT connection restored");
          this.lastErrorCategory = null;
        }

        this.client?.subscribe(this.topic, { qos: 0 }, (err) => {
          if (err) {
            this.log.warn(`OpenAPI MQTT subscribe failed: ${err.message}`);
          } else {
            this.log.debug("OpenAPI MQTT subscribed to event topic");
            this.onConnection?.(true);
          }
        });
      });

      this.client.on("message", (_topic, payload) => {
        this.handleMessage(payload);
      });

      this.client.on("error", (err) => {
        const category = classifyError(err);
        if (category === "AUTH") {
          this.connectFailCount++;
          if (this.connectFailCount >= MAX_CONNECT_FAILURES) {
            this.log.warn(
              "OpenAPI MQTT auth failed repeatedly — check API key",
            );
            this.onConnection?.(false);
            this.disconnect();
            return;
          }
        }
        this.log.debug(`OpenAPI MQTT error: ${err.message}`);
      });

      this.client.on("close", () => {
        this.onConnection?.(false);
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("OpenAPI MQTT disconnected — will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = classifyError(err);
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
   * Parse incoming MQTT event message.
   * Expected format: { sku, device, capabilities: [{ type, instance, state: { value } }] }
   *
   * @param payload Raw MQTT message buffer
   */
  private handleMessage(payload: Buffer): void {
    try {
      const rawStr = payload.toString();

      // Always forward raw JSON for diagnostics
      this.onRaw?.(rawStr);

      const raw = JSON.parse(rawStr) as Record<string, unknown>;

      const sku = (raw.sku as string) ?? "";
      const device = (raw.device as string) ?? "";

      if (!sku && !device) {
        this.log.debug(
          `OpenAPI MQTT: message without device info: ${payload.toString().slice(0, 200)}`,
        );
        return;
      }

      // Extract capabilities array
      const caps = raw.capabilities as CloudStateCapability[] | undefined;
      if (!caps || !Array.isArray(caps) || caps.length === 0) {
        this.log.debug(
          `OpenAPI MQTT: message without capabilities from ${sku}: ${payload.toString().slice(0, 300)}`,
        );
        return;
      }

      const event: OpenApiMqttEvent = { sku, device, capabilities: caps };
      this.onEvent?.(event);
    } catch {
      this.log.debug(
        `OpenAPI MQTT: failed to parse message: ${payload.toString().slice(0, 200)}`,
      );
    }
  }

  /** Schedule reconnect with exponential backoff */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    if (this.connectFailCount >= MAX_CONNECT_FAILURES) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      5_000 * Math.pow(2, this.reconnectAttempts - 1),
      300_000,
    );
    this.log.debug(
      `OpenAPI MQTT: reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.onEvent && this.onConnection) {
        this.connect(this.onEvent, this.onConnection, this.onRaw ?? undefined);
      }
    }, delay);
  }
}
