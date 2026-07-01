import * as crypto from "node:crypto";
import * as mqtt from "mqtt";
import { OPENAPI_MQTT_MAX_AUTH_FAILURES } from "./timing-constants";
import { ReconnectingMqttClient } from "./reconnecting-mqtt-client";
import {
  classifyError,
  type OpenApiMqttEvent,
  type CloudStateCapability,
  type TimerAdapter,
  errMessage,
  maskSecret,
} from "./types";

const BROKER_URL = "mqtts://mqtt.openapi.govee.com:8883";

/** Callback for incoming sensor events */
export type OpenApiEventCallback = (event: OpenApiMqttEvent) => void;

/** Callback for raw MQTT messages (for diagnostics) */
export type OpenApiRawCallback = (rawJson: string) => void;

/** Callback for connection state changes */
export type OpenApiConnectionCallback = (connected: boolean) => void;

/**
 * Govee Cloud-events client for real-time sensor events.
 * Connects to mqtt.openapi.govee.com:8883 using the API key for auth.
 * Receives event capabilities (lackWater, iceFull, bodyAppeared etc.)
 * without consuming Cloud API budget.
 *
 * Reconnect/lifecycle scaffolding (backoff timer, disposed guard,
 * subscribe-fail-forces-close) is inherited from {@link ReconnectingMqttClient}.
 */
export class GoveeOpenapiMqttClient extends ReconnectingMqttClient {
  private readonly apiKey: string;
  /**
   * Stable client ID for the lifetime of the adapter instance. Generated once
   * in the constructor so reconnects keep the same identity — Govee's broker
   * can then take over the previous socket cleanly instead of rejecting the
   * new connection as a duplicate. Reusing Date.now() per connect() created a
   * fresh ID on every reconnect.
   */
  private readonly sessionUuid: string = crypto.randomUUID();
  private topic: string;
  /** Masked form of {@link topic} for logging — never exposes the raw API key (H1). */
  private readonly topicLabel: string;
  /** Consecutive connect/auth failures — caps reconnect via reconnectExhausted(). */
  private connectFailCount = 0;
  private onEvent: OpenApiEventCallback | null = null;
  private onRaw: OpenApiRawCallback | null = null;
  private onConnection: OpenApiConnectionCallback | null = null;

  /** Channel label used in reconnect log lines. */
  protected readonly channelLabel = "Cloud-events";

  /**
   * @param apiKey Govee Cloud API key (used as username AND password)
   * @param log ioBroker logger
   * @param timers Timer adapter
   */
  constructor(apiKey: string, log: ioBroker.Logger, timers: TimerAdapter) {
    super(log, timers);
    this.apiKey = apiKey;
    this.topic = `GA/${apiKey}`;
    this.topicLabel = `GA/${maskSecret(apiKey)}`;
  }

  /** Stop reconnecting once the API key has been rejected too many times. */
  protected reconnectExhausted(): boolean {
    return this.connectFailCount >= OPENAPI_MQTT_MAX_AUTH_FAILURES;
  }

  /** Re-enter connect() with the stored callbacks when a backoff timer fires. */
  protected reconnect(): void {
    if (this.onEvent && this.onConnection) {
      this.connect(this.onEvent, this.onConnection, this.onRaw ?? undefined);
    }
  }

