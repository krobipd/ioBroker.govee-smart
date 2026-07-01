import type { AppDeviceEntry } from "../govee-api-client";
import { GOVEE_CAP_TYPE } from "../govee-constants";
import {
  SENSOR_ONLINE_FRESHNESS_DEFAULT_MS,
  SENSOR_ONLINE_FRESHNESS_MAX_MS,
  SENSOR_ONLINE_FRESHNESS_MIN_MS,
  SENSOR_ONLINE_FRESHNESS_MULTIPLIER,
} from "../timing-constants";
import type { CloudDevice, CloudStateCapability, GoveeDevice } from "../types";

/**
 * Whether a sensor's last reading is recent enough to treat the device as
 * online, independent of Govee's (sometimes stuck-false) `lastData.online`
 * flag. The window scales with the sensor's own `uploadRate` (minutes) so a
 * fast sensor flips offline quickly and a slow one isn't falsely flapped;
 * `|now - lastTime|` also tolerates minor server/local clock skew while
 * rejecting a garbage far-future timestamp.
 *
 * @param lastTime Govee reading timestamp (ms epoch) from `lastData.lastTime`
 * @param uploadRateMinutes Sensor upload interval from `settings.uploadRate`
 * @param now Current time (ms epoch); injectable for tests
 */
export function isSensorDataFresh(
  lastTime: number | undefined,
  uploadRateMinutes: number | undefined,
  now: number,
): boolean {
  if (typeof lastTime !== "number" || !Number.isFinite(lastTime)) {
    return false;
  }
  const windowMs =
    typeof uploadRateMinutes === "number" && Number.isFinite(uploadRateMinutes) && uploadRateMinutes > 0
      ? Math.min(
          Math.max(uploadRateMinutes * 60_000 * SENSOR_ONLINE_FRESHNESS_MULTIPLIER, SENSOR_ONLINE_FRESHNESS_MIN_MS),
          SENSOR_ONLINE_FRESHNESS_MAX_MS,
        )
      : SENSOR_ONLINE_FRESHNESS_DEFAULT_MS;
  return Math.abs(now - lastTime) < windowMs;
}

/**
 * Convert Cloud device to internal device model.
 *
 */
export function cloudDeviceToGoveeDevice(cd: CloudDevice): GoveeDevice {
  return {
    sku: cd.sku,
    deviceId: cd.device,
    name: cd.deviceName || cd.sku,
    type: cd.type || "unknown",
    capabilities: Array.isArray(cd.capabilities) ? cd.capabilities : [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: true },
  };
}

/**
 * Filter a raw Cloud device list to entries that carry capabilities. Govee's
 * /user/devices returns historical / deleted registrations without
 * capabilities — those are almost certainly stale and must not be added.
 *
 * @param raw Raw Cloud device list (defensively re-checked for array-ness)
 */
export function filterCloudDevicesWithCapabilities(raw: CloudDevice[]): CloudDevice[] {
  return Array.isArray(raw)
    ? raw.filter(
        cd =>
          cd &&
          typeof cd.sku === "string" &&
          typeof cd.device === "string" &&
          Array.isArray(cd.capabilities) &&
          cd.capabilities.length > 0,
      )
    : [];
}

/**
 * Convert an AppApi device entry into a synthetic capability list — the
 * App API doesn't expose capability metadata, but the user wants the same
 * `info.online` / `sensorTemperature` / `sensorHumidity` / `battery`
 * states regardless of which channel delivered the data.
 *
 * Used to bridge App-API events into the same per-device state-tree shape
 * that Cloud-driven devices produce.
 *
 * @param entry App-API device entry from the recent-data endpoint
 * @param now Current time (ms epoch) for the data-freshness online derivation; injectable for tests
 * @param hasHumidityCapability Whether the device declares a `sensorHumidity` cloud capability — Govee
 *   returns `hum:0` as a "no humidity sensor" sentinel for temp-only devices (e.g. H5109), which would
 *   otherwise create a permanent phantom `sensor_humidity=0` datapoint (#31 inspee)
 */
export function buildCapabilitiesFromAppEntry(
  entry: AppDeviceEntry,
  now: number = Date.now(),
  hasHumidityCapability = true,
): CloudStateCapability[] {
  const caps: CloudStateCapability[] = [];
  const last = entry.lastData;
  if (!last) {
    return caps;
  }
  if (typeof last.online === "boolean") {
    // Govee's gateway sensors (H5109 behind an H5042) leave `online:false`
    // stuck while readings keep flowing — trust a fresh reading timestamp over
    // the flag, but only ever ADD online-ness (never override a genuine `true`).
    const online = last.online || isSensorDataFresh(last.lastTime, entry.settings?.uploadRate, now);
    caps.push({
      type: GOVEE_CAP_TYPE.ONLINE,
      instance: "online",
      state: { value: online },
    });
  }
  if (typeof last.tem === "number" && Number.isFinite(last.tem)) {
    caps.push({
      type: GOVEE_CAP_TYPE.PROPERTY,
      instance: "sensorTemperature",
      state: { value: last.tem / 100 },
    });
  }
  // Skip the "no humidity sensor" sentinel (hum:0 on a device without a
  // declared humidity capability) so temp-only sensors don't grow a phantom
  // `sensor_humidity=0` datapoint. A real, non-zero reading is always kept,
  // and a real hygrometer (capability present) keeps humidity even at 0 %.
  if (typeof last.hum === "number" && Number.isFinite(last.hum) && (last.hum !== 0 || hasHumidityCapability)) {
    caps.push({
      type: GOVEE_CAP_TYPE.PROPERTY,
      instance: "sensorHumidity",
      state: { value: last.hum / 100 },
    });
  }
  if (typeof last.battery === "number" && Number.isFinite(last.battery)) {
    caps.push({
      type: GOVEE_CAP_TYPE.PROPERTY,
      instance: "battery",
      state: { value: last.battery },
    });
  } else if (entry.settings && typeof entry.settings.battery === "number" && Number.isFinite(entry.settings.battery)) {
    caps.push({
      type: GOVEE_CAP_TYPE.PROPERTY,
      instance: "battery",
      state: { value: entry.settings.battery },
    });
  }
  return caps;
}
