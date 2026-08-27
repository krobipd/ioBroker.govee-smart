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
var cloud_retry_exports = {};
__export(cloud_retry_exports, {
  CloudRetryLoop: () => CloudRetryLoop
});
module.exports = __toCommonJS(cloud_retry_exports);
var import_types = require("./types");
var import_timing_constants = require("./timing-constants");
class CloudRetryLoop {
  /** @param host Host interface wired up to the adapter. */
  constructor(host) {
    this.host = host;
  }
  host;
  retryTimer = void 0;
  connected = false;
  stopped = false;
  /**
   * Update the loop's view of whether Cloud is currently connected. Adapter
   * calls this after cache hits, initial success, and manual recoveries.
   *
   * @param ok New connection state
   */
  setConnected(ok) {
    this.connected = ok;
    if (ok && this.retryTimer !== void 0) {
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = void 0;
    }
  }
  /**
   * Cancel any pending retry and stop the loop for good. Called from onUnload.
   *
   * `stopped` is what makes the post-load check in {@link runAttempt} bite: a
   * loadFromCloud already in flight when the adapter unloads resolves AFTER
   * teardown, and without this flag it logged "Cloud connection restored" and
   * ran onCloudRestored — setState + a full cloud-state rebuild against a
   * torn-down adapter. Clearing the timer alone never stopped that path.
   */
  dispose() {
    this.stopped = true;
    if (this.retryTimer !== void 0) {
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = void 0;
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
  handleResult(result) {
    if (result.ok) {
      return;
    }
    switch (result.reason) {
      case "auth-failed":
        this.stopped = true;
        if (this.retryTimer !== void 0) {
          this.host.clearTimeout(this.retryTimer);
          this.retryTimer = void 0;
        }
        this.host.log.warn(
          `Govee Cloud: authentication failed \u2014 check API-Key in adapter settings. Not retrying automatically.`
        );
        return;
      case "rate-limited": {
        const pauseMs = Math.max(result.retryAfterMs, import_timing_constants.MIN_RATE_LIMIT_RETRY_MS);
        this.host.log.warn(`Govee Cloud: rate-limited \u2014 pausing for ${Math.round(pauseMs / 1e3)}s before retry`);
        this.schedule(pauseMs);
        return;
      }
      case "transient":
      default:
        this.schedule(import_timing_constants.TRANSIENT_RETRY_MS);
        return;
    }
  }
  /**
   * (Re-)arm the retry timer unless one is already queued or we're stopped.
   *
   * @param delayMs How long to wait before the next retry
   */
  schedule(delayMs) {
    if (this.stopped || this.connected) {
      return;
    }
    if (this.retryTimer !== void 0) {
      return;
    }
    this.retryTimer = this.host.setTimeout(() => {
      this.retryTimer = void 0;
      this.runAttempt().catch((e) => this.host.log.debug(`Cloud retry failed: ${(0, import_types.errMessage)(e)}`));
    }, delayMs);
  }
  /** Internal retry step — one load call, route the result. */
  async runAttempt() {
    if (this.connected || this.stopped) {
      return;
    }
    const result = await this.host.loadFromCloud();
    if (this.stopped) {
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CloudRetryLoop
});
//# sourceMappingURL=cloud-retry.js.map
