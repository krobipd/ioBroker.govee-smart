import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as mqtt from "mqtt";
import type { Counterpart } from "./api-limits";
import {
  RECONNECT_BACKOFF,
  ReconnectingMqttClient,
  brokerLimitsOf,
  computeBackoffDelay,
  type BrokerLimits,
} from "./reconnecting-mqtt-client";
import { type TimerAdapter } from "./types";
import { mockLog } from "../../test/test-helpers";

/** Timer adapter that captures scheduled callbacks so a test can fire them on demand. */
function makeCapturingTimers(): {
  timers: TimerAdapter;
  scheduled: Array<{ cb: () => void; ms: number; id: number }>;
  cleared: number[];
  fireLast: () => void;
} {
  const scheduled: Array<{ cb: () => void; ms: number; id: number }> = [];
  const cleared: number[] = [];
  let nextId = 1;
  const timers = {
    setInterval: () => undefined,
    clearInterval: () => {},
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ cb, ms, id });
      return id as unknown as ioBroker.Timeout;
    },
    clearTimeout: (h: unknown) => {
      cleared.push(h as number);
    },
    delay: () => Promise.resolve(),
  } as unknown as TimerAdapter;
  return {
    timers,
    scheduled,
    cleared,
    fireLast: () => scheduled[scheduled.length - 1].cb(),
  };
}

/** Minimal concrete subclass to exercise the base scaffolding directly. */
class TestClient extends ReconnectingMqttClient {
  public reconnectCalls = 0;
  public exhausted = false;
  /** The broker's counterparts — none: the connect, the writes and the pings go out unwindowed. */
  public limits: BrokerLimits | undefined = undefined;
  protected readonly channelLabel = "Test";

  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
    super(log, timers);
  }

  protected brokerLimits(): BrokerLimits | undefined {
    return this.limits;
  }

  protected reconnectExhausted(): boolean {
    return this.exhausted;
  }

  protected reconnect(): void {
    this.reconnectCalls++;
  }

  // --- test seams onto protected members ---
  public arm(): void {
    this.scheduleReconnect();
  }
  public setClient(c: unknown): void {
    this.client = c as never;
  }
  public subscribe(topic: string, onOk: () => void, onFail: (m: string) => void): void {
    this.subscribeOrForceClose(topic, onOk, onFail);
  }
  public open(connectFn: (url: string, opts: Record<string, unknown>) => unknown): boolean {
    return this.openBroker(connectFn as never, "mqtts://broker.example:8883", { keepalive: 60 });
  }
  /** A publish the way the account client sends one: only while the write window has room, counted where it is sent. */
  public publish(): boolean {
    if (!this.client || !this.connected || !this.writeFits()) {
      return false;
    }
    this.client.publish("GD/topic", "{}", { qos: 0 });
    this.countWrite();
    return true;
  }
  public get waitForConnect(): number {
    return this.connectWaitMs();
  }
  public openAt(connectFn: (url: string, opts: Record<string, unknown>) => unknown, url: string): void {
    this.openBroker(connectFn as never, url, { keepalive: 60, connectTimeout: 30_000 });
  }
  public get hasArmedTimer(): boolean {
    return this.reconnectTimer !== undefined;
  }
  public get attempts(): number {
    return this.reconnectAttempts;
  }
}

describe("RECONNECT_BACKOFF — the broker clients' backoff", () => {
  it("never waits longer than 150 s, well inside the fleet's 300 s for showing a counterpart's return", () => {
    const longest = Math.max(...Array.from({ length: 40 }, (_, i) => computeBackoffDelay(i + 1, RECONNECT_BACKOFF, 1)));
    expect(longest).toBe(150_000);
    expect(longest).toBeLessThan(300_000);
  });

  it("is what a client arms after a long run of failed attempts", () => {
    const t = makeCapturingTimers();
    const c = new TestClient(mockLog, t.timers);
    for (let i = 0; i < 12; i++) {
      c.arm();
      t.fireLast();
    }
    c.arm();
    expect(t.scheduled.at(-1)!.ms).toBeLessThanOrEqual(150_000);
    expect(t.scheduled.at(-1)!.ms).toBeGreaterThanOrEqual(120_000);
  });
});

