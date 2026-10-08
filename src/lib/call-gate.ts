// The gate that keeps the short windows of api-limits.json (GV-08) — per adapter instance.
import { counterpartFor, type ApiLimit, type Counterpart } from "./api-limits";
import { httpsRequest, type HttpsRequestFn } from "./http-client";

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
    let wait = 0;
    for (const [i, limit] of c.limits.entries()) {
      if (limit.seconds > GATE_MAX_WINDOW_SECONDS) {
        continue;
      }
      const times = this.window(this.key(c, i, limit, host), limit, now);
      if (times.length >= limit.max) {
        wait = Math.max(wait, times[times.length - limit.max] + limit.seconds * 1000 - now + 1);
      }
    }
    return wait;
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
      await this.admit(c, host);
      return httpsRequest(options);
    };
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
