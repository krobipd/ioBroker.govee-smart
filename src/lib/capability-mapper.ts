import {
  buildUniqueLabelMap,
  errMessage,
  rgbToHex,
  type CapabilityOption,
  type CloudCapability,
  type CloudStateCapability,
  type GoveeDevice,
} from "./types";
import { applyColorTempQuirk, getDeviceQuirks } from "./device-registry";
import { GOVEE_CAP_TYPE, GOVEE_DEVICE_TYPE } from "./govee-constants";
import { resolveLabel, tDesc, tName } from "./i18n";

/** ioBroker state definition derived from a Govee capability */
export interface StateDefinition {
  /** State ID suffix (e.g. "power", "brightness", "colorRgb") */
  id: string;
  /**
   * Display name. Plain string for capability-derived names (e.g. from
   * `humanize(cap.instance)` of an unknown Govee capability — those aren't
   * predictable). For known states, a translation object `{en, de, ru, ...}`
   * built via `tName()` — Admin/vis/Object-Browser pick the user's language
   * automatically.
   */
  name: string | Record<string, string>;
  /**
   * Human-readable description shown in the object browser — used to clarify
   * ambiguous state names (e.g. cloud vs local snapshots) where the id alone
   * isn't enough for a user to know what the state does.
   */
  desc?: string | Record<string, string>;
  /** ioBroker value type */
  type: ioBroker.CommonType;
  /** ioBroker role */
  role: string;
  /** Whether state is writable */
  write: boolean;
  /** Unit string */
  unit?: string;
  /** Min value for numbers */
  min?: number;
  /** Max value for numbers */
  max?: number;
  /**
   * Predefined values for a select (value → label).
   *
   * **Labels MUST be plain-string** — Admin renders states-values as React
   * children and a `{en, de, …}` translation object triggers React Error #31
   * → fatal "Error in GUI" on dropdown open (verified 2026-05-12). For
   * localized labels, resolve via {@link resolveLabel} with the adapter's
   * `system.config.language` value once.
   */
  states?: Record<string, string>;
  /** Default value for new states */
  def?: ioBroker.StateValue;
  /** Original capability type */
  capabilityType: string;
  /** Original capability instance */
  capabilityInstance: string;
  /** Target channel (control, scenes, music, snapshots). Defaults to "control". */
  channel?: string;
}

/**
 * Coerce arbitrary value to boolean. Accepts true/1/"1"/"true" as truthy.
 *
 * @param v Raw value from API
 */
function coerceBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Stringify an unknown raw API value for an ioBroker state. Objects /
 * functions go through JSON.stringify (so we don't get `[object Object]`);
 * everything else takes the primitive `String()` path. Centralised to keep
 * the no-base-to-string lint rule happy at the call sites without
 * sprinkling type assertions all over.
 *
 * @param v Raw value from API
 */
function safeStringify(v: unknown): string {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return v.toString();
    case "undefined":
      return "undefined";
    default:
      // object, function, null
      return JSON.stringify(v);
  }
}

/**
 * Coerce arbitrary value to finite number, or null if not parseable.
 *
 * @param v Raw value from API
 */
function coerceNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

/**
 * Maps Govee Cloud API capabilities to ioBroker state definitions.
 * Pure function — no side effects, easily testable.
 *
 * @param capabilities Device capabilities from Cloud API
 * @param log Adapter logger — per-cap skip-decisions land on debug.
 */
export function mapCapabilities(capabilities: CloudCapability[], log: ioBroker.Logger): StateDefinition[] {
  const states: StateDefinition[] = [];

  if (!Array.isArray(capabilities)) {
    return states;
  }

  let mapped = 0;
  let skipped = 0;
  for (const cap of capabilities) {
    const result = mapSingleCapability(cap);
    if (result) {
      states.push(...result);
      mapped++;
    } else {
      skipped++;
      // Unknown / unhandled cap shape — log so bug reports can see what
      // Govee sent that we didn't know what to do with. Includes type+
      // instance because that's enough to grep against device-registry
      // entries when adding support for a new SKU.
      log.debug(
        `Cap skipped: type=${cap?.type ?? "?"} instance=${cap?.instance ?? "?"} — no mapping (capability not handled or malformed)`,
      );
    }
  }
  log.debug(`mapCapabilities: ${mapped} mapped, ${skipped} skipped, ${states.length} state def(s) produced`);

  return states;
}

/**
 * Probe `capabilities` for a `devices.capabilities.dynamic_scene` entry of
 * the given instance (lightScene / diyScene / snapshot). Used to gate the
 * scene/snapshot dropdowns capability-driven instead of data-driven — a
 * device that exposes the cap should always show the dropdown, even if
 * the scene list hasn't been fetched yet.
 *
 * @param capabilities Device capabilities from Cloud API
 * @param instance The dynamic_scene instance to look up
 */
export function hasDynamicSceneCapability(
  capabilities: CloudCapability[],
  instance: "lightScene" | "diyScene" | "snapshot",
): boolean {
  if (!Array.isArray(capabilities)) {
    return false;
  }
  return capabilities.some(
    cap =>
      typeof cap?.type === "string" &&
      typeof cap?.instance === "string" &&
      (cap.type === GOVEE_CAP_TYPE.DYNAMIC_SCENE || cap.type === "dynamic_scene") &&
      cap.instance === instance,
  );
}

