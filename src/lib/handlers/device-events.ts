import { buildCloudStateDefs, libraryDecidesPending } from "../capability-mapper";
import type { DeviceManager } from "../device-manager";
import type { DeviceRegistry } from "../device-registry";
import { GOVEE_DEVICE_TYPE, isAppGroup } from "../govee-constants";
import type { LocalSnapshotStore } from "../local-snapshots";
import type { StateManager } from "../state-manager";
import { resolveSegmentCount, type MqttSegmentData } from "../device-manager/lookups";
import {
  deviceLabel,
  errText,
  logRejected,
  type DeviceState,
  type DeviceStateChanges,
  type GoveeDevice,
} from "../types";
import { rgbIntToHex, rgbToHex } from "../color";
import * as connectionState from "./connection-state";
import { reapStaleDevices } from "./device-reaper";
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
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** The store of local snapshots. */
  readonly localSnapshots: LocalSnapshotStore | null;
  /** This instance's device catalog (quirks + trust tier for the state-defs). */
  readonly deviceRegistry: DeviceRegistry;
  /** Whether the device trees are built. */
  readonly statesReady: boolean;
  /** The tree builds still running. */
  readonly stateCreationQueue: Promise<void>[];
  /** Re-fired into stateManager + connection-state + groupFanout-reachability. */
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
}

/**
 * Called by device-manager when a device's per-state values change. Mirrors
 * the updates into stateManager, refreshes the global connection-state
 * indicator, updates group reachability, and resets all mode dropdowns
 * when the device just powered off (the user shouldn't see "playing
 * Aurora-A" on a device that's off).
 *
 * @param adapter The adapter surface
 * @param device The device
 * @param state The state values that changed
 * @param changes Which values changed, when the caller knows
 */
export function onDeviceStateUpdate<
  T extends DeviceEventsAdapter &
    connectionState.ConnectionStateAdapter &
    groupFanoutHandler.GroupFanoutHandlerAdapter &
    dropdownReset.GroupStateHelpersAdapter,
>(adapter: T, device: GoveeDevice, state: Partial<DeviceState>, changes?: DeviceStateChanges): void {
  // Package A: don't mirror values before the initial object-creation batch has
  // finished — a fast LAN devStatus can otherwise write control.color_rgb before
  // createLanStates declared the object ("has no existing object"). Mirrors the
  // trackStateCreation gate. The value is dropped, not held: the next LAN status
  // read (every scan without the account broker, at least once a minute with
  // it — audit B5) or MQTT push re-delivers it.
  if (adapter.statesReady && adapter.stateManager) {
    adapter.stateManager.updateDeviceState(device, state).catch(logRejected(adapter.log, "mirror device state"));
  }
  connectionState.updateConnectionState(adapter);

  if (state.online !== undefined) {
    groupFanoutHandler.updateGroupReachability(adapter);
    // For Lights the updateDeviceState path no longer writes info.online —
    // syncInfoOnline owns it. Trigger it here so a wasOffline → online
    // transition from handleLanDiscovery reflects in info.online within
    // milliseconds instead of waiting up to one sync-timer cycle (20 s).
    if (device.type === GOVEE_DEVICE_TYPE.LIGHT && adapter.stateManager) {
      adapter.stateManager.syncInfoOnline(device).catch(logRejected(adapter.log, "refresh info.online"));
    }
  }

  // Mirror power-off to mode-dropdown reset. Covers MQTT/LAN-initiated
  // power changes (Govee app or physical remote) so the UI stays honest:
  // a device that's off can't be "playing Aurora-A" anymore.
  // L11 — defensively accept 0 as false too (Govee should send power as a
  // boolean, but the MQTT boundary could let a 0 slip through).
  // Only on the TRANSITION when the source says so: the LAN poll repeats
  // `power:false` every 30 s (the repeat is what keeps control.power honest
  // after a lost command), and resetting on each repeat read five dropdown
  // states per poll and per switched-off light (audit 2026-09-12, F7).
  // Sources that report changes only pass no flag and reset as before.
  const powerOff = state.power === false || (state.power as unknown) === 0;
  if (powerOff && (changes?.powerFlipped ?? true) && adapter.stateManager) {
    const prefix = adapter.stateManager.devicePrefix(device);
    dropdownReset.resetModeDropdowns(adapter, prefix, "").catch(logRejected(adapter.log, "reset mode dropdowns"));
  }
}

