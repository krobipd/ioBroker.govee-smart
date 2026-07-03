import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import type { GoveeDevice } from "../types";

/**
 * One account-membership source (Cloud `/user/devices`, the App-API device
 * list, or the group list). `ok` means the source was successfully queried
 * AND returned a plausible (non-empty) response this pass — an empty or failed
 * fetch is NOT ok and never drives a removal (Govee returns HTTP 200 with an
 * empty body on hiccups; a transient wobble must not delete a live device).
 * `keys` are the account keys the source reported this pass.
 */
export interface ReconcileSource {
  ok: boolean;
  keys: Set<string>;
}

/** The account sources feeding one reconcile pass. */
export interface ReconcileSources {
  /** Cloud REST `/user/devices` — authoritative for lights + appliances. */
  cloud: ReconcileSource;
  /** App-API device list — authoritative for sensors. */
  app: ReconcileSource;
  /** Group list — authoritative for BaseGroups. */
  group: ReconcileSource;
}

/** An absent source (missing credential stage, or not yet fetched). */
export const ABSENT_SOURCE: ReconcileSource = { ok: false, keys: new Set() };

/** Default consecutive-miss threshold before a device is evicted. */
export const DEFAULT_EVICT_THRESHOLD = 2;

/**
 * Device types that are NOT listed by Cloud `/user/devices` (they carry no
 * cloud capabilities) — sensors surface only through the App-API device list,
 * so that list, not the Cloud list, is authoritative for them.
 */
export function isSensorType(type: string): boolean {
  return type === GOVEE_DEVICE_TYPE.THERMOMETER || type === GOVEE_DEVICE_TYPE.SENSOR;
}

/** Which of the three account sources a device belongs to. */
export type SourceKind = "cloud" | "app" | "group";

/**
 * The source that authoritatively lists a device's type. A device is only a
 * removal candidate when THIS source refreshed AND was successfully queried AND
 * the device is absent from it — so an unrelated source can never drive a false
 * eviction (a light is never removed on the strength of the App-API list, which
 * may not carry lights at all; a sensor is never removed on a Cloud list that
 * never lists sensors).
 *
 * @param device Device to classify
 */
export function authoritativeKind(device: GoveeDevice): SourceKind {
  if (device.sku === "BaseGroup") {
    return "group";
  }
  return isSensorType(device.type) ? "app" : "cloud";
}

/** Input to {@link reconcileAccountMembership}. */
export interface ReconcileInput {
  /** The three account sources for this pass. */
  sources: ReconcileSources;
  /** The current device map's values (or any iterable of devices). */
  devices: Iterable<GoveeDevice>;
  /** Stable per-device key — MUST be the same fn the source keys were built with. */
  keyOf: (sku: string, deviceId: string) => string;
  /**
   * Which source refreshed this pass. Only devices whose authoritative source
   * is this one may have their miss counter incremented — so re-running the
   * reconcile from another trigger (reusing the other sources' stale snapshots)
   * never double-counts the debounce. Presence still resets from ANY source.
   */
  refreshedSource: SourceKind;
  /** Consecutive misses required before eviction (default {@link DEFAULT_EVICT_THRESHOLD}). */
  evictThreshold?: number;
}

/**
 * Decide which devices are no longer in the Govee account and should be
 * removed. Pure over the passed devices: it mutates each device's
 * `accountMissCount` (reset to 0 on presence, incremented on a confirmed
 * absence) and returns the ones that crossed the eviction threshold. Does NO
 * I/O — the caller performs the atomic map + cache-file + object removal.
 *
 * A device is evicted only when ALL hold:
 *  - it is NOT LAN-reachable (`channels.lan` false — LAN-first always wins),
 *  - it is absent from EVERY successfully queried source (the union — a device
 *    seen in any list is kept, belt-and-suspenders),
 *  - the source that authoritatively lists its type was successfully queried
 *    (so the absence is meaningful, not "we never asked"),
 *  - the miss persisted `evictThreshold` consecutive passes (debounce against
 *    a transient partial response).
 *
 * @param input Sources, devices, key fn, and threshold
 * @returns The devices that crossed the eviction threshold this pass
 */
export function reconcileAccountMembership(input: ReconcileInput): GoveeDevice[] {
  const { sources, devices, keyOf, refreshedSource } = input;
  const threshold = input.evictThreshold ?? DEFAULT_EVICT_THRESHOLD;
  const toEvict: GoveeDevice[] = [];
  for (const device of devices) {
    // LAN-first: a locally reachable device is definitively owned, full stop.
    if (device.channels.lan) {
      device.accountMissCount = 0;
      continue;
    }
    const key = keyOf(device.sku, device.deviceId);
    const owned =
      (sources.cloud.ok && sources.cloud.keys.has(key)) ||
      (sources.app.ok && sources.app.keys.has(key)) ||
      (sources.group.ok && sources.group.keys.has(key));
    if (owned) {
      // Presence is enough — an offline / dead-battery device still listed in
      // the account is kept (we key on membership, never on fresh values).
      device.accountMissCount = 0;
      continue;
    }
    // Absent from every ok source. Increment ONLY when the source that just
    // refreshed is the one that authoritatively lists this device's type AND it
    // was successfully queried — so a second trigger reusing another source's
    // stale snapshot cannot double-count the debounce, and a source we could
    // not query (e.g. no App-API credentials) never removes anything.
    const kind = authoritativeKind(device);
    if (kind !== refreshedSource || !sources[kind].ok) {
      continue;
    }
    device.accountMissCount = (device.accountMissCount ?? 0) + 1;
    if (device.accountMissCount >= threshold) {
      toEvict.push(device);
    }
  }
  return toEvict;
}
