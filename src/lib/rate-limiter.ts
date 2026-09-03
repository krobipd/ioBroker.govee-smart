import { errMessage, type TimerAdapter } from "./types";

/** A queued API call */
interface QueuedCall {
  /** Function to execute */
  execute: () => Promise<void>;
  /** Priority (lower = higher priority) */
  priority: number;
  /**
   * Set for tracked calls (executeTracked): rejects the caller's promise when
   * the call is evicted from a full queue or the limiter stops before it ran.
   */
  reject?: (err: Error) => void;
}

/**
 * Upper bound for the call queue. The queue only grows while the Govee
 * budget is exhausted; without a cap a script hammering writable states
 * during a rate-limit window would let it grow without limit. 200 covers
 * every legitimate burst (startup scene-loads for dozens of devices) by a
 * wide margin — beyond that the calls are stale by the time they'd run.
 */
export const MAX_QUEUE_LENGTH = 200;

/**
 * A per-device daily allowance on top of the global budget.
 *
 * Govee's limits are not one budget: the account gets 10,000 calls a day, but
 * an APPLIANCE gets 100 for itself. The global counters cannot express that —
 * one appliance may spend the whole account budget, ninety times its own share.
 */
export interface DeviceBudget {
  /** Identifies the device, e.g. `sku:deviceId`. */
  key: string;
  /** Calls this device may make today. */
  perDay: number;
}

/**
 * Rate limiter for Govee Cloud API calls.
 * Respects per-minute and daily limits, queues excess calls.
 */
export class RateLimiter {
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private readonly queue: QueuedCall[] = [];
  private processTimer: ioBroker.Interval | undefined = undefined;
  private callsThisMinute = 0;
  private callsToday = 0;
  private minuteResetTimer: ioBroker.Interval | undefined = undefined;
  private dayResetTimer: ioBroker.Interval | undefined = undefined;
  private dayResetKickoff: ioBroker.Timeout | undefined = undefined;
  /**
   * True after `stop()`. Guards the dayResetKickoff callback so a stop() that
   * fires between kickoff-schedule and kickoff-execute can't leave behind a
   * runaway dayResetTimer interval — without this, a stop+restart cycle would
   * leak one interval per restart.
   */
  private stopped = false;
  /** Warn-once flag for the queue-full drop — reset when the queue drains. */
  private warnedQueueFull = false;
  /**
   * Calls spent per device today. Cleared with the daily counter, so it follows
   * the same reset Govee applies.
   */
  private readonly callsTodayPerDevice = new Map<string, number>();
  /**
   * Devices already warned about today. The message is actionable and belongs
   * in the log once, not on every rejected write — a script hitting the limit
   * hits it again a minute later.
   */
  private readonly warnedDeviceBudget = new Set<string>();

  /** Max calls per minute */
  private perMinuteLimit: number;
  /** Max calls per day (with safety buffer) */
  private perDayLimit: number;

  /**
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param perMinuteLimit Max calls per minute (default 8, safe margin from 10)
   * @param perDayLimit Max calls per day (default 9000, safe margin from 10000)
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter, perMinuteLimit = 8, perDayLimit = 9000) {
    this.log = log;
    this.timers = timers;
    this.perMinuteLimit = perMinuteLimit;
    this.perDayLimit = perDayLimit;
  }

  /** Start the rate limiter — resets counters periodically */
  start(): void {
    this.stopped = false;
    // Reset minute counter every 60s
    this.minuteResetTimer = this.timers.setInterval(() => {
      this.callsThisMinute = 0;
      this.processQueue();
    }, 60_000);

    // Reset daily counter aligned to UTC midnight — Govee's daily quota
    // resets on the API's clock (UTC). A plain setInterval(24h) starting
    // at adapter launch would drift the reset to a non-midnight offset and
    // waste quota: after 18:00 start you'd get a full budget until 18:00
    // next day even though Govee gives you a fresh budget at 00:00.
    const msUntilMidnight = this.millisUntilNextUtcMidnight();
    this.dayResetKickoff = this.timers.setTimeout(() => {
      this.dayResetKickoff = undefined;
      // stop() may have fired between schedule and execute — bail before
      // installing the recurring 24 h timer, which would otherwise leak.
      if (this.stopped) {
        return;
      }
      this.resetDaily();
      this.dayResetTimer = this.timers.setInterval(() => this.resetDaily(), 86_400_000);
    }, msUntilMidnight);

    // Process queue every 2s
    this.processTimer = this.timers.setInterval(() => {
      this.processQueue();
    }, 2_000);
  }