/**
 * Internal — schedule a state-creation promise. Until adapter.statesReady,
 * promises accumulate in stateCreationQueue so onReady can await the full
 * initial batch. After ready, fire-and-forget.
 *
 * @param adapter The adapter surface
 * @param p The state-creation promise
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
 * @param adapter The adapter surface
 * @param device The device
 * @param _allDevices Every device the adapter knows
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
  const p = sm
    .runDeviceBuild(device, async () => {
      await sm.createInfoStates(device);
      await sm.createLanStates(device);
    })
    .catch(e => {
      adapter.log.error(`onLanDeviceReady failed for ${deviceLabel(device)}: ${errText(e)}`);
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
 * @param adapter The adapter surface
 * @param device The device
 * @param allDevices Every device the adapter knows
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
  // A group is only a group once its members are known. Without account
  // credentials they are never resolved (`loadGroupMembers` bails without a
  // bearer token), and this callback still handed such a group a device
  // object, an info channel, its name and an empty members list — on the
  // cache path of every restart, so an installation grew objects a fresh
  // install never creates. The phase-3 callback (`onGroupMembersReady`)
  // builds the tree the moment the members are actually there.
  if (isAppGroup(device) && !device.groupMembers?.length) {
    return;
  }
  // One build per device at a time (runDeviceBuild): the cache-based build of
  // the start-up and the cloud-list build a moment later must not interleave,
  // or the older cleanup deletes what the newer build just declared. The
  // definitions are derived INSIDE the build, from the device as it is when the
  // build runs: derived at the call, a build queued before the scene library
  // arrived ran after it with the old list and deleted `scenes.scene_speed` —
  // its value and the user's recording with it (the inventory upgrade suite
  // showed it, 3.1.0).
  const p = sm
    .runDeviceBuild(device, async () => {
      await sm.createInfoStates(device);
      await sm.createLanStates(device);
      // Derived right before they are written, and together with what the
      // device does not know yet (`libraryDecidesPending`): the cleanup keeps
      // exactly what this list could not decide.
      const localSnaps = adapter.localSnapshots?.getSnapshots(device.sku, device.deviceId);
      const memberDevices =
        isAppGroup(device) && device.groupMembers
          ? groupFanoutHandler.resolveGroupMembers(device, adapter.deviceManager?.getDevices() ?? allDevices)
          : undefined;
      const cloudDefs = buildCloudStateDefs(device, adapter.log, adapter.deviceRegistry, localSnaps, memberDevices);
      const undecided = libraryDecidesPending(device);
      const capN = Array.isArray(device.capabilities) ? device.capabilities.length : 0;
      adapter.log.debug(
        `buildCloudStateDefs for ${device.sku} ${device.deviceId}: ${capN} cap(s) in → ${cloudDefs.length} state def(s) out`,
      );
      // The device manager settles the count (and stores it on the device); the
      // state manager only builds the tree for that number.
      const segmentCount = adapter.deviceManager?.syncSegmentCount(device) ?? 0;
      await sm.createCloudStates(device, cloudDefs, segmentCount, undecided);
      await sm.migrateLegacyDiagnostics(device);
      await sm.updateDeviceTier(device, adapter.deviceRegistry.getTier(device.sku));
    })
    .catch(e => {
      adapter.log.error(`onCloudDataReady failed for ${deviceLabel(device)}: ${errText(e)}`);
    });
  trackStateCreation(adapter, p);
  connectionState.updateConnectionState(adapter);
  if (adapter.statesReady) {
    reapStaleDevices(adapter).catch(logRejected(adapter.log, "reap stale devices"));
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
 * @param adapter The adapter surface
 * @param group The app group
 * @param allDevices Every device the adapter knows
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

/**
 * The device's physical segment count, or 0 when not yet known — the cap for
 * filtering out echo indices above the real strip length.
 *
 * `resolveSegmentCount`, not the raw field: the physical length can come from
 * the catalogue quirk or the Cloud capabilities just as well as from something
 * the device itself reported, and a device whose count is known only from its
 * capabilities read as 0 here — which this filter treats as "drop every
 * index". Deliberately NOT `effectiveSegmentCount`: a user's manual claim
 * about a cut strip is not evidence about what the hardware echoes back.
 *
 * @param device Device whose physical segment count to read
 * @param registry This instance's device catalog
 */
