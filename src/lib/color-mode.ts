// The colour mode of a Govee light, read from its own report (krobi 2026-10-20 02:16 "perfekt dann mach das" on the
// plan Ressourcen/govee-smart/plan-farbmodus-2026-10-20.md).
//
// Every colour report carries the mode: `colorTemInKelvin > 0` is colour temperature, `0` is RGB — the convention of
// the push, the LAN `devStatus` answer and the cloud state (`colorRgb` + `colorTemperatureK`), and the one govee2mqtt
// builds its two light modes on. Until 3.2.1 the adapter wrote both datapoints blindly: in colour-temperature mode
// `color_rgb` carried Govee's placeholder (black on the H1741/H600D/H66A1/H1630, white on the H6062/H6093/H6199 — all
// stored reports), in RGB mode `color_temperature` kept its last value, and a local snapshot restored that stale Kelvin
// instead of the colour.
//
// Some models emulate colour temperature with RGB: the Govee app sends the table colour of the Kelvin with Kelvin 0, and
// the device reports it the same way (#57 H6199: 4 app commands, each exactly one table entry; #40 H1310 status
// 255/178/91 = 2800 K). An exact table match is therefore read as colour temperature — a model with real white LEDs
// reports Kelvin > 0 and never reaches the table.

/** What a colour report means for the two datapoints; `null` = no value in this mode. */
export interface ColorMode {
  /** `control.color_rgb` (`#rrggbb`), null in colour-temperature mode. */
  colorRgb: string | null;
  /** `control.color_temperature` (Kelvin), null in RGB mode. */
  colorTemperature: number | null;
}

/**
 * Govee's colour-temperature table, 2000–9000 K: 100-K steps up to 6500 K, then 7000, 7200, 8000, 8200 and 9000 K, two
 * colours per step (the tint a colour-temperature frame sends, and the second one the device answers with).
 *
 * Source: NecroKote/pygovee-h6199-ble `govee_h6199_ble/colortemp.py` (MIT), read from the H6199 itself. Against every
 * stored report it matches 14 of 16 colours that came with Kelvin 0 (homebridge-govee's `k2rgb` 11 — it lacks 2800 and
 * 9000 K and differs from 2200 K on); #56 carries 9000 K as `#d9e1ff`.
 */
const TABLE: ReadonlyArray<readonly [number, string, string]> = [
  [2000, "ff8d0b", "ff8912"],
  [2100, "ff921d", "ff8e21"],
  [2200, "ff9829", "ff932c"],
  [2300, "ff9d33", "ff9836"],
  [2400, "ffa23c", "ff9d3f"],
  [2500, "ffa645", "ffa148"],
  [2600, "ffaa4d", "ffa54f"],
  [2700, "ffae54", "ffa957"],
  [2800, "ffb25b", "ffad5e"],
  [2900, "ffb662", "ffb165"],
  [3000, "ffb969", "ffb46b"],
  [3100, "ffbd6f", "ffb872"],
  [3200, "ffc076", "ffbb78"],
  [3300, "ffc37c", "ffbe7e"],
  [3400, "ffc682", "ffc184"],
  [3500, "ffc987", "ffc489"],
  [3600, "ffcb8d", "ffc78f"],
  [3700, "ffce92", "ffc994"],
  [3800, "ffd097", "ffcc99"],
  [3900, "ffd39c", "ffce9f"],
  [4000, "ffd5a1", "ffd1a3"],
  [4100, "ffd7a6", "ffd3a8"],
  [4200, "ffd9ab", "ffd5ad"],
  [4300, "ffdbaf", "ffd7b1"],
  [4400, "ffddb4", "ffd9b6"],
  [4500, "ffdfb8", "ffdbba"],
  [4600, "ffe1bc", "ffddbe"],
  [4700, "ffe2c0", "ffdfc2"],
  [4800, "ffe4c4", "ffe1c6"],
  [4900, "ffe5c8", "ffe3ca"],
  [5000, "ffe7cc", "ffe4ce"],
  [5100, "ffe8d0", "ffe6d2"],
  [5200, "ffead3", "ffe8d5"],
  [5300, "ffebd7", "ffe9d9"],
  [5400, "ffedda", "ffebdc"],
  [5500, "ffeede", "ffece0"],
  [5600, "ffefe1", "ffeee3"],
  [5700, "fff0e4", "ffefe6"],
  [5800, "fff1e7", "fff0e9"],
  [5900, "fff3ea", "fff2ec"],
  [6000, "fff4ed", "fff3ef"],
  [6100, "fff5f0", "fff4f2"],
  [6200, "fff6f3", "fff5f5"],
  [6300, "fff7f7", "fff6f8"],
  [6400, "fff8f8", "fff8fb"],
  [6500, "fff9fb", "fff9fd"],
  [7000, "f7f5ff", "f5f3ff"],
  [7200, "f3f3ff", "f0f1ff"],
  [8000, "e5e9ff", "e3e9ff"],
  [8200, "e3e8ff", "e0e7ff"],
  [9000, "d9e1ff", "d6e1ff"],
];