describe("computeBackoffDelay", () => {
  const OPTS = { base: 5_000, cap: 300_000, jitterCap: 30_000 };

  it("doubles the base per attempt with rand=0 (no jitter)", () => {
    expect(computeBackoffDelay(1, OPTS, 0)).toBe(5_000);
    expect(computeBackoffDelay(2, OPTS, 0)).toBe(10_000);
    expect(computeBackoffDelay(3, OPTS, 0)).toBe(20_000);
  });

  it("caps the base at 300s for high attempt counts (rand=0)", () => {
    // attempt 7 → 5000*2^6 = 320000, capped to 300000
    expect(computeBackoffDelay(7, OPTS, 0)).toBe(300_000);
    expect(computeBackoffDelay(20, OPTS, 0)).toBe(300_000);
  });

  it("adds at most `base` jitter while base < jitterCap (rand=1)", () => {
    // attempt 1: base 5000, jitter = min(5000, 30000) = 5000 → 10000
    expect(computeBackoffDelay(1, OPTS, 1)).toBe(10_000);
  });

  it("caps jitter at jitterCap once base ≥ jitterCap (rand=1)", () => {
    // attempt 4: base 40000, jitter = min(40000, 30000) = 30000 → 70000
    expect(computeBackoffDelay(4, OPTS, 1)).toBe(70_000);
    // high attempt: base capped 300000, jitter capped 30000 → 330000
    expect(computeBackoffDelay(20, OPTS, 1)).toBe(330_000);
  });

  it("keeps every delay within [base, base+min(base,jitterCap)] for random rand", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const base = Math.min(OPTS.base * 2 ** (attempt - 1), OPTS.cap);
      const max = base + Math.min(base, OPTS.jitterCap);
      const d = computeBackoffDelay(attempt, OPTS);
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThanOrEqual(max);
    }
  });
});

