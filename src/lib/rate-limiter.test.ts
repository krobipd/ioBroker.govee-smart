import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiLimit, Counterpart } from "./api-limits";
import { currentBooking } from "./call-booking";
import {
  ACCOUNT_LIST_LANE,
  LIMITER_MEMORY_FILE,
  MAX_QUEUE_LENGTH,
  QUEUE_MAX_WINDOW_SECONDS,
  RateLimiter,
  applianceBudget,
  loadLimiterMemory,
  saveLimiterMemory,
  type CallLane,
} from "./rate-limiter";
import { CLOUD_LIMITS, type CloudLimits } from "./timing-constants";
import type { GoveeDevice, TimerAdapter } from "./types";
import { mockLog } from "../../test/test-helpers";

/**
 * A counterpart of one window — the shape api-limits.json gives every limit.
 *
 * @param name Its name
 * @param max Calls in the window
 * @param seconds Window length
 * @param per Account or device
 */
function counterpart(name: string, max: number, seconds: number, per: ApiLimit["per"] = "account"): Counterpart {
  return { name, match: {}, limits: [{ max, seconds, per, source: "test cap" }] };
}

/**
 * The queue, the daily window and the eviction rules on the account-list lane, which is what a lane-less call is
 * charged to: a minute window of `perMinute` and a day of `perDay`, shared by every OpenAPI lane like the declared one.
 *
 * @param perMinute The account-list minute window
 * @param perDay The daily window
 */
function limitsOf(perMinute: number, perDay: number): CloudLimits {
  const day = counterpart("test day", perDay, 86_400);
  return {
    "account-list": [counterpart("test list", perMinute, 60), day],
    "device-read": [CLOUD_LIMITS["device-read"][0], day],
    "device-control": [CLOUD_LIMITS["device-control"][0], day],
    appapi: CLOUD_LIMITS.appapi,
  };
}

/** A clock the test moves by hand — every window slides against it. */
function manualClock(): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: ms => (t += ms), set: v => (t = v) };
}

/** Timer adapter that captures scheduled callbacks so a test can fire them. */
function makeCapturingTimers(): {
  timers: TimerAdapter;
  timeouts: Array<{ cb: () => void; ms: number }>;
  clears: () => number;
} {
  const timeouts: Array<{ cb: () => void; ms: number }> = [];
  let clears = 0;
  const timers = {
    setInterval: () => undefined,
    clearInterval: () => {
      clears++;
    },
    setTimeout: (cb: () => void, ms: number) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    },
    clearTimeout: () => {
      clears++;
    },
    delay: () => Promise.resolve(),
  } as never;
  return { timers, timeouts, clears: () => clears };
}

/**
 * A limiter on a hand-moved clock with captured timers.
 *
 * @param limits The budget
 * @param log Logger
 */
function bench(
  limits: CloudLimits = CLOUD_LIMITS,
  log: ioBroker.Logger = mockLog,
): {
  rl: RateLimiter;
  clock: ReturnType<typeof manualClock>;
  timeouts: ReturnType<typeof makeCapturingTimers>["timeouts"];
  ran: () => number;
  fire: (lane?: CallLane) => Promise<boolean>;
  process: () => void;
} {
  const clock = manualClock();
  const t = makeCapturingTimers();
  const rl = new RateLimiter(log, t.timers, limits, clock.now);
  rl.start();
  let ran = 0;
  const fire = (lane: CallLane = ACCOUNT_LIST_LANE): Promise<boolean> =>
    rl.tryExecute(() => {
      ran++;
      return Promise.resolve();
    }, lane);
  return { rl, clock, timeouts: t.timeouts, ran: () => ran, fire, process: () => (rl as any).processQueue() };
}

