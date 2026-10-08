import type { DeviceManager } from "../device-manager";
import type { GroupFanoutHost } from "../group-fanout";
import { resolveGroupMembers } from "../group-fanout";
import type { StateManager } from "../state-manager";
import { logRejected } from "../types";
import { isAppGroup } from "../govee-constants";
import { stateToCommand } from "./dropdown-reset-helpers";
import { sendMusicCommand, type MusicCommandAdapter } from "./music-command";

/**
 * Adapter surface required by the group-fanout glue. Loose
 * `getObjectAsync` shape for utils.Adapter structural matching.
 */
export interface GroupFanoutHandlerAdapter extends MusicCommandAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** Read one own object. */
  getObjectAsync(id: string): Promise<unknown>;
}

// resolveGroupMembers (canonical resolver) lives in ../group-fanout, shared with
// the GroupFanoutHandler class; imported above for local use and re-exported so
// callers reaching it via this glue module (device-events) keep working.
export { resolveGroupMembers };

/**
 * Recalculate `info.membersUnreachable` for all groups. Called when any
 * device's online status changes — race-condition-safe because the state
 * is kept existent and just gets an empty string when no member is
 * unreachable (see device-manager-pattern #46).
 *
 * @param adapter The adapter surface
 * @returns How many groups were actually written. The caller uses this to tell
 *   a real first round apart from one that ran before the device list arrived —
 *   a "primed" flag set on an empty round would be spent without ever having
 *   refreshed a group, which is the very drift this is meant to end.
 */
export function updateGroupReachability(adapter: GroupFanoutHandlerAdapter): number {
  if (!adapter.deviceManager || !adapter.stateManager) {
    return 0;
  }
  const devices = adapter.deviceManager.getDevices();
  let written = 0;
  for (const group of devices) {
    if (!isAppGroup(group) || !group.groupMembers) {
      continue;
    }
    const memberDevices = resolveGroupMembers(group, devices);
    adapter.stateManager
      .updateGroupMembersUnreachable(group, memberDevices)
      .catch(logRejected(adapter.log, "write group members unreachable"));
    written++;
  }
  return written;
}

/**
 * Construct host object for {@link GroupFanoutHandler}. Closures capture
 * adapter state.
 *
 * @param adapter The adapter surface
 */
export function buildGroupFanoutHost(adapter: GroupFanoutHandlerAdapter): GroupFanoutHost {
  return {
    log: adapter.log,
    namespace: adapter.namespace,
    getDevices: () => adapter.deviceManager?.getDevices() ?? [],
    sendCommand: async (device, command, value) => {
      await adapter.deviceManager?.sendCommand(device, command, value);
    },
    awaitsReport: (device, command) => adapter.deviceManager?.transportUsed(device, command) === "broker",
    devicePrefix: device => adapter.stateManager?.devicePrefix(device) ?? "",
    stateToCommand: suffix => stateToCommand(suffix) ?? undefined,
    getObject: id => adapter.getObjectAsync(id) as Promise<ioBroker.Object | null | undefined>,
    sendMusicCommand: (device, devicePrefix, stateSuffix, value) =>
      sendMusicCommand(adapter, device, devicePrefix, stateSuffix, value),
  };
}
