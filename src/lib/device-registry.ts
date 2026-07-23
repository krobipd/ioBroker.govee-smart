import { errMessage } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";

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
 * Three pattern families cover all observed Govee quirks:
 *  1. Range-Override: API reports a wrong numeric range (colorTempRange)
 *  2. Boolean-Flag: per-SKU behaviour toggle (brokenPlatformApi)
 *  3. Map-Override: per-operation routing/behaviour map (transportOverrides)
 *
 * A fourth family (Number-Override for timing constants) is identified as
 * the next likely shape — add additively when a real SKU need shows up,
 * no architecture refactor required.
 */
export interface DeviceQuirks {
  /** Override color-temperature range (Govee API often claims a flat 2000-9000K, real range is narrower). */
  colorTempRange?: { min: number; max: number };
  /** Cloud platform-API metadata is unreliable — adapter skips Cloud-cap mapping and falls back to LAN-default states. */
  brokenPlatformApi?: boolean;
  /**
   * Per-command transport override — forces a command through Cloud or LAN
   * regardless of the default LAN-first heuristic. Use for SKUs where
   * Govee's LAN bridge silently drops a specific protocol family (e.g. H70B3
   * pixel-display snapshots: Loxforum-verified that A4-frames are filtered
   * by the WiFi firmware before reaching the BLE side).
   *
   * Value "cloud" forces sendCloudCommand. Value "lan" is a no-op (identical
   * to omitting the field) and exists for schema symmetry. Segment-suffix
   * commands (segmentColor:N, segmentBrightness:N) inherit the segmentBatch
   * override automatically.
   */
  transportOverrides?: Partial<Record<ConfigurableOverrideCommand, TransportTarget>>;
}

/**
 * Every command the router accepts. Includes dynamic-suffix commands
 * (segmentColor:N, segmentBrightness:N) which can't appear in devices.json
 * literally — they inherit the segmentBatch override at lookup time.
 */
export type OverridableCommand =
  | "power"
  | "brightness"
  | "colorRgb"
  | "colorTemperature"
  | "lightScene"
  | "diyScene"
  | "snapshot"
  | "gradientToggle"
  | "segmentBatch"
  | `segmentColor:${number}`
  | `segmentBrightness:${number}`;

/**
 * Subset of OverridableCommand that may appear as a key in devices.json.
 * Dynamic-suffix commands are excluded — covering all segment ops through
 * a single segmentBatch entry is both shorter and structurally correct.
 */
export type ConfigurableOverrideCommand = Exclude<
  OverridableCommand,
  `segmentColor:${number}` | `segmentBrightness:${number}`
>;

/** Target transport for a command override. */
export type TransportTarget = "cloud" | "lan";

/** Trust tiers used to decide whether a device's quirks are applied by default. */
export type DeviceStatus = "verified" | "reported" | "seed";

/** A single SKU entry in devices.json. */
export interface DeviceEntry {
  /** Govee app name — what users see in the Govee Home app. */
  name: string;
  /** Device category (Govee API type without `devices.types.` prefix). */
  type:
    | "light"
    | "thermometer"
    | "sensor"
    | "heater"
    | "humidifier"
    | "dehumidifier"
    | "fan"
    | "air_purifier"
    | "socket"
    | "kettle"
    | "ice_maker"
    | "aroma_diffuser";
  /** Trust tier (see DeviceStatus). */
  status: DeviceStatus;
  /** Adapter version when this device was first supported (semver). Optional. */
  since?: string;
  /** Per-SKU quirks the adapter applies at runtime. Optional. */
  quirks?: DeviceQuirks;
}

/** Top-level structure of devices.json. */
interface DevicesFile {
  _comment?: string;
  devices: Record<string, DeviceEntry>;
}

