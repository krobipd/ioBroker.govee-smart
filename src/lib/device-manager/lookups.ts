import { normalizeDeviceId, type GoveeDevice } from "../types";
import { mapKey } from "../device-key";
import { getDeviceQuirks } from "../device-registry";

/** Parsed per-segment data from MQTT BLE packets */
export interface MqttSegmentData {
  /** Segment index (0-based) */
  index: number;
  /** Per-segment brightness 0-100 */
  brightness: number;
  /** Red channel 0-255 */
  r: number;
  /** Green channel 0-255 */
  g: number;
  /** Blue channel 0-255 */
  b: number;
}

/** Result of parsing a segment push. */
export interface ParsedMqttSegments {
  /** Per-segment data with trailing padding slots removed. */
  segments: MqttSegmentData[];
  /**
   * True when trailing padding was actually stripped — the device ended its
   * list, so `segments.length` is the real count and may be trusted to SHRINK
   * the stored total. False when nothing was stripped: the list may have been
   * truncated at the 20-slot parser cap, so the count must only grow.
   */
  complete: boolean;
}

/**
 * Parse AA A5 BLE notification packets from MQTT op.command.
 * 5 packets × 4 segment slots = max 20 segments per push. The device sends
 * exactly as many packets as it has physical segments — so parsing out all
 * slots (and filtering empty-slot padding) gives us a reliable count of
 * what actually exists on the strip.
 *
 * Format per slot: [Brightness 0-100] [R] [G] [B].
 *
 * An "empty" slot (brightness = 0 AND r = g = b = 0) is treated as padding
 * in a partially-filled final packet, not as a real unlit segment — this
 * matters for devices that don't pad their last packet to 4 slots.
 *
 * @param commands Base64-encoded BLE packets from MQTT op.command
 */
export function parseMqttSegmentData(commands: string[]): ParsedMqttSegments {
  if (!Array.isArray(commands)) {
    return { segments: [], complete: false };
  }

  const segments: MqttSegmentData[] = [];
  // There are only 5 valid AA-A5 packet numbers (1-5 → segment indices 0-19).
  // Dedupe by packet number and bound the scan so a malicious broker can't send
  // a huge `op.command` array of duplicate/valid packets and blow the segments
  // list up into ~80k setState writes / a Math.max(...spread) RangeError (SEC-GC1).
  const seenPackets = new Set<number>();
  const MAX_SCAN = 512;
  let scanned = 0;

  for (const cmd of commands) {
    if (seenPackets.size >= 5 || scanned >= MAX_SCAN) {
      break;
    }
    scanned++;
    if (typeof cmd !== "string") {
      continue;
    }
    const bytes = Buffer.from(cmd, "base64");
    if (bytes.length < 20 || bytes[0] !== 0xaa || bytes[1] !== 0xa5) {
      continue;
    }

    // M2 — XOR checksum validation. Govee BLE packets carry an XOR over bytes
    // 0-18 in the last byte (index 19). Spoofed/malformed packets would
    // otherwise slip through and persist a wrong segmentCount.
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= bytes[i];
    }
    if (xor !== bytes[19]) {
      continue;
    }

    const packetNum = bytes[2];
    if (packetNum < 1 || packetNum > 5) {
      continue;
    }
    if (seenPackets.has(packetNum)) {
      continue; // one packet per number — a repeat is corrupt/malicious (SEC-GC1)
    }
    seenPackets.add(packetNum);

    const baseIndex = (packetNum - 1) * 4;
    for (let slot = 0; slot < 4; slot++) {
      const segIdx = baseIndex + slot;
      const offset = 3 + slot * 4;
      segments.push({
        index: segIdx,
        brightness: bytes[offset],
        r: bytes[offset + 1],
        g: bytes[offset + 2],
        b: bytes[offset + 3],
      });
    }
  }

  // Strip trailing padding. The final packet is padded to 4 slots when the real
  // segment count isn't a multiple of 4. Padding is either all-zero OR carries
  // an impossible brightness (>100 can never be a real segment — the H6076 pads
  // with 0x92 = 146). If we stripped anything, the device ended its list here →
  // `complete`, and the count may shrink the stored total. If we stripped
  // nothing, the list may be truncated at the 20-slot parser cap → grow-only.
  let strippedPadding = false;
  while (segments.length > 0) {
    const tail = segments[segments.length - 1];
    const allZero = tail.brightness === 0 && tail.r === 0 && tail.g === 0 && tail.b === 0;
    if (allZero || tail.brightness > 100) {
      segments.pop();
      strippedPadding = true;
    } else {
      break;
    }
  }

  return { segments, complete: strippedPadding };
}