  /**
   * Connect to the Cloud-events broker.
   *
   * @param onEvent Called on incoming sensor events
   * @param onConnection Called on connection state changes
   * @param onRaw Called with raw JSON for diagnostics
   */
  connect(onEvent: OpenApiEventCallback, onConnection: OpenApiConnectionCallback, onRaw?: OpenApiRawCallback): void {
    this.onEvent = onEvent;
    this.onConnection = onConnection;
    this.onRaw = onRaw ?? null;

    try {
      this.client = mqtt.connect(BROKER_URL, {
        username: this.apiKey,
        password: this.apiKey,
        clientId: `iob_govee_smart_${this.sessionUuid}`,
        protocolVersion: 4,
        keepalive: 60,
        reconnectPeriod: 0,
        rejectUnauthorized: true,
      });

      const clientId = `iob_govee_smart_${this.sessionUuid}`;
      this.log.debug(`Cloud-events connecting: broker=${BROKER_URL} clientId=${clientId} authMode=apiKey`);
      this.client.on("connect", () => {
        this.reconnectAttempts = 0;
        this.connectFailCount = 0;
        if (this.lastErrorCategory) {
          this.log.info(
            `Cloud-events connection restored: broker=${BROKER_URL} clientId=${clientId} topic=${this.topicLabel}`,
          );
          this.lastErrorCategory = null;
        } else {
          this.log.debug(`Cloud-events connected: broker=${BROKER_URL} clientId=${clientId} topic=${this.topicLabel}`);
        }

        this.subscribeOrForceClose(
          this.topic,
          () => {
            this.log.debug(`Cloud-events subscribed to event topic: topic=${this.topicLabel} qos=0`);
            this.onConnection?.(true);
          },
          msg =>
            this.log.warn(`Cloud-events subscribe failed: topic=${this.topicLabel} err="${msg}" — forcing reconnect`),
        );
      });

      this.client.on("message", (_topic, payload) => {
        this.handleMessage(payload);
      });

      this.client.on("error", err => {
        const category = classifyError(err);
        if (category === "AUTH") {
          this.connectFailCount++;
          if (this.connectFailCount >= OPENAPI_MQTT_MAX_AUTH_FAILURES) {
            this.log.warn(`Cloud-events auth failed repeatedly — check API key`);
            this.onConnection?.(false);
            this.disconnect();
            return;
          }
        }
        this.log.debug(`Cloud-events error: ${err.message}`);
        // Some error types (TLS handshake fail, unsolicited disconnect) keep
        // the client object alive without firing `close`. Force a close so
        // the close-handler scheduleReconnect runs — without this the
        // connection silently sits in a dead state.
        if (category === "NETWORK" || category === "TIMEOUT") {
          try {
            this.client?.end(true);
          } catch {
            // ignore — the handler runs once a close eventually fires
          }
        }
      });

      this.client.on("close", () => {
        this.onConnection?.(false);
        if (!this.lastErrorCategory) {
          this.lastErrorCategory = "NETWORK";
          this.log.debug("Cloud-events disconnected — will reconnect");
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      const category = classifyError(err);
      const msg = `Cloud-events connection failed: ${errMessage(err)}`;

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
  private handleMessage(payload: Buffer): void {
    try {
      const rawStr = payload.toString();

      // Always forward raw JSON for diagnostics
      this.onRaw?.(rawStr);

      const raw = JSON.parse(rawStr) as Record<string, unknown>;

      // typeof guards (like the account MQTT client) — Govee occasionally sends
      // sku/device as a number; without the guard a later .replace()/.split()
      // on the consumer side would crash.
      const sku = typeof raw.sku === "string" ? raw.sku : "";
      const device = typeof raw.device === "string" ? raw.device : "";

      if (!sku && !device) {
        this.log.debug(`Cloud-events: message without device info: ${payload.toString().slice(0, 200)}`);
        return;
      }

      // Extract capabilities array. Element-level type-checks happen here
      // (downstream `applyOnlineCap` reads `c.type`/`c.state.value` and
      // would otherwise faceplant on malformed entries that slipped through
      // the array check).
      const rawCaps = raw.capabilities;
      if (!Array.isArray(rawCaps) || rawCaps.length === 0) {
        this.log.debug(`Cloud-events: message without capabilities from ${sku}: ${payload.toString().slice(0, 300)}`);
        return;
      }
      const caps: CloudStateCapability[] = rawCaps.filter(
        (c: unknown): c is CloudStateCapability =>
          c !== null &&
          typeof c === "object" &&
          typeof (c as { type?: unknown }).type === "string" &&
          typeof (c as { instance?: unknown }).instance === "string",
      );
      if (caps.length === 0) {
        this.log.debug(`Cloud-events: capabilities all malformed from ${sku}`);
        return;
      }

      const event: OpenApiMqttEvent = { sku, device, capabilities: caps };
      this.onEvent?.(event);
    } catch {
      this.log.debug(`Cloud-events: failed to parse message: ${payload.toString().slice(0, 200)}`);
    }
  }
}
