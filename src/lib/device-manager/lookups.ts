import { normalizeDeviceId, type DeviceState, type GoveeDevice, type MqttStatusUpdate } from "../types";
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
   * True when the push carries the device's WHOLE segment list: its AA-A5 run
   * is numbered without a gap from 1 and sits inside a full status report
   * (an `aa 05` frame before it, `aa 11`/`aa 41` after it — every `v_`/`x_`/
   * `a_`/`y_` push in the recordings). Only a complete push may lower a
   * stored count; a lone A5 frame (`u_` push, #49) proves nothing about the end.
   */
  complete: boolean;
  /**
   * True when the count depends on the trailing-slot rule (a last slot
   * `(x,B,B,B)` read as filler) — an OBSERVED pattern (H6076 ×3, H6072 ×1),
   * not a documented one. Such a count may lower a stored one only when an
   * independent reference (the app's snapshot masks) confirms it.
   */
  trailGuess: boolean;
}

/**
 * Highest AA-A5 packet number read: 56 addressable slots in the 3-slot layout
 * need 19 packets. Recordings carry up to 10 (H7020, H6062).
 */
const MAX_AA_A5_PACKETS = 19;

/**
 * Parse AA A5 BLE notification packets from MQTT op.command.
 *
 * Format per slot: [Brightness 0-100] [R] [G] [B], four slots per 20-byte
 * frame. Rules, each measured against every AA-A5 recording in
 * `Ressourcen/govee-smart/github-exports/` (audit 2026-09-24):
 *
 * 1. Packet numbers run past 5 — the H7020 and the H6062 send 10 packets. A
 *    number is read once per push (a repeat is corrupt/malicious, SEC-GC1).
 * 2. Some models fill only three slots per packet: when the fourth slot is
 *    empty in EVERY packet of a push with at least two packets, the layout is
 *    three slots (H61A8, H7020, H6072), index `(packet−1)·3 + slot`. Read as
 *    four slots, a 30-segment H7020 became 19 with a black segment at every
 *    fourth index.
 * 3. Trailing empty slots and slots with an impossible brightness (>100 — the
 *    H6076 pads with 0x92 = 146) are filler.
 * 4. A last slot `(x,B,B,B)` whose colour bytes equal the brightness of the
 *    segment before it, while its own brightness differs, is filler — seen on
 *    the H6076 (`02 64 64 64`, `00 32 32 32`; confirmed by the app's snapshot
 *    mask `7f` = 7) and the H6072. Flagged as {@link ParsedMqttSegments.trailGuess}.
 * 5. Completeness: see {@link ParsedMqttSegments.complete}.
 *
 * @param commands Base64-encoded BLE packets from MQTT op.command
 */
export function parseMqttSegmentData(commands: string[]): ParsedMqttSegments {
  if (!Array.isArray(commands)) {
    return { segments: [], complete: false, trailGuess: false };
  }

  // Valid 20-byte frames in push order. Dedupe AA-A5 by packet number and bound
  // the scan so a malicious broker can't send a huge `op.command` array and
  // blow the segment list up into ~80k setState writes (SEC-GC1).
  const frames: Buffer[] = [];
  const packets = new Map<number, Buffer>();
  const packetPos: number[] = [];
  const MAX_SCAN = 512;
  let scanned = 0;
  for (const cmd of commands) {
    if (scanned >= MAX_SCAN) {
      break;
    }
    scanned++;
    if (typeof cmd !== "string") {
      continue;
    }
    const bytes = Buffer.from(cmd, "base64");
    if (bytes.length < 20) {
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
    frames.push(bytes);
    if (bytes[0] !== 0xaa || bytes[1] !== 0xa5) {
      continue;
    }
    const packetNum = bytes[2];
    if (packetNum < 1 || packetNum > MAX_AA_A5_PACKETS || packets.has(packetNum)) {
      continue;
    }
    packets.set(packetNum, bytes);
    packetPos.push(frames.length - 1);
  }
  if (packets.size === 0) {
    return { segments: [], complete: false, trailGuess: false };
  }

  const numbers = [...packets.keys()].sort((x, y) => x - y);
  const emptyFourth = (p: Buffer): boolean => p[15] === 0 && p[16] === 0 && p[17] === 0 && p[18] === 0;
  const slotsPerPacket = numbers.length >= 2 && numbers.every(n => emptyFourth(packets.get(n)!)) ? 3 : 4;

  const segments: MqttSegmentData[] = [];
  for (const n of numbers) {
    const bytes = packets.get(n)!;
    for (let slot = 0; slot < slotsPerPacket; slot++) {
      const offset = 3 + slot * 4;
      segments.push({
        index: (n - 1) * slotsPerPacket + slot,
        brightness: bytes[offset],
        r: bytes[offset + 1],
        g: bytes[offset + 2],
        b: bytes[offset + 3],
      });
    }
  }

  let trailGuess = false;
  while (segments.length > 0) {
    const tail = segments[segments.length - 1];
    const allZero = tail.brightness === 0 && tail.r === 0 && tail.g === 0 && tail.b === 0;
    if (allZero || tail.brightness > 100) {
      segments.pop();
      continue;
    }
    const before = segments.length >= 2 ? segments[segments.length - 2] : undefined;
    if (
      before &&
      tail.r === tail.g &&
      tail.g === tail.b &&
      tail.r === before.brightness &&
      tail.brightness !== before.brightness
    ) {
      segments.pop();
      trailGuess = true;
      continue;
    }
    break;
  }

  const gapless = numbers.every((n, i) => n === i + 1);
  const firstPos = Math.min(...packetPos);
  const lastPos = Math.max(...packetPos);
  const statusBefore = frames.slice(0, firstPos).some(f => f[0] === 0xaa && f[1] === 0x05);
  const statusAfter = frames.slice(lastPos + 1).some(f => f[0] === 0xaa && (f[1] === 0x11 || f[1] === 0x41));
  return { segments, complete: gapless && statusBefore && statusAfter, trailGuess };
}

/**
 * The segment count the app's own snapshots address — an independent
 * reference for a count read from an AA-A5 push. Decodes the `33 05 15 01`
 * frames (`RR GG BB`, five bytes, then the 7-byte segment mask in bytes 12-18,
 * least significant bit first — the layout `buildSegmentBitmask` writes) and
 * returns the highest addressed segment + 1 over all snapshots; `null` when no
 * snapshot carries such a frame (other sub-commands, e.g. the H1310's `03`/`04`,
 * are not decoded — their layout is not known).
 *
 * Measured on the recordings: H6076 7 (mask `7f`), H61E5 9 (`ff 01`),
 * H1741 8 (`ff 00`) — each equal to the model's AA-A5 count.
 *
 * @param snapshotBleCmds Snapshot BLE packets (per snapshot, per command group)
 */
export function segmentCountFromSnapshotFrames(snapshotBleCmds: unknown): number | null {
  if (!Array.isArray(snapshotBleCmds)) {
    return null;
  }
  let highest = -1;
  for (const snapshot of snapshotBleCmds) {
    for (const group of Array.isArray(snapshot) ? snapshot : []) {
      for (const frame of Array.isArray(group) ? group : []) {
        if (typeof frame !== "string") {
          continue;
        }
        const b = Buffer.from(frame, "base64");
        if (b.length !== 20 || b[0] !== 0x33 || b[1] !== 0x05 || b[2] !== 0x15 || b[3] !== 0x01) {
          continue;
        }
        for (let i = 0; i < 7; i++) {
          for (let bit = 0; bit < 8; bit++) {
            if ((b[12 + i] >> bit) & 1) {
              highest = Math.max(highest, i * 8 + bit);
            }
          }
        }
      }
    }
  }
  return highest >= 0 ? highest + 1 : null;
}

/** Where a device's segment count comes from — see {@link resolveSegmentCountWithSource}. */
export type SegmentCountSource = "quirk" | "learned" | "cloudCapability" | "none";

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
  return resolveSegmentCountWithSource(device, registry).count;
}

