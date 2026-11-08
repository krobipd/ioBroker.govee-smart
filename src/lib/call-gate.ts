// The gate that keeps the short windows of api-limits.json (GV-08) for every request — per adapter instance.
import { counterpartsFor, deviceOf, type Counterpart, type LimitedCall } from "./api-limits";
import { SlotLanes } from "./call-window";
import { HttpError, httpsRequest, type HttpsRequestFn } from "./http-client";
import { MAX_RATE_LIMIT_RETRY_MS, MIN_RATE_LIMIT_RETRY_MS } from "./timing-constants";

/** The wait a 429 without a readable `Retry-After` holds its host for — the same 60 s the device list waits. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Windows longer than this are not kept by the gate (it would have to remember a day of calls); the daily OpenAPI
 * window is kept by the rate limiter, which carries it over a restart.
 */
export const GATE_MAX_WINDOW_SECONDS = 3600;

/**
 * How soon a sent-and-done call looks again when the slot it needs is still open — never the case while every caller
 * ends its call right after the transport call, as {@link CallGate.tryAdmit} asks.
 */
const OPEN_SLOT_RECHECK_MS = 100;

/** One short window a call counts in: its lane and its limit. */
interface GateWindow {
  /** Counterpart, limit and lane (account, host or device). */
  key: string;
  /** Calls the window allows. */
  max: number;
  /** The window length. */
  seconds: number;
}

/**
 * Keeps the short windows of every counterpart a request belongs to — the endpoint's and the host's — per adapter
 * instance (compact mode shares the process, so nothing here is module-wide). A request holds its slot from the moment
 * it is let through until the window's length after it ended (call-window.ts): the gate never frees a slot before the
 * counterpart has counted the call.
 */
export class CallGate {
  private readonly lanes = new SlotLanes();
  /** Per host: until when a 429 holds it — no call goes out before (fleet suite D21: a 429 is a rate limit). */
  private readonly heldUntil = new Map<string, number>();
  /** Admissions waiting for an open request to end — the slot they need frees only after that. */
  private waiting: Array<() => void> = [];

