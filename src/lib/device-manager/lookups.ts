import { normalizeDeviceId, type GoveeDevice, type MqttStatusUpdate } from "../types";
import { mapKey } from "../device-key";
import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import { CLOUD_ONLINE_EVIDENCE_TTL_MS, LAN_CAPABLE_MEMORY_MS, LAN_REPLY_FRESHNESS_MS } from "../timing-constants";
import type { DeviceRegistry } from "../device-registry";

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
 * @param registry This instance's device catalog (segmentCount quirk lookup)
 */
export function resolveSegmentCount(device: GoveeDevice, registry: DeviceRegistry): number {
  // A segmentCount quirk is a hard override — Govee's capability count lies for
  // some SKUs; this wins over Cloud, cache and the live MQTT value.
  const override = plausibleSegmentCount(registry.getQuirks(device.sku)?.segmentCount);
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

/**
 * Which source settled a device's reachability. Machine keys, not prose: the
 * diagnostics report turns them into sentences, and keeping the wording out of
 * here is the point — the report used to describe the rule a SECOND time, by
 * hand, and drifted from it. Measured 2026-09-03 on an H618A: all four fields
 * of the report's reachability section were wrong at once, because the rule had
 * moved on in 2.30.0 and the hand-written copy had not.
 *
 * - `lanReply` — the local interface decided; nothing from the cloud counts.
 * - `gatewayDown` — the device's gateway is down, so it cannot be reachable.
 * - `cloudReport` — Govee itself reported, recently enough to still count.
 * - `cloudLiveness` — no report, but Govee recently delivered something FOR
 *   this device (a reading, an event, a capability set). The payload exists
 *   because the device spoke, so it proves reachability — but only upward, and
 *   it loses to a report of any direction.
 * - `noEvidence` — nobody said anything; not reachable, and not proven.
 */
export type ReachabilityDecidedBy = "lanReply" | "gatewayDown" | "cloudReport" | "cloudLiveness" | "noEvidence";

/** What {@link resolveDeviceReachability} answers. */
export interface ReachabilityDecision {
  /** Whether the device is reachable. */
  online: boolean;
  /** Whether that rests on evidence — an unproven `false` may never be written back. */
  proven: boolean;
  /** Which source decided. */
  decidedBy: ReachabilityDecidedBy;
  /** When the deciding source last spoke (ms epoch), or null when none did. */
  lastEvidenceAt: number | null;
}

/**
 * The one answer to "is this device reachable?", for every device kind.
 *
 * Reachability is only ever `true` when something PROVED it. There is no
 * fallback that infers it from the channel, and 2.29.0 shipped one — "the cloud
 * answers and the account still lists this device" — which read as a statement
 * about the device and was one about the account. Two of krobi's strips are
 * unplugged; that version reported both as reachable. A wrong green is worse
 * than a wrong grey: nobody notices it.
 *
 * The three sources of proof, in order:
 *
 * 1. **A light with a local API** — the LAN reply, and nothing else (Govee's
 *    cloud cache lags real reachability; measured 2026-05-13, it reported
 *    `true` twice during a genuine outage).
 * 2. **Govee reported for this device** — sensors, appliances, the account
 *    push, and the cloud state read. Its word decides in both directions.
 * 3. **Govee delivered something for this device** — a reading, an event, a
 *    capability set, with no word on reachability. Proof, but upward only, and
 *    it loses to a report in either direction. Kept strictly below (2): while
 *    both shared one slot the last writer won, and a packet arriving after a
 *    reported "offline" silently turned it green for half an hour.
 * 4. **Nothing proved anything** — not reachable. That is the honest answer
 *    when there is no evidence, and it is what an unplugged device deserves.
 *
 * `proven` says whether the value was heard or merely absent, so the caller can
 * write a heard value back into the device but never burn an unproven `false`
 * into it — that self-cementing write is what kept a device grey forever once
 * the cache had booted it to offline.
 *
 * The Cloud CHANNEL is deliberately not an input here. That it is up says the
 * adapter can talk to Govee, never that a device is there — 2.29.0 took it as
 * evidence and reported unplugged strips as reachable.
 *
 * Pure — no adapter, no I/O, no clock beyond the injected `now`.
 *
 * @param device The device to judge
 * @param now Current time (ms epoch); injectable for tests
 * @returns The reachability plus whether it rests on evidence, and which source
 *          decided it — see {@link ReachabilityDecision}
 */
export function resolveDeviceReachability(device: GoveeDevice, now: number = Date.now()): ReachabilityDecision {
  if (isLanDriven(device, now)) {
    return {
      online: !!(device.lastLanReplyAt && now - device.lastLanReplyAt < LAN_REPLY_FRESHNESS_MS),
      proven: true,
      decidedBy: "lanReply",
      lastEvidenceAt: device.lastLanReplyAt ?? null,
    };
  }
  // A device behind a gateway can be no more reachable than its gateway — it has
  // no connection of its own to be reachable ON (krobi 2026-09-03). This is a
  // CAP, not a source: a live gateway does not make the device reachable, it
  // only fails to rule it out. The positive proof stays the device's own fresh
  // reading. An unknown gateway caps nothing.
  if (device.state.gatewayOnline === false) {
    return { online: false, proven: true, decidedBy: "gatewayDown", lastEvidenceAt: null };
  }
  if (typeof device.state.cloudReportedOnline === "boolean") {
    const at = device.state.cloudReportedOnlineAt;
    // A report with no timestamp comes from before this rule existed — treat it
    // as expired rather than eternal. The next report re-establishes it within
    // one poll cycle, and an eternal "online" is exactly the bug being fixed.
    if (typeof at === "number" && now - at < CLOUD_ONLINE_EVIDENCE_TTL_MS) {
      return {
        online: device.state.cloudReportedOnline,
        proven: true,
        decidedBy: "cloudReport",
        lastEvidenceAt: at,
      };
    }
  }
  // Weaker than a report, and checked only after it: Govee delivered something
  // for this device without saying whether it is reachable. That payload only
  // exists because the device spoke, so it proves reachability — upward only,
  // and it must never outrank an explicit "offline" (which is why it sits
  // BELOW the branch above, not beside it).
  const liveAt = device.state.cloudLivenessAt;
  if (typeof liveAt === "number" && now - liveAt < CLOUD_ONLINE_EVIDENCE_TTL_MS) {
    return { online: true, proven: true, decidedBy: "cloudLiveness", lastEvidenceAt: liveAt };
  }
  return { online: false, proven: false, decidedBy: "noEvidence", lastEvidenceAt: null };
}

/**
 * Whether this device's reachability is decided by the LOCAL interface alone.
 *
 * True for a light that either has a current LAN address or answered locally
 * within {@link LAN_CAPABLE_MEMORY_MS}. The second half is what makes this
 * survive a restart: `lanIp` is re-discovered by scan, so for one cycle after
 * every start a LAN light looks address-less. Judging it by the cloud in that
 * window is precisely the 2.29.0 false-green (two unplugged strips reported as
 * reachable), which 2.29.1 had to undo.
 *
 * A LAN-driven device ignores every cloud reachability claim, in both
 * directions — Govee's cache lags reality (measured 2026-05-13).
 *
 * @param device Device to classify
 * @param now Current time in ms
 */
export function isLanDriven(device: GoveeDevice, now: number = Date.now()): boolean {
  if (device.type !== GOVEE_DEVICE_TYPE.LIGHT) {
    return false;
  }
  if (device.lanIp) {
    return true;
  }
  return typeof device.lastLanSeenAt === "number" && now - device.lastLanSeenAt < LAN_CAPABLE_MEMORY_MS;
}

/** Protocol limit: Govee's segment bitmask is 7 bytes × 8 bits = 56 slots (0..55). */
export const SEGMENT_HARD_MAX = 55;

/** Number of addressable segment slots (SEGMENT_HARD_MAX + 1 = 56). */
export const SEGMENT_COUNT_MAX = SEGMENT_HARD_MAX + 1;

/**
 * The segment count the state tree is built for: the resolved count
 * ({@link resolveSegmentCount}), grown by a manual index list that reaches
 * beyond it (a user editing `manual_list` can reveal indices the strip never
 * reported), never above what the protocol can address. Pure — the caller
 * (DeviceManager) stores the result on the device; the state-tree writer only
 * reads it.
 *
 * @param device Target device
 * @param registry This instance's device catalog
 */
export function effectiveSegmentCount(device: GoveeDevice, registry: DeviceRegistry): number {
  const resolved = resolveSegmentCount(device, registry);
  const manualMax =
    Array.isArray(device.manualSegments) && device.manualSegments.length > 0
      ? Math.max(...device.manualSegments) + 1
      : 0;
  return Math.min(Math.max(resolved, manualMax), SEGMENT_COUNT_MAX);
}

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

/**
 * Reachability as Govee ITSELF reported it in an account-push packet, or
 * `undefined` when the packet carries no such claim.
 *
 * Measured across all 75 packets from four real user reports (issues
 * #22/#25/#26), two shapes exist and they never mix:
 * - `state.connected` — text "true"/"false". Present in EVERY packet kind of
 *   those devices (status, pt, online), so it is always a valid claim.
 * - `state.result` — number 1/0, but a reachability claim ONLY inside a
 *   `cmd:"online"` packet. In `cmd:"status"` and `cmd:"ptReal"` the very same
 *   field is an operation result code; reading it as reachability there would
 *   turn every command acknowledgement into a liveness claim.
 *
 * Deliberately NOT keyed off `pactType`, although that also separates the two
 * cleanly in the captures: the account list shows devices with `pactType`
 * absent or 0 (H5106, H5125, H5126, H6181, H6110), and keying off it would drop
 * their claim on the floor. The field shapes are unambiguous on their own.
 *
 * Anything unrecognised (`result: 2`, `connected: "unknown"`, missing state)
 * returns `undefined` — no evidence, never a fallback to "reachable". An
 * unproven value must never be written back (the 2.29.1 rule).
 *
 * @param update The parsed account-push packet
 */
export function readReportedReachability(update: MqttStatusUpdate): boolean | undefined {
  const state = update.state;
  if (!state) {
    return undefined;
  }
  if (typeof state.connected === "string") {
    const value = state.connected.trim().toLowerCase();
    return value === "true" ? true : value === "false" ? false : undefined;
  }
  if (update.cmd === "online" && typeof state.result === "number") {
    return state.result === 1 ? true : state.result === 0 ? false : undefined;
  }
  return undefined;
}
