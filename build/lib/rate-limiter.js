"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var rate_limiter_exports = {};
__export(rate_limiter_exports, {
  RateLimiter: () => RateLimiter
});
module.exports = __toCommonJS(rate_limiter_exports);
class RateLimiter {
  log;
  timers;
  queue = [];
  processTimer = void 0;
  callsThisMinute = 0;
  callsToday = 0;
  minuteResetTimer = void 0;
  dayResetTimer = void 0;
  dayResetKickoff = void 0;
  /** Max calls per minute */
  perMinuteLimit;
  /** Max calls per day (with safety buffer) */
  perDayLimit;
  /**
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param perMinuteLimit Max calls per minute (default 8, safe margin from 10)
   * @param perDayLimit Max calls per day (default 9000, safe margin from 10000)
   */
  constructor(log, timers, perMinuteLimit = 8, perDayLimit = 9e3) {
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
  updateLimits(perMinuteLimit, perDayLimit) {
    this.perMinuteLimit = perMinuteLimit;
    this.perDayLimit = perDayLimit;
  }
  /** Start the rate limiter — resets counters periodically */
  start() {
    this.minuteResetTimer = this.timers.setInterval(() => {
      this.callsThisMinute = 0;
      this.processQueue();
    }, 6e4);
    const msUntilMidnight = this.millisUntilNextUtcMidnight();
    this.dayResetKickoff = this.timers.setTimeout(() => {
      this.resetDaily();
      this.dayResetTimer = this.timers.setInterval(
        () => this.resetDaily(),
        864e5
      );
    }, msUntilMidnight);
    this.processTimer = this.timers.setInterval(() => {
      this.processQueue();
    }, 2e3);
  }
  /** Stop the rate limiter */
  stop() {
    if (this.minuteResetTimer) {
      this.timers.clearInterval(this.minuteResetTimer);
      this.minuteResetTimer = void 0;
    }
    if (this.dayResetKickoff) {
      this.timers.clearTimeout(this.dayResetKickoff);
      this.dayResetKickoff = void 0;
    }
    if (this.dayResetTimer) {
      this.timers.clearInterval(this.dayResetTimer);
      this.dayResetTimer = void 0;
    }
    if (this.processTimer) {
      this.timers.clearInterval(this.processTimer);
      this.processTimer = void 0;
    }
    this.queue.length = 0;
  }
  /** Zero the daily counter and log. Separate so kickoff + interval share it. */
  resetDaily() {
    this.log.debug(
      `Rate limiter: daily reset (used ${this.callsToday} calls today)`
    );
    this.callsToday = 0;
  }
  /** Milliseconds from now until the next UTC midnight tick. */
  millisUntilNextUtcMidnight() {
    const now = /* @__PURE__ */ new Date();
    const next = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0
      )
    );
    return next.getTime() - now.getTime();
  }
  /**
   * Enqueue an API call. It will be executed when rate limits allow.
   *
   * @param execute The API call to make
   * @param priority Lower = higher priority (0 = control, 1 = status, 2 = scenes)
   */
  enqueue(execute, priority = 1) {
    this.queue.push({ execute, priority });
    this.queue.sort((a, b) => a.priority - b.priority);
  }
  /**
   * Execute immediately if within limits, otherwise queue.
   * Returns true if executed immediately.
   *
   * @param execute The API call to make
   * @param priority Call priority
   */
  async tryExecute(execute, priority = 0) {
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
  canMakeCall() {
    return this.callsThisMinute < this.perMinuteLimit && this.callsToday < this.perDayLimit;
  }
  /** Current daily usage */
  get dailyUsage() {
    return this.callsToday;
  }
  /** Process queued calls */
  processQueue() {
    while (this.queue.length > 0 && this.canMakeCall()) {
      const call = this.queue.shift();
      if (call) {
        this.callsThisMinute++;
        this.callsToday++;
        call.execute().catch((err) => {
          this.log.debug(
            `Queued call failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RateLimiter
});
//# sourceMappingURL=rate-limiter.js.map
