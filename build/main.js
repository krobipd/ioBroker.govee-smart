"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_capability_mapper = require("./lib/capability-mapper.js");
var import_device_manager = require("./lib/device-manager.js");
var import_govee_cloud_client = require("./lib/govee-cloud-client.js");
var import_govee_lan_client = require("./lib/govee-lan-client.js");
var import_govee_mqtt_client = require("./lib/govee-mqtt-client.js");
var import_rate_limiter = require("./lib/rate-limiter.js");
var import_state_manager = require("./lib/state-manager.js");
class GoveeAdapter extends utils.Adapter {
  deviceManager = null;
  stateManager = null;
  lanClient = null;
  mqttClient = null;
  cloudClient = null;
  rateLimiter = null;
  cloudPollTimer = void 0;
  cloudWasConnected = false;
  readyLogged = false;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }
  /** Adapter started — initialize all channels */
  async onReady() {
    var _a;
    const config = this.config;
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: "Information" },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection status",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.mqttConnected", {
      type: "state",
      common: {
        name: "MQTT connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.cloudConnected", {
      type: "state",
      common: {
        name: "Cloud API connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });
    this.stateManager = new import_state_manager.StateManager(this);
    this.deviceManager = new import_device_manager.DeviceManager(this.log);
    this.deviceManager.setCallbacks(
      (device, state) => this.onDeviceStateUpdate(device, state),
      (devices) => this.onDeviceListChanged(devices)
    );
    this.deviceManager.onLanIpChanged = (device, ip) => {
      const prefix = this.stateManager.devicePrefix(device);
      this.setStateAsync(`${prefix}.info.ip`, { val: ip, ack: true }).catch(
        () => {
        }
      );
    };
    this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
      const prefix = this.stateManager.devicePrefix(device);
      for (const idx of batch.segments) {
        if (batch.color !== void 0) {
          const hex = `#${batch.color.toString(16).padStart(6, "0")}`;
          this.setStateAsync(`${prefix}.segments.${idx}.color`, {
            val: hex,
            ack: true
          }).catch(() => {
          });
        }
        if (batch.brightness !== void 0) {
          this.setStateAsync(`${prefix}.segments.${idx}.brightness`, {
            val: batch.brightness,
            ack: true
          }).catch(() => {
          });
        }
      }
    };
    if (config.apiKey || config.goveeEmail && config.goveePassword) {
      this.log.info(
        "Starting Govee adapter \u2014 initializing channels, this may take a moment..."
      );
    }
    this.lanClient = new import_govee_lan_client.GoveeLanClient(this.log, this);
    this.deviceManager.setLanClient(this.lanClient);
    this.lanClient.start(
      (lanDevice) => {
        this.deviceManager.handleLanDiscovery(lanDevice);
        this.lanClient.requestStatus(lanDevice.ip);
      },
      (sourceIp, status) => {
        this.deviceManager.handleLanStatus(sourceIp, status);
      },
      3e4,
      config.networkInterface || ""
    );
    if (config.apiKey) {
      this.cloudClient = new import_govee_cloud_client.GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);
      this.rateLimiter = new import_rate_limiter.RateLimiter(this.log, this);
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);
      const cloudOk = await this.deviceManager.loadFromCloud();
      this.cloudWasConnected = cloudOk;
      this.setStateAsync("info.cloudConnected", {
        val: cloudOk,
        ack: true
      }).catch(() => {
      });
      if (cloudOk) {
        await this.loadCloudStates();
      }
      const intervalMs = Math.max(30, (_a = config.pollInterval) != null ? _a : 60) * 1e3;
      this.cloudPollTimer = this.setInterval(() => {
        this.deviceManager.loadFromCloud().then((ok) => {
          if (ok && !this.cloudWasConnected) {
            this.log.info("Cloud API connection restored");
          }
          this.cloudWasConnected = ok;
          this.setStateAsync("info.cloudConnected", {
            val: ok,
            ack: true
          }).catch(() => {
          });
        }).catch(() => {
        });
      }, intervalMs);
    }
    if (config.goveeEmail && config.goveePassword) {
      this.mqttClient = new import_govee_mqtt_client.GoveeMqttClient(
        config.goveeEmail,
        config.goveePassword,
        this.log,
        this
      );
      this.deviceManager.setMqttClient(this.mqttClient);
      await this.mqttClient.connect(
        (update) => this.deviceManager.handleMqttStatus(update),
        (connected) => {
          this.setStateAsync("info.mqttConnected", {
            val: connected,
            ack: true
          }).catch(() => {
          });
          if (connected) {
            this.log.debug("MQTT connected \u2014 real-time status active");
            for (const dev of this.deviceManager.getDevices()) {
              if (dev.mqttTopic) {
                this.mqttClient.registerDeviceTopic(
                  dev.deviceId,
                  dev.mqttTopic
                );
              }
            }
            if (!this.readyLogged) {
              this.readyLogged = true;
              this.logDeviceSummary();
            }
          }
          this.updateConnectionState();
        }
      );
    }
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");
    this.setTimeout(() => {
      if (this.stateManager && this.deviceManager) {
        this.stateManager.cleanupDevices(this.deviceManager.getDevices()).catch(() => {
        });
      }
    }, 3e4);
    this.updateConnectionState();
    if (!this.mqttClient) {
      this.readyLogged = true;
      this.logDeviceSummary();
    } else {
      this.setTimeout(() => {
        if (!this.readyLogged) {
          this.readyLogged = true;
          this.logDeviceSummary();
        }
      }, 15e3);
    }
  }
  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  onUnload(callback) {
    var _a, _b, _c;
    try {
      if (this.cloudPollTimer) {
        this.clearInterval(this.cloudPollTimer);
        this.cloudPollTimer = void 0;
      }
      (_a = this.lanClient) == null ? void 0 : _a.stop();
      (_b = this.mqttClient) == null ? void 0 : _b.disconnect();
      (_c = this.rateLimiter) == null ? void 0 : _c.stop();
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
    }
    callback();
  }
  /**
   * Handle state changes from user (write operations).
   *
   * @param id State ID
   * @param state New state value
   */
  async onStateChange(id, state) {
    var _a, _b;
    if (!state || state.ack || !this.deviceManager || !this.stateManager) {
      return;
    }
    const localId = id.replace(`${this.namespace}.`, "");
    if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
      return;
    }
    const device = this.findDeviceForState(localId);
    if (!device) {
      return;
    }
    const prefix = this.stateManager.devicePrefix(device);
    const stateSuffix = localId.slice(prefix.length + 1);
    const command = this.stateToCommand(stateSuffix);
    if (!command) {
      const obj = await this.getObjectAsync(id);
      if (((_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.capabilityType) && ((_b = obj == null ? void 0 : obj.native) == null ? void 0 : _b.capabilityInstance)) {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            obj.native.capabilityType,
            obj.native.capabilityInstance,
            state.val
          );
          await this.setStateAsync(id, { val: state.val, ack: true });
        } catch (err) {
          this.log.warn(
            `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        this.log.debug(`Unknown writable state: ${stateSuffix}`);
      }
      return;
    }
    try {
      if (command === "music") {
        await this.sendMusicCommand(device, prefix, stateSuffix, state.val);
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      }
      await this.deviceManager.sendCommand(device, command, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
      if (command === "colorRgb" || command === "colorTemperature") {
        for (const sceneKey of ["light_scene", "diy_scene", "snapshot"]) {
          const sceneId = `${this.namespace}.${prefix}.control.${sceneKey}`;
          const sceneState = await this.getStateAsync(sceneId);
          if ((sceneState == null ? void 0 : sceneState.val) && sceneState.val !== "0") {
            await this.setStateAsync(sceneId, { val: "0", ack: true });
          }
        }
      }
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`
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
  async sendMusicCommand(device, prefix, changedSuffix, newValue) {
    var _a, _b;
    const base = `${this.namespace}.${prefix}.control`;
    const modeState = await this.getStateAsync(`${base}.music_mode`);
    const sensState = await this.getStateAsync(`${base}.music_sensitivity`);
    const autoState = await this.getStateAsync(`${base}.music_auto_color`);
    const musicMode = changedSuffix === "control.music_mode" ? parseInt(String(newValue), 10) : parseInt(String((_a = modeState == null ? void 0 : modeState.val) != null ? _a : 0), 10);
    const sensitivity = changedSuffix === "control.music_sensitivity" ? newValue : (_b = sensState == null ? void 0 : sensState.val) != null ? _b : 100;
    const autoColor = changedSuffix === "control.music_auto_color" ? newValue ? 1 : 0 : (autoState == null ? void 0 : autoState.val) ? 1 : 0;
    if (!musicMode || musicMode === 0) {
      this.log.debug("Music mode not selected, skipping command");
      return;
    }
    const structValue = {
      musicMode,
      sensitivity,
      autoColor
    };
    await this.deviceManager.sendCapabilityCommand(
      device,
      "devices.capabilities.music_setting",
      "musicMode",
      structValue
    );
  }
  /**
   * Called by device-manager when a device state changes
   *
   * @param device Updated device
   * @param state Changed state values
   */
  onDeviceStateUpdate(device, state) {
    if (this.stateManager) {
      this.stateManager.updateDeviceState(device, state).catch(() => {
      });
    }
    this.updateConnectionState();
  }
  /**
   * Called by device-manager when the device list changes
   *
   * @param devices Current list of all devices
   */
  onDeviceListChanged(devices) {
    if (!this.stateManager) {
      return;
    }
    for (const device of devices) {
      let stateDefs;
      if (device.lanIp) {
        stateDefs = (0, import_capability_mapper.getDefaultLanStates)();
        if (device.capabilities.length > 0) {
          const lanIds = new Set(stateDefs.map((d) => d.id));
          const cloudDefs = (0, import_capability_mapper.mapCapabilities)(device.capabilities);
          for (const cd of cloudDefs) {
            if (!lanIds.has(cd.id)) {
              stateDefs.push(cd);
            }
          }
        }
      } else {
        stateDefs = (0, import_capability_mapper.mapCapabilities)(device.capabilities);
      }
      stateDefs = stateDefs.filter(
        (d) => d.id !== "light_scene" && d.id !== "diy_scene" && d.id !== "snapshot"
      );
      if (device.scenes.length > 0) {
        const sceneStates = { 0: "---" };
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
          capabilityInstance: "lightScene"
        });
      }
      if (device.diyScenes.length > 0) {
        const diyStates = { 0: "---" };
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
          capabilityInstance: "diyScene"
        });
      }
      if (device.snapshots.length > 0) {
        const snapStates = { 0: "---" };
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
          capabilityInstance: "snapshot"
        });
      }
      this.stateManager.createDeviceStates(device, stateDefs).catch((e) => {
        this.log.error(
          `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    }
    this.updateConnectionState();
  }
  /** Update global info.connection */
  updateConnectionState() {
    var _a, _b, _c, _d;
    const hasDevices = ((_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices().length) != null ? _b : 0) > 0;
    const anyOnline = (_d = (_c = this.deviceManager) == null ? void 0 : _c.getDevices().some((d) => d.state.online)) != null ? _d : false;
    const lanRunning = this.lanClient !== null;
    const connected = hasDevices ? anyOnline : lanRunning;
    this.setStateAsync("info.connection", { val: connected, ack: true }).catch(
      () => {
      }
    );
  }
  /**
   * Log final ready message with device/group/channel summary.
   * Called once at the end of onReady after all channels are initialized.
   *
   */
  logDeviceSummary() {
    var _a;
    if (!this.deviceManager) {
      return;
    }
    const all = this.deviceManager.getDevices();
    const devices = all.filter((d) => d.sku !== "BaseGroup");
    const groups = all.filter((d) => d.sku === "BaseGroup");
    const parts = [];
    if (devices.length > 0) {
      parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
    }
    if (groups.length > 0) {
      parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
    }
    const channels = ["LAN"];
    if (this.cloudWasConnected) {
      channels.push("Cloud");
    }
    if ((_a = this.mqttClient) == null ? void 0 : _a.connected) {
      channels.push("MQTT");
    }
    const deviceInfo = parts.length > 0 ? parts.join(", ") : "no devices found";
    this.log.info(
      `Govee adapter ready (${deviceInfo}, channels: ${channels.join("+")})`
    );
  }
  /**
   * Load current state for all Cloud devices and populate state values.
   * Called once after initial Cloud device list load.
   */
  async loadCloudStates() {
    if (!this.cloudClient || !this.deviceManager || !this.stateManager) {
      return;
    }
    const devices = this.deviceManager.getDevices();
    const lanStateIds = new Set((0, import_capability_mapper.getDefaultLanStates)().map((s) => s.id));
    let loaded = 0;
    for (const device of devices) {
      if (!device.channels.cloud || device.capabilities.length === 0) {
        continue;
      }
      try {
        const caps = await this.cloudClient.getDeviceState(
          device.sku,
          device.deviceId
        );
        const prefix = this.stateManager.devicePrefix(device);
        for (const cap of caps) {
          const mapped = (0, import_capability_mapper.mapCloudStateValue)(cap);
          if (!mapped) {
            continue;
          }
          if (device.lanIp && lanStateIds.has(mapped.stateId)) {
            continue;
          }
          const obj = await this.getObjectAsync(
            `${prefix}.control.${mapped.stateId}`
          );
          if (obj) {
            await this.setStateAsync(`${prefix}.control.${mapped.stateId}`, {
              val: mapped.value,
              ack: true
            });
          }
        }
        loaded++;
      } catch {
        this.log.debug(
          `Could not load Cloud state for ${device.name} (${device.sku})`
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
  findDeviceForState(localId) {
    if (!this.deviceManager || !this.stateManager) {
      return void 0;
    }
    for (const device of this.deviceManager.getDevices()) {
      const prefix = this.stateManager.devicePrefix(device);
      if (localId.startsWith(`${prefix}.`)) {
        return device;
      }
    }
    return void 0;
  }
  /**
   * Map state suffix to command name
   *
   * @param suffix State ID suffix (e.g. "power", "brightness")
   */
  stateToCommand(suffix) {
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
    if (suffix === "control.diy_scene") {
      return "diyScene";
    }
    if (suffix === "control.snapshot") {
      return "snapshot";
    }
    if (suffix === "control.music_mode" || suffix === "control.music_sensitivity" || suffix === "control.music_auto_color") {
      return "music";
    }
    const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
    if (segColorMatch) {
      return `segmentColor:${segColorMatch[1]}`;
    }
    const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
    if (segBrightMatch) {
      return `segmentBrightness:${segBrightMatch[1]}`;
    }
    if (suffix === "segments.command") {
      return "segmentBatch";
    }
    return null;
  }
}
if (require.main !== module) {
  module.exports = (options) => new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
//# sourceMappingURL=main.js.map
