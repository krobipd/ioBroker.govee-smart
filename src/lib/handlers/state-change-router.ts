import { getMusicModeOptions, musicModeNameUsesRgb } from "../capability-mapper";
import type { DeviceManager } from "../device-manager";
import { SEGMENT_HARD_MAX } from "../device-manager";
import { GOVEE_CAP_TYPE } from "../govee-constants";
import type { GoveeLanClient } from "../govee-lan-client";
import type { GroupFanoutHandler } from "../group-fanout";
import type { SnapshotHandler } from "../snapshot-handler";
import type { StateManager } from "../state-manager";
import { errMessage, hexToRgb, parseSegmentList, resolveStatesValue, type GoveeDevice } from "../types";
import * as cloudRetryHandler from "./cloud-retry-handler";
import * as diagnosticsHandler from "./diagnostics-handler";
import * as dropdownReset from "./dropdown-reset-helpers";

/**
 * Adapter surface required by the state-change router. Includes everything
 * the onStateChange path touches (devices, snapshots, group-fanout, music
 * commands, dropdown reset, manual segments, generic capability routing).
 */
export interface StateChangeRouterAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly unloading: boolean;
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  readonly snapshotHandler: SnapshotHandler | null;
  readonly groupFanout: GroupFanoutHandler | null;
  readonly lanClient: GoveeLanClient | null;
  readonly diagnosticsLastRun: Map<string, number>;
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  setStateAsync(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
  getObjectAsync(id: string): Promise<unknown>;
  /** Owned by main.ts — reloads the Cloud-state tree after a per-device refresh. */
  loadCloudStates(): Promise<void>;
  /** Owned by main.ts — central entry point for manual-segment updates. */
  applyManualSegments(device: GoveeDevice, mode: boolean, indices?: number[]): Promise<void>;
  /** Owned by main.ts — manual "sync devices" button: reload account list + reconcile. */
  syncDevicesManually?(): Promise<void>;
}

/**
 * Locate a device by the state-tree prefix it owns. Linear scan because the
 * device count is small (typical Govee account has 5-30 devices) and the
 * call is cheap relative to the surrounding `setStateAsync`.
 *
 */
export function findDeviceForState(adapter: StateChangeRouterAdapter, localId: string): GoveeDevice | undefined {
  if (!adapter.deviceManager || !adapter.stateManager) {
    return undefined;
  }
  for (const device of adapter.deviceManager.getDevices()) {
    const prefix = adapter.stateManager.devicePrefix(device);
    if (localId.startsWith(`${prefix}.`)) {
      return device;
    }
  }
  return undefined;
}

/**
 * Resolve a dropdown-state input value against the state's common.states
 * map. Returns the canonical key (always String form) so a user can write
 * either the index ("1"), the index as a number (1) or the label name
 * ("Aurora", case-insensitive) — all three land at the same canonical
 * value for the rest of the handler.
 *
 * Non-dropdown states (no common.states), reset sentinels (0/"0"/"") and
 * non-string/number inputs are passed through unchanged. A dropdown input
 * that doesn't match any key or label returns ok=false so the caller can
 * warn and skip the command.
 *
 */
export async function resolveDropdownInput(
  adapter: StateChangeRouterAdapter,
  id: string,
  raw: ioBroker.StateValue,
): Promise<{ val: ioBroker.StateValue; ok: boolean }> {
  if (raw === null || raw === undefined) {
    return { val: raw, ok: true };
  }
  if (raw === 0 || raw === "0" || raw === "") {
    return { val: raw, ok: true };
  }
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { val: raw, ok: true };
  }
  const obj = (await adapter.getObjectAsync(id)) as { common?: { states?: unknown } } | null | undefined;
  const states = obj?.common?.states;
  if (!states || typeof states !== "object") {
    return { val: raw, ok: true };
  }
  const resolved = resolveStatesValue(raw, states as Record<string, string>);
  if (resolved) {
    return { val: resolved.key, ok: true };
  }
  return { val: raw, ok: false };
}

