import { ReconnectingMqttClient, computeBackoffDelay } from "./reconnecting-mqtt-client";
import { type TimerAdapter } from "./types";

const mockLog: ioBroker.Logger = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  level: "debug",
};

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
  protected readonly channelLabel = "Test";

  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
    super(log, timers);
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
  public get hasArmedTimer(): boolean {
    return this.reconnectTimer !== undefined;
  }
  public get attempts(): number {
    return this.reconnectAttempts;
  }
}

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
