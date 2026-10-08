import { HttpError } from "./http-client";
import { Placeholders } from "./diagnostics/placeholders";
import type { LogLine, LogRing } from "./diagnostics/log-ring";
import { ByteRing } from "./diagnostics/byte-ring";
import { pseudonymiseReport } from "./report-placeholders";
import type { DeviceRegistry } from "./device-registry";
import { errText, type GoveeDevice } from "./types";
import { GOVEE_DEVICE_TYPE, isAppGroup } from "./govee-constants";
import {
  effectiveSegmentCount,
  isLanDriven,
  resolveDeviceReachability,
  resolveSegmentCount,
  resolveSegmentCountWithSource,
} from "./device-manager/lookups";
import { CLOUD_REACHABILITY_REFRESH_MS, STATUS_REQUEST_INTERVAL_MS } from "./timing-constants";
import { applianceBudget, type RateLimiterSnapshot } from "./rate-limiter";
import type { GoveeRateLimit } from "./govee-cloud-client";

/** Single log line captured for a device. */
export interface LogEntry {
  /** ISO timestamp */
  ts: string;
  /** ioBroker log level */
  level: "debug" | "info" | "warn" | "error";
  /** Free-form log message */
  msg: string;
}

/** A captured MQTT packet (op.command-array hex-joined or raw JSON payload). */
export interface MqttPacketEntry {
  /** When it arrived last (ISO time) — the ring folds the same packet into one entry (fleet R1). */
  ts: string;
  /** When the same packet arrived first (ISO time). */
  first?: string;
  /** How often the same packet arrived. */
  count?: number;
  /** Its kind: `status`, `online`, `ptReal`, `events` or `other` — each kind has its own ring (plan G3). */
  kind?: string;
  /** AWS-IoT account topic or Cloud-events topic the packet arrived on */
  topic: string;
  /** Hex-encoded BLE bytes (lowercase, space-separated) — set for AWS-IoT op.command entries. */
  hex?: string;
  /** Raw JSON envelope around the message — captured so state-correlation isn't lost. */
  rawJson?: string;
  /** A payload over the size limit keeps only its size — whole or nothing, never cut (fleet R3). */
  omittedBytes?: number;
}

/** One captured API call (success or failure) for a Cloud / App-API endpoint. */
export interface ApiResponseEntry {
  /** ISO timestamp */
  ts: string;
  /** Endpoint identifier (e.g. "/router/api/v1/device/state") */
  endpoint: string;
  /** True = body holds the parsed response. False = body holds `{ error, status, responseBody }`. */
  ok: boolean;
  /** HTTP status code if known. Useful for failed calls (e.g. 403 from /light-effect-libraries). */
  statusCode?: number;
  /** Response body on success. On failure: `{ error, status?, responseBody? }`. */
  body: unknown;
  /** Serialised size of `body` — what this entry costs against the per-device byte budget. */
  bytes: number;
  /**
   * Govee's rate-limit headers on this answer (2.39.0) — the measurement the
   * daily numbers of the budget wait for; absent when the answer carried none.
   */
  rateLimit?: GoveeRateLimit;
}

/**
 * Outgoing LAN UDP datagram entry — captures ptReal / colorwc / brightness /
 * turn sends so the diag-reader can see exactly what the adapter pushed onto
 * the wire for a device. Recorded per-device because LAN-traffic is device-IP-
 * keyed.
 */
export interface LanSendEntry {
  /** ISO timestamp */
  ts: string;
  /** Destination IP address */
  ip: string;
  /** Datagram type — "ptReal", "turn", "brightness", "colorwc", "devStatus" */
  cmd: string;
  /** Outgoing packet payloads — Base64 BLE strings for ptReal, JSON-serialised data otherwise */
  payload: unknown;
  /** Datagram size in bytes (for PMTU-debug). */
  bytes?: number;
  /** Send-error string if the socket reported one. */
  error?: string;
}

/**
 * Snapshot of the adapter's process-wide runtime state captured at
 * generate-time. Provided by an optional provider callback wired in main.ts
 * so the DiagnosticsCollector itself stays decoupled from the adapter class.
 */
export interface RuntimeStateSnapshot {
  /** DeviceManager.lastErrorCategory (Cloud-Device-List path). */
  deviceManagerLastErrorCategory?: string | null;
  /** DeviceManager.lastAppApiErrorCategory (App-API poll path). */
  appApiLastErrorCategory?: string | null;
  /** DeviceManager.lastGroupMembersErrorCategory (App-API groups path). */
  groupMembersLastErrorCategory?: string | null;
  /** GoveeCloudClient.getFailureReason() — user-facing reason for "Cloud not connected". */
  cloudFailureReason?: string | null;
  /** GoveeMqttClient.getFailureReason() — user-facing reason for "MQTT not connected". */
  mqttFailureReason?: string | null;
  /** Rate-limiter usage snapshot or null if no Cloud client. Shape mirrors RateLimiter.getUsageSnapshot(). */
  rateLimiter?: RateLimiterSnapshot | null;
  /** The newest rate-limit headers Govee sent (GoveeCloudClient.getLastRateLimit), null before the first. */
  cloudRateLimit?: GoveeRateLimit | null;
  /** Live wizard session if any — captured for "wizard ran during diag-click" forensics. */
  wizardSession?: unknown;
  /** LAN client's `seenDeviceIps` set as `["sku-id:ip", ...]` — discovery trace. */
  lanSeenDeviceIps?: string[];
}

/**
 * One account-level call (login / IoT key) as the report shows it. Never
 * carries credentials — see {@link DiagnosticsCollector.recordAccountCall}.
 */
export interface AccountCallEntry {
  /** ISO timestamp */
  ts: string;
  /** Which call — the login or the IoT-key request. */
  endpoint: string;
  /** Whether Govee accepted it. */
  ok: boolean;
  /** Govee's status — its payload status where it has one, else HTTP. */
  statusCode?: number;
  /** Govee's own message ("please login", "Incorrect user name or password"). */
  message?: string;
  /** When the same outcome was seen last — only set once it repeated. */
  lastTs?: string;
  /** How often this exact outcome occurred; absent means once. */
  count?: number;
}

/**
 * What a user-triggered command did. `lanSends` shows what went out on the
 * wire, but not whether the write was accepted and not what the device
 * reported back — so for "switching does not work" the chain broke off exactly
 * where the answer would be.
 */
export interface CommandResultEntry {
  /** ISO timestamp */
  ts: string;
  /** The state the user wrote, below the device prefix (e.g. "control.power"). */
  stateId: string;
  /** The value that was written. */
  value: unknown;
  /** Which channel carried it — "lan", "cloud", "ptReal", … */
  transport: string;
  /** Whether the command was accepted. */
  ok: boolean;
  /** Failure reason when it was not. */
  error?: string;
}

/** A device's buffers frozen before a report's live read (see `DiagnosticsCollector.freeze`). */
export interface FrozenBuffers {
  /** Activity log lines. */
  logs: LogEntry[];
  /** Captured MQTT packets, flattened from the rings, oldest first. */
  packets: MqttPacketEntry[];
  /** API history per endpoint. */
  responses: Record<string, ApiResponseEntry[]>;
  /** Outgoing LAN datagrams. */
  lanSends: LanSendEntry[];
  /** Results of user commands. */
  commandResults: CommandResultEntry[];
  /** The account-wide login and IoT-key calls. */
  accountCalls: AccountCallEntry[];
  /** The adapter's log lines about this device, at every level. */
  adapterLog: LogLine[];
  /** The device's LAN scan replies, counted. */
  lanReplies: LanReplyEntry[];
  /** Every change of the shown reachability. */
  reachabilityHistory: ReachabilityChangeEntry[];
  /** The packets no client could read. */
  unreadablePackets: UnreadableEntry[];
}