/**
 * Single source of truth for "this state-id belongs to LAN territory". Used by:
 * - cleanupCloudOwnedStates → skip these ids when wiping cloud-owned states in the control channel
 * - buildCloudStateDefs → dedup capability-derived defs against LAN ownership (prevents double-create)
 * - cloud-state-loader → filter out LAN-state-ids when applying cloud values
 *
 * Adding a new LAN-default state means: extend this set AND add the entry in getDefaultLanStates.
 * The capability-tag-invariant test enforces both stay in lock-step.
 */
export const LAN_STATE_IDS: ReadonlySet<string> = new Set(["power", "brightness", "colorRgb", "colorTemperature"]);

/**
 * Default state definitions for LAN-only devices (no Cloud capabilities).
 * All LAN-capable Govee lights support: power, brightness, color, color temperature.
 *
 * State IDs MUST match LAN_STATE_IDS above. Invariant test in capability-mapper.test.ts
 * fails if these drift apart.
 */
export function getDefaultLanStates(): StateDefinition[] {
  return [
    {
      id: "power",
      name: tName("power"),
      type: "boolean",
      role: "switch",
      write: true,
      def: false,
      capabilityType: "lan",
      capabilityInstance: "powerSwitch",
    },
    {
      id: "brightness",
      name: tName("brightness"),
      type: "number",
      role: "level.brightness",
      write: true,
      min: 0,
      max: 100,
      unit: "%",
      def: 0,
      capabilityType: "lan",
      capabilityInstance: "brightness",
    },
    {
      id: "colorRgb",
      name: tName("colorRgb"),
      type: "string",
      role: "level.color.rgb",
      write: true,
      def: "#000000",
      capabilityType: "lan",
      capabilityInstance: "colorRgb",
    },
    {
      id: "colorTemperature",
      name: tName("colorTemperature"),
      type: "number",
      role: "level.color.temperature",
      write: true,
      min: 2000,
      max: 9000,
      unit: "K",
      def: 2000,
      capabilityType: "lan",
      capabilityInstance: "colorTemperatureK",
    },
  ];
}

/**
 * Map a single capability to state definition(s)
 *
 * @param cap Cloud capability to map
 */
function mapSingleCapability(cap: CloudCapability): StateDefinition[] | null {
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return null;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");

  switch (shortType) {
    case "on_off":
      return [
        {
          id: "power",
          name: tName("power"),
          type: "boolean",
          role: "switch",
          write: true,
          def: false,
          capabilityType: cap.type,
          capabilityInstance: cap.instance,
        },
      ];

    case "range":
      return mapRange(cap);

    case "color_setting":
      return mapColorSetting(cap);

    case "toggle":
      return [
        {
          id: sanitizeId(cap.instance),
          name: humanize(cap.instance),
          type: "boolean",
          role: "switch",
          write: true,
          def: false,
          capabilityType: cap.type,
          capabilityInstance: cap.instance,
        },
      ];

    case "mode":
      return mapMode(cap);

    case "property":
      return mapProperty(cap);

    case "online":
      // Handled separately — not a regular state
      return null;

    case "segment_color_setting":
      // Segments are handled specially by state-manager
      return [
        {
          id: `_segment_${sanitizeId(cap.instance)}`,
          name: humanize(cap.instance),
          type: "string",
          role: "json",
          write: true,
          capabilityType: cap.type,
          capabilityInstance: cap.instance,
        },
      ];

    case "dynamic_scene":
      // lightScene / diyScene / snapshot get real dropdowns built later in
      // buildCloudStateDefs from the scenes/snapshots arrays — skip the
      // generic stub here so we don't create and immediately delete it.
      if (cap.instance === "lightScene" || cap.instance === "diyScene" || cap.instance === "snapshot") {
        return null;
      }
      return [
        {
          id: sanitizeId(cap.instance),
          name: humanize(cap.instance),
          type: "string",
          role: "json",
          write: true,
          def: "",
          capabilityType: cap.type,
          capabilityInstance: cap.instance,
        },
      ];

    case "work_mode":
      return mapWorkMode(cap);

    case "temperature_setting":
      return mapTemperatureSetting(cap);

    case "event":
      return mapEvent(cap);

    case "music_setting":
      return mapMusicSetting(cap);

    default:
      return null;
  }
}

/**
 * Map range capability (brightness, humidity, etc.)
 *
 * @param cap Cloud range capability
 */
function mapRange(cap: CloudCapability): StateDefinition[] {
  const range = cap.parameters?.range;
  const isBrightness = cap.instance.toLowerCase().includes("brightness");

  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "number",
      role: isBrightness ? "level.brightness" : "level",
      write: true,
      min: range?.min ?? 0,
      max: range?.max ?? 100,
      unit: normalizeUnit(cap.parameters?.unit),
      def: range?.min ?? 0,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    },
  ];
}

/**
 * Map color_setting capability (RGB or color temperature)
 *
 * @param cap Cloud color setting capability
 */
