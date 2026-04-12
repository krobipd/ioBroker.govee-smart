import * as fs from "node:fs";

/**
 * Device quirks — overrides for SKUs where Govee's API data is wrong.
 * Source: govee2mqtt research, real-world testing, community reports.
 */

/** Per-SKU quirk overrides */
export interface DeviceQuirks {
  /** Override color temperature range (API often claims 2000-9000K) */
  colorTempRange?: { min: number; max: number };
  /** Device has broken/bogus platform API metadata */
  brokenPlatformApi?: boolean;
}

/** Built-in quirks — verified, always available */
const BUILTIN_QUIRKS: Record<string, DeviceQuirks> = {
  // Color temperature overrides (API claims 2000-9000K)
  H60A1: { colorTempRange: { min: 2200, max: 6500 } },
  H6022: { colorTempRange: { min: 2700, max: 6500 } },

  // Broken platform API metadata
  H6141: { brokenPlatformApi: true },
  H6159: { brokenPlatformApi: true },
  H6003: { brokenPlatformApi: true },
  H6102: { brokenPlatformApi: true },
  H6053: { brokenPlatformApi: true },
  H617C: { brokenPlatformApi: true },
  H617E: { brokenPlatformApi: true },
  H617F: { brokenPlatformApi: true },
  H6119: { brokenPlatformApi: true },
};

/** Merged quirks map: community overrides built-in */
let mergedQuirks: Record<string, DeviceQuirks> = { ...BUILTIN_QUIRKS };

/** Community quirks JSON file structure */
interface CommunityQuirksFile {
  version?: number;
  quirks: Record<string, DeviceQuirks>;
}

/**
 * Load community quirks from a JSON file and merge with built-in quirks.
 * Community entries override built-in entries for the same SKU.
 *
 * @param filePath Path to community-quirks.json
 * @param log Optional logger with info and debug methods
 * @param log.info Log info message
 * @param log.debug Log debug message
 */
export function loadCommunityQuirks(
  filePath: string,
  log?: { info: (msg: string) => void; debug: (msg: string) => void },
): void {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as CommunityQuirksFile;
    if (!data.quirks || typeof data.quirks !== "object") {
      log?.debug("Community quirks file has no valid 'quirks' object");
      return;
    }

    // Merge: community overrides built-in
    mergedQuirks = { ...BUILTIN_QUIRKS };
    let count = 0;
    for (const [sku, quirk] of Object.entries(data.quirks)) {
      mergedQuirks[sku.toUpperCase()] = quirk;
      count++;
    }
    log?.debug(`Loaded ${count} community quirks (v${data.version ?? "?"})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log?.debug("No community quirks file found — using built-in only");
    } else {
      log?.info(
        `Could not load community quirks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Get quirks for a device SKU.
 *
 * @param sku Product model (e.g. "H60A1")
 */
export function getDeviceQuirks(sku: string): DeviceQuirks | undefined {
  return mergedQuirks[sku.toUpperCase()];
}

/**
 * Apply color temperature quirk — clamp range if device has known override.
 *
 * @param sku Product model
 * @param min API-reported minimum
 * @param max API-reported maximum
 */
export function applyColorTempQuirk(
  sku: string,
  min: number,
  max: number,
): { min: number; max: number } {
  const quirks = getDeviceQuirks(sku);
  if (quirks?.colorTempRange) {
    return quirks.colorTempRange;
  }
  return { min, max };
}
