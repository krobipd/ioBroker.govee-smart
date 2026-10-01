import { CloudRetryLoop, type CloudRetryHost } from "../cloud-retry";
import { cloudReachable, type CloudOutage } from "../cloud-outage";
import type { DeviceManager } from "../device-manager";
import type { CloudContact, GoveeCloudClient } from "../govee-cloud-client";
import type { StateManager } from "../state-manager";
import type { ActionableProblems } from "../actionable-problems";
import { deviceLabel, logRejected, type CloudLoadResult, type GoveeDevice } from "../types";
import { READY_TIMEOUT_MS } from "../timing-constants";
import { sessionKey } from "../device-key";
import { loadCloudStates, type CloudStateLoaderAdapter } from "./cloud-state-loader";
import type { ConnectionStateAdapter } from "./connection-state";
import { reapStaleDevices } from "./device-reaper";

/**
 * Adapter surface required by the cloud-retry handler. Mutates several
 * adapter fields so they need to be writable from outside.
 */
export interface CloudRetryHandlerAdapter extends CloudStateLoaderAdapter {
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
  /** Whether real calls say the Cloud is down (issue #51) — see {@link cloudReachable}. */
  readonly cloudOutage: CloudOutage;
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  clearTimeout: (h: ioBroker.Timeout) => void;
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
      markCloudListAccepted(adapter);
      // The start-up list failed, so its group-member step never saw a list (M9).
      await adapter.deviceManager?.loadGroupMembers();
      await treesBuilt(adapter, adapter.deviceManager?.getDevices() ?? []);
      await loadCloudStates(adapter);
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
 * `cloudWasConnected` (key accepted / list loaded) plus the two datapoints
 * `info.cloudConnected` and `groups.info.online`, which show
 * {@link cloudReachable} — that also counts a confirmed outage. The datapoints
 * are written only when their value changes.
 *
 * @param adapter Handler host
 * @param ok Whether the Cloud is reachable with the configured API key
 */
export function setCloudConnected(adapter: CloudRetryHandlerAdapter, ok: boolean): void {
  adapter.cloudWasConnected = ok;
  showCloudReachability(adapter);
}

/**
 * Write `info.cloudConnected` + `groups.info.online` when {@link cloudReachable}
 * changed — only then, so the per-call contact hook costs no state write.
 *
 * @param adapter Handler host
 */
function showCloudReachability(adapter: CloudRetryHandlerAdapter): void {
  const shown = cloudReachable(adapter);
  if (adapter.cloudConnectedShown === shown) {
    return;
  }
  adapter.cloudConnectedShown = shown;
  adapter
    .setState("info.cloudConnected", { val: shown, ack: true })
    .catch(logRejected(adapter.log, "write info.cloudConnected"));
  adapter.stateManager?.updateGroupsOnline(shown).catch(logRejected(adapter.log, "write groups.info.online"));
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
 * A call that could not reach Govee (`unreachable`) only feeds the outage
 * tracker: the second one a minute after the first, with no accepted answer in
 * between, shows the Cloud as down (issue #51). It never reaches the auth path,
 * never touches the retry loop and triggers no call of its own — the lessons of
 * 2.32.1 (a Cloud outage deleted a device tree) and #39 (retries into a 24 h
 * account block).
 *
 * @param adapter Handler host
 * @param outcome What the call said
 * @param reason The error text of an `unreachable` call
 */
export function onCloudContact(adapter: CloudRetryHandlerAdapter, outcome: CloudContact, reason?: string): void {
  if (outcome === "unreachable") {
    const now = Date.now();
    if (adapter.cloudOutage.noteUnreachable(now, reason ?? "no answer")) {
      const since = new Date(adapter.cloudOutage.since ?? now).toTimeString().slice(0, 8);
      adapter.log.warn(
        `Govee Cloud not reachable since ${since} (${adapter.cloudOutage.reason}) — commands over the Cloud fail until it answers again, LAN keeps working`,
      );
      showCloudReachability(adapter);
    }
    return;
  }
  if (outcome === "ok") {
    if (adapter.cloudOutage.noteAnswer()) {
      adapter.log.info("Govee Cloud reachable again");
    }
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

/**
 * What every accepted Cloud device list sets right — the start, a restored connection and the manual sync alike:
 * a rejected key is resolved, the Cloud shows reachable, and the retry loop stands down. Until 3.1.0 the manual
 * sync did none of it: after a failed start a successful sync left `info.cloudConnected` false and the armed retry
 * later logged "connection restored" (audit DRY-2).
 *
 * @param adapter Handler host
 */
export function markCloudListAccepted(adapter: CloudRetryHandlerAdapter): void {
  adapter.actionableProblems.resolve("cloud-auth", "Govee Cloud connected — API key accepted");
  setCloudConnected(adapter, true);
  ensureCloudRetry(adapter).setConnected(true);
}

/**
 * A start from the cache: the cache stands in for the device list, so the retry loop has nothing to fetch and a
 * Cloud-only light counts as reachable. The two datapoints wait for the first call Govee actually accepts (contact
 * hook) — a cache start has not talked to the Cloud yet. Here, not in main.ts: `cloudWasConnected` has its writers
 * in this module only (audit, Niedrig).
 *
 * @param adapter Handler host
 */
export function markCachedListAccepted(adapter: CloudRetryHandlerAdapter): void {
  adapter.cloudWasConnected = true;
  ensureCloudRetry(adapter).setConnected(true);
}

/**
 * Manual "sync devices" button (info.manualSyncDevices): pull the fresh Govee account device list and reconcile
 * it — new devices are onboarded, devices deleted from the account are removed — without a restart. A device the
 * list brought in gets its start value; the devices already known are not read again (each read costs the
 * device's daily Cloud budget), and their scene/snapshot data is untouched (the per-device refresh does that).
 *
 * @param adapter Handler host
 */
export async function syncDevicesManually(adapter: CloudRetryHandlerAdapter & ConnectionStateAdapter): Promise<void> {
  if (!adapter.deviceManager) {
    return;
  }
  if (!adapter.cloudClient) {
    // The account device list is a Cloud call — without an API key there is
    // nothing to fetch, and a "failed" warning plus a retry loop that can
    // never succeed would tell the user something false.
    adapter.log.info("Manual device sync needs the Cloud API key (adapter settings) — nothing to sync");
    return;
  }
  const known = new Set(adapter.deviceManager.getDevices().map(d => sessionKey(d.sku, d.deviceId)));
  const result = await adapter.deviceManager.loadFromCloud();
  if (!result.ok) {
    // Same single mechanism as the init/retry path: auth-failed reaches the
    // ActionableProblems registry, every other failure arms the retry loop —
    // also on a running adapter whose loop counted the list as loaded.
    // Plus one non-deduplicated line — the user explicitly pressed the
    // button and must see why nothing happened (M4).
    adapter.log.warn(`Manual device sync failed (${result.reason}) — see earlier log for details`);
    handleCloudFailure(adapter, result);
    return;
  }
  markCloudListAccepted(adapter);
  // A group added in the app since the start gets its members now (M9).
  await adapter.deviceManager.loadGroupMembers();
  await reapStaleDevices(adapter);
  const added = adapter.deviceManager.getDevices().filter(d => !known.has(sessionKey(d.sku, d.deviceId)));
  await treesBuilt(adapter, added);
  for (const device of added) {
    await loadCloudStates(adapter, device);
  }
  // The user pressed the button — the result goes on info (logging strategy: a user action reports it).
  adapter.log.info(
    added.length === 0
      ? "Manual device sync done — no new device"
      : `Manual device sync done — ${added.length} new: ${added.map(d => deviceLabel(d)).join(", ")}`,
  );
}

/**
 * Wait until the tree builds queued for these devices are done. A list that brings a device queues its build and
 * returns; a value read right after would be written before its object exists — js-controller's "has no existing
 * object" warning (the start avoids it by draining the queue first).
 *
 * @param adapter Handler host
 * @param devices The devices about to be read
 */
async function treesBuilt(adapter: CloudRetryHandlerAdapter, devices: readonly GoveeDevice[]): Promise<void> {
  await Promise.all(devices.map(device => adapter.stateManager!.runDeviceBuild(device, () => Promise.resolve())));
}
