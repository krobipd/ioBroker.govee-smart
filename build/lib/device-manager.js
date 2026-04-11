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
var import_device_quirks = require("./device-quirks.js");
var import_types = require("./types.js");
class DeviceManager {
  log;
  devices = /* @__PURE__ */ new Map();
  lanClient = null;
  mqttClient = null;
  cloudClient = null;
  rateLimiter = null;
  skuCache = null;
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
   * Register the SKU cache for persistent device data
   *
   * @param cache SKU cache instance
   */
  setSkuCache(cache) {
    this.skuCache = cache;
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
   * Load devices from local SKU cache.
   * Returns true if any devices were loaded (= Cloud not needed).
   */
  loadFromCache() {
    var _a;
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
    const incomplete = Array.from(this.devices.values()).some(
      (d) => d.scenes.length === 0 && d.sceneLibrary.length > 0 && d.type === "light"
    );
    if (incomplete) {
      this.log.info(
        "Cache has incomplete scene data \u2014 will re-fetch from Cloud"
      );
      return false;
    }
    for (const device of this.devices.values()) {
      this.populateScenesFromLibrary(device);
    }
    if (changed) {
      (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
    }
    return cached.length > 0;
  }
  /**
   * Load devices from Cloud API and save to cache.
   * Only called when cache is empty (first start) or manual refresh.
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
        const quirks = (0, import_device_quirks.getDeviceQuirks)(cd.sku);
        if (quirks == null ? void 0 : quirks.brokenPlatformApi) {
          this.log.debug(
            `${cd.sku} has known broken platform API metadata \u2014 capabilities may be incomplete`
          );
        }
      }
      for (const cd of cloudDevices) {
        if (cd.type === "light" || cd.capabilities.some((c) => c.type.includes("dynamic_scene"))) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            const loadScenes = async () => {
              try {
                const { lightScenes, diyScenes, snapshots } = await this.cloudClient.getScenes(cd.sku, cd.device);
                if (lightScenes.length > 0 || diyScenes.length > 0 || snapshots.length > 0) {
                  const scenesChanged = lightScenes.length !== device.scenes.length || diyScenes.length !== device.diyScenes.length || snapshots.length !== device.snapshots.length;
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
            if (device.diyScenes.length === 0) {
              const loadDiy = async () => {
                try {
                  const diy = await this.cloudClient.getDiyScenes(
                    cd.sku,
                    cd.device
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
            if (device.snapshots.length === 0) {
              const snapCap = cd.capabilities.find(
                (c) => c.type === "devices.capabilities.dynamic_scene" && c.instance === "snapshot" && c.parameters.options
              );
              if (snapCap == null ? void 0 : snapCap.parameters.options) {
                device.snapshots = snapCap.parameters.options.filter(
                  (o) => typeof o.name === "string" && o.value !== void 0 && o.value !== null
                ).map((o) => ({
                  name: o.name,
                  value: typeof o.value === "number" ? o.value : o.value
                }));
                this.log.debug(
                  `Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`
                );
              }
            }
            if (this.mqttClient) {
              if (device.sceneLibrary.length === 0) {
                try {
                  const lib = await this.mqttClient.fetchSceneLibrary(cd.sku);
                  if (lib.length > 0) {
                    device.sceneLibrary = lib;
                    changed = true;
                    this.log.debug(
                      `Scene library for ${cd.sku}: ${lib.length} scenes`
                    );
                  }
                } catch {
                  this.log.debug(`Could not load scene library for ${cd.sku}`);
                }
              }
              if (device.musicLibrary.length === 0) {
                try {
                  const lib = await this.mqttClient.fetchMusicLibrary(cd.sku);
                  if (lib.length > 0) {
                    device.musicLibrary = lib;
                    changed = true;
                    this.log.debug(
                      `Music library for ${cd.sku}: ${lib.length} modes`
                    );
                  }
                } catch (e) {
                  this.log.debug(
                    `Could not load music library for ${cd.sku}: ${e instanceof Error ? e.message : String(e)}`
                  );
                }
              }
              if (device.diyLibrary.length === 0) {
                try {
                  const lib = await this.mqttClient.fetchDiyLibrary(cd.sku);
                  if (lib.length > 0) {
                    device.diyLibrary = lib;
                    changed = true;
                    this.log.debug(
                      `DIY library for ${cd.sku}: ${lib.length} effects`
                    );
                  }
                } catch (e) {
                  this.log.debug(
                    `Could not load DIY library for ${cd.sku}: ${e instanceof Error ? e.message : String(e)}`
                  );
                }
              }
              if (!device.skuFeatures) {
                try {
                  const features = await this.mqttClient.fetchSkuFeatures(
                    cd.sku
                  );
                  if (features) {
                    device.skuFeatures = features;
                    changed = true;
                    this.log.debug(
                      `SKU features for ${cd.sku}: ${JSON.stringify(features).slice(0, 200)}`
                    );
                  }
                } catch (e) {
                  this.log.debug(
                    `Could not load SKU features for ${cd.sku}: ${e instanceof Error ? e.message : String(e)}`
                  );
                }
              }
            }
            if (device.scenes.length > 0 || device.diyScenes.length > 0 || device.snapshots.length > 0) {
              changed = true;
            }
          }
        }
      }
      if (this.skuCache) {
        let cachedCount = 0;
        let skippedCount = 0;
        for (const device of this.devices.values()) {
          const isLight = device.type === "light";
          const scenesIncomplete = isLight && device.scenes.length === 0 && device.capabilities.length > 0;
          if (scenesIncomplete) {
            skippedCount++;
            this.log.debug(
              `Not caching ${device.name} (${device.sku}) \u2014 scene data incomplete`
            );
          } else {
            this.skuCache.save(this.goveeDeviceToCached(device));
            cachedCount++;
          }
        }
        if (skippedCount > 0) {
          this.log.info(
            `Cached ${cachedCount} device(s), skipped ${skippedCount} with incomplete data \u2014 will retry next start`
          );
        } else {
          this.log.info(
            `Cached ${cachedCount} device(s) \u2014 next start uses cache, no Cloud needed`
          );
        }
      }
      for (const device of this.devices.values()) {
        this.populateScenesFromLibrary(device);
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
    var _a, _b;
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
        (_a = this.onLanIpChanged) == null ? void 0 : _a.call(this, matched, lanDevice.ip);
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
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false }
      };
      this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
      this.log.debug(`LAN: New device ${lanDevice.sku} at ${lanDevice.ip}`);
      (_b = this.onDeviceListChanged) == null ? void 0 : _b.call(this, this.getDevices());
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
    var _a, _b;
    if (command.startsWith("segmentColor:")) {
      if (device.lanIp && this.lanClient) {
        const segIdx = parseInt(command.split(":")[1], 10);
        const { r, g, b } = this.parseColor(value);
        this.lanClient.setSegmentColor(device.lanIp, [segIdx], r, g, b);
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendCloudCommand(device, command, value);
        return;
      }
      return;
    }
    if (command === "segmentBatch") {
      if (device.lanIp && this.lanClient) {
        const parsed = this.parseSegmentBatch(device, value);
        if ((parsed == null ? void 0 : parsed.color) !== void 0) {
          const r = parsed.color >> 16 & 255;
          const g = parsed.color >> 8 & 255;
          const b = parsed.color & 255;
          this.lanClient.setSegmentColor(
            device.lanIp,
            parsed.segments,
            r,
            g,
            b
          );
        }
        if (parsed) {
          (_a = this.onSegmentBatchUpdate) == null ? void 0 : _a.call(this, device, parsed);
        }
        if ((parsed == null ? void 0 : parsed.brightness) !== void 0 && this.cloudClient) {
          await this.sendSegmentBatch(device, value);
        }
        return;
      }
      if (device.channels.cloud && this.cloudClient) {
        await this.sendSegmentBatch(device, value);
        return;
      }
      return;
    }
    if (command === "sceneSpeed") {
      if (device.lanIp && this.lanClient) {
        device.state.sceneSpeed = parseInt(String(value), 10) || 0;
        this.log.debug(
          `Scene speed set to ${device.state.sceneSpeed} for ${device.name} (applied on next scene activation)`
        );
      }
      return;
    }
    if (command.startsWith("segmentBrightness:")) {
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
    const quirks = (0, import_device_quirks.getDeviceQuirks)(device.sku);
    if (!(quirks == null ? void 0 : quirks.noMqtt) && device.channels.mqtt && ((_b = this.mqttClient) == null ? void 0 : _b.connected)) {
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
  async sendSegmentBatch(device, commandStr) {
    var _a;
    if (!this.cloudClient) {
      return;
    }
    const parsed = this.parseSegmentBatch(device, commandStr);
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
      if (this.rateLimiter) {
        await this.rateLimiter.tryExecute(execute, 0);
      } else {
        await execute();
      }
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
      if (this.rateLimiter) {
        await this.rateLimiter.tryExecute(execute, 0);
      } else {
        await execute();
      }
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
          if (!isNaN(idx) && idx < segCount) {
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
  /** Callback for batch segment state sync */
  onSegmentBatchUpdate;
  /** Callback when device LAN IP changes */
  onLanIpChanged;
  /**
   * Send command via LAN UDP
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  sendLanCommand(device, command, value) {
    var _a, _b, _c, _d, _e, _f;
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
      case "gradientToggle":
        this.lanClient.setGradient(device.lanIp, value);
        break;
      case "diyScene": {
        const diyIdx = parseInt(String(value), 10);
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
        if (((_b = this.mqttClient) == null ? void 0 : _b.connected) && this.sendMqttCommand(device, command, value)) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
        break;
      }
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        const scene = device.scenes[idx - 1];
        if (scene) {
          const baseName = scene.name.replace(/-[A-Z]$/, "");
          const libEntry = (_c = device.sceneLibrary.find((s) => s.name === scene.name)) != null ? _c : device.sceneLibrary.find((s) => s.name === baseName);
          if (libEntry) {
            this.log.debug(
              `ptReal: ${scene.name} \u2192 code=${libEntry.sceneCode}`
            );
            this.lanClient.setScene(
              device.lanIp,
              libEntry.sceneCode,
              (_d = libEntry.scenceParam) != null ? _d : ""
            );
            return;
          }
        }
        if (((_e = this.mqttClient) == null ? void 0 : _e.connected) && this.sendMqttCommand(device, command, value)) {
          return;
        }
        this.sendCloudCommand(device, command, value).catch(() => {
        });
        break;
      }
      default:
        if (((_f = this.mqttClient) == null ? void 0 : _f.connected) && this.sendMqttCommand(device, command, value)) {
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
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  toCloudValue(device, command, value) {
    var _a, _b, _c;
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
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        const diy = device.diyScenes[idx - 1];
        return (_b = diy == null ? void 0 : diy.value) != null ? _b : value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        const snap = device.snapshots[idx - 1];
        return (_c = snap == null ? void 0 : snap.value) != null ? _c : value;
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
      diyScenes: [],
      snapshots: [],
      sceneLibrary: [],
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
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
  /**
   * Fill device.scenes from sceneLibrary when Cloud scenes are missing.
   * ptReal activation matches by name, so sceneLibrary names are sufficient.
   */
  populateScenesFromLibrary(device) {
    if (device.scenes.length === 0 && device.sceneLibrary.length > 0) {
      device.scenes = device.sceneLibrary.map((entry) => ({
        name: entry.name,
        value: {}
        // ptReal uses sceneLibrary directly, Cloud payload not needed
      }));
      this.log.debug(
        `${device.sku}: ${device.scenes.length} scenes from library (Cloud scenes missing)`
      );
    }
  }
  /**
   * Convert cached data to a GoveeDevice (runtime fields set to defaults)
   *
   * @param cached Cached device data
   */
  cachedToGoveeDevice(cached) {
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
      state: { online: false },
      channels: { lan: false, mqtt: false, cloud: false }
    };
  }
  /**
   * Extract cacheable data from a GoveeDevice
   *
   * @param device Runtime device
   */
  goveeDeviceToCached(device) {
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
      cachedAt: Date.now()
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceManager
});
//# sourceMappingURL=device-manager.js.map
