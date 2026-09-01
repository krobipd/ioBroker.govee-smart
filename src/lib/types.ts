/**
 * Result of a cloud-load attempt. The retry loop inspects `reason` to handle
 * rate limits and permanent failures correctly.
 */
export type CloudLoadResult =
  /** Success */
  | { ok: true }
  /** Network/timeout — just retry later */
  | { ok: false; reason: "transient" }
  /** Govee 429 — respect retry-after */
  | { ok: false; reason: "rate-limited"; retryAfterMs: number }
  /** Auth error (invalid API key) — NO retry, user must fix the config */
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
    /** Token TTL in seconds. Govee uses this name; some responses also send `tokenExpireCycle`. */
    token_expire_cycle?: number;
    tokenExpireCycle?: number;
  };
}

/**
 * Bundle of credentials persisted across adapter restarts so we don't have
 * to log in every time (which would spam the Govee 2FA email each restart).
 * Populated from `native` after a successful login, fed back into the next
 * MQTT connect.
 */
export interface PersistedMqttCredentials {
  /** Govee bearer token from /v1/login. */
  bearerToken: string;
  /** AWS IoT endpoint hostname (xxx-ats.iot.<region>.amazonaws.com). */
  iotEndpoint: string;
  /** Base64-encoded PKCS#12 cert bundle from /iot/key. */
  p12Cert: string;
  /** Password for the P12 cert (also from /iot/key). */
  p12Pass: string;
  /** Govee account-id, used to build the MQTT clientId. */
  accountId: string;
  /** MQTT topic the account subscribes to for status push. */
  accountTopic: string;
  /** ms-timestamp at which the bearer token expires (Date.now() + ttlMs). */
  tokenExpiresAt: number;
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
  /**
   * Consecutive account-reconcile passes this device was missing from its
   * authoritative account list (Cloud `/user/devices` for lights/appliances,
   * App-API list for sensors, group list for BaseGroups) while not
   * LAN-reachable. Persisted via the SKU cache so the debounce survives
   * restarts; reset to 0 the instant the device reappears in any source or is
   * seen on LAN. Reaching the evict threshold removes the device (irreversible).
   */
  accountMissCount?: number;
  /**
   * Human-readable identifier of the Govee gateway this device reaches the
   * cloud through, when it has no own WiFi (BLE→gateway sensors like the H5109
   * pool thermometer behind an H5042). Format `<gateway SKU> (<gateway BLE
   * name>)`, e.g. `H5042 (ihoment_H5042_3795)`. Set from the App-API
   * `settings.gatewayInfo`; **set-only, never cleared** once seen (sticky), so
   * a flaky poll that omits it can't churn the object tree. When present the
   * device shows `info.gateway` instead of an always-empty `info.ip`.
   */
  gateway?: string;
  /**
   * Timestamp (ms) when device last replied to a LAN-direct probe (multicast
   * discovery or unicast devStatus). Only set by the LAN-Discovery / LAN-Status
   * paths — NOT by MQTT-push (broker buffering risk) and NOT by Cloud caps.
   * Used as the sole truth-source for `info.online` of Lights via the
   * StateManager.syncInfoOnline resolver (90s freshness window).
   */
  lastLanReplyAt?: number;
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

/**
 * Consistent device label for log lines: always name plus model, e.g.
 * `Wifi Thermometer (H5179)`. Falls back to the bare SKU when no display
 * name is known (or the name IS the SKU) — never produces `H5179 (H5179)`.
 *
 * @param device Anything carrying a display name and a SKU (GoveeDevice, cached entry, …)
 * @param device.name Optional display name (user-assigned or Cloud-provided)
 * @param device.sku Product model
 */
export function deviceLabel(device: { name?: string; sku: string }): string {
  const name = typeof device.name === "string" ? device.name.trim() : "";
  return name && name !== device.sku ? `${name} (${device.sku})` : device.sku;
}

/**
 * Human-readable label for the Govee gateway a device reaches the cloud
 * through, derived from the App-API `settings.gatewayInfo`. Returns
 * `<SKU> (<BLE name>)`, or just the SKU when no BLE name is present, or
 * `undefined` when there is no usable gateway SKU — the caller then leaves the
 * device on the normal `info.ip` path and never creates an `info.gateway` with
 * a garbage value. Auth secrets (`secretCode`, `topic`) are deliberately ignored.
 *
 * @param gatewayInfo The `gatewayInfo` object from the App-API device settings
 */
export function formatGatewayLabel(gatewayInfo: { sku?: unknown; bleName?: unknown } | undefined): string | undefined {
  if (!gatewayInfo || typeof gatewayInfo !== "object") {
    return undefined;
  }
  const sku = typeof gatewayInfo.sku === "string" ? gatewayInfo.sku.trim() : "";
  if (!sku) {
    return undefined;
  }
  const bleName = typeof gatewayInfo.bleName === "string" ? gatewayInfo.bleName.trim() : "";
  return bleName ? `${sku} (${bleName})` : sku;
}

/** Error categories for dedup logging */
export type ErrorCategory =
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "RATE_LIMIT"
  /** Govee returned 454 with no code in the request body — user must request a verification code via Settings. */
  | "VERIFICATION_PENDING"
  /** Govee returned 454 with code already sent, or 455 — code is wrong or expired, user must request a fresh one. */
  | "VERIFICATION_FAILED"
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
    // mqtt.js CONNACK reason codes: 4 = bad user name or password, 5 = not
    // authorized — the broker rejected the credentials (API key / account).
    const reasonCode: unknown = (err as { code?: unknown }).code;
    if (reasonCode === 4 || reasonCode === 5) {
      return "AUTH";
    }
    // An HTTP error carries its status as a field — that is the authoritative
    // signal, not a number that happens to occur in the message text.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      if (status === 429) {
        return "RATE_LIMIT";
      }
      if (status === 401 || status === 403) {
        return "AUTH";
      }
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
  // Text markers are matched as WORDS, never as bare substrings: an "Invalid
  // JSON" error quotes the first 100 characters of a foreign body, and a Govee
  // maintenance page containing "author" or "401" in that snippet used to be
  // classified AUTH — which stops the Cloud retry loop for good and tells the
  // user to check a perfectly valid API key.
  if (/\b(rate limit(ed)?|too many requests)\b/i.test(msg)) {
    return "RATE_LIMIT";
  }
  // 2FA-pending classification must come before AUTH — Govee returns 454 with
  // a leading "454" or "Verification" marker that would otherwise fall into AUTH
  // and trip the auth-failure backoff. Two distinct categories so the adapter
  // can pause reconnect on PENDING (waiting for user-entered code) but reset
  // on FAILED (code was sent but rejected, user retries via Settings button).
  if (msg.includes("Verification required") || (msg.includes("status 454") && !msg.includes("invalid"))) {
    return "VERIFICATION_PENDING";
  }
  if (msg.includes("Verification code invalid") || msg.includes("status 455")) {
    return "VERIFICATION_FAILED";
  }
  if (
    msg.includes("Login failed") ||
    /\b(unauthori[sz]ed|not authori[sz]ed|forbidden|authentication failed|bad username or password)\b/i.test(msg)
  ) {
    return "AUTH";
  }
  return "UNKNOWN";
}

