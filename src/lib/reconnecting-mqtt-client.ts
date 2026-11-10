import type { IClientOptions, MqttClient } from "mqtt";
import { counterpartFor, type Counterpart } from "./api-limits";
import { CallGate } from "./call-gate";
import { type LaneMemory } from "./call-window";
import { type TimerAdapter } from "./types";
import { type ErrorCategory } from "./error-category";

/**
 * Signature of the `mqtt.connect` factory — tests inject a fake client without
 * starting the network library.
 */
export type MqttConnectFn = (url: string, opts: IClientOptions) => MqttClient;

/** Upper bound of one broker message — real status/event messages are a few KB. */
export const MQTT_MAX_MESSAGE_BYTES = 64 * 1024;

/** The port both Govee brokers listen on (MQTT over TLS). */
export const BROKER_PORT = 8883;

/**
 * The two counterparts of a broker in api-limits.json (GV-08), as the fleet counts them: every connection opened to it
 * (`tcp`) and every packet written on one (`tcp-write` — CONNECT, SUBSCRIBE, PINGREQ, PUBLISH).
 */
export interface BrokerLimits {
  /** The broker's host. */
  host: string;
  /** Every connection opened to the broker. */
  connection: Counterpart;
  /** Every packet written on a connection. */
  writes: Counterpart;
}

/**
 * The declared counterparts of a broker host.
 *
 * @param host The broker's host
 * @throws {Error} When api-limits.json declares no connection or no write limit for it
 */
export function brokerLimitsOf(host: string): BrokerLimits {
  const connection = counterpartFor("tcp", host, BROKER_PORT);
  const writes = counterpartFor("tcp-write", host, BROKER_PORT);
  if (!connection || !writes) {
    throw new Error(`api-limits.json declares no connection and write limit for ${host}`);
  }
  return { host, connection, writes };
}

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
 * The reconnect backoff of both broker clients: 5 s doubling to at most 120 s, plus up to 30 s jitter. The ceiling keeps
 * the longest wait (150 s) well inside the fleet's 300 s for showing a counterpart's return (inventory suite "counterpart
 * gone and back", round 87) — with 300 s a Govee outage of a few minutes left the push channel down up to 330 s after
 * Govee was back (CI 38647499985, 2026-10-14). Govee is not called more often for it: a connect waits for room in the
 * broker's declared connection and write windows either way.
 */
export const RECONNECT_BACKOFF: BackoffOpts = { base: 5_000, cap: 120_000, jitterCap: 30_000 };

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
  /**
   * The broker's declared windows (GV-08): every connection and every packet counts from the moment it leaves, and a
   * connect, a SUBSCRIBE, a ping and a publish go out only while their window has room.
   */
  private readonly gate: CallGate;
  /** Writes that wait for room in the write window (a SUBSCRIBE, a ping) — dropped with their client. */
  private readonly writeTimers = new Set<ioBroker.Timeout>();
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
  ) {
    this.gate = new CallGate(ms => timers.delay(ms));
  }

  /** The broker's declared counterparts — undefined while its host is not known yet (the account broker's IoT key). */
  protected abstract brokerLimits(): BrokerLimits | undefined;

  /** What the next process of this instance must know of the broker's windows (limit-memory.ts). */
  limitMemory(): LaneMemory {
    return this.gate.memory();
  }

  /**
   * Lay in what the previous process sent within the broker's windows.
   *
   * @param memory What the previous process left
   */
  rememberLimits(memory: LaneMemory): void {
    this.gate.remember(memory);
  }

  /** Whether one more packet fits the broker's write window now. */
  protected writeFits(): boolean {
    const limits = this.brokerLimits();
    return !limits || this.gate.waitMs(limits.writes, limits.host) === 0;
  }

  /** Count a packet that has left on the broker connection (its write window). */
  protected countWrite(): void {
    const limits = this.brokerLimits();
    if (limits) {
      this.gate.count(limits.writes, limits.host);
    }
  }

  /**
   * Let a packet out once the write window has room — at once when it has, otherwise when its oldest write has slid
   * out. Dropped when the client it was meant for is gone.
   *
   * @param client The client the packet belongs to
   * @param write Sends the packet
   */
  private whenWritable(client: MqttClient, write: () => void): void {
    const limits = this.brokerLimits();
    const wait = limits ? this.gate.waitMs(limits.writes, limits.host) : 0;
    if (wait === 0) {
      write();
      return;
    }
    const timer = this.timers.setTimeout(() => {
      if (timer) {
        this.writeTimers.delete(timer);
      }
      if (!this.disposed && this.client === client) {
        this.whenWritable(client, write);
      }
    }, wait);
    if (timer) {
      this.writeTimers.add(timer);
    }
  }

  /** Drop every write still waiting for room. */
  private dropWaitingWrites(): void {
    for (const timer of this.writeTimers) {
      this.timers.clearTimeout(timer);
    }
    this.writeTimers.clear();
  }

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
    const delay = Math.max(computeBackoffDelay(this.reconnectAttempts, RECONNECT_BACKOFF), this.connectWaitMs());
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
   * How long until one more broker connect fits — a connection in the connection window and its CONNECT in the write
   * window; 0 when it fits now (and while the host is not known yet).
   */
  protected connectWaitMs(): number {
    const limits = this.brokerLimits();
    if (!limits) {
      return 0;
    }
    return Math.max(this.gate.waitMs(limits.connection, limits.host), this.gate.waitMs(limits.writes, limits.host));
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
   * Every packet the client writes counts in the broker's write window (`packetsend`; a publish counts where it is sent,
   * see {@link countWrite}), and mqtt.js's keepalive ping waits for room like any other write — mqtt.js sends it on its
   * own clock, not after the last write, so it could otherwise land right behind a publish. The wait stays within the
   * write window (seconds), well inside the half keepalive mqtt.js gives the answer.
   *
   * @param connectFn The mqtt.connect factory
   * @param url Broker URL
   * @param opts Connection options (without `reconnectPeriod`)
   * @returns false when the broker's windows have no room for a connect now (nothing opened)
   */
  protected openBroker(connectFn: MqttConnectFn, url: string, opts: Omit<IClientOptions, "reconnectPeriod">): boolean {
    const limits = this.brokerLimits();
    if (this.connectWaitMs() > 0) {
      return false;
    }
    this.releaseClient();
    if (limits) {
      this.gate.count(limits.connection, limits.host);
    }
    const client = connectFn(url, {
      ...opts,
      ...(this.localAddress ? { localAddress: this.localAddress } : {}),
      reconnectPeriod: 0,
    });
    this.ownListeners = new Map(client.eventNames().map(name => [name, new Set<unknown>(client.listeners(name))]));
    if (limits) {
      client.on("packetsend", packet => {
        if (packet.cmd !== "publish") {
          this.gate.count(limits.writes, limits.host);
        }
      });
      if (typeof client.sendPing === "function") {
        const ping = client.sendPing.bind(client);
        client.sendPing = () => this.whenWritable(client, ping);
      }
    }
    this.client = client;
    return true;
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
    this.dropWaitingWrites();
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
   * Subscribe to `topic` (qos 0) once the write window has room. On subscribe-failure force a close so the
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
    const client = this.client;
    if (!client) {
      return;
    }
    this.whenWritable(client, () =>
      client.subscribe(topic, { qos: 0 }, err => {
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
      }),
    );
  }
}
