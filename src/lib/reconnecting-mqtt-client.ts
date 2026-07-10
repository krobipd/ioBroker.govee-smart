import type { MqttClient } from "mqtt";
import { type ErrorCategory, type TimerAdapter } from "./types";

/** Exponential-backoff parameters (all milliseconds). */
export interface BackoffOpts {
  /** Base delay for attempt 1, doubled each subsequent attempt. */
  base: number;
  /** Hard ceiling for the doubled base before jitter is added. */
  cap: number;
  /** Maximum jitter added on top of the (capped) base. */
  jitterCap: number;
}

/**
 * Pure exponential-backoff-with-jitter delay (ms) for a 1-based reconnect
 * attempt. Extracted from the two MQTT clients (identical curve) so it is
 * unit-testable without timers or a live socket. `rand` defaults to
 * `Math.random()` and is injectable for deterministic tests.
 *
 * @param attempt 1-based reconnect attempt counter
 * @param opts Backoff parameters
 * @param rand Random value in [0, 1) — injectable for tests
 */
export function computeBackoffDelay(attempt: number, opts: BackoffOpts, rand: number = Math.random()): number {
  const base = Math.min(opts.base * Math.pow(2, attempt - 1), opts.cap);
  const jitter = rand * Math.min(base, opts.jitterCap);
  return Math.round(base + jitter);
}

/**
 * Shared reconnect/lifecycle scaffolding for the two Govee MQTT clients (the
 * account AWS-IoT push channel and the OpenAPI cloud-events channel). Holds the
 * live client handle, the backoff-driven reconnect timer and the disposed
 * guard. The auth flow itself (P12 login + 2FA vs. apiKey) stays in the
 * subclass, re-entered via the abstract {@link reconnect} hook.
 */
export abstract class ReconnectingMqttClient {
  /** Live mqtt client, or null while disconnected. */
  protected client: MqttClient | null = null;
  /** Armed backoff timer between a failed attempt and the next reconnect. */
  protected reconnectTimer: ioBroker.Timeout | undefined = undefined;
  /** Consecutive reconnect attempts; reset to 0 by the subclass on a successful connect. */
  protected reconnectAttempts = 0;
  /** Last classified error category, for warn-once / debug-on-repeat dedup. */
  protected lastErrorCategory: ErrorCategory | null = null;
  /**
   * Raw message of the last connect failure — kept alongside the category so
   * probes can distinguish sub-cases (e.g. "email not registered" within AUTH).
   */
  protected lastErrorMessage: string | null = null;
  /** Set in disconnect(); reconnect paths bail on it so timers that fire after stop are no-ops. */
  protected disposed = false;

  /**
   * @param log ioBroker logger
   * @param timers Timer adapter (managed setTimeout/clearTimeout)
   */
  protected constructor(
    protected readonly log: ioBroker.Logger,
    protected readonly timers: TimerAdapter,
  ) {}

  /** Whether the underlying client is currently connected. */
  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Short channel label used in reconnect log lines ("MQTT" / "Cloud-events"). */
  protected abstract readonly channelLabel: string;

  /** True once the subclass has hit its terminal failure cap — reconnect then stops. */
  protected abstract reconnectExhausted(): boolean;

  /** Re-establish the connection via the subclass-specific auth flow. */
  protected abstract reconnect(): void;

  /** Hook for subclass-specific timer teardown (e.g. proactive-refresh timer). No-op by default. */
  protected disposeExtras(): void {}

  /**
   * Schedule the next reconnect with exponential backoff + jitter. No-op if
   * disposed, already armed, or the subclass's failure cap is reached. M6:
   * jitter guards against a thundering herd — during a distributed Govee outage
   * thousands of adapters would otherwise sync to the exact second.
   */
  protected scheduleReconnect(): void {
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
    const delay = computeBackoffDelay(this.reconnectAttempts, { base: 5_000, cap: 300_000, jitterCap: 30_000 });
    this.log.debug(`${this.channelLabel}: reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.reconnect();
    }, delay);
  }

  /** Disconnect and clean up: stop reconnect, run subclass teardown, end the client. */
  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.disposeExtras();
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
   * Subscribe to `topic` (qos 0). On subscribe-failure force a close so the
   * close-handler's scheduleReconnect runs: a failed subscribe leaves the TCP
   * socket alive (keepalive pings keep answering), so `close` would never fire
   * on its own — a permanent silent death without the forced close.
   *
   * @param topic Topic to subscribe to
   * @param onSubscribed Called once the subscribe succeeds
   * @param onSubscribeFail Called with the error message just before the forced close
   */
  protected subscribeOrForceClose(
    topic: string,
    onSubscribed: () => void,
    onSubscribeFail: (errMsg: string) => void,
  ): void {
    this.client?.subscribe(topic, { qos: 0 }, err => {
      if (err) {
        onSubscribeFail(err.message);
        try {
          this.client?.end(true);
        } catch {
          // ignore — the close-event handler will pick it up either way
        }
      } else {
        onSubscribed();
      }
    });
  }
}
