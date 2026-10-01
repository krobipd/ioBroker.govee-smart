// Govee's BLE frames as the LAN API relays them (ptReal): the encoders for scenes, DIY, music, gradient and
// segments, the scene-speed byte, and the one rule a received frame has to pass.
import { clampByte } from "./color";

/**
 * A percentage byte: 0–100, rounded; anything that is no finite number is 0.
 *
 * @param v The value
 */
export function clampByte0_100(v: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** ptReal color-segment bitmask size (Govee protocol-fixed): one bit per segment, 56 segments → 7 bytes. */
export const SEGMENT_COLOR_BITMASK_BYTES = 7;

/** ptReal brightness-segment bitmask size (Govee protocol-fixed): twice the color width → 14 bytes. */
export const SEGMENT_BRIGHTNESS_BITMASK_BYTES = 14;

/** A Govee BLE frame: 19 bytes, then the XOR of those 19 in byte 19. */
export const BLE_FRAME_BYTES = 20;

/**
 * XOR over the first `end` bytes — the checksum of a BLE frame.
 *
 * @param data Byte values
 * @param end How many leading bytes count (default: all)
 */
function xorChecksum(data: ArrayLike<number>, end = data.length): number {
  let checksum = 0;
  for (let i = 0; i < end; i++) {
    checksum ^= data[i];
  }
  return checksum;
}

/**
 * A received BLE frame, base64 as Govee relays it (`op.command`, snapshot packets): exactly
 * {@link BLE_FRAME_BYTES} bytes with a matching checksum, else null. The ONE rule for the status
 * push, the segment echo and the snapshot masks — until 3.1.0 three copies, one of them taking any
 * frame of 20 bytes OR MORE (audit DRY-8).
 *
 * @param raw The base64 text
 */
export function decodeBleFrame(raw: unknown): Buffer | null {
  if (typeof raw !== "string") {
    return null;
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== BLE_FRAME_BYTES || xorChecksum(bytes, BLE_FRAME_BYTES - 1) !== bytes[BLE_FRAME_BYTES - 1]) {
    return null;
  }
  return bytes;
}

/**
 * Pad data to 19 bytes + append XOR checksum = 20-byte BLE packet
 *
 * @param data Array of byte values to pad and checksum
 */
function finishPacket(data: number[]): number[] {
  while (data.length < 19) {
    data.push(0);
  }
  data.push(xorChecksum(data));
  return data;
}

/**
 * Frame arbitrary payload bytes into 19-byte BLE packets using Govee's
 * line-continuation protocol, then base64 each. Scenes (A3) and DIY (A1) differ
 * only in the header bytes, the per-line continuation prefix, and which header
 * index the 0xff line-marker defaults to when the payload fits a single line —
 * the `% 19` chunking, the `rawData[3] = numLines + 1` count, and the chunk →
 * checksum → base64 tail are identical. Byte-locked by the
 * "A-frame packet framing (byte-golden)" test.
 *
 * @param paramBytes Decoded payload bytes
 * @param header Leading frame bytes (the line count is written at index 3)
 * @param contPrefix Bytes that open each continuation line (before its number)
 * @param initMarker Header index the 0xff marker defaults to for a single line
 */
function buildAFramedPackets(
  paramBytes: number[],
  header: number[],
  contPrefix: number[],
  initMarker: number,
): string[] {
  const rawData: number[] = [...header];
  let numLines = 0;
  let lastLineMarker = initMarker;

  for (const b of paramBytes) {
    if (rawData.length % 19 === 0) {
      numLines++;
      rawData.push(...contPrefix);
      lastLineMarker = rawData.length;
      rawData.push(numLines);
    }
    rawData.push(b);
  }
  rawData[lastLineMarker] = 0xff;
  rawData[3] = numLines + 1;

  // Split into 19-byte chunks, pad + checksum each
  const packets: string[] = [];
  for (let i = 0; i < rawData.length; i += 19) {
    packets.push(Buffer.from(finishPacket(rawData.slice(i, i + 19))).toString("base64"));
  }
  return packets;
}

/**
 * Build Base64-encoded BLE packets for scene activation via ptReal.
 *
 * @param sceneCode Scene code from library (> 0)
 * @param scenceParam Base64-encoded scene parameter data (may be empty)
 */
export function buildScenePackets(sceneCode: number, scenceParam: string): string[] {
  const packets: string[] = [];

  // Multi-packet scene data (A3 framing: header A3 00 01 00 02, continuation A3)
  if (scenceParam) {
    const paramBytes = Array.from(Buffer.from(scenceParam, "base64"));
    packets.push(...buildAFramedPackets(paramBytes, [0xa3, 0x00, 0x01, 0x00, 0x02], [0xa3], 1));
  }

  // Final scene-code activation packet: 33 05 04 lo hi
  const lo = sceneCode & 0xff;
  const hi = (sceneCode >> 8) & 0xff;
  const activatePacket = finishPacket([0x33, 0x05, 0x04, lo, hi]);
  packets.push(Buffer.from(activatePacket).toString("base64"));

  return packets;
}

/**
 * Build Base64-encoded BLE packets for DIY scene activation via ptReal.
 * Uses A1 framing for multi-packet data, then sends activation command.
 *
 * @param scenceParam Base64-encoded DIY parameter data (may be empty)
 */
export function buildDiyPackets(scenceParam: string): string[] {
  const packets: string[] = [];

  // Multi-packet DIY data (A1 framing: header A1 02 00 00, continuation A1 02)
  if (scenceParam) {
    const paramBytes = Array.from(Buffer.from(scenceParam, "base64"));
    packets.push(...buildAFramedPackets(paramBytes, [0xa1, 0x02, 0x00, 0x00], [0xa1, 0x02], 2));
  }

  // Activation: 33 05 0A
  packets.push(Buffer.from(finishPacket([0x33, 0x05, 0x0a])).toString("base64"));
  return packets;
}

/**
 * Build a Base64-encoded BLE packet for gradient toggle via ptReal.
 *
 * @param on Gradient on/off
 */
export function buildGradientPacket(on: boolean): string {
  return Buffer.from(finishPacket([0x33, 0x14, on ? 0x01 : 0x00])).toString("base64");
}

/**
 * Build a Base64-encoded BLE packet for music mode via ptReal
 * (`33 05 01 <mode> [R G B]`).
 *
 * Whether RGB is appended is decided by the CALLER (via {@link
 * musicModeNameUsesRgb} on the mode name), not by the sub-mode value here:
 * Govee's music-mode values are SKU-specific, so a value-based gate would
 * append RGB on the wrong mode for a SKU whose Spectrum/Rolling isn't at the
 * usual value 1/2 (A1 proved mode values vary across the fleet).
 *
 * @param subMode Music sub-mode value sent to the device (raw capability value)
 * @param includeRgb Whether this mode carries a custom RGB colour (Spectrum/Rolling)
 * @param r Red channel 0-255
 * @param g Green channel 0-255
 * @param b Blue channel 0-255
 */
export function buildMusicModePacket(subMode: number, includeRgb: boolean, r = 0, g = 0, b = 0): string {
  const data = [0x33, 0x05, 0x01, subMode & 0xff];
  if (includeRgb) {
    data.push(clampByte(r), clampByte(g), clampByte(b));
  }
  return Buffer.from(finishPacket(data)).toString("base64");
}

/**
 * Build a little-endian segment bitmask.
 * Segment 0 = byte[0] bit 0, Segment 8 = byte[1] bit 0, etc.
 *
 * @param segments Array of 0-based segment indices
 * @param byteCount Number of bitmask bytes (7 for color, 14 for brightness)
 */
export function buildSegmentBitmask(segments: number[], byteCount: number): number[] {
  const mask = new Array<number>(byteCount).fill(0);
  for (const seg of segments) {
    const byteIdx = Math.floor(seg / 8);
    const bitIdx = seg % 8;
    if (byteIdx < byteCount) {
      mask[byteIdx] |= 1 << bitIdx;
    }
  }
  return mask;
}

/**
 * Build a Base64-encoded BLE packet for segment color via ptReal.
 * Command: 33 05 15 01 RR GG BB 00×5 bitmask×7
 *
 * @param r Red 0-255
 * @param g Green 0-255
 * @param b Blue 0-255
 * @param segments Array of 0-based segment indices
 */
export function buildSegmentColorPacket(r: number, g: number, b: number, segments: number[]): string {
  const data = [
    0x33,
    0x05,
    0x15,
    0x01,
    clampByte(r),
    clampByte(g),
    clampByte(b),
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...buildSegmentBitmask(segments, SEGMENT_COLOR_BITMASK_BYTES),
  ];
  return Buffer.from(finishPacket(data)).toString("base64");
}

/**
 * Build a Base64-encoded BLE packet for segment brightness via ptReal.
 * Command: 33 05 15 02 BB bitmask×14
 *
 * @param brightness Brightness 0-100
 * @param segments Array of 0-based segment indices
 */
export function buildSegmentBrightnessPacket(brightness: number, segments: number[]): string {
  const data = [
    0x33,
    0x05,
    0x15,
    0x02,
    clampByte0_100(brightness),
    ...buildSegmentBitmask(segments, SEGMENT_BRIGHTNESS_BITMASK_BYTES),
  ];
  return Buffer.from(finishPacket(data)).toString("base64");
}

/**
 * Apply speed level to a scene's scenceParam by replacing speed bytes in each page.
 * scenceParam structure: byte[0] = page count, then per page: 1 byte length + N bytes data.
 * Speed byte position within each page: pageLength - 5.
 *
 * @param scenceParam Base64-encoded scene parameter data
 * @param speedLevel Speed level index (0-based)
 * @param speedConfig JSON config string from speedInfo.config
 * @returns Modified Base64-encoded scenceParam with speed bytes replaced
 */
export function applySceneSpeed(scenceParam: string, speedLevel: number, speedConfig: string): string {
  if (!scenceParam || !speedConfig) {
    return scenceParam;
  }

  let configEntries: Array<{
    page: number;
    moveIn?: number[];
  }>;
  try {
    configEntries = JSON.parse(speedConfig);
  } catch {
    // Govee's speedInfo.config schema can drift — this is a pure helper
    // without a logger, so a malformed config falls back silently: the
    // un-modified scenceParam keeps the activation working at default
    // speed instead of failing the whole scene command.
    return scenceParam;
  }

  if (!Array.isArray(configEntries) || configEntries.length === 0) {
    return scenceParam;
  }

  const bytes = Array.from(Buffer.from(scenceParam, "base64"));
  if (bytes.length === 0) {
    return scenceParam;
  }

  const pageCount = bytes[0];
  let offset = 1;

  for (let pageIdx = 0; pageIdx < pageCount && offset < bytes.length; pageIdx++) {
    const pageLen = bytes[offset];
    if (offset + 1 + pageLen > bytes.length) {
      break;
    }

    const cfg = configEntries.find(c => c.page === pageIdx);
    if (cfg?.moveIn && speedLevel >= 0 && speedLevel < cfg.moveIn.length) {
      const speedBytePos = offset + 1 + (pageLen - 5);
      if (speedBytePos > offset && speedBytePos < offset + 1 + pageLen) {
        bytes[speedBytePos] = cfg.moveIn[speedLevel];
      }
    }

    offset += 1 + pageLen;
  }

  return Buffer.from(bytes).toString("base64");
}
