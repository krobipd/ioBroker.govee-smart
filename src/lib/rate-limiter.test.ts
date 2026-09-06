import { MAX_QUEUE_LENGTH, RateLimiter } from "./rate-limiter";
import type { TimerAdapter } from "./types";

const mockLog: ioBroker.Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
};

/** Mock timer adapter that doesn't actually schedule */
const mockTimers = {
  setInterval: () => ({}) as ioBroker.Interval,
  clearInterval: () => {},
  setTimeout: () => ({}) as ioBroker.Timeout,
  clearTimeout: () => {},
  delay: () => Promise.resolve(),
};

/** Timer adapter that captures scheduled callbacks so a test can fire them. */
function makeCapturingTimers(): {
  timers: TimerAdapter;
  intervals: Array<() => void>;
  timeouts: Array<() => void>;
  clears: () => number;
} {
  const intervals: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  let clears = 0;
  const timers = {
    setInterval: (cb: () => void) => {
      intervals.push(cb);
      return intervals.length;
    },
    clearInterval: () => {
      clears++;
    },
    setTimeout: (cb: () => void) => {
      timeouts.push(cb);
      return timeouts.length;
    },
    clearTimeout: () => {
      clears++;
    },
    delay: () => Promise.resolve(),
  } as never;
  return { timers, intervals, timeouts, clears: () => clears };
}

describe("RateLimiter", () => {
  it("should allow calls within limits", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 5, 100);
    expect(rl.canMakeCall()).toBe(true);
  });

  it("should track daily usage", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 10, 100);
    let called = 0;

    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    });
    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    });
    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    });

    expect(called).toBe(3);
    expect(rl.getUsageSnapshot().usedToday).toBe(3);
  });

  it("should queue calls when minute limit exceeded", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 2, 100);
    let called = 0;

    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // 1 — ok
    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // 2 — ok
    const queued = await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // 3 — queued

    expect(called).toBe(2);
    expect(queued).toBe(false);
  });

  it("should respect daily limit", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 100, 2);
    let called = 0;

    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // ok
    await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // ok
    const queued = await rl.tryExecute(() => {
      called++;
      return Promise.resolve();
    }); // queued

    expect(called).toBe(2);
    expect(queued).toBe(false);
    expect(rl.getUsageSnapshot().usedToday).toBe(2);
  });

  it("should enqueue with priority sorting", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 0, 100); // minute limit 0 = all queued
    const order: number[] = [];

    rl.enqueue(() => {
      order.push(2);
      return Promise.resolve();
    }, 2); // low priority
    rl.enqueue(() => {
      order.push(0);
      return Promise.resolve();
    }, 0); // high priority
    rl.enqueue(() => {
      order.push(1);
      return Promise.resolve();
    }, 1); // medium priority

    // Access internal queue to verify order
    const queue = (rl as any).queue;
    expect(queue).toHaveLength(3);
    expect(queue[0].priority).toBe(0);
    expect(queue[1].priority).toBe(1);
    expect(queue[2].priority).toBe(2);
  });

  it("evicts the lowest-priority queued call for a higher-priority one when full (L15)", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 0, 100_000); // minute limit 0 → all queue
    for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
      rl.enqueue(async () => {}, 2); // fill with low-priority (scene) calls
    }
    const queue = (rl as any).queue as Array<{ priority: number }>;
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH);
    expect(queue.every(e => e.priority === 2)).toBe(true);

    // A fresh high-priority (0 = control) call must get in, evicting a prio-2 tail.
    rl.enqueue(async () => {}, 0);
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH); // still capped
    expect(queue[0].priority).toBe(0); // high-priority call is at the head
    expect(queue.filter(e => e.priority === 2)).toHaveLength(MAX_QUEUE_LENGTH - 1); // one evicted

    // A fresh low-priority (2) call when full is still dropped (doesn't outrank the tail).
    rl.enqueue(async () => {}, 2);
    expect(queue).toHaveLength(MAX_QUEUE_LENGTH);
    expect(queue.filter(e => e.priority === 0)).toHaveLength(1); // unchanged
  });

  it("should clear queue on stop", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 0, 100);

    rl.enqueue(async () => {}, 1);
    rl.enqueue(async () => {}, 2);
    expect((rl as any).queue).toHaveLength(2);

    rl.stop();
    expect((rl as any).queue).toHaveLength(0);
  });

  it("should return true when executed immediately", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 10, 100);
    const result = await rl.tryExecute(async () => {});
    expect(result).toBe(true);
  });

  describe("executeTracked (M3 — user commands couple to the ACTUAL execution)", () => {
    it("runs immediately within budget and propagates an immediate failure", async () => {
      const rl = new RateLimiter(mockLog, mockTimers, 10, 100);
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
      const rl = new RateLimiter(mockLog, mockTimers, 1, 100);
      await rl.tryExecute(async () => {}); // burn the minute budget
      let ran = 0;
      const tracked = rl.executeTracked(() => {
        ran++;
        return Promise.resolve();
      });
      expect(ran).toBe(0); // queued, not run
      (rl as any).callsThisMinute = 0; // minute reset
      (rl as any).processQueue();
      await tracked;
      expect(ran).toBe(1);
    });

    it("rejects when the QUEUED call eventually fails — before M3 this was a debug line after the ack", async () => {
      const rl = new RateLimiter(mockLog, mockTimers, 1, 100);
      await rl.tryExecute(async () => {}); // burn the minute budget
      const tracked = rl.executeTracked(async () => Promise.reject(new Error("late 429")));
      (rl as any).callsThisMinute = 0;
      (rl as any).processQueue();
      await expect(tracked).rejects.toThrow("late 429");
    });

    it("rejects when the tracked call is evicted from a full queue", async () => {
      const rl = new RateLimiter(mockLog, mockTimers, 0, 100_000); // all queue
      for (let i = 0; i < MAX_QUEUE_LENGTH - 1; i++) {
        rl.enqueue(async () => {}, 2);
      }
      const evictable = rl.executeTracked(async () => {}, 2); // tracked tail
      const incoming = rl.executeTracked(async () => {}, 0); // outranks → evicts the tail
      await expect(evictable).rejects.toThrow("evicted");
      // the incoming call itself stays queued (never settles here) — detach it
      void incoming.catch(() => undefined);
    });

    it("rejects pending tracked calls on stop() instead of hanging forever", async () => {
      const rl = new RateLimiter(mockLog, mockTimers, 0, 100); // all queue
      const tracked = rl.executeTracked(async () => {}, 0);
      rl.stop();
      await expect(tracked).rejects.toThrow("stopped");
    });

    it("rejects immediately when a full queue drops the call", async () => {
      const rl = new RateLimiter(mockLog, mockTimers, 0, 100_000);
      for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
        rl.enqueue(async () => {}, 0); // full with top-priority calls
      }
      await expect(rl.executeTracked(async () => {}, 2)).rejects.toThrow("queue full");
    });
  });

  it("should track both minute and daily counters", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 5, 100);

    await rl.tryExecute(async () => {});
    await rl.tryExecute(async () => {});

    expect((rl as any).callsThisMinute).toBe(2);
    expect(rl.getUsageSnapshot().usedToday).toBe(2);
  });

  it("should block when both limits are independently exceeded", async () => {
    // Daily limit reached first
    const rl = new RateLimiter(mockLog, mockTimers, 100, 1);
    await rl.tryExecute(async () => {});
    expect(rl.canMakeCall()).toBe(false);
  });
});