/** One packet a client could not read (plan G5) — account-wide, the sender is not always a known device. */
export interface UnreadableEntry {
  /** When it arrived (ISO time). */
  ts: string;
  /** Which client: `account-broker`, `lan` or `openapi-events`. */
  source: string;
  /** Where it came from: a topic or an address. */
  from: string;
  /** Why it could not be read. */
  reason: string;
  /** The packet as it arrived — absent when over the size limit (whole or nothing, fleet R3). */
  raw?: string;
  /** The size of a packet over the limit. */
  omittedBytes?: number;
}

/** How many unreadable packets the report keeps, account-wide. */
const MAX_UNREADABLE = 30;

/** How many addresses a device's LAN replies are kept for — the newest. */
const MAX_LAN_REPLY_ADDRESSES = 8;

/** One change of a device's shown reachability (plan G4). */
export interface ReachabilityChangeEntry {
  /** When it changed (ISO time). */
  ts: string;
  /** What `info.online` shows now. */
  online: boolean;
  /** What it showed before — null for the first value of the run. */
  was: boolean | null;
  /** The source that decided it (`resolveDeviceReachability`). */
  decidedBy: string;
  /** The time of the evidence it rests on (ISO), null without one. */
  lastEvidenceAt: string | null;
}

/** How many reachability changes a device keeps. */
const MAX_REACHABILITY_CHANGES = 50;

/** One address a device answered the LAN scan from — counted, first and last time kept (fleet R1). */
export interface LanReplyEntry {
  /** The address it answered from. */
  ip: string;
  /** The model it named. */
  sku: string;
  /** First reply (ISO time). */
  first: string;
  /** Last reply (ISO time). */
  last: string;
  /** How many replies. */
  count: number;
}

/** Which strings name a device in a log line, and which name the other devices. */
export interface LogMentions {
  /** The device's own id, name and address. */
  mine: string[];
  /** The ids, names and addresses of every other device. */
  others: string[];
}

/** Per-device ring buffers. */
interface DeviceBuffers {
  logs: LogEntry[];
  /** MQTT packets per kind (plan G3): the same packet is counted, each kind keeps its own byte budget. */
  packets: Map<string, ByteRing<Omit<MqttPacketEntry, "ts" | "first" | "count">>>;
  /**
   * Per-endpoint history (most-recent at the end). Keeping multiple slots
   * is essential for diagnosing "the first call returned X, the refresh
   * call returned Y" cases — the single-slot design lost that timeline.
   */
  responses: Map<string, ApiResponseEntry[]>;
  /** Running total of `bytes` over every entry in `responses` — kept under {@link MAX_RESPONSE_BYTES_PER_DEVICE}. */
  responseBytes: number;
  /** Outgoing LAN datagrams — bounded ring buffer, see {@link MAX_LAN_SENDS}. */
  lanSends: LanSendEntry[];
  /** Outcomes of user-triggered commands — bounded, see {@link MAX_COMMAND_RESULTS}. */
  commandResults: CommandResultEntry[];
}

/**
 * Buffer sizes — raised in v2.9.1 so debug captures actually survive longer
 * Govee outages and Multi-Segment-Echo (~5 AA-A5-Pakete pro Status-Push).
 * Old sizes (20/10/3/12) were tuned for sparse Cloud-only debugging; the v2.9.1
 * Coverage-Welle adds LAN sends + MQTT raw envelopes + per-fetch raw bodies
 * → previous caps would evict the first interesting frames before a user could
 * ask for a report.
 *
 * Entry COUNTS alone bound nothing useful: 24 endpoints × 6 slots × 64 KB plus
 * 50 packets × 64 KB is well over 10 MB per device in theory, and a light with
 * a 64 KB scene library and a 60 KB scene list re-fetched a few times really did
 * sit at a megabyte for the lifetime of the process. Three byte caps keep the
 * collector at a size a Raspberry Pi can carry for thirty devices:
 * {@link MAX_RESPONSE_BYTES_PER_DEVICE} (oldest entries across all endpoints go
 * first), {@link MAX_PACKET_RAW_BYTES} per MQTT envelope and
 * {@link MAX_LAN_SEND_BYTES} per outgoing datagram payload.
 */
const MAX_LOGS = 100;
const MAX_RESPONSE_ENDPOINTS = 24;
const MAX_RESPONSES_PER_ENDPOINT = 6;
const MAX_LAN_SENDS = 30;
/** Recent command outcomes kept per device — enough to cover a user trying the same switch a few times. */
const MAX_COMMAND_RESULTS = 30;
/** Account-level calls kept — login + IoT key, a handful of attempts is plenty. */
const MAX_ACCOUNT_CALLS = 10;
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES_PER_DEVICE = 512 * 1024;
const MAX_PACKET_RAW_BYTES = 4_096;
const MAX_LAN_SEND_BYTES = 16_384;

/**
 * Whole or nothing (fleet R3): a captured text over the limit keeps only its size. A cut text could carry half of a
 * personal value that no placeholder pattern recognises any more — and the placeholders run when the report is made.
 *
 * @param text Captured text
 * @param max Size limit in characters
 * @returns The text, or undefined when it is over the limit
 */
function wholeOrNothing(text: string, max: number): string | undefined {
  return text.length > max ? undefined : text;
}

/** Each kind of MQTT packet keeps up to this many bytes per device (plan G3: 128 KB over four kinds). */
const MQTT_RING_BYTES = 32 * 1024;

/** One packet entry up to this size keeps its content; a larger one only its size (fleet R3). */
const MQTT_ENTRY_BYTES = 2 * MAX_PACKET_RAW_BYTES + 256;

/** The transaction stamp of a Govee envelope — it differs on every packet and makes no packet another one. */
const TRANSACTION_RE = /\\?"transaction\\?"\s*:\s*\\?"[^"\\]*\\?"/g;

/**
 * The kind of an MQTT packet: the OpenAPI events, or the account broker's `cmd` (`status`, `online`, `ptReal`).
 *
 * @param topic The topic it came on
 * @param rawJson The envelope, when there is one
 * @param hex The BLE frames, when there are any
 */
function packetKind(topic: string, rawJson?: string, hex?: string): string {
  if (topic === "openapi-events") {
    return "events";
  }
  try {
    const parsed = rawJson ? (JSON.parse(rawJson) as { cmd?: unknown; msg?: { cmd?: unknown } }) : undefined;
    const cmd = parsed?.cmd ?? parsed?.msg?.cmd;
    if (cmd === "status" || cmd === "online" || cmd === "ptReal") {
      return cmd;
    }
  } catch {
    // not JSON — the kind stays open
  }
  return hex && !rawJson ? "status" : "other";
}

/**
 * The packets of all kinds as one list, oldest first.
 *
 * @param rings The device's rings
 */
function packetView(rings?: Map<string, ByteRing<Omit<MqttPacketEntry, "ts" | "first" | "count">>>): MqttPacketEntry[] {
  return [...(rings?.values() ?? [])]
    .flatMap(ring =>
      ring.snapshot().map(e => ({
        ...(e.content ?? {}),
        ...(e.omittedBytes !== undefined ? { omittedBytes: e.omittedBytes } : {}),
        topic: e.content?.topic ?? "",
        ts: e.last,
        first: e.first,
        count: e.count,
      })),
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Object keys whose values are secrets and must never reach the diagnostics
 * export — the adapter asks users to attach that JSON to public GitHub
 * issues. Matched case-insensitively. `topic` covers the gateway push topic
 * (`GD/<hash>`); non-secret device metadata (bleName, MAC address) is kept.
 */
const SENSITIVE_KEYS = new Set([
  "secretcode",
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "bearer",
  "topic",
  // Settings of a device someone shared with this account — the other
  // account's data, never needed to support a model.
  "sharedsettings",
]);

/**
 * Recursively replace the values of {@link SENSITIVE_KEYS} with `"***"` on an
 * already-cloned structure (mutates in place). Keys come from JSON.parse'd
 * data, so a literal `__proto__` own-property assignment is harmless (own
 * property, not the prototype).
 *
 * @param value A freshly-cloned value that is safe to mutate
 */
function redactSecretsInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      redactSecretsInPlace(item);
    }
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        obj[key] = "***";
      } else {
        redactSecretsInPlace(obj[key]);
      }
    }
  }
}