/**
 * Render an unknown error to a string for logging. Returns `e.message` for
 * Error values (the stack stays out of warn/error lines — debug paths that
 * want the trace render it themselves) and `String(...)` for everything else.
 *
 * @param e Caught value (usually `unknown` in catch blocks)
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/**
 * `.catch` handler for a best-effort write on an event path (a state write, a
 * dropdown reset, a marker refresh). The write is allowed to fail — the state
 * may have been deleted out-of-band, the database may be going down — but the
 * failure stays visible on the debug log instead of vanishing in an empty
 * catch, so a "the adapter ignored my value" report can be traced.
 *
 * @param log Adapter logger
 * @param context What was being written, for the debug line
 */
export function logRejected(log: ioBroker.Logger, context: string): (e: unknown) => void {
  return e => log.debug(`${context}: ${errMessage(e)}`);
}

/**
 * Mask a secret for safe logging. Reveals only a short leading fragment so a
 * log line stays recognizable without exposing the value. Credential-bearing
 * strings (API key topic, tokens) must pass through this before they ever
 * reach a log line — a raw secret in a log the user later pastes publicly is a
 * real exposure (H1).
 *
 * @param secret The sensitive string to mask
 */
export function maskSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length <= 4) {
    return "***";
  }
  return `${secret.slice(0, 4)}***`;
}

