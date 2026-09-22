import { errMessage, type GoveeDevice, type TimerAdapter } from "./types";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import { CLOUD_APPLIANCE_DAILY_LIMIT, CLOUD_LIMITS, type CloudLimits } from "./timing-constants";

/**
 * The actor a cloud call is charged to — one of Govee's documented budgets
 * (see {@link CLOUD_LIMITS}). A call carries its lane so that a command for
 * device B never waits for device A, and a library call to app2.govee.com
 * never stands in front of a command.
 */
export type CallLane =
  | { kind: "account-list" }
  | { kind: "device-read"; deviceKey: string }
  | { kind: "device-control"; deviceKey: string }
  | { kind: "appapi" };

export const ACCOUNT_LIST_LANE: CallLane = { kind: "account-list" };
export const APP_API_LANE: CallLane = { kind: "appapi" };

/**
 * The key a device's own buckets are kept under.
 *
 * @param device The device (sku + id suffice)
 */
export function limiterDeviceKey(device: Pick<GoveeDevice, "sku" | "deviceId">): string {
  return `${device.sku}:${device.deviceId}`;
}

/**
 * Govee's "rpu / burst" control limit as a token bucket: `burst` tokens at
 * most, refilled `perSecond` continuously. A burst of six goes out at once,
 * the seventh waits half a second — never a 429, never a minute.
 */
class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  private refill(now: number): void {
    if (now > this.updatedAt) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1000) * this.perSecond);
      this.updatedAt = now;
    }
  }

  /**
   * Whether one token is available right now.
   *
   * @param now Current time (ms)
   */
  has(now: number): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  /**
   * Spend one token (the caller checked `has` first).
   *
   * @param now Current time (ms)
   */
  take(now: number): void {
    this.refill(now);
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /**
   * Whole tokens available, for the usage snapshot.
   *
   * @param now Current time (ms)
   */
  available(now: number): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }
}

/** A queued API call */
interface QueuedCall {
  /** Function to execute */
  execute: () => Promise<void>;
  /** The actor the call is charged to */
  lane: CallLane;
  /** Priority (lower = higher priority) */
  priority: number;
  /**
   * Set for tracked calls (executeTracked): rejects the caller's promise when
   * the call is evicted from a full queue or the limiter stops before it ran.
   */
  reject?: (err: Error) => void;
  /**
   * The device allowance this call belongs to, carried through the queue.
   *
   * Without it the per-device budget was booked ONLY on the immediate path:
   * every call that had to wait for the per-minute limit ran later without
   * ever being counted. The protection therefore failed exactly under the load
   * it exists for — a burst is precisely when calls queue.
   */
  budget?: DeviceBudget;
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
 * The daily allowance for one device, where Govee imposes one.
 *
 * Only appliances have their own budget — 100 calls a day, against the
 * account's 10,000 — and only appliances have no local path, so every write is
 * a cloud call. Lights and groups keep the global budget: a light's writes go
 * over the LAN, and its rare cloud fallbacks are covered by the account limit.
 *
 * Lives next to the limiter rather than in the command router: the router is
 * not the only caller that spends an appliance's allowance — the cloud state
 * read does too, and while this helper was private to the router that call
 * went unbudgeted while its own comment claimed otherwise.
 *
 * @param device The device a call is being made for
 * @returns The device's allowance, or undefined when only the global one applies
 */
export function applianceBudget(device?: GoveeDevice): DeviceBudget | undefined {
  if (!device || device.type === GOVEE_DEVICE_TYPE.LIGHT || device.sku === "BaseGroup") {
    return undefined;
  }
  return { key: `${device.sku}:${device.deviceId}`, perDay: CLOUD_APPLIANCE_DAILY_LIMIT };
}

/**
 * Rate limiter for Govee Cloud API calls — one bucket per actor Govee names
 * ({@link CLOUD_LIMITS}), a global daily counter over all of them, and one
 * priority-sorted queue whose calls run as soon as THEIR bucket is free.
 */
export class RateLimiter {
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private readonly queue: QueuedCall[] = [];
  private processTimer: ioBroker.Interval | undefined = undefined;
  /** `/user/devices` this minute. */
  private accountListUsed = 0;
  /** app2.govee.com calls this minute. */
  private appApiUsed = 0;
  /** `/device/state|scenes|diy-scenes` this minute, per device. */
  private readonly deviceReadUsed = new Map<string, number>();
  /** `/device/control` per device — Govee's rpu/burst as token buckets. */
  private readonly deviceControl = new Map<string, TokenBucket>();
  /** `/device/control` per account. */
  private readonly accountControl: TokenBucket;
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

