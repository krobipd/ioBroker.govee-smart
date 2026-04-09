import type { GoveeCloudClient } from "./govee-cloud-client.js";
import type { GoveeLanClient } from "./govee-lan-client.js";
import type { GoveeMqttClient } from "./govee-mqtt-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import {
  classifyError,
  normalizeDeviceId,
  type CloudDevice,
  type DeviceState,
  type ErrorCategory,
  type GoveeDevice,
  type LanDevice,
  type MqttStatusUpdate,
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
  private lastErrorCategory: ErrorCategory | null = null;

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
  async loadFromCloud(): Promise<boolean> {
    if (!this.cloudClient) {
      return false;
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

      // Load scenes and snapshots for light devices
      for (const cd of cloudDevices) {
        if (
          cd.type === "light" ||
          cd.capabilities.some((c) => c.type.includes("dynamic_scene"))
        ) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            // Scenes come from the dedicated scenes endpoint (refresh each poll)
            // Rate-limited to avoid hitting API limits during startup
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
            if (this.rateLimiter) {
              await this.rateLimiter.tryExecute(loadScenes, 2);
            } else {
              await loadScenes();
            }

            // DIY scenes from dedicated diy-scenes endpoint
            if (device.diyScenes.length === 0) {
              const loadDiy = async (): Promise<void> => {
                try {
                  const diy = await this.cloudClient!.getDiyScenes(
                    cd.sku,
                    cd.device,
                  );
                  if (diy.length > 0) {
                    device.diyScenes = diy;
                    changed = true;
                  }
                } catch {
                  this.log.debug(`Could not load DIY scenes for ${cd.sku}`);
                }
              };
              if (this.rateLimiter) {
                await this.rateLimiter.tryExecute(loadDiy, 2);
              } else {
                await loadDiy();
              }
            }

            // Snapshots from device capabilities (not in scenes endpoint)
            if (device.snapshots.length === 0) {
              const snapCap = cd.capabilities.find(
                (c) =>
                  c.type === "devices.capabilities.dynamic_scene" &&
                  c.instance === "snapshot" &&
                  c.parameters.options,
              );
              if (snapCap?.parameters.options) {
                this.log.debug(
                  `Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`,
                );
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
              }
            }

            // Scene library from undocumented API (public, no auth needed)
            if (device.sceneLibrary.length === 0 && this.mqttClient) {
              try {
                const lib = await this.mqttClient.fetchSceneLibrary(cd.sku);
                if (lib.length > 0) {
                  device.sceneLibrary = lib;
                  changed = true;
                  this.log.debug(
                    `Scene library for ${cd.sku}: ${lib.length} scenes`,
                  );
                }
              } catch {
                this.log.debug(`Could not load scene library for ${cd.sku}`);
              }
            }

            if (
              device.scenes.length > 0 ||
              device.diyScenes.length > 0 ||
              device.snapshots.length > 0
            ) {
              changed = true;
            }
          }
        }
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
    // Segment commands only work via Cloud API
    if (
      command.startsWith("segmentColor:") ||
      command.startsWith("segmentBrightness:") ||
      command === "segmentBatch"
    ) {
      if (device.channels.cloud && this.cloudClient) {
        if (command === "segmentBatch") {
          await this.sendSegmentBatch(device, value as string);
        } else {
          await this.sendCloudCommand(device, command, value);
        }
        return;
      }
      this.log.debug(`Segment control requires Cloud API for ${device.name}`);
      return;
    }

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
    if (!this.cloudClient || !device.channels.cloud) {
      this.log.debug(
        `Cloud not available for generic command on ${device.name}`,
      );
      return;
    }

    const shortType = capabilityType.replace("devices.capabilities.", "");
    let cloudValue: unknown = value;

    if (shortType === "toggle") {
      cloudValue = value ? 1 : 0;
    }

    const execute = async (): Promise<void> => {
      await this.cloudClient!.controlDevice(
        device.sku,
        device.deviceId,
        capabilityType,
        capabilityInstance,
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
   * Send a batch segment command.
   * Format: "segments:color:brightness" — e.g. "1-5:#ff0000:20", "all:#00ff00", "0,3,7::50"
   *
   * @param device Target device
   * @param commandStr Batch command string
   */
  async sendSegmentBatch(
    device: GoveeDevice,
    commandStr: string,
  ): Promise<void> {
    if (!this.cloudClient) {
      return;
    }

    const parsed = this.parseSegmentBatch(device, commandStr);
    if (!parsed) {
      this.log.warn(
        `Invalid segment command "${commandStr}" for ${device.name}`,
      );
      return;
    }

    const cap = this.findCapabilityForCommand(device, "segmentColor:0");
    if (!cap) {
      this.log.debug(`No segment capability for ${device.name}`);
      return;
    }

    if (parsed.color !== undefined) {
      const execute = async (): Promise<void> => {
        await this.cloudClient!.controlDevice(
          device.sku,
          device.deviceId,
          cap.type,
          cap.instance,
          { segment: parsed.segments, rgb: parsed.color },
        );
      };
      if (this.rateLimiter) {
        await this.rateLimiter.tryExecute(execute, 0);
      } else {
        await execute();
      }
    }

    if (parsed.brightness !== undefined) {
      const brightCap = device.capabilities.find(
        (c) =>
          c.type.includes("segment_color_setting") &&
          c.instance.toLowerCase().includes("brightness"),
      );
      const execute = async (): Promise<void> => {
        await this.cloudClient!.controlDevice(
          device.sku,
          device.deviceId,
          (brightCap ?? cap).type,
          (brightCap ?? cap).instance,
          { segment: parsed.segments, brightness: parsed.brightness },
        );
      };
      if (this.rateLimiter) {
        await this.rateLimiter.tryExecute(execute, 0);
      } else {
        await execute();
      }
    }

    // Update individual segment states to stay in sync
    this.onSegmentBatchUpdate?.(device, parsed);
  }

  /**
   * Parse batch segment command string.
   *
   * @param device Target device (for segment count)
   * @param cmd Command string (e.g. "1-5:#ff0000:20")
   */
  private parseSegmentBatch(
    device: GoveeDevice,
    cmd: string,
  ): {
    segments: number[];
    color?: number;
    brightness?: number;
  } | null {
    const parts = cmd.split(":");
    if (parts.length < 1 || !parts[0]) {
      return null;
    }

    // Parse segment indices
    const segStr = parts[0].trim();
    const segCount = device.segmentCount ?? 15;
    let segments: number[];

    if (segStr === "all") {
      segments = Array.from({ length: segCount }, (_, i) => i);
    } else {
      segments = [];
      for (const part of segStr.split(",")) {
        const rangeMatch = /^(\d+)-(\d+)$/.exec(part.trim());
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          for (let i = start; i <= end && i < segCount; i++) {
            segments.push(i);
          }
        } else {
          const idx = parseInt(part.trim(), 10);
          if (!isNaN(idx) && idx < segCount) {
            segments.push(idx);
          }
        }
      }
    }

    if (segments.length === 0) {
      return null;
    }

    // Parse color (#RRGGBB → packed int)
    let color: number | undefined;
    if (parts.length >= 2 && parts[1]) {
      const colorStr = parts[1].trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(colorStr)) {
        color = parseInt(colorStr.replace("#", ""), 16);
      }
    }

    // Parse brightness (0-100)
    let brightness: number | undefined;
    if (parts.length >= 3 && parts[2]) {
      const bri = parseInt(parts[2].trim(), 10);
      if (!isNaN(bri) && bri >= 0 && bri <= 100) {
        brightness = bri;
      }
    }

    if (color === undefined && brightness === undefined) {
      return null;
    }

    return { segments, color, brightness };
  }

  /** Callback for batch segment state sync */
  onSegmentBatchUpdate?: (
    device: GoveeDevice,
    batch: { segments: number[]; color?: number; brightness?: number },
  ) => void;

  /** Callback when device LAN IP changes */
  onLanIpChanged?: (device: GoveeDevice, ip: string) => void;

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
      case "lightScene": {
        // Try ptReal BLE-over-LAN if scene is in scene library
        const idx = parseInt(String(value), 10);
        const scene = device.scenes[idx - 1];
        if (scene) {
          // Match by exact name first, then by base name (strip -A/-B suffix)
          const baseName = scene.name.replace(/-[A-Z]$/, "");
          const libEntry =
            device.sceneLibrary.find((s) => s.name === scene.name) ??
            device.sceneLibrary.find((s) => s.name === baseName);
          if (libEntry) {
            this.log.debug(
              `ptReal: ${scene.name} → code=${libEntry.sceneCode}`,
            );
            this.lanClient.setScene(
              device.lanIp,
              libEntry.sceneCode,
              libEntry.scenceParam ?? "",
            );
            return;
          }
        }
        // Scene not in library — fall through to MQTT/Cloud
        if (
          this.mqttClient?.connected &&
          this.sendMqttCommand(device, command, value)
        ) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {});
        break;
      }
      default:
        // LAN doesn't support this command — fall through to MQTT/Cloud
        if (
          this.mqttClient?.connected &&
          this.sendMqttCommand(device, command, value)
        ) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {});
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

    const cloudValue = this.toCloudValue(device, command, value);

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
      if (
        command === "lightScene" &&
        shortType === "dynamic_scene" &&
        cap.instance === "lightScene"
      ) {
        return cap;
      }
      if (
        command === "diyScene" &&
        shortType === "dynamic_scene" &&
        cap.instance === "diyScene"
      ) {
        return cap;
      }
      if (
        command === "snapshot" &&
        shortType === "dynamic_scene" &&
        cap.instance === "snapshot"
      ) {
        return cap;
      }
      if (
        command.startsWith("segmentColor:") &&
        shortType === "segment_color_setting"
      ) {
        return cap;
      }
      if (
        command.startsWith("segmentBrightness:") &&
        shortType === "segment_color_setting"
      ) {
        return cap;
      }
    }
    return undefined;
  }

  /**
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  private toCloudValue(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): unknown {
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
      case "lightScene": {
        // Value is the dropdown index (string) — resolve to scene activation payload
        const idx = parseInt(String(value), 10);
        const scene = device.scenes[idx - 1];
        return scene?.value ?? value;
      }
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        const diy = device.diyScenes[idx - 1];
        return diy?.value ?? value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        const snap = device.snapshots[idx - 1];
        return snap?.value ?? value;
      }
      default:
        if (command.startsWith("segmentColor:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          const { r, g, b } = this.parseColor(value as string);
          return { segment: [segIdx], rgb: (r << 16) | (g << 8) | b };
        }
        if (command.startsWith("segmentBrightness:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          return { segment: [segIdx], brightness: value };
        }
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
      diyScenes: [],
      snapshots: [],
      sceneLibrary: [],
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
}