/**
 * Coerce an unknown value to a finite number. Returns null for NaN, Infinity,
 * non-numeric strings, objects, etc. Use at API boundaries where external
 * payloads might send numbers as strings, or send malformed values.
 *
 * Strings that contain a finite number are accepted (Govee occasionally sends
 * `brightness: "50"` instead of `brightness: 50`).
 *
 * @param raw Unknown input
 */
export function coerceFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Dedup-aware error logger.
 *
 * Compares the new error category against the caller's last category. On
 * change → warn (so the user sees fresh failures). On repeat → debug (so the
 * log doesn't spam). Returns the new category so the caller can update its
 * `lastErrorCategory` member.
 *
 * Caller pattern:
 * ```ts
 * this.lastErrorCategory = logDedup(this.log, this.lastErrorCategory, "Cloud", err);
 * ```
 *
 * @param log Adapter logger
 * @param last Previous category (null on first call)
 * @param context Short prefix (e.g. "Cloud", "MQTT", "App-API")
 * @param err Caught error
 * @returns New category (assign to caller's tracker)
 */
export function logDedup(
  log: ioBroker.Logger,
  last: ErrorCategory | null,
  context: string,
  err: unknown,
): ErrorCategory {
  const category = classifyError(err);
  const msg = errMessage(err);
  if (category !== last) {
    log.warn(`${context}: ${msg}`);
  } else {
    log.debug(`${context}: ${msg} (repeated)`);
  }
  return category;
}

/**
 * Clamp a value to the 0-255 byte range. NaN/non-numeric inputs become 0.
 * Shared with govee-lan-client (LAN command bounds-check).
 *
 * @param v Input value
 */
export function clampByte(v: unknown): number {
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
 * Parse hex color string to RGB values. Returns black for non-string,
 * wrong-length or malformed input (defensive — upstream may pass unexpected
 * types or shortened forms like "FF" that would otherwise yield blue=255
 * via the bitshift below).
 *
 * @param hex Color string (e.g. "#FF6600" or "FF6600")
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (typeof hex !== "string") {
    return { r: 0, g: 0, b: 0 };
  }
  const cleaned = hex.replace("#", "");
  // Reject anything that isn't exactly 6 hex digits — accepting "FF" or
  // "FFAABBCC" would silently yield non-obvious RGB values via parseInt
  // truncation/sign-extension.
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return { r: 0, g: 0, b: 0 };
  }
  const num = parseInt(cleaned, 16) || 0;
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
 * Accepts comma-separated singles ("0,1,2"), ranges ("0-9"), mixed
 * ("0-8,10-14"); whitespace-tolerant. Deduplicates automatically and
 * returns the result sorted ascending.
 *
 * @param input User-input string
 * @param maxIndex Per-device upper bound (e.g. device.segmentCount - 1). Indices > maxIndex are rejected.
 * @returns SegmentListParseResult with indices + optional error
 */
export function parseSegmentList(input: string, maxIndex: number): SegmentListParseResult {
  // Backstop matches the Govee bitmask protocol limit (`SEGMENT_HARD_MAX = 55`
  // in device-manager). Higher values would be silently dropped at the
  // ptReal layer anyway; rejecting them up front gives a clearer user error.
  const HARD_MAX = 55;
  if (typeof input !== "string") {
    return { indices: [], error: "input must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { indices: [], error: "list is empty" };
  }
  const effectiveMax = Math.min(Number.isFinite(maxIndex) && maxIndex >= 0 ? Math.floor(maxIndex) : HARD_MAX, HARD_MAX);
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
  const used = new Set<string>();
  return names.map(name => {
    let n = counts.get(name) ?? 0;
    let label = n === 0 ? name : `${name} (${n + 1})`;
    // Guard against colliding with a name the input already carried in
    // "(N)"-suffixed form (e.g. ["Aurora","Aurora","Aurora (2)"]) — keep bumping
    // the counter until the label is actually unique so the reverse-lookup stays
    // deterministic (I4).
    while (used.has(label)) {
      n += 1;
      label = `${name} (${n + 1})`;
    }
    counts.set(name, n + 1);
    used.add(label);
    return label;
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
export function buildUniqueLabelMap<T extends { name: string }>(items: T[], zeroLabel = "---"): Record<string, string> {
  const labels = disambiguateLabels(items.map(item => item.name));
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
export function resolveStatesValue(input: unknown, statesMap: Record<string, string>): ResolvedStatesValue | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    const key = String(input);
    // Own-property guard so a value/key can never resolve against an inherited
    // Object.prototype member (SEC-GC2). String(number) can't be "__proto__" etc.,
    // but keep it symmetric with the string branch below.
    if (Object.prototype.hasOwnProperty.call(statesMap, key)) {
      return { key, canonical: statesMap[key] };
    }
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      return null;
    }
    // Direct key match — handles numeric-string keys ("1") and
    // identifier-string keys ("spectrum") in one pass. Own-property guard so a
    // dropdown input of "__proto__" / "toString" / "constructor" can't match an
    // inherited prototype member and falsely resolve ok=true (SEC-GC2).
    if (Object.prototype.hasOwnProperty.call(statesMap, trimmed)) {
      return { key: trimmed, canonical: statesMap[trimmed] };
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

/**
 * Timer/callback interface for helper classes. Declared with function-property
 * syntax (`setTimeout: (...) => ...`) rather than method syntax: stricter
 * parameter variance for a dependency-injection surface, and it keeps the
 * repo-checker's plain-timer regex off the interface method names. The real
 * scheduling still goes through the injected `this.setTimeout` etc., which the
 * regex correctly ignores (preceded by a dot).
 */
export interface TimerAdapter {
  /** Create a repeating interval timer */
  setInterval: (callback: () => void, ms: number) => ioBroker.Interval | undefined;
  /** Clear a repeating interval timer */
  clearInterval: (timer: ioBroker.Interval) => void;
  /** Create a one-shot timeout timer */
  setTimeout: (callback: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Clear a one-shot timeout timer */
  clearTimeout: (timer: ioBroker.Timeout) => void;
  /** Async delay that gets cancelled on adapter unload */
  delay: (ms: number) => Promise<void>;
}

/** The four basic control kinds, spelled as their camelCase cloud instance. */
export type ControlKind = "power" | "brightness" | "colorRgb" | "colorTemperature";

/**
 * Canonical predicate: does a raw Govee capability match a basic control kind?
 * Single source of truth for the group-intersection check (capability-mapper
 * `memberHasControlState`, keyed on snake_case state-ids) and command routing
 * (`CommandRouter.findCapabilityForCommand`, keyed on camelCase command tokens).
 * A duplicated copy of this shape-match drifted at the B2 rename and broke
 * cloud-only group colour control — lives here (types.ts has no adapter-core/i18n
 * imports) so both callers share one copy. Exact `shortType` match (not
 * `endsWith`) → `segment_color_setting` never counts as a colour cap.
 *
 * @param cap Raw capability (type/instance may be non-string / missing)
 * @param kind Control kind to test for
 */
export function capMatchesControl(
  cap: { type?: unknown; instance?: unknown } | null | undefined,
  kind: ControlKind,
): boolean {
  if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
    return false;
  }
  const shortType = cap.type.replace("devices.capabilities.", "");
  const inst = cap.instance;
  switch (kind) {
    case "power":
      return shortType === "on_off";
    case "brightness":
      return shortType === "range" && inst.toLowerCase().includes("brightness");
    case "colorRgb":
      return shortType === "color_setting" && inst === "colorRgb";
    case "colorTemperature":
      return shortType === "color_setting" && inst.includes("colorTem");
  }
}
