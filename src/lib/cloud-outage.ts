import { CLOUD_UNREACHABLE_CONFIRM_MS } from "./timing-constants";

/**
 * Whether the Govee Cloud is down — decided from the outcome of real calls,
 * never from a probe of its own (2.41.0, issue #51).
 *
 * A call that could not reach Govee (no answer, 5xx) is noted; a second one at
 * least {@link CLOUD_UNREACHABLE_CONFIRM_MS} later, with no accepted answer in
 * between, confirms the outage. Any accepted answer ends it. Separate from
 * `cloudWasConnected`, which keeps meaning "API key accepted / list loaded" —
 * the auth guard and the list-retry loop read that one unchanged.
 */
export class CloudOutage {
  private firstFailureAt: number | null = null;
  private firstReason = "";
  private isConfirmed = false;

  /** The outage is confirmed — `info.cloudConnected` shows false. */
  get confirmed(): boolean {
    return this.isConfirmed;
  }

  /** When the first failed call of the current run happened, or null. */
  get since(): number | null {
    return this.firstFailureAt;
  }

  /** Why the first failed call of the current run failed. */
  get reason(): string {
    return this.firstReason;
  }

  /**
   * Note a call that could not reach Govee.
   *
   * @param now Time of the failure (ms)
   * @param reason The error text of the failed call
   * @returns true exactly when this failure confirms the outage
   */
  noteUnreachable(now: number, reason: string): boolean {
    if (this.isConfirmed) {
      return false;
    }
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
      this.firstReason = reason;
      return false;
    }
    if (now - this.firstFailureAt < CLOUD_UNREACHABLE_CONFIRM_MS) {
      return false;
    }
    this.isConfirmed = true;
    return true;
  }

  /**
   * Note an answer Govee accepted.
   *
   * @returns true exactly when this answer ends a confirmed outage
   */
  noteAnswer(): boolean {
    const wasConfirmed = this.isConfirmed;
    this.firstFailureAt = null;
    this.firstReason = "";
    this.isConfirmed = false;
    return wasConfirmed;
  }
}

/** The two fields {@link cloudReachable} reads from the handler host. */
export interface CloudReachabilityView {
  /** Key accepted / list loaded. */
  readonly cloudWasConnected: boolean;
  /** The outage tracker fed by the Cloud contact hook. */
  readonly cloudOutage: { readonly confirmed: boolean };
}

/**
 * The Cloud as the user sees it: the key is accepted / the list is loaded
 * (`cloudWasConnected`) AND real calls do not say it is down (issue #51).
 *
 * @param adapter Handler host
 */
export function cloudReachable(adapter: CloudReachabilityView): boolean {
  return adapter.cloudWasConnected && !adapter.cloudOutage.confirmed;
}
