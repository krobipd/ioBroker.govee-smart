import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import type { CachedDeviceData, SkuCache } from "../sku-cache";
import { deviceLabel, type GoveeDevice, type SnapshotPackets } from "../types";
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
 * The snapshot packets of a cache entry, or undefined when the entry holds
 * none — or holds the index-aligned form written before 2.40.0, which cannot
 * be told apart from a reordered list and is fetched anew (M10). A host-local
 * file: every element is checked.
 *
 * @param raw The cached `snapshotBleCmds`
 */
export function snapshotPacketsFromCache(raw: unknown): SnapshotPackets[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const packets: SnapshotPackets[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined; // the index-aligned form of 2.39.x and earlier
    }
    const { name, cmds } = entry as { name?: unknown; cmds?: unknown };
    if (typeof name !== "string" || !Array.isArray(cmds)) {
      return undefined;
    }
    packets.push({
      name,
      cmds: cmds.filter((g): g is string[] => Array.isArray(g)).map(g => g.filter(p => typeof p === "string")),
    });
  }
  return packets;
}

/**
 * The fields of a device that live only in memory — never written to the cache,
 * never read back from it (a tampered file or an old save that carries one is
 * ignored). THE list: saving, restoring and merging all use it.
 *
 * - `state`, `channels`, `lanIp`, `groupMembers` — rebuilt by LAN discovery,
 *   the Cloud list and the App API in every session
 * - `lastLanReplyAt` — the live LAN freshness stamp; a stale one would survive
 *   a restart and skew online logic (L11) — `lastLanSeenAt` is its persisted twin
 * - `iotTopic`, `lastStatusRequestAt` — the broker address the account list
 *   hands over every two minutes, and the request stamp (2.39.0)
 * - `lastReachabilityRefreshAt`, `lastLanStatusAt`, `lastLanStatusAskedAt` —
 *   attempt stamps; a restart allows one immediate attempt (they were written
 *   to the cache until 3.0.1 although their documentation said otherwise)
 */
export const RUNTIME_ONLY_KEYS = [
  "state",
  "channels",
  "lanIp",
  "groupMembers",
  "lastLanReplyAt",
  "iotTopic",
  "lastStatusRequestAt",
  "lastReachabilityRefreshAt",
  "lastLanStatusAt",
  "lastLanStatusAskedAt",
] as const satisfies readonly (keyof GoveeDevice)[];

/** One of {@link RUNTIME_ONLY_KEYS}. */
export type RuntimeOnlyKey = (typeof RUNTIME_ONLY_KEYS)[number];

/**
 * A copy without the in-memory-only fields.
 *
 * @param obj A device or a cache entry
 */
function withoutRuntimeFields<T extends object>(obj: T): Omit<T, RuntimeOnlyKey> {
  const copy = { ...obj } as Record<string, unknown>;
  for (const key of RUNTIME_ONLY_KEYS) {
    delete copy[key];
  }
  return copy as Omit<T, RuntimeOnlyKey>;
}

/**
 * Convert cached data back into a GoveeDevice: every persisted field, the
 * runtime-only ones at their boot defaults — LAN discovery, the Cloud list and
 * the App API refill them during onReady. Adding a field to GoveeDevice /
 * CachedDeviceData needs no change here (the shape is the contract).
 *
 * @param cached The cache entry
 */
export function cachedToGoveeDevice(cached: CachedDeviceData): GoveeDevice {
  const { cachedAt: _cachedAt, ...rest } = withoutRuntimeFields(cached as CachedDeviceData & Partial<GoveeDevice>);
  return {
    ...(rest as Omit<GoveeDevice, RuntimeOnlyKey>),
    // Host-local, editable file: a corrupt count or index list must not become
    // the device's segment map (same gate as the Cloud/MQTT/wizard sources).
    segmentCount: plausibleSegmentCount(rest.segmentCount),
    manualSegments: plausibleSegmentIndices(rest.manualSegments),
    snapshotBleCmds: snapshotPacketsFromCache(rest.snapshotBleCmds),
    state: { online: false },
    // The cache carries the account's capability list, and that list IS what
    // "has a cloud path" means: without it an installation without a single
    // light never ran a Cloud load on start and every cloud consumer dropped
    // the device (resolveTransport answered skip/no-channel).
    channels: { lan: false, mqtt: false, cloud: rest.capabilities.length > 0 },
  };
}

/**
 * Restore a cache entry INTO a device LAN discovery already created this
 * session — through the same restore as a new device, so every persisted field
 * arrives (until 3.0.1 this branch copied 16 fields by hand and lost
 * `sceneSpeed`, `librariesCheckedAt`, `accountMissCount` and the gateway pair
 * for every light found before the cache was read — with an account, every
 * light). What LAN discovery found in this session stays: the address, the
 * live stamps, the reachability, the LAN channel; the network stamps keep the
 * newer of the two.
 *
 * @param live The LAN-discovered device (updated in place)
 * @param cached The cache entry
 */
export function mergeCachedIntoLive(live: GoveeDevice, cached: CachedDeviceData): void {
  const restored = cachedToGoveeDevice(cached);
  const kept: Pick<GoveeDevice, RuntimeOnlyKey> = {
    state: live.state,
    channels: { ...live.channels, cloud: restored.channels.cloud },
    lanIp: live.lanIp,
    groupMembers: live.groupMembers,
    lastLanReplyAt: live.lastLanReplyAt,
    iotTopic: live.iotTopic,
    lastStatusRequestAt: live.lastStatusRequestAt,
    lastReachabilityRefreshAt: live.lastReachabilityRefreshAt,
    lastLanStatusAt: live.lastLanStatusAt,
    lastLanStatusAskedAt: live.lastLanStatusAskedAt,
  };
  Object.assign(live, restored, kept, {
    name: restored.name || live.name,
    type: restored.type || live.type,
    lastSeenOnNetwork: newer(live.lastSeenOnNetwork, restored.lastSeenOnNetwork),
    lastLanSeenAt: newer(live.lastLanSeenAt, restored.lastLanSeenAt),
  });
}

/**
 * The later of two optional stamps.
 *
 * @param a One stamp
 * @param b The other
 */
function newer(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

/**
 * Extract cacheable data from a GoveeDevice — everything but the runtime-only
 * fields, compacted by normalize(). Adding a new cacheable field to GoveeDevice:
 * no change here.
 *
 * @param device The device
 */
export function goveeDeviceToCached(device: GoveeDevice): CachedDeviceData {
  return {
    ...normalize(withoutRuntimeFields(device)),
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
function normalize<T extends Omit<GoveeDevice, RuntimeOnlyKey>>(d: T): Omit<CachedDeviceData, "cachedAt"> {
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