  private readonly limits: CloudLimits;
  /** Injectable clock — the token buckets refill against it. */
  private readonly clock: () => number;

  /**
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param limits The per-actor budget (default: Govee's v2 limits with margin)
   * @param clock Time source in ms (tests advance it by hand)
   */
  constructor(
    log: ioBroker.Logger,
    timers: TimerAdapter,
    limits: CloudLimits = CLOUD_LIMITS,
    clock: () => number = () => Date.now(),
  ) {
    this.log = log;
    this.timers = timers;
    this.limits = limits;
    this.clock = clock;
    this.accountControl = new TokenBucket(limits.accountControl.burst, limits.accountControl.perSecond, clock());
  }

  /** Start the rate limiter — resets counters periodically */
  start(): void {
    this.stopped = false;
    // Reset the minute windows every 60s
    this.minuteResetTimer = this.timers.setInterval(() => this.resetMinuteWindow(), 60_000);

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
   * @param lane The actor the call is charged to
   * @param priority Lower = higher priority (0 = control, 1 = status reads, 2 = scene libraries, 3 = reachability refresh)
   * @param reject Optional rejection callback, invoked if this queued call is later evicted to free a slot for a higher-priority one
   * @param budget The device's own daily allowance, when one applies — booked when the call actually runs, not when it is queued
   */
  enqueue(
    execute: () => Promise<void>,
    lane: CallLane = ACCOUNT_LIST_LANE,
    priority = 1,
    reject?: (err: Error) => void,
    budget?: DeviceBudget,
  ): boolean {
    // A stopped limiter never processes its queue again: a call queued after
    // stop() would wait forever, and a tracked caller with it — the leak the
    // stop() comment describes, reached from any late call during unload
    // (measured 2026-09-22: a scene job's second call after stop()).
    if (this.stopped) {
      reject?.(new Error("Rate limiter stopped — Cloud call cancelled"));
      return false;
    }
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
    this.queue.push({ execute, lane, priority, reject, budget });
    // Sort by priority (lower first)
    this.queue.sort((a, b) => a.priority - b.priority);
    return true;
  }

  /**
   * Execute immediately if within limits, otherwise queue.
   * Returns true if executed immediately.
   *
   * @param execute The API call to make
   * @param lane The actor the call is charged to
   * @param priority Call priority
   * @param budget The device's own daily allowance, when one applies
   */
  async tryExecute(
    execute: () => Promise<void>,
    lane: CallLane = ACCOUNT_LIST_LANE,
    priority = 0,
    budget?: DeviceBudget,
  ): Promise<boolean> {
    if (budget && this.deviceBudgetSpent(budget)) {
      return false;
    }
    if (this.canMakeCall(lane)) {
      this.spend(lane, budget);
      await execute();
      return true;
    }
    this.enqueue(execute, lane, priority, undefined, budget);
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
   * Book one call against its lane, the daily counter (EVERY lane — the 9,000
   * protection covers the account, not just the device lanes) and, where one
   * applies, the device's own allowance.
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance, when the call belongs to one
   */
  private spend(lane: CallLane, budget?: DeviceBudget): void {
    const now = this.clock();
    switch (lane.kind) {
      case "account-list":
        this.accountListUsed++;
        break;
      case "appapi":
        this.appApiUsed++;
        break;
      case "device-read":
        this.deviceReadUsed.set(lane.deviceKey, (this.deviceReadUsed.get(lane.deviceKey) ?? 0) + 1);
        break;
      case "device-control":
        this.controlBucket(lane.deviceKey, now).take(now);
        this.accountControl.take(now);
        break;
    }
    this.callsToday++;
    if (budget) {
      this.callsTodayPerDevice.set(budget.key, (this.callsTodayPerDevice.get(budget.key) ?? 0) + 1);
    }
  }

  private controlBucket(deviceKey: string, now: number): TokenBucket {
    let bucket = this.deviceControl.get(deviceKey);
    if (!bucket) {
      bucket = new TokenBucket(this.limits.deviceControl.burst, this.limits.deviceControl.perSecond, now);
      this.deviceControl.set(deviceKey, bucket);
    }
    return bucket;
  }

  /** Zero the minute windows and run what waited for them. */
  private resetMinuteWindow(): void {
    this.accountListUsed = 0;
    this.appApiUsed = 0;
    this.deviceReadUsed.clear();
    this.processQueue();
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
   * @param lane The actor the call is charged to
   * @param priority Call priority (0 = control)
   * @param budget The device's own daily allowance, when one applies
   */
  async executeTracked(
    execute: () => Promise<void>,
    lane: CallLane = ACCOUNT_LIST_LANE,
    priority = 0,
    budget?: DeviceBudget,
  ): Promise<void> {
    if (budget && this.deviceBudgetSpent(budget)) {
      throw new Error(`Daily Govee budget for ${budget.key} is used up (${budget.perDay} calls)`);
    }
    if (this.canMakeCall(lane)) {
      this.spend(lane, budget);
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
            reject(e instanceof Error ? e : new Error(errMessage(e)));
          }
        },
        lane,
        priority,
        reject,
        budget,
      );
      if (!accepted) {
        reject(new Error("Cloud call dropped — rate-limiter queue full"));
      }
    });
  }

