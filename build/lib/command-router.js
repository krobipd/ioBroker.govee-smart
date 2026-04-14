"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var command_router_exports = {};
__export(command_router_exports, {
  CommandRouter: () => CommandRouter
});
module.exports = __toCommonJS(command_router_exports);
var import_types = require("./types.js");
var import_govee_lan_client = require("./govee-lan-client.js");
class CommandRouter {
  log;
  lanClient = null;
  cloudClient = null;
  rateLimiter = null;
  /** Callback for batch segment state sync */
  onSegmentBatchUpdate;
  /** @param log ioBroker logger */
  constructor(log) {
    this.log = log;
  }
  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client) {
    this.lanClient = client;
  }
  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client) {
    this.cloudClient = client;
  }
  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter) {
    this.rateLimiter = limiter;
  }
  /**
   * Execute a function through the rate limiter if available, or directly.
   *
   * @param fn Async function to execute
   * @param priority Queue priority (0 = highest)
   */
  async executeRateLimited(fn, priority = 0) {
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
  async sendCommand(device, command, value) {
    var _a;
    if (command.startsWith("segmentColor:")) {
      const segIdx = parseInt(command.split(":")[1], 10);
      if (isNaN(segIdx) || segIdx < 0) {
        return;
      }
      if (device.lanIp && this.lanClient) {
        const { r, g, b } = (0, import_types.hexToRgb)(value);
        this.lanClient.setSegmentColor(device.lanIp, r, g, b, [segIdx]);
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      return;
    }
    if (command === "segmentBatch") {
      const parsed = this.parseSegmentBatch(device, value);
      if (parsed) {
        (_a = this.onSegmentBatchUpdate) == null ? void 0 : _a.call(this, device, parsed);
      }
      if (device.lanIp && this.lanClient && parsed) {
        if (parsed.color !== void 0) {
          const r = parsed.color >> 16 & 255;
          const g = parsed.color >> 8 & 255;
          const b = parsed.color & 255;
          this.lanClient.setSegmentColor(
            device.lanIp,
            r,
            g,
            b,
            parsed.segments
          );
        }
        if (parsed.brightness !== void 0) {
          this.lanClient.setSegmentBrightness(
            device.lanIp,
            parsed.brightness,
            parsed.segments
          );
        }
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendSegmentBatchParsed(device, value, parsed);
        return;
      }
      return;
    }
    if (command.startsWith("segmentBrightness:")) {
      const segIdx = parseInt(command.split(":")[1], 10);
      if (isNaN(segIdx) || segIdx < 0) {
        return;
      }
      if (device.lanIp && this.lanClient) {
        this.lanClient.setSegmentBrightness(device.lanIp, value, [
          segIdx
        ]);
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      return;
    }
    if (device.lanIp && this.lanClient) {
      this.sendLanCommand(device, command, value);
      return;
    }
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
  async sendCapabilityCommand(device, capabilityType, capabilityInstance, value) {
    if (!this.cloudClient || !device.channels.cloud) {
      this.log.debug(
        `Cloud not available for generic command on ${device.name}`
      );
      return;
    }
    const shortType = capabilityType.replace("devices.capabilities.", "");
    let cloudValue = value;
    if (shortType === "toggle") {
      cloudValue = value ? 1 : 0;
    }
    const execute = async () => {
      await this.cloudClient.controlDevice(
        device.sku,
        device.deviceId,
        capabilityType,
        capabilityInstance,
        cloudValue
      );
    };
    await this.executeRateLimited(execute);
  }
  /**
   * Send a batch segment command with pre-parsed data.
   *
   * @param device Target device
   * @param commandStr Original command string (for error messages)
   * @param parsed Pre-parsed batch data (null = invalid command)
   */
  async sendSegmentBatchParsed(device, commandStr, parsed) {
    var _a;
    if (!this.cloudClient) {
      return;
    }
    if (!parsed) {
      this.log.warn(
        `Invalid segment command "${commandStr}" for ${device.name}`
      );
      return;
    }
    const cap = this.findCapabilityForCommand(device, "segmentColor:0");
    if (!cap) {
      this.log.debug(`No segment capability for ${device.name}`);
      return;
    }
    if (parsed.color !== void 0) {
      const execute = async () => {
        await this.cloudClient.controlDevice(
          device.sku,
          device.deviceId,
          cap.type,
          cap.instance,
          { segment: parsed.segments, rgb: parsed.color }
        );
      };
      await this.executeRateLimited(execute);
    }
    if (parsed.brightness !== void 0) {
      const brightCap = device.capabilities.find(
        (c) => c.type.includes("segment_color_setting") && c.instance.toLowerCase().includes("brightness")
      );
      const execute = async () => {
        await this.cloudClient.controlDevice(
          device.sku,
          device.deviceId,
          (brightCap != null ? brightCap : cap).type,
          (brightCap != null ? brightCap : cap).instance,
          { segment: parsed.segments, brightness: parsed.brightness }
        );
      };
      await this.executeRateLimited(execute);
    }
    (_a = this.onSegmentBatchUpdate) == null ? void 0 : _a.call(this, device, parsed);
  }
  /**
   * Parse batch segment command string.
   *
   * @param device Target device (for segment count)
   * @param cmd Command string (e.g. "1-5:#ff0000:20")
   */
  parseSegmentBatch(device, cmd) {
    var _a;
    const parts = cmd.split(":");
    if (parts.length < 1 || !parts[0]) {
      return null;
    }
    const segStr = parts[0].trim();
    const segCount = (_a = device.segmentCount) != null ? _a : 0;
    let segments;
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
    let color;
    if (parts.length >= 2 && parts[1]) {
      const colorStr = parts[1].trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(colorStr)) {
        color = parseInt(colorStr.replace("#", ""), 16);
      }
    }
    let brightness;
    if (parts.length >= 3 && parts[2]) {
      const bri = parseInt(parts[2].trim(), 10);
      if (!isNaN(bri) && bri >= 0 && bri <= 100) {
        brightness = bri;
      }
    }
    if (color === void 0 && brightness === void 0) {
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
  toCloudValue(device, command, value) {
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = (0, import_types.hexToRgb)(value);
        return r << 16 | g << 8 | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(
            `${device.sku}: invalid light scene index ${String(value)} for cloud`
          );
          return value;
        }
        return device.scenes[idx - 1].value;
      }
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.diyScenes.length) {
          this.log.warn(
            `${device.sku}: invalid DIY scene index ${String(value)} for cloud`
          );
          return value;
        }
        return device.diyScenes[idx - 1].value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(
            `${device.sku}: invalid snapshot index ${String(value)} for cloud`
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
          const { r, g, b } = (0, import_types.hexToRgb)(value);
          return { segment: [segIdx], rgb: r << 16 | g << 8 | b };
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
  findCapabilityForCommand(device, command) {
    for (const cap of device.capabilities) {
      const shortType = cap.type.replace("devices.capabilities.", "");
      if (command === "power" && shortType === "on_off") {
        return cap;
      }
      if (command === "brightness" && shortType === "range" && cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
      if (command === "colorRgb" && shortType === "color_setting" && cap.instance === "colorRgb") {
        return cap;
      }
      if (command === "colorTemperature" && shortType === "color_setting" && cap.instance.includes("colorTem")) {
        return cap;
      }
      if (command === "scene" && shortType === "mode" && cap.instance === "presetScene") {
        return cap;
      }
      if (command === "lightScene" && shortType === "dynamic_scene" && cap.instance === "lightScene") {
        return cap;
      }
      if (command === "diyScene" && shortType === "dynamic_scene" && cap.instance === "diyScene") {
        return cap;
      }
      if (command === "snapshot" && shortType === "dynamic_scene" && cap.instance === "snapshot") {
        return cap;
      }
      if (command.startsWith("segmentColor:") && shortType === "segment_color_setting" && !cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
      if (command.startsWith("segmentBrightness:") && shortType === "segment_color_setting" && cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
    }
    return void 0;
  }
  /**
   * Send command via LAN UDP
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  sendLanCommand(device, command, value) {
    var _a, _b, _c, _d, _e;
    if (!device.lanIp || !this.lanClient) {
      return;
    }
    switch (command) {
      case "power":
        this.lanClient.setPower(device.lanIp, value);
        break;
      case "brightness":
        this.lanClient.setBrightness(device.lanIp, value);
        break;
      case "colorRgb": {
        const { r, g, b } = (0, import_types.hexToRgb)(value);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value);
        break;
      case "gradientToggle":
        this.lanClient.setGradient(device.lanIp, value);
        break;
      case "diyScene": {
        const diyIdx = parseInt(String(value), 10);
        if (isNaN(diyIdx) || diyIdx < 1 || diyIdx > device.diyScenes.length) {
          this.log.warn(
            `${device.sku}: invalid DIY scene index ${String(value)}`
          );
          return;
        }
        const diyScene = device.diyScenes[diyIdx - 1];
        if (diyScene) {
          const diyLib = device.diyLibrary.find(
            (d) => d.name === diyScene.name
          );
          if (diyLib) {
            this.log.debug(
              `ptReal DIY: ${diyScene.name} \u2192 code=${diyLib.diyCode}`
            );
            this.lanClient.setDiyScene(device.lanIp, (_a = diyLib.scenceParam) != null ? _a : "");
            return;
          }
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
        break;
      }
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(
            `${device.sku}: invalid light scene index ${String(value)}`
          );
          return;
        }
        const scene = device.scenes[idx - 1];
        if (scene) {
          const baseName = scene.name.replace(/-[A-Z]$/, "");
          const libEntry = (_b = device.sceneLibrary.find((s) => s.name === scene.name)) != null ? _b : device.sceneLibrary.find((s) => s.name === baseName);
          if (libEntry) {
            let param = (_c = libEntry.scenceParam) != null ? _c : "";
            if (device.sceneSpeed !== void 0 && device.sceneSpeed > 0 && ((_d = libEntry.speedInfo) == null ? void 0 : _d.supSpeed) && libEntry.speedInfo.config) {
              param = (0, import_govee_lan_client.applySceneSpeed)(
                param,
                device.sceneSpeed,
                libEntry.speedInfo.config
              );
            }
            this.log.debug(
              `ptReal: ${scene.name} \u2192 code=${libEntry.sceneCode}`
            );
            this.lanClient.setScene(device.lanIp, libEntry.sceneCode, param);
            return;
          }
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
        break;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(
            `${device.sku}: invalid snapshot index ${String(value)}`
          );
          return;
        }
        const cmdGroups = (_e = device.snapshotBleCmds) == null ? void 0 : _e[idx - 1];
        if (cmdGroups && cmdGroups.length > 0) {
          const allPackets = cmdGroups.flat();
          if (allPackets.length > 0) {
            this.log.debug(
              `ptReal Snapshot: ${device.snapshots[idx - 1].name} \u2192 ${allPackets.length} packets`
            );
            this.lanClient.sendPtReal(device.lanIp, allPackets);
            return;
          }
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
        break;
      }
      default:
        this.sendCloudCommand(device, command, value).catch(() => {
        });
    }
  }
  /**
   * Send command via Cloud API (rate-limited)
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCloudCommand(device, command, value) {
    if (!this.cloudClient) {
      return;
    }
    const cap = this.findCapabilityForCommand(device, command);
    if (!cap) {
      this.log.debug(
        `No Cloud capability for command '${command}' on ${device.sku}`
      );
      return;
    }
    const cloudValue = this.toCloudValue(device, command, value);
    const execute = async () => {
      await this.cloudClient.controlDevice(
        device.sku,
        device.deviceId,
        cap.type,
        cap.instance,
        cloudValue
      );
    };
    await this.executeRateLimited(execute);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandRouter
});
//# sourceMappingURL=command-router.js.map
