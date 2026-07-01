import { hasDynamicSceneCapability } from "./capability-mapper";
import { CommandRouter } from "./command-router";
import { getDeviceTier, isSeedAndDormant } from "./device-registry";
import { DiagnosticsCollector } from "./diagnostics";
import { GOVEE_CAP_TYPE, GOVEE_DEVICE_TYPE } from "./govee-constants";
import { logChannelFail, type ChannelDedupState } from "./log-channel-fail";
import {
  deviceKey as deviceKeyHelper,
  findDeviceBySkuAndId as findDeviceBySkuAndIdHelper,
  parseMqttSegmentData,
  SEGMENT_HARD_MAX,
  type MqttSegmentData,
} from "./device-manager/lookups";
import {
  buildCapabilitiesFromAppEntry as buildCapabilitiesFromAppEntryHelper,
  filterCloudDevicesWithCapabilities,
} from "./device-manager/mapping";
import * as cacheHelpers from "./device-manager/cache";
import * as cloudMergeHelpers from "./device-manager/cloud-merge";
import type { AppDeviceEntry, GoveeApiClient } from "./govee-api-client";
import type { GoveeCloudClient } from "./govee-cloud-client";
import type { GoveeLanClient } from "./govee-lan-client";
import type { RateLimiter } from "./rate-limiter";
import type { CachedDeviceData, SkuCache } from "./sku-cache";
import {
  classifyError,
  coerceFiniteNumber,
  logDedup,
  normalizeDeviceId,
  rgbToHex,
  type CloudDevice,
  type CloudLoadResult,
  type CloudScene,
  type CloudStateCapability,
  type DeviceState,
  type ErrorCategory,
  type GoveeDevice,
  type LanDevice,
  type MqttStatusUpdate,
  type TimerAdapter,
  errMessage,
} from "./types";
import { HttpError } from "./http-client";

// Re-export for backwards compat — consumers (main.ts, segment-wizard, state-manager)
// import these directly from "./device-manager".
export {
  parseMqttSegmentData,
  resolveSegmentCount,
  SEGMENT_HARD_MAX,
  type MqttSegmentData,
} from "./device-manager/lookups";
export { buildCapabilitiesFromAppEntry, cloudDeviceToGoveeDevice } from "./device-manager/mapping";

/**
 * Device manager — maintains unified device list and routes commands
 * through the fastest available channel: LAN → Cloud.
 * MQTT is status-push only and never used for commands.
 */
export class DeviceManager {
  /** Public for sub-module helpers (cache, cloud-merge). */
  public readonly log: ioBroker.Logger;
  /** Public for sub-module helpers (cache, cloud-merge, lookups). */
  public readonly devices = new Map<string, GoveeDevice>();
  private readonly commandRouter: CommandRouter;
  private readonly diagnostics: DiagnosticsCollector;
  /** SKUs we already nudged about — log only once per adapter lifetime, per SKU. */
  private readonly nudgedSeedSkus = new Set<string>();
  private cloudClient: GoveeCloudClient | null = null;
  private apiClient: GoveeApiClient | null = null;
  /** Public for sub-module helpers (cache). */
  public skuCache: SkuCache | null = null;
  /** Public for sub-module helpers (cloud-merge). */
  public onDeviceUpdate: ((device: GoveeDevice, state: Partial<DeviceState>) => void) | null = null;
  /** Phase-specific callbacks — one per data source. See setCallbacks. */
  public onLanDeviceReady: ((device: GoveeDevice, allDevices: GoveeDevice[]) => void) | null = null;
  public onCloudDataReady: ((device: GoveeDevice, allDevices: GoveeDevice[]) => void) | null = null;
  public onGroupMembersReady: ((group: GoveeDevice, allDevices: GoveeDevice[]) => void) | null = null;
  private onCloudCapabilities: ((device: GoveeDevice, caps: CloudStateCapability[]) => void) | null = null;
  /** Per-source dedup so a Cloud NETWORK error doesn't shadow an App-API one. */
  private lastErrorCategory: ErrorCategory | null = null;
  /**
   * Dedup state for Cloud REST device-list calls — used by `logChannelFail`
   * so the user-zentrierte warn message fires once per category and drops
   * to debug on repeats. Separate from `lastErrorCategory` (which lives in
   * `logDedup` for group-members + other non-channel errors).
   */
  private cloudListDedup: ChannelDedupState = { lastCategory: null };
  private lastAppApiErrorCategory: ErrorCategory | null = null;
  /** Dedup tracker for `loadGroupMembers` errors — first warn per category, rest debug. */
  private lastGroupMembersErrorCategory: ErrorCategory | null = null;