  /**
   * Whether a call on this lane can be made right now — the day counter first,
   * then the lane's own bucket.
   *
   * @param lane The actor the call would be charged to
   */
  canMakeCall(lane: CallLane = ACCOUNT_LIST_LANE): boolean {
    if (this.callsToday >= this.limits.perDay) {
      return false;
    }
    const now = this.clock();
    switch (lane.kind) {
      case "account-list":
        return this.accountListUsed < this.limits.accountListPerMinute;
      case "appapi":
        return this.appApiUsed < this.limits.appApiPerMinute;
      case "device-read":
        return (this.deviceReadUsed.get(lane.deviceKey) ?? 0) < this.limits.deviceReadPerMinute;
      case "device-control":
        return this.accountControl.has(now) && this.controlBucket(lane.deviceKey, now).has(now);
    }
  }

  /**
   * Snapshot of usage + limits for the diag runtime-state export, one entry
   * per lane. Returns plain values so the DiagnosticsCollector can
   * clone-and-cap safely. Plus `queueLength` for "Cloud calls piling up?"
   * forensics.
   */
  getUsageSnapshot(): RateLimiterSnapshot {
    const now = this.clock();
    return {
      usedToday: this.callsToday,
      dailyLimit: this.limits.perDay,
      queueLength: this.queue.length,
      lanes: {
        accountList: { used: this.accountListUsed, limit: this.limits.accountListPerMinute },
        appApi: { used: this.appApiUsed, limit: this.limits.appApiPerMinute },
        deviceRead: {
          limit: this.limits.deviceReadPerMinute,
          devices: [...this.deviceReadUsed].map(([deviceKey, used]) => ({ deviceKey, used })),
        },
        deviceControl: {
          perSecond: this.limits.deviceControl.perSecond,
          burst: this.limits.deviceControl.burst,
          accountTokens: this.accountControl.available(now),
          devices: [...this.deviceControl].map(([deviceKey, bucket]) => ({ deviceKey, tokens: bucket.available(now) })),
        },
      },
    };
  }

  /**
   * Process queued calls: walk the priority-sorted queue and start every call
   * whose lane is free right now. A call whose bucket is exhausted is skipped,
   * not waited for — a saturated App-API lane never holds a command back.
   */
  private processQueue(): void {
    if (this.stopped) {
      return;
    }
    for (let i = 0; i < this.queue.length;) {
      const call = this.queue[i];
      if (!this.canMakeCall(call.lane)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      // Re-check the device allowance HERE, not only when the call was
      // queued: while this one waited, immediate calls for the same device
      // may have spent the rest of its day. Running it anyway would overrun
      // Govee's 100/day for an appliance — the exact case the allowance
      // exists for, and the one the old code could not see because it never
      // carried the budget into the queue.
      if (call.budget && this.deviceBudgetSpent(call.budget)) {
        call.reject?.(new Error(`Daily Govee budget for ${call.budget.key} is used up (${call.budget.perDay} calls)`));
        continue;
      }
      // spend(), not two raw increments: this was the second booking site and
      // the only one that did not know about device allowances.
      this.spend(call.lane, call.budget);
      call.execute().catch(err => {
        this.log.debug(`Queued call failed: ${errMessage(err)}`);
      });
    }
    if (this.queue.length === 0) {
      // Queue drained — the next overflow episode warns again.
      this.warnedQueueFull = false;
    }
  }
}

/** What `getUsageSnapshot` reports — one entry per lane. */
export interface RateLimiterSnapshot {
  /** OpenAPI + App-API calls made today, all lanes together. */
  usedToday: number;
  /** The daily ceiling those calls count against. */
  dailyLimit: number;
  /** Calls waiting for a free bucket right now. */
  queueLength: number;
  /** Per-lane usage against its own limit. */
  lanes: {
    accountList: { used: number; limit: number };
    appApi: { used: number; limit: number };
    deviceRead: { limit: number; devices: Array<{ deviceKey: string; used: number }> };
    deviceControl: {
      perSecond: number;
      burst: number;
      accountTokens: number;
      devices: Array<{ deviceKey: string; tokens: number }>;
    };
  };
}