  /**
   * @param delay The adapter's cancellable delay (`TimerAdapter.delay`)
   * @param now Clock
   */
  constructor(
    private readonly delay: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The short windows of these counterparts, each with its lane.
   *
   * @param counterparts The counterparts the call belongs to
   * @param host The host called (for `per: "host"`)
   * @param device The device it is for (for `per: "device"`), when the call names one
   */
  private windowsOf(
    counterparts: readonly Counterpart[],
    host: string,
    device?: (c: Counterpart) => string | undefined,
  ): GateWindow[] {
    const windows: GateWindow[] = [];
    for (const c of counterparts) {
      for (const [i, limit] of c.limits.entries()) {
        if (limit.seconds > GATE_MAX_WINDOW_SECONDS) {
          continue;
        }
        let lane = "account";
        if (limit.per === "host") {
          lane = host;
        } else if (limit.per === "device") {
          lane = `device ${device?.(c) ?? "unknown"}`;
        }
        windows.push({ key: `${c.name}|${i}|${lane}`, max: limit.max, seconds: limit.seconds });
      }
    }
    return windows;
  }

  /**
   * How long until one more call fits every one of these windows — 0 when it fits now; undefined while a slot it
   * needs is held by a call that has not ended yet.
   *
   * @param windows The windows the call counts in
   */
  private waitIn(windows: readonly GateWindow[]): number | undefined {
    const now = this.now();
    let longest = 0;
    for (const w of windows) {
      const wait = this.lanes.waitMs(w.key, w.max, w.seconds, now);
      if (wait === undefined) {
        return undefined;
      }
      longest = Math.max(longest, wait);
    }
    return longest;
  }

  /**
   * Take a slot in every window when the call fits now; undefined (nothing taken) when it would go over. The returned
   * function ends the call: from then on its slots count down their window.
   *
   * @param windows The windows the call counts in
   */
  private take(windows: readonly GateWindow[]): (() => void) | undefined {
    if (this.waitIn(windows) !== 0) {
      return undefined;
    }
    const slots = windows.map(w => this.lanes.take(w.key));
    return () => {
      const end = this.now();
      for (const slot of slots) {
        slot.end = end;
      }
      const waiting = this.waiting;
      this.waiting = [];
      for (const wake of waiting) {
        wake();
      }
    };
  }

  /**
   * How long until one more sent-and-done call (a datagram, a write on an open connection) to this counterpart fits —
   * 0 when it fits now.
   *
   * @param c The counterpart
   * @param host The host called (for `per: "host"`)
   */
  waitMs(c: Counterpart, host: string): number {
    return this.waitIn(this.windowsOf([c], host)) ?? OPEN_SLOT_RECHECK_MS;
  }

  /**
   * Take the slots of a sent-and-done call (a datagram, a write on an open connection) when it fits now; undefined
   * (nothing taken) when it would go over. Such a call has no answer: the counterpart counts it from its send. The
   * caller ends it with the returned function right after the transport call, in the same synchronous step — so the
   * gate's stamp never lies before the moment it was sent.
   *
   * @param c The counterpart
   * @param host The host called (for `per: "host"`)
   */
  tryAdmit(c: Counterpart, host: string): (() => void) | undefined {
    return this.take(this.windowsOf([c], host));
  }

  /**
   * Wait until a request fits every short window of its counterparts — the endpoint's and the host's —, then take its
   * slots.
   *
   * @param call The request
   * @returns The function that ends the request
   */
  async admit(call: LimitedCall): Promise<() => void> {
    const windows = this.windowsOf(counterpartsFor(call), call.host, c => deviceOf(call, c.match));
    for (;;) {
      const end = this.take(windows);
      if (end) {
        return end;
      }
      const wait = this.waitIn(windows);
      await (wait === undefined ? new Promise<void>(wake => this.waiting.push(wake)) : this.delay(wait));
    }
  }

  /**
   * An HTTPS request function that waits at this gate first. A host no counterpart declares is refused — every call
   * goes to a declared counterpart.
   */
  https(): HttpsRequestFn {
    return async options => {
      const url = new URL(options.url);
      const call: LimitedCall = {
        kind: "http",
        host: url.hostname,
        method: options.method ?? "GET",
        path: url.pathname,
        // the body as the HTTP client sends it (http-client.ts), so a device named in it finds its own lane
        body: options.body ? JSON.stringify(options.body) : undefined,
      };
      if (counterpartsFor(call).length === 0) {
        throw new Error(`api-limits.json declares no limit for ${call.host}`);
      }
      const held = this.heldMs(call.host);
      if (held > 0) {
        // Answered here like the host would: every caller already handles a 429, and nothing reaches the host
        throw new HttpError("HTTP 429", 429, { "retry-after": String(Math.ceil(held / 1000)) });
      }
      const end = await this.admit(call);
      try {
        return await httpsRequest(options);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 429) {
          this.hold(call.host, err.headers["retry-after"]);
        }
        throw err;
      } finally {
        end();
      }
    };
  }

  /**
   * How long a 429 still holds the host — 0 when it is free.
   *
   * @param host The host called
   */
  heldMs(host: string): number {
    const until = this.heldUntil.get(host);
    if (until === undefined) {
      return 0;
    }
    const left = until - this.now();
    if (left <= 0) {
      this.heldUntil.delete(host);
      return 0;
    }
    return left;
  }

  /**
   * Hold the host for the wait its 429 names (seconds; 60 s when it names none), within the adapter's floor and ceiling.
   *
   * @param host The host that answered 429
   * @param retryAfter Its `Retry-After` header
   */
  private hold(host: string, retryAfter: string | string[] | undefined): void {
    const raw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    const ms = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) * 1000 : DEFAULT_RETRY_AFTER_MS;
    const holdMs = Math.min(Math.max(ms, MIN_RATE_LIMIT_RETRY_MS), MAX_RATE_LIMIT_RETRY_MS);
    this.heldUntil.set(host, Math.max(this.heldUntil.get(host) ?? 0, this.now() + holdMs));
  }
}
