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
  /**
   * Calls spent per device today. Cleared with the daily counter, so it follows
   * the same reset Govee applies.
   */
  callsTodayPerDevice = /* @__PURE__ */ new Map();
  /**
   * Devices already warned about today. The message is actionable and belongs
   * in the log once, not on every rejected write — a script hitting the limit
   * hits it again a minute later.
   */
  warnedDeviceBudget = /* @__PURE__ */ new Set();
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
    var _a;
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
    for (const call of this.queue) {
      (_a = call.reject) == null ? void 0 : _a.call(call, new Error("Rate limiter stopped \u2014 queued Cloud call cancelled"));
    }
    this.queue.length = 0;
  }
  /** Zero the daily counter and log. Separate so kickoff + interval share it. */
  resetDaily() {
    this.log.debug(
      `Rate limiter: daily reset (used ${this.callsToday} calls today, ${this.callsTodayPerDevice.size} device(s) tracked)`
    );
    this.callsToday = 0;
    this.callsTodayPerDevice.clear();
    this.warnedDeviceBudget.clear();
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
   * @param reject Optional rejection callback, invoked if this queued call is later evicted to free a slot for a higher-priority one
   */
  enqueue(execute, priority = 1, reject) {
    var _a;
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
        return false;
      }
      const evicted = this.queue.pop();
      (_a = evicted == null ? void 0 : evicted.reject) == null ? void 0 : _a.call(evicted, new Error("Cloud call evicted \u2014 rate-limiter queue full"));
    }
    this.queue.push({ execute, priority, reject });
    this.queue.sort((a, b) => a.priority - b.priority);
    return true;
  }
  /**
   * Execute immediately if within limits, otherwise queue.
   * Returns true if executed immediately.
   *
   * @param execute The API call to make
   * @param priority Call priority
   * @param budget
   */
  async tryExecute(execute, priority = 0, budget) {
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
  deviceBudgetSpent(budget) {
    var _a;
    const used = (_a = this.callsTodayPerDevice.get(budget.key)) != null ? _a : 0;
    if (used < budget.perDay) {
      return false;
    }
    if (!this.warnedDeviceBudget.has(budget.key)) {
      this.warnedDeviceBudget.add(budget.key);
      this.log.warn(
        `Device ${budget.key} has used its daily Govee budget (${budget.perDay} calls). Govee allows an appliance 100 calls per day and appliance control has no local path, so every write counts. Further commands for this device are skipped until Govee's daily reset \u2014 reduce how often a script writes to it.`
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
  spend(budget) {
    var _a;
    this.callsThisMinute++;
    this.callsToday++;
    if (budget) {
      this.callsTodayPerDevice.set(budget.key, ((_a = this.callsTodayPerDevice.get(budget.key)) != null ? _a : 0) + 1);
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
   * @param budget
   */
  async executeTracked(execute, priority = 0, budget) {
    if (budget && this.deviceBudgetSpent(budget)) {
      throw new Error(`Daily Govee budget for ${budget.key} is used up (${budget.perDay} calls)`);
    }
    if (this.canMakeCall()) {
      this.spend(budget);
      await execute();
      return;
    }
    await new Promise((resolve, reject) => {
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
        reject
      );
      if (!accepted) {
        reject(new Error("Cloud call dropped \u2014 rate-limiter queue full"));
      }
    });
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
