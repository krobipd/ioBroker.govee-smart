import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import type { CachedDeviceData, SkuCache } from "../sku-cache";
import { deviceLabel, type GoveeDevice } from "../types";
import { plausibleSegmentCount, plausibleSegmentIndices } from "./lookups";

/**
 * Adapter surface required by the cache helpers — DeviceManager exposes
 * `skuCache`, `devices`, and `log` in this shape.
 */
export interface DeviceCacheAdapter {
  readonly log: ioBroker.Logger;
  readonly skuCache: SkuCache | null;
  readonly devices: Map<string, GoveeDevice>;
}

/**
 * Fill device.scenes from sceneLibrary when Cloud scenes are missing.
 * ptReal activation matches by name, so sceneLibrary names are sufficient.
 *
 * @param adapter DeviceManager-shaped surface
 * @param device Device to populate scenes for
 */
export function populateScenesFromLibrary(adapter: DeviceCacheAdapter, device: GoveeDevice): void {
  if (device.scenes.length === 0 && device.sceneLibrary.length > 0) {
    device.scenes = device.sceneLibrary.map(entry => ({
      name: entry.name,
      value: {}, // ptReal uses sceneLibrary directly, Cloud payload not needed
    }));
    adapter.log.debug(`${device.sku}: ${device.scenes.length} scenes from library (Cloud scenes missing)`);
  }
}

/**
 * Convert cached data back into a GoveeDevice. Spreads all persisted fields
 * and re-initializes the runtime-only fields (state, channels, lanIp,
 * groupMembers) to their boot defaults — they get refilled by LAN-Discovery,
 * Cloud-API responses, etc. during onReady.
 *
 * Adding a new field to GoveeDevice / CachedDeviceData: no change here.
 * Removing a field: no change here either (extra keys in the cache are
 * silently ignored). The shape is the contract.
 *
 * Runtime-only fields (NOT restored from cache):
 * - state           — recomputed from LAN/MQTT status as devices come online
 * - channels        — recomputed from LAN/MQTT/Cloud connection results
 * - lanIp           — re-discovered by LAN UDP scan each restart
 * - groupMembers    — re-resolved by loadGroupMembers via App-API each restart
 */
export function cachedToGoveeDevice(cached: CachedDeviceData): GoveeDevice {
  // Strip cachedAt (cache-metadata) AND any runtime-only field that might
  // have leaked into the cache from a tampered file or an old broken save.
  // Runtime defaults are appended explicitly below — they are NOT influenced
  // by what the cache contained.
  const {
    cachedAt: _cachedAt,
    // Cast-through 'unknown' because TypeScript doesn't know the malformed
    // cache could carry these fields; we want the destructure-discard either way.
    state: _state,
    channels: _channels,
    lanIp: _lanIp,
    groupMembers: _groupMembers,
    lastLanReplyAt: _lastLanReplyAt,
    ...rest
  } = cached as CachedDeviceData &
    Partial<Pick<GoveeDevice, "state" | "channels" | "lanIp" | "groupMembers" | "lastLanReplyAt">>;
  return {
    ...rest,
    // Host-local, editable file: a corrupt count or index list must not become
    // the device's segment map (same gate as the Cloud/MQTT/wizard sources).
    segmentCount: plausibleSegmentCount(rest.segmentCount),
    manualSegments: plausibleSegmentIndices(rest.manualSegments),
    state: { online: false },
    channels: { lan: false, mqtt: false, cloud: false },
  };
}

/**
 * Extract cacheable data from a GoveeDevice — destructures the runtime-only
 * fields out and spreads the rest. Adding a new cacheable field to
 * GoveeDevice: no change here.
 *
 * normalize() handles the few save-time tweaks that exist (e.g. drop
 * segmentCount when 0, drop manualMode flags when falsy/empty) so the cache
 * stays compact.
 */
export function goveeDeviceToCached(device: GoveeDevice): CachedDeviceData {
  // Strip runtime-only fields. Everything else flows into the cache.
  // lastLanReplyAt is a live LAN-freshness timestamp — it must never be
  // persisted (a stale value would survive a restart and skew online logic) (L11).
  const {
    state: _state,
    channels: _channels,
    lanIp: _lanIp,
    groupMembers: _groupMembers,
    lastLanReplyAt: _lastLanReplyAt,
    ...cacheable
  } = device;
  return {
    ...normalize(cacheable),
    cachedAt: Date.now(),
  };
}

/**
 * Compact a few fields before persisting:
 * - segmentCount only kept when > 0 (0 means "not yet learned")
 * - manualMode only kept when true (false is the default)
 * - manualSegments only kept when manualMode AND non-empty
 * - sceneSpeed only kept when > 0
 *
 * Pure function on the destructured cacheable view (no `state` / `channels` /
 * `lanIp` / `groupMembers` here). Returns the same shape minus the dropped
 * keys.
 */
function normalize<T extends Omit<GoveeDevice, "state" | "channels" | "lanIp" | "groupMembers" | "lastLanReplyAt">>(
  d: T,
): Omit<CachedDeviceData, "cachedAt"> {
  const segmentCount = typeof d.segmentCount === "number" && d.segmentCount > 0 ? d.segmentCount : undefined;
  const manualMode = d.manualMode ? true : undefined;
  const manualSegments =
    manualMode && Array.isArray(d.manualSegments) && d.manualSegments.length > 0 ? d.manualSegments.slice() : undefined;
  const sceneSpeed = typeof d.sceneSpeed === "number" && d.sceneSpeed > 0 ? d.sceneSpeed : undefined;
  // Drop a zeroed miss-counter so the cache stays compact — 0 and undefined
  // are equivalent to the reconciler (both mean "no pending misses").
  const accountMissCount =
    typeof d.accountMissCount === "number" && d.accountMissCount > 0 ? d.accountMissCount : undefined;
  return {
    ...d,
    segmentCount,
    manualMode,
    manualSegments,
    sceneSpeed,
    accountMissCount,
  };
}

/**
 * Persist a device's current runtime state to the SKU cache. Safe no-op
 * when no cache is configured.
 *
 */
export function persistDeviceToCache(adapter: DeviceCacheAdapter, device: GoveeDevice): void {
  if (!adapter.skuCache) {
    return;
  }
  // save() never rejects (a failed write is a warn line inside it), so the
  // callers on the event paths don't have to wait for the disk.
  void adapter.skuCache.save(goveeDeviceToCached(device));
}

/**
 * Save all devices to SKU cache, skipping only those never confirmed via
 * Cloud yet. Routine persistence — logs at debug.
 *
 */
export function saveDevicesToCache(adapter: DeviceCacheAdapter): void {
  if (!adapter.skuCache) {
    return;
  }

  let cachedCount = 0;
  let skippedCount = 0;
  for (const device of adapter.devices.values()) {
    const isLight = device.type === GOVEE_DEVICE_TYPE.LIGHT;
    if (isLight && !device.scenesChecked) {
      skippedCount++;
      adapter.log.debug(`Not caching ${deviceLabel(device)} — scenes not yet checked`);
    } else {
      void adapter.skuCache.save(goveeDeviceToCached(device));
      cachedCount++;
    }
  }
  if (skippedCount > 0) {
    adapter.log.debug(`Cached ${cachedCount} device(s), skipped ${skippedCount} not yet checked`);
  } else {
    adapter.log.debug(`Cached ${cachedCount} device(s) — next start uses cache`);
  }
}
