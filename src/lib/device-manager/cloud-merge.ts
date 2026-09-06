import type { DeviceRegistry } from "../device-registry";
import { GOVEE_CAP_TYPE } from "../govee-constants";
import type { CloudDevice, CloudStateCapability, DeviceState, GoveeDevice } from "../types";
import { cloudDeviceToGoveeDevice } from "./mapping";
import { deviceKey } from "./lookups";

/**
 * Adapter surface required by the cloud-merge helpers — DeviceManager
 * exposes `log`, `devices` and the instance's device catalog, plus a few
 * dispatch hooks the merge path fires when devices change.
 */
export interface CloudMergeAdapter {
  readonly log: ioBroker.Logger;
  readonly devices: Map<string, GoveeDevice>;
  readonly registry: DeviceRegistry;
  /** Fired when a device's cap-derived state changes (online flip etc.). */
  onDeviceUpdate?: ((device: GoveeDevice, state: Partial<DeviceState>) => void) | null;
  /** Optional one-shot SKU nudge. */
  maybeNudgeSeedSku(sku: string, displayName: string | undefined): void;
}

/**
 * Merge a Cloud device list into the registry. Updates existing entries
 * with refreshed name/capabilities/type and registers new ones via
 * {@link cloudDeviceToGoveeDevice}. Returns true when at least one new
 * device was added.
 *
 */
export function mergeCloudDevices(adapter: CloudMergeAdapter, cloudDevices: CloudDevice[]): boolean {
  let changed = false;
  if (!Array.isArray(cloudDevices)) {
    return false;
  }
  for (const cd of cloudDevices) {
    if (!cd || typeof cd.sku !== "string" || typeof cd.device !== "string") {
      continue;
    }
    // Govee's /user/devices returns app device-groups as pseudo-devices. BaseGroup
    // is supported (members resolved via the app-API group list, fan-out built in
    // capability-mapper); SameModeGroup has no member-resolution path here, so
    // merging it verbatim would build a generic light from its capabilities and
    // leave an orphaned control tree that never actually drives anything. Skip it.
    if (cd.sku === "SameModeGroup") {
      adapter.log.debug(
        `Cloud: skipping SameModeGroup pseudo-device ${cd.deviceName ?? cd.device} (not a real device)`,
      );
      continue;
    }
    const existing = adapter.devices.get(deviceKey(cd.sku, cd.device));
    if (existing) {
      existing.name = cd.deviceName || existing.name;
      existing.capabilities = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      existing.type = cd.type || existing.type;
      existing.channels.cloud = true;
    } else {
      const device = cloudDeviceToGoveeDevice(cd);
      adapter.devices.set(deviceKey(cd.sku, cd.device), device);
      changed = true;
      adapter.log.debug(`Cloud: New device ${cd.deviceName} (${cd.sku})`);
      adapter.maybeNudgeSeedSku(cd.sku, cd.deviceName);
    }

    const quirks = adapter.registry.getQuirks(cd.sku);
    if (quirks?.brokenPlatformApi) {
      adapter.log.debug(`${cd.sku} has known broken platform API metadata — capabilities may be incomplete`);
    }
  }
  return changed;
}

/**
 * Read the reachability signal out of a capability list and apply it.
 *
 * A capability list carries two very different things, and this function keeps
 * them apart because the resolver ranks them differently:
 *
 * 1. **An explicit `online` capability** — Govee STATING whether the device is
 *    reachable. Lands in `state.cloudReportedOnline` + `…At` and counts in both
 *    directions.
 * 2. **No such capability, but a non-empty list** — Govee delivered a reading,
 *    an event or a capability set, and said nothing about reachability. The
 *    payload exists because the device spoke, so it is evidence; it is only
 *    ever positive, and it lands in the weaker `state.cloudLivenessAt`.
 *
 * Both used to be written into slot 1, and that made the last writer win: an
 * event arriving seconds after Govee reported `online:false` replaced that
 * `false` with a fabricated `true` for the next 30 minutes. The architecture
 * doc has always required the opposite ("an explicit report beats the mere
 * arrival of a packet"); separate slots are what actually enforce it.
 *
 * Skip the onDeviceUpdate fire if device already-online + still-online,
 * but refresh `lastSeenOnNetwork` either way.
 *
 * @param adapter Device-manager surface (for the update callback)
 * @param device Target device
 * @param caps The capability list that just arrived
 */
export function applyOnlineCap(adapter: CloudMergeAdapter, device: GoveeDevice, caps: CloudStateCapability[]): void {
  let online: boolean | undefined;
  for (const c of caps) {
    if (
      c &&
      typeof c.type === "string" &&
      (c.type === GOVEE_CAP_TYPE.ONLINE || c.type === "online") &&
      c.state &&
      typeof c.state.value === "boolean"
    ) {
      online = c.state.value;
      break;
    }
  }
  const now = Date.now();
  if (online === undefined) {
    if (caps.length === 0) {
      return;
    }
    // Arrival, not a statement. Never written into the report slot — see the
    // note above. `cloudLivenessAt` expires on the same clock, so this cannot
    // hold a device green forever either.
    device.state.cloudLivenessAt = now;
    device.lastSeenOnNetwork = now;
    if (device.state.online === true) {
      return;
    }
    device.state.online = true;
    adapter.onDeviceUpdate?.(device, { online: true });
    return;
  }
  // Remember that Govee spoke at all — `syncInfoOnline` needs to tell "Govee
  // reports offline" apart from "Govee never reports for this device kind".
  device.state.cloudReportedOnline = online;
  // Stamped so the proof can expire (CLOUD_ONLINE_EVIDENCE_TTL_MS). Without a
  // stamp a single "online" would read as reachable forever.
  device.state.cloudReportedOnlineAt = now;
  if (device.state.online === online && online === true) {
    device.lastSeenOnNetwork = now;
    return;
  }
  device.state.online = online;
  if (online) {
    device.lastSeenOnNetwork = now;
  }
  adapter.onDeviceUpdate?.(device, { online });
}
