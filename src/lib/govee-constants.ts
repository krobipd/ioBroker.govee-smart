/**
 * Shared Govee app-impersonation constants + capability/device-type strings.
 *
 * Capability and device-type constants replace inline string literals so a
 * typo at the call site becomes a TypeScript compile error instead of a
 * silent runtime miss. The values are dictated by Govee's Cloud API — we
 * mirror them 1:1.
 */

import { v5 as uuidv5, NIL as UUID_NIL } from "uuid";

/**
 * Govee Cloud API `capability.type` strings that the adapter references by
 * name. Only the types matched symbolically live here; the rest (on_off, range,
 * color_setting, toggle, mode, …) are compared as string literals or short
 * suffixes at their use sites (e.g. `capMatchesControl` in types.ts).
 */
export const GOVEE_CAP_TYPE = {
  DYNAMIC_SCENE: "devices.capabilities.dynamic_scene",
  PROPERTY: "devices.capabilities.property",
  MUSIC_SETTING: "devices.capabilities.music_setting",
  ONLINE: "devices.capabilities.online",
} as const;

/** Govee Cloud API device type strings (`device.type`). */
export const GOVEE_DEVICE_TYPE = {
  LIGHT: "devices.types.light",
  THERMOMETER: "devices.types.thermometer",
  SENSOR: "devices.types.sensor",
  HEATER: "devices.types.heater",
  HUMIDIFIER: "devices.types.humidifier",
  DEHUMIDIFIER: "devices.types.dehumidifier",
  FAN: "devices.types.fan",
  AIR_PURIFIER: "devices.types.air_purifier",
  SOCKET: "devices.types.socket",
  KETTLE: "devices.types.kettle",
  ICE_MAKER: "devices.types.ice_maker",
  AROMA_DIFFUSER: "devices.types.aroma_diffuser",
  /**
   * Battery button / remote (H5125, H5126). Has no connection of its own —
   * it wakes, chirps over the radio link to a gateway and sleeps again, so
   * its reachability comes from that gateway (see resolveGatewayReachability).
   */
  BUTTON: "devices.types.button",
} as const;

/** Bundled Govee-app version — the fallback until the live lookup succeeds. */
export const GOVEE_APP_VERSION = "7.6.20";
export const GOVEE_CLIENT_TYPE = "1";

/**
 * The Govee-app version the adapter impersonates in request headers. Defaults to
 * the bundled {@link GOVEE_APP_VERSION} and is updated at runtime from the live
 * App-Store lookup ({@link setAppVersion}) so the undocumented endpoints keep
 * accepting us when Govee bumps their app — without a manual constant bump.
 */
let currentAppVersion: string = GOVEE_APP_VERSION;

/** The app version to send in request headers (live if known, else bundled). */
export function getAppVersion(): string {
  return currentAppVersion;
}

/**
 * Update the impersonated app version from the live App-Store lookup. Ignores
 * empty / malformed values so a bad lookup can never break the headers — the
 * previous (bundled or last-good) version stays in effect.
 *
 * @param version Live iOS app version, e.g. "7.5.21"
 */
export function setAppVersion(version: string): void {
  if (typeof version === "string" && /^\d+(\.\d+)+$/.test(version)) {
    currentAppVersion = version;
  }
}

/** User-Agent for the Govee app endpoints, built with the current app version. */
export function goveeUserAgent(): string {
  return `GoveeHome/${currentAppVersion} (com.ihoment.GoVeeSensor; build:8; iOS 26.5.0) Alamofire/5.11.0`;
}

/**
 * Build the common Govee-app request headers. Every authenticated app endpoint
 * shares appVersion + clientId + clientType + User-Agent; the login /
 * verification calls additionally send `iotVersion` + a fresh `timestamp`
 * (`withTimestamp`), and the bearer endpoints add `Authorization` (`bearer`).
 * Kept in one place so the header set can't drift across the MQTT + App-API
 * clients. (Public endpoints with only appVersion + User-Agent build inline.)
 *
 * @param clientId Account-derived Govee client id
 * @param opts `bearer` token and/or `withTimestamp` for login-style calls
 * @param opts.bearer Bearer token — adds the `Authorization` header for authenticated endpoints
 * @param opts.withTimestamp Add `iotVersion` + a fresh `timestamp` for login / verification calls
 */
export function buildGoveeAppHeaders(
  clientId: string,
  opts: { bearer?: string; withTimestamp?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    appVersion: currentAppVersion,
    clientId,
    clientType: GOVEE_CLIENT_TYPE,
    "User-Agent": goveeUserAgent(),
  };
  if (opts.withTimestamp) {
    headers.iotVersion = "0";
    headers.timestamp = String(Date.now());
  }
  if (opts.bearer) {
    headers.Authorization = `Bearer ${opts.bearer}`;
  }
  return headers;
}

/** Base URL for the undocumented Govee app API (devices/v1/list, scene library, etc.). */
export const GOVEE_APP_BASE_URL = "https://app2.govee.com";

/**
 * Derive a stable, account-specific client ID from the user's email.
 *
 * The previous hardcoded constant looked like a single bot account from Govee's
 * side, which is the kind of thing that gets rate-limited or flagged.
 * Three reference implementations (homebridge-govee, govee2mqtt PR #652, PR #656)
 * all use UUIDv5(email) — same input always returns the same UUID, so each user
 * has one stable ID across restarts but each account is distinct.
 *
 * @param email - Govee account email address. Empty/undefined returns a deterministic
 *                fallback so existing call sites that build the ID before login
 *                don't crash; the fallback is never sent to Govee in practice.
 */
export function deriveGoveeClientId(email: string | undefined): string {
  const seed = (email ?? "").trim().toLowerCase() || "anonymous";
  return uuidv5(seed, UUID_NIL).replace(/-/g, "");
}
