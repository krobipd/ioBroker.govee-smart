import * as fs from "node:fs";
import * as path from "node:path";
import type { Counterpart } from "./api-limits";
import { writeFileAtomic } from "./atomic-file";
import { Booking, runBooked } from "./call-booking";
import { SlotLanes, isStamp, type Slot } from "./call-window";
import { errText, type GoveeDevice, type TimerAdapter } from "./types";
import { GOVEE_DEVICE_TYPE, isAppGroup } from "./govee-constants";
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
 * The key a device's own windows are kept under.
 *
 * @param device The device (sku + id suffice)
 */
export function limiterDeviceKey(device: Pick<GoveeDevice, "sku" | "deviceId">): string {
  return `${device.sku}:${device.deviceId}`;
}

/**
 * A full window longer than this refuses its call instead of queueing it: the
 * call would run hours later, at a moment nobody asked for (audit A10). Every
 * shorter window queues the call until a slot frees.
 */
export const QUEUE_MAX_WINDOW_SECONDS = 3600;

/** The window of a device's own allowance and of the report's "today" — one sliding day. */
const DAY_SECONDS = 86_400;

/** The file in the instance data folder that carries the long windows over a restart. */
export const LIMITER_MEMORY_FILE = "rate-limits.json";

/** One window a call books: its lane key and its limit. */
interface LaneWindow {
  /** Counterpart, limit and lane (account or device), or the device's allowance. */
  key: string;
  /** Calls the window allows. */
  max: number;
  /** The window length. */
  seconds: number;
}

/** What one booked call took: a slot in every window of its lane. */
interface SpentCall {
  /** The slots, each with its lane key. */
  taken: Array<{ key: string; slot: Slot }>;
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
   * The device allowance this call belongs to, carried through the queue —
   * booked when the call runs, so a call that waited is counted like one that
   * ran at once.
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

/** The refusal of a call on a spent daily window (A10). */
const DAY_BUDGET_SPENT =
  "Daily Govee Cloud budget is used up — the call is skipped until the oldest call of the last 24 hours is a day old";

/**
 * A per-device daily allowance on top of the global budget.
 *
 * Govee's limits are not one budget: the account gets 10,000 calls a day, but
 * an APPLIANCE gets 100 for itself. The global windows cannot express that —
 * one appliance may spend the whole account budget, ninety times its own share.
 */
export interface DeviceBudget {
  /** Identifies the device, e.g. `sku:deviceId`. */
  key: string;
  /** Calls this device may make in any 24 hours. */
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
  if (!device || device.type === GOVEE_DEVICE_TYPE.LIGHT || isAppGroup(device)) {
    return undefined;
  }
  return { key: `${device.sku}:${device.deviceId}`, perDay: CLOUD_APPLIANCE_DAILY_LIMIT };
}

/**
 * What a restart carries over: the settle times of every window longer than
 * {@link QUEUE_MAX_WINDOW_SECONDS}, by lane key — the daily OpenAPI window and
 * the appliances' allowances. A shorter window is long past when the next
 * process asks.
 */
export interface RateLimiterMemory {
  /** Settle times (ms) per lane key. */
  lanes: Record<string, number[]>;
}

/**
 * Read what the previous process of this instance left in its data folder — an
 * empty memory when there is none or it is unreadable.
 *
 * @param dataDir The instance data folder
 */
export function loadLimiterMemory(dataDir: string): RateLimiterMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, LIMITER_MEMORY_FILE), "utf-8")) as unknown;
    const lanes = (raw as { lanes?: unknown } | null)?.lanes;
    const kept: Record<string, number[]> = {};
    for (const [key, ends] of Object.entries(lanes ?? {})) {
      if (Array.isArray(ends)) {
        kept[key] = ends.filter(isStamp);
      }
    }
    return { lanes: kept };
  } catch {
    // no file yet, or an unreadable one: nothing was counted
    return { lanes: {} };
  }
}

/**
 * Leave the long windows for the next process of this instance.
 *
 * @param dataDir The instance data folder
 * @param memory What {@link RateLimiter.memory} returned
 */
export async function saveLimiterMemory(dataDir: string, memory: RateLimiterMemory): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  await writeFileAtomic(path.join(dataDir, LIMITER_MEMORY_FILE), JSON.stringify(memory));
}

/**
 * Rate limiter for Govee Cloud API calls — one lane per actor Govee names
 * ({@link CLOUD_LIMITS}), each with the sliding windows api-limits.json
 * declares, the daily window over every OpenAPI lane, and one priority-sorted
 * queue whose calls run as soon as THEIR windows have room. A call holds its
 * slot from the moment it runs until the window's length after it ended
 * (call-window.ts) — the way Govee counts it and the fleet judges it.
 */
