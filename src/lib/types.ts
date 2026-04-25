/** Adapter configuration from ioBroker native config */
export interface AdapterConfig {
  /** Govee Cloud API key (optional — enables scenes, segments, device names) */
  apiKey: string;
  /** Govee account email (optional — enables MQTT real-time status) */
  goveeEmail: string;
  /** Govee account password (optional — enables MQTT real-time status) */
  goveePassword: string;
  /** Network interface IP for LAN multicast (empty = all interfaces) */
  networkInterface: string;
  /**
   * Activate device entries with status `seed` from `devices.json`. Off by
   * default — these devices are prepared in code but unconfirmed by any
   * tester. The Wiki lists every device and its status.
   */
  experimentalQuirks: boolean;
}

/**
 * Ergebnis eines Cloud-Load-Versuchs. Der Retry-Loop wertet `reason` aus,
 * um Rate-Limits und permanente Fehler korrekt zu behandeln.
 */
export type CloudLoadResult =
  /** Erfolgreich */
  | { ok: true }
  /** Netzwerk/Timeout — einfach später retryen */
  | { ok: false; reason: "transient" }
  /** Govee 429 — retry-after respektieren */
  | { ok: false; reason: "rate-limited"; retryAfterMs: number }
  /** Auth-Fehler (ungültiger API-Key) — KEIN Retry, User muss Config korrigieren */
  | { ok: false; reason: "auth-failed"; message: string };

// --- Cloud API v2 Types ---

/** Device from Cloud API GET /router/api/v1/user/devices */
export interface CloudDevice {
  /** Product model (e.g. H6160) */
  sku: string;
  /** Unique device identifier */
  device: string;
  /** User-assigned device name */
  deviceName: string;
  /** Device category (e.g. "devices.types.light") */
  type: string;
  /** Device capabilities from Cloud API */
  capabilities: CloudCapability[];
}

/** A single capability from the Cloud API */
export interface CloudCapability {
  /** Capability type (e.g. "devices.capabilities.on_off") */
  type: string;
  /** Capability instance (e.g. "powerSwitch", "brightness") */
  instance: string;
  /** Parameter definition for this capability (optional — API can omit it) */
  parameters?: CapabilityParameters;
}

/** Parameter definition for a capability */
export interface CapabilityParameters {
  /** Value data type */
  dataType: "ENUM" | "INTEGER" | "STRUCT";
  /** Available options for ENUM type */
  options?: CapabilityOption[];
  /** Value range for INTEGER type */
  range?: { min: number; max: number; precision: number };
  /** Unit of measurement */
  unit?: string;
  /** Field definitions for STRUCT type */
  fields?: CapabilityField[];
}

/** ENUM option */
export interface CapabilityOption {
  /** Display name of the option */
  name: string;
  /** Option value (number, string, or complex object) */
  value: number | string | Record<string, unknown>;
}

/** STRUCT field definition */
export interface CapabilityField {
  /** Field name identifier */
  fieldName: string;
  /** Value data type */
  dataType?: "ENUM" | "INTEGER" | "STRUCT" | "Array";
  /** Available options for ENUM fields */
  options?: CapabilityOption[];
  /** Value range for INTEGER fields */
  range?: { min: number; max: number; precision: number };
  /** Element range for Array fields (0-based, segment count = max + 1) */
  elementRange?: { min: number; max: number };
  /** Whether this field is required */
  required?: boolean;
}

/** Cloud API device list response */
export interface CloudDeviceListResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** List of devices */
  data: CloudDevice[];
}

/** Cloud API device state response */
export interface CloudDeviceStateResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** Device state data */
  data: {
    /** Product model */
    sku: string;
    /** Device identifier */
    device: string;
    /** Current capability states */
    capabilities: CloudStateCapability[];
  };
}

/** A capability value from state response */
export interface CloudStateCapability {
  /** Capability type */
  type: string;
  /** Capability instance */
  instance: string;
  /** Current state value */
  state: { value: unknown };
}

