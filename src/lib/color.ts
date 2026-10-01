// Colour conversions between Govee's integer RGB, ioBroker's `#rrggbb` and byte channels.

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