/**
 * Resolve the authoritative segment count for a device.
 *
 * Priority:
 *   1. `segmentCount` quirk if present — a hard override for a lying capability
 *   2. `device.segmentCount` if already set (from cache, MQTT discovery, or wizard)
 *   3. Minimum of positive `segment_color_setting` capability counts
 *   4. 0 if no capability advertises segments
 *
 * Why `min` over the capability caps: Govee reports `segmentedBrightness` and
 * `segmentedColorRgb` separately, and on at least one SKU (H70D1) those two
 * disagree — brightness says 10, colorRgb says 15, real device has 10.
 * Picking the smaller value is the safer starting point; MQTT discovery can
 * then grow it if the real device pushes more slots.
 *
 * @param device Target device
 */
export function resolveSegmentCount(device: GoveeDevice): number {
  // A segmentCount quirk is a hard override — Govee's capability count lies for
  // some SKUs; this wins over Cloud, cache and the live MQTT value.
  const override = plausibleSegmentCount(getDeviceQuirks(device.sku)?.segmentCount);
  if (override !== undefined) {
    return override;
  }
  const stored = plausibleSegmentCount(device.segmentCount);
  if (stored !== undefined) {
    return stored;
  }
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  let min = Number.POSITIVE_INFINITY;
  for (const c of caps) {
    if (!c || typeof c.type !== "string" || !c.type.includes("segment_color_setting")) {
      continue;
    }
    const params = (c as { parameters?: { fields?: unknown[] } }).parameters;
    const fields = Array.isArray(params?.fields) ? params.fields : [];
    for (const f of fields) {
      if (!f || typeof f !== "object") {
        continue;
      }
      const fn = (f as { fieldName?: unknown }).fieldName;
      const er = (f as { elementRange?: { max?: unknown } }).elementRange;
      const rawMax = er && typeof er.max === "number" ? er.max : -1;
      // API boundary: a Cloud capability claiming more slots than the protocol can
      // address is a lie, not a bigger strip — ignore it like any other malformed field.
      const n = fn === "segment" && rawMax >= 0 ? plausibleSegmentCount(rawMax + 1) : undefined;
      if (n !== undefined && n < min) {
        min = n;
      }
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** Protocol limit: Govee's segment bitmask is 7 bytes × 8 bits = 56 slots (0..55). */
export const SEGMENT_HARD_MAX = 55;

/** Number of addressable segment slots (SEGMENT_HARD_MAX + 1 = 56). */
export const SEGMENT_COUNT_MAX = SEGMENT_HARD_MAX + 1;

/**
 * A segment COUNT the Govee bitmask protocol can actually address: an integer in
 * `1..SEGMENT_COUNT_MAX`. Anything else — 0, a fraction, a corrupt cache value, a
 * Cloud capability advertising thousands of slots, an oversized wizard payload —
 * comes back as `undefined` so the caller treats it as "not known" instead of
 * building that many segment channels. Single choke point for every source a
 * count can enter from (cache, Cloud, MQTT, wizard).
 *
 * @param n Candidate count from any source
 */
export function plausibleSegmentCount(n: unknown): number | undefined {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SEGMENT_COUNT_MAX ? n : undefined;
}

/**
 * The subset of a manual-segment index list the protocol can address
 * (`0..SEGMENT_HARD_MAX`, integers, deduplicated, ascending). `undefined` when
 * nothing usable is left — the caller then treats the device as contiguous.
 * Used where a list enters from an untrusted store (the host-local cache file);
 * the user-facing entry points already validate through `parseSegmentList`.
 *
 * @param list Candidate index list from any source
 */
export function plausibleSegmentIndices(list: unknown): number[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const clean = [
    ...new Set(
      list.filter((i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= SEGMENT_HARD_MAX),
    ),
  ].sort((a, b) => a - b);
  return clean.length > 0 ? clean : undefined;
}

/** ptReal color-segment bitmask size (Govee protocol-fixed): one bit per segment, 56 segments → 7 bytes. */
export const SEGMENT_COLOR_BITMASK_BYTES = 7;

/** ptReal brightness-segment bitmask size (Govee protocol-fixed): twice the color width → 14 bytes. */
export const SEGMENT_BRIGHTNESS_BITMASK_BYTES = 14;

/**
 * Generate the stable runtime map key for a device — thin wrapper over
 * {@link mapKey} (device-key.ts), kept for the existing call sites.
 *
 */
export function deviceKey(sku: string, deviceId: string): string {
  return mapKey(sku, deviceId);
}

/**
 * Locate a device in the registry by SKU + raw deviceId, with normalized
 * fallback. Direct key-hit first; if that misses, scan for a normalized
 * match (device IDs come from multiple sources with different
 * colon/case conventions).
 *
 */
export function findDeviceBySkuAndId(
  devices: Map<string, GoveeDevice>,
  sku: string,
  deviceId: string,
): GoveeDevice | undefined {
  const direct = devices.get(deviceKey(sku, deviceId));
  if (direct) {
    return direct;
  }
  const normalizedId = normalizeDeviceId(deviceId);
  for (const dev of devices.values()) {
    if (dev.sku === sku && normalizeDeviceId(dev.deviceId) === normalizedId) {
      return dev;
    }
  }
  return undefined;
}
