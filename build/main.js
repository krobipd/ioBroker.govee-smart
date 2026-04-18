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
var import_cloud_retry = require("./lib/cloud-retry.js");
var import_rate_limiter = require("./lib/rate-limiter.js");
var import_segment_wizard = require("./lib/segment-wizard.js");
var import_sku_cache = require("./lib/sku-cache.js");
var import_state_manager = require("./lib/state-manager.js");
var import_types = require("./lib/types.js");
const FULL_LIMITS = { perMinute: 8, perDay: 9e3 };
const SHARED_LIMITS = { perMinute: 4, perDay: 4500 };
const SIBLING_ALIVE_ID = "system.adapter.govee-appliances.0.alive";
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
  siblingActive = false;
  stateCreationQueue = [];
  lanScanTimer;
  cleanupTimer;
  readyTimer;
  cloudRetry = null;
  segmentWizard = null;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "govee-smart" });
    this.on(
      "ready",
      () => this.onReady().catch(
        (e) => {
          var _a;
          return this.log.error(
            `onReady crashed: ${e instanceof Error ? (_a = e.stack) != null ? _a : e.message : String(e)}`
          );
        }
      )
    );
    this.on(
      "stateChange",
      (id, state) => this.onStateChange(id, state).catch(
        (e) => this.log.warn(
          `onStateChange crashed for ${id}: ${e instanceof Error ? e.message : String(e)}`
        )
      )
    );
    this.on("message", (obj) => this.onMessage(obj));
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
    await this.setObjectNotExistsAsync("info.wizardStatus", {
      type: "state",
      common: {
        name: "Segment-Wizard status",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });
    await this.setStateAsync("info.wizardStatus", {
      val: "Kein Wizard aktiv. W\xE4hle oben einen LED-Strip und klicke \u25B6 Start.",
      ack: true
    });
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
    this.deviceManager.onMqttSegmentUpdate = (device, segments) => {
      const prefix = this.stateManager.devicePrefix(device);
      for (const seg of segments) {
        this.setStateAsync(`${prefix}.segments.${seg.index}.color`, {
          val: (0, import_types.rgbToHex)(seg.r, seg.g, seg.b),
          ack: true
        }).catch(() => {
        });
        this.setStateAsync(`${prefix}.segments.${seg.index}.brightness`, {
          val: seg.brightness,
          ack: true
        }).catch(() => {
        });
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
      this.rateLimiter = new import_rate_limiter.RateLimiter(
        this.log,
        this,
        FULL_LIMITS.perMinute,
        FULL_LIMITS.perDay
      );
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);
      await this.detectSiblingAdapter();
      if (!cachedOk) {
        const result = await this.cloudInitWithTimeout();
        this.cloudWasConnected = result.ok;
        this.ensureCloudRetry().setConnected(result.ok);
        this.setStateAsync("info.cloudConnected", {
          val: result.ok,
          ack: true
        }).catch(() => {
        });
        (_a = this.stateManager) == null ? void 0 : _a.updateGroupsOnline(result.ok).catch(() => {
        });
        if (result.ok) {
          await this.loadCloudStates();
        } else {
          this.handleCloudFailure(result);
        }
      } else {
        this.log.info("Using cached device data \u2014 no Cloud calls needed");
        this.cloudWasConnected = true;
        this.ensureCloudRetry().setConnected(true);
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true
        }).catch(() => {
        });
        (_b = this.stateManager) == null ? void 0 : _b.updateGroupsOnline(true).catch(() => {
        });
      }
      await this.deviceManager.loadGroupMembers();
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
    }, 6e4);
  }
  /**
   * Initial Cloud-Load mit 60-Sekunden-Hardtimeout.
   * Blockiert nicht länger — wenn Cloud hängt, geht Adapter mit LAN+MQTT weiter,
   * und der Retry-Loop probiert's passend zum Fehlergrund erneut.
   */
  async cloudInitWithTimeout() {
    if (!this.deviceManager) {
      return { ok: false, reason: "transient" };
    }
    const loadPromise = this.deviceManager.loadFromCloud();
    const timeoutPromise = new Promise((resolve) => {
      this.setTimeout(
        () => resolve({ ok: false, reason: "transient" }),
        6e4
      );
    });
    try {
      return await Promise.race([loadPromise, timeoutPromise]);
    } catch {
      return { ok: false, reason: "transient" };
    }
  }
  /** Build the host object for {@link CloudRetryLoop}. */
  buildCloudRetryHost() {
    return {
      log: this.log,
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: (h) => this.clearTimeout(h),
      loadFromCloud: () => this.cloudInitWithTimeout(),
      onCloudRestored: async () => {
        var _a;
        this.cloudWasConnected = true;
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true
        }).catch(() => {
        });
        (_a = this.stateManager) == null ? void 0 : _a.updateGroupsOnline(true).catch(() => {
        });
        await this.loadCloudStates();
      }
    };
  }
  /** Lazy-initialise the retry loop on first use. */
  ensureCloudRetry() {
    if (!this.cloudRetry) {
      this.cloudRetry = new import_cloud_retry.CloudRetryLoop(this.buildCloudRetryHost());
      this.cloudRetry.setConnected(this.cloudWasConnected);
    }
    return this.cloudRetry;
  }
  /**
   * React to a Cloud-load outcome — delegates to {@link CloudRetryLoop}.
   *
   * @param result CloudLoadResult from initial load or retry attempt
   */
  handleCloudFailure(result) {
    this.ensureCloudRetry().handleResult(result);
  }
  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  onUnload(callback) {
    var _a, _b, _c, _d, _e;
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
      (_a = this.cloudRetry) == null ? void 0 : _a.dispose();
      (_b = this.segmentWizard) == null ? void 0 : _b.dispose();
      (_c = this.lanClient) == null ? void 0 : _c.stop();
      (_d = this.mqttClient) == null ? void 0 : _d.disconnect();
      (_e = this.rateLimiter) == null ? void 0 : _e.stop();
      this.setState("info.connection", { val: false, ack: true }).catch(
        () => {
        }
      );
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
    if (id === SIBLING_ALIVE_ID) {
      this.applySiblingLimits((state == null ? void 0 : state.val) === true);
      return;
    }
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
    if (device.sku === "BaseGroup" && device.groupMembers) {
      await this.handleGroupFanOut(device, stateSuffix, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
      if (stateSuffix === "scenes.light_scene" || stateSuffix === "music.music_mode") {
        await this.resetRelatedDropdowns(
          prefix,
          stateSuffix === "scenes.light_scene" ? "lightScene" : "music"
        );
      }
      return;
    }
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
    if (stateSuffix === "segments.manual_mode" || stateSuffix === "segments.manual_list") {
      await this.handleManualSegmentsChange(device, stateSuffix, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
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
      const capType = (_b = obj == null ? void 0 : obj.native) == null ? void 0 : _b.capabilityType;
      const capInstance = (_c = obj == null ? void 0 : obj.native) == null ? void 0 : _c.capabilityInstance;
      if (typeof capType === "string" && typeof capInstance === "string") {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            capType,
            capInstance,
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
    if (command === "sceneSpeed") {
      const level = typeof state.val === "number" ? state.val : parseInt(String(state.val), 10);
      if (!isNaN(level)) {
        device.sceneSpeed = level;
      }
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
    if (state.online !== void 0) {
      this.updateGroupReachability();
    }
  }
  /**
   * Fan out a group command to all member devices.
   * Basic controls (power, brightness, color) are sent directly.
   * Scenes/music are matched by name across members.
   *
   * @param group BaseGroup device
   * @param stateSuffix State path suffix (e.g. "control.power")
   * @param value Command value
   */
  async handleGroupFanOut(group, stateSuffix, value) {
    if (!this.deviceManager || !group.groupMembers) {
      return;
    }
    const devices = this.deviceManager.getDevices();
    const members = this.resolveGroupMembers(group, devices).filter(
      (d) => d.state.online
    );
    if (members.length === 0) {
      this.log.debug(`Group "${group.name}": no reachable members for fan-out`);
      return;
    }
    const command = this.stateToCommand(stateSuffix);
    if (!command) {
      return;
    }
    if ((command === "lightScene" || command === "music") && (value === "0" || value === 0)) {
      return;
    }
    for (const member of members) {
      try {
        if (command === "lightScene") {
          await this.fanOutScene(group, member, value);
        } else if (command === "music") {
          await this.fanOutMusic(group, member, stateSuffix, value);
        } else {
          await this.deviceManager.sendCommand(member, command, value);
        }
      } catch (err) {
        this.log.debug(
          `Group fan-out to ${member.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  /**
   * Fan out a scene command: match group scene name to member scene index.
   *
   * @param group BaseGroup device
   * @param member Target member device
   * @param value Dropdown index value
   */
  async fanOutScene(group, member, value) {
    var _a;
    if (!this.deviceManager || !this.stateManager) {
      return;
    }
    const groupPrefix = this.stateManager.devicePrefix(group);
    const obj = await this.getObjectAsync(
      `${this.namespace}.${groupPrefix}.scenes.light_scene`
    );
    const groupStates = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.states;
    const sceneName = groupStates == null ? void 0 : groupStates[String(value)];
    if (!sceneName) {
      return;
    }
    const memberIdx = member.scenes.findIndex((s) => s.name === sceneName);
    if (memberIdx >= 0) {
      await this.deviceManager.sendCommand(member, "lightScene", memberIdx + 1);
    }
  }
  /**
   * Fan out a music command: match group music name to member music index.
   *
   * @param group BaseGroup device
   * @param member Target member device
   * @param stateSuffix Music state path suffix
   * @param value Command value
   */
  async fanOutMusic(group, member, stateSuffix, value) {
    var _a;
    if (!this.deviceManager || !this.stateManager) {
      return;
    }
    if (stateSuffix !== "music.music_mode") {
      await this.sendMusicCommand(
        member,
        this.stateManager.devicePrefix(member),
        stateSuffix,
        value
      );
      return;
    }
    const groupPrefix = this.stateManager.devicePrefix(group);
    const obj = await this.getObjectAsync(
      `${this.namespace}.${groupPrefix}.music.music_mode`
    );
    const groupStates = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.states;
    const musicName = groupStates == null ? void 0 : groupStates[String(value)];
    if (!musicName) {
      return;
    }
    const memberIdx = member.musicLibrary.findIndex(
      (m) => m.name === musicName
    );
    if (memberIdx >= 0) {
      const memberPrefix = this.stateManager.devicePrefix(member);
      await this.sendMusicCommand(
        member,
        memberPrefix,
        "music.music_mode",
        memberIdx + 1
      );
    }
  }
  /**
   * Resolve group member references to actual device objects.
   *
   * @param group BaseGroup device with groupMembers
   * @param devices Full device list to search
   */
  resolveGroupMembers(group, devices) {
    if (!group.groupMembers) {
      return [];
    }
    return group.groupMembers.map(
      (m) => devices.find((d) => d.sku === m.sku && d.deviceId === m.deviceId)
    ).filter((d) => d !== void 0);
  }
  /**
   * Recalculate info.membersUnreachable for all groups.
   * Called when any device's online status changes.
   */
  updateGroupReachability() {
    if (!this.deviceManager || !this.stateManager) {
      return;
    }
    const devices = this.deviceManager.getDevices();
    for (const group of devices) {
      if (group.sku !== "BaseGroup" || !group.groupMembers) {
        continue;
      }
      const memberDevices = this.resolveGroupMembers(group, devices);
      this.stateManager.updateGroupMembersUnreachable(group, memberDevices).catch(() => {
      });
    }
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
      let memberDevices;
      if (device.sku === "BaseGroup" && device.groupMembers) {
        memberDevices = this.resolveGroupMembers(device, devices);
      }
      const stateDefs = (0, import_capability_mapper.buildDeviceStateDefs)(device, localSnaps, memberDevices);
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
    var _a, _b;
    const devices = (_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
    const hasDevices = devices.length > 0;
    const anyOnline = devices.some((d) => d.state.online);
    const lanRunning = this.lanClient !== null;
    const connected = hasDevices ? anyOnline : lanRunning;
    this.setStateAsync("info.connection", { val: connected, ack: true }).catch(
      () => {
      }
    );
  }
  /**
   * Detect if sibling adapter (govee-appliances) is running and adjust rate limits.
   * Subscribes to alive state for dynamic updates.
   */
  async detectSiblingAdapter() {
    try {
      const alive = await this.getForeignStateAsync(SIBLING_ALIVE_ID);
      this.applySiblingLimits((alive == null ? void 0 : alive.val) === true);
      await this.subscribeForeignStatesAsync(SIBLING_ALIVE_ID);
    } catch {
      this.applySiblingLimits(false);
    }
  }
  /**
   * Apply rate limits based on sibling adapter presence.
   *
   * @param siblingAlive Whether the sibling adapter is running
   */
  applySiblingLimits(siblingAlive) {
    if (!this.rateLimiter || this.siblingActive === siblingAlive) {
      return;
    }
    this.siblingActive = siblingAlive;
    if (siblingAlive) {
      this.rateLimiter.updateLimits(
        SHARED_LIMITS.perMinute,
        SHARED_LIMITS.perDay
      );
      this.log.info(
        `govee-appliances detected \u2014 sharing API budget (${SHARED_LIMITS.perMinute}/min, ${SHARED_LIMITS.perDay}/day)`
      );
    } else {
      this.rateLimiter.updateLimits(FULL_LIMITS.perMinute, FULL_LIMITS.perDay);
      this.log.info(
        `govee-appliances not active \u2014 using full API budget (${FULL_LIMITS.perMinute}/min, ${FULL_LIMITS.perDay}/day)`
      );
    }
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
    const pending = [];
    if (this.cloudClient && !this.cloudWasConnected) {
      pending.push("Cloud");
    }
    if (this.mqttClient && !this.mqttClient.connected) {
      pending.push("MQTT");
    }
    const pendingNote = pending.length > 0 ? `, ${pending.join("+")} noch im Aufbau \u2014 wird im Hintergrund fortgesetzt` : "";
    if (devices.length === 0 && groups.length === 0) {
      this.log.info(
        `Govee adapter ready \u2014 no devices found (channels: ${channels.join("+")}${pendingNote})`
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
      `Govee adapter ready \u2014 ${parts.join(", ")} (channels: ${channels.join("+")}${pendingNote})`
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
   * React to manual-segments state changes — parses list, updates device runtime,
   * rebuilds segment tree. Reverts manual_mode on parse error.
   *
   * @param device Target device
   * @param suffix State suffix (either "segments.manual_mode" or "segments.manual_list")
   * @param newValue Written value
   */
  async handleManualSegmentsChange(device, suffix, newValue) {
    var _a, _b, _c, _d;
    if (!this.stateManager) {
      return;
    }
    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;
    const modeVal = suffix === "segments.manual_mode" ? Boolean(newValue) : Boolean(
      (_a = await this.getStateAsync(`${ns}.${prefix}.segments.manual_mode`)) == null ? void 0 : _a.val
    );
    const listVal = suffix === "segments.manual_list" ? typeof newValue === "string" ? newValue : "" : String(
      (_c = (_b = await this.getStateAsync(`${ns}.${prefix}.segments.manual_list`)) == null ? void 0 : _b.val) != null ? _c : ""
    );
    if (!modeVal) {
      device.manualMode = false;
      device.manualSegments = void 0;
      this.log.info(
        `${device.name}: manual segments disabled \u2014 using Cloud defaults`
      );
      await this.stateManager.createSegmentStates(device);
      return;
    }
    const maxIdx = Math.max(0, ((_d = device.segmentCount) != null ? _d : 0) - 1);
    const parsed = (0, import_types.parseSegmentList)(listVal, maxIdx);
    if (parsed.error) {
      this.log.warn(
        `${device.name}: manual_list invalid (${parsed.error}) \u2014 disabling manual mode`
      );
      device.manualMode = false;
      device.manualSegments = void 0;
      await this.setStateAsync(`${ns}.${prefix}.segments.manual_mode`, {
        val: false,
        ack: true
      });
      return;
    }
    device.manualMode = true;
    device.manualSegments = parsed.indices;
    this.log.info(
      `${device.name}: manual segments active \u2014 ${parsed.indices.length} physical segments (${listVal})`
    );
    await this.stateManager.createSegmentStates(device);
  }
  // ───────── Segment-Detection-Wizard ─────────
  /**
   * Handle incoming sendTo messages (from jsonConfig).
   *
   * @param obj ioBroker message object
   */
  onMessage(obj) {
    if (!(obj == null ? void 0 : obj.command)) {
      return;
    }
    this.handleMessage(obj).catch((e) => {
      this.log.warn(
        `onMessage handler crashed for ${obj.command}: ${e instanceof Error ? e.message : String(e)}`
      );
      this.sendMessageResponse(obj, {
        error: e instanceof Error ? e.message : String(e)
      });
    });
  }
  async handleMessage(obj) {
    var _a, _b, _c, _d, _e;
    try {
      if (obj.command === "getSegmentDevices") {
        const devices = (_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
        const list = devices.filter(
          (d) => {
            var _a2;
            return d.sku !== "BaseGroup" && typeof d.segmentCount === "number" && d.segmentCount > 0 && ((_a2 = d.state) == null ? void 0 : _a2.online) === true;
          }
        ).map((d) => ({
          value: this.deviceKeyFor(d),
          label: `${d.name} (${d.sku}, ${d.segmentCount} Segmente)`
        }));
        this.sendMessageResponse(obj, list);
        return;
      }
      if (obj.command === "segmentWizard") {
        const payload = (_c = obj.message) != null ? _c : {};
        const response = await this.runWizardStep(
          (_d = payload.action) != null ? _d : "",
          (_e = payload.device) != null ? _e : ""
        );
        this.sendMessageResponse(obj, response);
        return;
      }
    } catch (e) {
      this.log.warn(
        `onMessage failed for ${obj.command}: ${e instanceof Error ? e.message : String(e)}`
      );
      this.sendMessageResponse(obj, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }
  sendMessageResponse(obj, data) {
    if (obj.callback && obj.from) {
      this.sendTo(
        obj.from,
        obj.command,
        data,
        obj.callback
      );
    }
  }
  /**
   * Stable device key for wizard session tracking.
   *
   * @param device Target device
   */
  deviceKeyFor(device) {
    return `${device.sku}:${device.deviceId}`;
  }
  findDeviceByKey(key) {
    var _a, _b;
    const devices = (_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
    return devices.find((d) => this.deviceKeyFor(d) === key);
  }
  /** Construct the host object passed into SegmentWizard. */
  buildWizardHost() {
    return {
      log: this.log,
      getState: (id) => this.getStateAsync(id),
      setState: (id, s) => this.setStateAsync(id, {
        val: s.val,
        ack: s.ack
      }),
      sendCommand: async (device, command, value) => {
        var _a;
        await ((_a = this.deviceManager) == null ? void 0 : _a.sendCommand(device, command, value));
      },
      flashSegmentAtomic: (device, total, idx) => {
        if (!device.lanIp || !this.lanClient) {
          return Promise.resolve(false);
        }
        this.lanClient.flashSingleSegment(device.lanIp, total, idx);
        return Promise.resolve(true);
      },
      restoreStripAtomic: (device, total, color, brightness) => {
        if (!device.lanIp || !this.lanClient) {
          return Promise.resolve(false);
        }
        const r = color >> 16 & 255;
        const g = color >> 8 & 255;
        const b = color & 255;
        this.lanClient.restoreAllSegments(
          device.lanIp,
          total,
          r,
          g,
          b,
          brightness
        );
        return Promise.resolve(true);
      },
      findDevice: (key) => this.findDeviceByKey(key),
      namespace: this.namespace,
      devicePrefix: (device) => {
        var _a, _b;
        return (_b = (_a = this.stateManager) == null ? void 0 : _a.devicePrefix(device)) != null ? _b : "";
      },
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: (h) => this.clearTimeout(h)
    };
  }
  /**
   * Execute one wizard step (start/yes/no/abort). Delegates to
   * {@link SegmentWizard} — see `lib/segment-wizard.ts`.
   *
   * @param action "start" | "yes" | "no" | "abort"
   * @param deviceKey device identifier (only required for "start")
   */
  async runWizardStep(action, deviceKey) {
    if (!this.segmentWizard) {
      this.segmentWizard = new import_segment_wizard.SegmentWizard(this.buildWizardHost());
    }
    const response = await this.segmentWizard.runStep(action, deviceKey);
    const statusText = this.segmentWizard.getStatusText();
    await this.setStateAsync("info.wizardStatus", {
      val: statusText,
      ack: true
    });
    return response;
  }
  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  async handleSnapshotSave(device, name) {
    var _a;
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
    let segments;
    const segCount = (_a = device.segmentCount) != null ? _a : 0;
    if (segCount > 0) {
      segments = [];
      for (let i = 0; i < segCount; i++) {
        const segColor = await this.getStateAsync(
          `${ns}.${prefix}.segments.${i}.color`
        );
        const segBright = await this.getStateAsync(
          `${ns}.${prefix}.segments.${i}.brightness`
        );
        segments.push({
          color: typeof (segColor == null ? void 0 : segColor.val) === "string" ? segColor.val : "#000000",
          brightness: typeof (segBright == null ? void 0 : segBright.val) === "number" ? segBright.val : 100
        });
      }
    }
    const snapshot = {
      name,
      power: (powerState == null ? void 0 : powerState.val) === true,
      brightness: typeof (brightState == null ? void 0 : brightState.val) === "number" ? brightState.val : 0,
      colorRgb: typeof (colorState == null ? void 0 : colorState.val) === "string" ? colorState.val : "#000000",
      colorTemperature: typeof (ctState == null ? void 0 : ctState.val) === "number" ? ctState.val : 0,
      segments,
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
      if (snap.segments && snap.segments.length > 0) {
        for (let i = 0; i < snap.segments.length; i++) {
          const seg = snap.segments[i];
          await this.deviceManager.sendCommand(
            device,
            `segmentColor:${i}`,
            seg.color
          );
          await this.deviceManager.sendCommand(
            device,
            `segmentBrightness:${i}`,
            seg.brightness
          );
        }
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
