import type { GoveeCloudClient } from "./govee-cloud-client.js";
import type { GoveeLanClient } from "./govee-lan-client.js";
import type { GoveeMqttClient } from "./govee-mqtt-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import type {
  CloudDevice,
  DeviceState,
  GoveeDevice,
  LanDevice,
  MqttStatusUpdate,
} from "./types.js";

/**
 * Device manager — maintains unified device list and routes commands
 * through the fastest available channel: LAN → MQTT → Cloud.
 */
export class DeviceManager {
  private readonly log: ioBroker.Logger;
  private readonly devices = new Map<string, GoveeDevice>();
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  private onDeviceUpdate:
    | ((device: GoveeDevice, state: Partial<DeviceState>) => void)
    | null = null;
  private onDeviceListChanged: ((devices: GoveeDevice[]) => void) | null = null;

  /** @param log ioBroker logger */
  constructor(log: ioBroker.Logger) {
    this.log = log;
  }

  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client: GoveeLanClient): void {
    this.lanClient = client;
  }

  /**
   * Register the MQTT client
   *
   * @param client MQTT client instance
   */
  setMqttClient(client: GoveeMqttClient): void {
    this.mqttClient = client;
  }

  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client: GoveeCloudClient): void {
    this.cloudClient = client;
  }

  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
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
   * Get a device by its unique key (sku_deviceId)
   *
   * @param sku Product model
   * @param deviceId Unique device identifier
   */
  getDevice(sku: string, deviceId: string): GoveeDevice | undefined {
    return this.devices.get(this.deviceKey(sku, deviceId));
  }

  /**
   * Load devices from Cloud API and merge with LAN discovery.
   * Called on startup and periodically.
   */
  async loadFromCloud(): Promise<void> {
    if (!this.cloudClient) {
      return;
    }

    try {
      const cloudDevices = await this.cloudClient.getDevices();
      let changed = false;

      for (const cd of cloudDevices) {
        const existing = this.devices.get(this.deviceKey(cd.sku, cd.device));
        if (existing) {
          // Update capabilities and name
          existing.name = cd.deviceName || existing.name;
          existing.capabilities = cd.capabilities;
          existing.type = cd.type;
          existing.channels.cloud = true;
        } else {
          // New device
          const device = this.cloudDeviceToGoveeDevice(cd);
          this.devices.set(this.deviceKey(cd.sku, cd.device), device);
          changed = true;
          this.log.debug(`Cloud: New device ${cd.deviceName} (${cd.sku})`);
        }
      }

      // Load scenes for light devices
      for (const cd of cloudDevices) {
        if (
          cd.type === "light" ||
          cd.capabilities.some((c) => c.type.includes("mode"))
        ) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device && device.scenes.length === 0) {
            try {
              device.scenes = await this.cloudClient.getScenes(
                cd.sku,
                cd.device,
              );
            } catch {
              this.log.debug(`Could not load scenes for ${cd.sku}`);
            }
          }
        }
      }

      if (changed) {
        this.onDeviceListChanged?.(this.getDevices());
      }
    } catch (err) {
      this.log.warn(
        `Cloud device list failed: ${err instanceof Error ? err.message : String(err)}`,
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
        this.normalizeDeviceId(dev.deviceId) ===
        this.normalizeDeviceId(lanDevice.device)
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
      }
    } else {
      // LAN-only device (no Cloud data yet)
      // Include short device ID suffix for uniqueness (multiple devices can share same SKU)
      const shortId = this.normalizeDeviceId(lanDevice.device).slice(-4);
      const device: GoveeDevice = {
        sku: lanDevice.sku,
        deviceId: lanDevice.device,
        name: `${lanDevice.sku}_${shortId}`,
        type: "light",
        lanIp: lanDevice.ip,
        capabilities: [],
        scenes: [],
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false },
      };
      this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
      this.log.debug(
        `LAN: New device ${lanDevice.sku} at ${lanDevice.ip} (no Cloud data)`,
      );
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
        state.colorRgb = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      }
      if (update.state.colorTemInKelvin) {
        state.colorTemperature = update.state.colorTemInKelvin;
      }
    }

    // Merge into device state
    Object.assign(device.state, state);
    this.onDeviceUpdate?.(device, state);
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
      colorRgb: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
      colorTemperature: status.colorTemInKelvin || undefined,
    };

    Object.assign(device.state, state);
    this.onDeviceUpdate?.(device, state);
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
    // Priority 1: LAN
    if (device.lanIp && this.lanClient) {
      this.sendLanCommand(device, command, value);
      return;
    }

    // Priority 2: MQTT
    if (device.channels.mqtt && this.mqttClient?.connected) {
      if (this.sendMqttCommand(device, command, value)) {
        return;
      }
    }

    // Priority 3: Cloud (rate-limited)
    if (device.channels.cloud && this.cloudClient) {
      await this.sendCloudCommand(device, command, value);
      return;
    }

    this.log.warn(`No channel available for ${device.name} (${device.sku})`);
  }

  /**
   * Send command via LAN UDP
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private sendLanCommand(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): void {
    if (!device.lanIp || !this.lanClient) {
      return;
    }

    switch (command) {
      case "power":
        this.lanClient.setPower(device.lanIp, value as boolean);
        break;
      case "brightness":
        this.lanClient.setBrightness(device.lanIp, value as number);
        break;
      case "colorRgb": {
        const { r, g, b } = this.parseColor(value as string);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value as number);
        break;
      default:
        // LAN doesn't support this command — fall through to MQTT/Cloud
        if (
          this.mqttClient?.connected &&
          this.sendMqttCommand(device, command, value)
        ) {
          return;
        }
        void this.sendCloudCommand(device, command, value);
    }
  }

  /**
   * Send command via MQTT — returns true if sent
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private sendMqttCommand(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): boolean {
    if (!this.mqttClient) {
      return false;
    }

    switch (command) {
      case "power":
        return this.mqttClient.setPower(device.deviceId, value as boolean);
      case "brightness":
        return this.mqttClient.setBrightness(device.deviceId, value as number);
      case "colorRgb": {
        const { r, g, b } = this.parseColor(value as string);
        return this.mqttClient.setColor(device.deviceId, r, g, b);
      }
      case "colorTemperature":
        return this.mqttClient.setColorTemperature(
          device.deviceId,
          value as number,
        );
      default:
        return false;
    }
  }

  /**
   * Send command via Cloud API (rate-limited)
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private async sendCloudCommand(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): Promise<void> {
    if (!this.cloudClient) {
      return;
    }

    // Find the matching capability
    const cap = this.findCapabilityForCommand(device, command);
    if (!cap) {
      this.log.debug(
        `No Cloud capability for command '${command}' on ${device.sku}`,
      );
      return;
    }

    const cloudValue = this.toCloudValue(command, value);

    const execute = async (): Promise<void> => {
      await this.cloudClient!.controlDevice(
        device.sku,
        device.deviceId,
        cap.type,
        cap.instance,
        cloudValue,
      );
    };

    if (this.rateLimiter) {
      await this.rateLimiter.tryExecute(execute, 0);
    } else {
      await execute();
    }
  }

  /**
   * Find capability matching a command name
   *
   * @param device Target device
   * @param command Command type to find capability for
   */
  private findCapabilityForCommand(
    device: GoveeDevice,
    command: string,
  ): { type: string; instance: string } | undefined {
    for (const cap of device.capabilities) {
      const shortType = cap.type.replace("devices.capabilities.", "");
      if (command === "power" && shortType === "on_off") {
        return cap;
      }
      if (
        command === "brightness" &&
        shortType === "range" &&
        cap.instance.toLowerCase().includes("brightness")
      ) {
        return cap;
      }
      if (
        command === "colorRgb" &&
        shortType === "color_setting" &&
        cap.instance === "colorRgb"
      ) {
        return cap;
      }
      if (
        command === "colorTemperature" &&
        shortType === "color_setting" &&
        cap.instance.includes("colorTem")
      ) {
        return cap;
      }
      if (
        command === "scene" &&
        shortType === "mode" &&
        cap.instance === "presetScene"
      ) {
        return cap;
      }
    }
    return undefined;
  }

  /**
   * Convert adapter value to Cloud API value
   *
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  private toCloudValue(command: string, value: unknown): unknown {
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = this.parseColor(value as string);
        return (r << 16) | (g << 8) | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      default:
        return value;
    }
  }

  /**
   * Parse "#RRGGBB" hex string to RGB
   *
   * @param hex Color hex string (e.g. "#FF6600")
   */
  private parseColor(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace("#", "");
    const num = parseInt(clean, 16) || 0;
    return {
      r: (num >> 16) & 0xff,
      g: (num >> 8) & 0xff,
      b: num & 0xff,
    };
  }

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
      state: { online: false },
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
    const normalizedId = this.normalizeDeviceId(deviceId);
    for (const dev of this.devices.values()) {
      if (
        dev.sku === sku &&
        this.normalizeDeviceId(dev.deviceId) === normalizedId
      ) {
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
    return `${sku}_${this.normalizeDeviceId(deviceId)}`;
  }

  /**
   * Normalize device ID — remove colons, lowercase
   *
   * @param id Raw device identifier
   */
  private normalizeDeviceId(id: string): string {
    return id.replace(/:/g, "").toLowerCase();
  }
}
