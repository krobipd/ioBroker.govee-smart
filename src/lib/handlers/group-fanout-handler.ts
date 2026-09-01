import type { DeviceManager } from "../device-manager";
import type { GroupFanoutHost } from "../group-fanout";
import { resolveGroupMembers } from "../group-fanout";
import type { StateManager } from "../state-manager";
import { logRejected, type GoveeDevice } from "../types";

/**
 * Adapter surface required by the group-fanout glue. Loose
 * `getObjectAsync` shape for utils.Adapter structural matching.
 */
export interface GroupFanoutHandlerAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  getObjectAsync(id: string): Promise<unknown>;
  /** State-suffix → command lookup — owned by main.ts because it lives next to STATE_TO_COMMAND. */
  stateToCommand(suffix: string): string | null;
  /** Music command builder — owned by main.ts because it pulls sibling state values. */
  sendMusicCommand(device: GoveeDevice, devicePrefix: string, stateSuffix: string, value: unknown): Promise<void>;
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
 */
export function updateGroupReachability(adapter: GroupFanoutHandlerAdapter): void {
  if (!adapter.deviceManager || !adapter.stateManager) {
    return;
  }
  const devices = adapter.deviceManager.getDevices();
  for (const group of devices) {
    if (group.sku !== "BaseGroup" || !group.groupMembers) {
      continue;
    }
    const memberDevices = resolveGroupMembers(group, devices);
    adapter.stateManager
      .updateGroupMembersUnreachable(group, memberDevices)
      .catch(logRejected(adapter.log, "write group members unreachable"));
  }
}

/**
 * Construct host object for {@link GroupFanoutHandler}. Closures capture
 * adapter state.
 *
 */
export function buildGroupFanoutHost(adapter: GroupFanoutHandlerAdapter): GroupFanoutHost {
  return {
    log: adapter.log,
    namespace: adapter.namespace,
    getDevices: () => adapter.deviceManager?.getDevices() ?? [],
    sendCommand: async (device, command, value) => {
      await adapter.deviceManager?.sendCommand(device, command, value);
    },
    devicePrefix: device => adapter.stateManager?.devicePrefix(device) ?? "",
    stateToCommand: suffix => adapter.stateToCommand(suffix) ?? undefined,
    getObject: id => adapter.getObjectAsync(id) as Promise<ioBroker.Object | null | undefined>,
    sendMusicCommand: (device, devicePrefix, stateSuffix, value) =>
      adapter.sendMusicCommand(device, devicePrefix, stateSuffix, value),
  };
}