/**
 * Build and send a music_setting STRUCT command. Reads sibling music state
 * values and combines them into one API call.
 *
 */
export async function sendMusicCommand(
  adapter: StateChangeRouterAdapter,
  device: GoveeDevice,
  prefix: string,
  changedSuffix: string,
  newValue: ioBroker.StateValue,
): Promise<void> {
  const musicBase = `${adapter.namespace}.${prefix}.music`;

  const modeState = await adapter.getStateAsync(`${musicBase}.music_mode`);
  const sensState = await adapter.getStateAsync(`${musicBase}.music_sensitivity`);
  const autoState = await adapter.getStateAsync(`${musicBase}.music_auto_color`);

  const selectedIndex =
    changedSuffix === "music.music_mode" ? parseInt(String(newValue), 10) : parseInt(String(modeState?.val ?? 0), 10);
  const sensitivity =
    changedSuffix === "music.music_sensitivity" ? (newValue as number) : ((sensState?.val as number) ?? 100);
  const autoColor = changedSuffix === "music.music_auto_color" ? (newValue ? 1 : 0) : autoState?.val ? 1 : 0;

  // Index 0 = the "---" sentinel = nothing selected. Gate the skip on the
  // INDEX, not the resolved device value: on a 0-based SKU index 1 resolves to
  // device value 0 (a real mode) which must NOT be swallowed here (A1).
  if (!Number.isFinite(selectedIndex) || selectedIndex <= 0) {
    adapter.log.debug("Music mode not selected, skipping command");
    return;
  }

  // Resolve the dropdown index to the device's actual mode value through the
  // SAME option list the dropdown was built from (getMusicModeOptions), so the
  // index→value mapping can't drift: index N → options[N-1].value.
  const musicCap = device.capabilities.find(c => c.type === GOVEE_CAP_TYPE.MUSIC_SETTING && c.instance === "musicMode");
  const chosen = musicCap ? getMusicModeOptions(musicCap)[selectedIndex - 1] : undefined;
  const musicMode = chosen ? Number(chosen.value) : NaN;
  if (!Number.isFinite(musicMode)) {
    adapter.log.debug(`Music mode index ${selectedIndex} has no matching numeric option, skipping command`);
    return;
  }

  if (device.lanIp && adapter.lanClient) {
    // The local music packet (33 05 01 <mode> [rgb]) carries no sensitivity /
    // auto-color fields, so those changes can't be applied over LAN. Warn
    // instead of silently re-sending just the mode and acking "ok" (A3) — the
    // music mode itself still works over LAN.
    if (changedSuffix === "music.music_sensitivity" || changedSuffix === "music.music_auto_color") {
      adapter.log.warn(
        `${device.name} (${device.sku}): music sensitivity / auto-color can't be set over the local API — ` +
          `only the music mode applies for LAN-controlled lights.`,
      );
      return;
    }
    let r = 0,
      g = 0,
      b = 0;
    // A2: which modes carry a custom RGB colour is keyed on the mode NAME
    // (Spectrum/Rolling), not the numeric value — Govee's music-mode values are
    // SKU-specific (A1: 0-based vs 1-based SKUs), so a value gate appended RGB
    // on the wrong mode for a non-standard-value SKU.
    const includeRgb = musicModeNameUsesRgb(chosen?.name);
    if (includeRgb) {
      const colorState = await adapter.getStateAsync(`${adapter.namespace}.${prefix}.control.color_rgb`);
      if (colorState?.val && typeof colorState.val === "string") {
        ({ r, g, b } = hexToRgb(colorState.val));
      }
    }
    // NOTE (A2 residual): the sub-mode BYTE is the raw capability value, which
    // equals the ptReal sub-mode on every SKU seen so far (0-3). A SKU that
    // reports music-mode values outside that range is untested — the byte may
    // then be wrong and needs hardware validation. The RGB gate above is
    // already name-correct regardless of the numbering.
    adapter.lanClient.setMusicMode(device.lanIp, musicMode, includeRgb, r, g, b);
    return;
  }

  const structValue: Record<string, unknown> = {
    musicMode,
    sensitivity,
    autoColor,
  };

  await adapter.deviceManager!.sendCapabilityCommand(device, GOVEE_CAP_TYPE.MUSIC_SETTING, "musicMode", structValue);
}

