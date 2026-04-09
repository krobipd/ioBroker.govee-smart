/**
 * Device quirks — overrides for SKUs where Govee's API data is wrong.
 * Source: govee2mqtt research, real-world testing.
 */

/** Per-SKU quirk overrides */
export interface DeviceQuirks {
  /** Override color temperature range (API often claims 2000-9000K) */
  colorTempRange?: { min: number; max: number };
  /** Device has broken/bogus platform API metadata */
  brokenPlatformApi?: boolean;
  /** Device does not support MQTT despite being a light */
  noMqtt?: boolean;
}

const QUIRKS: Record<string, DeviceQuirks> = {
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

  // No MQTT support despite being light-type
  H6121: { noMqtt: true },
  H6154: { noMqtt: true },
  H6176: { noMqtt: true },
};

/**
 * Get quirks for a device SKU.
 *
 * @param sku Product model (e.g. "H60A1")
 */
export function getDeviceQuirks(sku: string): DeviceQuirks | undefined {
  return QUIRKS[sku.toUpperCase()];
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
