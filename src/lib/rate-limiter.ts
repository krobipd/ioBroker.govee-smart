import type { TimerAdapter } from "./types.js";

/** A queued API call */
interface QueuedCall {
  /** Function to execute */
  execute: () => Promise<void>;
  /** Priority (lower = higher priority) */
  priority: number;
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
  constructor(
    log: ioBroker.Logger,
    timers: TimerAdapter,
    perMinuteLimit = 8,
    perDayLimit = 9000,
  ) {
    this.log = log;
    this.timers = timers;
    this.perMinuteLimit = perMinuteLimit;
    this.perDayLimit = perDayLimit;
  }

  /**
   * Update rate limits dynamically (e.g. when sibling adapter starts/stops).
   *
   * @param perMinuteLimit Max calls per minute
   * @param perDayLimit Max calls per day
   */
  updateLimits(perMinuteLimit: number, perDayLimit: number): void {
    this.perMinuteLimit = perMinuteLimit;
    this.perDayLimit = perDayLimit;
  }

  /** Start the rate limiter — resets counters periodically */
  start(): void {
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
      this.resetDaily();
      this.dayResetTimer = this.timers.setInterval(
        () => this.resetDaily(),
        86_400_000,
      );
    }, msUntilMidnight);

    // Process queue every 2s
    this.processTimer = this.timers.setInterval(() => {
      this.processQueue();
    }, 2_000);
  }

  /** Stop the rate limiter */
  stop(): void {
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
    this.log.debug(
      `Rate limiter: daily reset (used ${this.callsToday} calls today)`,
    );
    this.callsToday = 0;
  }

  /** Milliseconds from now until the next UTC midnight tick. */
  private millisUntilNextUtcMidnight(): number {
    const now = new Date();
    const next = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    return next.getTime() - now.getTime();
  }

  /**
   * Enqueue an API call. It will be executed when rate limits allow.
   *
   * @param execute The API call to make
   * @param priority Lower = higher priority (0 = control, 1 = status, 2 = scenes)
   */
  enqueue(execute: () => Promise<void>, priority = 1): void {
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
  async tryExecute(
    execute: () => Promise<void>,
    priority = 0,
  ): Promise<boolean> {
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
    return (
      this.callsThisMinute < this.perMinuteLimit &&
      this.callsToday < this.perDayLimit
    );
  }

  /** Current daily usage */
  get dailyUsage(): number {
    return this.callsToday;
  }

  /** Process queued calls */
  private processQueue(): void {
    while (this.queue.length > 0 && this.canMakeCall()) {
      const call = this.queue.shift();
      if (call) {
        this.callsThisMinute++;
        this.callsToday++;
        call.execute().catch((err) => {
          this.log.debug(
            `Queued call failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }
  }
}
