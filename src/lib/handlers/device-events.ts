import { buildCloudStateDefs } from "../capability-mapper";
import type { DeviceManager } from "../device-manager";
import type { DeviceRegistry } from "../device-registry";
import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import type { LocalSnapshotStore } from "../local-snapshots";
import type { StateManager } from "../state-manager";
import { deviceLabel, errMessage, type DeviceState, type GoveeDevice } from "../types";
import * as connectionState from "./connection-state";
import * as groupFanoutHandler from "./group-fanout-handler";
import * as dropdownReset from "./dropdown-reset-helpers";

/**
 * Adapter surface required by the device-event helpers — covers the
 * onDeviceStateUpdate + onDeviceListChanged + refreshDeviceStates path.
 *
 * Composes ConnectionStateAdapter (for updateConnectionState) plus
 * GroupFanoutHandlerAdapter and GroupStateHelpersAdapter via duck-typing
 * — the calling adapter implements all three sets implicitly.
 */
export interface DeviceEventsAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  readonly localSnapshots: LocalSnapshotStore | null;
  /** This instance's device catalog (quirks + trust tier for the state-defs). */
  readonly deviceRegistry: DeviceRegistry;
  readonly statesReady: boolean;
  readonly stateCreationQueue: Promise<void>[];
  /** Re-fired into stateManager + connection-state + groupFanout-reachability. */
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
  /** Optional reapStaleDevices delegate — owned by main.ts because it touches diagnosticsLastRun. */
  reapStaleDevices?(): Promise<void>;
}

/**
 * Called by device-manager when a device's per-state values change. Mirrors
 * the updates into stateManager, refreshes the global connection-state
 * indicator, updates group reachability, and resets all mode dropdowns
 * when the device just powered off (the user shouldn't see "playing
 * Aurora-A" on a device that's off).
 *
 */
export function onDeviceStateUpdate<
  T extends DeviceEventsAdapter &
    connectionState.ConnectionStateAdapter &
    groupFanoutHandler.GroupFanoutHandlerAdapter &
    dropdownReset.GroupStateHelpersAdapter,
>(adapter: T, device: GoveeDevice, state: Partial<DeviceState>): void {
  // Package A: don't mirror values before the initial object-creation batch has
  // finished — a fast LAN devStatus can otherwise write control.color_rgb before
  // createLanStates declared the object ("has no existing object"). Mirrors the
  // trackStateCreation gate; the next LAN poll / MQTT push re-delivers the value.
  if (adapter.statesReady && adapter.stateManager) {
    adapter.stateManager.updateDeviceState(device, state).catch(() => {});
  }
  connectionState.updateConnectionState(adapter);

  if (state.online !== undefined) {
    groupFanoutHandler.updateGroupReachability(adapter);
    // For Lights the updateDeviceState path no longer writes info.online —
    // syncInfoOnline owns it. Trigger it here so a wasOffline → online
    // transition from handleLanDiscovery reflects in info.online within
    // milliseconds instead of waiting up to one sync-timer cycle (20 s).
    if (device.type === GOVEE_DEVICE_TYPE.LIGHT && adapter.stateManager) {
      adapter.stateManager.syncInfoOnline(device).catch(() => undefined);
    }
  }

  // Mirror power-off to mode-dropdown reset. Covers MQTT/LAN-initiated
  // power changes (Govee app or physical remote) so the UI stays honest:
  // a device that's off can't be "playing Aurora-A" anymore.
  // L11 — defensively accept 0 as false too (Govee should send power as a
  // boolean, but the MQTT boundary could let a 0 slip through).
  const powerOff = state.power === false || (state.power as unknown) === 0;
  if (powerOff && adapter.stateManager) {
    const prefix = adapter.stateManager.devicePrefix(device);
    dropdownReset.resetModeDropdowns(adapter, prefix, "").catch(() => undefined);
  }
}

/**
 * Internal — schedule a state-creation promise. Until adapter.statesReady,
 * promises accumulate in stateCreationQueue so onReady can await the full
 * initial batch. After ready, fire-and-forget.
 */