  /** Stop the rate limiter */
  stop(): void {
    this.stopped = true;
    if (this.minuteResetTimer) {
      this.timers.clearInterval(this.minuteResetTimer);
      this.minuteResetTimer = undefined;
    }
    if (this.dayResetKickoff) {
      this.timers.clearTimeout(this.dayResetKickoff);
      this.dayResetKickoff = undefined;
    }
    if (this.dayResetTimer) {
      this.timers.clearInterval(this.dayResetTimer);
      this.dayResetTimer = undefined;
    }
    if (this.processTimer) {
      this.timers.clearInterval(this.processTimer);
      this.processTimer = undefined;
    }
    // Reject pending TRACKED calls so no caller awaits a promise that can
    // never settle after stop (compact mode keeps the process alive —
    // a hanging await would leak its closure).
    for (const call of this.queue) {
      call.reject?.(new Error("Rate limiter stopped — queued Cloud call cancelled"));
    }
    this.queue.length = 0;
  }

  /** Zero the daily counter and log. Separate so kickoff + interval share it. */
  private resetDaily(): void {
    this.log.debug(
      `Rate limiter: daily reset (used ${this.callsToday} calls today, ${this.callsTodayPerDevice.size} device(s) tracked)`,
    );
    this.callsToday = 0;
    // The per-device allowances reset with the global one — Govee rolls both
    // over at the same time. The warn-once set goes too, so a device that hit
    // its limit yesterday says so again if it hits it today.
    this.callsTodayPerDevice.clear();
    this.warnedDeviceBudget.clear();
  }

  /** Milliseconds from now until the next UTC midnight tick. */
  private millisUntilNextUtcMidnight(): number {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    return next.getTime() - now.getTime();
  }

