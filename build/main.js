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
var path = __toESM(require("node:path"));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_capability_mapper = require("./lib/capability-mapper.js");
var import_device_quirks = require("./lib/device-quirks.js");
var import_device_manager = require("./lib/device-manager.js");
var import_govee_api_client = require("./lib/govee-api-client.js");
var import_govee_cloud_client = require("./lib/govee-cloud-client.js");
var import_govee_lan_client = require("./lib/govee-lan-client.js");
var import_govee_mqtt_client = require("./lib/govee-mqtt-client.js");
var import_local_snapshots = require("./lib/local-snapshots.js");
var import_rate_limiter = require("./lib/rate-limiter.js");
var import_sku_cache = require("./lib/sku-cache.js");
var import_state_manager = require("./lib/state-manager.js");
var import_types = require("./lib/types.js");
class GoveeAdapter extends utils.Adapter {
  deviceManager = null;
  stateManager = null;
  lanClient = null;
  mqttClient = null;
  cloudClient = null;
  rateLimiter = null;
  skuCache = null;
  localSnapshots = null;
  cloudWasConnected = false;
  readyLogged = false;
  cloudInitDone = false;
  lanScanDone = false;
  statesReady = false;
  stateCreationQueue = [];
  lanScanTimer;
  cleanupTimer;
  readyTimer;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }
  /** Adapter started — initialize all channels */
  async onReady() {
    var _a, _b;
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
    await this.stateManager.createGroupsOnlineState(false);
    this.deviceManager = new import_device_manager.DeviceManager(this.log);
    const dataDir = utils.getAbsoluteInstanceDataDir(this);
    const quirksPath = path.join(dataDir, "community-quirks.json");
    (0, import_device_quirks.loadCommunityQuirks)(quirksPath, this.log);
    this.skuCache = new import_sku_cache.SkuCache(dataDir, this.log);
    this.localSnapshots = new import_local_snapshots.LocalSnapshotStore(dataDir, this.log);
    this.deviceManager.setSkuCache(this.skuCache);
    const apiClient = new import_govee_api_client.GoveeApiClient();
    this.deviceManager.setApiClient(apiClient);
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
          const hex = (0, import_types.rgbIntToHex)(batch.color);
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
    const startChannels = ["LAN"];
    if (config.apiKey) {
      startChannels.push("Cloud");
    }
    if (config.goveeEmail && config.goveePassword) {
      startChannels.push("MQTT");
    }
    this.log.info(
      `Starting with channels: ${startChannels.join(", ")} \u2014 please wait...`
    );
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
    this.lanScanTimer = this.setTimeout(() => {
      this.lanScanDone = true;
      this.checkAllReady();
    }, 3e3);
    if (config.goveeEmail && config.goveePassword) {
      this.mqttClient = new import_govee_mqtt_client.GoveeMqttClient(
        config.goveeEmail,
        config.goveePassword,
        this.log,
        this
      );
      await this.mqttClient.connect(
        (update) => this.deviceManager.handleMqttStatus(update),
        (connected) => {
          this.setStateAsync("info.mqttConnected", {
            val: connected,
            ack: true
          }).catch(() => {
          });
          if (connected) {
            this.checkAllReady();
          }
          this.updateConnectionState();
        }
      );
      if (this.mqttClient.token) {
        apiClient.setBearerToken(this.mqttClient.token);
      }
    }
    const cachedOk = this.deviceManager.loadFromCache();
    if (config.apiKey) {
      this.cloudClient = new import_govee_cloud_client.GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);
      this.rateLimiter = new import_rate_limiter.RateLimiter(this.log, this);
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);
      if (!cachedOk) {
        const cloudOk = await this.deviceManager.loadFromCloud();
        this.cloudWasConnected = cloudOk;
        this.setStateAsync("info.cloudConnected", {
          val: cloudOk,
          ack: true
        }).catch(() => {
        });
        (_a = this.stateManager) == null ? void 0 : _a.updateGroupsOnline(cloudOk).catch(() => {
        });
        if (cloudOk) {
          await this.loadCloudStates();
        }
      } else {
        this.log.info("Using cached device data \u2014 no Cloud calls needed");
        this.cloudWasConnected = true;
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true
        }).catch(() => {
        });
        (_b = this.stateManager) == null ? void 0 : _b.updateGroupsOnline(true).catch(() => {
        });
      }
      this.cloudInitDone = true;
    }
    await Promise.all(this.stateCreationQueue);
    this.stateCreationQueue = [];
    this.statesReady = true;
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");
    this.cleanupTimer = this.setTimeout(() => {
      if (this.stateManager && this.deviceManager) {
        this.stateManager.cleanupDevices(this.deviceManager.getDevices()).catch(() => {
        });
      }
    }, 3e4);
    this.updateConnectionState();
    this.checkAllReady();
    this.readyTimer = this.setTimeout(() => {
      if (!this.readyLogged) {
        this.readyLogged = true;
        this.logDeviceSummary();
      }
    }, 3e4);
  }
  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  onUnload(callback) {
    var _a, _b, _c;
    try {
      if (this.lanScanTimer) {
        this.clearTimeout(this.lanScanTimer);
      }
      if (this.cleanupTimer) {
        this.clearTimeout(this.cleanupTimer);
      }
      if (this.readyTimer) {
        this.clearTimeout(this.readyTimer);
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
    var _a, _b, _c;
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
    if (stateSuffix === "snapshots.snapshot_save" && typeof state.val === "string" && state.val.trim()) {
      await this.handleSnapshotSave(device, state.val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }
    if (stateSuffix === "snapshots.snapshot_local") {
      if (state.val !== "0" && state.val !== 0) {
        await this.handleSnapshotRestore(device, state.val);
        await this.resetRelatedDropdowns(prefix, "snapshotLocal");
      }
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }
    if (stateSuffix === "snapshots.snapshot_delete" && typeof state.val === "string" && state.val.trim()) {
      this.handleSnapshotDelete(device, state.val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }
    if (stateSuffix === "info.diagnostics_export" && state.val) {
      const diag = this.deviceManager.generateDiagnostics(
        device,
        (_a = this.version) != null ? _a : "unknown"
      );
      const resultId = `${this.namespace}.${prefix}.info.diagnostics_result`;
      await this.setStateAsync(resultId, {
        val: JSON.stringify(diag, null, 2),
        ack: true
      });
      await this.setStateAsync(id, { val: false, ack: true });
      this.log.info(`Diagnostics exported for ${device.name} (${device.sku})`);
      return;
    }
    const command = this.stateToCommand(stateSuffix);
    if (!command) {
      const obj = await this.getObjectAsync(id);
      if (((_b = obj == null ? void 0 : obj.native) == null ? void 0 : _b.capabilityType) && ((_c = obj == null ? void 0 : obj.native) == null ? void 0 : _c.capabilityInstance)) {
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
    if ((command === "lightScene" || command === "diyScene" || command === "snapshot") && (state.val === "0" || state.val === 0)) {
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }
    try {
      if (command === "music") {
        if (stateSuffix === "music.music_mode" && (state.val === "0" || state.val === 0)) {
          await this.setStateAsync(id, { val: state.val, ack: true });
          return;
        }
        await this.sendMusicCommand(device, prefix, stateSuffix, state.val);
        await this.setStateAsync(id, { val: state.val, ack: true });
        if (stateSuffix === "music.music_mode") {
          await this.resetRelatedDropdowns(prefix, "music");
        }
        return;
      }
      await this.deviceManager.sendCommand(device, command, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
      await this.resetRelatedDropdowns(prefix, command);
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
    const musicBase = `${this.namespace}.${prefix}.music`;
    const modeState = await this.getStateAsync(`${musicBase}.music_mode`);
    const sensState = await this.getStateAsync(
      `${musicBase}.music_sensitivity`
    );
    const autoState = await this.getStateAsync(`${musicBase}.music_auto_color`);
    const musicMode = changedSuffix === "music.music_mode" ? parseInt(String(newValue), 10) : parseInt(String((_a = modeState == null ? void 0 : modeState.val) != null ? _a : 0), 10);
    const sensitivity = changedSuffix === "music.music_sensitivity" ? newValue : (_b = sensState == null ? void 0 : sensState.val) != null ? _b : 100;
    const autoColor = changedSuffix === "music.music_auto_color" ? newValue ? 1 : 0 : (autoState == null ? void 0 : autoState.val) ? 1 : 0;
    if (!musicMode || musicMode === 0) {
      this.log.debug("Music mode not selected, skipping command");
      return;
    }
    if (device.lanIp && this.lanClient) {
      let r = 0, g = 0, b = 0;
      if (musicMode === 1 || musicMode === 2) {
        const colorState = await this.getStateAsync(
          `${this.namespace}.${prefix}.control.colorRgb`
        );
        if ((colorState == null ? void 0 : colorState.val) && typeof colorState.val === "string") {
          ({ r, g, b } = (0, import_types.hexToRgb)(colorState.val));
        }
      }
      this.lanClient.setMusicMode(device.lanIp, musicMode, r, g, b);
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
    var _a;
    if (!this.stateManager) {
      return;
    }
    for (const device of devices) {
      const localSnaps = (_a = this.localSnapshots) == null ? void 0 : _a.getSnapshots(
        device.sku,
        device.deviceId
      );
      const stateDefs = (0, import_capability_mapper.buildDeviceStateDefs)(device, localSnaps);
      const p = this.stateManager.createDeviceStates(device, stateDefs).catch((e) => {
        this.log.error(
          `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`
        );
      });
      this.stateCreationQueue.push(p);
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
   * Check if all configured channels are initialized and log ready message.
   * Called from MQTT onConnection callback and end of onReady.
   */
  checkAllReady() {
    if (this.readyLogged) {
      return;
    }
    if (!this.lanScanDone) {
      return;
    }
    if (!this.statesReady) {
      return;
    }
    if (this.cloudClient && !this.cloudInitDone) {
      return;
    }
    if (this.mqttClient && !this.mqttClient.connected) {
      return;
    }
    this.readyLogged = true;
    this.logDeviceSummary();
  }
  /**
   * Log final ready message with device/group/channel summary.
   */
  logDeviceSummary() {
    var _a;
    if (!this.deviceManager) {
      return;
    }
    const all = this.deviceManager.getDevices();
    const devices = all.filter((d) => d.sku !== "BaseGroup");
    const groups = all.filter((d) => d.sku === "BaseGroup");
    const channels = ["LAN"];
    if (this.cloudWasConnected) {
      channels.push("Cloud");
    }
    if ((_a = this.mqttClient) == null ? void 0 : _a.connected) {
      channels.push("MQTT");
    }
    if (devices.length === 0 && groups.length === 0) {
      this.log.info(
        `Govee adapter ready \u2014 no devices found (channels: ${channels.join("+")})`
      );
      return;
    }
    const parts = [];
    if (devices.length > 0) {
      parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
    }
    if (groups.length > 0) {
      parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
    }
    this.log.info(
      `Govee adapter ready \u2014 ${parts.join(", ")} (channels: ${channels.join("+")})`
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
          const statePath = this.stateManager.resolveStatePath(
            prefix,
            mapped.stateId
          );
          const obj = await this.getObjectAsync(statePath);
          if (obj) {
            await this.setStateAsync(statePath, {
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
    if (suffix === "control.gradient_toggle") {
      return "gradientToggle";
    }
    if (suffix === "scenes.light_scene") {
      return "lightScene";
    }
    if (suffix === "scenes.diy_scene") {
      return "diyScene";
    }
    if (suffix === "scenes.scene_speed") {
      return "sceneSpeed";
    }
    if (suffix === "music.music_mode" || suffix === "music.music_sensitivity" || suffix === "music.music_auto_color") {
      return "music";
    }
    if (suffix === "snapshots.snapshot") {
      return "snapshot";
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
  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  async handleSnapshotSave(device, name) {
    if (!this.localSnapshots || !this.stateManager) {
      return;
    }
    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;
    const powerState = await this.getStateAsync(
      `${ns}.${prefix}.control.power`
    );
    const brightState = await this.getStateAsync(
      `${ns}.${prefix}.control.brightness`
    );
    const colorState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorRgb`
    );
    const ctState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorTemperature`
    );
    const snapshot = {
      name,
      power: (powerState == null ? void 0 : powerState.val) === true,
      brightness: typeof (brightState == null ? void 0 : brightState.val) === "number" ? brightState.val : 0,
      colorRgb: typeof (colorState == null ? void 0 : colorState.val) === "string" ? colorState.val : "#000000",
      colorTemperature: typeof (ctState == null ? void 0 : ctState.val) === "number" ? ctState.val : 0,
      savedAt: Date.now()
    };
    this.localSnapshots.saveSnapshot(device.sku, device.deviceId, snapshot);
    this.log.info(`Local snapshot saved: "${name}" for ${device.name}`);
    this.onDeviceListChanged(this.deviceManager.getDevices());
  }
  /**
   * Restore a local snapshot by index.
   *
   * @param device Target device
   * @param val Dropdown index value
   */
  async handleSnapshotRestore(device, val) {
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
    await this.deviceManager.sendCommand(device, "power", snap.power);
    if (snap.power) {
      await this.deviceManager.sendCommand(
        device,
        "brightness",
        snap.brightness
      );
      if (snap.colorTemperature > 0) {
        await this.deviceManager.sendCommand(
          device,
          "colorTemperature",
          snap.colorTemperature
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
  handleSnapshotDelete(device, name) {
    if (!this.localSnapshots) {
      return;
    }
    if (this.localSnapshots.deleteSnapshot(device.sku, device.deviceId, name)) {
      this.log.info(`Local snapshot deleted: "${name}" for ${device.name}`);
      this.onDeviceListChanged(this.deviceManager.getDevices());
    } else {
      this.log.warn(`Local snapshot "${name}" not found for ${device.name}`);
    }
  }
  /**
   * Reset related dropdown states when switching between scenes/snapshots/colors.
   * Each mode-switch resets all OTHER mode dropdowns to "---" (0).
   *
   * @param prefix Device state prefix
   * @param activeCommand The command that was just executed
   */
  async resetRelatedDropdowns(prefix, activeCommand) {
    const ALL_DROPDOWNS = [
      "scenes.light_scene",
      "scenes.diy_scene",
      "snapshots.snapshot",
      "snapshots.snapshot_local",
      "music.music_mode"
    ];
    const COMMAND_DROPDOWN = {
      lightScene: "scenes.light_scene",
      diyScene: "scenes.diy_scene",
      snapshot: "snapshots.snapshot",
      snapshotLocal: "snapshots.snapshot_local",
      music: "music.music_mode",
      colorRgb: "",
      colorTemperature: ""
    };
    if (!(activeCommand in COMMAND_DROPDOWN)) {
      return;
    }
    const ownDropdown = COMMAND_DROPDOWN[activeCommand];
    for (const dropdown of ALL_DROPDOWNS) {
      if (dropdown === ownDropdown) {
        continue;
      }
      const stateId = `${this.namespace}.${prefix}.${dropdown}`;
      const current = await this.getStateAsync(stateId);
      if ((current == null ? void 0 : current.val) && current.val !== "0" && current.val !== 0) {
        await this.setStateAsync(stateId, { val: "0", ack: true });
      }
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
//# sourceMappingURL=main.js.map
