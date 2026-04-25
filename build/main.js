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
const SIBLING_ALIVE_PATTERN = "system.adapter.govee-appliances.*.alive";
function isSiblingAliveId(id) {
  return id.startsWith("system.adapter.govee-appliances.") && id.endsWith(".alive");
}
const STATE_TO_COMMAND = {
  "control.power": "power",
  "control.brightness": "brightness",
  "control.colorRgb": "colorRgb",
  "control.colorTemperature": "colorTemperature",
  "control.scene": "scene",
  "control.gradient_toggle": "gradientToggle",
  "scenes.light_scene": "lightScene",
  "scenes.diy_scene": "diyScene",
  "scenes.scene_speed": "sceneSpeed",
  "music.music_mode": "music",
  "music.music_sensitivity": "music",
  "music.music_auto_color": "music",
  "snapshots.snapshot_cloud": "snapshot",
  "segments.command": "segmentBatch"
};
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
  unhandledRejectionHandler = null;
  uncaughtExceptionHandler = null;
  /** Per-device timestamp of the last diagnostics export — throttle gate */
  diagnosticsLastRun = /* @__PURE__ */ new Map();
  /** Cached admin language from system.config — used for wizard UI text */
  adminLanguage = "en";
  /** Active govee-appliances instance ids (e.g. "govee-appliances.0") */
  siblingInstancesAlive = /* @__PURE__ */ new Set();
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
    this.unhandledRejectionHandler = (reason) => {
      var _a;
      this.log.error(
        `Unhandled rejection: ${reason instanceof Error ? (_a = reason.stack) != null ? _a : reason.message : String(reason)}`
      );
    };
    this.uncaughtExceptionHandler = (err) => {
      var _a;
      this.log.error(`Uncaught exception: ${(_a = err.stack) != null ? _a : err.message}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }
  /** Adapter started — initialize all channels */
  async onReady() {
    var _a, _b, _c;
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
    await this.setObjectNotExistsAsync("info.refresh_cloud_data", {
      type: "state",
      common: {
        name: "Refresh Cloud Data",
        desc: "Write true to re-fetch scenes, snapshots and device list from the Govee Cloud for all devices. Use this after creating a new snapshot in the Govee Home app to see it in the dropdown without restarting the adapter.",
        type: "boolean",
        role: "button",
        read: true,
        write: true,
        def: false
      },
      native: {}
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });
    await this.setStateAsync("info.refresh_cloud_data", {
      val: false,
      ack: true
    });
    try {
      const sysConf = await this.getForeignObjectAsync("system.config");
      const lang = (_a = sysConf == null ? void 0 : sysConf.common) == null ? void 0 : _a.language;
      if (typeof lang === "string" && lang.length > 0) {
        this.adminLanguage = lang;
      }
    } catch {
    }
    await this.setStateAsync("info.wizardStatus", {
      val: (0, import_segment_wizard.wizardIdleText)(this.adminLanguage),
      ack: true
    });
    this.stateManager = new import_state_manager.StateManager(this);
    await this.stateManager.createGroupsOnlineState(false);
    this.deviceManager = new import_device_manager.DeviceManager(this.log, this);
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
    this.deviceManager.onSegmentCountGrown = (device) => {
      if (!this.stateManager) {
        return;
      }
      this.stateManager.createSegmentStates(device).catch((e) => {
        this.log.warn(
          `Failed to rebuild segment tree for ${device.name} after count growth: ${e instanceof Error ? e.message : String(e)}`
        );
      });
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
        var _a2;
        this.deviceManager.handleLanDiscovery(lanDevice);
        if (!((_a2 = this.mqttClient) == null ? void 0 : _a2.connected)) {
          this.lanClient.requestStatus(lanDevice.ip);
        }
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
        },
        // Forward every fresh bearer token — fires on initial login and on
        // each reconnect-login, so the API client never runs with a stale one.
        (token) => apiClient.setBearerToken(token)
      );
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
        (_b = this.stateManager) == null ? void 0 : _b.updateGroupsOnline(result.ok).catch(() => {
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
        (_c = this.stateManager) == null ? void 0 : _c.updateGroupsOnline(true).catch(() => {
        });
      }
      await this.deviceManager.loadGroupMembers();
      this.cloudInitDone = true;
    }
    while (this.stateCreationQueue.length > 0) {
      const pending = this.stateCreationQueue;
      this.stateCreationQueue = [];
      await Promise.all(pending);
    }
    this.statesReady = true;
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");
    await this.subscribeStatesAsync("info.refresh_cloud_data");
    this.cleanupTimer = this.setTimeout(() => {
      this.reapStaleDevices().catch(
        (e) => this.log.debug(
          `Device cleanup failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
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
   * React to the user writing `info.refresh_cloud_data = true`. Performs one
   * full Cloud reload cycle so newly created scenes/snapshots from the Govee
   * Home app show up without an adapter restart.
   */
  async handleManualCloudRefresh() {
    if (!this.deviceManager || !this.cloudClient) {
      this.log.info(
        "Refresh cloud data: no Cloud client configured (API key missing) \u2014 nothing to do"
      );
      return;
    }
    this.log.info(
      "Refresh cloud data: re-fetching scenes and snapshots for all devices"
    );
    try {
      const changed = await this.deviceManager.refreshSceneData();
      if (changed) {
        await this.loadCloudStates();
      }
      this.log.info("Refresh cloud data: done");
    } catch (e) {
      this.log.warn(
        `Refresh cloud data failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
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
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      this.setState("info.connection", { val: false, ack: true }).catch(
        () => {
        }
      );
      this.setState("info.mqttConnected", { val: false, ack: true }).catch(
        () => {
        }
      );
      this.setState("info.cloudConnected", { val: false, ack: true }).catch(
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
    var _a, _b, _c, _d;
    if (isSiblingAliveId(id)) {
      const instance = id.replace("system.adapter.", "").replace(/\.alive$/, "");
      if ((state == null ? void 0 : state.val) === true) {
        this.siblingInstancesAlive.add(instance);
      } else {
        this.siblingInstancesAlive.delete(instance);
      }
      this.applySiblingLimits(this.siblingInstancesAlive.size > 0);
      return;
    }
    if (!state || state.ack || !this.deviceManager || !this.stateManager) {
      return;
    }
    if (id === `${this.namespace}.info.refresh_cloud_data` && state.val) {
      await this.handleManualCloudRefresh();
      await this.setStateAsync(id, { val: false, ack: true });
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
    const resolved = await this.resolveDropdownInput(id, state.val);
    if (!resolved.ok) {
      this.log.warn(
        `Unknown dropdown value for ${id}: ${String(state.val)} \u2014 ignoring`
      );
      return;
    }
    const val = resolved.val;
    if (device.sku === "BaseGroup" && device.groupMembers) {
      await this.handleGroupFanOut(device, stateSuffix, val);
      await this.setStateAsync(id, { val, ack: true });
      if (stateSuffix === "scenes.light_scene" || stateSuffix === "music.music_mode") {
        await this.resetRelatedDropdowns(
          prefix,
          stateSuffix === "scenes.light_scene" ? "lightScene" : "music"
        );
      }
      return;
    }
    if (stateSuffix === "snapshots.snapshot_save" && typeof val === "string" && val.trim()) {
      await this.handleSnapshotSave(device, val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }
    if (stateSuffix === "snapshots.snapshot_local") {
      if (val !== "0" && val !== 0) {
        await this.handleSnapshotRestore(device, val);
        await this.resetRelatedDropdowns(prefix, "snapshotLocal");
      }
      await this.setStateAsync(id, { val, ack: true });
      return;
    }
    if (stateSuffix === "snapshots.snapshot_delete" && typeof val === "string" && val.trim()) {
      this.handleSnapshotDelete(device, val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }
    if (stateSuffix === "segments.manual_mode" || stateSuffix === "segments.manual_list") {
      await this.handleManualSegmentsChange(device, stateSuffix, val);
      return;
    }
    if (stateSuffix === "info.diagnostics_export" && val) {
      const deviceKey = `${device.sku}:${device.deviceId}`;
      const now = Date.now();
      const last = (_a = this.diagnosticsLastRun.get(deviceKey)) != null ? _a : 0;
      if (now - last < 2e3) {
        this.log.debug(
          `Diagnostics export throttled for ${device.name} \u2014 last run ${now - last}ms ago`
        );
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
      this.diagnosticsLastRun.set(deviceKey, now);
      const diag = this.deviceManager.generateDiagnostics(
        device,
        (_b = this.version) != null ? _b : "unknown"
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
      const capType = (_c = obj == null ? void 0 : obj.native) == null ? void 0 : _c.capabilityType;
      const capInstance = (_d = obj == null ? void 0 : obj.native) == null ? void 0 : _d.capabilityInstance;
      if (typeof capType === "string" && typeof capInstance === "string") {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            capType,
            capInstance,
            val
          );
          await this.setStateAsync(id, { val, ack: true });
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
    if ((command === "lightScene" || command === "diyScene" || command === "snapshot") && (val === "0" || val === 0)) {
      await this.setStateAsync(id, { val, ack: true });
      return;
    }
    if (command === "sceneSpeed") {
      const level = typeof val === "number" ? val : parseInt(String(val), 10);
      if (!isNaN(level)) {
        device.sceneSpeed = level;
      }
      await this.setStateAsync(id, { val, ack: true });
      return;
    }
    try {
      if (command === "music") {
        if (stateSuffix === "music.music_mode" && (val === "0" || val === 0)) {
          await this.setStateAsync(id, { val, ack: true });
          return;
        }
        await this.sendMusicCommand(device, prefix, stateSuffix, val);
        await this.setStateAsync(id, { val, ack: true });
        if (stateSuffix === "music.music_mode") {
          await this.resetRelatedDropdowns(prefix, "music");
        }
        return;
      }
      await this.deviceManager.sendCommand(device, command, val);
      await this.setStateAsync(id, { val, ack: true });
      if (command === "power" && val === false) {
        await this.resetModeDropdowns(prefix, "");
      } else {
        await this.resetRelatedDropdowns(prefix, command);
      }
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  /**
   * Resolve a dropdown-state input value against the state's common.states
   * map. Returns the canonical key (always String form) so a user can write
   * either the index ("1"), the index as a number (1) or the label name
   * ("Aurora", case-insensitive) — all three land at the same canonical
   * value for the rest of the handler.
   *
   * Non-dropdown states (no common.states), reset sentinels (0/"0"/"") and
   * non-string/number inputs are passed through unchanged. A dropdown input
   * that doesn't match any key or label returns ok=false so the caller can
   * warn and skip the command.
   *
   * @param id Full state id
   * @param raw Raw input value as provided by the user/script
   */
  async resolveDropdownInput(id, raw) {
    var _a;
    if (raw === null || raw === void 0) {
      return { val: raw, ok: true };
    }
    if (raw === 0 || raw === "0" || raw === "") {
      return { val: raw, ok: true };
    }
    if (typeof raw !== "number" && typeof raw !== "string") {
      return { val: raw, ok: true };
    }
    const obj = await this.getObjectAsync(id);
    const states = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.states;
    if (!states || typeof states !== "object") {
      return { val: raw, ok: true };
    }
    const resolved = (0, import_types.resolveStatesValue)(raw, states);
    if (resolved) {
      return { val: resolved.key, ok: true };
    }
    return { val: raw, ok: false };
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
    if (state.power === false && this.stateManager) {
      const prefix = this.stateManager.devicePrefix(device);
      this.resetModeDropdowns(prefix, "").catch(() => void 0);
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
   * Rebuild state definitions for one device and feed them into StateManager.
   * Used both from the full-list callback and from targeted refreshes
   * (e.g. after a local snapshot was added or removed — no reason to rebuild
   * the entire tree for every device then).
   *
   * @param device Target device
   * @param allDevices Full device list (needed to resolve group members)
   */
  refreshDeviceStates(device, allDevices) {
    var _a;
    if (!this.stateManager) {
      return;
    }
    const localSnaps = (_a = this.localSnapshots) == null ? void 0 : _a.getSnapshots(
      device.sku,
      device.deviceId
    );
    let memberDevices;
    if (device.sku === "BaseGroup" && device.groupMembers) {
      memberDevices = this.resolveGroupMembers(device, allDevices);
    }
    const stateDefs = (0, import_capability_mapper.buildDeviceStateDefs)(device, localSnaps, memberDevices);
    const p = this.stateManager.createDeviceStates(device, stateDefs).catch((e) => {
      this.log.error(
        `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`
      );
    });
    if (!this.statesReady) {
      this.stateCreationQueue.push(p);
    } else {
      void p;
    }
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
      this.refreshDeviceStates(device, devices);
    }
    this.updateConnectionState();
    if (this.statesReady) {
      this.reapStaleDevices().catch(() => void 0);
    }
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
   * Delete ioBroker objects for devices no longer present and drop the same
   * devices from adapter-level maps. Called after the initial-discovery
   * window and every time the device list changes so per-device state
   * (diagnostics throttle, etc.) doesn't outlive the device in the tree.
   */
  async reapStaleDevices() {
    if (!this.stateManager || !this.deviceManager) {
      return;
    }
    const currentDevices = this.deviceManager.getDevices();
    await this.stateManager.cleanupDevices(currentDevices);
    const liveKeys = new Set(
      currentDevices.map((d) => `${d.sku}:${d.deviceId}`)
    );
    for (const key of this.diagnosticsLastRun.keys()) {
      if (!liveKeys.has(key)) {
        this.diagnosticsLastRun.delete(key);
      }
    }
  }
  /**
   * Detect which govee-appliances instances (if any) are running. Subscribes
   * to the whole `system.adapter.govee-appliances.*.alive` namespace so
   * start/stop of any instance feeds back into applySiblingLimits.
   */
  async detectSiblingAdapter() {
    try {
      const instances = await this.getForeignObjectsAsync(
        "system.adapter.govee-appliances.*",
        "instance"
      );
      for (const id of Object.keys(instances != null ? instances : {})) {
        const aliveId = `${id}.alive`;
        const state = await this.getForeignStateAsync(aliveId);
        if ((state == null ? void 0 : state.val) === true) {
          this.siblingInstancesAlive.add(id.replace("system.adapter.", ""));
        }
      }
      this.applySiblingLimits(this.siblingInstancesAlive.size > 0);
      await this.subscribeForeignStatesAsync(SIBLING_ALIVE_PATTERN);
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
    var _a;
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
    (_a = this.deviceManager) == null ? void 0 : _a.saveDevicesToCache();
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
        const writes = [];
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
          writes.push(
            this.setStateAsync(statePath, {
              val: mapped.value,
              ack: true
            }).catch(() => void 0)
          );
        }
        await Promise.all(writes);
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
   * Map state suffix to command name.
   *
   * Simple suffixes live in a lookup table, segment indices need regex
   * extraction because they're dynamic. The three music states all route
   * to the same "music" command — the handler reads sibling values.
   *
   * @param suffix State ID suffix (e.g. "power", "brightness")
   */
  stateToCommand(suffix) {
    const direct = STATE_TO_COMMAND[suffix];
    if (direct) {
      return direct;
    }
    const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
    if (segColorMatch) {
      return `segmentColor:${segColorMatch[1]}`;
    }
    const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
    if (segBrightMatch) {
      return `segmentBrightness:${segBrightMatch[1]}`;
    }
    return null;
  }
  /**
   * Central entry point for manual-segment updates. Sets the device flags,
   * rebuilds the segment tree (which writes manual_mode + manual_list with
   * ack=true), and persists to cache. Both the user state-change handler
   * and the wizard route their final decisions here.
   *
   * @param device Target device
   * @param mode    Whether manual mode should be active
   * @param indices Physical indices when mode=true, ignored otherwise
   */
  async applyManualSegments(device, mode, indices) {
    var _a;
    if (!this.stateManager) {
      return;
    }
    device.manualMode = mode;
    device.manualSegments = mode && Array.isArray(indices) && indices.length > 0 ? indices.slice() : void 0;
    await this.stateManager.createSegmentStates(device);
    (_a = this.deviceManager) == null ? void 0 : _a.persistDeviceToCache(device);
  }
  /**
   * React to manual-segments state changes — parses list, forwards to
   * {@link applyManualSegments}. On parse error disables manual mode so the
   * rejected value doesn't survive in the state tree.
   *
   * @param device Target device
   * @param suffix State suffix (either "segments.manual_mode" or "segments.manual_list")
   * @param newValue Written value
   */
  async handleManualSegmentsChange(device, suffix, newValue) {
    const modeVal = suffix === "segments.manual_mode" ? Boolean(newValue) : device.manualMode === true;
    const listVal = suffix === "segments.manual_list" ? typeof newValue === "string" ? newValue : "" : Array.isArray(device.manualSegments) ? device.manualSegments.join(",") : "";
    if (!modeVal) {
      this.log.info(
        `${device.name}: manual segments disabled \u2014 strip treated as contiguous`
      );
      await this.applyManualSegments(device, false);
      return;
    }
    const maxIndex = typeof device.segmentCount === "number" && device.segmentCount > 0 ? device.segmentCount - 1 : import_device_manager.SEGMENT_HARD_MAX;
    const parsed = (0, import_types.parseSegmentList)(listVal, maxIndex);
    if (parsed.error) {
      this.log.warn(
        `${device.name}: manual_list invalid (${parsed.error}) \u2014 disabling manual mode`
      );
      await this.applyManualSegments(device, false);
      return;
    }
    this.log.info(
      `${device.name}: manual segments active \u2014 ${parsed.indices.length} physical indices (${listVal})`
    );
    await this.applyManualSegments(device, true, parsed.indices);
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
            return d.sku !== "BaseGroup" && ((_a2 = d.state) == null ? void 0 : _a2.online) === true && (0, import_device_manager.resolveSegmentCount)(d) > 0;
          }
        ).map((d) => {
          const count = (0, import_device_manager.resolveSegmentCount)(d);
          return {
            value: this.deviceKeyFor(d),
            label: `${d.name} (${d.sku}, bisher ${count} Segmente)`
          };
        });
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
      sendCommand: async (device, command, value) => {
        var _a;
        await ((_a = this.deviceManager) == null ? void 0 : _a.sendCommand(device, command, value));
      },
      flashSegmentAtomic: (device, idx) => {
        if (!device.lanIp || !this.lanClient) {
          return Promise.resolve(false);
        }
        this.lanClient.flashSingleSegment(device.lanIp, idx);
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
      clearTimeout: (h) => this.clearTimeout(h),
      applyWizardResult: (device, result) => this.applyWizardResult(device, result),
      getLanguage: () => this.adminLanguage
    };
  }
  /**
   * Apply a finished wizard's measurement: set the real segment count, then
   * route through {@link applyManualSegments} so the same state-tree rebuild
   * and cache-persist path runs for both wizard results and user edits.
   *
   * @param device Target device
   * @param result Wizard's measurement
   */
  async applyWizardResult(device, result) {
    device.segmentCount = result.segmentCount;
    if (result.hasGaps) {
      const parsed = (0, import_types.parseSegmentList)(
        result.manualList,
        result.segmentCount - 1
      );
      await this.applyManualSegments(
        device,
        true,
        parsed.error ? void 0 : parsed.indices
      );
    } else {
      await this.applyManualSegments(device, false);
    }
    this.log.debug(
      `applyWizardResult: ${device.sku} \u2192 segmentCount=${result.segmentCount}, manualMode=${device.manualMode}, list="${result.manualList}"`
    );
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
    const [powerState, brightState, colorState, ctState] = await Promise.all([
      this.getStateAsync(`${ns}.${prefix}.control.power`),
      this.getStateAsync(`${ns}.${prefix}.control.brightness`),
      this.getStateAsync(`${ns}.${prefix}.control.colorRgb`),
      this.getStateAsync(`${ns}.${prefix}.control.colorTemperature`)
    ]);
    let segments;
    const segCount = (_a = device.segmentCount) != null ? _a : 0;
    if (segCount > 0) {
      const segReads = [];
      for (let i = 0; i < segCount; i++) {
        segReads.push(
          Promise.all([
            this.getStateAsync(`${ns}.${prefix}.segments.${i}.color`),
            this.getStateAsync(`${ns}.${prefix}.segments.${i}.brightness`)
          ])
        );
      }
      const segResults = await Promise.all(segReads);
      segments = segResults.map(([segColor, segBright]) => ({
        color: typeof (segColor == null ? void 0 : segColor.val) === "string" ? segColor.val : "#000000",
        brightness: typeof (segBright == null ? void 0 : segBright.val) === "number" ? segBright.val : 100
      }));
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
    this.refreshDeviceStates(device, this.deviceManager.getDevices());
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
      this.refreshDeviceStates(device, this.deviceManager.getDevices());
    } else {
      this.log.warn(`Local snapshot "${name}" not found for ${device.name}`);
    }
  }
  /** Dropdowns whose value is a mode-selection — reset to "---" (0) when the mode stops. */
  static MODE_DROPDOWNS = [
    "scenes.light_scene",
    "scenes.diy_scene",
    "snapshots.snapshot_cloud",
    "snapshots.snapshot_local",
    "music.music_mode"
  ];
  /** Map command → its own dropdown path (excluded from reset when that mode is the one that was just activated). */
  static COMMAND_DROPDOWN = {
    lightScene: "scenes.light_scene",
    diyScene: "scenes.diy_scene",
    snapshot: "snapshots.snapshot_cloud",
    snapshotLocal: "snapshots.snapshot_local",
    music: "music.music_mode",
    colorRgb: "",
    colorTemperature: ""
  };
  /**
   * Reset related dropdown states when switching between scenes/snapshots/colors.
   * Each mode-switch resets all OTHER mode dropdowns to "---" (0).
   *
   * @param prefix Device state prefix
   * @param activeCommand The command that was just executed
   */
  async resetRelatedDropdowns(prefix, activeCommand) {
    if (!(activeCommand in GoveeAdapter.COMMAND_DROPDOWN)) {
      return;
    }
    const ownDropdown = GoveeAdapter.COMMAND_DROPDOWN[activeCommand];
    await this.resetModeDropdowns(prefix, ownDropdown);
  }
  /**
   * Reset every mode dropdown except `keep` (empty = reset all). Used both for
   * mode-switches (keep the new mode's own dropdown) and for power-off
   * (reset everything — a device that's off has no active mode).
   *
   * @param prefix Device state prefix
   * @param keep   Dropdown path to leave untouched (e.g. "music.music_mode"), or "" to reset all
   */
  async resetModeDropdowns(prefix, keep) {
    await Promise.all(
      GoveeAdapter.MODE_DROPDOWNS.filter((d) => d !== keep).map(
        async (dropdown) => {
          const stateId = `${this.namespace}.${prefix}.${dropdown}`;
          const current = await this.getStateAsync(stateId);
          if ((current == null ? void 0 : current.val) && current.val !== "0" && current.val !== 0) {
            await this.setStateAsync(stateId, { val: "0", ack: true });
          }
        }
      )
    );
  }
}
if (require.main !== module) {
  module.exports = (options) => new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
//# sourceMappingURL=main.js.map