describe("RateLimiter", () => {
  it("should allow calls within limits", () => {
    const { rl } = bench(limitsOf(5, 100));
    expect(rl.canMakeCall()).toBe(true);
  });

  it("should track daily usage", async () => {
    const { rl, ran, fire } = bench(limitsOf(10, 100));
    await fire();
    await fire();
    await fire();
    expect(ran()).toBe(3);
    expect(rl.getUsageSnapshot().usedToday).toBe(3);
  });

  it("should queue calls when the minute window is full", async () => {
    const { ran, fire } = bench(limitsOf(2, 100));
    await fire();
    await fire();
    expect(await fire()).toBe(false);
    expect(ran()).toBe(2);
  });

  it("should respect the daily window — the third call is refused, not queued", async () => {
    const { rl, ran, fire } = bench(limitsOf(100, 2));
    await fire();
    await fire();
    expect(await fire()).toBe(false);
    expect(ran()).toBe(2);
    expect(rl.getUsageSnapshot().usedToday).toBe(2);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("should enqueue with priority sorting", () => {
    const { rl } = bench(limitsOf(0, 100)); // minute limit 0 = all queued
    rl.enqueue(() => Promise.resolve(), ACCOUNT_LIST_LANE, 2);
    rl.enqueue(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0);
    rl.enqueue(() => Promise.resolve(), ACCOUNT_LIST_LANE, 1);
    const queue = (rl as any).queue;
    expect(queue).toHaveLength(3);
    expect(queue.map((q: { priority: number }) => q.priority)).toEqual([0, 1, 2]);
  });

  it("evicts the lowest-priority queued call for a higher-priority one when full (L15)", () => {
    const { rl } = bench(limitsOf(0, 100_000)); // minute limit 0 → all queue
    for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
      rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 2); // fill with low-priority (scene) calls
    }
    const queue = (rl as any).queue as Array<{ priority: number }>;
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH);
    expect(queue.every(e => e.priority === 2)).toBe(true);

    // A fresh high-priority (0 = control) call must get in, evicting a prio-2 tail.
    rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 0);
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH); // still capped
    expect(queue[0].priority).toBe(0); // high-priority call is at the head
    expect(queue.filter(e => e.priority === 2)).toHaveLength(MAX_QUEUE_LENGTH - 1); // one evicted

    // A fresh low-priority (2) call when full is still dropped (doesn't outrank the tail).
    rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 2);
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH);
    expect(queue.filter(e => e.priority === 0)).toHaveLength(1); // unchanged
  });

  it("should clear queue on stop", () => {
    const { rl } = bench(limitsOf(0, 100));
    rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 1);
    rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 2);
    expect((rl as any).queue).toHaveLength(2);
    rl.stop();
    expect((rl as any).queue).toHaveLength(0);
  });

  it("should return true when executed immediately", async () => {
    const { fire } = bench(limitsOf(10, 100));
    expect(await fire()).toBe(true);
  });

  describe("executeTracked (M3 — user commands couple to the ACTUAL execution)", () => {
    it("runs immediately within budget and propagates an immediate failure", async () => {
      const { rl } = bench(limitsOf(10, 100));
      let ran = 0;
      await rl.executeTracked(() => {
        ran++;
        return Promise.resolve();
      });
      expect(ran).toBe(1);
      await expect(rl.executeTracked(async () => Promise.reject(new Error("cloud says no")))).rejects.toThrow(
        "cloud says no",
      );
    });

    it("settles only when the QUEUED call eventually ran — success case", async () => {
      const { rl, clock, fire, process } = bench(limitsOf(1, 100));
      await fire(); // fill the minute window
      let ran = 0;
      const tracked = rl.executeTracked(() => {
        ran++;
        return Promise.resolve();
      });
      expect(ran).toBe(0); // queued, not run
      clock.advance(60_000); // the first call's slot frees
      process();
      await tracked;
      expect(ran).toBe(1);
    });

    it("rejects when the QUEUED call eventually fails — before M3 this was a debug line after the ack", async () => {
      const { rl, clock, fire, process } = bench(limitsOf(1, 100));
      await fire();
      const tracked = rl.executeTracked(async () => Promise.reject(new Error("late 429")));
      clock.advance(60_000);
      process();
      await expect(tracked).rejects.toThrow("late 429");
    });

    it("a queued call that rejects with a plain object surfaces the object's fields, not [object Object]", async () => {
      const { rl, clock, fire, process } = bench(limitsOf(1, 100));
      await fire();
      // The caller normalises to an Error — its message must carry what was thrown.
      // (vi.fn, not Promise.reject: the lint rule against non-Error rejections is right
      // for production code, and a plain-object rejection is exactly the case under test.)
      const execute = vi.fn<() => Promise<void>>().mockRejectedValue({ code: "ECONNRESET" });
      const tracked = rl.executeTracked(execute);
      clock.advance(60_000);
      process();
      await expect(tracked).rejects.toThrow('{"code":"ECONNRESET"}');
    });

    it("rejects when the tracked call is evicted from a full queue", async () => {
      const { rl } = bench(limitsOf(0, 100_000)); // all queue
      for (let i = 0; i < MAX_QUEUE_LENGTH - 1; i++) {
        rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 2);
      }
      const evictable = rl.executeTracked(async () => {}, ACCOUNT_LIST_LANE, 2); // tracked tail
      const incoming = rl.executeTracked(async () => {}, ACCOUNT_LIST_LANE, 0); // outranks → evicts the tail
      await expect(evictable).rejects.toThrow("evicted");
      // the incoming call itself stays queued (never settles here) — detach it
      void incoming.catch(() => undefined);
    });

    it("rejects pending tracked calls on stop() instead of hanging forever", async () => {
      const { rl } = bench(limitsOf(0, 100)); // all queue
      const tracked = rl.executeTracked(async () => {}, ACCOUNT_LIST_LANE, 0);
      rl.stop();
      await expect(tracked).rejects.toThrow("stopped");
    });

    it("rejects immediately when a full queue drops the call", async () => {
      const { rl } = bench(limitsOf(0, 100_000));
      for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
        rl.enqueue(async () => {}, ACCOUNT_LIST_LANE, 0); // full with top-priority calls
      }
      await expect(rl.executeTracked(async () => {}, ACCOUNT_LIST_LANE, 2)).rejects.toThrow("queue full");
    });
  });

  it("should track both the minute and the daily window", async () => {
    const { rl, fire } = bench(limitsOf(5, 100));
    await fire();
    await fire();
    const snap = rl.getUsageSnapshot();
    expect(snap.windows.find(w => w.lane === "test list|0|account")).toEqual({
      lane: "test list|0|account",
      seconds: 60,
      max: 5,
      used: 2,
    });
    expect(snap.usedToday).toBe(2);
  });

  it("should block when the daily window alone is full", async () => {
    const { rl, fire } = bench(limitsOf(100, 1));
    await fire();
    expect(rl.canMakeCall()).toBe(false);
  });
});