function mapColorSetting(cap: CloudCapability): StateDefinition[] {
  if (cap.instance === "colorRgb") {
    return [
      {
        id: "colorRgb",
        name: tName("colorRgb"),
        type: "string",
        role: "level.color.rgb",
        write: true,
        def: "#000000",
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      },
    ];
  }

  if (cap.instance === "colorTemperatureK" || cap.instance.includes("colorTem")) {
    const range = cap.parameters?.range;
    return [
      {
        id: "colorTemperature",
        name: tName("colorTemperature"),
        type: "number",
        role: "level.color.temperature",
        write: true,
        min: range?.min ?? 2000,
        max: range?.max ?? 9000,
        unit: "K",
        def: range?.min ?? 2000,
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      },
    ];
  }

  return [];
}

/**
 * Map mode capability (scenes with ENUM options)
 *
 * @param cap Cloud mode capability
 */
function mapMode(cap: CloudCapability): StateDefinition[] {
  if (cap.instance !== "presetScene" || !Array.isArray(cap.parameters?.options)) {
    return [];
  }

  const states: Record<string, string> = {};
  for (const opt of cap.parameters.options) {
    if (!opt || typeof opt.name !== "string") {
      continue;
    }
    const val = safeStringify(opt.value);
    states[val] = opt.name;
  }

  return [
    {
      id: "scene",
      name: tName("scene"),
      type: "mixed",
      role: "state",
      write: true,
      states,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    },
  ];
}

/**
 * Map property capability (read-only sensors). Routes to the `sensor`
 * channel so a Heater's temperature reading sits cleanly next to other
 * sensor-style states instead of in `control`.
 *
 * @param cap Cloud property capability
 */
function mapProperty(cap: CloudCapability): StateDefinition[] {
  const instance = cap.instance.toLowerCase();
  let role = "value";
  let unit: string | undefined;

  if (instance.includes("temperature")) {
    role = "value.temperature";
    unit = "°C";
  } else if (instance.includes("humidity")) {
    role = "value.humidity";
    unit = "%";
  } else if (instance.includes("battery")) {
    role = "value.battery";
    unit = "%";
  } else if (instance.includes("co2") || instance.includes("carbondioxide")) {
    role = "value.co2";
    unit = "ppm";
  }

  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "number",
      role,
      write: false,
      unit: normalizeUnit(cap.parameters?.unit) ?? unit,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
      channel: "sensor",
    },
  ];
}

/**
 * Map work_mode capability (STRUCT — Govee Heater/Humidifier/Fan/...).
 *
 * Two states max:
 *   - `work_mode` — main mode dropdown (mixed type so users can write
 *     either the numeric mode value or the label name)
 *   - `mode_value` — secondary parameter (e.g. fan-speed level for the
 *     "manual" mode); only created if the API actually exposes one
 *
 * @param cap Cloud work_mode capability
 */
