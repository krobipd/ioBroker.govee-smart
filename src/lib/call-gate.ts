// The gate that keeps the short windows of api-limits.json (GV-08) — per adapter instance.
import { counterpartFor, type ApiLimit, type Counterpart } from "./api-limits";
import { HttpError, httpsRequest, type HttpsRequestFn } from "./http-client";
import { MAX_RATE_LIMIT_RETRY_MS, MIN_RATE_LIMIT_RETRY_MS } from "./timing-constants";

/** The wait a 429 without a readable `Retry-After` holds its host for — the same 60 s the device list waits. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Windows longer than this are not kept by the gate (it would have to remember a day of calls); the daily OpenAPI
 * budget is kept by the rate limiter (`CLOUD_LIMITS.perDay`).
 */
export const GATE_MAX_WINDOW_SECONDS = 3600;

/**
 * Keeps the short windows of every counterpart, per adapter instance (compact mode shares the process, so nothing here
 * is module-wide). A call is counted when it is let through; the gate never forgets a call it let through before its
 * window has passed.
 */
export class CallGate {
  private readonly seen = new Map<string, number[]>();
  /** Per host: until when a 429 holds it — no call goes out before (fleet suite D21: a 429 is a rate limit). */
  private readonly heldUntil = new Map<string, number>();

  /**
   * @param delay The adapter's cancellable delay (`TimerAdapter.delay`)
   * @param now Clock
   */
  constructor(
    private readonly delay: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * How long until one more call fits every short window of the counterpart — 0 when it fits now.
   *
   * @param c The counterpart
   * @param host The host called (for `per: "host"`)
   */
  waitMs(c: Counterpart, host: string): number {
    const now = this.now();
    let longest = 0;
    for (const [i, limit] of c.limits.entries()) {
      if (limit.seconds > GATE_MAX_WINDOW_SECONDS) {
        continue;
      }
      const times = this.window(this.key(c, i, limit, host), limit, now);
      if (times.length >= limit.max) {
        longest = Math.max(longest, times[times.length - limit.max] + limit.seconds * 1000 - now + 1);
      }
    }
    return longest;
  }

  /**
   * Count the call now when it fits; false (nothing counted) when it would go over.
   *
   * @param c The counterpart
   * @param host The host called
   */
  tryAdmit(c: Counterpart, host: string): boolean {
    if (this.waitMs(c, host) > 0) {
      return false;
    }
    const now = this.now();
    for (const [i, limit] of c.limits.entries()) {
      if (limit.seconds <= GATE_MAX_WINDOW_SECONDS) {
        const key = this.key(c, i, limit, host);
        this.seen.set(key, [...(this.seen.get(key) ?? []), now]);
      }
    }
    return true;
  }

  /**
   * Wait until the call fits, then count it.
   *
   * @param c The counterpart
   * @param host The host called
   */
  async admit(c: Counterpart, host: string): Promise<void> {
    while (!this.tryAdmit(c, host)) {
      await this.delay(this.waitMs(c, host));
    }
  }

  /**
   * An HTTPS request function that waits at this gate first. A host no counterpart declares is refused — every call
   * goes to a declared counterpart.
   */
  https(): HttpsRequestFn {
    return async options => {
      const host = new URL(options.url).hostname;
      const c = counterpartFor("http", host);
      if (!c) {
        throw new Error(`api-limits.json declares no limit for ${host}`);
      }
      const held = this.heldMs(host);
      if (held > 0) {
        // Answered here like the host would: every caller already handles a 429, and nothing reaches the host
        throw new HttpError("HTTP 429", 429, { "retry-after": String(Math.ceil(held / 1000)) });
      }
      await this.admit(c, host);
      try {
        return await httpsRequest(options);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 429) {
          this.hold(host, err.headers["retry-after"]);
        }
        throw err;
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
    const wait = Math.min(Math.max(ms, MIN_RATE_LIMIT_RETRY_MS), MAX_RATE_LIMIT_RETRY_MS);
    this.heldUntil.set(host, Math.max(this.heldUntil.get(host) ?? 0, this.now() + wait));
  }

  private key(c: Counterpart, index: number, limit: ApiLimit, host: string): string {
    return `${c.name}|${index}|${limit.per === "host" ? host : ""}`;
  }

  private window(key: string, limit: ApiLimit, now: number): number[] {
    const times = this.seen.get(key) ?? [];
    const kept = times.filter(t => now - t < limit.seconds * 1000);
    this.seen.set(key, kept);
    return kept;
  }
}
