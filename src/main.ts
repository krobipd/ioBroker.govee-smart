import * as utils from "@iobroker/adapter-core";
import {
  applyQuirksToStates,
  getDefaultLanStates,
  mapCapabilities,
  mapCloudStateValue,
  type StateDefinition,
} from "./lib/capability-mapper.js";
import { DeviceManager } from "./lib/device-manager.js";
import { GoveeCloudClient } from "./lib/govee-cloud-client.js";
import { GoveeLanClient } from "./lib/govee-lan-client.js";
import { GoveeMqttClient } from "./lib/govee-mqtt-client.js";
import {
  LocalSnapshotStore,
  type LocalSnapshot,
} from "./lib/local-snapshots.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { SkuCache } from "./lib/sku-cache.js";
import { StateManager } from "./lib/state-manager.js";
import type { AdapterConfig, DeviceState, GoveeDevice } from "./lib/types.js";

class GoveeAdapter extends utils.Adapter {
  private deviceManager: DeviceManager | null = null;
  private stateManager: StateManager | null = null;
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  private skuCache: SkuCache | null = null;
  private localSnapshots: LocalSnapshotStore | null = null;
  private cloudWasConnected = false;
  private readyLogged = false;
  private cloudInitDone = false;
  private lanScanDone = false;
  private statesReady = false;
  private stateCreationQueue: Promise<void>[] = [];

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }

  /** Adapter started — initialize all channels */
  private async onReady(): Promise<void> {
    const config = this.config as unknown as AdapterConfig;

    // Ensure info.connection exists
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection status",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.mqttConnected", {
      type: "state",
      common: {
        name: "MQTT connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.cloudConnected", {
      type: "state",
      common: {
        name: "Cloud API connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });

    this.stateManager = new StateManager(this);
    this.deviceManager = new DeviceManager(this.log);
    const dataDir = utils.getAbsoluteInstanceDataDir(this);
    this.skuCache = new SkuCache(dataDir, this.log);
    this.localSnapshots = new LocalSnapshotStore(dataDir, this.log);
    this.deviceManager.setSkuCache(this.skuCache);

    this.deviceManager.setCallbacks(
      (device, state) => this.onDeviceStateUpdate(device, state),
      (devices) => this.onDeviceListChanged(devices),
    );

    // Update info.ip when LAN IP changes
    this.deviceManager.onLanIpChanged = (device, ip) => {
      const prefix = this.stateManager!.devicePrefix(device);
      this.setStateAsync(`${prefix}.info.ip`, { val: ip, ack: true }).catch(
        () => {},
      );
    };

    // Sync individual segment states after batch command
    this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
      const prefix = this.stateManager!.devicePrefix(device);
      for (const idx of batch.segments) {
        if (batch.color !== undefined) {
          const hex = `#${batch.color.toString(16).padStart(6, "0")}`;
          this.setStateAsync(`${prefix}.segments.${idx}.color`, {
            val: hex,
            ack: true,
          }).catch(() => {});
        }
        if (batch.brightness !== undefined) {
          this.setStateAsync(`${prefix}.segments.${idx}.brightness`, {
            val: batch.brightness,
            ack: true,
          }).catch(() => {});
        }
      }
    };

    // Log startup with configured channels
    const startChannels: string[] = ["LAN"];
    if (config.apiKey) {
      startChannels.push("Cloud");
    }
    if (config.goveeEmail && config.goveePassword) {
      startChannels.push("MQTT");
    }
    this.log.info(
      `Starting with channels: ${startChannels.join(", ")} — please wait...`,
    );

    // --- LAN (always active) ---
    this.lanClient = new GoveeLanClient(this.log, this);
    this.deviceManager.setLanClient(this.lanClient);

    this.lanClient.start(
      (lanDevice) => {
        this.deviceManager!.handleLanDiscovery(lanDevice);
        // Request status after discovery
        this.lanClient!.requestStatus(lanDevice.ip);
      },
      (sourceIp, status) => {
        this.deviceManager!.handleLanStatus(sourceIp, status);
      },
      30_000,
      config.networkInterface || "",
    );

    // Wait for first LAN scan responses (UDP multicast, devices respond within 1-2s)
    this.setTimeout(() => {
      this.lanScanDone = true;
      this.checkAllReady();
    }, 3_000);

    // --- MQTT (if account credentials provided) ---
    // Initialize MQTT before Cloud so scene library can load on first cycle
    if (config.goveeEmail && config.goveePassword) {
      this.mqttClient = new GoveeMqttClient(
        config.goveeEmail,
        config.goveePassword,
        this.log,
        this,
      );
      this.deviceManager.setMqttClient(this.mqttClient);

      await this.mqttClient.connect(
        (update) => this.deviceManager!.handleMqttStatus(update),
        (connected) => {
          this.setStateAsync("info.mqttConnected", {
            val: connected,
            ack: true,
          }).catch(() => {});
          if (connected) {
            for (const dev of this.deviceManager!.getDevices()) {
              if (dev.mqttTopic) {
                this.mqttClient!.registerDeviceTopic(
                  dev.deviceId,
                  dev.mqttTopic,
                );
              }
            }
            this.checkAllReady();
          }
          this.updateConnectionState();
        },
      );
    }

    // --- Device data: Cache first, Cloud only on cache miss ---
    const cachedOk = this.deviceManager.loadFromCache();

    if (config.apiKey) {
      this.cloudClient = new GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);

      this.rateLimiter = new RateLimiter(this.log, this);
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);

      if (!cachedOk) {
        // No cache — first start, fetch from Cloud once
        const cloudOk = await this.deviceManager.loadFromCloud();
        this.cloudWasConnected = cloudOk;
        this.setStateAsync("info.cloudConnected", {
          val: cloudOk,
          ack: true,
        }).catch(() => {});

        if (cloudOk) {
          await this.loadCloudStates();
        }
      } else {
        this.log.info("Using cached device data — no Cloud calls needed");
        this.cloudWasConnected = true;
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true,
        }).catch(() => {});
      }
      this.cloudInitDone = true;
    }

    // Wait for all state creation from cache/cloud load to complete
    await Promise.all(this.stateCreationQueue);
    this.stateCreationQueue = [];
    this.statesReady = true;

    // Subscribe to all writable device and group states
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");

    // Cleanup stale devices after initial discovery (30s delay for LAN scan)
    this.setTimeout(() => {
      if (this.stateManager && this.deviceManager) {
        this.stateManager
          .cleanupDevices(this.deviceManager.getDevices())
          .catch(() => {});
      }
    }, 30_000);

    this.updateConnectionState();

    // Check if all channels are ready — may already be true if MQTT connected fast
    this.checkAllReady();
    // Safety timeout: log ready even if a channel takes too long
    this.setTimeout(() => {
      if (!this.readyLogged) {
        this.readyLogged = true;
        this.logDeviceSummary();
      }
    }, 30_000);
  }

  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
    try {
      this.lanClient?.stop();
      this.mqttClient?.disconnect();
      this.rateLimiter?.stop();
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
      // ignore
    }
    callback();
  }

  /**
   * Handle state changes from user (write operations).
   *
   * @param id State ID
   * @param state New state value
   */
  private async onStateChange(
    id: string,
    state: ioBroker.State | null | undefined,
  ): Promise<void> {
    if (!state || state.ack || !this.deviceManager || !this.stateManager) {
      return;
    }

    // Find which device this state belongs to
    const localId = id.replace(`${this.namespace}.`, "");
    if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
      return;
    }

    const device = this.findDeviceForState(localId);
    if (!device) {
      return;
    }

    // Determine command from state suffix after device prefix
    const prefix = this.stateManager.devicePrefix(device);
    const stateSuffix = localId.slice(prefix.length + 1);
    // Handle local snapshot commands (no Cloud/MQTT needed)
    if (
      stateSuffix === "snapshots.snapshot_save" &&
      typeof state.val === "string" &&
      state.val.trim()
    ) {
      await this.handleSnapshotSave(device, state.val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }
    if (
      stateSuffix === "snapshots.snapshot_local" &&
      state.val !== "0" &&
      state.val !== 0
    ) {
      await this.handleSnapshotRestore(device, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }
    if (
      stateSuffix === "snapshots.snapshot_delete" &&
      typeof state.val === "string" &&
      state.val.trim()
    ) {
      this.handleSnapshotDelete(device, state.val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }

    const command = this.stateToCommand(stateSuffix);

    if (!command) {
      // Try generic capability routing via state object metadata
      const obj = await this.getObjectAsync(id);
      if (obj?.native?.capabilityType && obj?.native?.capabilityInstance) {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            obj.native.capabilityType as string,
            obj.native.capabilityInstance as string,
            state.val,
          );
          await this.setStateAsync(id, { val: state.val, ack: true });
        } catch (err) {
          this.log.warn(
            `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.log.debug(`Unknown writable state: ${stateSuffix}`);
      }
      return;
    }

    try {
      // Music mode: combine all music states into one STRUCT command
      if (command === "music") {
        await this.sendMusicCommand(device, prefix, stateSuffix, state.val);
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      }

      await this.deviceManager.sendCommand(device, command, state.val);
      // Optimistic ack
      await this.setStateAsync(id, { val: state.val, ack: true });
      // Reset scene dropdowns when switching to solid color/colorTemp
      if (command === "colorRgb" || command === "colorTemperature") {
        for (const [ch, key] of [
          ["scenes", "light_scene"],
          ["scenes", "diy_scene"],
          ["snapshots", "snapshot"],
        ]) {
          const sceneId = `${this.namespace}.${prefix}.${ch}.${key}`;
          const sceneState = await this.getStateAsync(sceneId);
          if (sceneState?.val && sceneState.val !== "0") {
            await this.setStateAsync(sceneId, { val: "0", ack: true });
          }
        }
      }
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build and send a music_setting STRUCT command.
   * Reads sibling music state values and combines them into one API call.
   *
   * @param device Target device
   * @param prefix Device state prefix
   * @param changedSuffix Which music state was changed
   * @param newValue New value for the changed state
   */
  private async sendMusicCommand(
    device: GoveeDevice,
    prefix: string,
    changedSuffix: string,
    newValue: ioBroker.StateValue,
  ): Promise<void> {
    const musicBase = `${this.namespace}.${prefix}.music`;

    // Read current sibling values
    const modeState = await this.getStateAsync(`${musicBase}.music_mode`);
    const sensState = await this.getStateAsync(
      `${musicBase}.music_sensitivity`,
    );
    const autoState = await this.getStateAsync(`${musicBase}.music_auto_color`);

    // Apply the changed value, use siblings for the rest
    const musicMode =
      changedSuffix === "music.music_mode"
        ? parseInt(String(newValue), 10)
        : parseInt(String(modeState?.val ?? 0), 10);
    const sensitivity =
      changedSuffix === "music.music_sensitivity"
        ? (newValue as number)
        : ((sensState?.val as number) ?? 100);
    const autoColor =
      changedSuffix === "music.music_auto_color"
        ? newValue
          ? 1
          : 0
        : autoState?.val
          ? 1
          : 0;

    if (!musicMode || musicMode === 0) {
      this.log.debug("Music mode not selected, skipping command");
      return;
    }

    // LAN first: send via ptReal BLE if device is on LAN
    if (device.lanIp && this.lanClient) {
      // Read current color for RGB-modes (Spectrum=1, Rolling=2)
      let r = 0,
        g = 0,
        b = 0;
      if (musicMode === 1 || musicMode === 2) {
        const colorState = await this.getStateAsync(
          `${this.namespace}.${prefix}.control.colorRgb`,
        );
        if (colorState?.val && typeof colorState.val === "string") {
          const hex = colorState.val.replace("#", "");
          const num = parseInt(hex, 16) || 0;
          r = (num >> 16) & 0xff;
          g = (num >> 8) & 0xff;
          b = num & 0xff;
        }
      }
      this.lanClient.setMusicMode(device.lanIp, musicMode, r, g, b);
      return;
    }

    // Cloud fallback
    const structValue: Record<string, unknown> = {
      musicMode,
      sensitivity,
      autoColor,
    };

    await this.deviceManager!.sendCapabilityCommand(
      device,
      "devices.capabilities.music_setting",
      "musicMode",
      structValue,
    );
  }

  /**
   * Called by device-manager when a device state changes
   *
   * @param device Updated device
   * @param state Changed state values
   */
  private onDeviceStateUpdate(
    device: GoveeDevice,
    state: Partial<DeviceState>,
  ): void {
    if (this.stateManager) {
      this.stateManager.updateDeviceState(device, state).catch(() => {});
    }
    this.updateConnectionState();
  }

  /**
   * Called by device-manager when the device list changes
   *
   * @param devices Current list of all devices
   */
  private onDeviceListChanged(devices: GoveeDevice[]): void {
    if (!this.stateManager) {
      return;
    }

    for (const device of devices) {
      let stateDefs: StateDefinition[];

      if (device.lanIp) {
        // LAN-capable: use LAN defaults for basic states, add Cloud extras
        stateDefs = getDefaultLanStates();
        if (device.capabilities.length > 0) {
          const lanIds = new Set(stateDefs.map((d) => d.id));
          const cloudDefs = mapCapabilities(device.capabilities);
          for (const cd of cloudDefs) {
            if (!lanIds.has(cd.id)) {
              stateDefs.push(cd);
            }
          }
        }
      } else {
        // Cloud-only: use Cloud capabilities
        stateDefs = mapCapabilities(device.capabilities);
      }

      // Apply device quirks (e.g. correct color temp range for specific SKUs)
      applyQuirksToStates(device.sku, stateDefs);

      // Remove generic JSON states from capability mapper —
      // only add back as real dropdowns if we have actual scene/snapshot/diy data
      stateDefs = stateDefs.filter(
        (d) =>
          d.id !== "light_scene" && d.id !== "diy_scene" && d.id !== "snapshot",
      );

      if (device.scenes.length > 0) {
        const sceneStates: Record<string, string> = { 0: "---" };
        device.scenes.forEach((s, i) => {
          sceneStates[i + 1] = s.name;
        });
        stateDefs.push({
          id: "light_scene",
          name: "Light Scene",
          type: "string",
          role: "text",
          write: true,
          states: sceneStates,
          def: "0",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "lightScene",
        });
      }

      // Scene speed slider — only if any scene supports speed adjustment
      const maxSpeedLevels = device.sceneLibrary.reduce((max, s) => {
        if (!s.speedInfo?.supSpeed || !s.speedInfo.config) {
          return max;
        }
        try {
          const levels = JSON.parse(s.speedInfo.config) as unknown[];
          return Math.max(max, levels.length);
        } catch {
          return max;
        }
      }, 0);
      if (maxSpeedLevels > 1) {
        stateDefs.push({
          id: "scene_speed",
          name: "Scene Speed",
          type: "number",
          role: "level",
          write: true,
          min: 0,
          max: maxSpeedLevels - 1,
          def: 0,
          capabilityType: "local",
          capabilityInstance: "sceneSpeed",
        });
      }

      if (device.diyScenes.length > 0) {
        const diyStates: Record<string, string> = { 0: "---" };
        device.diyScenes.forEach((s, i) => {
          diyStates[i + 1] = s.name;
        });
        stateDefs.push({
          id: "diy_scene",
          name: "DIY Scene",
          type: "string",
          role: "text",
          write: true,
          states: diyStates,
          def: "0",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "diyScene",
        });
      }

      if (device.snapshots.length > 0) {
        const snapStates: Record<string, string> = { 0: "---" };
        device.snapshots.forEach((s, i) => {
          snapStates[i + 1] = s.name;
        });
        stateDefs.push({
          id: "snapshot",
          name: "Snapshot",
          type: "string",
          role: "text",
          write: true,
          states: snapStates,
          def: "0",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "snapshot",
        });
      }

      // Local snapshots (100% LAN, no Cloud needed)
      const localSnaps = this.localSnapshots?.getSnapshots(
        device.sku,
        device.deviceId,
      );
      const localSnapStates: Record<string, string> = { 0: "---" };
      if (localSnaps) {
        localSnaps.forEach((s, i) => {
          localSnapStates[i + 1] = s.name;
        });
      }
      stateDefs.push({
        id: "snapshot_local",
        name: "Local Snapshot",
        type: "string",
        role: "text",
        write: true,
        states: localSnapStates,
        def: "0",
        capabilityType: "local",
        capabilityInstance: "snapshotLocal",
      });
      stateDefs.push({
        id: "snapshot_save",
        name: "Save Local Snapshot",
        type: "string",
        role: "text",
        write: true,
        def: "",
        capabilityType: "local",
        capabilityInstance: "snapshotSave",
      });
      stateDefs.push({
        id: "snapshot_delete",
        name: "Delete Local Snapshot",
        type: "string",
        role: "text",
        write: true,
        def: "",
        capabilityType: "local",
        capabilityInstance: "snapshotDelete",
      });

      const p = this.stateManager
        .createDeviceStates(device, stateDefs)
        .catch((e) => {
          this.log.error(
            `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      this.stateCreationQueue.push(p);
    }

    this.updateConnectionState();
  }

  /** Update global info.connection */
  private updateConnectionState(): void {
    const hasDevices = (this.deviceManager?.getDevices().length ?? 0) > 0;
    const anyOnline =
      this.deviceManager?.getDevices().some((d) => d.state.online) ?? false;
    const lanRunning = this.lanClient !== null;
    const connected = hasDevices ? anyOnline : lanRunning;
    this.setStateAsync("info.connection", { val: connected, ack: true }).catch(
      () => {},
    );
  }

  /**
   * Check if all configured channels are initialized and log ready message.
   * Called from MQTT onConnection callback and end of onReady.
   */
  private checkAllReady(): void {
    if (this.readyLogged) {
      return;
    }
    // Wait for first LAN scan (always active)
    if (!this.lanScanDone) {
      return;
    }
    // Wait for initial state creation to complete
    if (!this.statesReady) {
      return;
    }
    // Wait for Cloud init if configured
    if (this.cloudClient && !this.cloudInitDone) {
      return;
    }
    // Wait for MQTT connection if configured
    if (this.mqttClient && !this.mqttClient.connected) {
      return;
    }
    this.readyLogged = true;
    this.logDeviceSummary();
  }

  /**
   * Log final ready message with device/group/channel summary.
   */
  private logDeviceSummary(): void {
    if (!this.deviceManager) {
      return;
    }
    const all = this.deviceManager.getDevices();
    const devices = all.filter((d) => d.sku !== "BaseGroup");
    const groups = all.filter((d) => d.sku === "BaseGroup");

    const channels: string[] = ["LAN"];
    if (this.cloudWasConnected) {
      channels.push("Cloud");
    }
    if (this.mqttClient?.connected) {
      channels.push("MQTT");
    }

    if (devices.length === 0 && groups.length === 0) {
      this.log.info(
        `Govee adapter ready — no devices found (channels: ${channels.join("+")})`,
      );
      return;
    }

    // Summary line
    const parts: string[] = [];
    if (devices.length > 0) {
      parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
    }
    if (groups.length > 0) {
      parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
    }
    this.log.info(
      `Govee adapter ready — ${parts.join(", ")} (channels: ${channels.join("+")})`,
    );
  }

  /**
   * Load current state for all Cloud devices and populate state values.
   * Called once after initial Cloud device list load.
   */
  private async loadCloudStates(): Promise<void> {
    if (!this.cloudClient || !this.deviceManager || !this.stateManager) {
      return;
    }

    const devices = this.deviceManager.getDevices();
    // LAN-first: never overwrite LAN states with Cloud values
    const lanStateIds = new Set(getDefaultLanStates().map((s) => s.id));
    let loaded = 0;

    for (const device of devices) {
      if (!device.channels.cloud || device.capabilities.length === 0) {
        continue;
      }

      try {
        const caps = await this.cloudClient.getDeviceState(
          device.sku,
          device.deviceId,
        );
        const prefix = this.stateManager.devicePrefix(device);

        for (const cap of caps) {
          const mapped = mapCloudStateValue(cap);
          if (!mapped) {
            continue;
          }
          // Skip LAN-covered states for LAN-capable devices
          if (device.lanIp && lanStateIds.has(mapped.stateId)) {
            continue;
          }
          const statePath = this.stateManager.resolveStatePath(
            prefix,
            mapped.stateId,
          );
          const obj = await this.getObjectAsync(statePath);
          if (obj) {
            await this.setStateAsync(statePath, {
              val: mapped.value,
              ack: true,
            });
          }
        }
        loaded++;
      } catch {
        this.log.debug(
          `Could not load Cloud state for ${device.name} (${device.sku})`,
        );
      }
    }

    if (loaded > 0) {
      this.log.debug(`Cloud states loaded for ${loaded} devices`);
    }
  }

  /**
   * Find device for a state ID
   *
   * @param localId Local state ID without namespace prefix
   */
  private findDeviceForState(localId: string): GoveeDevice | undefined {
    if (!this.deviceManager || !this.stateManager) {
      return undefined;
    }

    for (const device of this.deviceManager.getDevices()) {
      const prefix = this.stateManager.devicePrefix(device);
      if (localId.startsWith(`${prefix}.`)) {
        return device;
      }
    }
    return undefined;
  }

  /**
   * Map state suffix to command name
   *
   * @param suffix State ID suffix (e.g. "power", "brightness")
   */
  private stateToCommand(suffix: string): string | null {
    // Control channel — basic device controls
    if (suffix === "control.power") {
      return "power";
    }
    if (suffix === "control.brightness") {
      return "brightness";
    }
    if (suffix === "control.colorRgb") {
      return "colorRgb";
    }
    if (suffix === "control.colorTemperature") {
      return "colorTemperature";
    }
    if (suffix === "control.scene") {
      return "scene";
    }
    if (suffix === "control.gradient_toggle") {
      return "gradientToggle";
    }
    // Scenes channel
    if (suffix === "scenes.light_scene") {
      return "lightScene";
    }
    if (suffix === "scenes.diy_scene") {
      return "diyScene";
    }
    if (suffix === "scenes.scene_speed") {
      return "sceneSpeed";
    }
    // Music channel
    if (
      suffix === "music.music_mode" ||
      suffix === "music.music_sensitivity" ||
      suffix === "music.music_auto_color"
    ) {
      return "music";
    }
    // Snapshots channel
    if (suffix === "snapshots.snapshot") {
      return "snapshot";
    }
    // Segment commands — encode segment index in command name
    const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
    if (segColorMatch) {
      return `segmentColor:${segColorMatch[1]}`;
    }
    const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
    if (segBrightMatch) {
      return `segmentBrightness:${segBrightMatch[1]}`;
    }
    // Batch segment command
    if (suffix === "segments.command") {
      return "segmentBatch";
    }
    return null;
  }

  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  private async handleSnapshotSave(
    device: GoveeDevice,
    name: string,
  ): Promise<void> {
    if (!this.localSnapshots || !this.stateManager) {
      return;
    }

    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;

    // Read current state values
    const powerState = await this.getStateAsync(
      `${ns}.${prefix}.control.power`,
    );
    const brightState = await this.getStateAsync(
      `${ns}.${prefix}.control.brightness`,
    );
    const colorState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorRgb`,
    );
    const ctState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorTemperature`,
    );

    const snapshot: LocalSnapshot = {
      name,
      power: powerState?.val === true,
      brightness: typeof brightState?.val === "number" ? brightState.val : 0,
      colorRgb:
        typeof colorState?.val === "string" ? colorState.val : "#000000",
      colorTemperature: typeof ctState?.val === "number" ? ctState.val : 0,
      savedAt: Date.now(),
    };

    this.localSnapshots.saveSnapshot(device.sku, device.deviceId, snapshot);
    this.log.info(`Local snapshot saved: "${name}" for ${device.name}`);

    // Refresh device states to update the dropdown
    this.onDeviceListChanged(this.deviceManager!.getDevices());
  }

  /**
   * Restore a local snapshot by index.
   *
   * @param device Target device
   * @param val Dropdown index value
   */
  private async handleSnapshotRestore(
    device: GoveeDevice,
    val: ioBroker.StateValue,
  ): Promise<void> {
    if (!this.localSnapshots || !this.deviceManager) {
      return;
    }

    const idx = parseInt(String(val), 10);
    if (idx < 1) {
      return;
    }

    const snaps = this.localSnapshots.getSnapshots(device.sku, device.deviceId);
    const snap = snaps[idx - 1];
    if (!snap) {
      this.log.warn(`Local snapshot index ${idx} not found for ${device.name}`);
      return;
    }

    this.log.info(`Restoring local snapshot "${snap.name}" for ${device.name}`);

    // Send each state via LAN → MQTT → Cloud routing
    await this.deviceManager.sendCommand(device, "power", snap.power);
    if (snap.power) {
      await this.deviceManager.sendCommand(
        device,
        "brightness",
        snap.brightness,
      );
      if (snap.colorTemperature > 0) {
        await this.deviceManager.sendCommand(
          device,
          "colorTemperature",
          snap.colorTemperature,
        );
      } else {
        await this.deviceManager.sendCommand(device, "colorRgb", snap.colorRgb);
      }
    }
  }

  /**
   * Delete a local snapshot by name.
   *
   * @param device Target device
   * @param name Snapshot name to delete
   */
  private handleSnapshotDelete(device: GoveeDevice, name: string): void {
    if (!this.localSnapshots) {
      return;
    }

    if (this.localSnapshots.deleteSnapshot(device.sku, device.deviceId, name)) {
      this.log.info(`Local snapshot deleted: "${name}" for ${device.name}`);
      // Refresh device states to update the dropdown
      this.onDeviceListChanged(this.deviceManager!.getDevices());
    } else {
      this.log.warn(`Local snapshot "${name}" not found for ${device.name}`);
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