interface RegistryConfig {
  /** Path to devices.json. Default: `<adapter root>/devices.json`. Ignored when `data` is given. */
  filePath?: string;
  /** Pre-parsed devices data — alternative to filePath, primarily for unit tests. */
  data?: DevicesFile;
  /**
   * Whether seed-status entries are activated. Default: false (the adapter
   * config option `experimentalQuirks` flips this on for users who want to
   * try untested devices).
   */
  experimental?: boolean;
  /** Optional logger — used to surface load failures and active-device counts. */
  log?: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

/**
 * Loads devices.json + filters by status. Replacement for the old
 * `device-quirks.ts` module that only had a hard-coded TS map.
 *
 * Status filter:
 *   - verified + reported → always active (default-on)
 *   - seed                → only when experimental=true
 *
 * Unknown SKUs return undefined from `getQuirks()`/`getEntry()` — the
 * adapter then runs its default code path without overrides.
 */
export class DeviceRegistry {
  private readonly entries: Map<string, DeviceEntry>;
  private readonly activeQuirks: Map<string, DeviceQuirks>;
  private readonly experimental: boolean;
  private readonly log: RegistryConfig["log"];

  /**
   * Build a registry from `config.data` (preferred for tests) or from a
   * file at `config.filePath` (default: `<adapter root>/devices.json`).
   *
   * @param config Loader options
   */
  constructor(config: RegistryConfig = {}) {
    this.experimental = config.experimental ?? false;
    this.log = config.log;
    this.entries = new Map();
    this.activeQuirks = new Map();

    if (config.data) {
      this.ingest(config.data);
    } else {
      const filePath = config.filePath ?? this.defaultPath();
      this.loadFromFile(filePath);
    }
  }

  /** Resolve the canonical devices.json path next to the package root. */
  private defaultPath(): string {
    return path.resolve(__dirname, "..", "..", "devices.json");
  }

  /**
   * Read devices.json from disk. Logs but does not throw on errors —
   * an empty registry is a safer fallback than a crashed adapter.
   *
   * @param filePath Absolute path to devices.json
   */
  private loadFromFile(filePath: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      this.log?.warn(`device-registry: cannot read ${filePath}: ${errMessage(err)}`);
      return;
    }

    let parsed: DevicesFile;
    try {
      parsed = JSON.parse(raw) as DevicesFile;
    } catch (err) {
      this.log?.warn(`device-registry: invalid JSON in ${filePath}: ${errMessage(err)}`);
      return;
    }

    this.ingest(parsed);
  }

  /**
   * Populate the in-memory maps from a parsed devices object. Shared
   * between file-loading and direct-data path (tests).
   *
   * @param parsed Pre-parsed devices.json content
   */
  private ingest(parsed: DevicesFile): void {
    if (!parsed?.devices || typeof parsed.devices !== "object") {
      this.log?.warn(`device-registry: 'devices' object missing or invalid`);
      return;
    }

    let active = 0;
    let skipped = 0;
    for (const [sku, entry] of Object.entries(parsed.devices)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const upper = sku.toUpperCase();
      this.entries.set(upper, entry);

      const eligible =
        entry.status === "verified" || entry.status === "reported" || (entry.status === "seed" && this.experimental);

      if (eligible && entry.quirks) {
        this.activeQuirks.set(upper, entry.quirks);
        active++;
      } else if (!eligible) {
        skipped++;
      }
    }

    this.log?.debug(
      `device-registry: ${this.entries.size} entries loaded, ${active} active quirks, ${skipped} seed entries skipped`,
    );
    // The boot-time seed-list dump was removed: it logged every seed SKU in
    // the catalog regardless of whether the user owned any of them, so a
    // typical Lights-only setup got 27 SKUs in their face for nothing.
    // The targeted nudge — "your H7160 is here, flip the toggle" — now
    // happens later in `noteSeedDeviceDetected()`, called by the device
    // manager when a real device of that SKU appears.
  }

