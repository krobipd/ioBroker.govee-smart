import { CloudRetryLoop, type CloudRetryHost } from "../cloud-retry";
import type { DeviceManager } from "../device-manager";
import type { CloudContact, GoveeCloudClient } from "../govee-cloud-client";
import type { StateManager } from "../state-manager";
import type { ActionableProblems } from "../actionable-problems";
import { logRejected, type CloudLoadResult } from "../types";
import { READY_TIMEOUT_MS } from "../timing-constants";

/**
 * Adapter surface required by the cloud-retry handler. Mutates several
 * adapter fields so they need to be writable from outside.
 */
export interface CloudRetryHandlerAdapter {
  readonly log: ioBroker.Logger;
  readonly deviceManager: DeviceManager | null;
  readonly cloudClient: GoveeCloudClient | null;
  readonly stateManager: StateManager | null;
  cloudInitTimer: ioBroker.Timeout | undefined;
  cloudRetry: CloudRetryLoop | undefined;
  cloudWasConnected: boolean;
  /**
   * The value `info.cloudConnected` and `groups.info.online` carry right now —
   * {@link setCloudConnected} writes only a change, so the per-call contact
   * hook does not turn every Cloud answer into two state writes.
   */
  cloudConnectedShown: boolean;
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  clearTimeout: (h: ioBroker.Timeout) => void;
  /** Reload Cloud-state-tree after a recovered connection. */
  loadCloudStates(): Promise<void>;
  /** Registry to surface a rejected API key as a user-actionable problem. */
  readonly actionableProblems: ActionableProblems;
}

/**
 * Initial cloud load with a 60-second hard timeout. Doesn't block any longer —
 * if the cloud hangs the adapter continues with LAN+MQTT and the retry loop
 * tries again according to the failure reason.
 *
 */
export async function cloudInitWithTimeout(adapter: CloudRetryHandlerAdapter): Promise<CloudLoadResult> {
  if (!adapter.deviceManager) {
    return { ok: false, reason: "transient" };
  }
  const loadPromise = adapter.deviceManager.loadFromCloud();
  const timeoutPromise = new Promise<CloudLoadResult>(resolve => {
    adapter.cloudInitTimer = adapter.setTimeout(() => resolve({ ok: false, reason: "transient" }), READY_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([loadPromise, timeoutPromise]);
    if (adapter.cloudInitTimer) {
      adapter.clearTimeout(adapter.cloudInitTimer);
      adapter.cloudInitTimer = undefined;
    }
    return result;
  } catch {
    if (adapter.cloudInitTimer) {
      adapter.clearTimeout(adapter.cloudInitTimer);
      adapter.cloudInitTimer = undefined;
    }
    return { ok: false, reason: "transient" };
  }
}

/**
 * Build the host object for {@link CloudRetryLoop}.
 *
 */
export function buildCloudRetryHost(adapter: CloudRetryHandlerAdapter): CloudRetryHost {
  return {
    log: adapter.log,
    setTimeout: (cb, ms) => adapter.setTimeout(cb, ms),
    clearTimeout: h => adapter.clearTimeout(h as ioBroker.Timeout),
    loadFromCloud: () => cloudInitWithTimeout(adapter),
    onCloudRestored: async () => {
      adapter.actionableProblems.resolve("cloud-auth", "Govee Cloud connected — API key accepted");
      setCloudConnected(adapter, true);
      // The start-up list failed, so its group-member step never saw a list (M9).
      await adapter.deviceManager?.loadGroupMembers();
      await adapter.loadCloudStates();
    },
  };
}

/**
 * Lazy-initialise the retry loop on first use.
 *
 */
export function ensureCloudRetry(adapter: CloudRetryHandlerAdapter): CloudRetryLoop {
  if (!adapter.cloudRetry) {
    adapter.cloudRetry = new CloudRetryLoop(buildCloudRetryHost(adapter));
    adapter.cloudRetry.setConnected(adapter.cloudWasConnected);
  }
  return adapter.cloudRetry;
}

/**
 * The one place that decides the Cloud reachability the user sees:
 * `cloudWasConnected` (device reachability, summary line) plus the two
 * datapoints `info.cloudConnected` and `groups.info.online`. The datapoints
 * are written only when their value changes.
 *
 * @param adapter Handler host
 * @param ok Whether the Cloud is reachable with the configured API key
 */
export function setCloudConnected(adapter: CloudRetryHandlerAdapter, ok: boolean): void {
  adapter.cloudWasConnected = ok;
  if (adapter.cloudConnectedShown === ok) {
    return;
  }
  adapter.cloudConnectedShown = ok;
  adapter
    .setState("info.cloudConnected", { val: ok, ack: true })
    .catch(logRejected(adapter.log, "write info.cloudConnected"));
  adapter.stateManager?.updateGroupsOnline(ok).catch(logRejected(adapter.log, "write groups.info.online"));
}

/**
 * One Cloud answer said something about the API key (the client's contact
 * hook). An accepted call shows the Cloud as reachable again and lifts an
 * earlier auth stop of the retry loop — it does NOT mark the device list as
 * loaded, so a pending list retry keeps running. A 401/403 while the Cloud
 * counted as reachable (shown, or assumed by a cache start) routes into
 * {@link handleCloudFailure} once; the repeats of an already rejected key —
 * and the 401 of a failing initial list load, which reports itself — stay
 * silent.
 *
 * @param adapter Handler host
 * @param outcome What the answer said about the key
 */
export function onCloudContact(adapter: CloudRetryHandlerAdapter, outcome: CloudContact): void {
  if (outcome === "ok") {
    adapter.actionableProblems.resolve("cloud-auth", "Govee Cloud connected — API key accepted");
    adapter.cloudRetry?.noteKeyAccepted();
    setCloudConnected(adapter, true);
    return;
  }
  if (adapter.cloudConnectedShown || adapter.cloudWasConnected) {
    handleCloudFailure(adapter, { ok: false, reason: "auth-failed", message: "Govee answered 401/403" });
  }
}

/**
 * React to a failed Cloud load (init, manual sync, retry) — the reachability
 * falls to false, and the retry loop re-arms by the failure reason even when
 * it believed the list loaded: a failed manual sync of a running adapter
 * arms a retry again instead of being dropped by the loop's `connected` guard.
 *
 * @param adapter Handler host
 * @param result The failed load outcome
 */
export function handleCloudFailure(adapter: CloudRetryHandlerAdapter, result: CloudLoadResult): void {
  if (!result.ok && result.reason === "auth-failed") {
    adapter.actionableProblems.report({
      key: "cloud-auth",
      title: "Govee rejected the Cloud API key",
      action:
        "check the API key in the adapter settings (Cloud API section); generate a fresh one in the Govee Home app if needed",
    });
  }
  setCloudConnected(adapter, false);
  const loop = ensureCloudRetry(adapter);
  loop.setConnected(false);
  loop.handleResult(result);
}
