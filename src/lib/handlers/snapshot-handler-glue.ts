import type { DeviceManager } from "../device-manager";
import type { LocalSnapshotStore } from "../local-snapshots";
import type { SnapshotHandlerHost } from "../snapshot-handler";
import type { StateManager } from "../state-manager";
import type { GoveeDevice } from "../types";

/**
 * Adapter surface required to build the SnapshotHandler host. Loose
 * `setState` signature for utils.Adapter structural matching.
 */
export interface SnapshotHandlerGlueAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly localSnapshots: LocalSnapshotStore | null;
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  fireCloudDataReady(device: GoveeDevice, allDevices: GoveeDevice[]): void;
}

/**
 * Construct host object for {@link SnapshotHandler} — adapter dependencies
 * captured as closures so the handler stays decoupled from the adapter shape.
 *
 */
export function buildSnapshotHost(adapter: SnapshotHandlerGlueAdapter): SnapshotHandlerHost {
  return {
    log: adapter.log,
    store: adapter.localSnapshots!,
    namespace: adapter.namespace,
    devicePrefix: device => adapter.stateManager?.devicePrefix(device) ?? "",
    getState: id => adapter.getStateAsync(id),
    sendCommand: async (device, command, value) => {
      await adapter.deviceManager?.sendCommand(device, command, value);
    },
    refreshDeviceStates: device => {
      // Snapshot save/delete = new content in the snapshot_local dropdown —
      // Cloud-phase event. Fires onCloudDataReady to surface the change.
      adapter.fireCloudDataReady(device, adapter.deviceManager?.getDevices() ?? []);
    },
  };
}
