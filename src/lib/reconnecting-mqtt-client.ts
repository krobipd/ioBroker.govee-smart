import type { IClientOptions, MqttClient } from "mqtt";
import { type TimerAdapter } from "./types";
import { type ErrorCategory } from "./error-category";

/**
 * Signature of the `mqtt.connect` factory — tests inject a fake client without
 * starting the network library.
 */
export type MqttConnectFn = (url: string, opts: IClientOptions) => MqttClient;

/** Upper bound of one broker message — real status/event messages are a few KB. */
export const MQTT_MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * At most this many broker connects in any {@link CONNECT_WINDOW_MS} (GV-08, api-limits.json): a connect costs about 20
 * protocol writes (TCP connect, TLS handshake records, CONNECT, SUBSCRIBE — measured on the inventory's network hook,
 * 2026-10-14), and the backoff starts again at 5 s after every successful connect, so a broker that accepts and drops
 * again would otherwise be dialled four times a minute.
 */
export const MAX_CONNECTS_PER_WINDOW = 2;
/** The window of {@link MAX_CONNECTS_PER_WINDOW}. */
export const CONNECT_WINDOW_MS = 60_000;

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
   * The address every broker connection leaves from — the chosen network address (`native.bind`, fleet master
   * network-address.ts); undefined = any address.
   */
  localAddress: string | undefined = undefined;
  /** When each broker connect of the last {@link CONNECT_WINDOW_MS} started. */
  private readonly connectTimes: number[] = [];
  /** How many broker connects this client starts in any {@link CONNECT_WINDOW_MS} — its share of api-limits.json. */
  protected readonly maxConnectsPerWindow: number = MAX_CONNECTS_PER_WINDOW;
  /**
   * The listeners mqtt.js put on the current client itself, before any of ours — releaseClient leaves them: its own
   * `close` handler clears the CONNACK timer, and without it a client ended while it still waited for CONNACK kept that
   * timer (connectTimeout, 30 s) running past onUnload (inventory CI 2026-10-14, resource probe).
   */
  private ownListeners = new Map<string | symbol, Set<unknown>>();

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
    const delay = Math.max(
      computeBackoffDelay(this.reconnectAttempts, { base: 5_000, cap: 300_000, jitterCap: 30_000 }),
      this.connectWaitMs(),
    );
    this.log.debug(`${this.channelLabel}: reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.reconnect();
    }, delay);
  }

  /**
   * How long until one more broker connect fits {@link maxConnectsPerWindow} — 0 when it fits now.
   *
   * @param now Current time (ms)
   */
  protected connectWaitMs(now: number = Date.now()): number {
    const recent = this.connectTimes.filter(t => now - t < CONNECT_WINDOW_MS);
    this.connectTimes.splice(0, this.connectTimes.length, ...recent);
    return recent.length < this.maxConnectsPerWindow
      ? 0
      : recent[recent.length - this.maxConnectsPerWindow] + CONNECT_WINDOW_MS - now + 1;
  }

  /** Disconnect and clean up: stop reconnect, run subclass teardown, end the client. */
  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.disposeExtras();
    this.releaseClient();
  }

  /**
   * Open a broker connection in place of the current one. The ONE way a client
   * is created: the previous socket is ended first, and mqtt.js never
   * reconnects on its own (`reconnectPeriod: 0`) — the backoff above does, and
   * two reconnect loops side by side would each log in.
   *
   * @param connectFn The mqtt.connect factory
   * @param url Broker URL
   * @param opts Connection options (without `reconnectPeriod`)
   */
  protected openBroker(connectFn: MqttConnectFn, url: string, opts: Omit<IClientOptions, "reconnectPeriod">): void {
    this.releaseClient();
    this.connectTimes.push(Date.now());
    const client = connectFn(url, {
      ...opts,
      ...(this.localAddress ? { localAddress: this.localAddress } : {}),
      reconnectPeriod: 0,
    });
    this.ownListeners = new Map(client.eventNames().map(name => [name, new Set<unknown>(client.listeners(name))]));
    this.client = client;
  }

  /**
   * End the current client, if any, before a new one takes its place. Both
   * connect paths assign `this.client` anew; without this the previous socket
   * stayed open (its handlers attached) whenever a reconnect replaced a client
   * that had not closed — e.g. after a throw between creating and wiring it.
   * Only our own handlers come off: mqtt.js's own (taken in openBroker) still
   * clear its timers when the ended socket closes.
   */
  protected releaseClient(): void {
    if (this.client) {
      for (const name of this.client.eventNames()) {
        const own = this.ownListeners.get(name);
        for (const listener of this.client.listeners(name)) {
          if (!own?.has(listener)) {
            this.client.removeListener(name, listener);
          }
        }
      }
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