describe("RateLimiter — sliding windows, the way Govee counts and the fleet judges (Werkbank rounds 170/171)", () => {
  it("a slot frees exactly the window's length after its call ended — the window is half open", async () => {
    const { clock, ran, fire, process } = bench(limitsOf(2, 100));
    await fire();
    await fire();
    await fire(); // queued
    clock.advance(59_999);
    process();
    expect(ran()).toBe(2);
    clock.advance(1);
    process();
    expect(ran()).toBe(3);
  });

  it("a call holds its slot while it is open, and from its end on — never from its start", async () => {
    const { rl, clock, ran, fire, process } = bench(limitsOf(1, 100));
    let answer!: () => void;
    const slow = rl.tryExecute(() => new Promise<void>(resolve => (answer = resolve)));
    clock.advance(120_000); // two minutes in flight — its slot is still held
    await fire();
    expect(ran()).toBe(0);
    answer();
    await slow;
    clock.advance(59_999); // the window counts from the answer
    process();
    expect(ran()).toBe(0);
    clock.advance(1);
    process();
    expect(ran()).toBe(1);
  });

  it("no calendar reset: a full window right before a minute boundary stays full after it", async () => {
    // A counter zeroed every 60 s let twice the maximum into one sliding minute — the 20 calls before the reset and
    // the 20 after it fall within 2 s of each other.
    const { clock, ran, fire, process } = bench(limitsOf(20, 1000));
    clock.set(59_000);
    for (let i = 0; i < 25; i++) {
      await fire();
    }
    expect(ran()).toBe(20);
    clock.set(61_000); // across the minute boundary
    process();
    expect(ran()).toBe(20);
    clock.set(119_000); // 60 s after the twenty ended
    process();
    expect(ran()).toBe(25);
  });

  it("the queue wakes when the soonest window a waiting call needs has room again", async () => {
    const { clock, timeouts, ran, fire } = bench(limitsOf(1, 100));
    await fire();
    clock.advance(10_000);
    await fire(); // queued — the first call's slot frees 50 s from now
    const wake = timeouts.at(-1)!;
    expect(wake.ms).toBe(50_000);
    clock.advance(50_000);
    wake.cb();
    expect(ran()).toBe(2);
  });

  it("with several calls waiting, the queue wakes for the soonest of them — not for the last one queued", async () => {
    const { clock, timeouts, fire } = bench(limitsOf(1, 100));
    await fire(); // fills the list window at t0
    clock.advance(30_000);
    for (let i = 0; i < 8; i++) {
      await fire({ kind: "appapi" }); // fills the libraries window at t0 + 30 s
    }
    await fire(); // the list call waits 30 s
    await fire({ kind: "appapi" }); // the library call waits 60 s
    expect(timeouts.at(-1)!.ms).toBe(30_000);
  });

  it("a window full of open calls wakes the queue when one of them ends", async () => {
    const { rl, clock, timeouts, ran, fire } = bench(limitsOf(1, 100));
    let answer!: () => void;
    const slow = rl.tryExecute(() => new Promise<void>(resolve => (answer = resolve)));
    await fire(); // queued behind an open call — no moment to wake yet
    const armed = timeouts.length;
    expect(armed).toBe(0);
    answer();
    await slow;
    expect(timeouts.length).toBe(armed + 1);
    expect(timeouts.at(-1)!.ms).toBe(60_000);
    clock.advance(60_000);
    timeouts.at(-1)!.cb();
    expect(ran()).toBe(1);
  });

  it("stop() clears the wake-up, and a stopped limiter runs no queued call", async () => {
    const t = makeCapturingTimers();
    const clock = manualClock();
    const rl = new RateLimiter(mockLog, t.timers, limitsOf(1, 100), clock.now);
    rl.start();
    let ran = 0;
    const inc = (): Promise<void> => {
      ran++;
      return Promise.resolve();
    };
    await rl.tryExecute(inc);
    await rl.tryExecute(inc); // queued, wake-up armed
    await rl.tryExecute(inc); // queued too — the wake-up is armed anew, the first one cleared
    expect(t.clears()).toBe(1);
    rl.stop();
    expect(t.clears()).toBe(2);
    clock.advance(60_000);
    t.timeouts.forEach(w => w.cb());
    expect(ran).toBe(1);
  });
});

