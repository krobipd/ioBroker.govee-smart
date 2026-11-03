import { errText } from "./types";
import type { DeviceEntry, DeviceQuirks, DevicesFile, DeviceStatus } from "./device-catalog";
import * as fs from "node:fs";
import * as path from "node:path";

interface RegistryConfig {
  /** Path to devices.json. Default: `<adapter root>/devices.json`. Ignored when `data` is given. */
  filePath?: string;
  /** Pre-parsed devices data — alternative to filePath, primarily for unit tests. */
  data?: DevicesFile;
  /** Optional logger — used to surface load failures and active-device counts. */
  log?: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

/**
 * Loads devices.json. Replacement for the old `device-quirks.ts` module that
 * only had a hard-coded TS map.
 *
 * A catalog correction (quirk) always applies to exactly the model it is
 * written for, whatever that model's status (GV-25): the status only says how
 * well the model is confirmed and decides whether it asks for a report.
 *
 * Unknown SKUs return undefined from `getQuirks()`/`getEntry()` — the
 * adapter then runs its default code path without overrides.
 */
export class DeviceRegistry {
  private readonly entries: Map<string, DeviceEntry>;
  private readonly activeQuirks: Map<string, DeviceQuirks>;
  private readonly log: RegistryConfig["log"];

  /**
   * Build a registry from `config.data` (preferred for tests) or from a
   * file at `config.filePath` (default: `<adapter root>/devices.json`).
   *
   * @param config Loader options
   */
  constructor(config: RegistryConfig = {}) {
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
      this.log?.warn(`device-registry: cannot read ${filePath}: ${errText(err)}`);
      return;
    }

    let parsed: DevicesFile;
    try {
      parsed = JSON.parse(raw) as DevicesFile;
    } catch (err) {
      this.log?.warn(`device-registry: invalid JSON in ${filePath}: ${errText(err)}`);
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
    for (const [sku, entry] of Object.entries(parsed.devices)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const upper = sku.toUpperCase();
      this.entries.set(upper, entry);

      if (entry.quirks) {
        this.activeQuirks.set(upper, entry.quirks);
        active++;
      }
    }

    this.log?.debug(`device-registry: ${this.entries.size} entries loaded, ${active} with quirks`);
  }

  /**
   * Quirks for a SKU, whatever its status. Returns undefined if the SKU is
   * unknown or its entry carries no quirks.
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

  /**
   * Color-temperature clamp — the `colorTempRange` quirk if one is active for
   * the SKU, otherwise the API-reported range unchanged.
   *
   * @param sku Govee SKU
   * @param min API-reported minimum
   * @param max API-reported maximum
   */
  applyColorTempQuirk(sku: string, min: number, max: number): { min: number; max: number } {
    const q = this.getQuirks(sku);
    if (q?.colorTempRange) {
      return q.colorTempRange;
    }
    return { min, max };
  }

  /**
   * Single canonical trust tier for a SKU as exposed to users via the
   * `info.tier` state. Unlike {@link getStatus}, this collapses the
   * unknown-SKU case into the explicit string `"unknown"` so the value is
   * always one of four well-known labels.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getTier(sku: string): DeviceTier {
    return this.getStatus(sku) ?? "unknown";
  }
}

/** The four labels `info.tier` can carry — the three catalog statuses plus "unknown". */
export type DeviceTier = DeviceStatus | "unknown";

// There is deliberately NO module-level registry: every adapter instance builds
// its own and hands it to the modules that need it, so nothing an instance holds
// leaks into another one sharing the process in compact mode.