/**
 * React to manual-segments state changes — parses list, forwards to
 * {@link StateChangeRouterAdapter.applyManualSegments}. On parse error
 * disables manual mode so the rejected value doesn't survive in the state
 * tree.
 *
 */
export async function handleManualSegmentsChange(
  adapter: StateChangeRouterAdapter,
  device: GoveeDevice,
  suffix: string,
  newValue: unknown,
): Promise<void> {
  const modeVal = suffix === "segments.manual_mode" ? Boolean(newValue) : device.manualMode === true;
  const listVal =
    suffix === "segments.manual_list"
      ? typeof newValue === "string"
        ? newValue
        : ""
      : Array.isArray(device.manualSegments)
        ? device.manualSegments.join(",")
        : "";

  if (!modeVal) {
    adapter.log.info(`${device.name}: manual segments disabled — strip treated as contiguous`);
    await adapter.applyManualSegments(device, false);
    return;
  }

  const maxIndex =
    typeof device.segmentCount === "number" && device.segmentCount > 0 ? device.segmentCount - 1 : SEGMENT_HARD_MAX;
  const parsed = parseSegmentList(listVal, maxIndex);
  if (parsed.error) {
    adapter.log.warn(`${device.name}: manual_list invalid (${parsed.error}) — disabling manual mode`);
    await adapter.applyManualSegments(device, false);
    return;
  }

  adapter.log.debug(`${device.name}: manual segments active — ${parsed.indices.length} physical indices (${listVal})`);
  await adapter.applyManualSegments(device, true, parsed.indices);
}

/**
 * Generic Capability-Routing path for states not in STATE_TO_COMMAND.
 * Reads `native.capabilityType`/`capabilityInstance` from the state object
 * and routes via the Cloud API.
 *
 */
export async function handleGenericCapabilityCommand(
  adapter: StateChangeRouterAdapter,
  device: GoveeDevice,
  id: string,
  stateSuffix: string,
  val: ioBroker.StateValue,
): Promise<void> {
  if (!adapter.deviceManager) {
    return;
  }
  const obj = (await adapter.getObjectAsync(id)) as
    { native?: { capabilityType?: unknown; capabilityInstance?: unknown } } | null | undefined;
  const capType = obj?.native?.capabilityType;
  const capInstance = obj?.native?.capabilityInstance;
  if (typeof capType === "string" && typeof capInstance === "string") {
    try {
      adapter.log.debug(
        `Routing to generic capability for ${device.name}: cap=${capType}/${capInstance} state=${stateSuffix} val=${JSON.stringify(val)}`,
      );
      await adapter.deviceManager.sendCapabilityCommand(device, capType, capInstance, val);
      await adapter.setStateAsync(id, { val, ack: true });
    } catch (err) {
      adapter.log.warn(`Command failed for ${device.name}: ${errMessage(err)}`);
    }
  } else {
    // No STATE_TO_COMMAND entry + no native capabilityType/Instance — nothing
    // we can route. Logging this is the bug-report-from-debug-log path for
    // "I wrote my state and the adapter ignored me".
    adapter.log.debug(
      `No handler matched for ${device.name} (${device.sku}) state=${stateSuffix} val=${JSON.stringify(val)} — writable state without command mapping or capability metadata, silently ignored`,
    );
  }
}

/**
 * Handle state changes from user (write operations). Central routing entry
 * point: refresh-button → cloud refetch; group → fan-out; snapshots → local
 * store; manual segments → handler; diagnostics → diag handler; otherwise
 * route via STATE_TO_COMMAND or generic capability path. Optimistic ack on
 * success; warn on errors.
 *
 */