describe("RateLimiter — the daily window outlives a restart", () => {
  it("a limiter that remembers counts the calls the previous process made in the last 24 hours", async () => {
    const first = bench(limitsOf(100, 3));
    await first.fire();
    await first.fire();
    const memory = first.rl.memory();
    expect(memory.lanes["test day|0|account"]).toEqual([1_000_000, 1_000_000]);
    const second = bench(limitsOf(100, 3));
    second.clock.set(1_000_000 + 3_600_000); // an hour later
    second.rl.remember(memory);
    expect(second.rl.getUsageSnapshot().usedToday).toBe(2);
    await second.fire();
    expect(await second.fire()).toBe(false);
    expect(second.ran()).toBe(1);
  });

  it("a limiter that made no call leaves an empty memory — no lane without a call in it", () => {
    const { rl } = bench();
    expect(rl.memory()).toEqual({ lanes: {} });
  });

  it("carries only windows longer than an hour — a minute is long past when the next process asks", async () => {
    const { rl, fire } = bench(limitsOf(5, 100));
    await fire();
    const lanes = Object.keys(rl.memory().lanes);
    expect(lanes).toEqual(["test day|0|account"]);
    expect(QUEUE_MAX_WINDOW_SECONDS).toBe(3600);
  });

  it("drops what lies outside the window, in the future or in a lane it does not keep", () => {
    const { rl, clock } = bench(limitsOf(100, 10));
    const now = clock.now();
    rl.remember({
      lanes: {
        "test day|0|account": [now - 86_400_000, now - 1000, now + 5000],
        "nobody|0|account": [now - 1000],
        "test list|0|account": [now - 1000],
      },
    });
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
    expect(rl.memory().lanes).toEqual({ "test day|0|account": [now - 1000] });
  });

  it("an appliance's allowance is carried over too", async () => {
    const budget = { key: "H7160:AA:BB", perDay: 2 };
    const first = bench(limitsOf(100, 100));
    await first.rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, budget);
    await first.rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, budget);
    const second = bench(limitsOf(100, 100));
    second.rl.remember(first.rl.memory());
    expect(await second.rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, budget)).toBe(false);
  });

  it("an open call at the stop counts as ending then", () => {
    const { rl, clock } = bench(limitsOf(100, 100));
    void rl.tryExecute(() => new Promise<void>(() => {}));
    clock.advance(5000);
    expect(rl.memory().lanes["test day|0|account"]).toEqual([clock.now()]);
  });

  it("the memory file round-trips; a missing, broken or foreign file is an empty memory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-limits-"));
    try {
      expect(loadLimiterMemory(dir)).toEqual({ lanes: {} });
      await saveLimiterMemory(path.join(dir, "sub"), { lanes: { "a|0|account": [1, 2] } });
      expect(loadLimiterMemory(path.join(dir, "sub"))).toEqual({ lanes: { "a|0|account": [1, 2] } });
      fs.writeFileSync(path.join(dir, LIMITER_MEMORY_FILE), "{not json");
      expect(loadLimiterMemory(dir)).toEqual({ lanes: {} });
      fs.writeFileSync(path.join(dir, LIMITER_MEMORY_FILE), JSON.stringify({ lanes: 5 }));
      expect(loadLimiterMemory(dir)).toEqual({ lanes: {} });
      fs.writeFileSync(
        path.join(dir, LIMITER_MEMORY_FILE),
        JSON.stringify({ lanes: { a: [1, "2", null, Infinity, 3], b: "x" } }),
      );
      expect(loadLimiterMemory(dir)).toEqual({ lanes: { a: [1, 3] } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RateLimiter — queue cap (v2.16.1)", () => {
  it("drops new calls once the queue is full — warn on the first drop, debug on repeats", () => {
    const warns: string[] = [];
    const debugs: string[] = [];
    const log = {
      ...mockLog,
      warn: (m: string) => warns.push(m),
      debug: (m: string) => debugs.push(m),
    } as ioBroker.Logger;
    const { rl } = bench(limitsOf(0, 100), log); // limit 0 → everything queues
    for (let i = 0; i < 200; i++) {
      rl.enqueue(async () => {});
    }
    expect((rl as any).queue).toHaveLength(200);
    rl.enqueue(async () => {}); // 201st → dropped + warn
    rl.enqueue(async () => {}); // 202nd → dropped + debug (dedup)
    expect((rl as any).queue).toHaveLength(200);
    expect(warns.filter(m => m.includes("queue full"))).toHaveLength(1);
    expect(debugs.filter(m => m.includes("queue full"))).toHaveLength(1);
  });

  it("a drained queue re-arms the overflow warning for the next episode", () => {
    const warns: string[] = [];
    const log = { ...mockLog, warn: (m: string) => warns.push(m) } as ioBroker.Logger;
    const limits = limitsOf(300, 1000);
    const { rl, process } = bench(limits, log);
    // a window that is full when the calls are queued and empty when the queue runs
    (rl as any).limits = limitsOf(0, 1000);
    for (let i = 0; i < 200; i++) {
      rl.enqueue(async () => {});
    }
    rl.enqueue(async () => {}); // overflow #1 → warn
    expect(warns).toHaveLength(1);
    (rl as any).limits = limits;
    process(); // drains everything (window 300)
    expect((rl as any).queue).toHaveLength(0);
    (rl as any).limits = limitsOf(0, 1000);
    for (let i = 0; i < 201; i++) {
      rl.enqueue(async () => {}); // overflow #2 → warns again
    }
    expect(warns).toHaveLength(2);
    rl.stop();
  });
});

describe("per-device daily budget", () => {
  it("an app group has no allowance of its own, whatever type Govee lists it with — its members pay", () => {
    const group = { sku: "BaseGroup", deviceId: "9900001", type: "" } as GoveeDevice;
    expect(applianceBudget(group)).toBeUndefined();
    expect(applianceBudget({ ...group, sku: "H7160", deviceId: "AA:BB" })).toEqual({
      key: "H7160:AA:BB",
      perDay: expect.any(Number),
    });
  });

  // Govee's limits are not one budget: the account gets 10,000 calls a day, but
  // an APPLIANCE gets 100 for itself — and appliance control has no local path,
  // so every write is a cloud call. The global windows cannot express that.
  const APPLIANCE = { key: "H7160:AA:BB", perDay: 3 };

  it("stops a device once it has spent its own allowance, while the global budget is untouched", async () => {
    const { rl } = bench(limitsOf(100, 10_000));
    let ran = 0;
    for (let i = 0; i < 5; i++) {
      await rl.tryExecute(
        (): Promise<void> => {
          ran += 1;
          return Promise.resolve();
        },
        ACCOUNT_LIST_LANE,
        0,
        APPLIANCE,
      );
    }
    expect(ran).toBe(3);
    // The global budget still has room — this is the device's own limit biting.
    expect(rl.getUsageSnapshot().usedToday).toBe(3);
  });

  it("does not queue an exhausted device — the allowance frees in hours, not seconds", async () => {
    // Queuing would hold the write for hours and then apply it at a moment nobody asked for.
    const { rl } = bench(limitsOf(100, 10_000));
    for (let i = 0; i < 3; i++) {
      await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    }
    expect(await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE)).toBe(false);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("a tracked call rejects rather than silently doing nothing", async () => {
    // User commands must not ack as if they had run.
    const { rl } = bench(limitsOf(100, 10_000));
    for (let i = 0; i < 3; i++) {
      await rl.executeTracked(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    }
    await expect(rl.executeTracked(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE)).rejects.toThrow(
      /budget/i,
    );
  });

  it("warns once per device, not on every rejected write", async () => {
    const warns: string[] = [];
    const { rl } = bench(limitsOf(100, 10_000), { ...mockLog, warn: (m: string) => warns.push(m) });
    for (let i = 0; i < 8; i++) {
      await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("H7160:AA:BB");
  });

  it("budgets are per device — a second appliance is unaffected", async () => {
    const { rl } = bench(limitsOf(100, 10_000));
    let other = 0;
    for (let i = 0; i < 5; i++) {
      await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    }
    await rl.tryExecute(
      () => {
        other += 1;
        return Promise.resolve();
      },
      ACCOUNT_LIST_LANE,
      0,
      { key: "H7131:CC:DD", perDay: 3 },
    );
    expect(other).toBe(1);
  });

  it("a QUEUED call is booked against the device allowance, not only an immediate one", async () => {
    // The protection used to fail exactly under load: the allowance was booked
    // only on the immediate path, so every call that had to wait for the
    // per-minute limit ran later without ever being counted. A burst is
    // precisely when calls queue.
    const { rl, clock, process } = bench(limitsOf(1, 10_000));
    await rl.tryExecute(() => Promise.resolve()); // fills the minute window, no allowance
    let ran = 0;
    for (let i = 0; i < 3; i++) {
      await rl.tryExecute(
        () => {
          ran += 1;
          return Promise.resolve();
        },
        ACCOUNT_LIST_LANE,
        0,
        APPLIANCE,
      );
    }
    expect(rl.getUsageSnapshot().queueLength).toBe(3);
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      process();
      await new Promise(resolve => setImmediate(resolve)); // the call ends — its slot counts from then
    }
    expect(ran).toBe(3);
    // Booked — so the very next call for this device is refused.
    clock.advance(60_000);
    expect(await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE)).toBe(false);
  });

  it("a queued call is dropped when immediate calls spent the allowance while it waited", async () => {
    const { rl, clock, process } = bench(limitsOf(1, 10_000));
    let queuedRan = 0;
    await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    await rl.tryExecute(
      () => {
        queuedRan += 1;
        return Promise.resolve();
      },
      ACCOUNT_LIST_LANE,
      0,
      APPLIANCE,
    );
    expect(rl.getUsageSnapshot().queueLength).toBe(1);
    // Two more immediate calls on another lane of the same device exhaust the allowance of 3 before the queue runs.
    const READ: CallLane = { kind: "device-read", deviceKey: "H7160:AA:BB" };
    await rl.tryExecute(() => Promise.resolve(), READ, 0, APPLIANCE);
    await rl.tryExecute(() => Promise.resolve(), READ, 0, APPLIANCE);
    clock.advance(60_000);
    process();
    await Promise.resolve();
    expect(queuedRan, "the queued call must not overrun the device's day").toBe(0);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("a queued TRACKED call rejects instead of hanging when the allowance ran out meanwhile", async () => {
    const { rl, clock, process } = bench(limitsOf(1, 10_000));
    await rl.tryExecute(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    const tracked = rl.executeTracked(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, APPLIANCE);
    const READ: CallLane = { kind: "device-read", deviceKey: "H7160:AA:BB" };
    await rl.tryExecute(() => Promise.resolve(), READ, 0, APPLIANCE);
    await rl.tryExecute(() => Promise.resolve(), READ, 0, APPLIANCE);
    clock.advance(60_000);
    process();
    await expect(tracked).rejects.toThrow(/budget/i);
  });

  it("a call without a budget is never blocked by one", async () => {
    // Lights keep the global budget: their writes go over the LAN and the rare
    // cloud fallback is covered by the account limit.
    const { ran, fire } = bench(limitsOf(100, 10_000));
    for (let i = 0; i < 10; i++) {
      await fire();
    }
    expect(ran()).toBe(10);
  });

  it("the allowance frees a day after the oldest call ended — no midnight — and re-arms the warning", async () => {
    const warns: string[] = [];
    const { rl, clock } = bench(limitsOf(100, 10_000), { ...mockLog, warn: (m: string) => warns.push(m) });
    let ran = 0;
    const call = (): Promise<boolean> =>
      rl.tryExecute(
        (): Promise<void> => {
          ran += 1;
          return Promise.resolve();
        },
        ACCOUNT_LIST_LANE,
        0,
        APPLIANCE,
      );
    await call();
    clock.advance(3_600_000);
    await call();
    await call();
    await call(); // refused, warns
    expect(ran).toBe(3);
    clock.advance(86_400_000 - 3_600_000 - 1);
    await call(); // the first call is a day old less 1 ms
    expect(ran).toBe(3);
    clock.advance(1);
    await call();
    expect(ran).toBe(4);
    await call(); // full again → warns once more
    expect(warns).toHaveLength(2);
  });
});

describe("RateLimiter — calls after stop()", () => {
  it("a tracked call queued AFTER stop() rejects instead of waiting forever", async () => {
    const { rl, fire } = bench(limitsOf(1, 100));
    await fire(); // fill the minute window
    rl.stop();
    await expect(rl.executeTracked(() => Promise.resolve())).rejects.toThrow("stopped");
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("a fire-and-queue call after stop() is dropped, not queued", async () => {
    const { rl, fire } = bench(limitsOf(1, 100));
    await fire();
    rl.stop();
    let ran = 0;
    expect(
      await rl.tryExecute(() => {
        ran++;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(ran).toBe(0);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });
});

describe("RateLimiter — lanes per Govee actor, the windows api-limits.json declares (issue #46, GV-08)", () => {
  // Govee's OpenAPI limits are per ACTOR: the device list per account per
  // minute, state/scenes per DEVICE per minute, control per device (burst 6,
  // two a second) and per account (burst 80, twelve a second). The 8/min global
  // window of 2.38.3 came from the v1 API and made eight bulbs drink from one
  // pot: the second half of a group switch waited for the next minute.
  const dev = (n: number): CallLane => ({ kind: "device-control", deviceKey: `H600D:BULB${n}` });
  const read = (n: number): CallLane => ({ kind: "device-read", deviceKey: `H600D:BULB${n}` });
  const APPAPI: CallLane = { kind: "appapi" };
  const LIST: CallLane = { kind: "account-list" };

  /**
   * The declared budget with the first counterpart of one lane replaced.
   *
   * @param kind The lane
   * @param c Its counterpart
   */
  const withLane = (kind: CallLane["kind"], c: Counterpart): CloudLimits => ({
    ...CLOUD_LIMITS,
    [kind]: [c, ...CLOUD_LIMITS[kind].slice(1)],
  });

  it("eight devices × two commands run at once — no device waits for another", async () => {
    const { ran, fire } = bench();
    for (let d = 1; d <= 8; d++) {
      await fire(dev(d));
      await fire(dev(d));
    }
    expect(ran()).toBe(16);
  });

  it("one device: six commands burst, the rest wait for the 3-s window — none is dropped", async () => {
    const { rl, clock, ran, fire, process } = bench();
    for (let i = 0; i < 10; i++) {
      await fire(dev(1));
    }
    expect(ran()).toBe(6);
    expect(rl.getUsageSnapshot().queueLength).toBe(4);
    clock.advance(2999);
    process();
    expect(ran()).toBe(6);
    clock.advance(1);
    process();
    expect(ran()).toBe(10);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("device reads: a device at its limit queues while another device runs", async () => {
    const { ran, fire } = bench();
    for (let i = 0; i < 21; i++) {
      await fire(read(1));
    }
    expect(ran()).toBe(20);
    await fire(read(2));
    expect(ran()).toBe(21);
  });

  it("a saturated App-API lane blocks no OpenAPI call — the libraries no longer stand in front of commands", async () => {
    const { ran, fire } = bench();
    for (let i = 0; i < 9; i++) {
      await fire(APPAPI);
    }
    expect(ran()).toBe(8);
    await fire(dev(1));
    await fire(read(1));
    await fire(LIST);
    expect(ran()).toBe(11);
  });

  it("the account-wide control window caps a burst across devices", async () => {
    const { ran, fire } = bench();
    for (let d = 1; d <= 14; d++) {
      for (let k = 0; k < 6; k++) {
        await fire(dev(d));
      }
    }
    expect(ran()).toBe(80);
  });

  it("the device list has its own account window", async () => {
    const { ran, fire } = bench();
    for (let i = 0; i < 21; i++) {
      await fire(LIST);
    }
    expect(ran()).toBe(20);
  });

  it("every OpenAPI lane books the daily window — the App API lane does not, Govee's day never pays for app2", async () => {
    const { rl, fire } = bench();
    await fire(APPAPI);
    await fire(LIST);
    await fire(read(1));
    await fire(dev(1));
    expect(rl.getUsageSnapshot().usedToday).toBe(3);
  });

  it("each window frees on its own and runs what waited for it", async () => {
    const { rl, clock, ran, fire, process } = bench(withLane("account-list", counterpart("test list", 1, 60)));
    await fire(LIST);
    await fire(LIST);
    for (let i = 0; i < 7; i++) {
      await fire(dev(1));
    }
    expect(ran()).toBe(7);
    clock.advance(3000); // the control window frees, the list window does not
    process();
    expect(ran()).toBe(8);
    clock.advance(57_000);
    process();
    expect(ran()).toBe(9);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("a call whose lane is free runs ahead of a queued call whose lane is not — no head-of-line blocking", async () => {
    const { rl, process } = bench(withLane("appapi", counterpart("test libraries", 1, 60)));
    await rl.tryExecute(() => Promise.resolve(), APPAPI);
    const order: string[] = [];
    // Both queue (app-api saturated; the read is queued explicitly), then the queue is processed.
    rl.enqueue(
      () => {
        order.push("appapi");
        return Promise.resolve();
      },
      APPAPI,
      2,
    );
    rl.enqueue(
      () => {
        order.push("read");
        return Promise.resolve();
      },
      read(1),
      2,
    );
    process();
    expect(order).toEqual(["read"]);
  });

  it("scenario issue #46: ten devices' start-up load plus sixteen commands — every command runs at once", async () => {
    const { ran, fire } = bench();
    for (let d = 1; d <= 10; d++) {
      await fire(read(d)); // state read
      await fire(read(d)); // scenes
      await fire(read(d)); // diy scenes
      for (let k = 0; k < 4; k++) {
        await fire(APPAPI); // libraries + features (shared per SKU since 2.39.0, worst case here)
      }
    }
    const before = ran();
    for (let d = 1; d <= 8; d++) {
      await fire(dev(d));
      await fire(dev(d));
    }
    expect(ran() - before).toBe(16);
  });

  it("the usage snapshot reports every window with its use", async () => {
    const { rl, fire } = bench();
    await fire(dev(1));
    await fire(read(1));
    await fire(APPAPI);
    await fire(LIST);
    const used = Object.fromEntries(rl.getUsageSnapshot().windows.map(w => [w.lane, [w.used, w.max, w.seconds]]));
    expect(used["Govee OpenAPI device list|0|account"]).toEqual([1, 20, 60]);
    expect(used["Govee App API libraries|0|account"]).toEqual([1, 8, 60]);
    expect(used["Govee OpenAPI device reads|0|device H600D:BULB1"]).toEqual([1, 20, 60]);
    expect(used["Govee OpenAPI device control|0|device H600D:BULB1"]).toEqual([1, 6, 3]);
    expect(used["Govee OpenAPI device control|1|account"]).toEqual([1, 80, 7]);
    expect(used["Govee OpenAPI (REST)|0|account"]).toEqual([3, 9000, 86_400]);
    // a window per device stands under its device only, never as an account window
    expect(Object.keys(used).sort()).toEqual(
      [
        "Govee App API libraries|0|account",
        "Govee OpenAPI (REST)|0|account",
        "Govee OpenAPI device control|0|device H600D:BULB1",
        "Govee OpenAPI device control|1|account",
        "Govee OpenAPI device list|0|account",
        "Govee OpenAPI device reads|0|device H600D:BULB1",
      ].sort(),
    );
  });

  it("a lane whose window is declared no more drops out of the report instead of breaking it", async () => {
    const { rl, fire } = bench({
      ...CLOUD_LIMITS,
      "device-read": [counterpart("old reads", 5, 60, "device"), CLOUD_LIMITS["device-read"][1]],
    });
    await fire(read(1));
    (rl as any).limits = CLOUD_LIMITS;
    const lanes = rl.getUsageSnapshot().windows.map(w => w.lane);
    expect(lanes).not.toContain("old reads|0|device H600D:BULB1");
    expect(lanes).toContain("Govee OpenAPI (REST)|0|account");
  });
});

describe("a spent daily window refuses, it does not queue (audit A10)", () => {
  function spentLimiter(): { rl: RateLimiter; warns: string[]; clock: ReturnType<typeof manualClock> } {
    const warns: string[] = [];
    const { rl, clock } = bench(limitsOf(100, 1), { ...mockLog, warn: (m: string) => warns.push(m) });
    return { rl, warns, clock };
  }

  it("a tracked command after the last call of the day is refused at once — not held for hours", async () => {
    const { rl } = spentLimiter();
    await rl.executeTracked(() => Promise.resolve());
    await expect(rl.executeTracked(() => Promise.resolve())).rejects.toThrow("Daily Govee Cloud budget is used up");
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("an appliance's call refused by the ACCOUNT's day names the daily ceiling, not the device's allowance", async () => {
    const { rl, warns } = spentLimiter();
    const budget = { key: "H7160:AA:BB", perDay: 50 };
    await rl.executeTracked(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, budget);
    await expect(rl.executeTracked(() => Promise.resolve(), ACCOUNT_LIST_LANE, 0, budget)).rejects.toThrow(
      "Daily Govee Cloud budget is used up",
    );
    expect(warns).toEqual([expect.stringContaining("daily ceiling")]);
  });

  it("tryExecute and enqueue queue nothing on a spent day", async () => {
    const { rl } = spentLimiter();
    await rl.tryExecute(() => Promise.resolve());
    expect(await rl.tryExecute(() => Promise.resolve())).toBe(false);
    let rejected = 0;
    expect(
      rl.enqueue(
        () => Promise.resolve(),
        ACCOUNT_LIST_LANE,
        1,
        () => rejected++,
      ),
    ).toBe(false);
    expect(rejected).toBe(1);
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("calls queued for a minute window are refused once the day runs out", async () => {
    const { rl, clock, process } = bench(limitsOf(1, 2));
    await rl.executeTracked(() => Promise.resolve()); // minute full, day 1/2
    const waiting = rl.executeTracked(() => Promise.resolve()); // queued for the minute
    const late = rl.executeTracked(() => Promise.resolve()); // queued too
    const refused = expect(late).rejects.toThrow("Daily Govee Cloud budget is used up");
    clock.advance(60_000);
    process(); // first waiter runs → day 2/2 → the second waiter is refused
    await waiting;
    await refused;
    expect(rl.getUsageSnapshot().queueLength).toBe(0);
  });

  it("warns once while the day is full, and again when it fills up next time", async () => {
    const { rl, warns, clock } = spentLimiter();
    await rl.executeTracked(() => Promise.resolve());
    await expect(rl.executeTracked(() => Promise.resolve())).rejects.toThrow();
    await expect(rl.executeTracked(() => Promise.resolve())).rejects.toThrow();
    expect(warns.filter(w => w.includes("daily ceiling"))).toHaveLength(1);
    clock.advance(86_400_000); // the call is a day old
    await rl.executeTracked(() => Promise.resolve());
    await expect(rl.executeTracked(() => Promise.resolve())).rejects.toThrow();
    expect(warns.filter(w => w.includes("daily ceiling"))).toHaveLength(2);
    rl.stop();
  });
});

describe("a call that never reached Govee is given back (issue #51)", () => {
  // The HTTP client reports each request to the booking of the call it runs in;
  // these executes do the same by hand. Most real callers (state reads, the
  // reachability refresh) swallow their own error — the limiter must see the
  // outcome anyway, which is why the report travels with the booking.
  const neverSent = async (): Promise<void> => {
    currentBooking()?.attempt(false);
    return Promise.resolve();
  };
  const delivered = async (): Promise<void> => {
    currentBooking()?.attempt(true);
    return Promise.resolve();
  };
  const READ: CallLane = { kind: "device-read", deviceKey: "H6097:AA" };
  const CONTROL: CallLane = { kind: "device-control", deviceKey: "H6097:AA" };
  const usedIn = (rl: RateLimiter, lane: string): number =>
    rl.getUsageSnapshot().windows.find(w => w.lane === lane)?.used ?? 0;
  const readsOf = (rl: RateLimiter): number => usedIn(rl, "Govee OpenAPI device reads|0|device H6097:AA");

  it("a swallowed DNS failure gives back the lane slot and the daily count, and the report counts it", async () => {
    const { rl } = bench();
    await rl.tryExecute(neverSent, READ);
    expect(readsOf(rl)).toBe(0);
    expect(rl.getUsageSnapshot().usedToday).toBe(0);
    expect(rl.getUsageSnapshot().notDeliveredToday).toBe(1);
  });

  it("a call that reached Govee keeps its booking", async () => {
    const { rl } = bench();
    await rl.tryExecute(delivered, READ);
    expect(readsOf(rl)).toBe(1);
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
    expect(rl.getUsageSnapshot().notDeliveredToday).toBe(0);
  });

  it("a call that made no request keeps its booking", async () => {
    const { rl } = bench();
    await rl.tryExecute(() => Promise.resolve(), READ);
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
  });

  it("one request through after a failed one: the booking stays", async () => {
    const { rl } = bench();
    await rl.tryExecute(async () => {
      currentBooking()?.attempt(false);
      currentBooking()?.attempt(true);
      return Promise.resolve();
    }, READ);
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
  });

  it("each lane gets its slot back: device list and app API", async () => {
    const { rl } = bench();
    await rl.tryExecute(neverSent, ACCOUNT_LIST_LANE);
    await rl.tryExecute(neverSent, { kind: "appapi" });
    expect(usedIn(rl, "Govee OpenAPI device list|0|account")).toBe(0);
    expect(usedIn(rl, "Govee App API libraries|0|account")).toBe(0);
  });

  it("control: six commands that never left free their slots — the seventh still goes at once", async () => {
    const { rl } = bench();
    for (let i = 0; i < 6; i++) {
      await rl.executeTracked(neverSent, CONTROL);
    }
    let ran = false;
    await rl.executeTracked(async () => {
      ran = true;
      return delivered();
    }, CONTROL);
    expect(ran).toBe(true);
    expect(usedIn(rl, "Govee OpenAPI device control|1|account")).toBe(1);
  });

  it("executeTracked: the failure still reaches the caller, the booking goes back", async () => {
    const { rl } = bench();
    await expect(
      rl.executeTracked(() => {
        currentBooking()?.attempt(false);
        return Promise.reject(new Error("getaddrinfo EAI_AGAIN"));
      }, CONTROL),
    ).rejects.toThrow("EAI_AGAIN");
    expect(rl.getUsageSnapshot().usedToday).toBe(0);
  });

  it("a queued call that never reached Govee is given back too", async () => {
    const { rl, clock, process } = bench({
      ...CLOUD_LIMITS,
      "device-read": [counterpart("test reads", 1, 60, "device"), CLOUD_LIMITS["device-read"][1]],
    });
    await rl.tryExecute(delivered, READ); // the window is full
    await rl.tryExecute(neverSent, READ); // queued
    expect(rl.getUsageSnapshot().queueLength).toBe(1);
    clock.advance(60_000);
    process(); // the waiter runs and fails
    await vi.waitFor(() => expect(rl.getUsageSnapshot().notDeliveredToday).toBe(1));
    expect(usedIn(rl, "test reads|0|device H6097:AA")).toBe(0);
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
  });

  it("an appliance at the end of its allowance: a DNS failure does not spend the last call", async () => {
    const { rl } = bench();
    const budget = { key: "H7127:AA", perDay: 2 };
    await rl.executeTracked(delivered, CONTROL, 0, budget);
    await rl.executeTracked(neverSent, CONTROL, 0, budget);
    let ran = false;
    await rl.executeTracked(
      async () => {
        ran = true;
        return delivered();
      },
      CONTROL,
      0,
      budget,
    );
    expect(ran).toBe(true);
    await expect(rl.executeTracked(delivered, CONTROL, 0, budget)).rejects.toThrow("Daily Govee budget");
  });

  it("a call given back frees only its own slots — a call booked while it was in flight keeps its count", async () => {
    const { rl, clock } = bench();
    let release!: () => void;
    const slow = rl.tryExecute(async () => {
      await new Promise<void>(resolve => (release = resolve));
      currentBooking()?.attempt(false);
    }, READ);
    await rl.tryExecute(delivered, READ); // booked while the first is in flight
    release();
    await slow;
    expect(readsOf(rl)).toBe(1);
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
    expect(rl.getUsageSnapshot().notDeliveredToday).toBe(1);
    // the slot left is the delivered call's, which counts down from its answer — not the open one given back
    clock.advance(60_000);
    expect(readsOf(rl)).toBe(0);
  });

  it("a leftover the call did not await cannot give the booking back after it settled", async () => {
    const { rl } = bench();
    let late!: () => void;
    await rl.tryExecute(() => {
      const booking = currentBooking();
      late = () => booking?.attempt(false);
      return Promise.resolve();
    }, READ);
    late();
    expect(rl.getUsageSnapshot().usedToday).toBe(1);
  });

  it("the report's given-back count slides over a day as well", async () => {
    const { rl, clock } = bench();
    await rl.tryExecute(neverSent, READ);
    clock.advance(86_399_999);
    expect(rl.getUsageSnapshot().notDeliveredToday).toBe(1);
    clock.advance(1);
    expect(rl.getUsageSnapshot().notDeliveredToday).toBe(0);
  });
});