function trackStateCreation(adapter: DeviceEventsAdapter, p: Promise<void>): void {
  if (!adapter.statesReady) {
    adapter.stateCreationQueue.push(p);
  } else {
    void p;
  }
}

/**
 * Phase 1 callback — LAN-Discovery has found a device. Creates info-channel
 * states (always-existing metadata) plus LAN-default control states (power,
 * brightness, colorRgb, colorTemperature).
 *
 * Does NOT create scenes/music/snapshots — those need Cloud data. If the
 * device later gets cloud capabilities, onCloudDataReady will fill them in
 * additively.
 *
 */
export function onLanDeviceReady<T extends DeviceEventsAdapter & connectionState.ConnectionStateAdapter>(
  adapter: T,
  device: GoveeDevice,
  _allDevices: GoveeDevice[],
): void {
  if (!adapter.stateManager) {
    return;
  }
  const sm = adapter.stateManager;
  const p = (async () => {
    await sm.createInfoStates(device);
    await sm.createLanStates(device);
  })().catch(e => {
    adapter.log.error(`onLanDeviceReady failed for ${deviceLabel(device)}: ${errMessage(e)}`);
  });
  trackStateCreation(adapter, p);
  connectionState.updateConnectionState(adapter);
}

/**
 * Phase 2 callback — Cloud-Data is available for a device (from cache-merge,
 * loadFromCloud success, refreshSceneDataForDevice, snapshot save/delete, or
 * wizard-apply). Creates the full state-tree: info + LAN + Cloud states.
 *
 * createInfoStates and createLanStates are idempotent — calling them again
 * after a LAN-phase has run only updates `info.online`/`info.ip` values.
 *
 */
export function onCloudDataReady<T extends DeviceEventsAdapter & connectionState.ConnectionStateAdapter>(
  adapter: T,
  device: GoveeDevice,
  allDevices: GoveeDevice[],
): void {
  if (!adapter.stateManager) {
    return;
  }
  const sm = adapter.stateManager;
  const localSnaps = adapter.localSnapshots?.getSnapshots(device.sku, device.deviceId);
  let memberDevices: GoveeDevice[] | undefined;
  if (device.sku === "BaseGroup" && device.groupMembers) {
    memberDevices = groupFanoutHandler.resolveGroupMembers(device, allDevices);
  }
  const cloudDefs = buildCloudStateDefs(device, adapter.log, adapter.deviceRegistry, localSnaps, memberDevices);
  const capN = Array.isArray(device.capabilities) ? device.capabilities.length : 0;
  adapter.log.debug(
    `buildCloudStateDefs for ${device.sku} ${device.deviceId}: ${capN} cap(s) in → ${cloudDefs.length} state def(s) out`,
  );
  const p = (async () => {
    await sm.createInfoStates(device);
    await sm.createLanStates(device);
    await sm.createCloudStates(device, cloudDefs);
    await sm.migrateLegacyDiagnostics(device);
    await sm.updateDeviceTier(device, adapter.deviceRegistry.getTier(device.sku));
  })().catch(e => {
    adapter.log.error(`onCloudDataReady failed for ${deviceLabel(device)}: ${errMessage(e)}`);
  });
  trackStateCreation(adapter, p);
  connectionState.updateConnectionState(adapter);
  if (adapter.statesReady) {
    adapter.reapStaleDevices?.().catch(() => undefined);
  }
}

/**
 * Phase 3 callback — Group members have been resolved (loadGroupMembers
 * success). Rebuilds the BaseGroup state-tree with the intersection of
 * member device capabilities.
 *
 * Member devices fire their own onLanDeviceReady / onCloudDataReady
 * independently — this callback only handles the group itself.
 *
 */
export function onGroupMembersReady<T extends DeviceEventsAdapter & connectionState.ConnectionStateAdapter>(
  adapter: T,
  group: GoveeDevice,
  allDevices: GoveeDevice[],
): void {
  // BaseGroups go through the same Cloud-data path — group state-defs are
  // intersection of member capabilities, which is Cloud-derived.
  onCloudDataReady(adapter, group, allDevices);
}
