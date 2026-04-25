import {
  buildUniqueLabelMap,
  rgbToHex,
  type CloudCapability,
  type CloudStateCapability,
  type GoveeDevice,
} from "./types.js";
import { applyColorTempQuirk } from "./device-quirks.js";

/** ioBroker state definition derived from a Govee capability */
export interface StateDefinition {
  /** State ID suffix (e.g. "power", "brightness", "colorRgb") */
  id: string;
  /** Display name */
  name: string;
  /**
   * Human-readable description shown in the object browser — used to clarify
   * ambiguous state names (e.g. cloud vs local snapshots) where the id alone
   * isn't enough for a user to know what the state does.
   */
  desc?: string;
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
  /** Predefined states for select (value → label) */
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
 */
export function mapCapabilities(
  capabilities: CloudCapability[],
): StateDefinition[] {
  const states: StateDefinition[] = [];

  if (!Array.isArray(capabilities)) {
    return states;
  }

  for (const cap of capabilities) {
    const mapped = mapSingleCapability(cap);
    if (mapped) {
      states.push(...mapped);
    }
  }

  return states;
}

/**
 * Default state definitions for LAN-only devices (no Cloud capabilities).
 * All LAN-capable Govee lights support: power, brightness, color, color temperature.
 */
export function getDefaultLanStates(): StateDefinition[] {
  return [
    {
      id: "power",
      name: "Power",
      type: "boolean",
      role: "switch",
      write: true,
      def: false,
      capabilityType: "lan",
      capabilityInstance: "powerSwitch",
    },
    {
      id: "brightness",
      name: "Brightness",
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
      name: "Color RGB",
      type: "string",
      role: "level.color.rgb",
      write: true,
      def: "#000000",
      capabilityType: "lan",
      capabilityInstance: "colorRgb",
    },
    {
      id: "colorTemperature",
      name: "Color Temperature",
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
  if (
    !cap ||
    typeof cap.type !== "string" ||
    typeof cap.instance !== "string"
  ) {
    return null;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");

  switch (shortType) {
    case "on_off":
      return [
        {
          id: "power",
          name: "Power",
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
      // buildDeviceStateDefs from the scenes/snapshots arrays — skip the
      // generic stub here so we don't create and immediately delete it.
      if (
        cap.instance === "lightScene" ||
        cap.instance === "diyScene" ||
        cap.instance === "snapshot"
      ) {
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
    case "temperature_setting":
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
        name: "Color RGB",
        type: "string",
        role: "level.color.rgb",
        write: true,
        def: "#000000",
        capabilityType: cap.type,
        capabilityInstance: cap.instance,
      },
    ];
  }

  if (
    cap.instance === "colorTemperatureK" ||
    cap.instance.includes("colorTem")
  ) {
    const range = cap.parameters?.range;
    return [
      {
        id: "colorTemperature",
        name: "Color Temperature",
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
  if (
    cap.instance !== "presetScene" ||
    !Array.isArray(cap.parameters?.options)
  ) {
    return [];
  }

  const states: Record<string, string> = {};
  for (const opt of cap.parameters.options) {
    if (!opt || typeof opt.name !== "string") {
      continue;
    }
    const val =
      typeof opt.value === "object"
        ? JSON.stringify(opt.value)
        : String(opt.value);
    states[val] = opt.name;
  }

  return [
    {
      id: "scene",
      name: "Scene",
      type: "mixed",
      role: "text",
      write: true,
      states,
      def: "",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    },
  ];
}

/**
 * Map property capability (read-only sensors)
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
    },
  ];
}

/**
 * Map music_setting capability to user-friendly states.
 * Parses STRUCT fields into: mode dropdown, sensitivity slider, auto-color toggle.
 *
 * @param cap Cloud music_setting capability
 */
function mapMusicSetting(cap: CloudCapability): StateDefinition[] {
  const fields = cap.parameters?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    // No field details from API — can't create usable states
    return [];
  }

  const states: StateDefinition[] = [];

  // Mode dropdown — only if API provides actual mode options
  const modeField = fields.find(
    (f) => f && typeof f.fieldName === "string" && f.fieldName === "musicMode",
  );
  if (
    modeField?.options &&
    Array.isArray(modeField.options) &&
    modeField.options.length > 0
  ) {
    const modeStates: Record<string, string> = { 0: "---" };
    for (const opt of modeField.options) {
      if (!opt || typeof opt.name !== "string") {
        continue;
      }
      modeStates[
        typeof opt.value === "object"
          ? JSON.stringify(opt.value)
          : String(opt.value as string | number | boolean)
      ] = opt.name;
    }
    states.push({
      id: "music_mode",
      name: "Music Mode",
      type: "mixed",
      role: "text",
      write: true,
      states: modeStates,
      def: "0",
      capabilityType: cap.type,
      capabilityInstance: cap.instance,
    });
  }

  // Sensitivity slider
  const sensField = fields.find(
    (f) =>
      f && typeof f.fieldName === "string" && f.fieldName === "sensitivity",
  );
  if (sensField?.range) {
    states.push({
      id: "music_sensitivity",
      name: "Music Sensitivity",
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
  const autoColorField = fields.find(
    (f) => f && typeof f.fieldName === "string" && f.fieldName === "autoColor",
  );
  if (autoColorField) {
    states.push({
      id: "music_auto_color",
      name: "Music Auto Color",
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
 */
export function applyQuirksToStates(
  sku: string,
  states: StateDefinition[],
): StateDefinition[] {
  for (const state of states) {
    if (
      state.id === "colorTemperature" &&
      state.min != null &&
      state.max != null
    ) {
      const corrected = applyColorTempQuirk(sku, state.min, state.max);
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
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
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
export function mapCloudStateValue(
  cap: CloudStateCapability,
): CloudStateValue | null {
  if (
    !cap ||
    typeof cap.type !== "string" ||
    typeof cap.instance !== "string"
  ) {
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
          value:
            typeof raw === "object" || typeof raw === "function"
              ? JSON.stringify(raw)
              : String(raw as string | number | boolean | bigint),
        };
      }
      return null;

    case "dynamic_scene":
    case "work_mode":
    case "temperature_setting":
      return {
        stateId: sanitizeId(cap.instance),
        value:
          typeof raw === "object" || typeof raw === "function"
            ? JSON.stringify(raw)
            : String(raw as string | number | boolean | bigint),
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
 * Build complete state definitions for a device.
 * Combines LAN defaults, Cloud capabilities, quirks, scenes, snapshots, and diagnostics.
 * For groups: computes capability intersection of member devices (no snapshots/diagnostics).
 *
 * @param device Govee device with capabilities, scenes, etc.
 * @param localSnapshots Optional local snapshot names
 * @param memberDevices Resolved member devices (only for BaseGroup)
 */
export function buildDeviceStateDefs(
  device: GoveeDevice,
  localSnapshots?: { name: string }[],
  memberDevices?: GoveeDevice[],
): StateDefinition[] {
  if (device.sku === "BaseGroup") {
    return buildGroupStateDefs(memberDevices || []);
  }
  let stateDefs: StateDefinition[];

  if (device.lanIp) {
    stateDefs = getDefaultLanStates();
    if (device.capabilities.length > 0) {
      const lanIds = new Set(stateDefs.map((d) => d.id));
      const cloudDefs = mapCapabilities(device.capabilities);
      for (const cd of cloudDefs) {
        if (!lanIds.has(cd.id)) {
          stateDefs.push(cd);
        }
      }
    }
  } else {
    stateDefs = mapCapabilities(device.capabilities);
  }

  applyQuirksToStates(device.sku, stateDefs);

  if (device.scenes.length > 0) {
    stateDefs.push({
      id: "light_scene",
      name: "Light Scene",
      // mixed lets users write the index ("1"), the index as number (1),
      // or the scene name ("Aurora") — the onStateChange handler resolves
      // all three forms via the common.states map.
      type: "mixed",
      role: "text",
      write: true,
      states: buildUniqueLabelMap(device.scenes),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "lightScene",
      channel: "scenes",
    });
  }

  // Scene speed slider — only if any scene supports speed adjustment
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
      } catch {
        /* ignore invalid config JSON */
      }
    }
    return max;
  }, -1);
  if (maxSpeedLevel > 0) {
    stateDefs.push({
      id: "scene_speed",
      name: "Scene Speed",
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

  if (device.diyScenes.length > 0) {
    stateDefs.push({
      id: "diy_scene",
      name: "DIY Scene",
      type: "mixed",
      role: "text",
      write: true,
      states: buildUniqueLabelMap(device.diyScenes),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "diyScene",
      channel: "scenes",
    });
  }

  if (device.snapshots.length > 0) {
    stateDefs.push({
      id: "snapshot_cloud",
      name: "Cloud Snapshot",
      desc: "Snapshots you saved in the Govee Home app. Selecting one replays that state on the device.",
      type: "mixed",
      role: "text",
      write: true,
      states: buildUniqueLabelMap(device.snapshots),
      def: "0",
      capabilityType: "devices.capabilities.dynamic_scene",
      capabilityInstance: "snapshot",
      channel: "snapshots",
    });
  }

  // Local snapshots
  stateDefs.push({
    id: "snapshot_local",
    name: "Local Snapshot",
    desc: "Snapshots saved by this adapter on the ioBroker server. Independent of the Govee Home app.",
    type: "mixed",
    role: "text",
    write: true,
    states: buildUniqueLabelMap(localSnapshots ?? []),
    def: "0",
    capabilityType: "local",
    capabilityInstance: "snapshotLocal",
    channel: "snapshots",
  });
  stateDefs.push({
    id: "snapshot_save",
    name: "Save Local Snapshot",
    desc: "Write a name to save the current device state (power, brightness, colour, per-segment colours) as a new local snapshot.",
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
    name: "Delete Local Snapshot",
    desc: "Write a local snapshot name to delete it. Does not affect Govee Home app snapshots.",
    type: "string",
    role: "text",
    write: true,
    def: "",
    capabilityType: "local",
    capabilityInstance: "snapshotDelete",
    channel: "snapshots",
  });

  // Diagnostics — under info/ because it exports ALL device data, not just snapshots
  stateDefs.push({
    id: "diagnostics_export",
    name: "Export Diagnostics",
    type: "boolean",
    role: "button",
    write: true,
    def: false,
    capabilityType: "local",
    capabilityInstance: "diagnosticsExport",
    channel: "info",
  });
  stateDefs.push({
    id: "diagnostics_result",
    name: "Diagnostics JSON",
    type: "string",
    role: "json",
    write: false,
    def: "",
    capabilityType: "local",
    capabilityInstance: "diagnosticsResult",
    channel: "info",
  });

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
      return caps.some(
        (c) => c && typeof c.type === "string" && c.type.endsWith("on_off"),
      );
    case "brightness":
      return caps.some(
        (c) =>
          c &&
          typeof c.type === "string" &&
          typeof c.instance === "string" &&
          c.type.endsWith("range") &&
          c.instance === "brightness",
      );
    case "colorRgb":
      return caps.some(
        (c) =>
          c &&
          typeof c.type === "string" &&
          typeof c.instance === "string" &&
          c.type.endsWith("color_setting") &&
          c.instance === "colorRgb",
      );
    case "colorTemperature":
      return caps.some(
        (c) =>
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
 * No snapshots, no diagnostics, no segments.
 *
 * @param members Resolved member devices
 */
function buildGroupStateDefs(members: GoveeDevice[]): StateDefinition[] {
  const controllable = members.filter((m) => m.lanIp || m.channels.cloud);
  if (controllable.length === 0) {
    return [];
  }

  const stateDefs: StateDefinition[] = [];

  // Control states: intersection of member capabilities
  for (const ld of getDefaultLanStates()) {
    if (controllable.every((m) => memberHasControlState(m, ld.id))) {
      stateDefs.push(ld);
    }
  }

  // Scenes: intersection of member scene names
  if (controllable.every((m) => m.scenes.length > 0)) {
    const firstNames = controllable[0].scenes.map((s) => s.name);
    const commonNames = firstNames.filter((name) =>
      controllable.every((m) => m.scenes.some((s) => s.name === name)),
    );
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "light_scene",
        name: "Light Scene",
        type: "mixed",
        role: "text",
        write: true,
        states: buildUniqueLabelMap(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: "devices.capabilities.dynamic_scene",
        capabilityInstance: "lightScene",
        channel: "scenes",
      });
    }
  }

  // Music: intersection of member music libraries
  if (controllable.every((m) => m.musicLibrary.length > 0)) {
    const firstNames = controllable[0].musicLibrary.map((m) => m.name);
    const commonNames = firstNames.filter((name) =>
      controllable.every((m) => m.musicLibrary.some((ml) => ml.name === name)),
    );
    if (commonNames.length > 0) {
      stateDefs.push({
        id: "music_mode",
        name: "Music Mode",
        type: "mixed",
        role: "text",
        write: true,
        states: buildUniqueLabelMap(commonNames.map((name) => ({ name }))),
        def: "0",
        capabilityType: "devices.capabilities.music_setting",
        capabilityInstance: "musicMode",
        channel: "music",
      });
    }
  }

  return stateDefs;
}
