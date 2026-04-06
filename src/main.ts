import * as utils from "@iobroker/adapter-core";
import {
  getDefaultLanStates,
  mapCapabilities,
  mapCloudStateValue,
  type StateDefinition,
} from "./lib/capability-mapper.js";
import { DeviceManager } from "./lib/device-manager.js";
import { GoveeCloudClient } from "./lib/govee-cloud-client.js";
import { GoveeLanClient } from "./lib/govee-lan-client.js";
import { GoveeMqttClient } from "./lib/govee-mqtt-client.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { StateManager } from "./lib/state-manager.js";
import type { AdapterConfig, DeviceState, GoveeDevice } from "./lib/types.js";

class GoveeAdapter extends utils.Adapter {
  private deviceManager: DeviceManager | null = null;
  private stateManager: StateManager | null = null;
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  private cloudPollTimer: ioBroker.Interval | undefined = undefined;

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

    this.deviceManager.setCallbacks(
      (device, state) => this.onDeviceStateUpdate(device, state),
      (devices) => this.onDeviceListChanged(devices),
    );

    // Log startup hint — initialization may take a while with Cloud/MQTT
    if (config.apiKey || (config.goveeEmail && config.goveePassword)) {
      this.log.info(
        "Starting Govee adapter — initializing channels, this may take a moment...",
      );
    }

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
    );

    // --- Cloud (if API key provided) ---
    if (config.apiKey) {
      this.cloudClient = new GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);

      this.rateLimiter = new RateLimiter(this.log, this);
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);

      // Initial cloud load
      const cloudOk = await this.deviceManager.loadFromCloud();
      this.setStateAsync("info.cloudConnected", {
        val: cloudOk,
        ack: true,
      }).catch(() => {});

      // Load current device states from Cloud
      if (cloudOk) {
        await this.loadCloudStates();
      }

      // Periodic cloud refresh
      const intervalMs = Math.max(30, config.pollInterval ?? 60) * 1000;
      this.cloudPollTimer = this.setInterval(() => {
        this.deviceManager!.loadFromCloud()
          .then((ok) => {
            this.setStateAsync("info.cloudConnected", {
              val: ok,
              ack: true,
            }).catch(() => {});
          })
          .catch(() => {});
      }, intervalMs);
    }

    // --- MQTT (if account credentials provided) ---
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
            this.log.debug("MQTT connected — real-time status active");
            for (const dev of this.deviceManager!.getDevices()) {
              if (dev.mqttTopic) {
                this.mqttClient!.registerDeviceTopic(
                  dev.deviceId,
                  dev.mqttTopic,
                );
              }
            }
          }
          this.updateConnectionState();
        },
      );
    }

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

    // Log final ready message — all channels initialized
    this.logDeviceSummary(config);
  }

  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
    try {
      if (this.cloudPollTimer) {
        this.clearInterval(this.cloudPollTimer);
        this.cloudPollTimer = undefined;
      }
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
    const command = this.stateToCommand(stateSuffix);

    if (!command) {
      this.log.debug(`Unknown writable state: ${stateSuffix}`);
      return;
    }

    try {
      await this.deviceManager.sendCommand(device, command, state.val);
      // Optimistic ack
      await this.setStateAsync(id, { val: state.val, ack: true });
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

      // Always remove generic light_scene/snapshot JSON states from capability mapper —
      // only add back as real dropdowns if we have actual scene/snapshot data
      stateDefs = stateDefs.filter(
        (d) => d.id !== "light_scene" && d.id !== "snapshot",
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

      this.stateManager.createDeviceStates(device, stateDefs).catch((e) => {
        this.log.error(
          `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
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
   * Log final ready message with device/group/channel summary.
   * Called once at the end of onReady after all channels are initialized.
   *
   * @param config Adapter configuration
   */
  private logDeviceSummary(config: AdapterConfig): void {
    if (!this.deviceManager) {
      return;
    }
    const all = this.deviceManager.getDevices();
    const devices = all.filter((d) => d.sku !== "BaseGroup");
    const groups = all.filter((d) => d.sku === "BaseGroup");

    const parts: string[] = [];
    if (devices.length > 0) {
      parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
    }
    if (groups.length > 0) {
      parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
    }

    const channels: string[] = ["LAN"];
    if (config.apiKey) {
      channels.push("Cloud");
    }
    if (config.goveeEmail && config.goveePassword) {
      channels.push("MQTT");
    }

    const deviceInfo = parts.length > 0 ? parts.join(", ") : "no devices found";
    this.log.info(
      `Govee adapter ready (${deviceInfo}, channels: ${channels.join("+")})`,
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
          const obj = await this.getObjectAsync(
            `${prefix}.control.${mapped.stateId}`,
          );
          if (obj) {
            await this.setStateAsync(`${prefix}.control.${mapped.stateId}`, {
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
    if (suffix === "control.light_scene") {
      return "lightScene";
    }
    if (suffix === "control.snapshot") {
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
    return null;
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