/** Cloud API scenes response — payload contains capabilities with options */
export interface CloudScenesResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** Payload with capabilities (scenes endpoint format) */
  payload?: {
    /** Scene capabilities with options */
    capabilities: CloudCapability[];
  };
}

/** A scene/snapshot option from the Cloud API */
export interface CloudScene {
  /** Display name */
  name: string;
  /** Activation value (passed directly to control endpoint) — object for scenes, integer for snapshots */
  value: Record<string, unknown> | number;
}

// --- AWS IoT MQTT Types ---

/** Login response from app2.govee.com */
export interface GoveeLoginResponse {
  /** API status code (200 = success) */
  status?: number;
  /** API status message */
  message?: string;
  /** Client authentication data (missing on auth failure) */
  client?: {
    /** Bearer token for API calls */
    token: string;
    /** Account identifier (numeric) */
    accountId: number | string;
    /** MQTT topic for status updates */
    topic: string;
  };
}

/** IoT key response from app2.govee.com */
export interface GoveeIotKeyResponse {
  /** IoT credential data */
  data?: {
    /** AWS IoT endpoint hostname */
    endpoint: string;
    /** Base64-encoded PKCS12 certificate */
    p12: string;
    /** Password for the PKCS12 certificate */
    p12Pass: string;
  };
}

/** MQTT status update received on account topic */
export interface MqttStatusUpdate {
  /** Product model */
  sku: string;
  /** Device identifier */
  device: string;
  /** Device state values */
  state?: {
    /** Power state (1 = on, 0 = off) */
    onOff?: number;
    /** Brightness percentage 0-100 */
    brightness?: number;
    /** RGB color values */
    color?: { r: number; g: number; b: number };
    /** Color temperature in Kelvin */
    colorTemInKelvin?: number;
  };
  /** Operation data */
  op?: {
    /** Command strings */
    command?: string[];
  };
}

// --- LAN API Types ---

/** LAN discovery response */
export interface LanDevice {
  /** Device IP address */
  ip: string;
  /** Device identifier */
  device: string;
  /** Product model */
  sku: string;
}

/** LAN status response */
export interface LanStatus {
  /** Power state (1 = on, 0 = off) */
  onOff: number;
  /** Brightness percentage 0-100 */
  brightness: number;
  /** RGB color values */
  color: { r: number; g: number; b: number };
  /** Color temperature in Kelvin */
  colorTemInKelvin: number;
}

/** LAN command message wrapper */
export interface LanMessage {
  /** Message payload */
  msg: {
    /** Command name */
    cmd: string;
    /** Command data */
    data: Record<string, unknown>;
  };
}

// --- Internal Device Model ---