  /**
   * Whether the given SKU exists as a `seed` entry in the catalog and
   * the experimental toggle is OFF — i.e. the adapter recognises this
   * device but the per-SKU quirk corrections aren't active. The device
   * manager calls this when a real device shows up so the user gets a
   * targeted* nudge ("you have an H7160, enable the toggle"), not a
   * blanket dump of every seed entry in the catalog.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  isSeedAndDormant(sku: string): boolean {
    if (this.experimental) {
      return false;
    }
    if (!sku || typeof sku !== "string") {
      return false;
    }
    return this.entries.get(sku.toUpperCase())?.status === "seed";
  }

  /**
   * Quirks for a SKU. Returns undefined if SKU is unknown OR if it's a
   * seed-status entry and `experimental` is off.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getQuirks(sku: string): DeviceQuirks | undefined {
    if (typeof sku !== "string") {
      return undefined;
    }
    return this.activeQuirks.get(sku.toUpperCase());
  }

  /**
   * The full registry entry for a SKU (status, name, since, quirks).
   * Returns undefined for unknown SKUs.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getEntry(sku: string): DeviceEntry | undefined {
    if (typeof sku !== "string") {
      return undefined;
    }
    return this.entries.get(sku.toUpperCase());
  }

  /**
   * Trust tier of a SKU, or undefined if unknown.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getStatus(sku: string): DeviceStatus | undefined {
    return this.getEntry(sku)?.status;
  }
}

/**
 * Module-level singleton — preserves the old `device-quirks.ts` API surface
 * so capability-mapper.ts and device-manager.ts can use the registry through
 * stateless function calls. The adapter calls `initDeviceRegistry()` once
 * during onReady; tests reset it via `_resetDeviceRegistry()`.
 */
let singleton: DeviceRegistry | undefined;

/**
 * Initialize the module-level registry. Adapter calls this once during
 * `onReady` with the experimental flag from config.
 *
 * @param config Loader options
 */
export function initDeviceRegistry(config: RegistryConfig = {}): DeviceRegistry {
  singleton = new DeviceRegistry(config);
  return singleton;
}

/**
 * Test-only helper — resets the singleton between mocha tests.
 * Not for production use.
 */
export function _resetDeviceRegistry(): void {
  singleton = undefined;
}

/**
 * Stateless quirks lookup — replacement for the old `getDeviceQuirks`.
 * Returns undefined if the registry hasn't been initialised yet (early
 * adapter startup) or the SKU is unknown / inactive.
 *
 * @param sku Govee SKU (case-insensitive)
 */
export function getDeviceQuirks(sku: string): DeviceQuirks | undefined {
  return singleton?.getQuirks(sku);
}

/**
 * Stateless color-temp clamp — applies a colorTempRange quirk if present,
 * otherwise returns the API-reported range unchanged. Falls through to the
 * input range if the registry hasn't been initialised yet (early startup).
 *
 * @param sku Govee SKU
 * @param min API-reported minimum
 * @param max API-reported maximum
 */
export function applyColorTempQuirk(sku: string, min: number, max: number): { min: number; max: number } {
  const q = singleton?.getQuirks(sku);
  if (q?.colorTempRange) {
    return q.colorTempRange;
  }
  return { min, max };
}

/**
 * Stateless check whether a SKU is recognised as `seed` and the toggle is
 * off — used by the device manager to nudge the user only for SKUs that
 * actually show up at runtime.
 *
 * @param sku Govee SKU (case-insensitive)
 */
export function isSeedAndDormant(sku: string): boolean {
  return singleton?.isSeedAndDormant(sku) ?? false;
}

/**
 * Single canonical trust tier for a SKU as exposed to users via the
 * `diag.tier` state. Unlike `getStatus`, this collapses the
 * `undefined`-from-registry case into the explicit string `"unknown"` so
 * the value is always one of four well-known labels.
 *
 * @param sku Govee SKU (case-insensitive)
 */
export function getDeviceTier(sku: string): "verified" | "reported" | "seed" | "unknown" {
  return singleton?.getStatus(sku) ?? "unknown";
}
