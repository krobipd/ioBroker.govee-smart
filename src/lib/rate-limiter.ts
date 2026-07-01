import { errMessage, type TimerAdapter } from "./types";

/** A queued API call */
interface QueuedCall {
  /** Function to execute */
  execute: () => Promise<void>;
  /** Priority (lower = higher priority) */
  priority: number;
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
    this.queue.length = 0;
  }

  /** Zero the daily counter and log. Separate so kickoff + interval share it. */
  private resetDaily(): void {
    this.log.debug(`Rate limiter: daily reset (used ${this.callsToday} calls today)`);
    this.callsToday = 0;
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
   */
  enqueue(execute: () => Promise<void>, priority = 1): void {
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
        return;
      }
      this.queue.pop(); // evict the lowest-priority queued call to make room
    }
    this.queue.push({ execute, priority });
    // Sort by priority (lower first)
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Execute immediately if within limits, otherwise queue.
   * Returns true if executed immediately.
   *
   * @param execute The API call to make
   * @param priority Call priority
   */
  async tryExecute(execute: () => Promise<void>, priority = 0): Promise<boolean> {
    if (this.canMakeCall()) {
      this.callsThisMinute++;
      this.callsToday++;
      await execute();
      return true;
    }
    this.enqueue(execute, priority);
    return false;
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
