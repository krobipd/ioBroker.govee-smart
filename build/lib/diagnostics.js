"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var diagnostics_exports = {};
__export(diagnostics_exports, {
  DiagnosticsCollector: () => DiagnosticsCollector
});
module.exports = __toCommonJS(diagnostics_exports);
var import_http_client = require("./http-client");
var import_device_registry = require("./device-registry");
const MAX_LOGS = 100;
const MAX_PACKETS = 50;
const MAX_RESPONSE_ENDPOINTS = 24;
const MAX_RESPONSES_PER_ENDPOINT = 6;
const MAX_LAN_SENDS = 30;
const MAX_BODY_BYTES = 65536;
const SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "secretcode",
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "bearer",
  "topic"
]);
function redactSecretsInPlace(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      redactSecretsInPlace(item);
    }
    return;
  }
  if (value && typeof value === "object") {
    const obj = value;
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        obj[key] = "***";
      } else {
        redactSecretsInPlace(obj[key]);
      }
    }
  }
}
function pushBounded(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}
class DiagnosticsCollector {
  buffers = /* @__PURE__ */ new Map();
  runtimeStateProvider = null;
  cacheSnapshotProvider = null;
  localSnapshotsProvider = null;
  /**
   * Register the runtime-state provider. main.ts wires it after all
   * sub-clients (Cloud, MQTT, Rate-limiter, LAN, Wizard) are instantiated
   * so the snapshot can pull from any of them.
   *
   * @param provider Callback returning a runtime-state snapshot (or partial)
   */
  setRuntimeStateProvider(provider) {
    this.runtimeStateProvider = provider;
  }
  /**
   * Register the cache-snapshot provider. main.ts wires SkuCache.loadOne
   * so generate() can render the on-disk view of the cache without giving
   * the DiagnosticsCollector a direct dependency on SkuCache.
   *
   * @param provider Callback returning the cached entry (or null) for one device
   */
  setCacheSnapshotProvider(provider) {
    this.cacheSnapshotProvider = provider;
  }
  /**
   * Register the local-snapshot provider. Wired to LocalSnapshotStore so
   * the diag includes user-saved snapshot definitions (per-segment colours
   * are useful for "user-saved snapshot looks wrong after restore" reports).
   *
   * @param provider Callback returning local snapshot entries for one device
   */
  setLocalSnapshotsProvider(provider) {
    this.localSnapshotsProvider = provider;
  }
  /**
   * Lazily initialise the ring buffers for a device id.
   *
   * @param deviceId Govee device id (the buffer key)
   */
  get(deviceId) {
    let b = this.buffers.get(deviceId);
    if (!b) {
      b = { logs: [], packets: [], responses: /* @__PURE__ */ new Map(), lanSends: [] };
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
  addLog(deviceId, level, msg) {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof msg !== "string") {
      return;
    }
    pushBounded(this.get(deviceId).logs, { ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg }, MAX_LOGS);
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
  addMqttPacket(deviceId, topic, payload) {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    const entry = { ts: (/* @__PURE__ */ new Date()).toISOString(), topic: String(topic) };
    if (typeof payload === "string") {
      if (!payload) {
        return;
      }
      entry.hex = payload;
    } else if (payload && typeof payload === "object") {
      if (typeof payload.hex === "string" && payload.hex) {
        entry.hex = payload.hex;
      }
      if (typeof payload.rawJson === "string" && payload.rawJson) {
        entry.rawJson = payload.rawJson;
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
  addLanSend(deviceId, ip, cmd, payload, bytes, error) {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ip: String(ip),
      cmd: String(cmd),
      payload: this.cloneAndCap(payload)
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
  recordApiSuccess(deviceId, endpoint, body, statusCode) {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof endpoint !== "string" || !endpoint) {
      return;
    }
    const stored = this.cloneAndCap(body);
    this.appendResponse(this.get(deviceId), {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      endpoint,
      ok: true,
      statusCode: statusCode != null ? statusCode : 200,
      body: stored
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
  recordApiFailure(deviceId, endpoint, error, statusCode) {
    if (typeof deviceId !== "string" || !deviceId) {
      return;
    }
    if (typeof endpoint !== "string" || !endpoint) {
      return;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    const responseBody = error instanceof import_http_client.HttpError ? error.responseBody : void 0;
    const body = { error: errMsg, status: statusCode };
    if (typeof responseBody === "string" && responseBody.length > 0) {
      body.responseBody = responseBody.length > MAX_BODY_BYTES ? `${responseBody.slice(0, MAX_BODY_BYTES)}\u2026` : responseBody;
    }
    this.appendResponse(this.get(deviceId), {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      endpoint,
      ok: false,
      statusCode,
      body
    });
  }
  /** @param body Body to clone-via-JSON and cap at MAX_BODY_BYTES. */
  cloneAndCap(body) {
    try {
      const serialised = JSON.stringify(body);
      if (typeof serialised !== "string") {
        return body;
      }
      const clone = JSON.parse(serialised);
      redactSecretsInPlace(clone);
      const capped = JSON.stringify(clone);
      if (typeof capped === "string" && capped.length > MAX_BODY_BYTES) {
        return `<truncated ${capped.length}b: ${capped.slice(0, MAX_BODY_BYTES)}\u2026>`;
      }
      return clone;
    } catch {
      return String(body);
    }
  }
  /**
   * @param b Device buffers
   * @param entry New API response entry (success or failure) to append
   */
  appendResponse(b, entry) {
    var _a;
    const list = (_a = b.responses.get(entry.endpoint)) != null ? _a : [];
    pushBounded(list, entry, MAX_RESPONSES_PER_ENDPOINT);
    b.responses.set(entry.endpoint, list);
    if (b.responses.size > MAX_RESPONSE_ENDPOINTS) {
      const first = b.responses.keys().next().value;
      if (first !== void 0) {
        b.responses.delete(first);
      }
    }
  }
  /**
   * Drop all buffers for a device — called when the adapter forgets a
   * device (cleanupDevices in device-manager). Keeps memory bounded.
   *
   * @param deviceId Govee device id
   */
  forget(deviceId) {
    this.buffers.delete(deviceId);
  }
  /**
   * Drop buffers for all devices that are NOT in the live list.
   *
   * Called from the adapter cleanup path (reapStaleDevices) so logs / packets /
   * responses for long-removed Govee-app devices don't stay in memory forever.
   *
   * @param liveDeviceIds Set of the currently active device ids
   */
  pruneOrphans(liveDeviceIds) {
    for (const id of this.buffers.keys()) {
      if (!liveDeviceIds.has(id)) {
        this.buffers.delete(id);
      }
    }
  }
  /** Drop all buffers — useful in tests. */
  clear() {
    this.buffers.clear();
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
  generate(device, adapterVersion) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    const quirks = (0, import_device_registry.getDeviceQuirks)(device.sku);
    const b = this.buffers.get(device.deviceId);
    const runtimeState = this.runtimeStateProvider ? this.runtimeStateProvider() : null;
    const cacheSnapshot = this.cacheSnapshotProvider ? this.cloneAndCap(this.cacheSnapshotProvider(device.sku, device.deviceId)) : null;
    const localSnapshots = this.localSnapshotsProvider ? this.cloneAndCap(this.localSnapshotsProvider(device.sku, device.deviceId)) : [];
    return {
      adapter: "iobroker.govee-smart",
      version: adapterVersion,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      device: {
        sku: device.sku,
        deviceId: device.deviceId,
        name: device.name,
        type: device.type,
        segmentCount: (_a = device.segmentCount) != null ? _a : null,
        channels: { ...device.channels },
        lanIp: (_b = device.lanIp) != null ? _b : null,
        // v2.9.1 — runtime flags / timestamps that were previously invisible
        manualMode: (_c = device.manualMode) != null ? _c : false,
        manualSegments: (_d = device.manualSegments) != null ? _d : null,
        sceneSpeed: (_e = device.sceneSpeed) != null ? _e : null,
        scenesChecked: (_f = device.scenesChecked) != null ? _f : false,
        lastSeenOnNetwork: (_g = device.lastSeenOnNetwork) != null ? _g : null,
        lastLanReplyAt: (_h = device.lastLanReplyAt) != null ? _h : null,
        groupMembers: (_i = device.groupMembers) != null ? _i : null
      },
      capabilities: device.capabilities,
      scenes: {
        count: device.scenes.length,
        names: device.scenes.map((s) => s.name),
        // Cloud-side `value` payload — needed when the dropdown index can't
        // be replayed from name alone (snapshots especially have integer IDs).
        entries: device.scenes.map((s) => ({ name: s.name, value: s.value }))
      },
      diyScenes: {
        count: device.diyScenes.length,
        names: device.diyScenes.map((s) => s.name),
        entries: device.diyScenes.map((s) => ({ name: s.name, value: s.value }))
      },
      snapshots: {
        count: device.snapshots.length,
        names: device.snapshots.map((s) => s.name),
        entries: device.snapshots.map((s) => ({ name: s.name, value: s.value })),
        // v2.9.1 — raw BLE packets per snapshot. THE field for byte-level
        // snapshot debugging (Issue #13, H61A8 tukey42). Previously the only
        // way to get this was to ask the user for the cache file.
        bleCmds: device.snapshotBleCmds ? device.snapshots.map((s, idx) => {
          var _a2, _b2;
          return {
            name: s.name,
            packets: (_b2 = (_a2 = device.snapshotBleCmds) == null ? void 0 : _a2[idx]) != null ? _b2 : []
          };
        }) : []
      },
      sceneLibrary: {
        count: device.sceneLibrary.length,
        // v2.9.1 — full entries with `scenceParam` Base64 + `speedInfo.config`
        // JSON. Old shape (name + sceneCode + hasParam + speedSupported only)
        // hid the very bytes needed to compare working vs broken scene
        // activation between SKUs.
        entries: device.sceneLibrary.map((s) => ({
          name: s.name,
          sceneCode: s.sceneCode,
          scenceParam: s.scenceParam,
          speedInfo: s.speedInfo
        }))
      },
      musicLibrary: {
        count: device.musicLibrary.length,
        entries: device.musicLibrary.map((m) => {
          var _a2;
          return {
            name: m.name,
            musicCode: m.musicCode,
            mode: (_a2 = m.mode) != null ? _a2 : null,
            scenceParam: m.scenceParam
          };
        })
      },
      diyLibrary: {
        count: device.diyLibrary.length,
        entries: device.diyLibrary.map((d) => ({
          name: d.name,
          diyCode: d.diyCode,
          scenceParam: d.scenceParam
        }))
      },
      quirks: quirks != null ? quirks : null,
      skuFeatures: device.skuFeatures,
      state: { ...device.state },
      recentLogs: (_j = b == null ? void 0 : b.logs.slice()) != null ? _j : [],
      lastMqttPackets: (_k = b == null ? void 0 : b.packets.slice()) != null ? _k : [],
      // History per endpoint (most-recent at the end). Each entry has
      // {ts, ok, statusCode, body}. body holds either the success
      // response or `{error, status, responseBody?}` for failed calls.
      apiHistory: b ? Object.fromEntries(Array.from(b.responses.entries()).map(([k, v]) => [k, v.slice()])) : {},
      // v2.9.1 — outgoing LAN UDP datagrams. Closes the "did the adapter
      // even send anything?" diag blind spot for ptReal-driven scene /
      // snapshot / segment commands.
      lanSends: (_l = b == null ? void 0 : b.lanSends.slice()) != null ? _l : [],
      // v2.9.1 — persisted-on-disk view of the SkuCache for this device.
      // Used to compare runtime state to the cache that would be reloaded
      // on next restart. Empty when no cache entry exists yet.
      cache: cacheSnapshot,
      // v2.9.1 — user-saved local snapshots for this device.
      localSnapshots,
      // v2.9.1 — process-wide adapter runtime state: last-error categories
      // per subsystem, rate-limiter usage, live wizard session, LAN-discovery
      // peers. Each field optional (provider may know fewer than all of them).
      runtimeState
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DiagnosticsCollector
});
//# sourceMappingURL=diagnostics.js.map
