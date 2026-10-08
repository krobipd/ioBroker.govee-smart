import { errText } from "./types";
import type { DeviceEntry, DeviceQuirks, DevicesFile, DeviceStatus } from "./device-catalog";
import * as fs from "node:fs";
import * as path from "node:path";

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
   * device but the user has not opted in yet (catalog quirks, where the
   * entry carries any, stay inactive as well). The device
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
   * `diag.tier` state. Unlike {@link getStatus}, this collapses the
   * unknown-SKU case into the explicit string `"unknown"` so the value is
   * always one of four well-known labels.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getTier(sku: string): DeviceTier {
    return this.getStatus(sku) ?? "unknown";
  }
}

/** The four labels `diag.tier` can carry — the three catalog statuses plus "unknown". */
export type DeviceTier = DeviceStatus | "unknown";

// There is deliberately NO module-level registry: every adapter instance builds
// its own from its own `experimentalQuirks` setting and hands it to the modules
// that need it. In compact mode several instances share one process (one module
// cache), and a shared registry let the instance that started last decide the
// experimental toggle for all of them.
