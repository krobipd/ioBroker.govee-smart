import * as utils from "@iobroker/adapter-core";
import {
  getDefaultLanStates,
  mapCapabilities,
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
    await this.setStateAsync("info.connection", { val: false, ack: true });

    this.stateManager = new StateManager(this);
    this.deviceManager = new DeviceManager(this.log);

    this.deviceManager.setCallbacks(
      (device, state) => this.onDeviceStateUpdate(device, state),
      (devices) => this.onDeviceListChanged(devices),
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
    );

    // --- Cloud (if API key provided) ---
    if (config.apiKey) {
      this.cloudClient = new GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);

      this.rateLimiter = new RateLimiter(this.log, this);
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);

      // Initial cloud load
      await this.deviceManager.loadFromCloud();

      // Periodic cloud refresh
      const intervalMs = Math.max(30, config.pollInterval ?? 60) * 1000;
      this.cloudPollTimer = this.setInterval(() => {
        void this.deviceManager!.loadFromCloud();
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
          if (connected) {
            this.log.debug("MQTT connected — real-time status active");
            // Register device topics
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
        void this.stateManager.cleanupDevices(this.deviceManager.getDevices());
      }
    }, 30_000);

    this.updateConnectionState();

    const channels: string[] = ["LAN"];
    if (config.apiKey) {
      channels.push("Cloud");
    }
    if (config.goveeEmail) {
      channels.push("MQTT");
    }
    this.log.info(`Govee adapter started — channels: ${channels.join(", ")}`);
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
      void this.stateManager.updateDeviceState(device, state);
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

      void this.stateManager.createDeviceStates(device, stateDefs);
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
    void this.setStateAsync("info.connection", { val: connected, ack: true });
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
    // Segment commands
    if (suffix.startsWith("segments.") && suffix.endsWith(".color")) {
      return "segmentColor";
    }
    if (suffix.startsWith("segments.") && suffix.endsWith(".brightness")) {
      return "segmentBrightness";
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
