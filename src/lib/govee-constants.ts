/**
 * Shared Govee app-impersonation constants + capability/device-type strings.
 *
 * Capability and device-type constants replace inline string literals so a
 * typo at the call site becomes a TypeScript compile error instead of a
 * silent runtime miss. The values are dictated by Govee's Cloud API — we
 * mirror them 1:1.
 */

import { v5 as uuidv5, NIL as UUID_NIL } from "uuid";

/** Govee Cloud API capability type strings (`capability.type`). */
export const GOVEE_CAP_TYPE = {
  ON_OFF: "devices.capabilities.on_off",
  RANGE: "devices.capabilities.range",
  COLOR_SETTING: "devices.capabilities.color_setting",
  SEGMENT_COLOR_SETTING: "devices.capabilities.segment_color_setting",
  DYNAMIC_SCENE: "devices.capabilities.dynamic_scene",
  PROPERTY: "devices.capabilities.property",
  TOGGLE: "devices.capabilities.toggle",
  MUSIC_SETTING: "devices.capabilities.music_setting",
  MODE: "devices.capabilities.mode",
  ONLINE: "devices.capabilities.online",
  WORK_MODE: "devices.capabilities.work_mode",
  TEMPERATURE_SETTING: "devices.capabilities.temperature_setting",
  EVENT: "devices.capabilities.event",
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
} as const;

export const GOVEE_APP_VERSION = "7.5.20";
export const GOVEE_CLIENT_TYPE = "1";
export const GOVEE_USER_AGENT = `GoveeHome/${GOVEE_APP_VERSION} (com.ihoment.GoVeeSensor; build:8; iOS 26.5.0) Alamofire/5.11.0`;

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