/**
 * Provider callback shape — see {@link RuntimeStateSnapshot}. Returning
 * `undefined` is fine, generate() just omits the field then.
 */
export type RuntimeStateProvider = () => RuntimeStateSnapshot;

/**
 * Cache-snapshot provider — returns the persisted-on-disk view of a single
 * device's cache file so the diag-reader can compare runtime state to what
 * would be reloaded on a restart. Provider returns null when no cache entry
 * exists for the device. Body shape is provider-specific (CachedDeviceData
 * from SkuCache or similar) — DiagnosticsCollector clones-and-caps it.
 */
export type CacheSnapshotProvider = (sku: string, deviceId: string) => unknown;

/**
 * Local-snapshot list provider — returns the on-disk LocalSnapshot entries
 * (incl. per-segment colour data) for a single device. Body shape stays
 * provider-specific so the LocalSnapshotStore file format can evolve.
 */
export type LocalSnapshotsProvider = (sku: string, deviceId: string) => unknown[];

/**
 * The ioBroker side of the installation: versions, host, whether the instance
 * shares a process, and which credential tier is configured. Every one of these
 * used to be a follow-up question on a bug report — and the issue forms dropped
 * their Node field on 2026-09-02 precisely because it belongs in here.
 */
export interface EnvironmentSnapshot {
  /** Node.js version the adapter runs on. */
  node?: string;
  /** js-controller version. */
  jsController?: string;
  /** Admin adapter version. */
  admin?: string;
  /** Host platform, e.g. "linux x64". */
  platform?: string;
  /** Whether this instance shares a process with others (compact mode). */
  compactMode?: boolean;
  /**
   * Configured credential tier — "lan" (nothing entered), "apiKey", or
   * "account". Never the credentials themselves; the tier alone explains why a
   * channel is missing.
   */
  credentialTier?: "lan" | "apiKey" | "account";
  /** Total devices the adapter manages. */
  deviceCount?: number;
  /** How many of those are currently reachable. */
  reachableCount?: number;
  /** Per-channel status as the ready summary shows it. */
  channels?: Record<string, string>;
  /**
   * When this adapter run started (ISO). Every timeline in a report — the
   * start-up calls, a push that came late, a queue that drained — is read
   * against it, and it used to be reconstructed from the oldest API entry.
   */
  startedAt?: string;
}

/** Environment provider — see {@link EnvironmentSnapshot}. */
export type EnvironmentProvider = () => EnvironmentSnapshot;

/**
 * How ONE writable datapoint of this device is actually driven.
 *
 * This is the question the report exists for: adding a stranger's device means
 * knowing which datapoint is reached over which channel, and why. The report
 * carried the capability list and the object tree — the two ends — but never
 * the routing between them, so "why does this control do nothing on my model"
 * could not be answered from a report alone.
 */
export interface ControlPathEntry {
  /** The datapoint below the device prefix, e.g. "control.power". */
  stateId: string;
  /** The command it maps to, e.g. "power", "segmentColor:3". */
  command: string;
  /** Which channel a write would take — "lan", "cloud", or "skip" (nothing would happen). */
  transport: string;
  /** WHY that channel: "default", "override" (a quirk forces it), "no-lan", … */
  reason: string;
}

/**
 * Control-path provider — resolves the routing for this device's writable
 * datapoints. Pure decision-making, no I/O: it asks the same function a real
 * write would ask.
 */
export type ControlPathProvider = (device: GoveeDevice, stateIds: string[]) => ControlPathEntry[];

/**
 * The device's datapoints as they actually exist in the object tree, with type,
 * role, unit and current value. The report otherwise shows only the adapter's
 * in-memory view, which is no help at all for the most common report class:
 * "this datapoint is missing / has the wrong type / the wrong role".
 *
 * Scoped to ONE device prefix — never a full-instance scan, which is exactly
 * the per-round tree walk removed in 2.27.1.
 */
export type ObjectTreeProvider = (prefix: string) => Promise<ObjectTreeEntry[]>;

/** One datapoint as the object tree holds it. */
export interface ObjectTreeEntry {
  /** State id below the device prefix, e.g. "control.power". */
  id: string;
  /** Declared common.type. */
  type?: string;
  /** Declared common.role. */
  role?: string;
  /** Declared unit, when the state has one. */
  unit?: string;
  /** Whether the state is writable. */
  write?: boolean;
  /** Current value. */
  val?: unknown;
  /** Whether the value is acknowledged. */
  ack?: boolean;
}

/**
 * Append to a bounded ring-buffer array — pushes `entry`, then drops the
 * oldest entries so the array never exceeds `max`.
 *
 * @param arr Target array (mutated in place)
 * @param entry Entry to append
 * @param max Maximum retained length
 */
