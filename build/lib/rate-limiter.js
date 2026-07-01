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
  MAX_QUEUE_LENGTH: () => MAX_QUEUE_LENGTH,
  RateLimiter: () => RateLimiter
});
module.exports = __toCommonJS(rate_limiter_exports);
var import_types = require("./types");
const MAX_QUEUE_LENGTH = 200;
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
  /**
   * True after `stop()`. Guards the dayResetKickoff callback so a stop() that
   * fires between kickoff-schedule and kickoff-execute can't leave behind a
   * runaway dayResetTimer interval — without this, a stop+restart cycle would
   * leak one interval per restart.
   */
  stopped = false;
  /** Warn-once flag for the queue-full drop — reset when the queue drains. */
  warnedQueueFull = false;
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
  /** Start the rate limiter — resets counters periodically */
  start() {
    this.stopped = false;
    this.minuteResetTimer = this.timers.setInterval(() => {
      this.callsThisMinute = 0;
      this.processQueue();
    }, 6e4);
    const msUntilMidnight = this.millisUntilNextUtcMidnight();
    this.dayResetKickoff = this.timers.setTimeout(() => {
      this.dayResetKickoff = void 0;
      if (this.stopped) {
        return;
      }
      this.resetDaily();
      this.dayResetTimer = this.timers.setInterval(() => this.resetDaily(), 864e5);
    }, msUntilMidnight);
    this.processTimer = this.timers.setInterval(() => {
      this.processQueue();
    }, 2e3);
  }
  /** Stop the rate limiter */
  stop() {
    this.stopped = true;
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
    this.log.debug(`Rate limiter: daily reset (used ${this.callsToday} calls today)`);
    this.callsToday = 0;
  }
  /** Milliseconds from now until the next UTC midnight tick. */
  millisUntilNextUtcMidnight() {
    const now = /* @__PURE__ */ new Date();
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
  enqueue(execute, priority = 1) {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      const tail = this.queue[this.queue.length - 1];
      if (!tail || tail.priority <= priority) {
        const msg = `Rate limiter queue full (${MAX_QUEUE_LENGTH}) \u2014 dropping new Cloud call (priority ${priority})`;
        if (this.warnedQueueFull) {
          this.log.debug(msg);
        } else {
          this.warnedQueueFull = true;
          this.log.warn(msg);
        }
        return;
      }
      this.queue.pop();
    }
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
  /**
   * Snapshot of usage + limits for the diag runtime-state export. Returns
   * plain values so the DiagnosticsCollector can clone-and-cap safely.
   * Plus `queueLength` for "Cloud calls piling up?" forensics.
   */
  getUsageSnapshot() {
    return {
      usedToday: this.callsToday,
      usedThisMinute: this.callsThisMinute,
      dailyLimit: this.perDayLimit,
      perMinuteLimit: this.perMinuteLimit,
      queueLength: this.queue.length
    };
  }
  /** Process queued calls */
  processQueue() {
    if (this.stopped) {
      return;
    }
    while (this.queue.length > 0 && this.canMakeCall()) {
      const call = this.queue.shift();
      if (call) {
        this.callsThisMinute++;
        this.callsToday++;
        call.execute().catch((err) => {
          this.log.debug(`Queued call failed: ${(0, import_types.errMessage)(err)}`);
        });
      }
    }
    if (this.queue.length === 0) {
      this.warnedQueueFull = false;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_QUEUE_LENGTH,
  RateLimiter
});
//# sourceMappingURL=rate-limiter.js.map
