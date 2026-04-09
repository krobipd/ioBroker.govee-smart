"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
/**
 * Rate limiter for Govee Cloud API calls.
 * Respects per-minute and daily limits, queues excess calls.
 */
class RateLimiter {
    log;
    timers;
    queue = [];
    processTimer = undefined;
    callsThisMinute = 0;
    callsToday = 0;
    minuteResetTimer = undefined;
    dayResetTimer = undefined;
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
    constructor(log, timers, perMinuteLimit = 8, perDayLimit = 9000) {
        this.log = log;
        this.timers = timers;
        this.perMinuteLimit = perMinuteLimit;
        this.perDayLimit = perDayLimit;
    }
    /** Start the rate limiter — resets counters periodically */
    start() {
        // Reset minute counter every 60s
        this.minuteResetTimer = this.timers.setInterval(() => {
            this.callsThisMinute = 0;
            this.processQueue();
        }, 60_000);
        // Reset daily counter every 24h
        this.dayResetTimer = this.timers.setInterval(() => {
            this.log.debug(`Rate limiter: daily reset (used ${this.callsToday} calls today)`);
            this.callsToday = 0;
        }, 86_400_000);
        // Process queue every 2s
        this.processTimer = this.timers.setInterval(() => {
            this.processQueue();
        }, 2_000);
    }
    /** Stop the rate limiter */
    stop() {
        if (this.minuteResetTimer) {
            this.timers.clearInterval(this.minuteResetTimer);
            this.minuteResetTimer = undefined;
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
    /**
     * Enqueue an API call. It will be executed when rate limits allow.
     *
     * @param execute The API call to make
     * @param priority Lower = higher priority (0 = control, 1 = status, 2 = scenes)
     */
    enqueue(execute, priority = 1) {
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
        return (this.callsThisMinute < this.perMinuteLimit &&
            this.callsToday < this.perDayLimit);
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
                    this.log.debug(`Queued call failed: ${err instanceof Error ? err.message : String(err)}`);
                });
            }
        }
    }
}
exports.RateLimiter = RateLimiter;
//# sourceMappingURL=rate-limiter.js.map