import { getDeviceQuirks } from "./device-quirks.js";
import { hexToRgb } from "./types.js";
import type { GoveeCloudClient } from "./govee-cloud-client.js";
import type { GoveeLanClient } from "./govee-lan-client.js";
import type { GoveeMqttClient } from "./govee-mqtt-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { GoveeDevice } from "./types.js";

/**
 * Command router — routes device commands through the fastest available
 * channel: LAN → MQTT → Cloud.
 */
export class CommandRouter {
  private readonly log: ioBroker.Logger;
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;

  /** Callback for batch segment state sync */
  onSegmentBatchUpdate?: (
    device: GoveeDevice,
    batch: { segments: number[]; color?: number; brightness?: number },
  ) => void;

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
   * Execute a function through the rate limiter if available, or directly.
   *
   * @param fn Async function to execute
   * @param priority Queue priority (0 = highest)
   */
  async executeRateLimited(
    fn: () => Promise<void>,
    priority = 0,
  ): Promise<void> {
    if (this.rateLimiter) {
      await this.rateLimiter.tryExecute(fn, priority);
    } else {
      await fn();
    }
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
    // Segment color: try LAN ptReal first, fall back to Cloud
    if (command.startsWith("segmentColor:")) {
      if (device.lanIp && this.lanClient) {
        const segIdx = parseInt(command.split(":")[1], 10);
        if (isNaN(segIdx) || segIdx < 0) {
          this.log.warn(`${device.sku}: invalid segment index in ${command}`);
          return;
        }
        const { r, g, b } = hexToRgb(value as string);
        this.lanClient.setSegmentColor(device.lanIp, [segIdx], r, g, b);
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      return;
    }

    // Segment batch: try LAN ptReal first, fall back to Cloud
    if (command === "segmentBatch") {
      if (device.lanIp && this.lanClient) {
        const parsed = this.parseSegmentBatch(device, value as string);
        if (parsed?.color !== undefined) {
          const r = (parsed.color >> 16) & 0xff;
          const g = (parsed.color >> 8) & 0xff;
          const b = parsed.color & 0xff;
          this.lanClient.setSegmentColor(
            device.lanIp,
            parsed.segments,
            r,
            g,
            b,
          );
        }
        if (parsed) {
          this.onSegmentBatchUpdate?.(device, parsed);
        }
        // Brightness via ptReal not supported — fall through to Cloud if needed
        if (parsed?.brightness !== undefined && this.cloudClient) {
          await this.sendSegmentBatch(device, value as string);
        }
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendSegmentBatch(device, value as string);
        return;
      }
      return;
    }

    // Scene speed: re-send active scene with modified speed level (LAN ptReal only)
    if (command === "sceneSpeed") {
      if (device.lanIp && this.lanClient) {
        // TODO: Implement speed byte manipulation in scenceParam once byte layout is verified.
        // For now, store the speed level for next scene activation.
        device.state.sceneSpeed = parseInt(String(value), 10) || 0;
        this.log.debug(
          `Scene speed set to ${device.state.sceneSpeed} for ${device.name} (applied on next scene activation)`,
        );
      }
      return;
    }

    // Segment brightness: Cloud only (no ptReal equivalent)
    if (command.startsWith("segmentBrightness:")) {
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      return;
    }

    // Priority 1: LAN
    if (device.lanIp && this.lanClient) {
      this.sendLanCommand(device, command, value);
      return;
    }

    // Priority 2: MQTT (skip for devices with noMqtt quirk)
    const quirks = getDeviceQuirks(device.sku);
    if (!quirks?.noMqtt && device.channels.mqtt && this.mqttClient?.connected) {
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

    await this.executeRateLimited(execute);
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
      await this.executeRateLimited(execute);
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
      await this.executeRateLimited(execute);
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
  parseSegmentBatch(
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
    const segCount = device.segmentCount ?? 0;
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
          if (!isNaN(idx) && idx >= 0 && idx < segCount) {
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

  /**
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  toCloudValue(device: GoveeDevice, command: string, value: unknown): unknown {
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = hexToRgb(value as string);
        return (r << 16) | (g << 8) | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      case "lightScene": {
        // Value is the dropdown index (string) — resolve to scene activation payload
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(
            `${device.sku}: invalid light scene index ${String(value)} for cloud`,
          );
          return value;
        }
        return device.scenes[idx - 1].value;
      }
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.diyScenes.length) {
          this.log.warn(
            `${device.sku}: invalid DIY scene index ${String(value)} for cloud`,
          );
          return value;
        }
        return device.diyScenes[idx - 1].value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(
            `${device.sku}: invalid snapshot index ${String(value)} for cloud`,
          );
          return value;
        }
        return device.snapshots[idx - 1].value;
      }
      default:
        if (command.startsWith("segmentColor:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          const { r, g, b } = hexToRgb(value as string);
          return { segment: [segIdx], rgb: (r << 16) | (g << 8) | b };
        }
        if (command.startsWith("segmentBrightness:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          return { segment: [segIdx], brightness: value };
        }
        return value;
    }
  }

  /**
   * Find capability matching a command name
   *
   * @param device Target device
   * @param command Command type to find capability for
   */
  findCapabilityForCommand(
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
        shortType === "segment_color_setting" &&
        !cap.instance.toLowerCase().includes("brightness")
      ) {
        return cap;
      }
      if (
        command.startsWith("segmentBrightness:") &&
        shortType === "segment_color_setting" &&
        cap.instance.toLowerCase().includes("brightness")
      ) {
        return cap;
      }
    }
    return undefined;
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
        const { r, g, b } = hexToRgb(value as string);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value as number);
        break;
      case "gradientToggle":
        this.lanClient.setGradient(device.lanIp, value as boolean);
        break;
      case "diyScene": {
        // Try ptReal BLE-over-LAN if DIY scene is in library
        const diyIdx = parseInt(String(value), 10);
        if (isNaN(diyIdx) || diyIdx < 1 || diyIdx > device.diyScenes.length) {
          this.log.warn(
            `${device.sku}: invalid DIY scene index ${String(value)}`,
          );
          return;
        }
        const diyScene = device.diyScenes[diyIdx - 1];
        if (diyScene) {
          const diyLib = device.diyLibrary.find(
            (d) => d.name === diyScene.name,
          );
          if (diyLib) {
            this.log.debug(
              `ptReal DIY: ${diyScene.name} → code=${diyLib.diyCode}`,
            );
            this.lanClient.setDiyScene(device.lanIp, diyLib.scenceParam ?? "");
            return;
          }
        }
        // No library match — fall through to MQTT/Cloud
        if (
          this.mqttClient?.connected &&
          this.sendMqttCommand(device, command, value)
        ) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {});
        break;
      }
      case "lightScene": {
        // Try ptReal BLE-over-LAN if scene is in scene library
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(
            `${device.sku}: invalid light scene index ${String(value)}`,
          );
          return;
        }
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
        const { r, g, b } = hexToRgb(value as string);
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

    await this.executeRateLimited(execute);
  }
}
