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
 * Read the multi-source online indicator from a capability list and apply
 * it to the device's state. Capability list with no explicit online flag
 * is treated as „we just heard from the device" — assume online so a
 * Cloud poll-success doesn't leave a known-good device flagged offline.
 *
 * Skip the onDeviceUpdate fire if device already-online + still-online,
 * but refresh `lastSeenOnNetwork` either way.
 *
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
  if (online === undefined && caps.length > 0) {
    online = true;
  }
  if (online === undefined) {
    return;
  }
  if (device.state.online === online && online === true) {
    device.lastSeenOnNetwork = Date.now();
    return;
  }
  device.state.online = online;
  if (online) {
    device.lastSeenOnNetwork = Date.now();
  }
  adapter.onDeviceUpdate?.(device, { online });
}
