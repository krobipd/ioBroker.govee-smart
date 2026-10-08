import type { DeviceManager } from "../device-manager";
import type { LocalSnapshotStore } from "../local-snapshots";
import type { SnapshotHandlerHost } from "../snapshot-handler";
import type { StateManager } from "../state-manager";
import type { ConnectionStateAdapter } from "./connection-state";
import { onCloudDataReady, type DeviceEventsAdapter } from "./device-events";

/**
 * Adapter surface required to build the SnapshotHandler host. Loose
 * `setState` signature for utils.Adapter structural matching.
 */
export interface SnapshotHandlerGlueAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** The store of local snapshots. */
  readonly localSnapshots: LocalSnapshotStore | null;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** Read one own state. */
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
}

/**
 * Construct host object for {@link SnapshotHandler} — adapter dependencies
 * captured as closures so the handler stays decoupled from the adapter shape.
 *
 * @param adapter The adapter surface
 */
export function buildSnapshotHost(
  adapter: SnapshotHandlerGlueAdapter & DeviceEventsAdapter & ConnectionStateAdapter,
): SnapshotHandlerHost {
  return {
    log: adapter.log,
    store: adapter.localSnapshots!,
    namespace: adapter.namespace,
    devicePrefix: device => adapter.stateManager?.devicePrefix(device) ?? "",
    getState: id => adapter.getStateAsync(id),
    sendCommand: async (device, command, value) => {
      await adapter.deviceManager?.sendCommand(device, command, value);
    },
    segmentCount: device => adapter.deviceManager?.syncSegmentCount(device) ?? 0,
    refreshDeviceStates: device => {
      // Snapshot save/delete = new content in the snapshot_local dropdown —
      // Cloud-phase event. Fires onCloudDataReady to surface the change.
      onCloudDataReady(adapter, device, adapter.deviceManager?.getDevices() ?? []);
    },
  };
}
