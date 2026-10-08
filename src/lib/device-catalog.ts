// The vocabulary of devices.json: device types, trust tiers, quirk fields and the commands a quirk may route.
// devices.schema.json carries the same words for editors and `npm run validate-devices`; device-catalog.test.ts
// holds both in step, so a new word is written here and in the schema — nowhere else (audit S9). No imports:
// the wiki generator under tools/ reads this file too.

/**
 * Per-SKU quirk overrides — fields the adapter checks at runtime to adapt
 * its behaviour for a specific Govee device. New fields are added here as
 * the schema evolves; the loader silently ignores unknown fields so a
 * v2.x devices.json on a v2.0 adapter still works.
 *
 * Each field listed here MUST be wired up in code (capability-mapper,
 * command-router, device-manager, …). Documentation-only fields are not
 * allowed — SKU-specific notes go into the per-release issue tracker or
 * the Wiki Devices page, not into the schema.
 *
 * Pattern families of the observed Govee quirks:
 *  1. Range-Override: API reports a wrong numeric range (colorTempRange)
 *  2. Boolean-Flag: per-SKU behaviour toggle (brokenPlatformApi, brokenBrokerCommands)
 *  3. Map-Override: per-operation routing/behaviour map (transportOverrides)
 *  4. Number-Override: API reports a wrong scalar (segmentCount, statusCmdVersion)
 *  5. Unit-Override: API reports a value in another unit (platformTempUnit)
 *  6. Capability-Ignore: API offers a capability the device never acts on (ignoredCloudCapabilities)
 */
export interface DeviceQuirks {
  /** Override color-temperature range (Govee API often claims a flat 2000-9000K, real range is narrower). */
  colorTempRange?: { min: number; max: number };
  /**
   * Override the segment count. Govee's segment capabilities sometimes advertise
   * more slots than the strip physically has. A HARD cap: overrides Cloud, the
   * cache AND the live MQTT count. Intended for cloud-only SKUs that never push
   * AA-A5 status packets and therefore can't self-correct — LAN/MQTT devices
   * usually correct themselves once a complete status push arrives.
   */
  segmentCount?: number;
  /** Cloud platform-API metadata is unreliable — adapter skips Cloud-cap mapping and falls back to LAN-default states. */
  brokenPlatformApi?: boolean;
  /**
   * The account broker does not carry this model's light commands (K18) — power, brightness, colour and colour
   * temperature go LAN → Cloud instead of LAN → broker → Cloud. Models per govee2mqtt `src/service/quirks.rs`
   * (`with_iot_api_support(false)`: H6121, H6154, H6176; issues #40, #49; read 2026-10-08). Dormant on a `seed`
   * entry like every quirk until the experimental toggle is on.
   */
  brokenBrokerCommands?: boolean;
  /**
   * Per-command transport override — forces a command through Cloud or LAN
   * regardless of the default LAN-first heuristic. Use for SKUs where
   * Govee's LAN bridge silently drops a specific protocol family (e.g. H70B3
   * pixel-display snapshots: Loxforum-verified that A4-frames are filtered
   * by the WiFi firmware before reaching the BLE side).
   *
   * Value "cloud" forces sendCloudCommand. Value "lan" is a no-op (identical
   * to omitting the field) and exists for schema symmetry. `segmentBatch`
   * routes the batch command (`segments.command`) only; the per-segment
   * commands carry no override.
   */
  transportOverrides?: Partial<Record<ConfigurableOverrideCommand, TransportTarget>>;
  /**
   * `cmdVersion` of the status request over the account broker (2.39.0).
   * Govee's devices answer version 2 (measured 2026-09-22); homebridge-govee
   * carries one exception, H6121 ("requires cmdVersion 1 for status requests",
   * `lib/utils/device-capabilities.js`). A device sent the wrong version stays
   * silent — grey after the TTL, never a false green. Dormant on a `seed`
   * entry like every quirk until the experimental toggle is on.
   */
  statusCmdVersion?: 1 | 2;
  /**
   * The unit the OpenAPI `/device/state` reports `sensorTemperature` in; `"F"`
   * converts it to °C before it reaches the °C datapoint. The model list is
   * govee2mqtt's `src/service/quirks.rs` (`with_platform_temperature_sensor_units`,
   * 15 models, read 2026-09-24) — govee2mqtt reads the platform reading as °F
   * (`src/hass_mqtt/sensor.rs`). homebridge-govee reads it differently ("in
   * whatever unit the Govee app is set to", `response-parser.js`) and decides per
   * reading (setting, declared unit, comparison with the account list's °C).
   * Only the `/device/state` reading — the account list's `tem` is hundredths of
   * °C whatever the app shows (#18).
   */
  platformTempUnit?: "F";
  /**
   * Cloud capability instances Govee lists and acknowledges with "success"
   * that the device never acts on — no datapoint is offered for them, so a
   * user is not left with a switch that does nothing. Sources: homebridge-govee
   * `lib/utils/constants.js` (H1250 `mainLightToggle`/`backgroundLightToggle`,
   * "its cloud answers {"status":"success"} to both, but the command never
   * reaches the device", #1333) and `lib/utils/device-capabilities.js` (H8120:
   * "the OpenAPI colorRgb write is accepted but does nothing on this model").
   */
  ignoredCloudCapabilities?: string[];
}

