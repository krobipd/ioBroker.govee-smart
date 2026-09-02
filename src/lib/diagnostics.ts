import { HttpError } from "./http-client";
import type { DeviceRegistry } from "./device-registry";
import type { GoveeDevice } from "./types";

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
  /** ISO timestamp */
  ts: string;
  /** AWS-IoT account topic or Cloud-events topic the packet arrived on */
  topic: string;
  /** Hex-encoded BLE bytes (lowercase, space-separated) — set for AWS-IoT op.command entries. */
  hex?: string;
  /** Raw JSON envelope around the message — captured so state-correlation isn't lost. */
  rawJson?: string;
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
  rateLimiter?: {
    usedToday: number;
    usedThisMinute: number;
    dailyLimit: number;
    perMinuteLimit: number;
    queueLength: number;
  } | null;
  /** Live wizard session if any — captured for "wizard ran during diag-click" forensics. */
  wizardSession?: unknown;
  /** LAN client's `seenDeviceIps` set as `["sku-id:ip", ...]` — discovery trace. */
  lanSeenDeviceIps?: string[];
}

/** Per-device ring buffers. */
interface DeviceBuffers {
  logs: LogEntry[];
  packets: MqttPacketEntry[];
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
}

/**
 * Buffer sizes — raised in v2.9.1 so debug captures actually survive longer
 * Govee outages and Multi-Segment-Echo (~5 AA-A5-Pakete pro Status-Push).
 * Old sizes (20/10/3/12) were tuned for sparse Cloud-only debugging; the v2.9.1
 * Coverage-Welle adds LAN sends + MQTT raw envelopes + per-fetch raw bodies
 * → previous caps would evict the first interesting frames before a user could
 * trigger the diag.export button.
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
const MAX_PACKETS = 50;
const MAX_RESPONSE_ENDPOINTS = 24;
const MAX_RESPONSES_PER_ENDPOINT = 6;
const MAX_LAN_SENDS = 30;
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES_PER_DEVICE = 512 * 1024;
const MAX_PACKET_RAW_BYTES = 4_096;
const MAX_LAN_SEND_BYTES = 16_384;

/**
 * Cut a captured text to `max` characters with a marker. Real MQTT envelopes
 * and ptReal payloads are a few hundred bytes to a few KB — anything larger
 * is a Govee anomaly worth seeing the head of, not worth keeping whole.
 *
 * @param text Captured text
 * @param max Character cap
 */
function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…<truncated ${text.length}b>` : text;
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
 * Collects diagnostic context per device and produces the
 * `diag.result` JSON. Replaces the inline
 * `device-manager.generateDiagnostics()` so log/MQTT/API hooks can write
 * data without coupling to DeviceManager.
 *
 * Buffers are bounded — the collector survives long-running adapters
 * without unbounded memory growth.
 */
export class DiagnosticsCollector {
  private readonly buffers = new Map<string, DeviceBuffers>();
  private runtimeStateProvider: RuntimeStateProvider | null = null;
  private cacheSnapshotProvider: CacheSnapshotProvider | null = null;
  private localSnapshotsProvider: LocalSnapshotsProvider | null = null;

  /** @param registry This instance's device catalog — the export shows the quirks active for the SKU */
  constructor(private readonly registry: DeviceRegistry) {}

  /**
   * Register the runtime-state provider. main.ts wires it after all
   * sub-clients (Cloud, MQTT, Rate-limiter, LAN, Wizard) are instantiated
   * so the snapshot can pull from any of them.
   *
   * @param provider Callback returning a runtime-state snapshot (or partial)
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
      b = { logs: [], packets: [], responses: new Map(), responseBytes: 0, lanSends: [] };
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
   * Append an MQTT packet for a device. Bounded to MAX_PACKETS most-recent.
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
    const entry: MqttPacketEntry = { ts: new Date().toISOString(), topic: String(topic) };
    if (typeof payload === "string") {
      if (!payload) {
        return;
      }
      entry.hex = capText(payload, MAX_PACKET_RAW_BYTES);
    } else if (payload && typeof payload === "object") {
      if (typeof payload.hex === "string" && payload.hex) {
        entry.hex = capText(payload.hex, MAX_PACKET_RAW_BYTES);
      }
      if (typeof payload.rawJson === "string" && payload.rawJson) {
        entry.rawJson = capText(payload.rawJson, MAX_PACKET_RAW_BYTES);
      }
      if (!entry.hex && !entry.rawJson) {
        return;
      }
    } else {
      return;
    }
    pushBounded(this.get(deviceId).packets, entry, MAX_PACKETS);
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
   */
  recordApiSuccess(deviceId: string, endpoint: string, body: unknown, statusCode?: number): void {
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
    const errMsg = error instanceof Error ? error.message : String(error);
    const responseBody = error instanceof HttpError ? error.responseBody : undefined;
    const body: Record<string, unknown> = { error: errMsg, status: statusCode };
    if (typeof responseBody === "string" && responseBody.length > 0) {
      body.responseBody =
        responseBody.length > MAX_BODY_BYTES ? `${responseBody.slice(0, MAX_BODY_BYTES)}…` : responseBody;
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
      const capped = JSON.stringify(clone);
      if (typeof capped === "string" && capped.length > maxBytes) {
        return `<truncated ${capped.length}b: ${capped.slice(0, maxBytes)}…>`;
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
    for (const id of this.buffers.keys()) {
      if (!liveDeviceIds.has(id)) {
        this.buffers.delete(id);
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
   */
  generate(device: GoveeDevice, adapterVersion: string): Record<string, unknown> {
    const quirks = this.registry.getQuirks(device.sku);
    const b = this.buffers.get(device.deviceId);

    const runtimeState = this.runtimeStateProvider ? this.runtimeStateProvider() : null;
    const cacheSnapshot = this.cacheSnapshotProvider
      ? this.cloneAndCap(this.cacheSnapshotProvider(device.sku, device.deviceId))
      : null;
    const localSnapshots = this.localSnapshotsProvider
      ? this.cloneAndCap(this.localSnapshotsProvider(device.sku, device.deviceId))
      : [];

    return {
      adapter: "iobroker.govee-smart",
      version: adapterVersion,
      exportedAt: new Date().toISOString(),
      device: {
        sku: device.sku,
        deviceId: device.deviceId,
        name: device.name,
        type: device.type,
        segmentCount: device.segmentCount ?? null,
        channels: { ...device.channels },
        lanIp: device.lanIp ?? null,
        // v2.9.1 — runtime flags / timestamps that were previously invisible
        manualMode: device.manualMode ?? false,
        manualSegments: device.manualSegments ?? null,
        sceneSpeed: device.sceneSpeed ?? null,
        scenesChecked: device.scenesChecked ?? false,
        lastSeenOnNetwork: device.lastSeenOnNetwork ?? null,
        lastLanReplyAt: device.lastLanReplyAt ?? null,
        groupMembers: device.groupMembers ?? null,
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
          ? device.snapshots.map((s, idx) => ({
              name: s.name,
              packets: device.snapshotBleCmds?.[idx] ?? [],
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
      lastMqttPackets: b?.packets.slice() ?? [],
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
    };
  }
}
