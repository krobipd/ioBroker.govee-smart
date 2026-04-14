import { CommandRouter } from "./command-router.js";
import { getDeviceQuirks } from "./device-quirks.js";
import type { GoveeApiClient } from "./govee-api-client.js";
import type { GoveeCloudClient } from "./govee-cloud-client.js";
import type { GoveeLanClient } from "./govee-lan-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { CachedDeviceData, SkuCache } from "./sku-cache.js";
import {
  classifyError,
  normalizeDeviceId,
  rgbToHex,
  type CloudDevice,
  type DeviceState,
  type ErrorCategory,
  type GoveeDevice,
  type LanDevice,
  type MqttStatusUpdate,
} from "./types.js";

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
 * 5 packets × 4 segment slots = max 20 segments.
 * Format per slot: [Brightness 0-100] [R] [G] [B].
 * Only returns segments up to segmentCount.
 *
 * @param commands Base64-encoded BLE packets from MQTT op.command
 * @param segmentCount Device segment count (limits output)
 */
export function parseMqttSegmentData(
  commands: string[],
  segmentCount: number,
): MqttSegmentData[] {
  if (segmentCount <= 0) {
    return [];
  }

  const segments: MqttSegmentData[] = [];

  for (const cmd of commands) {
    const bytes = Buffer.from(cmd, "base64");
    // AA A5 packets are 20 bytes: AA A5 <packetNum> <4×4 bytes data> <checksum>
    if (bytes.length < 20 || bytes[0] !== 0xaa || bytes[1] !== 0xa5) {
      continue;
    }

    const packetNum = bytes[2]; // 01-05
    if (packetNum < 1 || packetNum > 5) {
      continue;
    }

    const baseIndex = (packetNum - 1) * 4;
    for (let slot = 0; slot < 4; slot++) {
      const segIdx = baseIndex + slot;
      if (segIdx >= segmentCount) {
        break;
      }
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

  return segments;
}

/**
 * Device manager — maintains unified device list and routes commands
 * through the fastest available channel: LAN → MQTT → Cloud.
 */
export class DeviceManager {
  private readonly log: ioBroker.Logger;
  private readonly devices = new Map<string, GoveeDevice>();
  private readonly commandRouter: CommandRouter;
  private cloudClient: GoveeCloudClient | null = null;
  private apiClient: GoveeApiClient | null = null;
  private skuCache: SkuCache | null = null;
  private onDeviceUpdate:
    | ((device: GoveeDevice, state: Partial<DeviceState>) => void)
    | null = null;
  private onDeviceListChanged: ((devices: GoveeDevice[]) => void) | null = null;
  private lastErrorCategory: ErrorCategory | null = null;

  /** @param log ioBroker logger */
  constructor(log: ioBroker.Logger) {
    this.log = log;
    this.commandRouter = new CommandRouter(log);
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
        // Merge cached data into LAN-discovered device
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

    // Check if cache has incomplete scene data (e.g. from previous rate limit)
    const incomplete = Array.from(this.devices.values()).some(
      (d) =>
        d.scenes.length === 0 &&
        d.sceneLibrary.length > 0 &&
        d.type === "light",
    );
    if (incomplete) {
      this.log.info(
        "Cache has incomplete scene data — will re-fetch from Cloud",
      );
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
  async loadFromCloud(): Promise<boolean> {
    if (!this.cloudClient) {
      return false;
    }

    try {
      const cloudDevices = await this.cloudClient.getDevices();

      // Step 1: Merge Cloud devices into local device map
      let changed = this.mergeCloudDevices(cloudDevices);

      // Step 2: Load scenes, snapshots, and libraries for light devices
      for (const cd of cloudDevices) {
        if (
          cd.type === "light" ||
          cd.capabilities.some((c) => c.type.includes("dynamic_scene"))
        ) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            if (await this.loadDeviceScenes(device, cd)) {
              changed = true;
            }
            if (await this.loadDeviceLibraries(device, cd.sku)) {
              changed = true;
            }
          }
        }
      }

      // Step 3: Save to cache and finalize
      this.saveDevicesToCache();

      for (const device of this.devices.values()) {
        this.populateScenesFromLibrary(device);
      }

      if (changed) {
        this.onDeviceListChanged?.(this.getDevices());
      }
      this.lastErrorCategory = null;
      return true;
    } catch (err) {
      this.logDedup("Cloud device list failed", err);
      return false;
    }
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
    for (const cd of cloudDevices) {
      const existing = this.devices.get(this.deviceKey(cd.sku, cd.device));
      if (existing) {
        existing.name = cd.deviceName || existing.name;
        existing.capabilities = cd.capabilities;
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
    let changed = false;

    // Scenes from dedicated scenes endpoint (rate-limited)
    const loadScenes = async (): Promise<void> => {
      try {
        const { lightScenes, diyScenes, snapshots } =
          await this.cloudClient!.getScenes(cd.sku, cd.device);
        if (
          lightScenes.length > 0 ||
          diyScenes.length > 0 ||
          snapshots.length > 0
        ) {
          const scenesChanged =
            lightScenes.length !== device.scenes.length ||
            diyScenes.length !== device.diyScenes.length ||
            snapshots.length !== device.snapshots.length;
          device.scenes = lightScenes;
          device.diyScenes = diyScenes;
          device.snapshots = snapshots;
          if (scenesChanged) {
            changed = true;
          }
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
            changed = true;
          }
        } catch {
          this.log.debug(`Could not load DIY scenes for ${cd.sku}`);
        }
      };
      await this.commandRouter.executeRateLimited(loadDiy, 2);
    }

    // Snapshots from device capabilities (fallback)
    if (device.snapshots.length === 0) {
      const snapCap = cd.capabilities.find(
        (c) =>
          c.type === "devices.capabilities.dynamic_scene" &&
          c.instance === "snapshot" &&
          c.parameters.options,
      );
      if (snapCap?.parameters.options) {
        device.snapshots = snapCap.parameters.options
          .filter(
            (o) =>
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

    if (
      device.scenes.length > 0 ||
      device.diyScenes.length > 0 ||
      device.snapshots.length > 0
    ) {
      changed = true;
    }

    return changed;
  }

  /**
   * Load scene/music/DIY libraries and SKU features from undocumented API.
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

    if (device.sceneLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchSceneLibrary(sku);
        if (lib.length > 0) {
          device.sceneLibrary = lib;
          changed = true;
          this.log.debug(`Scene library for ${sku}: ${lib.length} scenes`);
        }
      } catch {
        this.log.debug(`Could not load scene library for ${sku}`);
      }
    }

    if (device.musicLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchMusicLibrary(sku);
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
    }

    if (device.diyLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchDiyLibrary(sku);
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
    }

    if (!device.skuFeatures) {
      try {
        const features = await this.apiClient.fetchSkuFeatures(sku);
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
    }

    // Load snapshot BLE commands for local activation
    if (!device.snapshotBleCmds && device.snapshots.length > 0) {
      try {
        const snaps = await this.apiClient.fetchSnapshots(sku, device.deviceId);
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

  /** Save all devices to SKU cache, skipping those with incomplete scene data. */
  private saveDevicesToCache(): void {
    if (!this.skuCache) {
      return;
    }

    let cachedCount = 0;
    let skippedCount = 0;
    for (const device of this.devices.values()) {
      const isLight = device.type === "light";
      const scenesIncomplete =
        isLight && device.scenes.length === 0 && device.capabilities.length > 0;
      if (scenesIncomplete) {
        skippedCount++;
        this.log.debug(
          `Not caching ${device.name} (${device.sku}) — scene data incomplete`,
        );
      } else {
        this.skuCache.save(this.goveeDeviceToCached(device));
        cachedCount++;
      }
    }
    if (skippedCount > 0) {
      this.log.info(
        `Cached ${cachedCount} device(s), skipped ${skippedCount} with incomplete data — will retry next start`,
      );
    } else {
      this.log.info(
        `Cached ${cachedCount} device(s) — next start uses cache, no Cloud needed`,
      );
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
        type: "light",
        lanIp: lanDevice.ip,
        capabilities: [],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
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

    // Parse per-segment data from BLE notification packets (AA A5)
    if (update.op?.command && device.segmentCount) {
      const segData = parseMqttSegmentData(
        update.op.command,
        device.segmentCount,
      );
      if (segData.length > 0) {
        this.onMqttSegmentUpdate?.(device, segData);
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
   * Send a command to a device — routes through LAN → MQTT → Cloud.
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
      capabilities: cd.capabilities,
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
      state: { online: false },
      channels: { lan: false, mqtt: false, cloud: false },
    };
  }

  /**
   * Extract cacheable data from a GoveeDevice
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
      cachedAt: Date.now(),
    };
  }

  /**
   * Generate diagnostics data for a device — structured JSON for GitHub issue submission.
   *
   * @param device Target device
   * @param adapterVersion Adapter version string
   */
  generateDiagnostics(
    device: GoveeDevice,
    adapterVersion: string,
  ): Record<string, unknown> {
    const quirks = getDeviceQuirks(device.sku);
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
      },
      capabilities: device.capabilities,
      scenes: {
        count: device.scenes.length,
        names: device.scenes.map((s) => s.name),
      },
      diyScenes: {
        count: device.diyScenes.length,
        names: device.diyScenes.map((s) => s.name),
      },
      snapshots: {
        count: device.snapshots.length,
        names: device.snapshots.map((s) => s.name),
      },
      sceneLibrary: {
        count: device.sceneLibrary.length,
        entries: device.sceneLibrary.map((s) => ({
          name: s.name,
          sceneCode: s.sceneCode,
          hasParam: !!s.scenceParam,
          speedSupported: s.speedInfo?.supSpeed ?? false,
        })),
      },
      musicLibrary: {
        count: device.musicLibrary.length,
        entries: device.musicLibrary.map((m) => ({
          name: m.name,
          musicCode: m.musicCode,
          mode: m.mode ?? null,
        })),
      },
      diyLibrary: {
        count: device.diyLibrary.length,
        entries: device.diyLibrary.map((d) => ({
          name: d.name,
          diyCode: d.diyCode,
        })),
      },
      quirks: quirks ?? null,
      skuFeatures: device.skuFeatures,
      state: { ...device.state },
    };
  }
}