function mapWorkMode(cap: CloudCapability): StateDefinition[] {
  const fields = cap.parameters?.fields;
  if (!fields || fields.length === 0) {
    return [
      {
        id: "work_mode",
        name: tName("workMode"),
        type: "mixed",
        role: "level.mode.work",
        write: true,
        def: "",
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      },
    ];
  }

  const states: StateDefinition[] = [];
  const modeField = fields.find(f => f && f.fieldName === "workMode");
  if (modeField?.options && modeField.options.length > 0) {
    const modeStates: Record<string, string> = {};
    for (const opt of modeField.options) {
      if (opt && typeof opt.name === "string") {
        modeStates[safeStringify(opt.value)] = opt.name;
      }
    }
    states.push({
      id: "work_mode",
      name: tName("workMode"),
      type: "mixed",
      role: "level.mode.work",
      write: true,
      states: modeStates,
      def: modeField.options[0] ? safeStringify(modeField.options[0].value) : "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    });
  }

  const valueField = fields.find(f => f && f.fieldName === "modeValue");
  if (valueField) {
    if (valueField.options && valueField.options.length > 0) {
      const valStates: Record<string, string> = {};
      for (const opt of valueField.options) {
        if (opt && typeof opt.name === "string") {
          valStates[safeStringify(opt.value)] = opt.name;
        }
      }
      states.push({
        id: "mode_value",
        name: tName("modeValue"),
        type: "mixed",
        role: "state",
        write: true,
        states: valStates,
        def: valueField.options[0] ? safeStringify(valueField.options[0].value) : "",
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      });
    } else if (valueField.range) {
      states.push({
        id: "mode_value",
        name: tName("modeValue"),
        type: "number",
        role: "level",
        write: true,
        min: valueField.range.min,
        max: valueField.range.max,
        def: valueField.range.min,
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      });
    }
  }

  return states;
}

/**
 * Map temperature_setting capability — Heater target-temp slider.
 * Honours the unit reported by the API (°F or °C); falls back to °F
 * because that's the more common Govee Heater default.
 *
 * @param cap Cloud temperature_setting capability
 */
function mapTemperatureSetting(cap: CloudCapability): StateDefinition[] {
  const fields = cap.parameters?.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    const tempField = fields.find(f => {
      if (!f || typeof f.fieldName !== "string") {
        return false;
      }
      if (f.fieldName === "targetTemperature") {
        return true;
      }
      return f.fieldName.toLowerCase().includes("temperature");
    });
    if (tempField?.range) {
      const unit = normalizeUnit(cap.parameters?.unit) ?? "°F";
      return [
        {
          id: "target_temperature",
          name: tName("targetTemperature"),
          type: "number",
          role: "level.temperature",
          write: true,
          min: tempField.range.min,
          max: tempField.range.max,
          unit,
          def: tempField.range.min,
          capabilityType: cap.type,
          capabilityInstance: cap.instance,
        },
      ];
    }
  }

  const range = cap.parameters?.range;
  if (range) {
    const unit = normalizeUnit(cap.parameters?.unit) ?? "°F";
    return [
      {
        id: "target_temperature",
        name: tName("targetTemperature"),
        type: "number",
        role: "level.temperature",
        write: true,
        min: range.min,
        max: range.max,
        unit,
        def: range.min,
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      },
    ];
  }

  // No usable schema — expose the raw payload so the user at least sees
  // the attempt and can report it. Stays JSON to avoid pretending we
  // understand the structure.
  return [
    {
      id: "target_temperature",
      name: tName("targetTemperature"),
      type: "string",
      role: "json",
      write: true,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    },
  ];
}

/**
 * Map event capability (asynchronous OpenAPI-MQTT alarms — read-only).
 * Each event becomes a boolean indicator in the events/ channel
 * (lackWater, iceFull, bodyAppeared, dirtDetected, …).
 *
 * @param cap Cloud event capability
 */
function mapEvent(cap: CloudCapability): StateDefinition[] {
  return [
    {
      id: sanitizeId(cap.instance),
      name: humanize(cap.instance),
      type: "boolean",
      role: "indicator.alarm",
      write: false,
      def: false,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
      channel: "events",
    },
  ];
}

/**
 * Map music_setting capability to user-friendly states.
 * Parses STRUCT fields into: mode dropdown, sensitivity slider, auto-color toggle.
 *
 * @param cap Cloud music_setting capability
 */
/**
 * Ordered list of valid music-mode options from a music_setting capability.
 * Both the dropdown builder ({@link mapMusicSetting}) and the send path
 * (`sendMusicCommand` in state-change-router) resolve music modes through THIS
 * function, so the index→value mapping can never drift between what the user
 * selects and what is sent to the device.
 *
 * @param cap A music_setting capability
 * @returns The `musicMode` field's options (string name only), in API order
 */
export function getMusicModeOptions(cap: CloudCapability): CapabilityOption[] {
  const fields = cap.parameters?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  const modeField = fields.find(f => f && typeof f.fieldName === "string" && f.fieldName === "musicMode");
  if (!modeField?.options || !Array.isArray(modeField.options)) {
    return [];
  }
  return modeField.options.filter(o => !!o && typeof o.name === "string");
}

function mapMusicSetting(cap: CloudCapability): StateDefinition[] {
  const fields = cap.parameters?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    // No field details from API — can't create usable states
    return [];
  }

  const states: StateDefinition[] = [];

  // Mode dropdown — only if API provides actual mode options. Index-based
  // (0 = "---" sentinel), consistent with every other dropdown; the device
  // value for index N is modeOptions[N-1].value, resolved at send time through
  // the SAME getMusicModeOptions() list so build and send never drift. The old
  // value-keyed scheme collided with the sentinel on 0-based SKUs, making the
  // first music mode unreachable (A1).
  const modeOptions = getMusicModeOptions(cap);
  if (modeOptions.length > 0) {
    states.push({
      id: "music_mode",
      name: tName("musicMode"),
      type: "mixed",
      role: "state",
      write: true,
      states: buildUniqueLabelMap(modeOptions),
      def: "0",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    });
  }

  // Sensitivity slider
  const sensField = fields.find(f => f && typeof f.fieldName === "string" && f.fieldName === "sensitivity");
  if (sensField?.range) {
    states.push({
      id: "music_sensitivity",
      name: tName("musicSensitivity"),
      type: "number",
      role: "level",
      write: true,
      min: sensField.range.min,
      max: sensField.range.max,
      unit: "%",
      def: sensField.range.max,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    });
  }

  // Auto color toggle
  const autoColorField = fields.find(f => f && typeof f.fieldName === "string" && f.fieldName === "autoColor");
  if (autoColorField) {
    states.push({
      id: "music_auto_color",
      name: tName("musicAutoColor"),
      type: "boolean",
      role: "switch",
      write: true,
      def: true,
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    });
  }

  // All music states belong to the music channel
  for (const s of states) {
    s.channel = "music";
  }
  return states;
}

/**
 * Apply device quirks to mapped state definitions.
 * Corrects wrong API data (e.g. color temperature range) for specific SKUs.
 *
 * @param sku Device model (e.g. "H60A1")
 * @param states State definitions to adjust
 * @param log Adapter logger — quirk-applied events land on debug.
 */
export function applyQuirksToStates(sku: string, states: StateDefinition[], log: ioBroker.Logger): StateDefinition[] {
  for (const state of states) {
    if (state.id === "colorTemperature" && state.min != null && state.max != null) {
      const corrected = applyColorTempQuirk(sku, state.min, state.max);
      if (corrected.min !== state.min || corrected.max !== state.max) {
        log.debug(
          `Quirk applied for ${sku}: colorTemperature range ${state.min}-${state.max}K → ${corrected.min}-${corrected.max}K`,
        );
      }
      state.min = corrected.min;
      state.max = corrected.max;
      state.def = corrected.min;
    }
  }
  return states;
}

/** Known Govee API unit strings → ioBroker units */
const UNIT_MAP: Record<string, string> = {
  "unit.percent": "%",
  "unit.kelvin": "K",
  "unit.celsius": "°C",
  "unit.fahrenheit": "°F",
};