/** Unified device representation used by device-manager */
export interface GoveeDevice {
  /** Product model (e.g. H6160) */
  sku: string;
  /** Unique device ID (8-byte hex) */
  deviceId: string;
  /** Display name (from Cloud or SKU fallback) */
  name: string;
  /** Device type from Cloud (e.g. "devices.types.light") */
  type: string;
  /** LAN IP address if discovered */
  lanIp?: string;
  /** Capabilities from Cloud API */
  capabilities: CloudCapability[];
  /** Available light scenes (from Cloud scenes endpoint) */
  scenes: CloudScene[];
  /** Available DIY scenes (from Cloud scenes endpoint) */
  diyScenes: CloudScene[];
  /** Available snapshots (from Cloud scenes endpoint) */
  snapshots: CloudScene[];
  /** Scene library entries with scene codes for ptReal (from undocumented API) */
  sceneLibrary: Array<{
    name: string;
    /** BLE scene code (> 0 = usable via ptReal) */
    sceneCode: number;
    /** Base64-encoded BLE scene parameter data */
    scenceParam?: string;
    /** Speed control info (from scene library API) */
    speedInfo?: {
      /** Whether this scene supports speed adjustment */
      supSpeed: boolean;
      /** Default speed level index */
      speedIndex: number;
      /** JSON config with per-level moveIn/color/bright overrides */
      config: string;
    };
  }>;
  /** Music effect library entries for ptReal local music mode (authenticated API) */
  musicLibrary: Array<{
    name: string;
    /** BLE music effect code */
    musicCode: number;
    /** Base64-encoded BLE parameter data */
    scenceParam?: string;
    /** Music sub-mode index */
    mode?: number;
  }>;
  /** DIY light effect library entries for ptReal local DIY activation (authenticated API) */
  diyLibrary: Array<{
    name: string;
    /** BLE DIY effect code */
    diyCode: number;
    /** Base64-encoded BLE parameter data */
    scenceParam?: string;
  }>;
  /** Supported feature flags per SKU (from authenticated API) */
  skuFeatures: Record<string, unknown> | null;
  /** Group member devices (only for BaseGroup) */
  groupMembers?: { sku: string; deviceId: string }[];
  /** Last known state */
  state: DeviceState;
  /**
   * Number of LED segments on this device. Resolved by
   * {@link resolveSegmentCount} from Cache → MQTT-discovered → Cloud min.
   * Persisted via SKU cache so learned values survive restarts.
   */
  segmentCount?: number;
  /** BLE packets per cloud snapshot for ptReal activation [snapshotIdx][cmdIdx][packetBase64] */
  snapshotBleCmds?: string[][][];
  /** Current speed level for scene playback (0-based, applied on next scene activation) */
  sceneSpeed?: number;
  /**
   * Set to true after a Cloud scene-fetch attempt completed (success or confirmed empty).
   * Used to distinguish "not yet tried" from "legitimately empty" — prevents endless refetch.
   */
  scenesChecked?: boolean;
  /**
   * Manual-mode flag for cut strips (physical segments with gaps). When true,
   * `manualSegments` lists the indices that actually light up; all others
   * (within `0..segmentCount-1`) are skipped. Orthogonal to `segmentCount`:
   * the total is still the strip's real length, manualMode just masks gaps.
   */
  manualMode?: boolean;
  /**
   * Explicit physical segment indices (parsed from `segments.manual_list` state).
   * Only used when `manualMode=true`. Indices must be within `0..segmentCount-1`.
   */
  manualSegments?: number[];
  /**
   * Timestamp (ms) when device was last seen via LAN discovery or MQTT status push.
   * Used for cache pruning — stale entries without recent network sighting get removed.
   */
  lastSeenOnNetwork?: number;
  /** Which channels are available */
  channels: {
    /** LAN UDP reachable */
    lan: boolean;
    /** MQTT connected */
    mqtt: boolean;
    /** Cloud API available */
    cloud: boolean;
  };
}

/** Current device state */
export interface DeviceState {
  /** Whether device is reachable */
  online: boolean;
  /** Power on/off */
  power?: boolean;
  /** Brightness 0-100 */
  brightness?: number;
  /** Color as "#RRGGBB" hex string */
  colorRgb?: string;
  /** Color temperature in Kelvin */
  colorTemperature?: number;
  /** Active scene name */
  scene?: string;
  /** Additional dynamic state values */
  [key: string]: unknown;
}

/**
 * Normalize device ID — remove colons, lowercase.
 * Returns empty string if input is not a string (defensive against malformed API data).
 *
 * @param id Raw device identifier
 */
export function normalizeDeviceId(id: string): string {
  if (typeof id !== "string") {
    return "";
  }
  return id.replace(/:/g, "").toLowerCase();
}

/** Error categories for dedup logging */
export type ErrorCategory =
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "RATE_LIMIT"
  | "UNKNOWN";

/**
 * Classify an error into a category for dedup logging.
 * Only the category is used as key — not context or full message.
 *
 * @param err Error to classify
 */
export function classifyError(err: unknown): ErrorCategory {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" ||
      code === "ENOTFOUND" ||
      code === "ENETUNREACH" ||
      code === "ECONNRESET" ||
      code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
      return "TIMEOUT";
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ENETUNREACH") ||
    msg.includes("ECONNRESET")
  ) {
    return "NETWORK";
  }
  if (msg.includes("Timeout")) {
    return "TIMEOUT";
  }
  if (
    msg.includes("429") ||
    msg.includes("Rate limit") ||
    msg.includes("Rate limited")
  ) {
    return "RATE_LIMIT";
  }
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("Login failed") ||
    msg.includes("auth")
  ) {
    return "AUTH";
  }
  return "UNKNOWN";
}

