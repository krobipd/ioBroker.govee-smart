import { CloudRetryLoop, type CloudRetryHost } from "./cloud-retry";
import type { CloudLoadResult } from "./types";

/**
 * Test harness — records every call the loop makes to its host and lets tests
 * fire the scheduled timer on demand. The real adapter's ioBroker setTimeout
 * is async; here we make it deterministic so we can assert exact sequences.
 */
class TestHost implements CloudRetryHost {
  public readonly logs: { level: string; msg: string }[] = [];
  public readonly timers: { cb: () => void; ms: number }[] = [];
  public clearedTimers = 0;
  public loadCalls = 0;
  public restoredCalls = 0;
  public loadResults: CloudLoadResult[] = [];
  public onCloudRestoredThrows: Error | null = null;

  public log = {
    debug: (m: string): void => {
      this.logs.push({ level: "debug", msg: m });
    },
    info: (m: string): void => {
      this.logs.push({ level: "info", msg: m });
    },
    warn: (m: string): void => {
      this.logs.push({ level: "warn", msg: m });
    },
  };

  public setTimeout(cb: () => void, ms: number): unknown {
    const idx = this.timers.length;
    this.timers.push({ cb, ms });
    return idx;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number" && this.timers[handle]) {
      this.timers[handle] = { cb: (): void => {}, ms: -1 };
    }
    this.clearedTimers += 1;
  }

  public async loadFromCloud(): Promise<CloudLoadResult> {
    this.loadCalls += 1;
    const r = this.loadResults.shift();
    if (!r) {
      throw new Error("TestHost.loadFromCloud called with no queued result");
    }
    return r;
  }

  public async onCloudRestored(): Promise<void> {
    this.restoredCalls += 1;
    if (this.onCloudRestoredThrows) {
      throw this.onCloudRestoredThrows;
    }
  }

  /** Fire the most-recently scheduled timer — returns its delay. */
  public fireLatestTimer(): number {
    const last = this.timers[this.timers.length - 1];
    expect(last).toBeDefined();
    last.cb();
    return last.ms;
  }

  public lastWarn(): string | undefined {
    const w = [...this.logs].reverse().find(l => l.level === "warn");
    return w?.msg;
  }
}

function queueResults(host: TestHost, ...rs: CloudLoadResult[]): void {
  host.loadResults.push(...rs);
}

