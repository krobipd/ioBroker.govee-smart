import { MAX_QUEUE_LENGTH, RateLimiter } from "./rate-limiter";

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
function makeCapturingTimers() {
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

    await rl.tryExecute(async () => {
      called++;
    });
    await rl.tryExecute(async () => {
      called++;
    });
    await rl.tryExecute(async () => {
      called++;
    });

    expect(called).toBe(3);
    expect(rl.getUsageSnapshot().usedToday).toBe(3);
  });

  it("should queue calls when minute limit exceeded", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 2, 100);
    let called = 0;

    await rl.tryExecute(async () => {
      called++;
    }); // 1 — ok
    await rl.tryExecute(async () => {
      called++;
    }); // 2 — ok
    const queued = await rl.tryExecute(async () => {
      called++;
    }); // 3 — queued

    expect(called).toBe(2);
    expect(queued).toBe(false);
  });

  it("should respect daily limit", async () => {
    const rl = new RateLimiter(mockLog, mockTimers, 100, 2);
    let called = 0;

    await rl.tryExecute(async () => {
      called++;
    }); // ok
    await rl.tryExecute(async () => {
      called++;
    }); // ok
    const queued = await rl.tryExecute(async () => {
      called++;
    }); // queued

    expect(called).toBe(2);
    expect(queued).toBe(false);
    expect(rl.getUsageSnapshot().usedToday).toBe(2);
  });

  it("should enqueue with priority sorting", () => {
    const rl = new RateLimiter(mockLog, mockTimers, 0, 100); // minute limit 0 = all queued
    const order: number[] = [];

    rl.enqueue(async () => {
      order.push(2);
    }, 2); // low priority
    rl.enqueue(async () => {
      order.push(0);
    }, 0); // high priority
    rl.enqueue(async () => {
      order.push(1);
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
      await rl.executeTracked(async () => {
        ran++;
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
      const tracked = rl.executeTracked(async () => {
        ran++;
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
    const inc = async (): Promise<void> => {
      ran++;
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
    rl.enqueue(async () => {
      ran++;
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
