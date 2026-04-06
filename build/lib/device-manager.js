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
var device_manager_exports = {};
__export(device_manager_exports, {
  DeviceManager: () => DeviceManager
});
module.exports = __toCommonJS(device_manager_exports);
var import_types = require("./types.js");
class DeviceManager {
  log;
  devices = /* @__PURE__ */ new Map();
  lanClient = null;
  mqttClient = null;
  cloudClient = null;
  rateLimiter = null;
  onDeviceUpdate = null;
  onDeviceListChanged = null;
  lastErrorCategory = null;
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
   * Register the MQTT client
   *
   * @param client MQTT client instance
   */
  setMqttClient(client) {
    this.mqttClient = client;
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
   * Set callbacks for device state changes and list changes.
   *
   * @param onUpdate Called when a device state changes (from any channel)
   * @param onListChanged Called when the device list changes (new/removed devices)
   */
  setCallbacks(onUpdate, onListChanged) {
    this.onDeviceUpdate = onUpdate;
    this.onDeviceListChanged = onListChanged;
  }
  /** Get all known devices */
  getDevices() {
    return Array.from(this.devices.values());
  }
  /**
   * Get a device by its unique key (sku_deviceId)
   *
   * @param sku Product model
   * @param deviceId Unique device identifier
   */
  getDevice(sku, deviceId) {
    return this.devices.get(this.deviceKey(sku, deviceId));
  }
  /**
   * Load devices from Cloud API and merge with LAN discovery.
   * Called on startup and periodically.
   */
  async loadFromCloud() {
    var _a;
    if (!this.cloudClient) {
      return false;
    }
    try {
      const cloudDevices = await this.cloudClient.getDevices();
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
      }
      for (const cd of cloudDevices) {
        if (cd.type === "light" || cd.capabilities.some((c) => c.type.includes("dynamic_scene"))) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            const loadScenes = async () => {
              try {
                const { lightScenes, snapshots } = await this.cloudClient.getScenes(cd.sku, cd.device);
                if (lightScenes.length > 0 || snapshots.length > 0) {
                  const scenesChanged = lightScenes.length !== device.scenes.length || snapshots.length !== device.snapshots.length;
                  device.scenes = lightScenes;
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
            if (device.snapshots.length === 0) {
              const snapCap = cd.capabilities.find(
                (c) => c.type === "devices.capabilities.dynamic_scene" && c.instance === "snapshot" && c.parameters.options
              );
              if (snapCap == null ? void 0 : snapCap.parameters.options) {
                device.snapshots = snapCap.parameters.options.filter(
                  (o) => typeof o.name === "string" && typeof o.value === "object"
                ).map((o) => ({
                  name: o.name,
                  value: o.value
                }));
              }
            }
            if (device.scenes.length > 0 || device.snapshots.length > 0) {
              changed = true;
            }
          }
        }
      }
      if (changed) {
        (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
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
  handleLanDiscovery(lanDevice) {
    var _a;
    let matched;
    for (const dev of this.devices.values()) {
      if ((0, import_types.normalizeDeviceId)(dev.deviceId) === (0, import_types.normalizeDeviceId)(lanDevice.device)) {
        matched = dev;
        break;
      }
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
          `LAN: ${matched.name} (${matched.sku}) at ${lanDevice.ip}`
        );
      }
    } else {
      const shortId = (0, import_types.normalizeDeviceId)(lanDevice.device).slice(-4);
      const device = {
        sku: lanDevice.sku,
        deviceId: lanDevice.device,
        name: `${lanDevice.sku}_${shortId}`,
        type: "light",
        lanIp: lanDevice.ip,
        capabilities: [],
        scenes: [],
        snapshots: [],
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false }
      };
      this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
      this.log.debug(
        `LAN: New device ${lanDevice.sku} at ${lanDevice.ip} (no Cloud data)`
      );
      (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
    }
  }
  /**
   * Handle MQTT status update — update device state.
   *
   * @param update MQTT status message
   */
  handleMqttStatus(update) {
    var _a;
    const device = this.findDeviceBySkuAndId(update.sku, update.device);
    if (!device) {
      this.log.debug(`MQTT: Unknown device ${update.sku} ${update.device}`);
      return;
    }
    device.channels.mqtt = true;
    const state = { online: true };
    if (update.state) {
      if (update.state.onOff !== void 0) {
        state.power = update.state.onOff === 1;
      }
      if (update.state.brightness !== void 0) {
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
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
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
  handleLanStatus(ip, status) {
    var _a;
    let device;
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
    const state = {
      online: true,
      power: status.onOff === 1,
      brightness: status.brightness,
      colorRgb: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
      colorTemperature: status.colorTemInKelvin || void 0
    };
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
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
    if (command.startsWith("segmentColor:") || command.startsWith("segmentBrightness:")) {
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      this.log.debug(`Segment control requires Cloud API for ${device.name}`);
      return;
    }
    if (device.lanIp && this.lanClient) {
      this.sendLanCommand(device, command, value);
      return;
    }
    if (device.channels.mqtt && ((_a = this.mqttClient) == null ? void 0 : _a.connected)) {
      if (this.sendMqttCommand(device, command, value)) {
        return;
      }
    }
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
  sendLanCommand(device, command, value) {
    var _a;
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
        const { r, g, b } = this.parseColor(value);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value);
        break;
      default:
        if (((_a = this.mqttClient) == null ? void 0 : _a.connected) && this.sendMqttCommand(device, command, value)) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
    }
  }
  /**
   * Send command via MQTT — returns true if sent
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  sendMqttCommand(device, command, value) {
    if (!this.mqttClient) {
      return false;
    }
    switch (command) {
      case "power":
        return this.mqttClient.setPower(device.deviceId, value);
      case "brightness":
        return this.mqttClient.setBrightness(device.deviceId, value);
      case "colorRgb": {
        const { r, g, b } = this.parseColor(value);
        return this.mqttClient.setColor(device.deviceId, r, g, b);
      }
      case "colorTemperature":
        return this.mqttClient.setColorTemperature(
          device.deviceId,
          value
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
      if (command === "snapshot" && shortType === "dynamic_scene" && cap.instance === "snapshot") {
        return cap;
      }
      if (command.startsWith("segmentColor:") && shortType === "segment_color_setting") {
        return cap;
      }
      if (command.startsWith("segmentBrightness:") && shortType === "segment_color_setting") {
        return cap;
      }
    }
    return void 0;
  }
  /**
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  toCloudValue(device, command, value) {
    var _a, _b;
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = this.parseColor(value);
        return r << 16 | g << 8 | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        const scene = device.scenes[idx - 1];
        return (_a = scene == null ? void 0 : scene.value) != null ? _a : value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        const snap = device.snapshots[idx - 1];
        return (_b = snap == null ? void 0 : snap.value) != null ? _b : value;
      }
      default:
        if (command.startsWith("segmentColor:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          const { r, g, b } = this.parseColor(value);
          return { segment: [segIdx], rgb: r << 16 | g << 8 | b };
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
  parseColor(hex) {
    const clean = hex.replace("#", "");
    const num = parseInt(clean, 16) || 0;
    return {
      r: num >> 16 & 255,
      g: num >> 8 & 255,
      b: num & 255
    };
  }
  /**
   * Convert Cloud device to internal device model
   *
   * @param cd Cloud API device data
   */
  cloudDeviceToGoveeDevice(cd) {
    return {
      sku: cd.sku,
      deviceId: cd.device,
      name: cd.deviceName || cd.sku,
      type: cd.type || "unknown",
      capabilities: cd.capabilities,
      scenes: [],
      snapshots: [],
      state: { online: true },
      channels: { lan: false, mqtt: false, cloud: true }
    };
  }
  /**
   * Find device by SKU and device ID (handles format differences)
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  findDeviceBySkuAndId(sku, deviceId) {
    const direct = this.devices.get(this.deviceKey(sku, deviceId));
    if (direct) {
      return direct;
    }
    const normalizedId = (0, import_types.normalizeDeviceId)(deviceId);
    for (const dev of this.devices.values()) {
      if (dev.sku === sku && (0, import_types.normalizeDeviceId)(dev.deviceId) === normalizedId) {
        return dev;
      }
    }
    return void 0;
  }
  /**
   * Generate unique key for a device
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  deviceKey(sku, deviceId) {
    return `${sku}_${(0, import_types.normalizeDeviceId)(deviceId)}`;
  }
  /**
   * Log error with dedup — only warn on category change, debug on repeat.
   *
   * @param context Error context description
   * @param err Error to log
   */
  logDedup(context, err) {
    const category = (0, import_types.classifyError)(err);
    const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
    if (category !== this.lastErrorCategory) {
      this.lastErrorCategory = category;
      this.log.warn(msg);
    } else {
      this.log.debug(`${msg} (repeated)`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceManager
});
//# sourceMappingURL=device-manager.js.map