export async function onStateChange(
  adapter: StateChangeRouterAdapter,
  id: string,
  state: ioBroker.State | null | undefined,
): Promise<void> {
  // Silent early-skips for the noisy routine cases (ack=true is fired on
  // every setState we do ourselves; logging that would flood the debug
  // log). The remaining gates DO get a debug line because they're rare
  // and load-bearing for "why did the adapter ignore my write?" reports.
  if (!state || state.ack) {
    return;
  }
  if (!adapter.deviceManager || !adapter.stateManager) {
    adapter.log.debug(`onStateChange ignored ${id}: adapter not ready (deviceManager/stateManager missing)`);
    return;
  }
  if (adapter.unloading) {
    adapter.log.debug(`onStateChange ignored ${id}: adapter is unloading`);
    return;
  }

  const localId = id.replace(`${adapter.namespace}.`, "");

  // Adapter-level "manually sync devices" button — pull the fresh account
  // device list and reconcile (add new / remove deleted) without a restart.
  // Not a devices.*/groups.* path, so handle it before that gate.
  if (localId === "info.manual_sync_devices") {
    if (state.val) {
      adapter.log.info("Manual device sync requested — refreshing the device list from your Govee account");
      await adapter.syncDevicesManually?.();
    }
    await adapter.setStateAsync(id, { val: false, ack: true });
    return;
  }

  if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
    adapter.log.debug(`onStateChange ignored ${id}: not a devices.* / groups.* path`);
    return;
  }

  const device = findDeviceForState(adapter, localId);
  if (!device) {
    adapter.log.debug(`onStateChange ignored ${id}: no device matches this state path`);
    return;
  }

  const prefix = adapter.stateManager.devicePrefix(device);
  const stateSuffix = localId.slice(prefix.length + 1);
  adapter.log.debug(
    `onStateChange ${id}: device=${device.name} (${device.sku}) suffix=${stateSuffix} val=${JSON.stringify(state.val)}`,
  );
  // v2.9.1 — surface the user-write into the per-device diag log so a
  // "I set state X and the adapter ignored me" report has the write
  // attempt + the subsequent routing/skip logs in one place.
  adapter.deviceManager
    .getDiagnostics()
    .addLog(device.deviceId, "debug", `User-write ${stateSuffix}=${JSON.stringify(state.val)}`);

  const resolved = await resolveDropdownInput(adapter, id, state.val);
  if (!resolved.ok) {
    adapter.log.warn(`Unknown dropdown value for ${id}: ${String(state.val)} — ignoring`);
    return;
  }
  const val = resolved.val;

  // Group fan-out: route commands to each member device. Only ack when the
  // fan-out actually reached a member — a group with no reachable members (or
  // where every member send failed) must NOT report success (L3/A6); fanOut
  // has already warned in that case.
  if (device.sku === "BaseGroup" && device.groupMembers) {
    const reached = await adapter.groupFanout!.fanOut(device, stateSuffix, val);
    if (reached) {
      await adapter.setStateAsync(id, { val, ack: true });
      if (stateSuffix === "scenes.light_scene" || stateSuffix === "music.music_mode") {
        await dropdownReset.resetRelatedDropdowns(
          adapter,
          prefix,
          stateSuffix === "scenes.light_scene" ? "lightScene" : "music",
        );
      }
    }
    return;
  }

  // Local snapshot commands (no Cloud/MQTT needed)
  if (stateSuffix === "snapshots.snapshot_save" && typeof val === "string" && val.trim()) {
    await adapter.snapshotHandler!.save(device, val.trim());
    await adapter.setStateAsync(id, { val: "", ack: true });
    return;
  }
  if (stateSuffix === "snapshots.snapshot_local") {
    if (val !== "0" && val !== 0) {
      await adapter.snapshotHandler!.restore(device, val);
      await dropdownReset.resetRelatedDropdowns(adapter, prefix, "snapshotLocal");
    }
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }
  if (stateSuffix === "snapshots.snapshot_delete" && typeof val === "string" && val.trim()) {
    await adapter.snapshotHandler!.delete(device, val.trim());
    await adapter.setStateAsync(id, { val: "", ack: true });
    return;
  }

  // Per-device cloud refresh — "I just created a snapshot in the Govee Home
  // app, pull the new list for THIS light". Replaces the global
  // info.refresh_cloud_data button (removed in v2.7.0); see
  // DeviceManager.refreshSceneDataForDevice for the API-budget rationale.
  if (stateSuffix === "snapshots.refresh_cloud" && val) {
    if (adapter.deviceManager) {
      adapter.log.info(`Refresh cloud data for ${device.name} (${device.sku}): re-fetching scenes and snapshots`);
      try {
        const changed = await adapter.deviceManager.refreshSceneDataForDevice(device.deviceId);
        if (changed) {
          await cloudRetryHandler.reloadCloudStates(adapter);
        }
      } catch (e) {
        adapter.log.warn(`Refresh cloud data for ${device.name} failed: ${errMessage(e)}`);
      }
    }
    await adapter.setStateAsync(id, { val: false, ack: true });
    return;
  }

  // Manual segments toggle/list — handler owns the ack because a parse
  // error rewrites manual_mode to false, and an outer ack with the
  // raw value would resurrect the rejected entry.
  if (stateSuffix === "segments.manual_mode" || stateSuffix === "segments.manual_list") {
    await handleManualSegmentsChange(adapter, device, stateSuffix, val);
    return;
  }

  if (stateSuffix === "diag.export" && val) {
    if (adapter.deviceManager) {
      await diagnosticsHandler.handleDiagnosticsExport(
        adapter,
        adapter.deviceManager,
        adapter.diagnosticsLastRun,
        device,
        prefix,
        id,
      );
    }
    return;
  }

  const command = dropdownReset.stateToCommand(stateSuffix);

  if (!command) {
    await handleGenericCapabilityCommand(adapter, device, id, stateSuffix, val);
    return;
  }

  // Dropdown reset to the "no selection" sentinel — acknowledge without firing
  // a command. lightScene/diyScene/snapshot use 0 = "---"; the preset-scene
  // dropdown (control.scene) uses "" (its def). Writing that sentinel to
  // control.scene used to fall through to a spurious preset-scene command (L4).
  if (
    (command === "lightScene" || command === "diyScene" || command === "snapshot" || command === "scene") &&
    (val === "0" || val === 0 || val === "")
  ) {
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }

  // Scene speed: store on device, applied on next scene activation.
  // Persist to SKU cache so the user's choice survives a restart.
  if (command === "sceneSpeed") {
    const level = typeof val === "number" ? val : parseInt(String(val), 10);
    if (!isNaN(level)) {
      device.sceneSpeed = level;
      adapter.deviceManager?.persistDeviceToCache(device);
    }
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }

  try {
    if (command === "music") {
      if (stateSuffix === "music.music_mode" && (val === "0" || val === 0)) {
        await adapter.setStateAsync(id, { val, ack: true });
        return;
      }
      await sendMusicCommand(adapter, device, prefix, stateSuffix, val);
      await adapter.setStateAsync(id, { val, ack: true });
      if (stateSuffix === "music.music_mode") {
        await dropdownReset.resetRelatedDropdowns(adapter, prefix, "music");
      }
      return;
    }

    await adapter.deviceManager.sendCommand(device, command, val);
    await adapter.setStateAsync(id, { val, ack: true });
    // Power-off resets all mode dropdowns (device off → no active mode).
    if (command === "power" && val === false) {
      await dropdownReset.resetModeDropdowns(adapter, prefix, "");
    } else {
      await dropdownReset.resetRelatedDropdowns(adapter, prefix, command);
    }
  } catch (err) {
    adapter.log.warn(`Command failed for ${device.name}: ${errMessage(err)}`);
  }
}
