import { errMessage, type CloudLoadResult } from "./types";
import { MIN_RATE_LIMIT_RETRY_MS, TRANSIENT_RETRY_MS } from "./timing-constants";

/**
 * Dependencies the retry loop needs. Extracting this interface decouples the
 * state machine from the adapter class so the reconnect behaviour can be
 * verified without standing up a full adapter fixture.
 */
export interface CloudRetryHost {
  /** Host logger (maps to `adapter.log`). */
  log: {
    debug(m: string): void;
    info(m: string): void;
    warn(m: string): void;
  };
  /** Schedule a managed timeout; must be cancellable via clearTimeout. */
  setTimeout: (cb: () => void, ms: number) => unknown;
  /** Cancel a previously scheduled timeout. */
  clearTimeout: (handle: unknown) => void;
  /** Perform one Cloud-load attempt — should include any own timeout wrapping. */
  loadFromCloud(): Promise<CloudLoadResult>;
  /** Hook called once after a successful retry (host refreshes states). */
  onCloudRestored(): Promise<void>;
}

/**
 * Background retry-loop for Govee Cloud connectivity.
 *
 * Handles the three failure modes of a Cloud load:
 *  - `auth-failed` → **stop permanently** (user must fix API-Key)
 *  - `rate-limited` → wait the server-supplied `retryAfterMs`, then retry once
 *  - `transient` → wait a fixed 5 min, then retry once
 *
 * A retry that still fails is handed back through {@link handleResult} so the
 * loop re-arms according to the new reason — a 429 that still 429s keeps
 * honouring Retry-After without escalating to transient.
 *
 * Idempotent: {@link handleResult} never queues a second timer while one is
 * already armed, and `connected=true` short-circuits further attempts.
 */
export class CloudRetryLoop {
  private retryTimer: unknown = undefined;
  private connected = false;
  private stopped = false;

  /** @param host Host interface wired up to the adapter. */
  constructor(private readonly host: CloudRetryHost) {}

  /**
   * Update the loop's view of whether Cloud is currently connected. Adapter
   * calls this after cache hits, initial success, and manual recoveries.
   *
   * @param ok New connection state
   */
  public setConnected(ok: boolean): void {
    this.connected = ok;
    if (ok && this.retryTimer !== undefined) {
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /** Cancel any pending retry. Called from onUnload. */
  public dispose(): void {
    if (this.retryTimer !== undefined) {
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * React to a {@link CloudLoadResult}. On `ok` nothing happens — the caller
   * is expected to flip {@link setConnected} separately. On failure the loop
   * either stops (auth), schedules a specific delay (rate-limit), or falls
   * back to the transient-retry delay.
   *
   * @param result Most recent Cloud-load outcome
   */
  public handleResult(result: CloudLoadResult): void {
    if (result.ok) {
      return;
    }
    switch (result.reason) {
      case "auth-failed":
        this.stopped = true;
        if (this.retryTimer !== undefined) {
          this.host.clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
        }
        this.host.log.warn(
          `Govee Cloud: authentication failed — check API-Key in adapter settings. Not retrying automatically.`,
        );
        return;
      case "rate-limited": {
        // Floor the server's Retry-After so a 0 / malformed value can't turn
        // into an immediate-retry tight loop that hammers the Cloud (L5).
        const pauseMs = Math.max(result.retryAfterMs, MIN_RATE_LIMIT_RETRY_MS);
        this.host.log.warn(`Govee Cloud: rate-limited — pausing for ${Math.round(pauseMs / 1000)}s before retry`);
        this.schedule(pauseMs);
        return;
      }
      case "transient":
      default:
        this.schedule(TRANSIENT_RETRY_MS);
        return;
    }
  }

  /**
   * (Re-)arm the retry timer unless one is already queued or we're stopped.
   *
   * @param delayMs How long to wait before the next retry
   */
  private schedule(delayMs: number): void {
    if (this.stopped || this.connected) {
      return;
    }
    if (this.retryTimer !== undefined) {
      return;
    }
    this.retryTimer = this.host.setTimeout(() => {
      this.retryTimer = undefined;
      this.runAttempt().catch(e => this.host.log.debug(`Cloud retry failed: ${errMessage(e)}`));
    }, delayMs);
  }

  /** Internal retry step — one load call, route the result. */
  private async runAttempt(): Promise<void> {
    if (this.connected || this.stopped) {
      return;
    }
    const result = await this.host.loadFromCloud();
    if (this.stopped) {
      // dispose() ran while loadFromCloud was in flight — don't log "restored"
      // or fire onCloudRestored after unload (L13).
      return;
    }
    if (result.ok) {
      this.connected = true;
      this.host.log.info("Govee Cloud connection restored");
      await this.host.onCloudRestored();
    } else {
      this.handleResult(result);
    }
  }
}