describe("CloudRetryLoop", () => {
  let host: TestHost;
  let loop: CloudRetryLoop;

  beforeEach(() => {
    host = new TestHost();
    loop = new CloudRetryLoop(host);
  });

  describe("handleResult — auth-failed", () => {
    it("should stop the loop permanently and not schedule a retry", () => {
      loop.handleResult({
        ok: false,
        reason: "auth-failed",
        message: "HTTP 403",
      });
      expect(host.timers).toHaveLength(0);
      expect(host.lastWarn()).toContain("authentication failed");
      // Stopped-for-good is observable behaviour: a later transient result
      // must not schedule a retry either.
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(0);
    });

    it("should stop even if called twice", () => {
      loop.handleResult({
        ok: false,
        reason: "auth-failed",
        message: "x",
      });
      loop.handleResult({
        ok: false,
        reason: "auth-failed",
        message: "x",
      });
      expect(host.timers).toHaveLength(0);
    });

    it("should cancel any pending transient retry when auth fails later", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(1);
      loop.handleResult({
        ok: false,
        reason: "auth-failed",
        message: "x",
      });
      // clearTimeout should have been called on the pending timer
      expect(host.clearedTimers).toBeGreaterThan(0);
    });
  });

  describe("handleResult — rate-limited", () => {
    it("should schedule a retry with the server-supplied delay", () => {
      loop.handleResult({
        ok: false,
        reason: "rate-limited",
        retryAfterMs: 30_000,
      });
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0].ms).toBe(30_000);
      expect(host.lastWarn()).toContain("30s");
    });

    it("floors a zero / malformed Retry-After so it can't tight-loop (L5)", () => {
      loop.handleResult({ ok: false, reason: "rate-limited", retryAfterMs: 0 });
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0].ms).toBe(5_000); // floored to MIN_RATE_LIMIT_RETRY_MS, not 0
      expect(host.lastWarn()).toContain("5s");
    });

    it("should not double-schedule when called twice", () => {
      loop.handleResult({
        ok: false,
        reason: "rate-limited",
        retryAfterMs: 30_000,
      });
      loop.handleResult({
        ok: false,
        reason: "rate-limited",
        retryAfterMs: 60_000,
      });
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0].ms).toBe(30_000);
    });

    it("should honour Retry-After on every consecutive 429", async () => {
      queueResults(
        host,
        { ok: false, reason: "rate-limited", retryAfterMs: 45_000 },
        { ok: false, reason: "rate-limited", retryAfterMs: 120_000 },
      );
      loop.handleResult({
        ok: false,
        reason: "rate-limited",
        retryAfterMs: 30_000,
      });
      expect(host.timers[0].ms).toBe(30_000);

      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();

      // After retry still rate-limited → new timer with next Retry-After
      expect(host.timers).toHaveLength(2);
      expect(host.timers[1].ms).toBe(45_000);
    });
  });

  describe("handleResult — transient", () => {
    it("should schedule a retry after 5 minutes", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0].ms).toBe(5 * 60_000);
    });

    it("should treat unknown reasons as transient", () => {
      loop.handleResult({
        ok: false,
        reason: "weird" as unknown as "transient",
      });
      expect(host.timers[0].ms).toBe(5 * 60_000);
    });

    it("should not log a warning for transient (noise budget)", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.logs.filter(l => l.level === "warn")).toHaveLength(0);
    });
  });

  describe("handleResult — ok", () => {
    it("should be a no-op", () => {
      loop.handleResult({ ok: true });
      expect(host.timers).toHaveLength(0);
      expect(host.logs).toHaveLength(0);
    });
  });

  describe("successful retry", () => {
    it("should call onCloudRestored and stop retrying once connected", async () => {
      queueResults(host, { ok: true });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.restoredCalls).toBe(1);
      // Connected-state is observable behaviour: a later transient result
      // must not re-arm the loop while the connection is up.
      const timersBefore = host.timers.length;
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(timersBefore);
    });

    it("should log 'Govee Cloud connection restored' on success", async () => {
      queueResults(host, { ok: true });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      const info = host.logs.filter(l => l.level === "info");
      expect(info.some(l => l.msg.includes("restored"))).toBe(true);
    });

    it("does not log 'restored' or fire onCloudRestored when disposed mid-load (L13)", async () => {
      queueResults(host, { ok: true });
      const origLoad = host.loadFromCloud.bind(host);
      host.loadFromCloud = async () => {
        loop.dispose(); // adapter unloaded while the load was in flight
        return origLoad();
      };
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.restoredCalls).toBe(0);
      expect(host.logs.filter(l => l.level === "info").some(l => l.msg.includes("restored"))).toBe(false);
    });

    it("should re-arm when the retry still fails", async () => {
      queueResults(host, { ok: false, reason: "transient" }, { ok: true });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      // After failed retry, second timer queued
      expect(host.timers).toHaveLength(2);
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.restoredCalls).toBe(1);
    });
  });

  describe("connected short-circuit", () => {
    it("should skip load when setConnected(true) before timer fires", async () => {
      loop.handleResult({ ok: false, reason: "transient" });
      loop.setConnected(true);
      host.fireLatestTimer();
      await Promise.resolve();
      // Because the timer was cleared by setConnected, the callback that
      // would call loadFromCloud is replaced with a no-op.
      expect(host.loadCalls).toBe(0);
    });

    it("should not schedule a new retry while already connected", () => {
      loop.setConnected(true);
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(0);
    });

    it("setConnected(true) should cancel any pending timer", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      const before = host.clearedTimers;
      loop.setConnected(true);
      expect(host.clearedTimers).toBeGreaterThan(before);
    });

    it("setConnected(false) should allow the loop to resume scheduling", () => {
      loop.setConnected(true);
      loop.setConnected(false);
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(1);
    });
  });

  describe("stopped short-circuit", () => {
    it("should not run loadFromCloud after auth-fail", async () => {
      loop.handleResult({
        ok: false,
        reason: "auth-failed",
        message: "x",
      });
      // Even if a future handleResult is called with transient, no retry
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers).toHaveLength(0);
      expect(host.loadCalls).toBe(0);
    });
  });

  describe("dispose", () => {
    it("should clear the pending retry timer", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      const before = host.clearedTimers;
      loop.dispose();
      expect(host.clearedTimers).toBeGreaterThan(before);
    });

    it("should be safe when no timer is pending", () => {
      expect(() => loop.dispose()).not.toThrow();
    });

    it("should be safe to call twice", () => {
      loop.handleResult({ ok: false, reason: "transient" });
      loop.dispose();
      expect(() => loop.dispose()).not.toThrow();
    });
  });

  describe("defensive behaviour", () => {
    it("should swallow a rejection from onCloudRestored without breaking state", async () => {
      host.onCloudRestoredThrows = new Error("downstream crashed");
      queueResults(host, { ok: true });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      // The swallowed rejection ends up as a debug log via runAttempt's
      // catch handler — wait for microtasks to flush.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const dbg = host.logs.filter(l => l.level === "debug");
      expect(dbg.some(l => l.msg.includes("downstream crashed"))).toBe(true);
    });

    it("should not log 'restored' when the retry itself returns transient", async () => {
      queueResults(host, { ok: false, reason: "transient" });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      const info = host.logs.filter(l => l.level === "info");
      expect(info.some(l => l.msg.includes("restored"))).toBe(false);
      expect(host.restoredCalls).toBe(0);
    });

    it("should allow a new transient after a successful restore cycle", async () => {
      queueResults(host, { ok: true });
      loop.handleResult({ ok: false, reason: "transient" });
      host.fireLatestTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.restoredCalls).toBe(1);

      // Later, the host notices the connection dropped
      loop.setConnected(false);
      loop.handleResult({ ok: false, reason: "transient" });
      expect(host.timers.length).toBeGreaterThanOrEqual(2);
      const lastTimer = host.timers[host.timers.length - 1];
      expect(lastTimer.ms).toBe(5 * 60_000);
    });
  });
});
