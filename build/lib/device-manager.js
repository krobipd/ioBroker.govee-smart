"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_manager_exports = {};
__export(device_manager_exports, {
  DeviceManager: () => DeviceManager,
  SEGMENT_HARD_MAX: () => import_lookups2.SEGMENT_HARD_MAX,
  buildCapabilitiesFromAppEntry: () => import_mapping2.buildCapabilitiesFromAppEntry,
  cloudDeviceToGoveeDevice: () => import_mapping2.cloudDeviceToGoveeDevice,
  parseMqttSegmentData: () => import_lookups2.parseMqttSegmentData,
  resolveSegmentCount: () => import_lookups2.resolveSegmentCount
});
module.exports = __toCommonJS(device_manager_exports);
var import_capability_mapper = require("./capability-mapper");
var import_command_router = require("./command-router");
var import_device_registry = require("./device-registry");
var import_diagnostics = require("./diagnostics");
var import_govee_constants = require("./govee-constants");
var import_log_channel_fail = require("./log-channel-fail");
var import_lookups = require("./device-manager/lookups");
var import_mapping = require("./device-manager/mapping");
var cacheHelpers = __toESM(require("./device-manager/cache"));
var cloudMergeHelpers = __toESM(require("./device-manager/cloud-merge"));
var import_types = require("./types");
var import_http_client = require("./http-client");
var import_lookups2 = require("./device-manager/lookups");
var import_mapping2 = require("./device-manager/mapping");
class DeviceManager {
  /** Public for sub-module helpers (cache, cloud-merge). */
  log;
  /** Public for sub-module helpers (cache, cloud-merge, lookups). */
  devices = /* @__PURE__ */ new Map();
  commandRouter;
  diagnostics;
  /** SKUs we already nudged about — log only once per adapter lifetime, per SKU. */
  nudgedSeedSkus = /* @__PURE__ */ new Set();
  cloudClient = null;
  apiClient = null;
  /** Public for sub-module helpers (cache). */
  skuCache = null;
  /** Public for sub-module helpers (cloud-merge). */
  onDeviceUpdate = null;
  /** Phase-specific callbacks — one per data source. See setCallbacks. */
  onLanDeviceReady = null;
  onCloudDataReady = null;
  onGroupMembersReady = null;
  onCloudCapabilities = null;
  /** Per-source dedup so a Cloud NETWORK error doesn't shadow an App-API one. */
  lastErrorCategory = null;
  /**
   * Dedup state for Cloud REST device-list calls — used by `logChannelFail`
   * so the user-zentrierte warn message fires once per category and drops
   * to debug on repeats. Separate from `lastErrorCategory` (which lives in
   * `logDedup` for group-members + other non-channel errors).
   */
  cloudListDedup = { lastCategory: null };
  lastAppApiErrorCategory = null;
  /** Dedup tracker for `loadGroupMembers` errors — first warn per category, rest debug. */
  lastGroupMembersErrorCategory = null;
  /**
   * @param log    ioBroker logger
   * @param timers Adapter timer wrapper (forwarded to CommandRouter for
   *   onUnload-safe delays).
   */
  constructor(log, timers) {
    this.log = log;
    this.commandRouter = new import_command_router.CommandRouter(log, timers);
    this.diagnostics = new import_diagnostics.DiagnosticsCollector();
    this.commandRouter.onDiagLog = (deviceId, level, msg) => {
      this.diagnostics.addLog(deviceId, level, msg);
    };
  }
  /**
   * Expose the diagnostics collector so adapter-side hooks (MQTT,
   * Cloud, log wrapper) can write into the per-device ring buffers.
   */
  getDiagnostics() {
    return this.diagnostics;
  }
  /**
   * Snapshot of the per-source `lastErrorCategory` trackers — used by the
   * diag runtime-state provider to surface "Cloud-Device-List path keeps
   * failing with TIMEOUT" / "App-API hit RATE_LIMIT last poll" etc.
   *
   * Each entry is a category string or null when the source has never seen
   * a failure (or the last attempt succeeded).
   */
  getErrorCategorySnapshot() {
    return {
      deviceManager: this.lastErrorCategory,
      appApi: this.lastAppApiErrorCategory,
      groupMembers: this.lastGroupMembersErrorCategory
    };
  }
  /**
   * Pull the HTTP status code out of any error shape we know about
   * (HttpError, Govee API responses with `.statusCode` / `.status`).
   * Returns undefined for network errors / generic failures so the
   * diagnostics entry shows "no status — likely network/timeout".
   *
   * @param e Caught error value
   */
  extractStatus(e) {
    if (e instanceof import_http_client.HttpError) {
      return e.statusCode;
    }
    if (typeof e === "object" && e !== null) {
      const x = e;
      if (typeof x.statusCode === "number") {
        return x.statusCode;
      }
      if (typeof x.status === "number") {
        return x.status;
      }
    }
    return void 0;
  }
  /**
   * Structured debug-log for failed undocumented App-API calls. Pulls apart
   * the cryptic "Invalid JSON in HTTP 200 response — body starts with: <snippet>"
   * message into addressable fields so the user can read the actual facts:
   * endpoint URL, HTTP status, bearer-token presence, body snippet.
   * No interpretation — just the data.
   *
   * @param sku Govee SKU (for log context)
   * @param what Human-readable name of the data being loaded
   * @param endpoint Endpoint identifier for diagnostics history
   * @param hasBearer Whether a bearer token was attached to the request
   * @param e Caught error
   */
  logUndocApiFailure(sku, what, endpoint, hasBearer, e) {
    var _a;
    const httpStatus = this.extractStatus(e);
    const msg = (0, import_types.errMessage)(e);
    const bodyMatch = msg.match(/body starts with: (.+)$/);
    const bodySnippet = (_a = bodyMatch == null ? void 0 : bodyMatch[1]) != null ? _a : "";
    const statusPart = httpStatus !== void 0 ? ` httpStatus=${httpStatus}` : "";
    const bodyPart = bodySnippet ? ` body="${bodySnippet}"` : ` error="${msg}"`;
    this.log.debug(
      `Could not load ${what} for ${sku}: endpoint=${endpoint}${statusPart} bearer=${hasBearer ? "yes" : "no"}${bodyPart}`
    );
  }
  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client) {
    this.commandRouter.setLanClient(client);
  }
  /**
   * Register the undocumented API client for scene/music/DIY libraries
   *
   * @param client API client instance
   */
  setApiClient(client) {
    this.apiClient = client;
  }
  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client) {
    this.cloudClient = client;
    this.commandRouter.setCloudClient(client);
  }
  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter) {
    this.commandRouter.setRateLimiter(limiter);
  }
  /**
   * Register the SKU cache for persistent device data
   *
   * @param cache SKU cache instance
   */
  setSkuCache(cache) {
    this.skuCache = cache;
  }
  /**
   * Set the phase-specific callbacks. Each fires when its data source has
   * delivered its part of the picture — never with stale / half-filled data.
   *
   * @param callbacks Phase callbacks. See per-field JSDoc on DeviceManager.
   * @param callbacks.onUpdate Fired when a single device's state-fields change (LAN/MQTT/Cloud value update)
   * @param callbacks.onLanDeviceReady Fired when LAN-Discovery finds a device — only LAN data is available yet
   * @param callbacks.onCloudDataReady Fired when Cloud capabilities are available (cache merge OR live cloud)
   * @param callbacks.onGroupMembersReady Fired when group membership has been resolved via App-API
   */
  setCallbacks(callbacks) {
    this.onDeviceUpdate = callbacks.onUpdate;
    this.onLanDeviceReady = callbacks.onLanDeviceReady;
    this.onCloudDataReady = callbacks.onCloudDataReady;
    this.onGroupMembersReady = callbacks.onGroupMembersReady;
  }
  /** Get all known devices */
  getDevices() {
    return Array.from(this.devices.values());
  }
  /**
   * Remove a device from internal tracking. Called when a device was removed
   * from the Govee account — the jsonl objects are cleaned up by
   * `cleanupDevices` (state-manager); here only the in-memory maps.
   *
   * Returns the deviceId of the dropped device (for diagnostics cleanup), or
   * null if there was nothing to remove.
   *
   * @param sku Govee SKU
   * @param deviceId Device ID (with/without colons)
   */
  removeDevice(sku, deviceId) {
    const key = this.deviceKey(sku, deviceId);
    const dev = this.devices.get(key);
    if (!dev) {
      return null;
    }
    this.devices.delete(key);
    return dev.deviceId;
  }
  /**
   * Load devices from local SKU cache.
   * Returns true if any devices were loaded (= Cloud not needed).
   */
  loadFromCache() {
    if (!this.skuCache) {
      return false;
    }
    const cached = this.skuCache.loadAll();
    if (cached.length === 0) {
      return false;
    }
    const nowMs = Date.now();
    for (const entry of cached) {
      this.applyCachedEntry(entry, nowMs);
    }
    this.log.info(`Loaded ${cached.length} device(s) from cache`);
    const allDevices = this.getDevices();
    this.firePostCachePhaseCallbacks(allDevices);
    const hasLight = allDevices.some((d) => d.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT);
    if (hasLight) {
      this.log.debug("Cache loaded \u2014 will refresh scenes/snapshots via Cloud");
      return false;
    }
    for (const device of this.devices.values()) {
      cacheHelpers.populateScenesFromLibrary(this, device);
    }
    return cached.length > 0;
  }
  /**
   * Apply a single cached entry: merge into LAN-discovered device if present,
   * otherwise create new from cache. Updates segment-specific fields too —
   * LAN discovery runs before cache load on every start, so missing segment
   * fields meant restart threw away wizard/MQTT-learned segment state.
   *
   * @param entry Cached entry from SkuCache
   * @param nowMs Cached `Date.now()` for age calculation across the batch
   */
  applyCachedEntry(entry, nowMs) {
    const key = this.deviceKey(entry.sku, entry.deviceId);
    const existing = this.devices.get(key);
    const ageDays = typeof entry.lastSeenOnNetwork === "number" ? Math.round((nowMs - entry.lastSeenOnNetwork) / 864e5) : null;
    const ageInfo = ageDays === null ? "no age data (legacy entry)" : `${ageDays}d since last seen`;
    if (existing) {
      existing.name = entry.name || existing.name;
      existing.type = entry.type || existing.type;
      existing.capabilities = entry.capabilities;
      existing.scenes = entry.scenes;
      existing.diyScenes = entry.diyScenes;
      existing.snapshots = entry.snapshots;
      existing.sceneLibrary = entry.sceneLibrary;
      existing.musicLibrary = entry.musicLibrary;
      existing.diyLibrary = entry.diyLibrary;
      existing.skuFeatures = entry.skuFeatures;
      existing.snapshotBleCmds = entry.snapshotBleCmds;
      existing.scenesChecked = entry.scenesChecked;
      existing.lastSeenOnNetwork = entry.lastSeenOnNetwork;
      existing.segmentCount = entry.segmentCount;
      existing.manualMode = entry.manualMode;
      existing.manualSegments = entry.manualSegments;
      existing.channels.cloud = entry.capabilities.length > 0;
      this.log.debug(
        `Cache merged into LAN-discovered device ${entry.sku} ${entry.deviceId} (${ageInfo}, caps=${entry.capabilities.length})`
      );
    } else {
      this.devices.set(key, cacheHelpers.cachedToGoveeDevice(entry));
      this.log.debug(
        `Cache restored (no LAN discovery yet) for ${entry.sku} ${entry.deviceId} (${ageInfo}, caps=${entry.capabilities.length})`
      );
    }
  }
  /**
   * Fire per-device phase callback right after cache merge. Devices with
   * non-empty caps go into Cloud-phase immediately (cache counts as Cloud-
   * data-ready); devices without caps stay in LAN-phase. Cloud-Load later
   * refreshes dropdowns/scenes/snapshots via onCloudDataReady again
   * (idempotent).
   *
   * @param allDevices Snapshot from `getDevices()`, computed once by the caller
   */
  firePostCachePhaseCallbacks(allDevices) {
    var _a, _b;
    for (const device of allDevices) {
      if (device.capabilities.length > 0) {
        (_a = this.onCloudDataReady) == null ? void 0 : _a.call(this, device, allDevices);
      } else if (device.lanIp) {
        (_b = this.onLanDeviceReady) == null ? void 0 : _b.call(this, device, allDevices);
      }
    }
  }
  /**
   * Load devices from Cloud API and save to cache.
   * Only called when cache is empty (first start) or manual refresh.
   */
  async loadFromCloud() {
    var _a;
    if (!this.cloudClient) {
      return { ok: false, reason: "transient" };
    }
    try {
      const rawCloudDevices = await this.cloudClient.getDevices();
      const cloudDevices = (0, import_mapping.filterCloudDevicesWithCapabilities)(rawCloudDevices);
      if (Array.isArray(rawCloudDevices) && rawCloudDevices.length !== cloudDevices.length) {
        this.log.info(
          `Cloud: received ${rawCloudDevices.length} devices raw, ${cloudDevices.length} after filter (skipped stale entries without capabilities)`
        );
      }
      let changed = this.mergeCloudDevices(cloudDevices);
      for (const cd of cloudDevices) {
        const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
        const hasSceneCap = (0, import_capability_mapper.hasDynamicSceneCapability)(caps, "lightScene") || (0, import_capability_mapper.hasDynamicSceneCapability)(caps, "diyScene") || (0, import_capability_mapper.hasDynamicSceneCapability)(caps, "snapshot");
        const isLight = cd.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT || hasSceneCap;
        if (isLight) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            if (await this.loadDeviceScenes(device, cd)) {
              changed = true;
            }
            if (await this.loadDeviceLibraries(device, cd.sku)) {
              changed = true;
            }
            device.scenesChecked = true;
          }
        }
      }
      if (cloudDevices.length > 0) {
        const ownedKeys = new Set(cloudDevices.map((cd) => this.deviceKey(cd.sku, cd.device)));
        const removed = [];
        for (const device of this.devices.values()) {
          if (device.sku === "BaseGroup" || device.channels.lan || !device.channels.cloud) {
            continue;
          }
          if (!ownedKeys.has(this.deviceKey(device.sku, device.deviceId))) {
            removed.push(device);
          }
        }
        for (const device of removed) {
          this.log.info(`Removed device ${device.name} (${device.sku}) \u2014 no longer in your Govee account`);
          this.removeDevice(device.sku, device.deviceId);
        }
      }
      if (this.skuCache && cloudDevices.length > 0) {
        this.skuCache.pruneStale(14);
      }
      this.saveDevicesToCache();
      for (const device of this.devices.values()) {
        cacheHelpers.populateScenesFromLibrary(this, device);
      }
      if (changed) {
        const allDevices = this.getDevices();
        for (const device of allDevices) {
          if (device.sku === "BaseGroup") {
            continue;
          }
          (_a = this.onCloudDataReady) == null ? void 0 : _a.call(this, device, allDevices);
        }
      }
      this.lastErrorCategory = null;
      this.cloudListDedup.lastCategory = null;
      return { ok: true };
    } catch (err) {
      (0, import_log_channel_fail.logChannelFail)(this.log, {
        channel: "Cloud REST",
        err,
        context: "loading device list",
        retryHint: "retrying every 5 min",
        dedup: this.cloudListDedup
      });
      if (err instanceof import_http_client.HttpError && err.statusCode === 429) {
        const retryAfterRaw = err.headers["retry-after"];
        const retryAfterSec = typeof retryAfterRaw === "string" && /^\d+$/.test(retryAfterRaw) ? parseInt(retryAfterRaw, 10) : 60;
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterMs: retryAfterSec * 1e3
        };
      }
      const category = (0, import_types.classifyError)(err);
      if (category === "AUTH") {
        return {
          ok: false,
          reason: "auth-failed",
          message: err instanceof Error ? err.message : String(err)
        };
      }
      return { ok: false, reason: "transient" };
    }
  }
  /**
   * Re-fetch scenes, snapshots and libraries for one specific device. Triggered
   * by the per-device `snapshots.refresh_cloud` button ("a new snapshot/scene
   * was saved in the Govee Home app, show it here for THIS light").
   *
   * Three Cloud calls happen in order:
   *   1. `/user/devices` — refreshes the whole capability set including the
   *      authoritative snapshot-options list (this is what was missing in
   *      v2.6.7's refresh path: stale capabilities meant the snapshot fallback
   *      in `loadDeviceScenes` couldn't see new entries).
   *   2. `/device/scenes` + `/device/diy-scenes` (per loadDeviceScenes)
   *   3. `/appsku/v1/light-effect-libraries` × 3 (scene/music/DIY via
   *      loadDeviceLibraries with force=true)
   *
   * Replaces the global `refreshSceneData()` removed in v2.7.0: refreshing all
   * lights cost N*5 Cloud calls vs 5 for the one device the user actually
   * touched. Rate-limit pressure scales linearly with account size.
   *
   * @param deviceId Target device's deviceId (mac-like identifier)
   * @returns true when scene/snapshot/library data changed
   */
  async refreshSceneDataForDevice(deviceId) {
    var _a;
    if (!this.cloudClient) {
      return false;
    }
    const target = Array.from(this.devices.values()).find(
      (d) => (0, import_types.normalizeDeviceId)(d.deviceId) === (0, import_types.normalizeDeviceId)(deviceId)
    );
    if (!target) {
      this.log.debug(`refreshSceneDataForDevice: device ${deviceId} not found`);
      return false;
    }
    this.diagnostics.addLog(target.deviceId, "info", `User-triggered refresh-cloud-data for ${target.sku}`);
    try {
      const rawCloudDevices = await this.cloudClient.getDevices();
      const cloudDevices = (0, import_mapping.filterCloudDevicesWithCapabilities)(rawCloudDevices);
      this.mergeCloudDevices(cloudDevices);
    } catch (e) {
      this.log.debug(`refreshSceneDataForDevice: getDevices failed: ${(0, import_types.errMessage)(e)}`);
    }
    const cd = {
      sku: target.sku,
      device: target.deviceId,
      deviceName: target.name,
      type: target.type,
      capabilities: Array.isArray(target.capabilities) ? target.capabilities : []
    };
    let changed = false;
    if (await this.loadDeviceScenes(target, cd)) {
      changed = true;
    }
    if (await this.loadDeviceLibraries(
      target,
      cd.sku,
      /* force */
      true
    )) {
      changed = true;
    }
    if (changed) {
      this.saveDevicesToCache();
      cacheHelpers.populateScenesFromLibrary(this, target);
      (_a = this.onCloudDataReady) == null ? void 0 : _a.call(this, target, this.getDevices());
    }
    return changed;
  }
  /**
   * Merge Cloud device list into local device map.
   * Updates existing devices, adds new ones.
   *
   * @param cloudDevices Devices from Cloud API
   * @returns true if any new devices were added
   */
  mergeCloudDevices(cloudDevices) {
    return cloudMergeHelpers.mergeCloudDevices(this, cloudDevices);
  }
  /**
   * Load scenes, DIY scenes, and snapshots for a device from Cloud API.
   *
   * @param device Target device to populate
   * @param cd Cloud device data with capabilities
   * @returns true if any scene data changed
   */
  async loadDeviceScenes(device, cd) {
    var _a;
    this.diagnostics.addLog(cd.device, "debug", `loadDeviceScenes called for ${cd.sku}`);
    let scenesCallSucceeded = false;
    let snapsFromScenesCall = [];
    let diyFromScenesCall = [];
    const loadScenes = async () => {
      try {
        const { lightScenes, diyScenes, snapshots } = await this.cloudClient.getScenes(cd.sku, cd.device);
        scenesCallSucceeded = true;
        snapsFromScenesCall = snapshots;
        diyFromScenesCall = diyScenes;
        if (lightScenes.length > 0) {
          device.scenes = lightScenes;
        }
        if (diyScenes.length > 0) {
          device.diyScenes = diyScenes;
        }
      } catch (e) {
        this.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/scenes", e, this.extractStatus(e));
        this.log.debug(`Could not load scenes for ${cd.sku}: ${(0, import_types.errMessage)(e)}`);
      }
    };
    await this.commandRouter.executeRateLimited(loadScenes, 2);
    if (diyFromScenesCall.length === 0) {
      const loadDiy = async () => {
        try {
          const diy = await this.cloudClient.getDiyScenes(cd.sku, cd.device);
          if (diy.length > 0) {
            device.diyScenes = diy;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/diy-scenes", e, this.extractStatus(e));
          this.log.debug(`Could not load DIY scenes for ${cd.sku}: ${(0, import_types.errMessage)(e)}`);
        }
      };
      await this.commandRouter.executeRateLimited(loadDiy, 2);
    }
    if (snapsFromScenesCall.length > 0) {
      device.snapshots = snapsFromScenesCall;
    } else if (scenesCallSucceeded) {
      const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      const snapCap = caps.find(
        (c) => {
          var _a2;
          return c && c.type === import_govee_constants.GOVEE_CAP_TYPE.DYNAMIC_SCENE && c.instance === "snapshot" && Array.isArray((_a2 = c.parameters) == null ? void 0 : _a2.options);
        }
      );
      if ((_a = snapCap == null ? void 0 : snapCap.parameters) == null ? void 0 : _a.options) {
        device.snapshots = snapCap.parameters.options.filter((o) => o && typeof o.name === "string" && o.value !== void 0 && o.value !== null).map((o) => ({
          name: o.name,
          value: typeof o.value === "number" ? o.value : o.value
        }));
        this.log.debug(`Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`);
      }
    }
    return device.scenes.length > 0 || device.diyScenes.length > 0 || device.snapshots.length > 0;
  }
  /**
   * Load scene/music/DIY libraries and SKU features from undocumented API.
   *
   * Each fetch runs through the rate-limiter so a fresh install with 10
   * devices doesn't slam app2.govee.com with 40 back-to-back requests —
   * those endpoints are undocumented and aggressive callers can get the
   * account temporarily locked.
   *
   * @param device Target device to populate
   * @param sku Product model
   * @param force When true, refetch every endpoint regardless of cache —
   *   used by the user-triggered refresh button so a stale library
   *   actually gets replaced
   * @returns true if any library data changed
   */
  async loadDeviceLibraries(device, sku, force = false) {
    if (!this.apiClient) {
      return false;
    }
    this.diagnostics.addLog(device.deviceId, "debug", `loadDeviceLibraries called for ${sku} (force=${force})`);
    let changed = false;
    const runLimited = async (fn) => {
      await this.commandRouter.executeRateLimited(fn, 2);
    };
    const hasBearer = this.apiClient.hasBearerToken();
    if (force || device.sceneLibrary.length === 0) {
      await runLimited(async () => {
        const ep = `/light-effect-libraries?sku=${sku}`;
        try {
          const lib = await this.apiClient.fetchSceneLibrary(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `Scene library for ${sku}: ${lib.length} scene(s)${lib.length === 0 ? " \u2014 empty (Govee returned no data for this SKU)" : ""}`
          );
          if (lib.length > 0) {
            device.sceneLibrary = lib;
            changed = true;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "scene library", ep, hasBearer, e);
        }
      });
    }
    if (force || device.musicLibrary.length === 0) {
      await runLimited(async () => {
        const ep = `/light-effect-libraries-music?sku=${sku}`;
        try {
          const lib = await this.apiClient.fetchMusicLibrary(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `Music library for ${sku}: ${lib.length} mode(s)${lib.length === 0 ? " \u2014 empty (Govee returned no data for this SKU)" : ""}`
          );
          if (lib.length > 0) {
            device.musicLibrary = lib;
            changed = true;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "music library", ep, hasBearer, e);
        }
      });
    }
    if (force || device.diyLibrary.length === 0) {
      await runLimited(async () => {
        const ep = `/diy-effect-libraries?sku=${sku}`;
        try {
          const lib = await this.apiClient.fetchDiyLibrary(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `DIY library for ${sku}: ${lib.length} effect(s)${lib.length === 0 ? " \u2014 empty (Govee returned no data for this SKU)" : ""}`
          );
          if (lib.length > 0) {
            device.diyLibrary = lib;
            changed = true;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "DIY library", ep, hasBearer, e);
        }
      });
    }
    if (force || !device.skuFeatures) {
      await runLimited(async () => {
        const ep = `/sku-features?sku=${sku}`;
        try {
          const features = await this.apiClient.fetchSkuFeatures(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, features);
          if (features) {
            device.skuFeatures = features;
            changed = true;
            this.log.debug(`SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`);
          } else {
            this.log.debug(`SKU features for ${sku}: null \u2014 Govee returned no data for this SKU`);
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "SKU features", ep, hasBearer, e);
        }
      });
    }
    if ((force || !device.snapshotBleCmds) && device.snapshots.length > 0) {
      await runLimited(async () => {
        const ep = `/bff-app/v1/devices/snapshots?sku=${sku}`;
        try {
          const snaps = await this.apiClient.fetchSnapshots(sku, device.deviceId);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, snaps);
          this.log.debug(
            `Snapshot BLE for ${sku}: ${snaps.length} snapshot(s) with local data${snaps.length === 0 ? " \u2014 Govee returned no BLE-cmds for this SKU/device" : ""}`
          );
          if (snaps.length > 0) {
            device.snapshotBleCmds = device.snapshots.map((ds) => {
              var _a;
              const match = snaps.find((s) => s.name === ds.name);
              return (_a = match == null ? void 0 : match.bleCmds) != null ? _a : [];
            });
            changed = true;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "snapshot BLE", ep, hasBearer, e);
        }
      });
    }
    return changed;
  }
  /**
   * Load group membership from undocumented API and attach to BaseGroup devices.
   * Resolves member device references against the current device map.
   *
   * @returns true if any group memberships were resolved
   */
  async loadGroupMembers() {
    var _a;
    if (!this.apiClient) {
      return false;
    }
    if (!this.apiClient.hasBearerToken()) {
      this.log.debug("Group membership requires Email+Password \u2014 skipping member resolution");
      return false;
    }
    const ep = "/bff-app/v1/exec-plat/home";
    try {
      const apiGroups = await this.apiClient.fetchGroupMembers();
      for (const group of this.devices.values()) {
        if (group.sku === "BaseGroup") {
          const apiGroup = apiGroups.find((g) => String(g.groupId) === group.deviceId);
          this.diagnostics.recordApiSuccess(
            group.deviceId,
            ep,
            apiGroup != null ? apiGroup : { resolved: false, groupId: group.deviceId }
          );
        }
      }
      if (apiGroups.length === 0) {
        this.log.debug("No group membership data from API");
        return false;
      }
      let changed = false;
      for (const group of this.devices.values()) {
        if (group.sku !== "BaseGroup") {
          continue;
        }
        const apiGroup = apiGroups.find((g) => String(g.groupId) === group.deviceId);
        if (!apiGroup) {
          continue;
        }
        const members = [];
        for (const m of apiGroup.devices) {
          const resolved = this.findDeviceBySkuAndId(m.sku, m.deviceId);
          if (resolved) {
            members.push({ sku: resolved.sku, deviceId: resolved.deviceId });
          } else {
            this.log.debug(`Group "${group.name}": member ${m.sku}/${m.deviceId} not in device map`);
          }
        }
        group.groupMembers = members;
        if (members.length > 0) {
          changed = true;
        }
        this.log.debug(`Group "${group.name}": ${members.length}/${apiGroup.devices.length} members resolved`);
      }
      if (changed) {
        const allDevices = this.getDevices();
        for (const group of allDevices.filter((d) => d.sku === "BaseGroup")) {
          (_a = this.onGroupMembersReady) == null ? void 0 : _a.call(this, group, allDevices);
        }
      }
      this.lastGroupMembersErrorCategory = null;
      return changed;
    } catch (e) {
      const status = this.extractStatus(e);
      for (const group of this.devices.values()) {
        if (group.sku === "BaseGroup") {
          this.diagnostics.recordApiFailure(group.deviceId, ep, e, status);
        }
      }
      this.lastGroupMembersErrorCategory = (0, import_types.logDedup)(
        this.log,
        this.lastGroupMembersErrorCategory,
        "Group membership",
        e
      );
      return false;
    }
  }
  /** Save all devices to SKU cache, skipping only those never confirmed via Cloud yet. */
  saveDevicesToCache() {
    cacheHelpers.saveDevicesToCache(this);
  }
  /**
   * Handle LAN device discovery — match against known devices or create new.
   *
   * @param lanDevice Discovered LAN device
   */
  handleLanDiscovery(lanDevice) {
    const matched = this.findDeviceForLanDiscovery(lanDevice);
    if (matched) {
      this.applyLanDiscoveryToExisting(matched, lanDevice);
    } else {
      this.createLanOnlyDevice(lanDevice);
    }
  }
  /**
   * Locate the in-memory device that matches an incoming LAN-discovery
   * frame. Primary key is the normalized deviceId; falls back to SKU only
   * when EXACTLY ONE same-SKU device without lanIp exists — otherwise the
   * wrong same-SKU device would get bound (`feedback_doppel_audit_pattern`).
   *
   * @param lanDevice Discovery frame from the LAN client
   */
  findDeviceForLanDiscovery(lanDevice) {
    for (const dev of this.devices.values()) {
      if ((0, import_types.normalizeDeviceId)(dev.deviceId) === (0, import_types.normalizeDeviceId)(lanDevice.device)) {
        return dev;
      }
    }
    const skuMatches = Array.from(this.devices.values()).filter((dev) => dev.sku === lanDevice.sku && !dev.lanIp);
    return skuMatches.length === 1 ? skuMatches[0] : void 0;
  }
  /**
   * Apply LAN-discovery data (IP, reachability, freshness) to an existing
   * device. Marks it online and fires `onDeviceUpdate` if it was offline —
   * a discovery reply proves the device is on the network; without this path
   * info.online stays forever false for cached lights (MQTT only pushes on
   * state changes, main.ts skips the devStatus poll when MQTT is up).
   *
   * @param matched The existing device to update
   * @param lanDevice Discovery frame
   */
  applyLanDiscoveryToExisting(matched, lanDevice) {
    var _a, _b, _c;
    const hadNoLanIp = !matched.lanIp;
    const ipChanged = matched.lanIp !== lanDevice.ip;
    const wasOffline = matched.state.online !== true;
    matched.lanIp = lanDevice.ip;
    matched.channels.lan = true;
    matched.lastSeenOnNetwork = Date.now();
    matched.lastLanReplyAt = Date.now();
    if (hadNoLanIp) {
      (_a = this.onLanDeviceReady) == null ? void 0 : _a.call(this, matched, this.getDevices());
    }
    if (ipChanged) {
      this.log.debug(`LAN: ${matched.name} (${matched.sku}) at ${lanDevice.ip}`);
      (_b = this.onLanIpChanged) == null ? void 0 : _b.call(this, matched, lanDevice.ip);
    }
    if (wasOffline) {
      matched.state.online = true;
      (_c = this.onDeviceUpdate) == null ? void 0 : _c.call(this, matched, { online: true });
    }
  }
  /**
   * Create a new device record from a LAN discovery frame for a device that
   * has no Cloud data yet. Capabilities stay empty; Cloud-phase fires later
   * from cache-merge or loadFromCloud once caps arrive. Before v2.8.0 this
   * fired a bulk onDeviceListChanged that triggered a wipe-and-recreate bug
   * (Issue #13).
   *
   * @param lanDevice Discovery frame
   */
  createLanOnlyDevice(lanDevice) {
    var _a;
    const shortId = (0, import_types.normalizeDeviceId)(lanDevice.device).slice(-4);
    const device = {
      sku: lanDevice.sku,
      deviceId: lanDevice.device,
      name: `${lanDevice.sku}_${shortId}`,
      type: import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT,
      lanIp: lanDevice.ip,
      capabilities: [],
      scenes: [],
      diyScenes: [],
      snapshots: [],
      sceneLibrary: [],
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
      lastSeenOnNetwork: Date.now(),
      state: { online: true },
      channels: { lan: true, mqtt: false, cloud: false }
    };
    this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
    this.diagnostics.addLog(lanDevice.device, "info", `LAN-discovered at ${lanDevice.ip}`);
    this.log.debug(
      `LAN: new device sku=${lanDevice.sku} deviceId=${lanDevice.device} ip=${lanDevice.ip} reachable=yes`
    );
    this.maybeNudgeSeedSku(lanDevice.sku, device.name);
    (_a = this.onLanDeviceReady) == null ? void 0 : _a.call(this, device, this.getDevices());
  }
  /**
   * Log the device's trust tier — once per SKU per adapter lifetime, so
   * device reconnects don't spam the log. Behaviour by tier:
   *   - verified / reported: silent (the catalog backs the device, no
   *     action needed). The tier is still surfaced via the
   *     `diag.tier` state for any user who wants to check.
   *   - seed (toggle off): warn — points the user at the experimental
   *     toggle that gates the per-SKU corrections we'd otherwise apply.
   *   - seed (toggle on): info — confirms quirks are active.
   *   - unknown: warn — asks for a diagnostics export so we can add the
   *     SKU to the catalogue.
   *
   * @param sku Govee SKU
   * @param displayName Device name as shown in Govee Home
   */
  maybeNudgeSeedSku(sku, displayName) {
    const upper = (typeof sku === "string" ? sku : "").toUpperCase();
    if (!upper || this.nudgedSeedSkus.has(upper)) {
      return;
    }
    this.nudgedSeedSkus.add(upper);
    const tier = (0, import_device_registry.getDeviceTier)(upper);
    const label = displayName ? `${displayName} (${upper})` : upper;
    switch (tier) {
      case "verified":
      case "reported":
        return;
      case "seed":
        if ((0, import_device_registry.isSeedAndDormant)(upper)) {
          this.log.warn(
            `Device ${label} is in beta and needs the "Enable experimental device support" toggle in adapter settings to apply known per-SKU corrections.`
          );
        } else {
          this.log.info(`Device ${label} is in beta \u2014 experimental quirks are active.`);
        }
        return;
      case "unknown":
        this.log.warn(
          `Device ${label} is not in the supported device list. Please trigger diag.export and post the resulting JSON in a GitHub issue so the SKU can be added.`
        );
        return;
    }
  }
  /**
   * Handle MQTT status update — update device state.
   *
   * @param update MQTT status message
   */
  handleMqttStatus(update) {
    var _a, _b;
    const device = this.findDeviceBySkuAndId(update.sku, update.device);
    if (!device) {
      this.log.debug(`MQTT: Unknown device ${update.sku} ${update.device}`);
      return;
    }
    device.channels.mqtt = true;
    device.lastSeenOnNetwork = Date.now();
    const state = this.parseMqttStateUpdate(device, update);
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
    if ((_b = update.op) == null ? void 0 : _b.command) {
      this.processMqttSegmentPacket(device, update.op.command);
    }
  }
  /**
   * Translate an MQTT status payload into a `DeviceState` patch. API-Boundary
   * defense: Govee occasionally sends brightness/onOff/color as a string —
   * `coerceFiniteNumber` returns null on drift, leaving the field unchanged
   * instead of writing it with a broken value.
   *
   * MQTT-push proves the device talked to the Govee broker — but the broker
   * can replay last-will/retained messages. For Lights, info.online comes
   * ONLY from LAN-direct replies (`StateManager.syncInfoOnline`). MQTT-push
   * still updates power/brightness/color but does NOT flip online for Lights.
   *
   * @param device Target device (for type-check on online-flip)
   * @param update MQTT status update from the AWS-IoT subscription
   */
  parseMqttStateUpdate(device, update) {
    const state = {};
    if (device.type !== import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT) {
      state.online = true;
    }
    if (!update.state) {
      return state;
    }
    const onOff = (0, import_types.coerceFiniteNumber)(update.state.onOff);
    if (onOff !== null) {
      state.power = onOff === 1;
    }
    const brightness = (0, import_types.coerceFiniteNumber)(update.state.brightness);
    if (brightness !== null) {
      state.brightness = brightness;
    }
    if (update.state.color && typeof update.state.color === "object") {
      const r = (0, import_types.coerceFiniteNumber)(update.state.color.r);
      const g = (0, import_types.coerceFiniteNumber)(update.state.color.g);
      const b = (0, import_types.coerceFiniteNumber)(update.state.color.b);
      if (r !== null && g !== null && b !== null) {
        state.colorRgb = (0, import_types.rgbToHex)(r, g, b);
      }
    }
    const ctk = (0, import_types.coerceFiniteNumber)(update.state.colorTemInKelvin);
    if (ctk !== null && ctk > 0) {
      state.colorTemperature = ctk;
    }
    return state;
  }
  /**
   * Parse per-segment data from a BLE notification packet (AA A5) and either
   * grow the segment tree if the device just reported a higher index than
   * known, or forward filtered per-segment updates to the state-tree.
   * MQTT is authoritative for segment count — the device tells us what it
   * actually has; Cloud only gives an initial best-guess from capabilities.
   *
   * @param device Target device (segmentCount + manualSegments owner)
   * @param opCommand Raw `op.command` payload from the MQTT update (string[] when AA A5)
   */
  processMqttSegmentPacket(device, opCommand) {
    var _a, _b, _c;
    const segData = (0, import_lookups.parseMqttSegmentData)(opCommand);
    if (segData.length === 0) {
      return;
    }
    const maxSeen = Math.max(...segData.map((s) => s.index)) + 1;
    const current = (_a = device.segmentCount) != null ? _a : 0;
    if (maxSeen > import_lookups.SEGMENT_HARD_MAX) {
      this.log.debug(`${device.name}: ignoring segmentCount=${maxSeen} (above protocol limit ${import_lookups.SEGMENT_HARD_MAX})`);
      return;
    }
    if (maxSeen > current) {
      this.log.info(`${device.name}: detected ${maxSeen} segments via MQTT (was ${current}) \u2014 rebuilding state tree`);
      device.segmentCount = maxSeen;
      if (this.skuCache) {
        this.skuCache.save(cacheHelpers.goveeDeviceToCached(device));
      }
      (_b = this.onSegmentCountGrown) == null ? void 0 : _b.call(this, device);
      return;
    }
    const filtered = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? segData.filter((s) => device.manualSegments.includes(s.index)) : segData;
    if (filtered.length > 0) {
      (_c = this.onMqttSegmentUpdate) == null ? void 0 : _c.call(this, device, filtered);
    }
  }
  /**
   * Handle LAN status response.
   *
   * @param ip Source IP address
   * @param status LAN status data
   * @param status.onOff Power state (1=on, 0=off)
   * @param status.brightness Brightness 0-100
   * @param status.color RGB color values
   * @param status.color.r Red channel 0-255
   * @param status.color.g Green channel 0-255
   * @param status.color.b Blue channel 0-255
   * @param status.colorTemInKelvin Color temperature in Kelvin
   */
  handleLanStatus(ip, status) {
    var _a;
    let device;
    for (const dev of this.devices.values()) {
      if (dev.lanIp === ip) {
        device = dev;
        break;
      }
    }
    if (!device) {
      return;
    }
    device.lastSeenOnNetwork = Date.now();
    device.lastLanReplyAt = Date.now();
    const { r, g, b } = status.color;
    const state = {
      online: true,
      power: status.onOff === 1,
      brightness: status.brightness,
      colorRgb: (0, import_types.rgbToHex)(r, g, b),
      colorTemperature: status.colorTemInKelvin || void 0
    };
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
  }
  /**
   * Set the callback for batch segment state sync.
   * Forwards to the internal CommandRouter.
   *
   * @param callback Called when a segment batch command updates segment states
   */
  set onSegmentBatchUpdate(callback) {
    this.commandRouter.onSegmentBatchUpdate = callback;
  }
  /**
   * Send a command to a device — routes through LAN → Cloud.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCommand(device, command, value) {
    return this.commandRouter.sendCommand(device, command, value);
  }
  /**
   * Send a generic capability command via Cloud API.
   * Used for capability types not explicitly handled (toggle, dynamic_scene, etc.)
   *
   * @param device Target device
   * @param capabilityType Full capability type (e.g. "devices.capabilities.toggle")
   * @param capabilityInstance Capability instance name (e.g. "gradientToggle")
   * @param value Command value
   */
  async sendCapabilityCommand(device, capabilityType, capabilityInstance, value) {
    return this.commandRouter.sendCapabilityCommand(device, capabilityType, capabilityInstance, value);
  }
  /** Callback when device LAN IP changes */
  onLanIpChanged;
  /** Callback when MQTT delivers per-segment state data (AA A5 BLE packets) */
  onMqttSegmentUpdate;
  /**
   * Callback when the device's physical segment count turns out to be
   * larger than the Cloud-reported value (observed via MQTT AA A5 stream).
   * The adapter rebuilds the state tree in response so the extra indices
   * appear as datapoints.
   */
  onSegmentCountGrown;
  /**
   * Find device by SKU and device ID (handles format differences)
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  findDeviceBySkuAndId(sku, deviceId) {
    return (0, import_lookups.findDeviceBySkuAndId)(this.devices, sku, deviceId);
  }
  /**
   * Generate unique key for a device
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  deviceKey(sku, deviceId) {
    return (0, import_lookups.deviceKey)(sku, deviceId);
  }
  /**
   * Persist a device's current runtime state to the SKU cache. Safe no-op
   * when no cache is configured.
   *
   * @param device Target device
   */
  persistDeviceToCache(device) {
    cacheHelpers.persistDeviceToCache(this, device);
  }
  /**
   * Generate diagnostics data for a device — structured JSON for GitHub
   * issue submission. Delegates to the DiagnosticsCollector so the JSON
   * also includes ring-buffer context (recent logs, MQTT packets, last
   * API responses).
   *
   * @param device Target device
   * @param adapterVersion Adapter version string
   */
  generateDiagnostics(device, adapterVersion) {
    return this.diagnostics.generate(device, adapterVersion);
  }
  /**
   * Poll the undocumented app-API for sensor-like devices (H5179 et al.)
   * where OpenAPI v2 `/device/state` returns empty. Each entry is converted
   * to synthetic capabilities and routed back through the same callback as
   * regular Cloud state, so the existing setState pipeline picks it up
   * without a special-case branch.
   *
   * Bearer token comes from the MQTT login flow — without MQTT credentials
   * (Email + Password) this is a no-op.
   *
   * @returns Number of devices that received an update
   */
  async pollAppApi() {
    if (!this.apiClient || !this.apiClient.hasBearerToken()) {
      return 0;
    }
    if (!this.hasDeviceNeedingAppApi()) {
      return 0;
    }
    let entries;
    try {
      entries = await this.apiClient.fetchDeviceList();
    } catch (err) {
      const category = (0, import_types.classifyError)(err);
      const msg = `App API fetch failed: ${(0, import_types.errMessage)(err)}`;
      if (category !== this.lastAppApiErrorCategory) {
        this.lastAppApiErrorCategory = category;
        this.log.warn(msg);
      } else {
        this.log.debug(msg);
      }
      return 0;
    }
    this.lastAppApiErrorCategory = null;
    const results = await Promise.all(
      entries.map(
        (entry) => Promise.resolve().then(() => {
          var _a;
          const device = this.devices.get(this.deviceKey(entry.sku, entry.device));
          if (!device) {
            return false;
          }
          const caps = (0, import_mapping.buildCapabilitiesFromAppEntry)(entry);
          if (caps.length === 0) {
            return false;
          }
          (_a = this.onCloudCapabilities) == null ? void 0 : _a.call(this, device, caps);
          if (device.type !== import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT || !device.lanIp) {
            this.applyOnlineCap(device, caps);
          }
          this.diagnostics.recordApiSuccess(device.deviceId, "/device/rest/devices/v1/list", entry);
          return true;
        })
      )
    );
    return results.filter(Boolean).length;
  }
  /**
   * Pull the `devices.capabilities.online` entry (if any) out of a
   * synthetic capability list and apply it directly to
   * `device.state.online` plus `lastSeenOnNetwork`. Surfaces via
   * onDeviceUpdate so the adapter's `info.online` state matches the
   * App-API / OpenAPI-MQTT signal. If no online cap is in the list but
   * the list is non-empty (i.e. fresh data arrived), the device is
   * considered online — same convention as the LAN/MQTT paths.
   *
   * @param device Target device
   * @param caps Capability list from the source pipeline
   */
  applyOnlineCap(device, caps) {
    cloudMergeHelpers.applyOnlineCap(this, device, caps);
  }
  /**
   * Hook callback for sources that emit `CloudStateCapability[]` updates
   * outside the normal Cloud-poll path (App-API, OpenAPI-MQTT). Caller is
   * responsible for wiring it to the adapter-side state-write path.
   *
   * @param cb Callback receiving (device, caps)
   */
  setOnCloudCapabilities(cb) {
    this.onCloudCapabilities = cb;
  }
  /**
   * Whether at least one device in the registry would consume App-API
   * readings (sensors, appliances). Used to skip the App-API poll on
   * Lights-only installations, and as a checkAllReady gate so "ready" is
   * only logged once sensor values can actually arrive.
   */
  hasDeviceNeedingAppApi() {
    for (const dev of this.devices.values()) {
      if (dev.type !== import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && dev.sku !== "BaseGroup") {
        return true;
      }
    }
    return false;
  }
  /**
   * Process a parsed OpenAPI-MQTT event by forwarding its capabilities
   * through the same hook used by App-API polls. Called from the
   * adapter-side OpenAPI-MQTT message handler.
   *
   * @param event Parsed event from the OpenAPI-MQTT broker
   * @param event.sku Govee SKU (e.g. "H5179")
   * @param event.device MAC-style device identifier
   * @param event.capabilities Capability list synthesised from the broker payload
   */
  handleOpenApiEvent(event) {
    var _a;
    if (!event || typeof event.sku !== "string" || typeof event.device !== "string") {
      return;
    }
    if (!Array.isArray(event.capabilities) || event.capabilities.length === 0) {
      return;
    }
    const device = this.devices.get(this.deviceKey(event.sku, event.device));
    if (!device) {
      return;
    }
    const capSummary = event.capabilities.map((c) => {
      var _a2, _b, _c;
      return `${(_b = (_a2 = c.type) == null ? void 0 : _a2.replace("devices.capabilities.", "")) != null ? _b : "?"}/${(_c = c.instance) != null ? _c : "?"}`;
    }).join(", ");
    this.diagnostics.addLog(
      device.deviceId,
      "debug",
      `OpenAPI-MQTT event for ${device.sku}: ${event.capabilities.length} cap(s) [${capSummary}]`
    );
    (_a = this.onCloudCapabilities) == null ? void 0 : _a.call(this, device, event.capabilities);
    if (device.type !== import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT || !device.lanIp) {
      this.applyOnlineCap(device, event.capabilities);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceManager,
  SEGMENT_HARD_MAX,
  buildCapabilitiesFromAppEntry,
  cloudDeviceToGoveeDevice,
  parseMqttSegmentData,
  resolveSegmentCount
});
//# sourceMappingURL=device-manager.js.map