/**
 * Normalize Govee API unit string to ioBroker standard
 *
 * @param unit Raw unit string from API
 */
function normalizeUnit(unit?: string): string | undefined {
  if (!unit) {
    return undefined;
  }
  return UNIT_MAP[unit] ?? unit;
}

/**
 * Sanitize a string for use as ioBroker state ID
 *
 * @param str Input string to sanitize
 */
function sanitizeId(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase();
}

/**
 * Convert camelCase to human-readable name
 *
 * @param str camelCase input string
 */
function humanize(str: string): string {
  // Order: first underscore → space, then camelCase split, then trim +
  // uppercase the first character. Previously leading-underscore IDs
  // (e.g. `_segment_color`) became ` segment color` with a leading space
  // and no capitalization (^\w matches a space, not a word char).
  return str
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, c => c.toUpperCase());
}

/** Mapped Cloud state value: state ID + converted value */
export interface CloudStateValue {
  /** State ID in control/ channel (e.g. "power", "brightness", "gradient_toggle") */
  stateId: string;
  /** Converted value ready for ioBroker setStateAsync */
  value: ioBroker.StateValue;
}

/**
 * Map a Cloud device state capability to a state ID + converted value.
 * Uses the same ID logic as mapCapabilities so IDs always match.
 *
 * @param cap Cloud state capability with current value
 */