describe("RateLimiter — timer-driven behaviour", () => {
  it("schedules the reset + process timers on start and clears them on stop", () => {
    const t = makeCapturingTimers();
    const rl = new RateLimiter(mockLog, t.timers, 5, 100);
    rl.start();
    expect(t.intervals).toHaveLength(2); // minute-reset (60s) + queue-process (2s)
    expect(t.timeouts).toHaveLength(1); // day-reset kickoff (aligned to UTC midnight)
    rl.stop();
    expect(t.clears()).toBeGreaterThanOrEqual(3); // both intervals + the kickoff timeout
  });

  it("drains the queue when the minute counter resets", async () => {
    const t = makeCapturingTimers();
    const rl = new RateLimiter(mockLog, t.timers, 1, 100);
    rl.start();
    let ran = 0;
    const inc = (): Promise<void> => {
      ran++;
      return Promise.resolve();
    };
    await rl.tryExecute(inc); // 1 — immediate
    await rl.tryExecute(inc); // 2 — queued (minute limit 1)
    expect(ran).toBe(1);
    t.intervals[0](); // fire minute-reset → counter 0 + processQueue drains the queue
    await Promise.resolve();
    expect(ran).toBe(2);
  });

  it("daily kickoff zeroes the counter and installs the recurring 24h interval", () => {
    const t = makeCapturingTimers();
    const rl = new RateLimiter(mockLog, t.timers, 100, 100);
    rl.start();
    (rl as any).callsToday = 42;
    expect(t.intervals).toHaveLength(2);
    t.timeouts[0](); // fire the day-reset kickoff
    expect((rl as any).callsToday).toBe(0);
    expect(t.intervals).toHaveLength(3); // + the recurring 24h reset interval
  });

  it("does NOT install the 24h interval if stopped before the kickoff fires (leak guard)", () => {
    const t = makeCapturingTimers();
    const rl = new RateLimiter(mockLog, t.timers, 100, 100);
    rl.start();
    rl.stop();
    t.timeouts[0](); // stale kickoff fires after stop
    expect(t.intervals).toHaveLength(2); // no 3rd recurring interval — the stopped-guard held
  });

  it("processQueue is a no-op after stop (and the queue is cleared)", async () => {
    const t = makeCapturingTimers();
    const rl = new RateLimiter(mockLog, t.timers, 0, 100); // limit 0 → everything queues
    let ran = 0;
    rl.enqueue(() => {
      ran++;
      return Promise.resolve();
    });
    rl.start();
    rl.stop();
    t.intervals.forEach(cb => cb());
    await Promise.resolve();
    expect(ran).toBe(0);
  });

  it("millisUntilNextUtcMidnight is within (0, 24h]", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 5, 100);
    const ms = (rl as any).millisUntilNextUtcMidnight();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(86_400_000);
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
    const rl = new RateLimiter(log, mockTimers, 0, 100); // limit 0 → everything queues
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

  it("a drained queue re-arms the overflow warning for the next episode", async () => {
    const warns: string[] = [];
    const log = { ...mockLog, warn: (m: string) => warns.push(m) } as ioBroker.Logger;
    const t = makeCapturingTimers();
    const rl = new RateLimiter(log, t.timers, 300, 1000);
    rl.start();
    for (let i = 0; i < 200; i++) {
      rl.enqueue(async () => {});
    }
    rl.enqueue(async () => {}); // overflow #1 → warn
    expect(warns).toHaveLength(1);
    t.intervals[1](); // queue-process tick drains everything (budget 300)
    await Promise.resolve();
    expect((rl as any).queue).toHaveLength(0);
    for (let i = 0; i < 201; i++) {
      rl.enqueue(async () => {}); // overflow #2 → warns again
    }
    expect(warns).toHaveLength(2);
    rl.stop();
  });
});