  /**
   * @param log    ioBroker logger
   * @param timers Adapter timer wrapper (forwarded to CommandRouter for
   *   onUnload-safe delays).
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
    this.log = log;
    this.commandRouter = new CommandRouter(log, timers);
    this.diagnostics = new DiagnosticsCollector();
    // v2.9.1 — funnel command-router routing decisions into the per-device
    // diag ring buffer. Without this, "I clicked but nothing happened" was
    // not triage-able from diag JSON alone — the channel decision lived
    // only in the adapter log.
    this.commandRouter.onDiagLog = (deviceId, level, msg) => {
      this.diagnostics.addLog(deviceId, level, msg);
    };
  }

  /**
   * Expose the diagnostics collector so adapter-side hooks (MQTT,
   * Cloud, log wrapper) can write into the per-device ring buffers.
   */
  getDiagnostics(): DiagnosticsCollector {
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
  getErrorCategorySnapshot(): {
    deviceManager: ErrorCategory | null;
    appApi: ErrorCategory | null;
    groupMembers: ErrorCategory | null;
  } {
    return {
      deviceManager: this.lastErrorCategory,
      appApi: this.lastAppApiErrorCategory,
      groupMembers: this.lastGroupMembersErrorCategory,
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
  private extractStatus(e: unknown): number | undefined {
    if (e instanceof HttpError) {
      return e.statusCode;
    }
    if (typeof e === "object" && e !== null) {
      const x = e as { statusCode?: unknown; status?: unknown };
      if (typeof x.statusCode === "number") {
        return x.statusCode;
      }
      if (typeof x.status === "number") {
        return x.status;
      }
    }
    return undefined;
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
  private logUndocApiFailure(sku: string, what: string, endpoint: string, hasBearer: boolean, e: unknown): void {
    const httpStatus = this.extractStatus(e);
    const msg = errMessage(e);
    // http-client formats invalid-JSON-200 errors as "...body starts with: <snippet>"
    const bodyMatch = msg.match(/body starts with: (.+)$/);
    const bodySnippet = bodyMatch?.[1] ?? "";
    const statusPart = httpStatus !== undefined ? ` httpStatus=${httpStatus}` : "";
    const bodyPart = bodySnippet ? ` body="${bodySnippet}"` : ` error="${msg}"`;
    this.log.debug(
      `Could not load ${what} for ${sku}: endpoint=${endpoint}${statusPart} bearer=${hasBearer ? "yes" : "no"}${bodyPart}`,
    );
  }

  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client: GoveeLanClient): void {
    this.commandRouter.setLanClient(client);
  }

  /**
   * Register the undocumented API client for scene/music/DIY libraries
   *
   * @param client API client instance
   */
  setApiClient(client: GoveeApiClient): void {
    this.apiClient = client;
  }

  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client: GoveeCloudClient): void {
    this.cloudClient = client;
    this.commandRouter.setCloudClient(client);
  }

  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter: RateLimiter): void {
    this.commandRouter.setRateLimiter(limiter);
  }

  /**
   * Register the SKU cache for persistent device data
   *
   * @param cache SKU cache instance
   */
  setSkuCache(cache: SkuCache): void {
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
  setCallbacks(callbacks: {
    onUpdate: (device: GoveeDevice, state: Partial<DeviceState>) => void;
    onLanDeviceReady: (device: GoveeDevice, allDevices: GoveeDevice[]) => void;
    onCloudDataReady: (device: GoveeDevice, allDevices: GoveeDevice[]) => void;
    onGroupMembersReady: (group: GoveeDevice, allDevices: GoveeDevice[]) => void;
  }): void {
    this.onDeviceUpdate = callbacks.onUpdate;
    this.onLanDeviceReady = callbacks.onLanDeviceReady;
    this.onCloudDataReady = callbacks.onCloudDataReady;
    this.onGroupMembersReady = callbacks.onGroupMembersReady;
  }

  /** Get all known devices */
  getDevices(): GoveeDevice[] {
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
  removeDevice(sku: string, deviceId: string): string | null {
    const key = this.deviceKey(sku, deviceId);
    const dev = this.devices.get(key);
    if (!dev) {
      return null;
    }
    this.devices.delete(key);
    // nudgedSeedSkus stays — we don't want to push the seed hint again if the
    // same SKU pops back in later.
    return dev.deviceId;
  }

  /**
   * Load devices from local SKU cache.
   * Returns true if any devices were loaded (= Cloud not needed).
   */
  loadFromCache(): boolean {
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

    // Always refetch cloud data on startup if any light is present —
    // snapshots are user-content (created dynamically in the Govee Home app)
    // and would miss new entries if we relied solely on the cache. The
    // refetch costs one call per light per startup, well within rate limits.
    const hasLight = allDevices.some(d => d.type === GOVEE_DEVICE_TYPE.LIGHT);
    if (hasLight) {
      this.log.debug("Cache loaded — will refresh scenes/snapshots via Cloud");
      return false;
    }

    // No lights — Cloud refetch not needed. Fill scenes from sceneLibrary
    // for devices where Cloud scenes are missing.
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
  private applyCachedEntry(entry: CachedDeviceData, nowMs: number): void {
    const key = this.deviceKey(entry.sku, entry.deviceId);
    const existing = this.devices.get(key);
    const ageDays =
      typeof entry.lastSeenOnNetwork === "number" ? Math.round((nowMs - entry.lastSeenOnNetwork) / 86400000) : null;
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
        `Cache merged into LAN-discovered device ${entry.sku} ${entry.deviceId} (${ageInfo}, caps=${entry.capabilities.length})`,
      );
    } else {
      this.devices.set(key, cacheHelpers.cachedToGoveeDevice(entry));
      this.log.debug(
        `Cache restored (no LAN discovery yet) for ${entry.sku} ${entry.deviceId} (${ageInfo}, caps=${entry.capabilities.length})`,
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
  private firePostCachePhaseCallbacks(allDevices: GoveeDevice[]): void {
    for (const device of allDevices) {
      if (device.capabilities.length > 0) {
        this.onCloudDataReady?.(device, allDevices);
      } else if (device.lanIp) {
        this.onLanDeviceReady?.(device, allDevices);
      }
    }
  }

  /**
   * Load devices from Cloud API and save to cache.
   * Only called when cache is empty (first start) or manual refresh.
   */
  async loadFromCloud(): Promise<CloudLoadResult> {
    if (!this.cloudClient) {
      return { ok: false, reason: "transient" };
    }

    try {
      const rawCloudDevices = await this.cloudClient.getDevices();

      // Hard-filter: Govee's Device-List API returns historical/stale entries
      // (deleted devices that are no longer in the app) without capabilities.
      const cloudDevices = filterCloudDevicesWithCapabilities(rawCloudDevices);

      if (Array.isArray(rawCloudDevices) && rawCloudDevices.length !== cloudDevices.length) {
        this.log.info(
          `Cloud: received ${rawCloudDevices.length} devices raw, ${cloudDevices.length} after filter (skipped stale entries without capabilities)`,
        );
      }

      // Step 1: Merge Cloud devices into local device map
      let changed = this.mergeCloudDevices(cloudDevices);

      // Step 2: Load scenes, snapshots, and libraries for any device that
      // exposes a `dynamic_scene` capability — independent of `cd.type`.
      // Govee occasionally returns devices with `type` missing or a value
      // we don't recognise; keying off the capability is what the rest of
      // the codebase already uses to decide whether scene/snapshot states
      // exist, so the loader has to follow the same rule.
      for (const cd of cloudDevices) {
        const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
        const hasSceneCap =
          hasDynamicSceneCapability(caps, "lightScene") ||
          hasDynamicSceneCapability(caps, "diyScene") ||
          hasDynamicSceneCapability(caps, "snapshot");
        const isLight = cd.type === GOVEE_DEVICE_TYPE.LIGHT || hasSceneCap;
        if (isLight) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            if (await this.loadDeviceScenes(device, cd)) {
              changed = true;
            }
            if (await this.loadDeviceLibraries(device, cd.sku)) {
              changed = true;
            }
            // Mark scenes as checked regardless of result — empty is legitimate,
            // and we've now confirmed that via Cloud. Prevents refetch loop.
            device.scenesChecked = true;
          }
        }
      }

      // Reconcile account membership (BUG-1): Govee's /user/devices returns
      // devices deleted from the account capability-less, so they drop out
      // after the hard-filter. A cloud-only device (never seen on LAN) that is
      // no longer in the fresh list has been removed from the account — drop
      // it, instead of letting the cache rehydrate it forever. Guards: only on
      // a plausible non-empty response; never a LAN-present device (LAN-first);
      // never a capability-bearing device (that's just offline — keep it).
      if (cloudDevices.length > 0) {
        const ownedKeys = new Set(cloudDevices.map(cd => this.deviceKey(cd.sku, cd.device)));
        const removed: GoveeDevice[] = [];
        for (const device of this.devices.values()) {
          if (device.sku === "BaseGroup" || device.channels.lan || !device.channels.cloud) {
            continue;
          }
          if (!ownedKeys.has(this.deviceKey(device.sku, device.deviceId))) {
            removed.push(device);
          }
        }
        for (const device of removed) {
          this.log.info(`Removed device ${device.name} (${device.sku}) — no longer in your Govee account`);
          this.removeDevice(device.sku, device.deviceId);
        }
      }

      // Step 3: Prune stale cache entries (only after successful Cloud-load
      // with a plausible response — never prune on Cloud failure or empty list)
      if (this.skuCache && cloudDevices.length > 0) {
        this.skuCache.pruneStale(14);
      }

      // Step 4: Save to cache and finalize
      this.saveDevicesToCache();

      for (const device of this.devices.values()) {
        cacheHelpers.populateScenesFromLibrary(this, device);
      }

      if (changed) {
        const allDevices = this.getDevices();
        for (const device of allDevices) {
          if (device.sku === "BaseGroup") {
            // Groups go through onGroupMembersReady — see loadGroupMembers
            continue;
          }
          this.onCloudDataReady?.(device, allDevices);
        }
      }
      this.lastErrorCategory = null;
      this.cloudListDedup.lastCategory = null;
      return { ok: true };
    } catch (err) {
      logChannelFail(this.log, {
        channel: "Cloud REST",
        err,
        context: "loading device list",
        retryHint: "retrying every 5 min",
        dedup: this.cloudListDedup,
      });

      // Govee 429: respect Retry-After header (default 60s if missing)
      if (err instanceof HttpError && err.statusCode === 429) {
        const retryAfterRaw = err.headers["retry-after"];
        const retryAfterSec =
          typeof retryAfterRaw === "string" && /^\d+$/.test(retryAfterRaw) ? parseInt(retryAfterRaw, 10) : 60;
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterMs: retryAfterSec * 1000,
        };
      }

      // Auth failure: API key wrong or revoked — NO retry. Classify 401/403 by
      // status code too, not just classifyError's message match, so a body
      // without "auth"/"unauthorized" (e.g. "Access denied") doesn't fall
      // through to a "transient" retry loop on a permanently-bad key (same class
      // as the L26 cloud-client fix).
      const category = classifyError(err);
      const authByStatus = err instanceof HttpError && (err.statusCode === 401 || err.statusCode === 403);
      if (authByStatus || category === "AUTH") {
        return {
          ok: false,
          reason: "auth-failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Network/timeout/unknown: transient, just retry later
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
  async refreshSceneDataForDevice(deviceId: string): Promise<boolean> {
    if (!this.cloudClient) {
      return false;
    }
    const target = Array.from(this.devices.values()).find(
      d => normalizeDeviceId(d.deviceId) === normalizeDeviceId(deviceId),
    );
    if (!target) {
      this.log.debug(`refreshSceneDataForDevice: device ${deviceId} not found`);
      return false;
    }
    this.diagnostics.addLog(target.deviceId, "info", `User-triggered refresh-cloud-data for ${target.sku}`);

    // Step 1: refetch the device list so cd.capabilities is current. Skipping
    // this was the v2.6.7 bug — the button re-ran /device/scenes only, which
    // never carries newly-created snapshots for some SKUs; the authoritative
    // list lives in /user/devices.
    try {
      const rawCloudDevices = await this.cloudClient.getDevices();
      const cloudDevices = filterCloudDevicesWithCapabilities(rawCloudDevices);
      this.mergeCloudDevices(cloudDevices);
    } catch (e) {
      this.log.debug(`refreshSceneDataForDevice: getDevices failed: ${errMessage(e)}`);
      // Keep going with stale capabilities — better than aborting the refresh.
    }

    // Step 2: per-device scenes + libraries with fresh capabilities.
    const cd: CloudDevice = {
      sku: target.sku,
      device: target.deviceId,
      deviceName: target.name,
      type: target.type,
      capabilities: Array.isArray(target.capabilities) ? target.capabilities : [],
    };
    let changed = false;
    if (await this.loadDeviceScenes(target, cd)) {
      changed = true;
    }
    if (await this.loadDeviceLibraries(target, cd.sku, /* force */ true)) {
      changed = true;
    }
    if (changed) {
      this.saveDevicesToCache();
      cacheHelpers.populateScenesFromLibrary(this, target);
      // Per-device Cloud-phase fire — only the targeted device needs a rebuild.
      this.onCloudDataReady?.(target, this.getDevices());
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
  private mergeCloudDevices(cloudDevices: CloudDevice[]): boolean {
    return cloudMergeHelpers.mergeCloudDevices(this, cloudDevices);
  }

  /**
   * Load scenes, DIY scenes, and snapshots for a device from Cloud API.
   *
   * @param device Target device to populate
   * @param cd Cloud device data with capabilities
   * @returns true if any scene data changed
   */
  private async loadDeviceScenes(device: GoveeDevice, cd: CloudDevice): Promise<boolean> {
    this.diagnostics.addLog(cd.device, "debug", `loadDeviceScenes called for ${cd.sku}`);
    // Scenes from dedicated scenes endpoint (rate-limited).
    //
    // lightScene + diyScene: per-list guard against transient empties. Govee's
    // /device/scenes sometimes returns 149 lightScenes + 0 snapshots (or vice
    // versa) on back-to-back calls. One guard per list keeps the last-known-good
    // data in place for those types.
    //
    // snapshot: handled separately AFTER this block (see below). A per-list
    // guard alone froze the cached snapshot list forever once it was populated —
    // user content (snapshots created in the Govee Home app) never surfaced
    // (Issue #13, tukey42, v2.6.7).
    let scenesCallSucceeded = false;
    let snapsFromScenesCall: CloudScene[] = [];
    let diyFromScenesCall: CloudScene[] = [];
    const loadScenes = async (): Promise<void> => {
      try {
        const { lightScenes, diyScenes, snapshots } = await this.cloudClient!.getScenes(cd.sku, cd.device);
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
        this.log.debug(`Could not load scenes for ${cd.sku}: ${errMessage(e)}`);
      }
    };
    await this.commandRouter.executeRateLimited(loadScenes, 2);

    // DIY scenes from the dedicated endpoint. Gate on whether THIS /device/scenes
    // call carried DIY scenes — NOT on an empty cache. The old `diyScenes.length
    // === 0` gate froze the list after the first population, so DIY scenes the
    // user created in the app later never surfaced (Pattern 54, same class as the
    // snapshot bug below). getDiyScenes only overwrites on a non-empty result, so
    // a transient empty keeps the cache.
    if (diyFromScenesCall.length === 0) {
      const loadDiy = async (): Promise<void> => {
        try {
          const diy = await this.cloudClient!.getDiyScenes(cd.sku, cd.device);
          if (diy.length > 0) {
            device.diyScenes = diy;
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/diy-scenes", e, this.extractStatus(e));
          this.log.debug(`Could not load DIY scenes for ${cd.sku}: ${errMessage(e)}`);
        }
      };
      await this.commandRouter.executeRateLimited(loadDiy, 2);
    }

    // Snapshots — three-way resolution:
    //   1. /device/scenes returned non-empty snapshots → trust that list.
    //   2. /device/scenes succeeded but returned empty → fall back to the
    //      `snapshot` capability inside /user/devices (cd.capabilities).
    //      This is the fix path for newly-created snapshots: /device/scenes
    //      lags or omits them for some SKUs, but /user/devices carries them.
    //      Empty capability options here is a legitimate "user deleted all
    //      snapshots in the app" — we reflect that and clear the list.
    //   3. /device/scenes threw OR no snapshot capability exists at all →
    //      keep device.snapshots untouched (cache survives transient Cloud
    //      outages and devices that simply don't expose the capability).
    if (snapsFromScenesCall.length > 0) {
      device.snapshots = snapsFromScenesCall;
    } else if (scenesCallSucceeded) {
      const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      const snapCap = caps.find(
        c =>
          c &&
          c.type === GOVEE_CAP_TYPE.DYNAMIC_SCENE &&
          c.instance === "snapshot" &&
          Array.isArray(c.parameters?.options),
      );
      if (snapCap?.parameters?.options) {
        device.snapshots = snapCap.parameters.options
          .filter(o => o && typeof o.name === "string" && o.value !== undefined && o.value !== null)
          .map(o => ({
            name: o.name,
            value: typeof o.value === "number" ? o.value : (o.value as Record<string, unknown>),
          }));
        this.log.debug(`Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`);
      }
    }

    // "Changed" = we ended up with any scene/snapshot data.
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
  private async loadDeviceLibraries(device: GoveeDevice, sku: string, force = false): Promise<boolean> {
    if (!this.apiClient) {
      return false;
    }

    this.diagnostics.addLog(device.deviceId, "debug", `loadDeviceLibraries called for ${sku} (force=${force})`);
    let changed = false;

    // Run each fetch inside a rate-limited slot. Priority 2 = below
    // control commands and scene/snapshot loads; library data is cache-only
    // and can wait for a quieter moment.
    const runLimited = async (fn: () => Promise<void>): Promise<void> => {
      await this.commandRouter.executeRateLimited(fn, 2);
    };

    const hasBearer = this.apiClient.hasBearerToken();

    if (force || device.sceneLibrary.length === 0) {
      await runLimited(async () => {
        const ep = `/light-effect-libraries?sku=${sku}`;
        try {
          const lib = await this.apiClient!.fetchSceneLibrary(sku);
          // v2.9.1 — record the raw library array (incl. scenceParam Base64
          // + speedInfo.config JSON) so a byte-level "why does this scene
          // not activate on H61A8 but works on H61BE?" diagnosis can be done
          // from the diag JSON alone. Old projection ({count, names}) hid
          // the very bytes the user would need.
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `Scene library for ${sku}: ${lib.length} scene(s)${lib.length === 0 ? " — empty (Govee returned no data for this SKU)" : ""}`,
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
          const lib = await this.apiClient!.fetchMusicLibrary(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `Music library for ${sku}: ${lib.length} mode(s)${lib.length === 0 ? " — empty (Govee returned no data for this SKU)" : ""}`,
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
          const lib = await this.apiClient!.fetchDiyLibrary(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, lib);
          this.log.debug(
            `DIY library for ${sku}: ${lib.length} effect(s)${lib.length === 0 ? " — empty (Govee returned no data for this SKU)" : ""}`,
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
          const features = await this.apiClient!.fetchSkuFeatures(sku);
          this.diagnostics.recordApiSuccess(device.deviceId, ep, features);
          if (features) {
            device.skuFeatures = features;
            changed = true;
            this.log.debug(`SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`);
          } else {
            this.log.debug(`SKU features for ${sku}: null — Govee returned no data for this SKU`);
          }
        } catch (e) {
          this.diagnostics.recordApiFailure(device.deviceId, ep, e, this.extractStatus(e));
          this.logUndocApiFailure(sku, "SKU features", ep, hasBearer, e);
        }
      });
    }

    // Load snapshot BLE commands for local activation.
    // `force` honoured so refresh_cloud also clears stale BLE-Cmds when the
    // user re-creates a snapshot in the Govee app and re-imports it. Without
    // the force-branch the gate was sticky — cached snapshot packets stayed
    // until the cache file was manually deleted (Issue #13 v2.8.2, tukey42).
    if ((force || !device.snapshotBleCmds) && device.snapshots.length > 0) {
      await runLimited(async () => {
        const ep = `/bff-app/v1/devices/snapshots?sku=${sku}`;
        try {
          const snaps = await this.apiClient!.fetchSnapshots(sku, device.deviceId);
          // v2.9.1 — record the full bleCmds payload (per-snapshot Base64
          // packet groups). Was completely absent from apiHistory in v2.9.0;
          // Issue #13 H61A8 byte-level analysis couldn't proceed without it.
          this.diagnostics.recordApiSuccess(device.deviceId, ep, snaps);
          this.log.debug(
            `Snapshot BLE for ${sku}: ${snaps.length} snapshot(s) with local data${snaps.length === 0 ? " — Govee returned no BLE-cmds for this SKU/device" : ""}`,
          );
          if (snaps.length > 0) {
            device.snapshotBleCmds = device.snapshots.map(ds => {
              const match = snaps.find(s => s.name === ds.name);
              return match?.bleCmds ?? [];
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
  async loadGroupMembers(): Promise<boolean> {
    if (!this.apiClient) {
      return false;
    }
    if (!this.apiClient.hasBearerToken()) {
      this.log.debug("Group membership requires Email+Password — skipping member resolution");
      return false;
    }

    const ep = "/bff-app/v1/exec-plat/home";
    try {
      const apiGroups = await this.apiClient.fetchGroupMembers();
      // v2.9.1 — record per-group response in apiHistory of each BaseGroup
      // device. The fetch is account-wide so we tag every group's deviceId.
      for (const group of this.devices.values()) {
        if (group.sku === "BaseGroup") {
          const apiGroup = apiGroups.find(g => String(g.groupId) === group.deviceId);
          this.diagnostics.recordApiSuccess(
            group.deviceId,
            ep,
            apiGroup ?? { resolved: false, groupId: group.deviceId },
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
        // Match by groupId: BaseGroup deviceId is the numeric group ID as string
        const apiGroup = apiGroups.find(g => String(g.groupId) === group.deviceId);
        if (!apiGroup) {
          continue;
        }

        // Resolve member devices against our device map
        const members: { sku: string; deviceId: string }[] = [];
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
        // Per-group Group-phase fire — only the BaseGroup state-trees need
        // rebuilding (intersection of member caps). Members themselves
        // haven't changed, so their phase callbacks don't fire.
        for (const group of allDevices.filter(d => d.sku === "BaseGroup")) {
          this.onGroupMembersReady?.(group, allDevices);
        }
      }
      // Reset dedup on success so a future failure warns again.
      this.lastGroupMembersErrorCategory = null;
      return changed;
    } catch (e) {
      // v2.9.1 — record failure on every BaseGroup so the diag JSON shows
      // why group fan-out doesn't work without needing the adapter log.
      const status = this.extractStatus(e);
      for (const group of this.devices.values()) {
        if (group.sku === "BaseGroup") {
          this.diagnostics.recordApiFailure(group.deviceId, ep, e, status);
        }
      }
      // Group-membership is best-effort — but a persistent failure (e.g. API
      // permission revoked) should still surface once so the user knows
      // groups won't fan-out. logDedup demotes repeats to debug.
      this.lastGroupMembersErrorCategory = logDedup(
        this.log,
        this.lastGroupMembersErrorCategory,
        "Group membership",
        e,
      );
      return false;
    }
  }

  /** Save all devices to SKU cache, skipping only those never confirmed via Cloud yet. */
  public saveDevicesToCache(): void {
    cacheHelpers.saveDevicesToCache(this);
  }

  /**
   * Handle LAN device discovery — match against known devices or create new.
   *
   * @param lanDevice Discovered LAN device
   */
  handleLanDiscovery(lanDevice: LanDevice): void {
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
  private findDeviceForLanDiscovery(lanDevice: LanDevice): GoveeDevice | undefined {
    for (const dev of this.devices.values()) {
      if (normalizeDeviceId(dev.deviceId) === normalizeDeviceId(lanDevice.device)) {
        return dev;
      }
    }
    const skuMatches = Array.from(this.devices.values()).filter(dev => dev.sku === lanDevice.sku && !dev.lanIp);
    return skuMatches.length === 1 ? skuMatches[0] : undefined;
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
  private applyLanDiscoveryToExisting(matched: GoveeDevice, lanDevice: LanDevice): void {
    const hadNoLanIp = !matched.lanIp;
    const ipChanged = matched.lanIp !== lanDevice.ip;
    const wasOffline = matched.state.online !== true;
    matched.lanIp = lanDevice.ip;
    matched.channels.lan = true;
    matched.lastSeenOnNetwork = Date.now();
    matched.lastLanReplyAt = Date.now();
    if (hadNoLanIp) {
      this.onLanDeviceReady?.(matched, this.getDevices());
    }
    if (ipChanged) {
      this.log.debug(`LAN: ${matched.name} (${matched.sku}) at ${lanDevice.ip}`);
      this.onLanIpChanged?.(matched, lanDevice.ip);
    }
    if (wasOffline) {
      matched.state.online = true;
      this.onDeviceUpdate?.(matched, { online: true });
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
  private createLanOnlyDevice(lanDevice: LanDevice): void {
    const shortId = normalizeDeviceId(lanDevice.device).slice(-4);
    const device: GoveeDevice = {
      sku: lanDevice.sku,
      deviceId: lanDevice.device,
      name: `${lanDevice.sku}_${shortId}`,
      type: GOVEE_DEVICE_TYPE.LIGHT,
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
      channels: { lan: true, mqtt: false, cloud: false },
    };
    this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
    this.diagnostics.addLog(lanDevice.device, "info", `LAN-discovered at ${lanDevice.ip}`);
    this.log.debug(
      `LAN: new device sku=${lanDevice.sku} deviceId=${lanDevice.device} ip=${lanDevice.ip} reachable=yes`,
    );
    this.maybeNudgeSeedSku(lanDevice.sku, device.name);
    this.onLanDeviceReady?.(device, this.getDevices());
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
  public maybeNudgeSeedSku(sku: string, displayName: string | undefined): void {
    const upper = (typeof sku === "string" ? sku : "").toUpperCase();
    if (!upper || this.nudgedSeedSkus.has(upper)) {
      return;
    }
    this.nudgedSeedSkus.add(upper);
    const tier = getDeviceTier(upper);
    const label = displayName ? `${displayName} (${upper})` : upper;
    switch (tier) {
      case "verified":
      case "reported":
        return;
      case "seed":
        if (isSeedAndDormant(upper)) {
          this.log.warn(
            `Device ${label} is in beta and needs the "Enable experimental device support" toggle in adapter settings to apply known per-SKU corrections.`,
          );
        } else {
          this.log.info(`Device ${label} is in beta — experimental quirks are active.`);
        }
        return;
      case "unknown":
        this.log.warn(
          `Device ${label} is not in the supported device list. Please trigger diag.export and post the resulting JSON in a GitHub issue so the SKU can be added.`,
        );
        return;
    }
  }

  /**
   * Handle MQTT status update — update device state.
   *
   * @param update MQTT status message
   */
  handleMqttStatus(update: MqttStatusUpdate): void {
    const device = this.findDeviceBySkuAndId(update.sku, update.device);
    if (!device) {
      this.log.debug(`MQTT: Unknown device ${update.sku} ${update.device}`);
      return;
    }
    device.channels.mqtt = true;
    device.lastSeenOnNetwork = Date.now();
    const state = this.parseMqttStateUpdate(device, update);
    Object.assign(device.state, state);
    this.onDeviceUpdate?.(device, state);
    if (update.op?.command) {
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
  private parseMqttStateUpdate(device: GoveeDevice, update: MqttStatusUpdate): Partial<DeviceState> {
    const state: Partial<DeviceState> = {};
    if (device.type !== GOVEE_DEVICE_TYPE.LIGHT) {
      state.online = true;
    }
    if (!update.state) {
      return state;
    }
    const onOff = coerceFiniteNumber(update.state.onOff);
    if (onOff !== null) {
      state.power = onOff === 1;
    }
    const brightness = coerceFiniteNumber(update.state.brightness);
    if (brightness !== null) {
      state.brightness = brightness;
    }
    if (update.state.color && typeof update.state.color === "object") {
      const r = coerceFiniteNumber((update.state.color as { r?: unknown }).r);
      const g = coerceFiniteNumber((update.state.color as { g?: unknown }).g);
      const b = coerceFiniteNumber((update.state.color as { b?: unknown }).b);
      if (r !== null && g !== null && b !== null) {
        state.colorRgb = rgbToHex(r, g, b);
      }
    }
    // 0 = "not in colortemp mode" — drop intentionally (Govee-Konvention).
    const ctk = coerceFiniteNumber(update.state.colorTemInKelvin);
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
  private processMqttSegmentPacket(device: GoveeDevice, opCommand: string[]): void {
    const segData = parseMqttSegmentData(opCommand);
    if (segData.length === 0) {
      return;
    }
    // reduce() rather than Math.max(...spread) so a large segData can never blow
    // the call stack with a huge argument spread (SEC-GC1 defence-in-depth;
    // parseMqttSegmentData already caps it to ≤20).
    const maxSeen = segData.reduce((m, s) => Math.max(m, s.index), -1) + 1;
    const current = device.segmentCount ?? 0;
    // L6 — plausibility cap: SEGMENT_HARD_MAX (55) is the Govee protocol upper
    // limit. Values above it only come from broken/spoofed packets.
    if (maxSeen > SEGMENT_HARD_MAX) {
      this.log.debug(`${device.name}: ignoring segmentCount=${maxSeen} (above protocol limit ${SEGMENT_HARD_MAX})`);
      return;
    }
    if (maxSeen > current) {
      this.log.info(`${device.name}: detected ${maxSeen} segments via MQTT (was ${current}) — rebuilding state tree`);
      device.segmentCount = maxSeen;
      // Persist now so a restart starts from the real value instead of
      // falling back to Cloud capabilities and deleting the extra slots.
      if (this.skuCache) {
        this.skuCache.save(cacheHelpers.goveeDeviceToCached(device));
      }
      // Skip per-segment sync for this push — the new datapoints don't exist
      // yet. The next AA A5 push hits the fully-built tree.
      this.onSegmentCountGrown?.(device);
      return;
    }
    // Filter by manual-segments override if active — ignore indices the user
    // has declared as "not physically present" (cut strip).
    const filtered =
      device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0
        ? segData.filter(s => device.manualSegments!.includes(s.index))
        : segData;
    if (filtered.length > 0) {
      this.onMqttSegmentUpdate?.(device, filtered);
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
  handleLanStatus(
    ip: string,
    status: {
      onOff: number;
      brightness: number;
      color: { r: number; g: number; b: number };
      colorTemInKelvin: number;
    },
  ): void {
    // Find device by LAN IP
    let device: GoveeDevice | undefined;
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
    const state: Partial<DeviceState> = {
      online: true,
      power: status.onOff === 1,
      brightness: status.brightness,
      colorRgb: rgbToHex(r, g, b),
      colorTemperature: status.colorTemInKelvin || undefined,
    };

    Object.assign(device.state, state);
    this.onDeviceUpdate?.(device, state);
  }

  /**
   * Set the callback for batch segment state sync.
   * Forwards to the internal CommandRouter.
   *
   * @param callback Called when a segment batch command updates segment states
   */
  set onSegmentBatchUpdate(
    callback:
      ((device: GoveeDevice, batch: { segments: number[]; color?: number; brightness?: number }) => void) | undefined,
  ) {
    this.commandRouter.onSegmentBatchUpdate = callback;
  }

  /**
   * Send a command to a device — routes through LAN → Cloud.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCommand(device: GoveeDevice, command: string, value: unknown): Promise<void> {
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
  async sendCapabilityCommand(
    device: GoveeDevice,
    capabilityType: string,
    capabilityInstance: string,
    value: unknown,
  ): Promise<void> {
    return this.commandRouter.sendCapabilityCommand(device, capabilityType, capabilityInstance, value);
  }

  /** Callback when device LAN IP changes */
  onLanIpChanged?: (device: GoveeDevice, ip: string) => void;

  /** Callback when MQTT delivers per-segment state data (AA A5 BLE packets) */
  onMqttSegmentUpdate?: (device: GoveeDevice, segments: MqttSegmentData[]) => void;

  /**
   * Callback when the device's physical segment count turns out to be
   * larger than the Cloud-reported value (observed via MQTT AA A5 stream).
   * The adapter rebuilds the state tree in response so the extra indices
   * appear as datapoints.
   */
  onSegmentCountGrown?: (device: GoveeDevice) => void;

  /**
   * Find device by SKU and device ID (handles format differences)
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private findDeviceBySkuAndId(sku: string, deviceId: string): GoveeDevice | undefined {
    return findDeviceBySkuAndIdHelper(this.devices, sku, deviceId);
  }

  /**
   * Generate unique key for a device
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private deviceKey(sku: string, deviceId: string): string {
    return deviceKeyHelper(sku, deviceId);
  }

  /**
   * Persist a device's current runtime state to the SKU cache. Safe no-op
   * when no cache is configured.
   *
   * @param device Target device
   */
  public persistDeviceToCache(device: GoveeDevice): void {
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
  generateDiagnostics(device: GoveeDevice, adapterVersion: string): Record<string, unknown> {
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
  async pollAppApi(): Promise<number> {
    if (!this.apiClient || !this.apiClient.hasBearerToken()) {
      return 0;
    }
    // Skip the entire round-trip when no device in the registry would
    // actually consume App-API readings. The App API is only used for
    // sensor and appliance state (thermometers, heaters, kettles, …);
    // a Lights-only setup would otherwise burn one Govee call every 2
    // minutes for nothing.
    if (!this.hasDeviceNeedingAppApi()) {
      return 0;
    }
    let entries: AppDeviceEntry[];
    try {
      entries = await this.apiClient.fetchDeviceList();
    } catch (err) {
      const category = classifyError(err);
      const msg = `App API fetch failed: ${errMessage(err)}`;
      if (category !== this.lastAppApiErrorCategory) {
        this.lastAppApiErrorCategory = category;
        this.log.warn(msg);
      } else {
        this.log.debug(msg);
      }
      return 0;
    }
    // Reset on success so the next failure warns again.
    this.lastAppApiErrorCategory = null;
    // Process all entries in parallel — each entry only touches its own
    // device (no shared mutation), and the downstream callbacks (onCloud-
    // Capabilities → main.applyCloudCapabilities → setStateAsync queue)
    // are async-safe. Sequential `for` blocked the App-API tick on a slow
    // setStateAsync round-trip per device.
    // Wrap each per-entry block in `Promise.resolve` so the iterable is a
    // true Thenable — synchronous returns confuse `await Promise.all`'s
    // type-checker (await-thenable lint rule) even though the runtime would
    // accept them. No-op at runtime, makes the intent explicit and lints
    // without `require-await`.
    const results = await Promise.all(
      entries.map(entry =>
        Promise.resolve().then(() => {
          const device = this.devices.get(this.deviceKey(entry.sku, entry.device));
          if (!device) {
            return false;
          }
          const hasHumidityCap = device.capabilities.some(c => c.instance === "sensorHumidity");
          const caps = buildCapabilitiesFromAppEntryHelper(entry, Date.now(), hasHumidityCap);
          if (caps.length === 0) {
            return false;
          }
          this.onCloudCapabilities?.(device, caps);
          // mapSingleCapability returns null for the synthetic `online` cap
          // (online is a device-level property, not a regular state), so
          // onCloudCapabilities never reaches info.online via the capability
          // pipeline. Pluck it out and apply it directly — otherwise sensor
          // SKUs like H5179 stay at info.online=false forever even while
          // their readings keep updating.
          // Cloud-only lights (no local API, lanIp === null) have no LAN
          // reachability signal, so the cloud online cap is their only truth —
          // apply it like sensors/appliances. LAN-capable lights stay excluded:
          // their info.online is LAN-driven, and Govee's Cloud cache lags real
          // LAN reachability (2× false-positive `true` during 2026-05-13).
          if (device.type !== GOVEE_DEVICE_TYPE.LIGHT || !device.lanIp) {
            this.applyOnlineCap(device, caps);
          }
          this.diagnostics.recordApiSuccess(device.deviceId, "/device/rest/devices/v1/list", entry);
          return true;
        }),
      ),
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
  private applyOnlineCap(device: GoveeDevice, caps: CloudStateCapability[]): void {
    cloudMergeHelpers.applyOnlineCap(this, device, caps);
  }

  /**
   * Hook callback for sources that emit `CloudStateCapability[]` updates
   * outside the normal Cloud-poll path (App-API, OpenAPI-MQTT). Caller is
   * responsible for wiring it to the adapter-side state-write path.
   *
   * @param cb Callback receiving (device, caps)
   */
  setOnCloudCapabilities(cb: ((device: GoveeDevice, caps: CloudStateCapability[]) => void) | null): void {
    this.onCloudCapabilities = cb;
  }

  /**
   * Whether at least one device in the registry would consume App-API
   * readings (sensors, appliances). Used to skip the App-API poll on
   * Lights-only installations, and as a checkAllReady gate so "ready" is
   * only logged once sensor values can actually arrive.
   */
  public hasDeviceNeedingAppApi(): boolean {
    for (const dev of this.devices.values()) {
      if (dev.type !== GOVEE_DEVICE_TYPE.LIGHT && dev.sku !== "BaseGroup") {
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
  handleOpenApiEvent(event: { sku: string; device: string; capabilities: CloudStateCapability[] }): void {
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
    // v2.9.1 — surface each Cloud-events arrival per-device. Without this,
    // "appliance state never updates" reports couldn't be triaged from the
    // diag alone because the appliance push-channel was entirely silent.
    const capSummary = event.capabilities
      .map(c => `${c.type?.replace("devices.capabilities.", "") ?? "?"}/${c.instance ?? "?"}`)
      .join(", ");
    this.diagnostics.addLog(
      device.deviceId,
      "debug",
      `OpenAPI-MQTT event for ${device.sku}: ${event.capabilities.length} cap(s) [${capSummary}]`,
    );
    this.onCloudCapabilities?.(device, event.capabilities);
    // Same online-cap unwrap as the App-API path. OpenAPI-MQTT events
    // are the only signal we get for appliance state (heater on/off,
    // ice-bucket-full, …) — without this, info.online for those SKUs
    // never flips to true even while events stream in.
    // Cloud-only lights need the cloud online signal too (see the App-API
    // path above); LAN-capable lights stay LAN-driven. OpenAPI-MQTT in practice
    // mostly carries appliance events, but cloud-only lights can ride it too.
    if (device.type !== GOVEE_DEVICE_TYPE.LIGHT || !device.lanIp) {
      this.applyOnlineCap(device, event.capabilities);
    }
  }
}
