import { hasDynamicSceneCapability } from "./capability-mapper";
import { CommandRouter, type TransportDecision } from "./command-router";
import type { DeviceRegistry } from "./device-registry";
import { DiagnosticsCollector } from "./diagnostics";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import { logChannelFail, type ChannelDedupState } from "./log-channel-fail";
import {
  deviceKey as deviceKeyHelper,
  effectiveSegmentCount,
  findDeviceBySkuAndId as findDeviceBySkuAndIdHelper,
  isLanDriven,
  parseMqttSegmentData,
  plausibleSegmentCount,
  plausibleSegmentIndices,
  readReportedReachability,
  SEGMENT_COUNT_MAX,
  type MqttSegmentData,
} from "./device-manager/lookups";
import {
  buildCapabilitiesFromAppEntry as buildCapabilitiesFromAppEntryHelper,
  filterCloudDevicesWithCapabilities,
} from "./device-manager/mapping";
import * as cacheHelpers from "./device-manager/cache";
import * as cloudMergeHelpers from "./device-manager/cloud-merge";
import * as libraryLoader from "./device-manager/library-loader";
import {
  ABSENT_SOURCE,
  reconcileAccountMembership,
  type ReconcileSource,
  type ReconcileSources,
  type SourceKind,
} from "./device-manager/reconciler";
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
  type CloudStateCapability,
  type DeviceState,
  type ErrorCategory,
  type GoveeDevice,
  type LanDevice,
  type MqttStatusUpdate,
  type TimerAdapter,
  deviceLabel,
  errMessage,
  formatGatewayLabel,
} from "./types";
import { extractHttpStatus, HttpError } from "./http-client";

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
  /** This instance's device catalog — public for sub-module helpers (cloud-merge). */
  public readonly registry: DeviceRegistry;
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
  /** Shared Cloud budget — owned here for the data loaders since M12. */
  private rateLimiter: RateLimiter | null = null;
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

  // === Account reconcile (auto-remove devices no longer in the Govee account) ===
  /**
   * Latest snapshot of each account-membership source, `null` until that source
   * has been fetched at least once this session. Fed to the reconciler whenever
   * either source refreshes (end of loadFromCloud / pollAppApi).
   */
  private lastCloudList: ReconcileSource | null = null;
  private lastAppList: ReconcileSource | null = null;
  private lastGroupList: ReconcileSource | null = null;
  /**
   * Gate for the account-reconcile — main flips this true once the initial LAN
   * scan is done, so a cache-restored LAN device isn't counted as an account
   * miss before `channels.lan` has been set (advisor guard).
   */
  public accountReconcileEnabled = false;
  /**
   * Fired after devices were evicted from the account so the adapter runs the
   * object cleanup (reapStaleDevices → cleanupDevices + diagnostics prune). An
   * App-API-poll-driven eviction never fires onCloudDataReady, so the cleanup
   * must be triggered explicitly.
   */
  public onDevicesRemoved: (() => void) | null = null;

  /**
   * @param log    ioBroker logger
   * @param timers Adapter timer wrapper (forwarded to CommandRouter for
   *   onUnload-safe delays).
   * @param registry This instance's device catalog (quirks, trust tiers)
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter, registry: DeviceRegistry) {
    this.log = log;
    this.registry = registry;
    this.commandRouter = new CommandRouter(log, timers, registry);
    this.diagnostics = new DiagnosticsCollector(registry);
    // v2.9.1 — funnel command-router routing decisions into the per-device
    // diag ring buffer. Without this, "I clicked but nothing happened" was
    // not triage-able from diag JSON alone — the channel decision lived
    // only in the adapter log.
    // What a user command actually did — the diag report's answer to
    // "switching does not work": the LAN capture ends at the wire.
    this.commandRouter.onCommandResult = (deviceId, entry) => {
      this.diagnostics.recordCommandResult(deviceId, entry);
    };
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
    // One budget, one instance: DeviceManager owns it for the data loaders,
    // CommandRouter shares the SAME instance for command sends (M12).
    this.rateLimiter = limiter;
    this.commandRouter.setRateLimiter(limiter);
  }

  /**
   * Host for the extracted library loaders (device-manager/library-loader).
   * runLimited pins the budget semantics: fire-and-queue tryExecute at
   * background priority — see the LibraryLoaderHost doc for why this must
   * not become executeTracked.
   */
  private libraryHost(): libraryLoader.LibraryLoaderHost {
    return {
      cloudClient: this.cloudClient!,
      apiClient: this.apiClient,
      log: this.log,
      diagnostics: this.diagnostics,
      runLimited: async (fn: () => Promise<void>): Promise<void> => {
        if (this.rateLimiter) {
          await this.rateLimiter.tryExecute(fn, 2);
        } else {
          await fn();
        }
      },
    };
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
   * Central account-membership reconcile — runs after either source refreshes
   * (loadFromCloud / pollAppApi). Removes devices that persisted missing from
   * their authoritative account list across the debounce window AND are not
   * LAN-reachable, atomically across all three stores (in-memory map,
   * SKU-cache file, ioBroker objects). Gated until the initial LAN scan is
   * done. Decision logic lives in the pure {@link reconcileAccountMembership}.
   *
   * @param refreshedSource Which source list just refreshed (cloud / app / group) — only devices whose authoritative source matches get their absence advanced this pass
   */
  private runAccountReconcile(refreshedSource: SourceKind): void {
    if (!this.accountReconcileEnabled) {
      return;
    }
    const sources: ReconcileSources = {
      cloud: this.lastCloudList ?? ABSENT_SOURCE,
      app: this.lastAppList ?? ABSENT_SOURCE,
      group: this.lastGroupList ?? ABSENT_SOURCE,
    };
    // Nothing successfully queried yet → nothing to judge.
    if (!sources.cloud.ok && !sources.app.ok && !sources.group.ok) {
      return;
    }
    const toEvict = reconcileAccountMembership({
      sources,
      devices: this.devices.values(),
      keyOf: (sku, id) => this.deviceKey(sku, id),
      refreshedSource,
    });
    if (toEvict.length === 0) {
      return;
    }
    for (const device of toEvict) {
      this.log.info(`Removed device ${deviceLabel(device)} — no longer in your Govee account`);
      this.removeDevice(device.sku, device.deviceId);
      this.skuCache?.evictDevice(device.sku, device.deviceId, deviceLabel(device));
    }
    // Persist the survivors' updated miss counters, then clean up the now-orphan
    // ioBroker objects + diagnostics buffers for the evicted devices.
    this.saveDevicesToCache();
    this.onDevicesRemoved?.();
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
    // Always true here — the empty-cache case returned false at the top.
    return true;
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
    // A SameModeGroup pseudo-device may sit in a cache written by an older build
    // that merged it before we learned to skip it (see mergeCloudDevices). Never
    // restore it — it has no member-resolution path and only creates an orphaned
    // control tree.
    if (entry.sku === "SameModeGroup") {
      return;
    }
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
      // The cache file is host-local and editable — a corrupt count must not
      // become the device's count (same gate as the Cloud/MQTT/wizard sources).
      existing.segmentCount = plausibleSegmentCount(entry.segmentCount);
      existing.manualMode = entry.manualMode;
      existing.manualSegments = plausibleSegmentIndices(entry.manualSegments);
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
            const host = this.libraryHost();
            if (await libraryLoader.loadDeviceScenes(host, device, cd)) {
              changed = true;
            }
            if (await libraryLoader.loadDeviceLibraries(host, device, cd.sku)) {
              changed = true;
            }
            // Mark scenes as checked regardless of result — empty is legitimate,
            // and we've now confirmed that via Cloud. Prevents refetch loop.
            device.scenesChecked = true;
          }
        }
      }

      // Capture the Cloud /user/devices list as one account-membership source
      // and run the central reconciler. `ok` requires a plausible non-empty
      // response — a transient empty body (Govee returns HTTP 200 empty on
      // hiccups) must never drive an irreversible removal.
      this.lastCloudList = {
        ok: cloudDevices.length > 0,
        keys: new Set(cloudDevices.map(cd => this.deviceKey(cd.sku, cd.device))),
      };
      this.runAccountReconcile("cloud");

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
      // Budgeted + coupled to real execution: this is a user-triggered
      // refresh that NEEDS the fresh list before proceeding — and it must
      // count against the daily accounting like every other Cloud call.
      let rawCloudDevices: CloudDevice[] = [];
      const fetchList = async (): Promise<void> => {
        rawCloudDevices = await this.cloudClient!.getDevices();
      };
      if (this.rateLimiter) {
        await this.rateLimiter.executeTracked(fetchList, 1);
      } else {
        await fetchList();
      }
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
    const host = this.libraryHost();
    if (await libraryLoader.loadDeviceScenes(host, target, cd)) {
      changed = true;
    }
    if (await libraryLoader.loadDeviceLibraries(host, target, cd.sku, /* force */ true)) {
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
      // Snapshot the group list as the third reconcile source. Non-empty guard
      // (like the device sources): an empty response is treated as not-ok, so a
      // transient empty never evicts a still-existing group.
      this.lastGroupList = {
        ok: apiGroups.length > 0,
        keys: new Set(apiGroups.map(g => this.deviceKey("BaseGroup", String(g.groupId)))),
      };
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
      // Reconcile now that the group list is fresh — a BaseGroup absent from a
      // non-empty group response is a candidate for removal after the debounce.
      this.runAccountReconcile("group");
      // Reset dedup on success so a future failure warns again.
      this.lastGroupMembersErrorCategory = null;
      return changed;
    } catch (e) {
      // A failed group fetch is not authoritative — never reconcile groups on it.
      this.lastGroupList = { ok: false, keys: new Set() };
      // v2.9.1 — record failure on every BaseGroup so the diag JSON shows
      // why group fan-out doesn't work without needing the adapter log.
      const status = extractHttpStatus(e);
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
    // Persisted twin of lastLanReplyAt — survives the restart so this device
    // stays LAN-decided even before the first scan of the next session.
    matched.lastLanSeenAt = Date.now();
    if (hadNoLanIp) {
      this.onLanDeviceReady?.(matched, this.getDevices());
    }
    if (ipChanged) {
      this.log.debug(`LAN: ${deviceLabel(matched)} at ${lanDevice.ip}`);
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
      lastLanSeenAt: Date.now(),
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
    const tier = this.registry.getTier(upper);
    const label = displayName ? `${displayName} (${upper})` : upper;
    switch (tier) {
      case "verified":
      case "reported":
        return;
      case "seed":
        if (this.registry.isSeedAndDormant(upper)) {
          this.log.warn(
            `Device ${label} is in beta and needs the "Enable experimental device support" toggle in adapter settings to apply known per-SKU corrections.`,
          );
        } else {
          this.log.info(`Device ${label} is in beta — experimental quirks are active.`);
        }
        return;
      case "unknown":
        this.log.warn(
          `Device ${label} is not in the supported device list. Please trigger diag.export and attach the resulting JSON to a GitHub issue so the SKU can be added.`,
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
    // The local interface decides alone for a LAN-driven light — no cloud claim
    // touches its reachability, not even an explicit one. Govee's cache lags
    // reality (measured 2026-05-13: `true` twice during a real 8-minute outage),
    // and that path is deliberately left untouched.
    if (!isLanDriven(device)) {
      const reported = readReportedReachability(update);
      // ORDER IS LOAD-BEARING: an explicit report beats mere arrival, in both
      // directions. Counting arrival first would turn Govee's own "this device
      // is gone" packet into a liveness sign — which is what the adapter did
      // for appliances until 2.30.0.
      const heard = reported !== undefined ? reported : true;
      state.online = heard;
      state.cloudReportedOnline = heard;
      // Stamped so the proof can expire — an unstamped one would read as
      // reachable forever (the Weihnachtslichter case).
      state.cloudReportedOnlineAt = Date.now();
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
    const { segments: segData, complete } = parseMqttSegmentData(opCommand);
    if (segData.length === 0) {
      return;
    }
    // reduce() rather than Math.max(...spread) so a large segData can never blow
    // the call stack with a huge argument spread (SEC-GC1 defence-in-depth;
    // parseMqttSegmentData already caps it to ≤20).
    const maxSeen = segData.reduce((m, s) => Math.max(m, s.index), -1) + 1;
    const current = device.segmentCount ?? 0;
    // L6 — plausibility cap: the Govee bitmask addresses SEGMENT_COUNT_MAX slots.
    // Values above it only come from broken/spoofed packets. Untestable through
    // the public path and kept anyway: the parser above only yields packet
    // numbers 1-5 → indices 0-19, so maxSeen can never exceed 20 (equivalent
    // mutant, 2026-08-22 test audit). Guards the day the parser learns more
    // packet numbers. Same gate as every other count source (plausibleSegmentCount).
    if (maxSeen > SEGMENT_COUNT_MAX) {
      this.log.debug(
        `${deviceLabel(device)}: ignoring segmentCount=${maxSeen} (above protocol limit ${SEGMENT_COUNT_MAX})`,
      );
      return;
    }
    // A segmentCount quirk is a hard override (a cloud-only SKU whose capability
    // count lies and which never pushes AA-A5 to self-correct) — a live packet
    // must never fight it.
    const quirk = this.registry.getQuirks(device.sku)?.segmentCount;
    const quirkLocked = typeof quirk === "number" && quirk > 0;
    // Adopt the packet count when it disagrees with the stored total: always
    // upward (a bigger real strip); downward ONLY when the push proved complete
    // (trailing padding was stripped), so a set truncated at the 20-slot parser
    // cap can never delete real segments (e.g. 20-29 on a 30-segment strip).
    // MQTT is authoritative — the device reports what it physically has — but
    // only as far as the parser can see. Same rebuild path both ways:
    // createSegmentStates adds the missing / prunes the excess.
    const grow = maxSeen > current;
    const shrink = maxSeen < current && complete;
    if (!quirkLocked && maxSeen > 0 && (grow || shrink)) {
      this.log.info(
        `${deviceLabel(device)}: ${grow ? "detected" : "corrected to"} ${maxSeen} segments via MQTT (was ${current}) — rebuilding state tree`,
      );
      device.segmentCount = maxSeen;
      // Persist now so a restart starts from the real value instead of
      // falling back to Cloud capabilities.
      if (this.skuCache) {
        void this.skuCache.save(cacheHelpers.goveeDeviceToCached(device));
      }
      // Skip per-segment sync for this push — the datapoints are being rebuilt.
      // The next AA A5 push hits the fully-built tree.
      this.onSegmentCountChanged?.(device);
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
    device.lastLanSeenAt = Date.now();
    const { r, g, b } = status.color;
    const state: Partial<DeviceState> = {
      power: status.onOff === 1,
      brightness: status.brightness,
      colorRgb: rgbToHex(r, g, b),
      colorTemperature: status.colorTemInKelvin || undefined,
    };
    // `online` only on a real offline→online flip (mirrors
    // applyLanDiscoveryToExisting): with online:true in EVERY devStatus
    // patch, each poll reply triggered the group-reachability pass and a
    // per-group state write — pure churn on a steady LAN (M6). A flip
    // still carries `online`, so the <1s recovery path is unchanged.
    if (device.state.online !== true) {
      state.online = true;
    }

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
   * Callback when the device's physical segment count changes from the stored
   * value (observed via the MQTT AA A5 stream) — up when the real strip is
   * bigger than Cloud advertised, or down when a complete push proves Cloud
   * over-reported. The adapter rebuilds the state tree in response so the
   * datapoints match: missing indices are added, excess ones pruned.
   */
  onSegmentCountChanged?: (device: GoveeDevice) => void;

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
   * Settle the device's segment count from every source (catalog quirk, learned
   * count, Cloud capabilities, manual list) and store it on the device — the
   * one place the domain object is written. The state-tree builder receives
   * the number and only reads it.
   *
   * @param device Target device
   * @returns The count the segment tree is to be built for
   */
  public syncSegmentCount(device: GoveeDevice): number {
    const count = effectiveSegmentCount(device, this.registry);
    device.segmentCount = count;
    return count;
  }

  /**
   * Generate diagnostics data for a device — structured JSON for GitHub
   * issue submission. Delegates to the DiagnosticsCollector so the JSON
   * also includes ring-buffer context (recent logs, MQTT packets, last
   * API responses).
   *
   * @param device Target device
   * @param adapterVersion Adapter version string
   * @param prefix Device state prefix, so the report can include the object tree
   */
  generateDiagnostics(device: GoveeDevice, adapterVersion: string, prefix?: string): Promise<Record<string, unknown>> {
    return this.diagnostics.generate(device, adapterVersion, prefix);
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
      // The report has to show a failed account-list fetch too. Sensors and
      // appliances get their reachability and their readings from exactly this
      // call — when it fails, the report used to look as if it had never been
      // attempted, which is indistinguishable from "this account has no such
      // devices" (feedback_diag_system_self_service: every swallowed API call
      // must reach the report). Recorded once per device so it shows up in the
      // report of whichever device the user exports.
      for (const dev of this.devices.values()) {
        this.diagnostics.recordApiFailure(dev.deviceId, "/device/rest/devices/v1/list", err, extractHttpStatus(err));
      }
      return 0;
    }
    // Reset on success so the next failure warns again.
    this.lastAppApiErrorCategory = null;
    // Snapshot the App-API list as the second account-membership source. This
    // endpoint (empty-body POST) returns the COMPLETE Govee-Home account list,
    // so it is authoritative for sensors (which never appear in /user/devices).
    this.lastAppList = {
      ok: entries.length > 0,
      keys: new Set(entries.map(e => this.deviceKey(e.sku, e.device))),
    };
    // Apply each entry in a plain loop — the per-entry work only touches its own
    // device and the downstream onCloudCapabilities callback is fire-and-forget
    // (it enqueues its own setState work), so there is nothing to parallelise.
    let updated = 0;
    const gatewayDiscovered: GoveeDevice[] = [];
    for (const entry of entries) {
      const device = this.devices.get(this.deviceKey(entry.sku, entry.device));
      if (!device) {
        continue;
      }
      // Gateway-connected sensor (e.g. H5109 behind an H5042): capture which
      // gateway it hangs off. Set-only-when-present — NEVER cleared on a poll
      // that omits gatewayInfo, so a flaky/partial response can't churn the
      // object tree. Independent of the reading caps below, so it happens even
      // on a poll that carried no fresh temperature.
      const gw = formatGatewayLabel(entry.settings?.gatewayInfo);
      if (gw && device.gateway !== gw) {
        device.gateway = gw;
        gatewayDiscovered.push(device);
      }
      // The gateway's own device id — the link that makes krobi's rule possible
      // ("the gateway is the online/offline device", 2026-09-03). Set-only-when-
      // present, same as the label above: a partial response must not unlink it.
      const gwId = entry.settings?.gatewayInfo?.device;
      if (typeof gwId === "string" && gwId && device.gatewayDeviceId !== gwId) {
        device.gatewayDeviceId = gwId;
      }
      const hasHumidityCap = device.capabilities.some(c => c.instance === "sensorHumidity");
      const caps = buildCapabilitiesFromAppEntryHelper(entry, Date.now(), hasHumidityCap);
      if (caps.length === 0) {
        continue;
      }
      this.onCloudCapabilities?.(device, caps);
      // mapSingleCapability returns null for the synthetic `online` cap (online
      // is a device-level property, not a regular state), so onCloudCapabilities
      // never reaches info.online via the capability pipeline. Pluck it out and
      // apply it directly — otherwise sensor SKUs like H5179 stay at
      // info.online=false forever even while their readings keep updating.
      this.maybeApplyCloudOnline(device, caps);
      this.diagnostics.recordApiSuccess(device.deviceId, "/device/rest/devices/v1/list", entry);
      updated++;
    }
    // A newly-discovered gateway is static device metadata — persist it (so the
    // info.gateway state is available straight from cache on the next restart,
    // in phase 1) and re-run the info-state pass once so info.gateway appears
    // now instead of only after the next cloud refresh. Guarded to fire only on
    // a genuine change, so the steady state does no extra work.
    if (gatewayDiscovered.length > 0) {
      this.saveDevicesToCache();
      const all = this.getDevices();
      for (const device of gatewayDiscovered) {
        this.onCloudDataReady?.(device, all);
      }
    }
    // Resolve every gateway-backed device against its gateway. This is the only
    // place that can: reachability is decided per-device everywhere else, and a
    // sensor cannot see its gateway from there.
    this.resolveGatewayReachability();
    // Reconcile now that the (complete) App-API account list is fresh — this is
    // what surfaces a sold sensor (absent here) for removal after the debounce.
    this.runAccountReconcile("app");
    return updated;
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
   * Which channel a write to this command would take, and why — the same
   * decision a real write makes. Read-only, no I/O; the diagnostics report uses
   * it to show HOW a device is driven, which is what a stranger's model needs
   * before it can be added to the catalogue.
   *
   * @param device Target device
   * @param command Command token, e.g. "power" or "segmentColor:3"
   */
  resolveTransport(device: GoveeDevice, command: string): TransportDecision {
    return this.commandRouter.resolveTransport(device, command);
  }

  /**
   * Public entry for the Cloud state read (`/device/state`). That response
   * carries Govee's own reachability for the device, and until 2.29.1 the
   * adapter threw it away: the value translator has no `online` branch, so the
   * capability fell into its default and nothing else looked at it.
   *
   * That gap is why a device with no local API had no evidence at all — which
   * 2.29.0 then papered over by inferring reachability from the cloud CHANNEL,
   * reporting unplugged devices as reachable. This is the honest source.
   *
   * @param device The device the state read was for
   * @param caps The capabilities Govee returned
   */
  applyCloudStateOnline(device: GoveeDevice, caps: CloudStateCapability[]): void {
    this.maybeApplyCloudOnline(device, caps);
  }

  /**
   * Apply the cloud / App-API online cap, but ONLY where it is the authoritative
   * reachability signal: sensors, appliances, and lights with no local
   * interface. A LAN-driven light keeps its LAN-decided info.online — Govee's
   * cloud cache lags real LAN reachability (2× false-positive `true` on
   * 2026-05-13). Since 2.30.0 the test is `isLanDriven`, not `lanIp`: the
   * address is re-discovered by scan on every restart, so judging by it would
   * hand every light to the stale cloud cache for one cycle after each start.
   *
   * @param device Target device
   * @param caps Capability list carrying the online flag
   */
  private maybeApplyCloudOnline(device: GoveeDevice, caps: CloudStateCapability[]): void {
    if (!isLanDriven(device)) {
      this.applyOnlineCap(device, caps);
    }
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
   * Cap every gateway-backed device's reachability at its gateway's.
   *
   * A battery sensor or button behind a Govee gateway has no connection of its
   * own — it wakes, chirps over the radio link and sleeps again. It cannot prove
   * its own reachability; only the gateway can (measured: 17 of 143 devices in a
   * real account list have no push topic, and they are exactly this group).
   * krobi's rule 2026-09-03: the gateway IS the online/offline device.
   *
   * Deliberately a CAP, not a replacement: a dead gateway makes the device
   * unreachable, but a live gateway does not make it reachable on its own. A
   * flat battery or a device out of radio range stays silent while the gateway
   * happily keeps reporting — believing the gateway there would be a false
   * green, and a false green is the one nobody notices. The device's own fresh
   * reading (isSensorDataFresh) remains the positive evidence.
   *
   * A gateway that is not in the account list caps nothing.
   */
  private resolveGatewayReachability(): void {
    for (const dev of this.devices.values()) {
      if (!dev.gatewayDeviceId) {
        continue;
      }
      const wanted = normalizeDeviceId(dev.gatewayDeviceId);
      let gateway: GoveeDevice | undefined;
      for (const candidate of this.devices.values()) {
        if (normalizeDeviceId(candidate.deviceId) === wanted) {
          gateway = candidate;
          break;
        }
      }
      dev.state.gatewayOnline = gateway ? gateway.state.online === true : undefined;
    }
  }

  /**
   * Whether at least one device in the registry needs the App-API call —
   * sensors and appliances for their readings, and (since 2.30.0) any light
   * without a local interface, for which this call is the guaranteed renewer of
   * its reachability proof. Used to skip the poll where nothing would consume
   * it, and as a checkAllReady gate so "ready" is only logged once those values
   * can actually arrive.
   */
  public hasDeviceNeedingAppApi(): boolean {
    for (const dev of this.devices.values()) {
      if (dev.sku === "BaseGroup") {
        continue;
      }
      if (dev.type !== GOVEE_DEVICE_TYPE.LIGHT) {
        return true;
      }
      // Since 2.30.0 a light with no local interface also needs this call — it
      // is the guaranteed renewer of its reachability proof. The account push
      // is event-driven: a device that simply sits there and does nothing sends
      // nothing, so its proof would expire and the device would go grey while
      // being perfectly fine. One account-wide call every 2 minutes, exactly the
      // cost an installation with any sensor already pays.
      if (!isLanDriven(dev)) {
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
    // Cloud-only lights need the cloud online signal too; LAN-capable lights
    // stay LAN-driven (same rule as the App-API path — see maybeApplyCloudOnline).
    this.maybeApplyCloudOnline(device, event.capabilities);
  }
}