/** Table colour (`#rrggbb`, lower case) → Kelvin; both columns. */
export const KELVIN_OF_TABLE_COLOR: ReadonlyMap<string, number> = new Map(
  TABLE.flatMap(([kelvin, first, second]) => [
    [`#${first}`, kelvin],
    [`#${second}`, kelvin],
  ]),
);

/**
 * `#rrggbb` of three channels, each clamped to 0–255.
 *
 * @param r Red
 * @param g Green
 * @param b Blue
 */
function hexOf(r: number, g: number, b: number): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * What one colour report means — only for a report that carries BOTH fields; a report without one of them decides
 * nothing (a `brightness` echo, silence, an offline device keep the datapoints as they are).
 *
 * @param rgb The reported colour, 0–255 per channel
 * @param rgb.r Red
 * @param rgb.g Green
 * @param rgb.b Blue
 * @param kelvin The reported `colorTemInKelvin` / `colorTemperatureK`
 * @returns The two datapoint values
 */
export function colorModeOf(rgb: { r: number; g: number; b: number }, kelvin: number): ColorMode {
  if (kelvin > 0) {
    // Govee's colour in this mode is a placeholder (black or white, per model), not the light's colour.
    return { colorRgb: null, colorTemperature: kelvin };
  }
  const colorRgb = hexOf(rgb.r, rgb.g, rgb.b);
  return { colorRgb, colorTemperature: KELVIN_OF_TABLE_COLOR.get(colorRgb) ?? null };
}

/**
 * Whether a saved colour is Govee's colour-temperature placeholder — a local snapshot taken in colour-temperature mode
 * stored `#000000` (no colour) or, before the colour mode, the placeholder itself.
 *
 * @param colorRgb A saved `#rrggbb`
 */
export function isColorPlaceholder(colorRgb: string): boolean {
  const c = colorRgb.toLowerCase();
  return c === "#000000" || c === "#ffffff";
}

/**
 * Whether a saved colour state comes back as a colour temperature — local snapshots and the segment wizard's baseline.
 * True for a Kelvin with no colour (colour-temperature mode, GV-32) or with Govee's placeholder (a state saved before
 * the colour mode). A Kelvin next to a real colour is either the stale value of RGB mode (the defect #56/#57 exposed)
 * or a table colour — both come back as the colour, the way the device showed them.
 *
 * @param colorRgb The saved colour, if any
 * @param kelvin The saved Kelvin, if any
 */
export function restoresAsColorTemperature(
  colorRgb: string | null | undefined,
  kelvin: number | null | undefined,
): boolean {
  return typeof kelvin === "number" && kelvin > 0 && (typeof colorRgb !== "string" || isColorPlaceholder(colorRgb));
}
