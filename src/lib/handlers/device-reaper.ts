import type { DeviceManager } from "../device-manager";
import type { StateManager } from "../state-manager";

/** What the stale-device cleanup needs. */
export interface DeviceReaperAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** Diagnostics-export throttle, keyed per device — reaped with the device. */
}

/**
 * Delete ioBroker objects for devices no longer present and drop the same
 * devices from adapter-level maps. Diagnostics-buffer + diagnosticsLastRun
 * are reaped so removed-device data doesn't leak into the next adapter
 * lifetime.
 *
 * @param adapter Adapter surface
 */
export async function reapStaleDevices(adapter: DeviceReaperAdapter): Promise<void> {
  if (!adapter.stateManager || !adapter.deviceManager) {
    return;
  }
  // Absence only means something when the population is known, and only an
  // account list makes it known. Without one, `getDevices()` holds whatever
  // LAN discovery found plus whatever the cache happened to hold — and
  // cleaning up against that deletes live devices' trees including their
  // recorded history (measured: 249 of 249 objects with an empty cache, 132 of
  // 249 with a partial one).
  if (!adapter.deviceManager.hasKnownPopulation()) {
    adapter.log.debug("Device cleanup skipped: no account list answered this session — absence proves nothing");
    return;
  }
  // A list names a device the map lacks: fetch the Cloud list first — the
  // light's tree comes back with it, and this pass would judge a gap.
  if (adapter.deviceManager.reloadForAccountGap()) {
    return;
  }
  const currentDevices = adapter.deviceManager.getDevices();
  await adapter.stateManager.cleanupDevices(currentDevices, adapter.deviceManager.accountListedPrefixes());

  const liveDeviceIds = new Set(currentDevices.map(d => d.deviceId));
  adapter.deviceManager.getDiagnostics().pruneOrphans(liveDeviceIds);
}