/**
 * {@link resolveSegmentCount} together with the source that settled it. The
 * diagnostics report names the source from THIS answer — it used to re-derive
 * it with its own copy of the priority, without the plausibility gate, and
 * reported "cloud capability" next to a count of 0.
 *
 * @param device Target device
 * @param registry This instance's device catalog (segmentCount quirk lookup)
 */
export function resolveSegmentCountWithSource(
  device: GoveeDevice,
  registry: DeviceRegistry,
): { count: number; source: SegmentCountSource } {
  // A segmentCount quirk is a hard override — Govee's capability count lies for
  // some SKUs; this wins over Cloud, cache and the live MQTT value.
  const override = plausibleSegmentCount(registry.getQuirks(device.sku)?.segmentCount);
  if (override !== undefined) {
    return { count: override, source: "quirk" };
  }
  const stored = plausibleSegmentCount(device.segmentCount);
  if (stored !== undefined) {
    return { count: stored, source: "learned" };
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
  return Number.isFinite(min) ? { count: min, source: "cloudCapability" } : { count: 0, source: "none" };
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

/** Govee transaction ids look like `x_1788603714892008`: 13 digits of epoch ms, then a counter. */
const TRANSACTION_STAMP = /^[a-z]_(\d{13})\d*$/i;
/** A stamp further ahead than this is a clock we do not trust — arrival time it is. */
const FUTURE_STAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * When the device itself spoke, according to a status push. Only a `status`
 * packet with a state is the device's own voice; Govee's `online` packet is
 * Govee talking ABOUT the device and goes through `readReportedReachability`.
 *
 * Without a parseable stamp there is NO answer — deliberately not the arrival
 * time: the broker replays retained messages on every reconnect, and an
 * arrival-dated replay would arm a 30-minute shield for a device that may be
 * unplugged (advisor 2026-09-08). A packet that cannot date itself keeps the
 * old rule, where the next poll decides within two minutes.
 *
 * @param update the decoded push
 * @param now arrival time
 * @returns the packet's own stamp, or undefined when it has none or this is not the device speaking
 */
export function readDevicePushAt(update: MqttStatusUpdate, now: number): number | undefined {
  if (update.cmd !== "status" || !update.state) {
    return undefined;
  }
  const match = typeof update.transaction === "string" ? TRANSACTION_STAMP.exec(update.transaction) : null;
  if (!match) {
    return undefined;
  }
  const stamp = Number(match[1]);
  return Number.isFinite(stamp) && stamp <= now + FUTURE_STAMP_TOLERANCE_MS ? stamp : undefined;
}

/**
 * Whether the device's own last push is still inside the evidence window.
 *
 * @param state the device state carrying `devicePushAt`
 * @param now the moment to judge from
 */
export function isDevicePushFresh(state: Pick<DeviceState, "devicePushAt">, now: number): boolean {
  return typeof state.devicePushAt === "number" && now - state.devicePushAt < CLOUD_ONLINE_EVIDENCE_TTL_MS;
}