describe("per-device daily budget", () => {
  // Govee's limits are not one budget: the account gets 10,000 calls a day, but
  // an APPLIANCE gets 100 for itself — and appliance control has no local path,
  // so every write is a cloud call. The global counters cannot express that.
  const APPLIANCE = { key: "H7160:AA:BB", perDay: 3 };

  it("stops a device once it has spent its own allowance, while the global budget is untouched", async () => {
    const limiter = new RateLimiter(mockLog, mockTimers, 100, 10_000);
    let ran = 0;
    const call = (): Promise<boolean> =>
      limiter.tryExecute(
        (): Promise<void> => {
          ran += 1;
          return Promise.resolve();
        },
        0,
        APPLIANCE,
      );
    for (let i = 0; i < 5; i++) {
      await call();
    }
    expect(ran).toBe(3);
    // The global budget still has room — this is the device's own limit biting.
    expect(limiter.getUsageSnapshot().usedToday).toBe(3);
  });

  it("does not queue an exhausted device — the allowance resets in hours, not seconds", async () => {
    // Queuing would hold the write until Govee's daily rollover and then apply
    // it at a moment nobody asked for.
    const limiter = new RateLimiter(mockLog, mockTimers, 100, 10_000);
    for (let i = 0; i < 3; i++) {
      await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    }
    const accepted = await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    expect(accepted).toBe(false);
    expect(limiter.getUsageSnapshot().queueLength).toBe(0);
  });

  it("a tracked call rejects rather than silently doing nothing", async () => {
    // User commands must not ack as if they had run.
    const limiter = new RateLimiter(mockLog, mockTimers, 100, 10_000);
    for (let i = 0; i < 3; i++) {
      await limiter.executeTracked(() => Promise.resolve(), 0, APPLIANCE);
    }
    await expect(limiter.executeTracked(() => Promise.resolve(), 0, APPLIANCE)).rejects.toThrow(/budget/i);
  });

  it("warns once per device, not on every rejected write", async () => {
    const warns: string[] = [];
    const limiter = new RateLimiter({ ...mockLog, warn: (m: string) => warns.push(m) }, mockTimers, 100, 10_000);
    for (let i = 0; i < 8; i++) {
      await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("H7160:AA:BB");
  });

  it("budgets are per device — a second appliance is unaffected", async () => {
    const limiter = new RateLimiter(mockLog, mockTimers, 100, 10_000);
    let other = 0;
    for (let i = 0; i < 5; i++) {
      await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    }
    await limiter.tryExecute(
      () => {
        other += 1;
        return Promise.resolve();
      },
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
    const limiter = new RateLimiter(mockLog, mockTimers, 0, 10_000); // minute limit 0 → everything queues
    let ran = 0;
    for (let i = 0; i < 3; i++) {
      await limiter.tryExecute(
        () => {
          ran += 1;
          return Promise.resolve();
        },
        0,
        APPLIANCE,
      );
    }
    expect(limiter.getUsageSnapshot().queueLength).toBe(3);
    // Give the queue room and drain it.
    (limiter as unknown as { perMinuteLimit: number }).perMinuteLimit = 100;
    (limiter as unknown as { processQueue: () => void }).processQueue();
    await Promise.resolve();
    expect(ran).toBe(3);
    expect(limiter.getUsageSnapshot().usedToday).toBe(3);
    // Booked — so the very next call for this device is refused.
    const accepted = await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    expect(accepted).toBe(false);
  });

  it("a queued call is dropped when immediate calls spent the allowance while it waited", async () => {
    const limiter = new RateLimiter(mockLog, mockTimers, 1, 10_000);
    let queuedRan = 0;
    // First call runs immediately (minute limit 1), the second queues.
    await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    await limiter.tryExecute(
      () => {
        queuedRan += 1;
        return Promise.resolve();
      },
      0,
      APPLIANCE,
    );
    expect(limiter.getUsageSnapshot().queueLength).toBe(1);
    // Two more immediate calls exhaust the allowance of 3 before the queue runs.
    (limiter as unknown as { callsThisMinute: number }).callsThisMinute = 0;
    await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    (limiter as unknown as { callsThisMinute: number }).callsThisMinute = 0;
    await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    (limiter as unknown as { callsThisMinute: number }).callsThisMinute = 0;
    (limiter as unknown as { processQueue: () => void }).processQueue();
    await Promise.resolve();
    expect(queuedRan, "the queued call must not overrun the device's day").toBe(0);
  });

  it("a queued TRACKED call rejects instead of hanging when the allowance ran out meanwhile", async () => {
    const limiter = new RateLimiter(mockLog, mockTimers, 1, 10_000);
    await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    const tracked = limiter.executeTracked(() => Promise.resolve(), 0, APPLIANCE);
    // Spend the rest of the allowance while the tracked call sits in the queue.
    for (let i = 0; i < 2; i++) {
      (limiter as unknown as { callsThisMinute: number }).callsThisMinute = 0;
      await limiter.tryExecute(() => Promise.resolve(), 0, APPLIANCE);
    }
    (limiter as unknown as { callsThisMinute: number }).callsThisMinute = 0;
    (limiter as unknown as { processQueue: () => void }).processQueue();
    await expect(tracked).rejects.toThrow(/budget/i);
  });

  it("a call without a budget is never blocked by one", async () => {
    // Lights keep the global budget: their writes go over the LAN and the rare
    // cloud fallback is covered by the account limit.
    const limiter = new RateLimiter(mockLog, mockTimers, 100, 10_000);
    let ran = 0;
    for (let i = 0; i < 10; i++) {
      await limiter.tryExecute(() => {
        ran += 1;
        return Promise.resolve();
      });
    }
    expect(ran).toBe(10);
  });

  it("the daily reset frees the device allowance and re-arms the warning", async () => {
    const warns: string[] = [];
    const { timers, timeouts } = makeCapturingTimers();
    const limiter = new RateLimiter({ ...mockLog, warn: (m: string) => warns.push(m) }, timers, 100, 10_000);
    limiter.start();
    let ran = 0;
    const call = (): Promise<boolean> =>
      limiter.tryExecute(
        (): Promise<void> => {
          ran += 1;
          return Promise.resolve();
        },
        0,
        APPLIANCE,
      );
    for (let i = 0; i < 5; i++) {
      await call();
    }
    expect(ran).toBe(3);
    // The daily reset is armed as a one-shot aligned to UTC midnight, which
    // then installs the recurring interval — firing that kickoff performs the
    // first reset.
    timeouts[0]();
    await call();
    expect(ran).toBe(4);
    for (let i = 0; i < 5; i++) {
      await call();
    }
    expect(warns).toHaveLength(2);
    limiter.stop();
  });
});