export function mapCloudStateValue(cap: CloudStateCapability): CloudStateValue | null {
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return null;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");
  const raw = cap.state?.value;
  if (raw === undefined || raw === null) {
    return null;
  }

  switch (shortType) {
    case "on_off":
      return { stateId: "power", value: coerceBool(raw) };

    case "range": {
      const n = coerceNum(raw);
      if (n === null) {
        return null;
      }
      return { stateId: sanitizeId(cap.instance), value: n };
    }

    case "color_setting":
      if (cap.instance === "colorRgb") {
        const num = coerceNum(raw) ?? 0;
        return {
          stateId: "colorRgb",
          value: rgbToHex((num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff),
        };
      }
      if (cap.instance.includes("colorTem")) {
        const n = coerceNum(raw);
        if (n === null) {
          return null;
        }
        return { stateId: "colorTemperature", value: n };
      }
      return null;

    case "toggle":
      return { stateId: sanitizeId(cap.instance), value: coerceBool(raw) };

    case "mode":
      if (cap.instance === "presetScene") {
        return {
          stateId: "scene",
          value: safeStringify(raw),
        };
      }
      return null;

    case "dynamic_scene":
      // snapshot is an action-only dropdown (activate a saved snapshot) — there
      // is no persistent "current snapshot" status, and its real state id is
      // snapshot_cloud (not "snapshot"), so a cloud-state write here only
      // produced a "has no existing object" warning (B12). Skip it. lightScene /
      // diyScene DO have a meaningful active value and sanitizeId maps them to
      // light_scene / diy_scene, which match their real states.
      if (cap.instance === "snapshot") {
        return null;
      }
      return {
        stateId: sanitizeId(cap.instance),
        value: safeStringify(raw),
      };

    case "work_mode": {
      // STRUCT: { workMode: <number>, modeValue?: <number> }. Cloud
      // /device/state only returns the primary mode here — mode_value
      // (sub-parameter) follows via MQTT status push when the device
      // reports it, so we don't lose it just because it isn't in the
      // initial state response.
      if (typeof raw === "object" && raw !== null) {
        const struct = raw as Record<string, unknown>;
        const n = coerceNum(struct.workMode);
        if (n !== null) {
          return { stateId: "work_mode", value: n };
        }
      }
      const direct = coerceNum(raw);
      if (direct !== null) {
        return { stateId: "work_mode", value: direct };
      }
      return null;
    }

    case "temperature_setting": {
      // STRUCT: { targetTemperature: <number>, temperatureUnit?: ... }
      // — fall back to direct number for adapters that simplify.
      const direct = coerceNum(raw);
      if (direct !== null) {
        return { stateId: "target_temperature", value: direct };
      }
      if (typeof raw === "object" && raw !== null) {
        const struct = raw as Record<string, unknown>;
        const temp = struct.targetTemperature ?? struct.temperature ?? struct.temp;
        const n = coerceNum(temp);
        if (n !== null) {
          return { stateId: "target_temperature", value: n };
        }
      }
      return null;
    }

    case "event":
      return {
        stateId: sanitizeId(cap.instance),
        value: coerceBool(raw),
      };

    case "music_setting":
      // Extract mode value from STRUCT state
      if (typeof raw === "object" && raw !== null) {
        const struct = raw as Record<string, unknown>;
        const mode = coerceNum(struct.musicMode);
        return {
          stateId: "music_mode",
          value: mode !== null ? String(mode) : "0",
        };
      }
      return null;

    case "property": {
      const n = coerceNum(raw);
      if (n === null) {
        return null;
      }
      return { stateId: sanitizeId(cap.instance), value: n };
    }

    default:
      return null;
  }
}

/**
 * Plan the per-state writes for a list of synthesised Cloud-state
 * capabilities. Used by the App-API poll and the OpenAPI-MQTT event
 * handler (both call into `applyCloudCapabilities` on the adapter side).
 *
 * Returns the resolved `(stateId, value)` pairs for capabilities that:
 *   - decode via `mapCloudStateValue` to a non-null result, AND
 *   - aren't shadowed by the LAN-state set when the device is LAN-capable
 *     (lights with `lanIp` shouldn't have their LAN sub-second updates
 *      overwritten by a Cloud-source value).
 *
 * Pure function — no adapter state, no I/O — so the LAN-shadow logic is
 * unit-testable independent of the live state-write pipeline.
 *
 * @param caps Capabilities to consider
 * @param hasLanIp Whether the target device has a known LAN IP
 * @param lanStateIds Default-LAN state IDs that LAN delivers authoritatively
 */
export function planCloudCapabilityWrites(
  caps: CloudStateCapability[],
  hasLanIp: boolean,
  lanStateIds: ReadonlySet<string>,
): CloudStateValue[] {
  const writes: CloudStateValue[] = [];
  if (!Array.isArray(caps)) {
    return writes;
  }
  for (const cap of caps) {
    const mapped = mapCloudStateValue(cap);
    if (!mapped) {
      continue;
    }
    if (hasLanIp && lanStateIds.has(mapped.stateId)) {
      continue;
    }
    writes.push(mapped);
  }
  return writes;
}

/**
 * Scene-dropdown rules — three states with identical shape (dropdown over a
 * device-content array, capabilityType `dynamic_scene`). Adding a new
 * scene-style dropdown means: append one entry here. The 8 other Cloud-derived
 * states (scene_speed, refresh_cloud, snapshot_local/save/delete, diag.*)
 * have genuinely different shapes and stay inline — not the same anti-pattern.
 */
const SCENE_DROPDOWN_RULES: ReadonlyArray<{
  id: string;
  cap: "lightScene" | "diyScene" | "snapshot";
  nameKey: Parameters<typeof tName>[0];
  descKey?: Parameters<typeof tDesc>[0];
  channel: "scenes" | "snapshots";
  source: (d: GoveeDevice) => { name: string }[];
}> = [
  { id: "light_scene", cap: "lightScene", nameKey: "lightScene", channel: "scenes", source: d => d.scenes },
  { id: "diy_scene", cap: "diyScene", nameKey: "diyScene", channel: "scenes", source: d => d.diyScenes },
  {
    id: "snapshot_cloud",
    cap: "snapshot",
    nameKey: "cloudSnapshot",
    descKey: "cloudSnapshotDesc",
    channel: "snapshots",
    source: d => d.snapshots,
  },
];

/**
 * Build LAN-owned state definitions for a device. Returns the four
 * lan-default states (power/brightness/colorRgb/colorTemperature) with quirks
 * applied, or [] for devices without a LAN address (sensors, appliances,
 * groups).
 *
 * Phase architecture: belongs to the LAN phase. Called when a device becomes
 * visible via LAN discovery or is loaded with a lanIp from the cache.
 *
 * @param device Govee device
 * @param log Adapter logger — forwarded to applyQuirksToStates.
 */
export function buildLanStateDefs(device: GoveeDevice, log: ioBroker.Logger): StateDefinition[] {
  if (!device.lanIp) {
    return [];
  }
  const stateDefs = getDefaultLanStates();
  applyQuirksToStates(device.sku, stateDefs, log);
  return stateDefs;
}

/**
 * The three diagnostics states (export button, JSON result, trust tier).
 * Shared by buildCloudStateDefs (tier default "unknown") and
 * buildGroupStateDefs (tier default "verified") — only the tier default differs.
 *
 * @param tierDef Initial value for the diag.tier state
 */
function buildDiagStateDefs(tierDef: string | null): StateDefinition[] {
  const defs: StateDefinition[] = [
    {
      id: "export",
      name: tName("exportDiagnostics"),
      type: "boolean",
      role: "button",
      write: true,
      def: false,
      capabilityType: "local",
      capabilityInstance: "diagnosticsExport",
      channel: "diag",
    },
    {
      id: "result",
      name: tName("diagnosticsJson"),
      type: "string",
      role: "json",
      write: false,
      def: "",
      capabilityType: "local",
      capabilityInstance: "diagnosticsResult",
      channel: "diag",
    },
  ];
  // The trust tier is a per-SKU catalog attribute — meaningless for a BaseGroup
  // (not a real device), which used to show a hard-coded "verified". Groups pass
  // null and get no tier state at all (B4).
  if (tierDef !== null) {
    defs.push({
      id: "tier",
      name: tName("deviceTier"),
      type: "string",
      role: "text",
      write: false,
      def: tierDef,
      states: {
        verified: resolveLabel("deviceTierVerified"),
        reported: resolveLabel("deviceTierReported"),
        seed: resolveLabel("deviceTierSeed"),
        unknown: resolveLabel("deviceTierUnknown"),
      },
      capabilityType: "local",
      capabilityInstance: "diagnosticsTier",
      channel: "diag",
    });
  }
  return defs;
}

/**
 * Build Cloud-owned state definitions for a device — everything that needs
 * Cloud capabilities or local synthetic decoration. Excludes LAN-default IDs
 * (the LAN phase owns those). Returns intersection state for BaseGroup
 * devices.
 *
 * Phase architecture: belongs to the Cloud phase. Called when capabilities for
 * a device become available from the cache or a fresh cloud load.
 *
 * @param device Govee device
 * @param log Adapter logger — forwarded to mapCapabilities / applyQuirksToStates.
 * @param localSnapshots Optional local snapshot names
 * @param memberDevices Resolved member devices (only for BaseGroup)
 */
export function buildCloudStateDefs(
  device: GoveeDevice,
  log: ioBroker.Logger,
  localSnapshots?: { name: string }[],
  memberDevices?: GoveeDevice[],
): StateDefinition[] {
  if (device.sku === "BaseGroup") {
    return buildGroupStateDefs(memberDevices || []);
  }

  // Per-SKU quirk: brokenPlatformApi → don't trust the platform-cap tree.
  // Skip capability-derived defs AND the scene/snapshot dropdowns (they're
  // gated by hasDynamicSceneCapability which reads device.capabilities, i.e.
  // the same untrusted source). LAN-phase still creates power / brightness /
  // colorRgb / colorTemperature defaults so the device stays controllable.
  const quirks = getDeviceQuirks(device.sku);
  const skipCapabilities = quirks?.brokenPlatformApi === true;

  // Capability-derived states. A LAN-owning light (lanIp set) lets the LAN
  // phase own the four control ids (power/brightness/colorRgb/colorTemperature)
  // — they are filtered out here so they are not double-created in the same
  // channel. Without a lanIp there is NO LAN phase to provide them and nothing
  // to double-create, so keep the cap-derived control states: a cloud-only
  // light (owner never enabled the local API) stays controllable via the Cloud,
  // and appliances (which never have a LAN phase) keep their on/off too. The
  // command-router routes these via Cloud (`no-lan` / `light-no-lan-fallback`).
  // Local-first stays, local-only does not. Sensors carry no such caps; groups
  // returned earlier. LAN lights are unchanged.
  const noLanPhase = !device.lanIp;
  const stateDefs: StateDefinition[] = skipCapabilities
    ? []
    : mapCapabilities(device.capabilities, log).filter(d => noLanPhase || !LAN_STATE_IDS.has(d.id));

  if (skipCapabilities) {
    log.debug(`${device.sku}: brokenPlatformApi quirk active — skipping capability-derived states + dropdowns`);
  }

  applyQuirksToStates(device.sku, stateDefs, log);

  // Light-only synthetic state defs — scenes / snapshots / music / scene_speed
  // only make sense for lights. Sensors and appliances would otherwise see
  // empty snapshot dropdowns and a useless save/delete button pair.
  const isLight = device.type === GOVEE_DEVICE_TYPE.LIGHT;

  // Three structurally-identical Cloud dropdowns — collapsed into one loop.
  for (const r of SCENE_DROPDOWN_RULES) {
    if (skipCapabilities || !isLight || !hasDynamicSceneCapability(device.capabilities, r.cap)) {
      continue;
    }
    stateDefs.push({
      id: r.id,
      name: tName(r.nameKey),
      desc: r.descKey ? tDesc(r.descKey) : undefined,
      // mixed lets users write the index ("1"), the index as number (1),
      // or the entry name ("Aurora") — the onStateChange handler resolves
      // all three forms via the common.states map.
      type: "mixed",
      role: "state",
      write: true,
      states: buildUniqueLabelMap(r.source(device)),
      def: "0",
      capabilityType: GOVEE_CAP_TYPE.DYNAMIC_SCENE,
      capabilityInstance: r.cap,
      channel: r.channel,
    });
  }

  // Scene speed slider — only if any scene supports speed adjustment.
  // Stays inline: depends on a computed maxSpeedLevel that doesn't fit the
  // dropdown-rule shape.
  const maxSpeedLevel = device.sceneLibrary.reduce((max, entry) => {
    if (entry.speedInfo?.supSpeed && entry.speedInfo.config) {
      try {
        const parsed = JSON.parse(entry.speedInfo.config) as unknown;
        // Config can drift — if not an array, skip this entry silently
        if (!Array.isArray(parsed)) {
          return max;
        }
        for (const cfg of parsed as Array<{ moveIn?: number[] }>) {
          if (cfg && Array.isArray(cfg.moveIn) && cfg.moveIn.length - 1 > max) {
            max = cfg.moveIn.length - 1;
          }
        }
      } catch (e) {
        log.debug(`${device.sku}: speed-config parse failed for scene "${entry.name}": ${errMessage(e)}`);
      }
    }
    return max;
  }, -1);
  if (isLight && maxSpeedLevel > 0) {
    stateDefs.push({
      id: "scene_speed",
      name: tName("sceneSpeed"),
      type: "number",
      role: "level",
      write: true,
      min: 0,
      max: maxSpeedLevel,
      def: 0,
      capabilityType: "local",
      capabilityInstance: "sceneSpeed",
      channel: "scenes",
    });
  }

  // Per-device refresh button — gated on ANY dynamic-scene capability.
  // OR-gate over three caps doesn't fit a rules-table.
  // brokenPlatformApi gate skips this too: the refresh action would post a
  // user-facing button for a Cloud endpoint that wasn't trustable to begin
  // with.
  if (
    !skipCapabilities &&
    isLight &&
    (hasDynamicSceneCapability(device.capabilities, "lightScene") ||
      hasDynamicSceneCapability(device.capabilities, "diyScene") ||
      hasDynamicSceneCapability(device.capabilities, "snapshot"))
  ) {
    stateDefs.push({
      id: "refresh_cloud",
      name: tName("refreshCloud"),
      desc: tDesc("refreshCloudDesc"),
      type: "boolean",
      role: "button",
      write: true,
      def: false,
      capabilityType: "local",
      capabilityInstance: "refreshCloud",
      channel: "snapshots",
    });
  }

  // Local snapshots — three states with different shapes (mixed dropdown vs
  // plain string-write fields). Inline because a rules-table would need a
  // discriminator field with no payoff.
  if (isLight) {
    stateDefs.push({
      id: "snapshot_local",
      name: tName("localSnapshot"),
      desc: tDesc("localSnapshotDesc"),
      type: "mixed",
      role: "state",
      write: true,
      states: buildUniqueLabelMap(localSnapshots ?? []),
      def: "0",
      capabilityType: "local",
      capabilityInstance: "snapshotLocal",
      channel: "snapshots",
    });
    stateDefs.push({
      id: "snapshot_save",
      name: tName("saveLocalSnapshot"),
      desc: tDesc("saveLocalSnapshotDesc"),
      type: "string",
      role: "text",
      write: true,
      def: "",
      capabilityType: "local",
      capabilityInstance: "snapshotSave",
      channel: "snapshots",
    });
    stateDefs.push({
      id: "snapshot_delete",
      name: tName("deleteLocalSnapshot"),
      desc: tDesc("deleteLocalSnapshotDesc"),
      type: "string",
      role: "text",
      write: true,
      def: "",
      capabilityType: "local",
      capabilityInstance: "snapshotDelete",
      channel: "snapshots",
    });
  }

  // Diagnostics — export button, JSON result, trust tier. Default tier
  // "unknown" for a real device (its actual tier comes from the registry).
  stateDefs.push(...buildDiagStateDefs("unknown"));

  return stateDefs;
}

/**
 * Check if a member device supports a given control state.
 * LAN-capable devices support all basic controls.
 *
 * @param member Group member device
 * @param stateId Control state ID (e.g. "power", "brightness")
 */
function memberHasControlState(member: GoveeDevice, stateId: string): boolean {
  if (member.lanIp) {
    return true;
  }
  const caps = Array.isArray(member.capabilities) ? member.capabilities : [];
  switch (stateId) {
    case "power":
      return caps.some(c => c && typeof c.type === "string" && c.type.endsWith("on_off"));
    case "brightness":
      return caps.some(
        c =>
          c &&
          typeof c.type === "string" &&
          typeof c.instance === "string" &&
          c.type.endsWith("range") &&
          c.instance === "brightness",
      );
    case "colorRgb":
      return caps.some(
        c =>
          c &&
          typeof c.type === "string" &&
          typeof c.instance === "string" &&
          c.type.endsWith("color_setting") &&
          c.instance === "colorRgb",
      );
    case "colorTemperature":
      return caps.some(
        c =>
          c &&
          typeof c.type === "string" &&
          typeof c.instance === "string" &&
          c.type.endsWith("color_setting") &&
          (c.instance === "colorTem" || c.instance === "colorTemperatureK"),
      );
    default:
      return false;
  }
}

/**
 * Build state definitions for a BaseGroup device.
 * Capabilities = intersection of controllable member devices.
 * No snapshots, no segments; diag-states (export/result/tier) included since v2.9.1.
 *
 * @param members Resolved member devices
 */
function buildGroupStateDefs(members: GoveeDevice[]): StateDefinition[] {
  const controllable = members.filter(m => m.lanIp || m.channels.cloud);
  if (controllable.length === 0) {
    return [];
  }

  const stateDefs: StateDefinition[] = [];

  // Control states: intersection of member capabilities
  for (const ld of getDefaultLanStates()) {
    if (controllable.every(m => memberHasControlState(m, ld.id))) {
      stateDefs.push(ld);
    }
  }

  // Scenes: intersection of member scene names
  if (controllable.every(m => m.scenes.length > 0)) {
    const firstNames = controllable[0].scenes.map(s => s.name);
    const commonNames = firstNames.filter(name => controllable.every(m => m.scenes.some(s => s.name === name)));
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "light_scene",
        name: tName("lightScene"),
        type: "mixed",
        role: "state",
        write: true,
        states: buildUniqueLabelMap(commonNames.map(name => ({ name }))),
        def: "0",
        capabilityType: GOVEE_CAP_TYPE.DYNAMIC_SCENE,
        capabilityInstance: "lightScene",
        channel: "scenes",
      });
    }
  }

  // Music: intersection of member music libraries
  if (controllable.every(m => m.musicLibrary.length > 0)) {
    const firstNames = controllable[0].musicLibrary.map(m => m.name);
    const commonNames = firstNames.filter(name => controllable.every(m => m.musicLibrary.some(ml => ml.name === name)));
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "music_mode",
        name: tName("musicMode"),
        type: "mixed",
        role: "state",
        write: true,
        states: buildUniqueLabelMap(commonNames.map(name => ({ name }))),
        def: "0",
        capabilityType: GOVEE_CAP_TYPE.MUSIC_SETTING,
        capabilityInstance: "musicMode",
        channel: "music",
      });
    }
  }

  // v2.9.1 — BaseGroups get the same three diag states. Tier defaults to
  // "verified" because BaseGroup isn't a real SKU and has no quirks entry —
  // the diag-button just renders consistently.
  stateDefs.push(...buildDiagStateDefs(null));

  return stateDefs;
}
