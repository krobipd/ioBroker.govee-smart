import { normalizeDeviceId } from "./types";

/**
 * Sanitize a string for use inside an ioBroker object id — lowercase, only
 * `[a-z0-9_-]` survive (everything else becomes `_`). Matches the historical
 * `sanitize` helpers in state-manager/sku-cache so existing object ids and
 * cache filenames keep the exact same shape.
 *
 * @param str Raw string
 */
function sanitizeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/**
 * Runtime map key for the in-memory device registry — `${sku}_<normalizedId>`
 * with the FULL normalized device id. NOT an object id, never written to disk.
 *
 * @param sku Govee SKU
 * @param deviceId Raw device id
 */
export function mapKey(sku: string, deviceId: string): string {
  return `${sku}_${normalizeDeviceId(deviceId)}`;
}

/**
 * The key of the 2.x rule — `${skuLower}_<last4>`, sanitized. Up to 2.41.0 it was the device's
 * object id below `devices.`/`groups.`, the SKU-cache filename and the local-snapshot key, derived
 * anew everywhere and never checked for a second device with the same four characters. Since 3.0.0
 * the object id comes from `DeviceIdRegistry` (`device-id.ts`); this form only still finds what 2.x
 * left behind — a cache file of the old name, a snapshot file of a store older than 2.37.0.
 *
 * @param sku Govee SKU
 * @param deviceId Raw device id
 */
export function treeKey(sku: string, deviceId: string): string {
  const shortId = normalizeDeviceId(deviceId).slice(-4);
  return sanitizeId(`${sku}_${shortId}`);
}

/**
 * On-disk key of a device's SKU-cache file — `${skuLower}_<full normalized id>`, sanitized. The full
 * id, not the object id: two devices of one SKU whose ids end in the same four characters had one
 * shared file under the 2.x name ({@link treeKey}), and the last save won (3.0.0).
 *
 * @param sku Govee SKU
 * @param deviceId Raw device id
 */
export function cacheKey(sku: string, deviceId: string): string {
  return sanitizeId(`${sku}_${normalizeDeviceId(deviceId)}`);
}

/**
 * Session key for the wizard + diagnostics-throttle maps — `${sku}:${deviceId}`
 * with the RAW (un-normalized) device id, matching the existing in-memory keys.
 * In-memory only (never persisted), so the raw form is fine.
 *
 * @param sku Govee SKU
 * @param deviceId Raw device id
 */
export function sessionKey(sku: string, deviceId: string): string {
  return `${sku}:${deviceId}`;
}