export class RateLimiter {
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private readonly queue: QueuedCall[] = [];
  private readonly lanes = new SlotLanes();
  /** Calls given back because none of their requests reached Govee — one sliding day, for the report. */
  private readonly notDelivered = new SlotLanes();
  /** The wake-up for the queue: when the soonest window a queued call waits for has room again. */
  private wakeTimer: ioBroker.Timeout | undefined = undefined;
  /** True after `stop()` — nothing is queued or run any more. */
  private stopped = false;
  /** Warn-once flag for the queue-full drop — reset when the queue drains. */
  private warnedQueueFull = false;
  /**
   * The long windows already reported as spent — the message is actionable and
   * belongs in the log once, not on every rejected write. A window that has
   * room again says so again when it fills up next time.
   */
  private readonly warnedSpent = new Set<string>();

  private readonly limits: CloudLimits;
  /** Injectable clock — the windows slide against it. */
  private readonly clock: () => number;

  /**
   * @param log ioBroker logger
   * @param timers Timer adapter
   * @param limits The per-actor budget (default: the declared windows of api-limits.json)
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
  }

  /** Start the rate limiter. */
  start(): void {
    this.stopped = false;
  }

  /** Stop the rate limiter */
  stop(): void {
    this.stopped = true;
    if (this.wakeTimer) {
      this.timers.clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    // Reject pending TRACKED calls so no caller awaits a promise that can
    // never settle after stop (compact mode keeps the process alive —
    // a hanging await would leak its closure).
    for (const call of this.queue) {
      call.reject?.(new Error("Rate limiter stopped — queued Cloud call cancelled"));
    }
    this.queue.length = 0;
  }

  /**
   * The windows a call on this lane books: every limit of every counterpart
   * of the lane — per device under the lane's device, otherwise for the
   * account — and the device's own allowance, where one applies.
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance
   */
  private windowsOf(lane: CallLane, budget?: DeviceBudget): LaneWindow[] {
    const windows: LaneWindow[] = [];
    for (const counterpart of this.limits[lane.kind]) {
      for (const [i, limit] of counterpart.limits.entries()) {
        const who = limit.per === "device" && "deviceKey" in lane ? `device ${lane.deviceKey}` : "account";
        windows.push({ key: `${counterpart.name}|${i}|${who}`, max: limit.max, seconds: limit.seconds });
      }
    }
    if (budget) {
      windows.push({ key: `allowance|${budget.key}`, max: budget.perDay, seconds: DAY_SECONDS });
    }
    return windows;
  }

  /**
   * The long window that refuses this call, if one is full — its slots free
   * only in hours.
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance
   */
  private spentWindow(lane: CallLane, budget?: DeviceBudget): LaneWindow | undefined {
    const now = this.clock();
    for (const w of this.windowsOf(lane, budget)) {
      if (w.seconds <= QUEUE_MAX_WINDOW_SECONDS) {
        continue;
      }
      if (this.lanes.waitMs(w.key, w.max, w.seconds, now) !== 0) {
        return w;
      }
    }
    return undefined;
  }

  /**
   * Whether the call is refused because a long window is full — and if so,
   * say so once. A refused call is NOT queued: its window has room again only
   * in hours, and a queued command would run at a moment nobody asked for
   * (audit A10).
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance
   * @returns the refusal, or undefined when the call may run or wait
   */
  private refusal(lane: CallLane, budget?: DeviceBudget): Error | undefined {
    const spent = this.spentWindow(lane, budget);
    if (!spent) {
      return undefined;
    }
    const isAllowance = budget !== undefined && spent.key === `allowance|${budget.key}`;
    if (!this.warnedSpent.has(spent.key)) {
      this.warnedSpent.add(spent.key);
      if (isAllowance) {
        this.log.warn(
          `Device ${budget.key} has used its daily Govee budget (${budget.perDay} calls in 24 hours). Govee allows an ` +
            `appliance 100 calls per day and appliance control has no local path, so every write counts. Further ` +
            `commands for this device are skipped until its oldest call of the last 24 hours is a day old — reduce ` +
            `how often a script writes to it.`,
        );
      } else {
        this.log.warn(
          `The adapter has made ${spent.max} Govee Cloud calls in the last 24 hours — the daily ceiling. Further ` +
            `Cloud calls are skipped until the oldest of them is a day old; LAN control keeps working.`,
        );
      }
    }
    return new Error(
      isAllowance ? `Daily Govee budget for ${budget.key} is used up (${budget.perDay} calls)` : DAY_BUDGET_SPENT,
    );
  }

  /**
   * How long until a call on this lane fits every short window — 0 when it
   * fits now, undefined while a slot it needs is held by a call that has not
   * ended yet.
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance
   */
  private waitFor(lane: CallLane, budget?: DeviceBudget): number | undefined {
    const now = this.clock();
    let longest = 0;
    for (const w of this.windowsOf(lane, budget)) {
      const wait = this.lanes.waitMs(w.key, w.max, w.seconds, now);
      if (wait === undefined) {
        return undefined;
      }
      longest = Math.max(longest, wait);
    }
    return longest;
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
    const refused = this.refusal(lane, budget);
    if (refused) {
      reject?.(refused);
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
    this.schedule();
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
    // A full long window refuses in enqueue — its wait is hours, so it never runs here
    if (this.waitFor(lane, budget) === 0) {
      await this.runSpent(execute, this.spend(lane, budget));
      return true;
    }
    this.enqueue(execute, lane, priority, undefined, budget);
    return false;
  }

  /**
   * Book one call: a slot in every window of its lane — the daily window
   * included (EVERY OpenAPI lane: the 9,000 protection covers the account,
   * not just the device lanes) — and, where one applies, in the device's own
   * allowance.
   *
   * @param lane The actor the call is charged to
   * @param budget The device's allowance, when the call belongs to one
   */
  private spend(lane: CallLane, budget?: DeviceBudget): SpentCall {
    const taken = this.windowsOf(lane, budget).map(w => {
      // a window that takes a call has room again: when it fills up next time, it says so again
      this.warnedSpent.delete(w.key);
      return { key: w.key, slot: this.lanes.take(w.key) };
    });
    return { taken };
  }

  /**
   * Run a booked call. When it ends, its slots count down their windows from
   * that moment; when none of its requests reached Govee (issue #51) — a call
   * that failed on the name lookup or a refused connection was never counted
   * by Govee — its slots are given back instead, least of all an appliance's
   * daily allowance, which otherwise refused real commands after an outage.
   *
   * @param execute The API call
   * @param spent What {@link spend} booked for it
   */
  private async runSpent(execute: () => Promise<void>, spent: SpentCall): Promise<void> {
    const booking = new Booking();
    try {
      await runBooked(booking, execute);
    } finally {
      const now = this.clock();
      if (booking.seal()) {
        for (const { key, slot } of spent.taken) {
          this.lanes.give(key, slot);
        }
        this.notDelivered.take("given back").end = now;
      } else {
        for (const { slot } of spent.taken) {
          slot.end = now;
        }
      }
      this.schedule();
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
    // A full long window refuses in enqueue, which rejects this promise with the reason
    if (this.waitFor(lane, budget) === 0) {
      await this.runSpent(execute, this.spend(lane, budget));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const accepted = this.enqueue(
        async () => {
          try {
            await execute();
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(errText(e)));
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
   * Whether a call on this lane can be made right now — every window of the
   * lane, the daily one included, has room.
   *
   * @param lane The actor the call would be charged to
   */
  canMakeCall(lane: CallLane = ACCOUNT_LIST_LANE): boolean {
    return this.waitFor(lane) === 0;
  }

  /**
   * What the next process of this instance must know: the settle times of
   * every window longer than {@link QUEUE_MAX_WINDOW_SECONDS} — an open call
   * as ending now.
   */
  memory(): RateLimiterMemory {
    const now = this.clock();
    const lanes: Record<string, number[]> = {};
    for (const w of this.knownWindows()) {
      if (w.seconds > QUEUE_MAX_WINDOW_SECONDS) {
        const ends = this.lanes.ends(w.key, w.seconds, now);
        if (ends.length > 0) {
          lanes[w.key] = ends;
        }
      }
    }
    return { lanes };
  }

  /**
   * Lay in what the previous process left — the calls it made within every
   * long window still count. Only lanes this limiter keeps and only settle
   * times within their window are taken.
   *
   * @param memory What {@link loadLimiterMemory} read
   */
  remember(memory: RateLimiterMemory): void {
    const now = this.clock();
    const longs = new Map(
      this.knownWindows()
        .filter(w => w.seconds > QUEUE_MAX_WINDOW_SECONDS)
        .map(w => [w.key, w.seconds]),
    );
    for (const [key, ends] of Object.entries(memory.lanes)) {
      const seconds = longs.get(key) ?? (key.startsWith("allowance|") ? DAY_SECONDS : undefined);
      if (seconds === undefined) {
        continue;
      }
      this.lanes.restore(
        key,
        ends.filter(end => end <= now && now - end < seconds * 1000),
      );
    }
  }

  /**
   * Every window a lane of this limiter books right now: the declared ones of
   * every lane that holds a slot, and the device allowances.
   */
  private knownWindows(): LaneWindow[] {
    const windows = new Map<string, LaneWindow>();
    for (const kind of Object.keys(this.limits) as Array<CallLane["kind"]>) {
      for (const counterpart of this.limits[kind]) {
        for (const [i, limit] of counterpart.limits.entries()) {
          if (limit.per !== "device") {
            const key = `${counterpart.name}|${i}|account`;
            windows.set(key, { key, max: limit.max, seconds: limit.seconds });
          }
        }
      }
    }
    for (const key of this.lanes.keys()) {
      if (key.startsWith("allowance|")) {
        windows.set(key, { key, max: 0, seconds: DAY_SECONDS });
      } else if (!windows.has(key)) {
        const window = this.windowOfKey(key);
        if (window) {
          windows.set(key, window);
        }
      }
    }
    return [...windows.values()];
  }

  /**
   * The declared window a lane key names (`<counterpart>|<limit index>|<who>`).
   *
   * @param key The lane key
   */
  private windowOfKey(key: string): LaneWindow | undefined {
    const [name, index] = key.split("|");
    const counterpart = Object.values(this.limits)
      .flat()
      .find((c: Counterpart) => c.name === name);
    const limit = counterpart?.limits[Number(index)];
    return limit ? { key, max: limit.max, seconds: limit.seconds } : undefined;
  }

  /**
   * Snapshot of usage + limits for the diag runtime-state export: every window
   * that holds a slot, with its use. Returns plain values so the
   * DiagnosticsCollector can clone-and-cap safely. Plus `queueLength` for
   * "Cloud calls piling up?" forensics.
   */
  getUsageSnapshot(): RateLimiterSnapshot {
    const now = this.clock();
    const windows = this.knownWindows().map(w => ({
      lane: w.key,
      seconds: w.seconds,
      max: w.max,
      used: this.lanes.held(w.key, w.seconds, now).length,
    }));
    const day = this.knownWindows().find(w => w.seconds > QUEUE_MAX_WINDOW_SECONDS && !w.key.startsWith("allowance|"));
    return {
      usedToday: day ? this.lanes.held(day.key, day.seconds, now).length : 0,
      notDeliveredToday: this.notDelivered.held("given back", DAY_SECONDS, now).length,
      dailyLimit: day?.max ?? 0,
      queueLength: this.queue.length,
      windows,
    };
  }

  /**
   * Wake the queue when the soonest window a queued call waits for has room
   * again. A window full of calls that have not ended yet has no such moment:
   * the end of one of them schedules again.
   */
  private schedule(): void {
    // a stopped limiter has an empty queue and queues nothing: no call, no wake-up
    let soonest: number | undefined;
    for (const call of this.queue) {
      const wait = this.waitFor(call.lane, call.budget);
      if (wait !== undefined && (soonest === undefined || wait < soonest)) {
        soonest = wait;
      }
    }
    if (soonest === undefined) {
      return;
    }
    if (this.wakeTimer) {
      this.timers.clearTimeout(this.wakeTimer);
    }
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = undefined;
      this.processQueue();
    }, soonest);
  }

  /**
   * Process queued calls: walk the priority-sorted queue and start every call
   * whose windows have room right now. A call whose lane is full is skipped,
   * not waited for — a saturated App-API lane never holds a command back.
   */
  private processQueue(): void {
    if (this.stopped) {
      return;
    }
    for (let i = 0; i < this.queue.length;) {
      const call = this.queue[i];
      // Checked HERE, not only when the call was queued: while it waited,
      // immediate calls may have spent the rest of the day or of the device's
      // allowance. Running it anyway would overrun Govee's 100/day for an
      // appliance — the exact case the allowance exists for.
      const refused = this.refusal(call.lane, call.budget);
      if (refused) {
        this.queue.splice(i, 1);
        call.reject?.(refused);
        continue;
      }
      if (this.waitFor(call.lane, call.budget) !== 0) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.runSpent(call.execute, this.spend(call.lane, call.budget)).catch(err => {
        this.log.debug(`Queued call failed: ${errText(err)}`);
      });
    }
    if (this.queue.length === 0) {
      // Queue drained — the next overflow episode warns again.
      this.warnedQueueFull = false;
    }
    this.schedule();
  }
}

/** What `getUsageSnapshot` reports — every window that holds a slot. */
export interface RateLimiterSnapshot {
  /** OpenAPI calls in the last 24 hours, all lanes together. */
  usedToday: number;
  /** Calls given back in the last 24 hours because none of their requests reached Govee (DNS, refused connection). */
  notDeliveredToday: number;
  /** The daily ceiling those calls count against. */
  dailyLimit: number;
  /** Calls waiting for a free window right now. */
  queueLength: number;
  /** Per window: its lane (`<counterpart>|<limit>|<account or device>`), length, limit and use. */
  windows: Array<{ lane: string; seconds: number; max: number; used: number }>;
}