function physicalSegmentCap(device: GoveeDevice, registry: DeviceRegistry): number {
  const count = resolveSegmentCount(device, registry);
  return count > 0 ? count : 0;
}

/** One segment value a device echoed back — its index and what it shows now. */
interface SegmentEcho {
  /** Segment index. */
  index: number;
  /** Colour as `#rrggbb`, when the echo carries one. */
  color?: string;
  /** Brightness 0–100, when the echo carries one. */
  brightness?: number;
}

/**
 * Write what a device echoed into its segment datapoints — the ONE writer for
 * a batch command's echo and an AA A5 status push. Only into segments that
 * exist: the wizard sends `segmentBatch` over indices 0..SEGMENT_HARD_MAX so
 * the strip reveals its real length, and a stale packet can carry indices above
 * it — a write there is js-controller's "has no existing object" warning per
 * index (e.g. segments.51..55 on a 19-segment strip).
 *
 * @param adapter Adapter surface
 * @param device The device that echoed
 * @param echoes Its segment values
 */
function writeSegmentEcho(adapter: DeviceEventsAdapter, device: GoveeDevice, echoes: readonly SegmentEcho[]): void {
  const prefix = adapter.stateManager!.devicePrefix(device);
  const cap = physicalSegmentCap(device, adapter.deviceRegistry);
  for (const echo of echoes) {
    if (cap === 0 || echo.index >= cap) {
      continue;
    }
    if (echo.color !== undefined) {
      adapter
        .setState(`${prefix}.segments.${echo.index}.color`, { val: echo.color, ack: true })
        .catch(logRejected(adapter.log, "best-effort write"));
    }
    if (echo.brightness !== undefined) {
      adapter
        .setState(`${prefix}.segments.${echo.index}.brightness`, { val: echo.brightness, ack: true })
        .catch(logRejected(adapter.log, "best-effort write"));
    }
  }
}

/**
 * A segment batch command went out — mirror it into the segment datapoints.
 *
 * @param adapter Adapter surface
 * @param device The device the batch went to
 * @param batch The indices with the colour (RGB int) and/or brightness sent
 * @param batch.segments The segment indices
 * @param batch.color The colour as an RGB integer
 * @param batch.brightness The brightness 0–100
 */
export function onSegmentBatchEcho(
  adapter: DeviceEventsAdapter,
  device: GoveeDevice,
  batch: { segments: number[]; color?: number; brightness?: number },
): void {
  const color = batch.color === undefined ? undefined : rgbIntToHex(batch.color);
  writeSegmentEcho(
    adapter,
    device,
    batch.segments.map(index => ({ index, color, brightness: batch.brightness })),
  );
}

/**
 * An AA A5 status push reported the segments — mirror them.
 *
 * @param adapter Adapter surface
 * @param device The device that pushed
 * @param segments Its segments with colour and brightness
 */
export function onMqttSegmentEcho(
  adapter: DeviceEventsAdapter,
  device: GoveeDevice,
  segments: MqttSegmentData[],
): void {
  writeSegmentEcho(
    adapter,
    device,
    segments.map(seg => ({ index: seg.index, color: rgbToHex(seg.r, seg.g, seg.b), brightness: seg.brightness })),
  );
}