/**
 * Clamp a value to the 0-255 byte range. NaN/non-numeric inputs become 0.
 *
 * @param v Input value
 */
function clampByte(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Convert RGB values to hex color string "#RRGGBB".
 * Out-of-range or non-numeric inputs are clamped to produce valid hex.
 *
 * @param r Red channel 0-255
 * @param g Green channel 0-255
 * @param b Blue channel 0-255
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const rr = clampByte(r).toString(16).padStart(2, "0");
  const gg = clampByte(g).toString(16).padStart(2, "0");
  const bb = clampByte(b).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

/**
 * Parse hex color string to RGB values. Returns black for non-string
 * or malformed input (defensive — upstream may pass unexpected types).
 *
 * @param hex Color string (e.g. "#FF6600" or "FF6600")
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (typeof hex !== "string") {
    return { r: 0, g: 0, b: 0 };
  }
  const num = parseInt(hex.replace("#", ""), 16) || 0;
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

/**
 * Convert packed RGB integer to hex color string "#RRGGBB"
 *
 * @param rgb Packed integer (r << 16 | g << 8 | b)
 */
export function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Result of parsing a manual-segments string like "0-9", "0-2,4-9", "0,3,5".
 *
 * indices  Deduplicated, sorted list of segment indices
 *
 * error    Human-readable error (null on success)
 */
export interface SegmentListParseResult {
  /** Deduplicated, sorted list of segment indices */
  indices: number[];
  /** Human-readable error (null on success) */
  error: string | null;
}

/**
 * Parse a user-provided segment-list string.
 * Akzeptiert Komma-Einzeln ("0,1,2"), Range ("0-9"), Mixed ("0-8,10-14"),
 * whitespace-tolerant. Dedupe automatisch. Sortiert aufsteigend.
 *
 * @param input User-Input string
 * @param maxIndex Obergrenze pro Gerät (z. B. device.segmentCount - 1). Indices > maxIndex werden abgelehnt.
 * @returns SegmentListParseResult mit indices + optional error
 */
export function parseSegmentList(
  input: string,
  maxIndex: number,
): SegmentListParseResult {
  const HARD_MAX = 99; // Backstop, deckt alle realistischen Govee-Geräte
  if (typeof input !== "string") {
    return { indices: [], error: "input must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { indices: [], error: "list is empty" };
  }
  const effectiveMax = Math.min(
    Number.isFinite(maxIndex) && maxIndex >= 0
      ? Math.floor(maxIndex)
      : HARD_MAX,
    HARD_MAX,
  );
  const set = new Set<number>();
  const parts = trimmed.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") {
      continue;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) {
        return {
          indices: [],
          error: `invalid range "${part}" (start > end)`,
        };
      }
      for (let i = start; i <= end; i++) {
        if (i < 0 || i > effectiveMax) {
          return {
            indices: [],
            error: `segment ${i} is outside 0-${effectiveMax} for this device`,
          };
        }
        set.add(i);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return {
        indices: [],
        error: `invalid entry "${part}" (only digits and ranges allowed)`,
      };
    }
    const idx = parseInt(part, 10);
    if (idx < 0 || idx > effectiveMax) {
      return {
        indices: [],
        error: `segment ${idx} is outside 0-${effectiveMax} for this device`,
      };
    }
    set.add(idx);
  }
  if (set.size === 0) {
    return { indices: [], error: "no valid indices in list" };
  }
  return {
    indices: Array.from(set).sort((a, b) => a - b),
    error: null,
  };
}

