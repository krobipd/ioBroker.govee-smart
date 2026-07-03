import { CloudRetryLoop, type CloudRetryHost } from "../cloud-retry";
import type { DeviceManager } from "../device-manager";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { StateManager } from "../state-manager";
import type { ActionableProblems } from "../actionable-problems";
import type { CloudLoadResult } from "../types";
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
      adapter.cloudWasConnected = true;
      adapter.setState("info.cloudConnected", { val: true, ack: true }).catch(() => {});
      adapter.stateManager?.updateGroupsOnline(true).catch(() => {});
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
 * React to a Cloud-load outcome — delegates to {@link CloudRetryLoop}.
 *
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
  ensureCloudRetry(adapter).handleResult(result);
}
