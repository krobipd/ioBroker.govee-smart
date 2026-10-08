import { errText } from "../types";
import { updateConnectionState, type ConnectionStateAdapter } from "./connection-state";
import * as groupFanoutHandler from "./group-fanout-handler";

/** What the 20-second round needs: the connection contract, the group contract, and its own two flags. */
export type OnlineSyncAdapter = ConnectionStateAdapter &
  groupFanoutHandler.GroupFanoutHandlerAdapter & {
    readonly unloading: boolean;
    /** A round has written the groups once this run — later rounds only on a change. */
    groupReachabilityPrimed: boolean;
  };

/**
 * One round of the 20-second re-evaluation: every device's `info.online`,
 * the groups' reachability, the rollup and `info.connection`.
 */
export async function runOnlineSyncRound(adapter: OnlineSyncAdapter): Promise<void> {
  // The body is one try: the group and connection updates are synchronous,
  // and a throw there would be an unhandled rejection of the timer's promise
  // — which ends the process, every 20 s again (fleet rule: top-level
  // try/catch in the async body).
  try {
    if (adapter.unloading || !adapter.stateManager || !adapter.deviceManager) {
      return;
    }
    let anyLightChanged = false;
    for (const device of adapter.deviceManager.getDevices()) {
      const changed = await adapter.stateManager.syncInfoOnline(device).catch(() => false);
      if (changed) {
        anyLightChanged = true;
      }
    }
    // The first round after a start always re-evaluates the groups: their
    // members' reachability was just read fresh, and without this the
    // rollup would keep a value nobody has checked since the last restart.
    if (anyLightChanged || !adapter.groupReachabilityPrimed) {
      // Only a round that really wrote a group counts as primed — at the
      // first tick the cloud device list may still be loading, and a flag
      // spent on an empty round would put us back to change-only.
      if (groupFanoutHandler.updateGroupReachability(adapter) > 0) {
        adapter.groupReachabilityPrimed = true;
      }
    }
    // The rollup rides on the same round: it is derived from exactly the
    // markers that were just re-evaluated, so it can never drift away from
    // what the individual devices say.
    await adapter.stateManager.writeDeviceRollup().catch(e => {
      adapter.log.debug(`Device rollup failed: ${errText(e)}`);
    });
    // info.connection rides on the same round: the evidence of the last
    // device ages out here, and no other event would notice (audit B7 —
    // it stayed green until the next channel change).
    if (!adapter.unloading) {
      updateConnectionState(adapter);
    }
  } catch (e) {
    adapter.log.debug(`Online sync round failed: ${errText(e)}`);
  }
}