/**
 * The commands that may appear as a key of `transportOverrides` in devices.json.
 * The per-segment commands (segmentColor:N, segmentBrightness:N) carry no
 * dynamic-suffix key and no override.
 */
export const CONFIGURABLE_OVERRIDE_COMMANDS = [
  "power",
  "brightness",
  "colorRgb",
  "colorTemperature",
  "lightScene",
  "diyScene",
  "snapshot",
  "gradientToggle",
  "segmentBatch",
] as const;

/** A command that may carry a transport override in devices.json. */
export type ConfigurableOverrideCommand = (typeof CONFIGURABLE_OVERRIDE_COMMANDS)[number];

/** Where a transport override may send a command. */
export const TRANSPORT_TARGETS = ["cloud", "lan"] as const;

/** Target transport for a command override. */
export type TransportTarget = (typeof TRANSPORT_TARGETS)[number];

/** Trust tiers: multiple reports / one report with diagnostics / imported and untested. */
export const DEVICE_STATUSES = ["verified", "reported", "seed"] as const;

/** Trust tiers used to decide whether a device's quirks are applied by default. */
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * Device categories — Govee's API type without the `devices.types.` prefix, in the order the
 * wiki lists them. A Govee gateway is a device of its own: the sensor behind it is supported
 * THROUGH it, so it needs a catalog entry (2.39.0, krobi 2026-09-22).
 */
export const DEVICE_TYPES = [
  "light",
  "thermometer",
  "sensor",
  "heater",
  "humidifier",
  "dehumidifier",
  "fan",
  "air_purifier",
  "socket",
  "kettle",
  "ice_maker",
  "aroma_diffuser",
  "button",
  "gateway",
  "composter",
] as const;

/** A device category of the catalog. */
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** A single SKU entry in devices.json. */
export interface DeviceEntry {
  /** Govee app name — what users see in the Govee Home app. */
  name: string;
  /** Device category (Govee API type without `devices.types.` prefix). */
  type: DeviceType;
  /** Trust tier (see DeviceStatus). */
  status: DeviceStatus;
  /** Adapter version when this device was first supported (semver). Optional. */
  since?: string;
  /** Per-SKU quirks the adapter applies at runtime. Optional. */
  quirks?: DeviceQuirks;
}

/** Top-level structure of devices.json. */
export interface DevicesFile {
  /** Free text at the top of the file, ignored by the loader. */
  _comment?: string;
  /** SKU → entry. */
  devices: Record<string, DeviceEntry>;
}