  /**
   * Enqueue an API call. It will be executed when rate limits allow.
   * The queue is capped at {@link MAX_QUEUE_LENGTH} — when full, the new
   * call is dropped (first drop per overflow episode warns, repeats stay
   * on debug so a hammering script can't spam the log).
   *
   * @param execute The API call to make
   * @param priority Lower = higher priority (0 = control, 1 = status, 2 = scenes)
   * @param reject Optional rejection callback, invoked if this queued call is later evicted to free a slot for a higher-priority one
   */
  enqueue(execute: () => Promise<void>, priority = 1, reject?: (err: Error) => void): boolean {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      // Queue full. The queue is sorted ascending, so the tail is the
      // lowest-priority call. Evict it in favour of the new call when the new
      // one outranks it — otherwise a fresh control command (prio 0) would be
      // dropped while stale scene loads (prio 2) keep their slots (L15).
      const tail = this.queue[this.queue.length - 1];
      if (!tail || tail.priority <= priority) {
        const msg = `Rate limiter queue full (${MAX_QUEUE_LENGTH}) — dropping new Cloud call (priority ${priority})`;
        if (this.warnedQueueFull) {
          this.log.debug(msg);
        } else {
          this.warnedQueueFull = true;
          this.log.warn(msg);
        }
        return false;
      }
      const evicted = this.queue.pop(); // evict the lowest-priority queued call to make room
      evicted?.reject?.(new Error("Cloud call evicted — rate-limiter queue full"));
    }
    this.queue.push({ execute, priority, reject });
    // Sort by priority (lower first)
    this.queue.sort((a, b) => a.priority - b.priority);
    return true;
  }

  /**
   * Execute immediately if within limits, otherwise queue.
   * Returns true if executed immediately.
   *
   * @param execute The API call to make
   * @param priority Call priority
   * @param budget The device's own daily allowance, when one applies
   */
  async tryExecute(execute: () => Promise<void>, priority = 0, budget?: DeviceBudget): Promise<boolean> {
    if (budget && this.deviceBudgetSpent(budget)) {
      return false;
    }
    if (this.canMakeCall()) {
      this.spend(budget);
      await execute();
      return true;
    }
    this.enqueue(execute, priority);
    return false;
  }

  /**
   * Whether this device has used up its own daily allowance — and if so, say so
   * once. An exhausted device budget does NOT queue the call: the allowance
   * resets at Govee's daily rollover, not in a few seconds, so queuing would
   * only hold a write that is hours from running and then apply it at a moment
   * nobody asked for.
   *
   * @param budget The device's allowance
   * @returns true when the call must not be made
   */
  private deviceBudgetSpent(budget: DeviceBudget): boolean {
    const used = this.callsTodayPerDevice.get(budget.key) ?? 0;
    if (used < budget.perDay) {
      return false;
    }
    if (!this.warnedDeviceBudget.has(budget.key)) {
      this.warnedDeviceBudget.add(budget.key);
      this.log.warn(
        `Device ${budget.key} has used its daily Govee budget (${budget.perDay} calls). Govee allows an appliance ` +
          `100 calls per day and appliance control has no local path, so every write counts. Further commands for ` +
          `this device are skipped until Govee's daily reset — reduce how often a script writes to it.`,
      );
    }
    return true;
  }

  /**
   * Book one call against the global counters and, where one applies, the
   * device's own allowance.
   *
   * @param budget The device's allowance, when the call belongs to one
   */
  private spend(budget?: DeviceBudget): void {
    this.callsThisMinute++;
    this.callsToday++;
    if (budget) {
      this.callsTodayPerDevice.set(budget.key, (this.callsTodayPerDevice.get(budget.key) ?? 0) + 1);
    }
  }

  /**
   * Execute within the budget and settle when the call ACTUALLY ran —
   * including when it had to queue. User commands need this coupling:
   * tryExecute resolves on enqueue, the caller acks the state, and a later
   * queue failure would be invisible to the user (M3). Loaders keep
   * tryExecute (fire-and-queue is fine for background data).
   *
   * Rejects with the call's error, or with a queue-drop error when the
   * capped queue evicts the call before it ever ran.
   *
   * @param execute The API call to make
   * @param priority Call priority (0 = control)
   * @param budget The device's own daily allowance, when one applies
   */
  async executeTracked(execute: () => Promise<void>, priority = 0, budget?: DeviceBudget): Promise<void> {
    if (budget && this.deviceBudgetSpent(budget)) {
      throw new Error(`Daily Govee budget for ${budget.key} is used up (${budget.perDay} calls)`);
    }
    if (this.canMakeCall()) {
      this.spend(budget);
      await execute();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const accepted = this.enqueue(
        async () => {
          try {
            await execute();
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        priority,
        reject,
      );
      if (!accepted) {
        reject(new Error("Cloud call dropped — rate-limiter queue full"));
      }
    });
  }

  /** Whether a call can be made right now */
  canMakeCall(): boolean {
    return this.callsThisMinute < this.perMinuteLimit && this.callsToday < this.perDayLimit;
  }

  /**
   * Snapshot of usage + limits for the diag runtime-state export. Returns
   * plain values so the DiagnosticsCollector can clone-and-cap safely.
   * Plus `queueLength` for "Cloud calls piling up?" forensics.
   */
  getUsageSnapshot(): {
    usedToday: number;
    usedThisMinute: number;
    dailyLimit: number;
    perMinuteLimit: number;
    queueLength: number;
  } {
    return {
      usedToday: this.callsToday,
      usedThisMinute: this.callsThisMinute,
      dailyLimit: this.perDayLimit,
      perMinuteLimit: this.perMinuteLimit,
      queueLength: this.queue.length,
    };
  }

  /** Process queued calls */
  private processQueue(): void {
    if (this.stopped) {
      return;
    }
    while (this.queue.length > 0 && this.canMakeCall()) {
      const call = this.queue.shift();
      if (call) {
        this.callsThisMinute++;
        this.callsToday++;
        call.execute().catch(err => {
          this.log.debug(`Queued call failed: ${errMessage(err)}`);
        });
      }
    }
    if (this.queue.length === 0) {
      // Queue drained — the next overflow episode warns again.
      this.warnedQueueFull = false;
    }
  }
}