function pushBounded<T>(arr: T[], entry: T, max: number): void {
  arr.push(entry);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

/**
 * Serialised size of a stored body — the unit the per-device byte budget is
 * kept in. Non-serialisable values were already turned into strings by
 * cloneAndCap; anything else counts as zero rather than throwing.
 *
 * @param value Stored body
 */
function byteSize(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Collects diagnostic context per device and produces the report JSON that
 * the admin card hands to the browser. Replaces the inline
 * `device-manager.generateDiagnostics()` so log/MQTT/API hooks can write
 * data without coupling to DeviceManager.
 *
 * Buffers are bounded — the collector survives long-running adapters
 * without unbounded memory growth.
 */
export class DiagnosticsCollector {
  private readonly buffers = new Map<string, DeviceBuffers>();
  /**
   * One pseudonymiser for the whole adapter run, so a marker means the same
   * thing in every buffer and in every report exported from this run.
   */
  /**
   * Every device name currently known, for replacing them inside free text.
   * A name has no detectable shape, so unlike an address it cannot be found by
   * pattern — it has to be looked up. Provider rather than a stored list so a
   * renamed device is picked up without the collector tracking the account.
   */
  private deviceNamesProvider: (() => string[]) | null = null;
  /** Every device id currently known — see {@link setDeviceIdsProvider}. */
  private deviceIdsProvider: (() => string[]) | null = null;
  private runtimeStateProvider: RuntimeStateProvider | null = null;
  private cacheSnapshotProvider: CacheSnapshotProvider | null = null;
  private localSnapshotsProvider: LocalSnapshotsProvider | null = null;
  private environmentProvider: EnvironmentProvider | null = null;
  /** Control-path provider — see {@link ControlPathProvider}. */
  private controlPathProvider: ControlPathProvider | null = null;
  /** Account-level call outcomes (login, IoT key) — see {@link recordAccountCall}. */
  private readonly accountCalls: AccountCallEntry[] = [];
  /** The adapter's log at every level (fleet master `log-ring.ts`, plan G2) — wired by main.ts at the start. */
  private logRing: LogRing | null = null;
  /** LAN scan replies per device (plan G1) — counted instead of one log line each. */
  private readonly lanReplies = new Map<string, Map<string, LanReplyEntry>>();
  /** Reachability changes per device (plan G4). */
  private readonly reachability = new Map<string, ReachabilityChangeEntry[]>();
  /** Packets no client could read (plan G5), account-wide. */
  private readonly unreadable: UnreadableEntry[] = [];
  private objectTreeProvider: ObjectTreeProvider | null = null;

  /** @param registry This instance's device catalog — the export shows the quirks active for the SKU */
  constructor(private readonly registry: DeviceRegistry) {}

  /**
   * Wire the list of known device names, so the pseudonymiser can replace them
   * inside free text — a name has no detectable shape.
   *
   * @param provider Returns every device name known right now, or null to clear
   */
  setDeviceNamesProvider(provider: (() => string[]) | null): void {
    this.deviceNamesProvider = provider;
  }

  /** Every device name known right now; empty when nothing is wired yet. */
  private deviceNames(): string[] {
    try {
      return this.deviceNamesProvider?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Wire the list of known device ids. Only the digit ones matter to the
   * pseudonymiser: a group's id has no detectable shape, so like a name it is
   * replaced by lookup — in log lines, object ids and API bodies alike.
   *
   * @param provider Returns every device id known right now, or null to clear
   */
  setDeviceIdsProvider(provider: (() => string[]) | null): void {
    this.deviceIdsProvider = provider;
  }

  /** Every known device id made of digits only (the groups); empty when nothing is wired. */
  private digitDeviceIds(): string[] {
    try {
      return (this.deviceIdsProvider?.() ?? []).filter(id => typeof id === "string" && /^\d+$/.test(id));
    } catch {
      return [];
    }
  }

  /**
   * Wire the ioBroker-side snapshot (versions, host, credential tier, totals).
   *
   * @param provider Returns the environment, or null to clear
   */
  setEnvironmentProvider(provider: EnvironmentProvider | null): void {
    this.environmentProvider = provider;
  }

  /**
   * Wire the control-path resolver — the routing between a datapoint and the
   * channel that would carry a write to it.
   *
   * @param provider Resolves the routing, or null to clear
   */
  setControlPathProvider(provider: ControlPathProvider | null): void {
    this.controlPathProvider = provider;
  }

  /**
   * Wire the object-tree reader. Scoped to one device prefix by contract —
   * a full-instance scan is exactly what 2.27.1 removed from the hot path.
   *
   * @param provider Reads the datapoints below one device prefix
   */
  setObjectTreeProvider(provider: ObjectTreeProvider | null): void {
    this.objectTreeProvider = provider;
  }

  /**
   * Record the outcome of an ACCOUNT-level call — the login and the IoT-key
   * request. Both were invisible in the report, although two filed issues are
   * exactly about them ("email not registered", "too many logins — account
   * blocked"): the report showed a dead push channel and no reason.
   *
   * Carries NO credentials. Endpoint, verdict, status code and Govee's own
   * message are what tell the cases apart; the report's placeholders replace
   * whatever personal the message names when the report is made.
   *
   * Account-wide rather than per-device: these two calls belong to the account,
   * not to a device, and every device's report needs to show them.
   *
   * @param endpoint Which of the two calls
   * @param ok Whether Govee accepted it
   * @param statusCode Govee's status (its own payload status, not just HTTP)
   * @param message Govee's own message, if any
   */
  recordAccountCall(endpoint: string, ok: boolean, statusCode?: number, message?: string): void {
    if (typeof endpoint !== "string" || !endpoint) {
      return;
    }
    const text = message ? String(message) : undefined;
    // A rejected login REPEATS — the client retries, and the 24 h lockout in
    // issue #39 came from exactly that loop. A plain ring buffer would fill with
    // ten identical entries and push out the FIRST one, which is the one that
    // says when it started. So an identical outcome folds into the existing
    // entry: first seen, last seen, how often.
    const same = this.accountCalls.find(
      e => e.endpoint === endpoint && e.ok === (ok === true) && e.statusCode === statusCode && e.message === text,
    );
    if (same) {
      same.lastTs = new Date().toISOString();
      same.count = (same.count ?? 1) + 1;
      return;
    }
    pushBounded(
      this.accountCalls,
      {
        ts: new Date().toISOString(),
        endpoint,
        ok: ok === true,
        ...(typeof statusCode === "number" ? { statusCode } : {}),
        ...(text ? { message: text } : {}),
      },
      MAX_ACCOUNT_CALLS,
    );
  }

  /**
   * Record what a user-triggered command actually did. Closes the gap between
   * "the adapter sent something" and "the device did something": `lanSends`
   * ends at the wire, this says whether the write was accepted and why not.
   *
   * @param deviceId Govee device id
   * @param entry What was written, over which channel, and how it went
   */
  recordCommandResult(deviceId: string, entry: Omit<CommandResultEntry, "ts">): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    pushBounded(
      this.get(deviceId).commandResults,
      {
        ts: new Date().toISOString(),
        stateId: String(entry.stateId),
        value: this.cloneAndCap(entry.value),
        transport: String(entry.transport),
        ok: entry.ok === true,
        ...(entry.error ? { error: String(entry.error) } : {}),
      },
      MAX_COMMAND_RESULTS,
    );
  }

  /**
   * Wire the process-wide runtime snapshot pulled at export time.
   *
   * @param provider Returns the runtime state, or null to clear
   */
  setRuntimeStateProvider(provider: RuntimeStateProvider | null): void {
    this.runtimeStateProvider = provider;
  }

  /**
   * Register the cache-snapshot provider. main.ts wires SkuCache.loadOne
   * so generate() can render the on-disk view of the cache without giving
   * the DiagnosticsCollector a direct dependency on SkuCache.
   *
   * @param provider Callback returning the cached entry (or null) for one device
   */
  setCacheSnapshotProvider(provider: CacheSnapshotProvider | null): void {
    this.cacheSnapshotProvider = provider;
  }

  /**
   * Register the local-snapshot provider. Wired to LocalSnapshotStore so
   * the diag includes user-saved snapshot definitions (per-segment colours
   * are useful for "user-saved snapshot looks wrong after restore" reports).
   *
   * @param provider Callback returning local snapshot entries for one device
   */
  setLocalSnapshotsProvider(provider: LocalSnapshotsProvider | null): void {
    this.localSnapshotsProvider = provider;
  }

  /**
   * Lazily initialise the ring buffers for a device id.
   *
   * @param deviceId Govee device id (the buffer key)
   */
  private get(deviceId: string): DeviceBuffers {
    let b = this.buffers.get(deviceId);
    if (!b) {
      b = { logs: [], packets: new Map(), responses: new Map(), responseBytes: 0, lanSends: [], commandResults: [] };
      this.buffers.set(deviceId, b);
    }
    return b;
  }

  /**
   * Append a log line for a device. Drops the oldest entry once the
   * buffer reaches MAX_LOGS.
   *
   * @param deviceId Govee device id
   * @param level ioBroker log level
   * @param msg Log message
   */
  addLog(deviceId: string, level: LogEntry["level"], msg: string): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof msg !== "string") {
      return;
    }
    pushBounded(this.get(deviceId).logs, { ts: new Date().toISOString(), level, msg }, MAX_LOGS);
  }

  /**
   * Append an MQTT packet for a device — into the ring of its kind, the same packet counted (plan G3).
   * `hex` (BLE-payload) and `rawJson` (envelope) are optional and stored as
   * provided — callers may pass one or both. v2.9.1: AWS-IoT path now passes
   * rawJson so state-only pushes are also captured.
   *
   * @param deviceId Govee device id
   * @param topic Source topic (account or device)
   * @param payload Either a hex string (op.command BLE bytes) or `{hex?, rawJson?}`
   */
  addMqttPacket(deviceId: string, topic: string, payload: string | { hex?: string; rawJson?: string }): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    // The topic embeds the account id (`GA/<hash>`, `GD/<hash>`): the report's
    // placeholders turn it into `GA/topic-N` (audit M12).
    const entry: Omit<MqttPacketEntry, "ts" | "first" | "count"> = { topic: String(topic) };
    const hex =
      typeof payload === "string" ? payload : payload && typeof payload === "object" ? payload.hex : undefined;
    const rawJson = payload && typeof payload === "object" ? payload.rawJson : undefined;
    let omitted = 0;
    if (typeof hex === "string" && hex) {
      entry.hex = wholeOrNothing(hex, MAX_PACKET_RAW_BYTES);
      omitted += entry.hex === undefined ? hex.length : 0;
    }
    if (typeof rawJson === "string" && rawJson) {
      const clean = this.cleanRawJson(rawJson);
      entry.rawJson = wholeOrNothing(clean, MAX_PACKET_RAW_BYTES);
      omitted += entry.rawJson === undefined ? clean.length : 0;
    }
    if (omitted > 0) {
      entry.omittedBytes = omitted;
    }
    if (!entry.hex && !entry.rawJson && !entry.omittedBytes) {
      return;
    }
    entry.kind = packetKind(entry.topic, entry.rawJson, entry.hex);
    const rings = this.get(deviceId).packets;
    const ring =
      rings.get(entry.kind) ?? rings.set(entry.kind, new ByteRing(MQTT_RING_BYTES, MQTT_ENTRY_BYTES)).get(entry.kind)!;
    // The same packet again — the transaction stamp aside — raises a counter instead of pushing others out (R1).
    ring.add(`${entry.topic}|${entry.hex ?? ""}|${(entry.rawJson ?? "").replace(TRANSACTION_RE, "")}`, entry);
  }

  /**
   * Redact the secrets of an MQTT envelope when it is captured — the placeholders run when the report is made, on
   * the whole envelope (audit E4: nothing is cut before that).
   *
   * @param rawJson The envelope as received
   */
  private cleanRawJson(rawJson: string): string {
    try {
      const parsed: unknown = JSON.parse(rawJson);
      redactSecretsInPlace(parsed);
      return JSON.stringify(parsed);
    } catch {
      return rawJson;
    }
  }

  /**
   * Record an outgoing LAN UDP datagram (per-device). Captures the data the
   * adapter actually put on the wire so a "I clicked snapshot and nothing
   * happened" report has the verbatim packet payload — which the v2.8.x
   * diag couldn't show even though `lastCommandSentMs` was kept in memory.
   *
   * @param deviceId Govee device id
   * @param ip Destination IP
   * @param cmd Command type ("ptReal", "turn", …)
   * @param payload Outgoing data — Base64 strings for ptReal, JSON-payload otherwise
   * @param bytes Datagram size in bytes (optional)
   * @param error Send-error string if the socket reported one (optional)
   */
  addLanSend(deviceId: string, ip: string, cmd: string, payload: unknown, bytes?: number, error?: string): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    const entry: LanSendEntry = {
      ts: new Date().toISOString(),
      ip: String(ip),
      cmd: String(cmd),
      payload: this.cloneAndCap(payload, MAX_LAN_SEND_BYTES),
    };
    if (typeof bytes === "number" && Number.isFinite(bytes)) {
      entry.bytes = bytes;
    }
    if (typeof error === "string" && error) {
      entry.error = error;
    }
    pushBounded(this.get(deviceId).lanSends, entry, MAX_LAN_SENDS);
  }

  /**
   * Record a successful API call for a Cloud/App-API endpoint. Appends
   * to the per-endpoint history (most-recent at the end), keeping at
   * most MAX_RESPONSES_PER_ENDPOINT entries per endpoint and at most
   * MAX_RESPONSE_ENDPOINTS distinct endpoints overall.
   *
   * Body is shallow-copied + serialised so later mutations of the
   * caller's object do not change what we report. Large bodies get
   * truncated to MAX_BODY_BYTES with a marker so users see the prefix.
   *
   * @param deviceId Govee device id
   * @param endpoint Endpoint identifier
   * @param body Response body
   * @param statusCode Optional HTTP status (200 by default if omitted)
   * @param rateLimit Govee's rate-limit headers on this answer, when it carried any
   */
  recordApiSuccess(
    deviceId: string,
    endpoint: string,
    body: unknown,
    statusCode?: number,
    rateLimit?: GoveeRateLimit | null,
  ): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof endpoint !== "string" || !endpoint) {
      return;
    }
    const stored = this.cloneAndCap(body);
    this.appendResponse(this.get(deviceId), {
      ts: new Date().toISOString(),
      endpoint,
      ok: true,
      statusCode: statusCode ?? 200,
      body: stored,
      bytes: byteSize(stored),
      ...(rateLimit ? { rateLimit: this.cloneAndCap(rateLimit) as GoveeRateLimit } : {}),
    });
  }

  /**
   * Record a FAILED API call. Captures the error message + HTTP status
   * (if extractable) plus the raw response body when the error is an
   * {@link HttpError} so the diag JSON shows "endpoint attempted, returned
   * 403 with body 'API key invalid'" instead of just "HTTP 403". Without
   * the body, 4xx/5xx triage stays one round-trip away.
   *
   * @param deviceId Govee device id
   * @param endpoint Endpoint identifier
   * @param error The thrown Error or any value
   * @param statusCode Optional HTTP status if extractable from the error
   */
  recordApiFailure(deviceId: string, endpoint: string, error: unknown, statusCode?: number): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof endpoint !== "string" || !endpoint) {
      return;
    }
    // The success path redacts and pseudonymises before capping; this one used
    // to store the raw foreign body, only length-limited. Today's callers are
    // device-scoped Cloud endpoints whose bodies carry no credentials, so
    // nothing leaked — but this is the branch that captures a foreign error
    // page verbatim, in a report whose whole purpose is being published.
    // A body that parses as JSON goes through the same key-based redaction as
    // a successful one; whatever it is, addresses and mail addresses inside it
    // are replaced before the length cap can hide them in a truncated string.
    const errMsg = errText(error);
    const responseBody = error instanceof HttpError ? error.responseBody : undefined;
    const body: Record<string, unknown> = { error: errMsg, status: statusCode };
    if (typeof responseBody === "string" && responseBody.length > 0) {
      let cleaned: string;
      try {
        const parsed: unknown = JSON.parse(responseBody);
        redactSecretsInPlace(parsed);
        cleaned = JSON.stringify(parsed);
      } catch {
        cleaned = responseBody;
      }
      // whole or nothing (R3) — the placeholders of the report need the whole text
      if (cleaned.length > MAX_BODY_BYTES) {
        body.responseBodyOmittedBytes = cleaned.length;
      } else {
        body.responseBody = cleaned;
      }
    }
    this.appendResponse(this.get(deviceId), {
      ts: new Date().toISOString(),
      endpoint,
      ok: false,
      statusCode,
      body,
      bytes: byteSize(body),
    });
  }

  /**
   * @param body Body to clone-via-JSON and cap.
   * @param maxBytes Size cap for the serialised clone (default {@link MAX_BODY_BYTES}).
   */
  private cloneAndCap(body: unknown, maxBytes: number = MAX_BODY_BYTES): unknown {
    try {
      const serialised = JSON.stringify(body);
      if (typeof serialised !== "string") {
        return body;
      }
      // Deep-clone, then strip credentials so secrets (e.g. a gateway
      // `secretCode`) never reach the diagnostics export — which the adapter
      // asks the user to publish (SEC-ISSUE1). Redact before the size
      // cap so a truncated body is masked too.
      const clone = JSON.parse(serialised) as unknown;
      redactSecretsInPlace(clone);
      // Redact now; the placeholders run when the report is made. A body over
      // the limit keeps only its size (R3): a cut body could carry half of a
      // personal value no placeholder pattern recognises any more.
      const redacted = JSON.stringify(clone);
      if (typeof redacted === "string" && redacted.length > maxBytes) {
        return { omittedBytes: redacted.length };
      }
      return clone;
    } catch {
      return String(body);
    }
  }

  /**
   * Append one API entry under three bounds: the per-endpoint slot count, the
   * distinct-endpoint count and the per-device byte budget. For the byte
   * budget the OLDEST entry anywhere in the device's history goes first — the
   * newest entry is always kept, so a fresh 64 KB scene list evicts stale
   * copies of itself and of other endpoints rather than being refused.
   *
   * @param b Device buffers
   * @param entry New API response entry (success or failure) to append
   */
  private appendResponse(b: DeviceBuffers, entry: ApiResponseEntry): void {
    const list = b.responses.get(entry.endpoint) ?? [];
    list.push(entry);
    b.responseBytes += entry.bytes;
    while (list.length > MAX_RESPONSES_PER_ENDPOINT) {
      b.responseBytes -= list.shift()!.bytes;
    }
    b.responses.set(entry.endpoint, list);
    if (b.responses.size > MAX_RESPONSE_ENDPOINTS) {
      const first = b.responses.keys().next().value;
      if (first !== undefined) {
        for (const dropped of b.responses.get(first) ?? []) {
          b.responseBytes -= dropped.bytes;
        }
        b.responses.delete(first);
      }
    }
    while (b.responseBytes > MAX_RESPONSE_BYTES_PER_DEVICE) {
      let oldestKey: string | undefined;
      let oldestTs = "";
      for (const [key, entries] of b.responses) {
        const head = entries[0];
        if (!head || head === entry) {
          continue;
        }
        if (oldestKey === undefined || head.ts < oldestTs) {
          oldestKey = key;
          oldestTs = head.ts;
        }
      }
      if (oldestKey === undefined) {
        break; // only the entry just added is left — it stays
      }
      const entries = b.responses.get(oldestKey)!;
      b.responseBytes -= entries.shift()!.bytes;
      if (entries.length === 0) {
        b.responses.delete(oldestKey);
      }
    }
  }

  /**
   * Drop buffers for all devices that are NOT in the live list.
   *
   * Called from the adapter cleanup path (reapStaleDevices) so logs / packets /
   * responses for long-removed Govee-app devices don't stay in memory forever.
   *
   * @param liveDeviceIds Set of the currently active device ids
   */
  pruneOrphans(liveDeviceIds: Set<string>): void {
    for (const map of [this.buffers, this.lanReplies, this.reachability]) {
      for (const id of map.keys()) {
        if (!liveDeviceIds.has(id)) {
          map.delete(id);
        }
      }
    }
  }

  /**
   * Build the diagnostics-export JSON for a device. Combines static
   * device data + capabilities + scenes/libraries with the captured
   * ring-buffer context (logs, MQTT packets, API responses).
   *
   * v2.9.1: extended to surface raw BLE/scene/snapshot bytes, runtime
   * adapter state, persisted-cache view, local-snapshots and LAN-send
   * history. See `feedback_diag_system_self_service.md` for the brief.
   *
   * @param device Target device
   * @param adapterVersion Adapter version string (e.g. "2.0.0")
   * @param prefix Device state prefix — enables the object-tree section
   */
  async generate(device: GoveeDevice, adapterVersion: string, prefix?: string): Promise<Record<string, unknown>> {
    return (await this.generateReport(device, adapterVersion, prefix)).content;
  }

  /**
   * A copy of a device's buffers as they stand now — taken before the report's live read, so the read's own answers
   * never push the recorded history out of the rings (the live read goes into its own section).
   *
   * @param deviceId Govee device id
   * @param mentions The strings naming this device and the others in a log line
   * @returns The frozen buffers, or undefined when the device has none yet
   */
  freeze(deviceId: string, mentions?: LogMentions): FrozenBuffers {
    const b = this.get(deviceId);
    return structuredClone({
      logs: b.logs,
      packets: packetView(b.packets),
      responses: Object.fromEntries(b.responses),
      lanSends: b.lanSends,
      commandResults: b.commandResults,
      accountCalls: this.accountCalls,
      adapterLog: this.adapterLogAbout(mentions),
      lanReplies: [...(this.lanReplies.get(deviceId)?.values() ?? [])],
      reachabilityHistory: this.reachability.get(deviceId) ?? [],
      unreadablePackets: this.unreadable,
    });
  }

  /**
   * Record one change of a device's shown reachability (plan G4) — when, to what, from what, and which source decided
   * it on which evidence.
   *
   * @param deviceId Govee device id
   * @param change The change as the state manager resolved it
   * @param change.online What `info.online` shows now
   * @param change.was What it showed before (null for the first value)
   * @param change.decidedBy The deciding source
   * @param change.lastEvidenceAt The evidence time (ms), null without one
   */
  recordReachability(
    deviceId: string,
    change: { online: boolean; was: boolean | null; decidedBy: string; lastEvidenceAt: number | null },
  ): void {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    pushBounded(
      this.reachability.get(deviceId) ?? this.reachability.set(deviceId, []).get(deviceId)!,
      {
        ts: new Date().toISOString(),
        online: change.online,
        was: change.was,
        decidedBy: change.decidedBy,
        lastEvidenceAt: change.lastEvidenceAt === null ? null : new Date(change.lastEvidenceAt).toISOString(),
      },
      MAX_REACHABILITY_CHANGES,
    );
  }

  /**
   * Record one packet a client could not read (plan G5). The raw text is kept whole or only its size, and goes
   * through the report's placeholders like everything else.
   *
   * @param source Which client
   * @param from The topic or address it came from
   * @param raw The packet as text
   * @param reason Why it could not be read
   */
  recordUnreadable(source: string, from: string, raw: string, reason: string): void {
    // the same redaction as every captured envelope: a packet that is JSON loses its secrets now (SENSITIVE_KEYS)
    const text = this.cleanRawJson(typeof raw === "string" ? raw : String(raw));
    const kept = wholeOrNothing(text, MAX_PACKET_RAW_BYTES);
    pushBounded(
      this.unreadable,
      {
        ts: new Date().toISOString(),
        source: String(source),
        from: String(from),
        reason: String(reason),
        ...(kept === undefined ? { omittedBytes: text.length } : { raw: kept }),
      },
      MAX_UNREADABLE,
    );
  }

  /**
   * Wire the adapter's log ring (plan G2).
   *
   * @param ring The ring main.ts hooked into the adapter log
   */
  setLogRing(ring: LogRing | null): void {
    this.logRing = ring;
  }

  /**
   * Count one LAN scan reply of a device (plan G1) — the scan answers every 30 s, one log line per reply pushed every
   * other line out of the device's activity log (#50: 100 of 100 lines).
   *
   * @param deviceId Govee device id
   * @param ip The address it answered from
   * @param sku The model it named
   */
  recordLanReply(deviceId: string, ip: string, sku: string): void {
    if (typeof deviceId !== "string" || !deviceId || typeof ip !== "string") {
      return;
    }
    const now = new Date().toISOString();
    const byIp = this.lanReplies.get(deviceId) ?? new Map<string, LanReplyEntry>();
    const seen = byIp.get(ip);
    if (seen) {
      byIp.delete(ip);
      seen.last = now;
      seen.count += 1;
      seen.sku = String(sku);
      byIp.set(ip, seen);
    } else {
      byIp.set(ip, { ip, sku: String(sku), first: now, last: now, count: 1 });
      // a device answering from ever new addresses (spoofed sources) keeps only its latest ones
      for (const oldest of byIp.keys()) {
        if (byIp.size <= MAX_LAN_REPLY_ADDRESSES) {
          break;
        }
        byIp.delete(oldest);
      }
    }
    this.lanReplies.set(deviceId, byIp);
  }

  /**
   * The adapter's log lines about one device — all of them when no mentions are given.
   *
   * @param mentions The strings naming this device and the others
   */
  private adapterLogAbout(mentions?: LogMentions): LogLine[] {
    return this.logRing?.about(mentions?.mine ?? [], mentions?.others ?? []) ?? [];
  }

  /**
   * One report with its placeholders: the content and the device id for the file name, rendered by the same
   * placeholders (DB-12 — a scheme id stays as it is).
   *
   * @param device Target device
   * @param adapterVersion Adapter version string
   * @param prefix Device state prefix — enables the object-tree section
   * @param extra What the report adds for this export: frozen buffers, the live read, the tree id for the file name
   * @param extra.frozen Buffers frozen before the live read
   * @param extra.live The live read's section
   * @param extra.treeId The device's tree id (`h6199-b24d`)
   * @param extra.mentions The strings naming this device and the others in a log line
   * @returns The pseudonymised content and the file id
   */
  async generateReport(
    device: GoveeDevice,
    adapterVersion: string,
    prefix?: string,
    extra: { frozen?: FrozenBuffers; live?: Record<string, unknown>; treeId?: string; mentions?: LogMentions } = {},
  ): Promise<{ content: Record<string, unknown>; fileId: string }> {
    const quirks = this.registry.getQuirks(device.sku);
    const b = extra.frozen
      ? { ...extra.frozen, responses: new Map(Object.entries(extra.frozen.responses)) }
      : this.buffers.get(device.deviceId);
    const accountCalls = extra.frozen?.accountCalls ?? this.accountCalls;

    const runtimeState = this.runtimeStateProvider ? this.runtimeStateProvider() : null;
    const cacheSnapshot = this.cacheSnapshotProvider
      ? this.cloneAndCap(this.cacheSnapshotProvider(device.sku, device.deviceId))
      : null;
    const localSnapshots = this.localSnapshotsProvider
      ? this.cloneAndCap(this.localSnapshotsProvider(device.sku, device.deviceId))
      : [];
    let environment: EnvironmentSnapshot | null = null;
    try {
      environment = this.environmentProvider ? this.environmentProvider() : null;
    } catch {
      environment = null;
    }
    let objectTree: ObjectTreeEntry[] | null = null;
    if (this.objectTreeProvider && prefix) {
      objectTree = await this.objectTreeProvider(prefix).catch(() => null);
    }
    // The routing between the two ends the report already had: which channel
    // carries a write to each datapoint, and why that one. Derived from the
    // writable datapoints of the real tree, so it describes THIS installation.
    let controlPaths: ControlPathEntry[] | null = null;
    if (this.controlPathProvider && objectTree) {
      const writable = objectTree.filter(e => e.write === true).map(e => e.id);
      try {
        controlPaths = this.controlPathProvider(device, writable);
      } catch {
        controlPaths = null;
      }
    }

    // readMe, adapter, version, time and runtime come from the fleet frame (`report-file.ts`, DB-06).
    const report: Record<string, unknown> = {
      // What the report used to be missing entirely: which ioBroker this ran on
      // and how the installation as a whole was doing at export time.
      environment,
      device: {
        sku: device.sku,
        deviceId: device.deviceId,
        name: device.name,
        type: device.type,
        objectPrefix: prefix ?? null,
        // The strip's PHYSICAL length as the adapter settles it (quirk >
        // learned > cloud capabilities) — not the raw learned field, which is
        // empty for a device whose count is only known from its capabilities
        // and would report `null` next to a tree full of segment channels.
        segmentCount: resolveSegmentCount(device, this.registry),
        // How many segment channels the tree actually has: the physical length
        // widened by a manual index list on a cut strip. The two differ exactly
        // in the case a segment report is usually about.
        segmentTreeSize: effectiveSegmentCount(device, this.registry),
        // Where the segment count came from. It is the single most asked-back
        // question on a segment report, and the number alone never answered it.
        segmentCountSource: this.segmentCountSource(device),
        // Same idea for reachability: `state.online` alone never answered
        // "why does it show offline" — this names the deciding source, when it
        // last spoke, what refreshes it, and which sources stay silent for this
        // device kind by design.
        reachabilitySource: this.reachabilitySource(device),
        channels: { ...device.channels },
        lanIp: device.lanIp ?? null,
        gateway: device.gateway ?? null,
        // v2.9.1 — runtime flags / timestamps that were previously invisible
        manualMode: device.manualMode ?? false,
        manualSegments: device.manualSegments ?? null,
        sceneSpeed: device.sceneSpeed ?? null,
        scenesChecked: device.scenesChecked ?? false,
        lastSeenOnNetwork: device.lastSeenOnNetwork ?? null,
        lastLanReplyAt: device.lastLanReplyAt ?? null,
        groupMembers: device.groupMembers ?? null,
        // Whether the account list handed this device a broker topic — the
        // topic itself is an address and stays out. Without one, no status
        // request can reach the device at all.
        brokerTopicKnown: typeof device.iotTopic === "string" && device.iotTopic.length > 0,
        // When the adapter last asked it for its status over the broker
        // (2.39.0), and when it last renewed its cloud reachability proof.
        lastStatusRequestAt: device.lastStatusRequestAt ?? null,
        lastReachabilityRefreshAt: device.lastReachabilityRefreshAt ?? null,
        // When the last failed command left the datapoint's value unconfirmed —
        // null once a later command or the device's own state confirmed it (issue #51).
        unconfirmedSince: device.unconfirmedSince ?? null,
        // When the libraries were last fetched, and how many account lists in a
        // row did not contain the device (the reaper's counter).
        librariesCheckedAt: device.librariesCheckedAt ?? null,
        accountMissCount: device.accountMissCount ?? 0,
      },
      capabilities: device.capabilities,
      scenes: {
        count: device.scenes.length,
        names: device.scenes.map(s => s.name),
        // Cloud-side `value` payload — needed when the dropdown index can't
        // be replayed from name alone (snapshots especially have integer IDs).
        entries: device.scenes.map(s => ({ name: s.name, value: s.value })),
      },
      diyScenes: {
        count: device.diyScenes.length,
        names: device.diyScenes.map(s => s.name),
        entries: device.diyScenes.map(s => ({ name: s.name, value: s.value })),
      },
      snapshots: {
        count: device.snapshots.length,
        names: device.snapshots.map(s => s.name),
        entries: device.snapshots.map(s => ({ name: s.name, value: s.value })),
        // v2.9.1 — raw BLE packets per snapshot. THE field for byte-level
        // snapshot debugging (Issue #13, H61A8 tukey42). Previously the only
        // way to get this was to ask the user for the cache file.
        bleCmds: device.snapshotBleCmds
          ? device.snapshots.map(s => ({
              name: s.name,
              packets: device.snapshotBleCmds?.find(p => p.name === s.name)?.cmds ?? [],
            }))
          : [],
      },
      sceneLibrary: {
        count: device.sceneLibrary.length,
        // v2.9.1 — full entries with `scenceParam` Base64 + `speedInfo.config`
        // JSON. Old shape (name + sceneCode + hasParam + speedSupported only)
        // hid the very bytes needed to compare working vs broken scene
        // activation between SKUs.
        entries: device.sceneLibrary.map(s => ({
          name: s.name,
          sceneCode: s.sceneCode,
          scenceParam: s.scenceParam,
          speedInfo: s.speedInfo,
        })),
      },
      musicLibrary: {
        count: device.musicLibrary.length,
        entries: device.musicLibrary.map(m => ({
          name: m.name,
          musicCode: m.musicCode,
          mode: m.mode ?? null,
          scenceParam: m.scenceParam,
        })),
      },
      diyLibrary: {
        count: device.diyLibrary.length,
        entries: device.diyLibrary.map(d => ({
          name: d.name,
          diyCode: d.diyCode,
          scenceParam: d.scenceParam,
        })),
      },
      quirks: quirks ?? null,
      skuFeatures: device.skuFeatures,
      state: { ...device.state },
      recentLogs: b?.logs.slice() ?? [],
      // The adapter's own log at every level, also debug (plan G2) — the lines naming this device or no other one.
      adapterLog: extra.frozen?.adapterLog ?? this.adapterLogAbout(extra.mentions),
      // Every address the device answered the LAN scan from, counted (plan G1).
      lanReplies: extra.frozen?.lanReplies ?? [...(this.lanReplies.get(device.deviceId)?.values() ?? [])],
      // Every change of what info.online showed, with the deciding source and its evidence (plan G4).
      reachabilityHistory: (extra.frozen?.reachabilityHistory ?? this.reachability.get(device.deviceId) ?? []).slice(),
      // Packets no client could read — account-wide, the sender is not always a known device (plan G5).
      unreadablePackets: (extra.frozen?.unreadablePackets ?? this.unreadable).slice(),
      // Per kind, the same packet counted (plan G3) — flattened, oldest first.
      lastMqttPackets: extra.frozen?.packets ?? packetView(this.buffers.get(device.deviceId)?.packets),
      // History per endpoint (most-recent at the end). Each entry has
      // {ts, ok, statusCode, body}. body holds either the success
      // response or `{error, status, responseBody?}` for failed calls.
      apiHistory: b ? Object.fromEntries(Array.from(b.responses.entries()).map(([k, v]) => [k, v.slice()])) : {},
      // v2.9.1 — outgoing LAN UDP datagrams. Closes the "did the adapter
      // even send anything?" diag blind spot for ptReal-driven scene /
      // snapshot / segment commands.
      lanSends: b?.lanSends.slice() ?? [],
      // v2.9.1 — persisted-on-disk view of the SkuCache for this device.
      // Used to compare runtime state to the cache that would be reloaded
      // on next restart. Empty when no cache entry exists yet.
      cache: cacheSnapshot,
      // v2.9.1 — user-saved local snapshots for this device.
      localSnapshots,
      // v2.9.1 — process-wide adapter runtime state: last-error categories
      // per subsystem, rate-limiter usage, live wizard session, LAN-discovery
      // peers. Each field optional (provider may know fewer than all of them).
      runtimeState,
      // What the user's last commands actually did — `lanSends` stops at the
      // wire, this says whether the write was accepted and why not.
      commandResults: b?.commandResults.slice() ?? [],
      // Account-wide, so it appears in every device's report: without it a dead
      // push channel has no reason in the report at all.
      accountCalls: accountCalls.slice(),
      // "How is this device actually driven" — the question a report has to
      // answer before a stranger's model can be added to the catalogue.
      controlPaths,
      // The datapoints as they really exist, with type, role, unit and value.
      // Null when no prefix was passed (the device has no tree yet).
      objectTree,
      // What the device said when the report was asked for (DB-02, E1/E2) — only for a connected device.
      ...(extra.live ? { live: extra.live } : {}),
    };

    // The report's placeholders (fleet DB-04), new for every report: the names
    // the user gave — devices, groups, and this device's snapshots and DIY
    // scenes (GV-30) — by lookup, the shapeless Govee values by key, then
    // names, mail, hardware ids and addresses by their form.
    const snapshotNames = [
      ...device.snapshots.map(s => s.name),
      ...device.diyScenes.map(s => s.name),
      ...(Array.isArray(localSnapshots)
        ? localSnapshots
            .map(s => (s as { name?: unknown } | null)?.name)
            .filter((n): n is string => typeof n === "string")
        : []),
    ];
    const places = new Placeholders();
    const content = pseudonymiseReport(
      report,
      { names: [...this.deviceNames(), ...snapshotNames], digitIds: this.digitDeviceIds() },
      places,
    ) as Record<string, unknown>;
    // the same pre-pass and placeholders as the content, so a digit group id becomes the same `group-N`
    const fileId = String(
      pseudonymiseReport(extra.treeId ?? device.sku, { names: [], digitIds: this.digitDeviceIds() }, places),
    );
    return { content, fileId };
  }

  /**
   * Where this device's reachability comes from — and, just as important, which
   * sources can NEVER speak for it.
   *
   * The report used to show `state.online` and nothing else. On a "shows offline
   * although it works" report that is the one number that cannot answer the
   * question, because the interesting part is which source decided it and when
   * that source last said anything. Measured cost of the omission (2026-09-03):
   * tracing a single device's reachability took hours of reading the adapter's
   * source, because the report simply did not carry it.
   *
   * **This method decides nothing.** It asks {@link resolveDeviceReachability}
   * which source settled the question and only puts that into words. The first
   * version did decide — it re-stated the rule by hand — and 2.30.0 moved the
   * rule underneath it: measured on an H618A the same day, all four fields were
   * wrong at once (LAN was tied to `lanIp` instead of the seven-day memory, two
   * timestamps read fields the resolver no longer uses, and the gateway ceiling
   * was missing entirely). A second copy of a rule is a copy that will drift.
   *
   * Mirrors {@link segmentCountSource} — same question, same shape.
   *
   * @param device The device the report is about
   */
  private reachabilitySource(device: GoveeDevice): {
    decidedBy: string;
    lastEvidenceAt: number | null;
    refreshedBy: string;
    silentSources: string[];
  } {
    // An app group is no device: nothing reports on it, and its tree has no
    // reachability datapoint of its own. Run through the device rule it read
    // "nothing ever reported — reported as not reachable" next to five renewers
    // that never touch a group (krobi's installation, 2.39.1).
    if (isAppGroup(device)) {
      return {
        decidedBy:
          "not applicable — an app group has no reachability of its own; groups.info.online shows the cloud connection, the group's info.membersUnreachable names members that cannot be reached",
        lastEvidenceAt: null,
        refreshedBy: "nothing — a group is never asked for its state",
        silentSources: [],
      };
    }
    const decision = resolveDeviceReachability(device);
    const isLight = device.type === GOVEE_DEVICE_TYPE.LIGHT;
    const lanDriven = isLanDriven(device);

    // What stays silent, and what can renew the evidence, both follow from HOW
    // the device is driven — not from what happened to decide this time. Each
    // renewer names the credentials it needs, because that is the difference
    // between "this proof gets refreshed" and "this proof expires in 30
    // minutes and the device goes grey": every renewer but the last one needs
    // the Govee account, and an installation with only an API key has none.
    const silent: string[] = [];
    const renewers: string[] = [];
    if (lanDriven) {
      // maybeApplyCloudOnline bails on isLanDriven, so NO cloud source can
      // speak for this device — in either direction.
      silent.push("cloud state read (a LAN-driven light ignores every cloud claim)");
      silent.push("account push (same reason)");
      silent.push("app device list (same reason)");
      silent.push("cloud event push (same reason)");
      renewers.push("LAN scan, every 30 s");
    } else {
      silent.push(isLight ? "LAN reply (device has no local API enabled)" : "LAN reply (not a light)");
      renewers.push(
        "account push, event-driven (needs email + password) — the device's own status push holds against a polled offline for 30 min",
      );
      renewers.push("app device list, every 2 min (needs email + password)");
      renewers.push(
        `status request over the account broker once the device's own push is older than ${Math.round(STATUS_REQUEST_INTERVAL_MS / 60000)} min, and once right after a failed command (needs email + password)`,
      );
      renewers.push("cloud event push, event-driven (needs the API key)");
      // The refresh skips every device with its own daily budget (appliances,
      // sensors — `applianceBudget`): 72 of its 90 calls a day would go to
      // reachability alone. Promising it here sent the reader of an H7127
      // report waiting for a call that never comes (issue #47, 2026-09-22).
      if (applianceBudget(device) === undefined) {
        renewers.push(
          `reachability refresh once the evidence is older than ${Math.round(CLOUD_REACHABILITY_REFRESH_MS / 60000)} min, and once after a failed command when no status request can reach the device — that read also corrects the values (needs the API key)`,
        );
      } else {
        silent.push(
          "reachability refresh (the device keeps its own daily budget — start read, own push, command and list only)",
        );
      }
    }

    const refreshedBy = renewers.join("; ");

    const decidedBy = {
      lanReply: "LAN reply freshness",
      gatewayDown: "its gateway is down — a device behind a gateway can be no more reachable than the gateway",
      cloudReport: "Govee reported it explicitly (an `online` capability)",
      cloudLiveness:
        "Govee delivered something for this device without reporting reachability — the payload proves it spoke",
      noEvidence: "nothing ever reported — reported as not reachable",
    }[decision.decidedBy];

    return {
      decidedBy,
      lastEvidenceAt: decision.lastEvidenceAt,
      refreshedBy,
      silentSources: silent,
    };
  }

  /**
   * Which source settled this device's segment count — the answer of
   * `resolveSegmentCountWithSource`, put into words. A second copy of the
   * priority here drifted (no plausibility gate: "cloud capability" next to
   * a count of 0; a quirk of 99 reported as the source of a different count).
   *
   * @param device The device being reported on
   */
  private segmentCountSource(device: GoveeDevice): string {
    switch (resolveSegmentCountWithSource(device, this.registry).source) {
      case "quirk":
        return "quirk (hard override for this SKU)";
      case "learned":
        return "learned at runtime (cache, MQTT push or wizard)";
      case "cloudCapability":
        return "smallest cloud segment capability";
      case "none":
      default:
        return "unknown (no segment source)";
    }
  }
}