describe("ReconnectingMqttClient base scaffolding", () => {
  describe("the broker's windows — every connection and every packet counts, nothing goes over (GV-08)", () => {
    /**
     * A broker's counterparts with the given maxima, as the press hands them to the adapter.
     *
     * @param connections Connections a minute
     * @param writes Packets in 15 s
     */
    function lowered(connections: number, writes: number): BrokerLimits {
      const counterpart = (name: string, max: number, seconds: number): Counterpart => ({
        name,
        match: {},
        limits: [{ max, seconds, per: "account", source: "test" }],
      });
      return {
        host: "broker.example",
        connection: counterpart("connection", connections, 60),
        writes: counterpart("writes", writes, 15),
      };
    }

    /** mqtt.js as far as the gate sees it: CONNECT after the socket, `packetsend` for every packet, its own ping. */
    class FakeMqtt extends EventEmitter {
      connected = false;
      constructor(private readonly sent: number[]) {
        super();
        setTimeout(() => {
          this.write("connect");
          setTimeout(() => {
            this.connected = true;
            this.emit("connect");
          }, 20);
        }, 50);
      }
      private write(cmd: string): void {
        this.sent.push(Date.now());
        this.emit("packetsend", { cmd });
      }
      subscribe(_topic: string, _opts: unknown, cb: (e: Error | null) => void): void {
        this.write("subscribe");
        cb(null);
      }
      publish(): void {
        this.write("publish");
      }
      sendPing(): void {
        this.write("pingreq");
      }
      end(): void {
        this.connected = false;
      }
    }

    /**
     * The most entries any half-open sliding window of `ms` holds.
     *
     * @param times The moments, oldest first
     * @param ms The window
     */
    function peak(times: number[], ms: number): number {
      return Math.max(0, ...times.map((t, j) => times.slice(0, j + 1).filter(o => t - o < ms).length));
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    for (const [connections, writes] of [
      [1, 1],
      [1, 2],
      [2, 2],
    ]) {
      it(`at ${connections} connection(s) a minute and ${writes} write(s) in 15 s: connect, subscribe, pings, publishes and reconnects stay within both`, () => {
        const timers = {
          setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as ioBroker.Timeout,
          clearTimeout: (h: ioBroker.Timeout) => clearTimeout(h as unknown as NodeJS.Timeout),
          setInterval: () => undefined,
          clearInterval: () => {},
          delay: () => Promise.resolve(),
        } as unknown as TimerAdapter;
        const c = new TestClient(mockLog, timers);
        c.limits = lowered(connections, writes);
        const sent: number[] = [];
        const opened: number[] = [];
        let fake: FakeMqtt | undefined;
        const connectNow = (): void => {
          if (
            c.open(() => {
              opened.push(Date.now());
              fake = new FakeMqtt(sent);
              fake.on("connect", () =>
                c.subscribe(
                  "GA/topic",
                  () => {},
                  () => {},
                ),
              );
              return fake;
            })
          ) {
            return;
          }
          setTimeout(connectNow, c.waitForConnect);
        };
        connectNow();
        let subscribed = 0;
        for (let second = 0; second < 300; second++) {
          vi.advanceTimersByTime(1_000);
          // the application publishes every second, mqtt.js pings on its own clock — right behind a publish too
          c.publish();
          if (second % 60 === 59) {
            fake?.sendPing();
          }
          // the broker drops the connection twice; the client comes back as fast as the windows let it
          if (second === 100 || second === 200) {
            fake?.end();
            connectNow();
          }
          subscribed = sent.length;
        }
        expect(subscribed).toBeGreaterThan(0);
        expect(opened.length).toBe(3);
        expect(peak(opened, 60_000)).toBeLessThanOrEqual(connections);
        expect(peak(sent, 15_000)).toBeLessThanOrEqual(writes);
        // the press asks the window to be reached as well: with the application's demand it is
        expect(peak(sent, 15_000)).toBe(writes);
      });
    }

    it("a connect waits until the connection window and the write window have room — and says how long", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.limits = lowered(2, 10);
      const connect = (): unknown => ({ on: () => {}, end: () => {}, eventNames: () => [], listeners: () => [] });
      expect(c.open(connect)).toBe(true);
      expect(c.open(connect)).toBe(true);
      expect(c.waitForConnect).toBeGreaterThan(59_000);
      expect(c.open(connect)).toBe(false);
      c.arm();
      expect(t.scheduled.at(-1)!.ms).toBeGreaterThan(59_000); // the backoff waits for the window, not only its own 5 s
    });

    it("a write that waited for room is dropped once its client is gone — and a subscribe without a client is none", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t = makeCapturingTimers();
        const c = new TestClient(mockLog, t.timers);
        c.limits = lowered(2, 1);
        let told: ((packet: { cmd: string }) => void) | undefined;
        let subscribed = 0;
        const fake = {
          on: (event: string, listener: (packet: { cmd: string }) => void) => {
            if (event === "packetsend") {
              told = listener;
            }
            return fake;
          },
          end: () => {},
          eventNames: () => [],
          listeners: () => [],
          subscribe: () => {
            subscribed++;
          },
        };
        expect(c.open(() => fake)).toBe(true);
        told!({ cmd: "connect" }); // the CONNECT fills the write window
        c.subscribe(
          "GA/topic",
          () => {},
          () => {},
        );
        expect(subscribed).toBe(0);
        c.setClient({ connected: true }); // another client took its place
        vi.setSystemTime(Date.now() + 15_000);
        t.fireLast();
        expect(subscribed).toBe(0);
        c.setClient(null);
        expect(() =>
          c.subscribe(
            "GA/topic",
            () => {},
            () => {},
          ),
        ).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });

    it("hands its windows to the next process: what the last one sent still counts after a restart", () => {
      const t = makeCapturingTimers();
      const first = new TestClient(mockLog, t.timers);
      first.limits = lowered(1, 10);
      const connect = (): unknown => ({ on: () => {}, end: () => {}, eventNames: () => [], listeners: () => [] });
      expect(first.open(connect)).toBe(true);
      const next = new TestClient(mockLog, t.timers);
      next.limits = lowered(1, 10);
      next.rememberLimits(first.limitMemory());
      expect(next.open(connect)).toBe(false);
    });

    it("both Govee brokers declare a connection and a write limit in api-limits.json", () => {
      for (const host of ["mqtt.openapi.govee.com", "a1b2c3d4e5f6g7-ats.iot.eu-central-1.amazonaws.com"]) {
        const limits = brokerLimitsOf(host);
        expect(limits.connection.match.kind).toBe("tcp");
        expect(limits.writes.match.kind).toBe("tcp-write");
      }
      expect(() => brokerLimitsOf("broker.example")).toThrow(/declares no connection and write limit/);
    });
  });

  describe("releaseClient — a client ended while it still waits for CONNACK", () => {
    it("leaves mqtt.js's own close handler in place, so its CONNACK timer stops with the socket", async () => {
      // a broker that takes the connection and never answers — the client sits in its connectTimeout
      const sockets: net.Socket[] = [];
      const server = net.createServer(socket => sockets.push(socket));
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as net.AddressInfo;
      const c = new TestClient(mockLog, makeCapturingTimers().timers);
      let client: mqtt.MqttClient | undefined;
      c.openAt((url, opts) => (client = mqtt.connect(url, opts)), `mqtt://127.0.0.1:${port}`);
      const internals = (): { connackTimer?: { _destroyed?: boolean } } => client as never;
      const until = async (done: () => boolean): Promise<void> => {
        for (let i = 0; i < 100 && !done(); i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      try {
        await until(() => !!internals().connackTimer);
        expect(internals().connackTimer?._destroyed).toBe(false);
        c.disconnect();
        await until(() => internals().connackTimer?._destroyed === true);
        expect(internals().connackTimer?._destroyed).toBe(true);
      } finally {
        sockets.forEach(socket => socket.destroy());
        await new Promise(resolve => server.close(resolve));
      }
    });
  });

  describe("openBroker — the chosen network address (fleet master network-address.ts)", () => {
    it("connects from the chosen address, and from any address without one", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      const seen: Array<Record<string, unknown>> = [];
      const connect = (_url: string, opts: Record<string, unknown>): unknown => {
        seen.push(opts);
        return { removeAllListeners: () => {}, on: () => {}, end: () => {}, eventNames: () => [], listeners: () => [] };
      };
      c.open(connect);
      c.localAddress = "10.47.4.175";
      c.open(connect);
      expect(seen[0]).not.toHaveProperty("localAddress");
      expect(seen[1]).toMatchObject({ localAddress: "10.47.4.175", keepalive: 60, reconnectPeriod: 0 });
    });
  });

  describe("scheduleReconnect", () => {
    it("arms a backoff timer and fires reconnect() when it elapses", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.arm();
      expect(t.scheduled).toHaveLength(1);
      expect(c.reconnectCalls).toBe(0);
      expect(c.attempts).toBe(1);
      t.fireLast();
      expect(c.reconnectCalls).toBe(1);
    });

    it("does not arm a second timer while one is pending", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.arm();
      c.arm();
      expect(t.scheduled).toHaveLength(1);
      expect(c.attempts).toBe(1);
    });

    it("stops scheduling once the failure cap is reached", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.exhausted = true;
      c.arm();
      expect(t.scheduled).toHaveLength(0);
    });
  });

  describe("disposed guard", () => {
    it("never arms a timer after disconnect()", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.disconnect();
      c.arm();
      expect(t.scheduled).toHaveLength(0);
    });

    it("makes a stale timer that fires after disconnect a no-op", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      c.arm(); // timer captured
      c.disconnect(); // disposed = true, reconnectTimer cleared
      t.fireLast(); // stale callback fires
      expect(c.reconnectCalls).toBe(0);
    });
  });

  describe("connected getter", () => {
    it("reflects the live client and survives teardown", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      expect(c.connected).toBe(false);
      c.setClient({ connected: true });
      expect(c.connected).toBe(true);
      c.setClient(null);
      expect(c.connected).toBe(false);
    });
  });

  describe("subscribeOrForceClose", () => {
    it("calls onSubscribed and does not end the client on success", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      let ended = false;
      let okCalled = false;
      let failMsg: string | null = null;
      c.setClient({
        subscribe: (_topic: string, _opts: unknown, cb: (e: Error | null) => void) => cb(null),
        end: () => {
          ended = true;
        },
      });
      c.subscribe(
        "GA/topic",
        () => {
          okCalled = true;
        },
        m => {
          failMsg = m;
        },
      );
      expect(okCalled).toBe(true);
      expect(failMsg).toBeNull();
      expect(ended).toBe(false);
    });

    it("forces a close and calls onSubscribeFail on subscribe error", () => {
      const t = makeCapturingTimers();
      const c = new TestClient(mockLog, t.timers);
      let endedForce: boolean | null = null;
      let okCalled = false;
      let failMsg: string | null = null;
      c.setClient({
        subscribe: (_topic: string, _opts: unknown, cb: (e: Error | null) => void) => cb(new Error("policy denied")),
        end: (force: boolean) => {
          endedForce = force;
        },
      });
      c.subscribe(
        "GA/topic",
        () => {
          okCalled = true;
        },
        m => {
          failMsg = m;
        },
      );
      expect(okCalled).toBe(false);
      expect(failMsg).toBe("policy denied");
      expect(endedForce).toBe(true);
    });
  });
});
