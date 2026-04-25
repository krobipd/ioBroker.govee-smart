import { CommandRouter } from "./command-router.js";
import { getDeviceQuirks } from "./device-registry.js";
import { DiagnosticsCollector } from "./diagnostics.js";
import type { AppDeviceEntry, GoveeApiClient } from "./govee-api-client.js";
import type { GoveeCloudClient } from "./govee-cloud-client.js";
import type { GoveeLanClient } from "./govee-lan-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { CachedDeviceData, SkuCache } from "./sku-cache.js";
import {
  classifyError,
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
} from "./types.js";
import { HttpError } from "./http-client.js";

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
export function parseMqttSegmentData(commands: string[]): MqttSegmentData[] {
  if (!Array.isArray(commands)) {
    return [];
  }

  const segments: MqttSegmentData[] = [];
  // Track the highest packetNum seen so we know where real data ends.
  let highestPacket = 0;

  for (const cmd of commands) {
    if (typeof cmd !== "string") {
      continue;
    }
    const bytes = Buffer.from(cmd, "base64");
    if (bytes.length < 20 || bytes[0] !== 0xaa || bytes[1] !== 0xa5) {
      continue;
    }

    const packetNum = bytes[2];
    if (packetNum < 1 || packetNum > 5) {
      continue;
    }
    if (packetNum > highestPacket) {
      highestPacket = packetNum;
    }

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

  // Trim trailing padding slots from the highest packet: Govee pads short
  // packets with 0x00 bytes, so a run of all-zero slots at the end is not
  // real segment data but filler. Keep any zero-slots that are followed by
  // a real one — they're legitimately-unlit middle segments.
  while (segments.length > 0) {
    const tail = segments[segments.length - 1];
    if (tail.brightness === 0 && tail.r === 0 && tail.g === 0 && tail.b === 0) {
      segments.pop();
    } else {
      break;
    }
  }

  return segments;
}

/**
 * Effective physical segment indices for a device.
 * Uses `device.manualSegments` when `device.manualMode=true` (cut strip override),
 * falls back to `0..segmentCount-1` otherwise. Empty if device has no segments.
 *
 * @param device Target device
 */
export function getEffectiveSegmentIndices(device: GoveeDevice): number[] {
  if (
    device.manualMode &&
    Array.isArray(device.manualSegments) &&
    device.manualSegments.length > 0
  ) {
    return device.manualSegments.slice();
  }
  const count = device.segmentCount ?? 0;
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Resolve the authoritative segment count for a device.
 *
 * Priority:
 *   1. `device.segmentCount` if already set (from cache, MQTT discovery, or wizard)
 *   2. Minimum of positive `segment_color_setting` capability counts
 *   3. 0 if no capability advertises segments
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
  if (typeof device.segmentCount === "number" && device.segmentCount > 0) {
    return device.segmentCount;
  }
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  let min = Number.POSITIVE_INFINITY;
  for (const c of caps) {
    if (
      !c ||
      typeof c.type !== "string" ||
      !c.type.includes("segment_color_setting")
    ) {
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
      if (fn === "segment" && rawMax >= 0) {
        const n = rawMax + 1;
        if (n > 0 && n < min) {
          min = n;
        }
      }
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** Protocol limit: Govee's segment bitmask is 7 bytes × 8 bits = 56 slots (0..55). */
export const SEGMENT_HARD_MAX = 55;

/**
 * Device manager — maintains unified device list and routes commands
 * through the fastest available channel: LAN → Cloud.
 * MQTT is status-push only and never used for commands.
 */
export class DeviceManager {
  private readonly log: ioBroker.Logger;
  private readonly devices = new Map<string, GoveeDevice>();
  private readonly commandRouter: CommandRouter;
  private readonly diagnostics: DiagnosticsCollector;
  private cloudClient: GoveeCloudClient | null = null;
  private apiClient: GoveeApiClient | null = null;
  private skuCache: SkuCache | null = null;
  private onDeviceUpdate:
    | ((device: GoveeDevice, state: Partial<DeviceState>) => void)
    | null = null;
  private onDeviceListChanged: ((devices: GoveeDevice[]) => void) | null = null;
  private onCloudCapabilities:
    | ((device: GoveeDevice, caps: CloudStateCapability[]) => void)
    | null = null;
  private lastErrorCategory: ErrorCategory | null = null;

  /**
   * @param log    ioBroker logger
   * @param timers Adapter timer wrapper (forwarded to CommandRouter for
   *   onUnload-safe delays).
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
    this.log = log;
    this.commandRouter = new CommandRouter(log, timers);
    this.diagnostics = new DiagnosticsCollector();
  }

  /**
   * Expose the diagnostics collector so adapter-side hooks (MQTT,
   * Cloud, log wrapper) can write into the per-device ring buffers.
   */
  getDiagnostics(): DiagnosticsCollector {
    return this.diagnostics;
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
   * Set callbacks for device state changes and list changes.
   *
   * @param onUpdate Called when a device state changes (from any channel)
   * @param onListChanged Called when the device list changes (new/removed devices)
   */
  setCallbacks(
    onUpdate: (device: GoveeDevice, state: Partial<DeviceState>) => void,
    onListChanged: (devices: GoveeDevice[]) => void,
  ): void {
    this.onDeviceUpdate = onUpdate;
    this.onDeviceListChanged = onListChanged;
  }

  /** Get all known devices */
  getDevices(): GoveeDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Drop a device from the internal map. Called after the state-manager
   * has deleted its object tree so the DeviceManager's map doesn't grow
   * unboundedly across the adapter's lifetime.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  removeDevice(sku: string, deviceId: string): void {
    this.devices.delete(this.deviceKey(sku, deviceId));
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

    let changed = false;
    for (const entry of cached) {
      const key = this.deviceKey(entry.sku, entry.deviceId);
      const existing = this.devices.get(key);
      if (existing) {
        // Merge cached data into LAN-discovered device. Segment-specific
        // fields (segmentCount, manualMode, manualSegments) MUST be merged
        // too — LAN discovery runs before the cache load on every start, so
        // the existing-branch is the normal path. Missing these three meant
        // every restart threw away the wizard/MQTT-learned segment state and
        // fell back to Cloud's min-advertised count.
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
        changed = true;
      } else {
        this.devices.set(key, this.cachedToGoveeDevice(entry));
        changed = true;
      }
    }

    if (changed) {
      this.log.info(`Loaded ${cached.length} device(s) from cache`);
    }

    // Always refetch cloud data on startup — scenesChecked is purely diagnostic
    // now, not a gate. Snapshots are user-content (created dynamically in the
    // Govee Home app) and would miss new entries if we relied solely on the
    // cache. The refetch costs one call per light device per startup, well
    // within rate limits. Users can also trigger a fresh fetch without
    // restart via `info.refresh_cloud_data`.
    const hasLight = Array.from(this.devices.values()).some(
      (d) => d.type === "devices.types.light",
    );
    if (hasLight) {
      this.log.debug("Cache loaded — will refresh scenes/snapshots via Cloud");
      return false;
    }

    // Fill scenes from sceneLibrary for devices where Cloud scenes are missing
    for (const device of this.devices.values()) {
      this.populateScenesFromLibrary(device);
    }

    if (changed) {
      this.onDeviceListChanged?.(this.getDevices());
    }
    return cached.length > 0;
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
      // (deleted devices that are no longer in the app). Filter out entries
      // without capabilities — those are almost certainly stale registrations.
      const cloudDevices = Array.isArray(rawCloudDevices)
        ? rawCloudDevices.filter(
            (cd) =>
              cd &&
              typeof cd.sku === "string" &&
              typeof cd.device === "string" &&
              Array.isArray(cd.capabilities) &&
              cd.capabilities.length > 0,
          )
        : [];

      if (
        Array.isArray(rawCloudDevices) &&
        rawCloudDevices.length !== cloudDevices.length
      ) {
        this.log.info(
          `Cloud: received ${rawCloudDevices.length} devices raw, ${cloudDevices.length} after filter (skipped stale entries without capabilities)`,
        );
      }

      // Step 1: Merge Cloud devices into local device map
      let changed = this.mergeCloudDevices(cloudDevices);

      // Step 2: Load scenes, snapshots, and libraries for light devices
      for (const cd of cloudDevices) {
        const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
        const isLight =
          cd.type === "devices.types.light" ||
          caps.some(
            (c) =>
              c &&
              typeof c.type === "string" &&
              c.type.includes("dynamic_scene"),
          );
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

      // Step 3: Prune stale cache entries (only after successful Cloud-load
      // with a plausible response — never prune on Cloud failure or empty list)
      if (this.skuCache && cloudDevices.length > 0) {
        this.skuCache.pruneStale(14);
      }

      // Step 4: Save to cache and finalize
      this.saveDevicesToCache();

      for (const device of this.devices.values()) {
        this.populateScenesFromLibrary(device);
      }

      if (changed) {
        this.onDeviceListChanged?.(this.getDevices());
      }
      this.lastErrorCategory = null;
      return { ok: true };
    } catch (err) {
      this.logDedup("Cloud device list failed", err);

      // Govee 429: respect Retry-After header (default 60s if missing)
      if (err instanceof HttpError && err.statusCode === 429) {
        const retryAfterRaw = err.headers["retry-after"];
        const retryAfterSec =
          typeof retryAfterRaw === "string" && /^\d+$/.test(retryAfterRaw)
            ? parseInt(retryAfterRaw, 10)
            : 60;
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterMs: retryAfterSec * 1000,
        };
      }

      // Auth failure: API-Key falsch oder widerrufen — KEIN Retry
      const category = classifyError(err);
      if (category === "AUTH") {
        return {
          ok: false,
          reason: "auth-failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Netzwerk/Timeout/Unknown: transient, einfach später
      return { ok: false, reason: "transient" };
    }
  }

  /**
   * Re-fetch scenes and snapshots for all known light devices without
   * re-running the full Cloud bootstrap. Skips `loadDeviceLibraries` — the
   * undocumented library/sku-features endpoints are static (libraries never
   * change for a given SKU) and some return 403 for many accounts, so
   * running them again on every user-triggered refresh only produces a
   * multi-minute rate-limiter backlog without adding data.
   *
   * Used by the `info.refresh_cloud_data` button for "new snapshot/scene
   * was saved in the Govee Home app, show it here".
   *
   * @returns true when any device's scene/snapshot data changed
   */
  async refreshSceneData(): Promise<boolean> {
    if (!this.cloudClient) {
      return false;
    }
    let anyChanged = false;
    const lights = Array.from(this.devices.values()).filter(
      (d) => d.type === "devices.types.light",
    );
    for (const device of lights) {
      const cd: CloudDevice = {
        sku: device.sku,
        device: device.deviceId,
        deviceName: device.name,
        type: device.type,
        capabilities: Array.isArray(device.capabilities)
          ? device.capabilities
          : [],
      };
      if (await this.loadDeviceScenes(device, cd)) {
        anyChanged = true;
      }
    }
    if (anyChanged) {
      this.saveDevicesToCache();
      for (const device of this.devices.values()) {
        this.populateScenesFromLibrary(device);
      }
      this.onDeviceListChanged?.(this.getDevices());
    }
    return anyChanged;
  }

  /**
   * Merge Cloud device list into local device map.
   * Updates existing devices, adds new ones.
   *
   * @param cloudDevices Devices from Cloud API
   * @returns true if any new devices were added
   */
  private mergeCloudDevices(cloudDevices: CloudDevice[]): boolean {
    let changed = false;
    if (!Array.isArray(cloudDevices)) {
      return false;
    }
    for (const cd of cloudDevices) {
      // Defensive guard against malformed cloud entries
      if (!cd || typeof cd.sku !== "string" || typeof cd.device !== "string") {
        continue;
      }
      const existing = this.devices.get(this.deviceKey(cd.sku, cd.device));
      if (existing) {
        existing.name = cd.deviceName || existing.name;
        existing.capabilities = Array.isArray(cd.capabilities)
          ? cd.capabilities
          : [];
        existing.type = cd.type;
        existing.channels.cloud = true;
      } else {
        const device = this.cloudDeviceToGoveeDevice(cd);
        this.devices.set(this.deviceKey(cd.sku, cd.device), device);
        changed = true;
        this.log.debug(`Cloud: New device ${cd.deviceName} (${cd.sku})`);
      }

      const quirks = getDeviceQuirks(cd.sku);
      if (quirks?.brokenPlatformApi) {
        this.log.debug(
          `${cd.sku} has known broken platform API metadata — capabilities may be incomplete`,
        );
      }
    }
    return changed;
  }

  /**
   * Load scenes, DIY scenes, and snapshots for a device from Cloud API.
   *
   * @param device Target device to populate
   * @param cd Cloud device data with capabilities
   * @returns true if any scene data changed
   */
  private async loadDeviceScenes(
    device: GoveeDevice,
    cd: CloudDevice,
  ): Promise<boolean> {
    // Scenes from dedicated scenes endpoint (rate-limited).
    // Guards are per-list, not combined: Govee's /device/scenes sometimes
    // returns 149 lightScenes + 0 snapshots (or vice versa) on back-to-back
    // calls even though the snapshot exists. A combined guard (if any list
    // non-empty, overwrite all) would wipe the other lists on that call and
    // break the dropdown until the next lucky round-trip. One guard per
    // list keeps the last-known-good data in place.
    const loadScenes = async (): Promise<void> => {
      try {
        const { lightScenes, diyScenes, snapshots } =
          await this.cloudClient!.getScenes(cd.sku, cd.device);
        if (lightScenes.length > 0) {
          device.scenes = lightScenes;
        }
        if (diyScenes.length > 0) {
          device.diyScenes = diyScenes;
        }
        if (snapshots.length > 0) {
          device.snapshots = snapshots;
        }
      } catch {
        this.log.debug(`Could not load scenes for ${cd.sku}`);
      }
    };
    await this.commandRouter.executeRateLimited(loadScenes, 2);

    // DIY scenes from dedicated endpoint
    if (device.diyScenes.length === 0) {
      const loadDiy = async (): Promise<void> => {
        try {
          const diy = await this.cloudClient!.getDiyScenes(cd.sku, cd.device);
          if (diy.length > 0) {
            device.diyScenes = diy;
          }
        } catch {
          this.log.debug(`Could not load DIY scenes for ${cd.sku}`);
        }
      };
      await this.commandRouter.executeRateLimited(loadDiy, 2);
    }

    // Snapshots from device capabilities (fallback)
    if (device.snapshots.length === 0) {
      const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      const snapCap = caps.find(
        (c) =>
          c &&
          c.type === "devices.capabilities.dynamic_scene" &&
          c.instance === "snapshot" &&
          Array.isArray(c.parameters?.options),
      );
      if (snapCap?.parameters?.options) {
        device.snapshots = snapCap.parameters.options
          .filter(
            (o) =>
              o &&
              typeof o.name === "string" &&
              o.value !== undefined &&
              o.value !== null,
          )
          .map((o) => ({
            name: o.name,
            value:
              typeof o.value === "number"
                ? o.value
                : (o.value as Record<string, unknown>),
          }));
        this.log.debug(
          `Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`,
        );
      }
    }

    // "Changed" = we ended up with any scene/snapshot data. Inner tracking
    // was redundant with this single-source check.
    return (
      device.scenes.length > 0 ||
      device.diyScenes.length > 0 ||
      device.snapshots.length > 0
    );
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
   * @returns true if any library data changed
   */
  private async loadDeviceLibraries(
    device: GoveeDevice,
    sku: string,
  ): Promise<boolean> {
    if (!this.apiClient) {
      return false;
    }

    let changed = false;

    // Run each fetch inside a rate-limited slot. Priority 2 = below
    // control commands and scene/snapshot loads; library data is cache-only
    // and can wait for a quieter moment.
    const runLimited = async (fn: () => Promise<void>): Promise<void> => {
      await this.commandRouter.executeRateLimited(fn, 2);
    };

    if (device.sceneLibrary.length === 0) {
      await runLimited(async () => {
        try {
          const lib = await this.apiClient!.fetchSceneLibrary(sku);
          if (lib.length > 0) {
            device.sceneLibrary = lib;
            changed = true;
            this.log.debug(`Scene library for ${sku}: ${lib.length} scenes`);
          }
        } catch {
          this.log.debug(`Could not load scene library for ${sku}`);
        }
      });
    }

    if (device.musicLibrary.length === 0) {
      await runLimited(async () => {
        try {
          const lib = await this.apiClient!.fetchMusicLibrary(sku);
          if (lib.length > 0) {
            device.musicLibrary = lib;
            changed = true;
            this.log.debug(`Music library for ${sku}: ${lib.length} modes`);
          }
        } catch (e) {
          this.log.debug(
            `Could not load music library for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    }

    if (device.diyLibrary.length === 0) {
      await runLimited(async () => {
        try {
          const lib = await this.apiClient!.fetchDiyLibrary(sku);
          if (lib.length > 0) {
            device.diyLibrary = lib;
            changed = true;
            this.log.debug(`DIY library for ${sku}: ${lib.length} effects`);
          }
        } catch (e) {
          this.log.debug(
            `Could not load DIY library for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    }

    if (!device.skuFeatures) {
      await runLimited(async () => {
        try {
          const features = await this.apiClient!.fetchSkuFeatures(sku);
          if (features) {
            device.skuFeatures = features;
            changed = true;
            this.log.debug(
              `SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`,
            );
          }
        } catch (e) {
          this.log.debug(
            `Could not load SKU features for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    }

    // Load snapshot BLE commands for local activation
    if (!device.snapshotBleCmds && device.snapshots.length > 0) {
      await runLimited(async () => {
        try {
          const snaps = await this.apiClient!.fetchSnapshots(
            sku,
            device.deviceId,
          );
          if (snaps.length > 0) {
            device.snapshotBleCmds = device.snapshots.map((ds) => {
              const match = snaps.find((s) => s.name === ds.name);
              return match?.bleCmds ?? [];
            });
            changed = true;
            this.log.debug(
              `Snapshot BLE for ${sku}: ${snaps.length} snapshots with local data`,
            );
          }
        } catch (e) {
          this.log.debug(
            `Could not load snapshot BLE for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
          );
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
      this.log.debug(
        "Group membership requires Email+Password — skipping member resolution",
      );
      return false;
    }

    try {
      const apiGroups = await this.apiClient.fetchGroupMembers();
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
        const apiGroup = apiGroups.find(
          (g) => String(g.groupId) === group.deviceId,
        );
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
            this.log.debug(
              `Group "${group.name}": member ${m.sku}/${m.deviceId} not in device map`,
            );
          }
        }

        group.groupMembers = members;
        if (members.length > 0) {
          changed = true;
        }
        this.log.debug(
          `Group "${group.name}": ${members.length}/${apiGroup.devices.length} members resolved`,
        );
      }

      if (changed) {
        this.onDeviceListChanged?.(this.getDevices());
      }
      return changed;
    } catch (e) {
      this.log.debug(
        `Could not load group members: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** Save all devices to SKU cache, skipping only those never confirmed via Cloud yet. */
  public saveDevicesToCache(): void {
    if (!this.skuCache) {
      return;
    }

    let cachedCount = 0;
    let skippedCount = 0;
    for (const device of this.devices.values()) {
      const isLight = device.type === "devices.types.light";
      // Skip only if we never asked Cloud yet — empty scenes are legitimate
      // once confirmed via scenesChecked=true.
      if (isLight && !device.scenesChecked) {
        skippedCount++;
        this.log.debug(
          `Not caching ${device.name} (${device.sku}) — scenes not yet checked`,
        );
      } else {
        this.skuCache.save(this.goveeDeviceToCached(device));
        cachedCount++;
      }
    }
    // Routine persistence — debug level only. Users don't need a play-by-play
    // for every cache write. Significant events (scenes fetched, MQTT bumps)
    // log themselves elsewhere.
    if (skippedCount > 0) {
      this.log.debug(
        `Cached ${cachedCount} device(s), skipped ${skippedCount} not yet checked`,
      );
    } else {
      this.log.debug(`Cached ${cachedCount} device(s) — next start uses cache`);
    }
  }

  /**
   * Handle LAN device discovery — match against known devices or create new.
   *
   * @param lanDevice Discovered LAN device
   */
  handleLanDiscovery(lanDevice: LanDevice): void {
    // Try to find by device ID (colon-separated in Cloud, varies in LAN)
    let matched: GoveeDevice | undefined;
    for (const dev of this.devices.values()) {
      if (
        normalizeDeviceId(dev.deviceId) === normalizeDeviceId(lanDevice.device)
      ) {
        matched = dev;
        break;
      }
      // Also match by SKU if device IDs don't match format
      if (dev.sku === lanDevice.sku && !dev.lanIp) {
        matched = dev;
        break;
      }
    }

    if (matched) {
      const ipChanged = matched.lanIp !== lanDevice.ip;
      matched.lanIp = lanDevice.ip;
      matched.channels.lan = true;
      matched.lastSeenOnNetwork = Date.now();
      if (ipChanged) {
        this.log.debug(
          `LAN: ${matched.name} (${matched.sku}) at ${lanDevice.ip}`,
        );
        this.onLanIpChanged?.(matched, lanDevice.ip);
      }
    } else {
      // LAN-only device (no Cloud data yet)
      // Include short device ID suffix for uniqueness (multiple devices can share same SKU)
      const shortId = normalizeDeviceId(lanDevice.device).slice(-4);
      const device: GoveeDevice = {
        sku: lanDevice.sku,
        deviceId: lanDevice.device,
        name: `${lanDevice.sku}_${shortId}`,
        type: "devices.types.light",
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
      this.log.debug(`LAN: New device ${lanDevice.sku} at ${lanDevice.ip}`);
      this.onDeviceListChanged?.(this.getDevices());
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
    const state: Partial<DeviceState> = { online: true };

    if (update.state) {
      if (update.state.onOff !== undefined) {
        state.power = update.state.onOff === 1;
      }
      if (update.state.brightness !== undefined) {
        state.brightness = update.state.brightness;
      }
      if (update.state.color) {
        const { r, g, b } = update.state.color;
        state.colorRgb = rgbToHex(r, g, b);
      }
      if (update.state.colorTemInKelvin) {
        state.colorTemperature = update.state.colorTemInKelvin;
      }
    }

    // Merge into device state
    Object.assign(device.state, state);
    this.onDeviceUpdate?.(device, state);

    // Parse per-segment data from BLE notification packets (AA A5).
    // MQTT is authoritative for segment count — the device tells us what it
    // actually has. Cloud only gives an initial best-guess from capabilities.
    if (update.op?.command) {
      const segData = parseMqttSegmentData(update.op.command);

      if (segData.length > 0) {
        const maxSeen = Math.max(...segData.map((s) => s.index)) + 1;
        const current = device.segmentCount ?? 0;
        if (maxSeen > current) {
          this.log.info(
            `${device.name}: detected ${maxSeen} segments via MQTT (was ${current}) — rebuilding state tree`,
          );
          device.segmentCount = maxSeen;
          // Persist now so a restart starts from the real value instead of
          // falling back to Cloud capabilities and deleting the extra slots.
          if (this.skuCache) {
            this.skuCache.save(this.goveeDeviceToCached(device));
          }
          // Skip per-segment sync for this push — the new datapoints don't
          // exist yet. The next AA A5 push hits the fully-built tree.
          this.onSegmentCountGrown?.(device);
          return;
        }
      }

      // Filter by manual-segments override if active — ignore indices the
      // user has declared as "not physically present" (cut strip).
      const filtered =
        device.manualMode &&
        Array.isArray(device.manualSegments) &&
        device.manualSegments.length > 0
          ? segData.filter((s) => device.manualSegments!.includes(s.index))
          : segData;
      if (filtered.length > 0) {
        this.onMqttSegmentUpdate?.(device, filtered);
      }
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
      | ((
          device: GoveeDevice,
          batch: { segments: number[]; color?: number; brightness?: number },
        ) => void)
      | undefined,
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
  async sendCommand(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): Promise<void> {
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
    return this.commandRouter.sendCapabilityCommand(
      device,
      capabilityType,
      capabilityInstance,
      value,
    );
  }

  /** Callback when device LAN IP changes */
  onLanIpChanged?: (device: GoveeDevice, ip: string) => void;

  /** Callback when MQTT delivers per-segment state data (AA A5 BLE packets) */
  onMqttSegmentUpdate?: (
    device: GoveeDevice,
    segments: MqttSegmentData[],
  ) => void;

  /**
   * Callback when the device's physical segment count turns out to be
   * larger than the Cloud-reported value (observed via MQTT AA A5 stream).
   * The adapter rebuilds the state tree in response so the extra indices
   * appear as datapoints.
   */
  onSegmentCountGrown?: (device: GoveeDevice) => void;

  /**
   * Convert Cloud device to internal device model
   *
   * @param cd Cloud API device data
   */
  private cloudDeviceToGoveeDevice(cd: CloudDevice): GoveeDevice {
    return {
      sku: cd.sku,
      deviceId: cd.device,
      name: cd.deviceName || cd.sku,
      type: cd.type || "unknown",
      capabilities: Array.isArray(cd.capabilities) ? cd.capabilities : [],
      scenes: [],
      diyScenes: [],
      snapshots: [],
      sceneLibrary: [],
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
      state: { online: true },
      channels: { lan: false, mqtt: false, cloud: true },
    };
  }

  /**
   * Find device by SKU and device ID (handles format differences)
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private findDeviceBySkuAndId(
    sku: string,
    deviceId: string,
  ): GoveeDevice | undefined {
    // Direct key lookup
    const direct = this.devices.get(this.deviceKey(sku, deviceId));
    if (direct) {
      return direct;
    }

    // Normalized search
    const normalizedId = normalizeDeviceId(deviceId);
    for (const dev of this.devices.values()) {
      if (dev.sku === sku && normalizeDeviceId(dev.deviceId) === normalizedId) {
        return dev;
      }
    }
    return undefined;
  }

  /**
   * Generate unique key for a device
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private deviceKey(sku: string, deviceId: string): string {
    return `${sku}_${normalizeDeviceId(deviceId)}`;
  }

  /**
   * Log error with dedup — only warn on category change, debug on repeat.
   *
   * @param context Error context description
   * @param err Error to log
   */
  private logDedup(context: string, err: unknown): void {
    const category = classifyError(err);
    const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
    if (category !== this.lastErrorCategory) {
      this.lastErrorCategory = category;
      this.log.warn(msg);
    } else {
      this.log.debug(`${msg} (repeated)`);
    }
  }

  /**
   * Fill device.scenes from sceneLibrary when Cloud scenes are missing.
   * ptReal activation matches by name, so sceneLibrary names are sufficient.
   *
   * @param device Device to populate scenes for
   */
  private populateScenesFromLibrary(device: GoveeDevice): void {
    if (device.scenes.length === 0 && device.sceneLibrary.length > 0) {
      device.scenes = device.sceneLibrary.map((entry) => ({
        name: entry.name,
        value: {}, // ptReal uses sceneLibrary directly, Cloud payload not needed
      }));
      this.log.debug(
        `${device.sku}: ${device.scenes.length} scenes from library (Cloud scenes missing)`,
      );
    }
  }

  /**
   * Convert cached data to a GoveeDevice (runtime fields set to defaults)
   *
   * @param cached Cached device data
   */
  private cachedToGoveeDevice(cached: CachedDeviceData): GoveeDevice {
    return {
      sku: cached.sku,
      deviceId: cached.deviceId,
      name: cached.name,
      type: cached.type,
      capabilities: cached.capabilities,
      scenes: cached.scenes,
      diyScenes: cached.diyScenes,
      snapshots: cached.snapshots,
      sceneLibrary: cached.sceneLibrary,
      musicLibrary: cached.musicLibrary,
      diyLibrary: cached.diyLibrary,
      skuFeatures: cached.skuFeatures,
      snapshotBleCmds: cached.snapshotBleCmds,
      scenesChecked: cached.scenesChecked,
      lastSeenOnNetwork: cached.lastSeenOnNetwork,
      // Restore learned count so it wins over Cloud capability on next start.
      segmentCount: cached.segmentCount,
      manualMode: cached.manualMode,
      manualSegments: cached.manualSegments,
      state: { online: false },
      channels: { lan: false, mqtt: false, cloud: false },
    };
  }

  /**
   * Persist a device's current runtime state to the SKU cache.
   * Safe no-op when no cache is configured.
   *
   * @param device Target device
   */
  public persistDeviceToCache(device: GoveeDevice): void {
    if (!this.skuCache) {
      return;
    }
    this.skuCache.save(this.goveeDeviceToCached(device));
  }

  /**
   * Extract cacheable data from a GoveeDevice.
   *
   * @param device Runtime device
   */
  private goveeDeviceToCached(device: GoveeDevice): CachedDeviceData {
    return {
      sku: device.sku,
      deviceId: device.deviceId,
      name: device.name,
      type: device.type,
      capabilities: device.capabilities,
      scenes: device.scenes,
      diyScenes: device.diyScenes,
      snapshots: device.snapshots,
      sceneLibrary: device.sceneLibrary,
      musicLibrary: device.musicLibrary,
      diyLibrary: device.diyLibrary,
      skuFeatures: device.skuFeatures,
      snapshotBleCmds: device.snapshotBleCmds,
      scenesChecked: device.scenesChecked,
      lastSeenOnNetwork: device.lastSeenOnNetwork,
      segmentCount:
        typeof device.segmentCount === "number" && device.segmentCount > 0
          ? device.segmentCount
          : undefined,
      manualMode: device.manualMode ? true : undefined,
      manualSegments:
        device.manualMode &&
        Array.isArray(device.manualSegments) &&
        device.manualSegments.length > 0
          ? device.manualSegments.slice()
          : undefined,
      cachedAt: Date.now(),
    };
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
  generateDiagnostics(
    device: GoveeDevice,
    adapterVersion: string,
  ): Record<string, unknown> {
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
    let entries: AppDeviceEntry[];
    try {
      entries = await this.apiClient.fetchDeviceList();
    } catch (err) {
      const category = classifyError(err);
      const msg = `App API fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      if (category !== this.lastErrorCategory) {
        this.lastErrorCategory = category;
        this.log.warn(msg);
      } else {
        this.log.debug(msg);
      }
      return 0;
    }
    let updated = 0;
    for (const entry of entries) {
      const device = this.devices.get(this.deviceKey(entry.sku, entry.device));
      if (!device) {
        continue;
      }
      const caps = buildCapabilitiesFromAppEntry(entry);
      if (caps.length === 0) {
        continue;
      }
      // Route synthetic capabilities through the existing
      // onCloudCapabilities callback so main.ts's normal setState
      // pipeline (mapCloudStateValue + setStateAsync) handles them.
      this.onCloudCapabilities?.(device, caps);
      this.diagnostics.setApiResponse(
        device.deviceId,
        "/device/rest/devices/v1/list",
        entry,
      );
      updated++;
    }
    return updated;
  }

  /**
   * Hook callback for sources that emit `CloudStateCapability[]` updates
   * outside the normal Cloud-poll path (App-API, OpenAPI-MQTT). Caller is
   * responsible for wiring it to the adapter-side state-write path.
   *
   * @param cb Callback receiving (device, caps)
   */
  setOnCloudCapabilities(
    cb: ((device: GoveeDevice, caps: CloudStateCapability[]) => void) | null,
  ): void {
    this.onCloudCapabilities = cb;
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
  handleOpenApiEvent(event: {
    sku: string;
    device: string;
    capabilities: CloudStateCapability[];
  }): void {
    if (
      !event ||
      typeof event.sku !== "string" ||
      typeof event.device !== "string"
    ) {
      return;
    }
    if (!Array.isArray(event.capabilities) || event.capabilities.length === 0) {
      return;
    }
    const device = this.devices.get(this.deviceKey(event.sku, event.device));
    if (!device) {
      return;
    }
    this.onCloudCapabilities?.(device, event.capabilities);
  }
}

/**
 * Convert an app-API device entry into a list of synthetic Cloud-state
 * capabilities the existing `mapCloudStateValue` pipeline can consume.
 *
 * Govee stores temperature and humidity as integer hundredths of a unit
 * (`tem: 2370` → 23.70 °C, `hum: 4290` → 42.90 % RH). Battery may live
 * either at the lastData level or in deviceSettings — lastData wins
 * because it's the more recent reading.
 *
 * @param entry One entry from `GoveeApiClient.fetchDeviceList()`
 */
export function buildCapabilitiesFromAppEntry(
  entry: AppDeviceEntry,
): CloudStateCapability[] {
  const caps: CloudStateCapability[] = [];
  const last = entry.lastData;
  if (!last) {
    return caps;
  }
  if (typeof last.online === "boolean") {
    caps.push({
      type: "devices.capabilities.online",
      instance: "online",
      state: { value: last.online },
    });
  }
  if (typeof last.tem === "number" && Number.isFinite(last.tem)) {
    caps.push({
      type: "devices.capabilities.property",
      instance: "sensorTemperature",
      state: { value: last.tem / 100 },
    });
  }
  if (typeof last.hum === "number" && Number.isFinite(last.hum)) {
    caps.push({
      type: "devices.capabilities.property",
      instance: "sensorHumidity",
      state: { value: last.hum / 100 },
    });
  }
  if (typeof last.battery === "number" && Number.isFinite(last.battery)) {
    caps.push({
      type: "devices.capabilities.property",
      instance: "battery",
      state: { value: last.battery },
    });
  } else if (
    entry.settings &&
    typeof entry.settings.battery === "number" &&
    Number.isFinite(entry.settings.battery)
  ) {
    caps.push({
      type: "devices.capabilities.property",
      instance: "battery",
      state: { value: entry.settings.battery },
    });
  }
  return caps;
}