/**
 * Disambiguate a list of names by appending " (2)", " (3)" to repeats,
 * preserving the order. The first occurrence keeps the original name.
 *
 * Used both when building common.states maps and when reverse-resolving
 * a label back to an index — the SAME function on both sides guarantees
 * the user-visible label and the lookup target stay in sync, even when
 * the source list (cloud scenes etc.) contains duplicates.
 *
 * @param names Raw name list, possibly containing duplicates
 */
export function disambiguateLabels(names: string[]): string[] {
  const counts = new Map<string, number>();
  return names.map((name) => {
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    return seen === 0 ? name : `${name} (${seen + 1})`;
  });
}

/**
 * Build a `common.states` map from a list of named items, with index 0
 * reserved for a sentinel entry (default "---" = no selection).
 *
 * Duplicate names are disambiguated via `disambiguateLabels`, so each
 * value in the resulting map is unique and the reverse-lookup is
 * deterministic.
 *
 * @param items Source list — each item must have a `name` field
 * @param zeroLabel Label for index 0 (default "---" = no selection)
 */
export function buildUniqueLabelMap<T extends { name: string }>(
  items: T[],
  zeroLabel = "---",
): Record<string, string> {
  const labels = disambiguateLabels(items.map((item) => item.name));
  const result: Record<string, string> = { 0: zeroLabel };
  labels.forEach((label, i) => {
    result[String(i + 1)] = label;
  });
  return result;
}

/**
 * Result of resolving a state value against a `common.states` map.
 * `key` is the matching map key (string form, as stored in the map),
 * `canonical` is the matching label (the canonical, disambiguated form
 * — what the dropdown displays).
 */
export interface ResolvedStatesValue {
  /** The matching key from the states map, in string form */
  key: string;
  /** Canonical label as stored in the states map */
  canonical: string;
}

/**
 * Reverse-resolve a state value against a `common.states` map, accepting
 * three input forms:
 * - number `1`            → direct key lookup
 * - string matching a key → direct key match (case-sensitive — keys
 * are identifiers like "1" or "spectrum")
 * - string matching a label → case-insensitive trim match against
 * the map values
 *
 * Returns null when no match is found. The caller decides whether to
 * warn, ack=false, or fall back to a default — this helper is pure.
 *
 * @param input User-supplied state value (number, string, or other)
 * @param statesMap The state's `common.states` map (key → label)
 */
export function resolveStatesValue(
  input: unknown,
  statesMap: Record<string, string>,
): ResolvedStatesValue | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    const key = String(input);
    const canonical = statesMap[key];
    if (canonical !== undefined) {
      return { key, canonical };
    }
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      return null;
    }
    // Direct key match — handles numeric-string keys ("1") and
    // identifier-string keys ("spectrum") in one pass.
    const directLabel = statesMap[trimmed];
    if (directLabel !== undefined) {
      return { key: trimmed, canonical: directLabel };
    }
    // Label match — case-insensitive, trim. Lets users write the
    // human-readable name (e.g. "Aurora") regardless of casing.
    const needle = trimmed.toLowerCase();
    for (const [key, label] of Object.entries(statesMap)) {
      if (typeof label === "string" && label.trim().toLowerCase() === needle) {
        return { key, canonical: label };
      }
    }
  }
  return null;
}

/**
 * Event message from the OpenAPI-MQTT broker (mqtt.openapi.govee.com:8883).
 * Govee pushes one of these per device-capability state change — primarily
 * appliance events like lackWater, iceFull, bodyAppeared.
 */
export interface OpenApiMqttEvent {
  /** Product model */
  sku: string;
  /** Device identifier */
  device: string;
  /** Event capabilities (typically a single event entry) */
  capabilities: CloudStateCapability[];
}

/** Timer/callback interfaces for helper classes */
export interface TimerAdapter {
  /** Create a repeating interval timer */
  setInterval(callback: () => void, ms: number): ioBroker.Interval | undefined;
  /** Clear a repeating interval timer */
  clearInterval(timer: ioBroker.Interval): void;
  /** Create a one-shot timeout timer */
  setTimeout(callback: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Clear a one-shot timeout timer */
  clearTimeout(timer: ioBroker.Timeout): void;
}
