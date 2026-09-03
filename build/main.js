"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  GoveeAdapter: () => GoveeAdapter
});
module.exports = __toCommonJS(main_exports);
var import_adapter_core = require("@iobroker/adapter-core");
var utils = __toESM(require("@iobroker/adapter-core"));
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var import_actionable_problems = require("./lib/actionable-problems");
var import_device_registry = require("./lib/device-registry");
var import_device_manager = require("./lib/device-manager");
var import_lookups = require("./lib/device-manager/lookups");
var import_govee_api_client = require("./lib/govee-api-client");
var import_govee_cloud_client = require("./lib/govee-cloud-client");
var import_govee_lan_client = require("./lib/govee-lan-client");
var import_govee_mqtt_client = require("./lib/govee-mqtt-client");
var import_govee_openapi_mqtt_client = require("./lib/govee-openapi-mqtt-client");
var import_local_snapshots = require("./lib/local-snapshots");
var import_log_prefix = require("./lib/log-prefix");
var import_snapshot_handler = require("./lib/snapshot-handler");
var import_group_fanout = require("./lib/group-fanout");
var import_message_router = require("./lib/message-router");
var cloudCreds = __toESM(require("./lib/handlers/cloud-creds-handler"));
var cloudRetryHandler = __toESM(require("./lib/handlers/cloud-retry-handler"));
var cloudStateLoader = __toESM(require("./lib/handlers/cloud-state-loader"));
var connectionState = __toESM(require("./lib/handlers/connection-state"));
var deviceEvents = __toESM(require("./lib/handlers/device-events"));
var groupFanoutHandler = __toESM(require("./lib/handlers/group-fanout-handler"));
var dropdownReset = __toESM(require("./lib/handlers/dropdown-reset-helpers"));
var snapshotHandlerGlue = __toESM(require("./lib/handlers/snapshot-handler-glue"));
var stateChangeRouter = __toESM(require("./lib/handlers/state-change-router"));
var wizardHandler = __toESM(require("./lib/handlers/wizard-handler"));
var import_rate_limiter = require("./lib/rate-limiter");
var import_i18n = require("./lib/i18n");
var import_sku_cache = require("./lib/sku-cache");
var import_state_manager = require("./lib/state-manager");
var import_types = require("./lib/types");
var import_timing_constants = require("./lib/timing-constants");
function physicalSegmentCap(device) {
  return typeof device.segmentCount === "number" && device.segmentCount > 0 ? device.segmentCount : 0;
}
class GoveeAdapter extends utils.Adapter {
  // ── Test seams ────────────────────────────────────────────────────────────
  // Network-facing collaborators are built through overridable factory fields
  // instead of inline `new` calls, so the orchestration tests can drive onReady
  // without sockets, TLS or a live Govee account. The state-facing ones
  // (StateManager, DeviceManager, SkuCache, LocalSnapshotStore) deliberately
  // run FOR REAL against the stub adapter — that is what makes the state-tree
  // assertions meaningful (hassemu hybrid pattern). Production behaviour is
  // unchanged: every default is the same constructor call as before.
  /**
   * @param log Adapter logger forwarded to the LAN client
   * @param timers Adapter timer wrapper
   */
  makeLanClient = (log, timers) => new import_govee_lan_client.GoveeLanClient(log, timers);
  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   */
  makeMqttClient = (email, password, log, timers) => new import_govee_mqtt_client.GoveeMqttClient(email, password, log, timers);
  /**
   * @param apiKey Govee Cloud API key
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   */
  makeOpenapiMqttClient = (apiKey, log, timers) => new import_govee_openapi_mqtt_client.GoveeOpenapiMqttClient(apiKey, log, timers);
  /**
   * @param apiKey Govee Cloud API key
   * @param log Adapter logger
   */
  makeCloudClient = (apiKey, log) => new import_govee_cloud_client.GoveeCloudClient(apiKey, log);
  /** @param log Adapter logger */
  makeApiClient = (log) => new import_govee_api_client.GoveeApiClient(log);
  /**
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   * @param perMinute Per-minute Cloud budget
   * @param perDay Per-day Cloud budget
   */
  makeRateLimiter = (log, timers, perMinute, perDay) => new import_rate_limiter.RateLimiter(log, timers, perMinute, perDay);
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * This instance's device catalog (devices.json filtered by the instance's
   * own `experimentalQuirks` setting). Built first in onReady and handed to
   * every module that applies quirks — never a module-level value, because in
   * compact mode several instances share one process and the last one to
   * start would otherwise decide the experimental toggle for all of them.
   */
  deviceRegistry;
  deviceManager = null;
  stateManager = null;
  lanClient = null;
  mqttClient = null;
  openapiMqttClient = null;
  /** Registry surfacing user-actionable problems (verification, credentials). */
  actionableProblems;
  cloudClient = null;
  /** Shared Cloud budget — the cloud-state loader budgets its /device/state calls on it too. */
  rateLimiter = null;
  /** Repeating timer for the App-API poll (sensor-state pull). */
  appApiPollTimer;
  /**
   * One-shot timer for the FIRST app-api poll (5s after start) — kept as a
   * handle so onUnload can clear it before it fires into the void.
   */
  appApiInitialTimer;
  /** One-shot timer for the cloud-init 60 s safety timeout — same pattern; armed by the cloud-retry handler. */
  cloudInitTimer;
  /**
   * Last info.connection value — cached so not every device update issues an
   * unnecessary setState (H4). Maintained by the connection-state handler.
   */
  lastConnectionState = null;
  // === Lifecycle flags (adapter boot sequence) ===
  // checkAllReady() checks all 5 preconditions at once — they run in parallel,
  // not a linear STATE_MACHINE pattern, because the channels connect
  // independently.
  /** The initial LAN-scan wait has elapsed. */
  lanScanDone = false;
  /** The initial state tree has been built. */
  statesReady = false;
  /** The Cloud init phase has finished. */
  cloudInitDone = false;
  /** The first App-API poll has completed. */
  appApiInitialPollDone = false;
  /** Guard so the "ready" summary is logged once. */
  readyLogged = false;
  /** Cloud was connected at least once — for the "restored" log after a down. */
  cloudWasConnected = false;
  /**
   * js-controller and admin versions, read once at start. The diagnostics
   * report states them, and a bug report without them costs one round-trip
   * every time. Read once rather than per export: they cannot change while the
   * process runs — a controller or admin update restarts every instance.
   */
  hostVersions = {};
  /** Daily interval for the app-version-drift check against the app store. */
  appVersionCheckTimer;
  /**
   * 20 s Timer that re-evaluates `info.online` for every device via
   * StateManager.syncInfoOnline. Drives the offline-transition for Lights
   * (TTL-based on lastLanReplyAt) and the no-op write-suppression for all
   * devices. Cleared synchronously in onUnload.
   */
  onlineSyncTimer;
  // === Sub-Komponenten ===
  skuCache = null;
  localSnapshots = null;
  snapshotHandler = null;
  groupFanout = null;
  messageRouter = null;
  /** Current channel status — pulled by the log-prefix wrapper on every log call. */
  channelStatus = { lan: "n/a", cloud: "n/a", mqtt: "n/a", openapi: "n/a" };
  /** State-creation promises queued by the device-events handler until the initial tree is ready. */
  stateCreationQueue = [];
  lanScanTimer;
  cleanupTimer;
  readyTimer;
  /** Undefined until the cloud-retry handler's first ensureCloudRetry() call. */
  cloudRetry;
  /** Lazily instantiated by the wizard handler's `runWizardStep`. */
  segmentWizard = null;
  /** Per-device timestamp of the last diagnostics export — throttle gate. */
  diagnosticsLastRun = /* @__PURE__ */ new Map();
  /**
   * Set true at the start of onUnload — async paths (onStateChange,
   * applyCloudCapabilities, retrySceneData, …) check this between awaits
   * and bail before further setState against a torn-down adapter.
   */
  unloading = false;
  /** The handler-facing view of this adapter — see {@link AdapterHost}. */
  handlerHost;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "govee-smart" });
    this.handlerHost = this.buildHost();
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Build the handler-facing view over the private runtime. Accessors, not
   * copies: every member reads (and, where a handler owns the value, writes)
   * the live field, so the handlers see exactly what the adapter sees.
   */
  buildHost() {
    const host = {};
    const read = (key, get) => {
      Object.defineProperty(host, key, { get, enumerable: true });
    };
    const readWrite = (key, get, set) => {
      Object.defineProperty(host, key, { get, set, enumerable: true });
    };
    const method = (key, fn) => {
      Object.defineProperty(host, key, { value: fn, enumerable: true });
    };
    read("log", () => this.log);
    read("namespace", () => this.namespace);
    read("version", () => this.version);
    read("config", () => this.config);
    method("setState", (id, state) => this.setState(id, state));
    method("getStateAsync", (id) => this.getStateAsync(id));
    method("getObjectAsync", (id) => this.getObjectAsync(id));
    method("getForeignObjectAsync", (id) => this.getForeignObjectAsync(id));
    method(
      "extendForeignObjectAsync",
      (id, obj) => this.extendForeignObjectAsync(id, obj)
    );
    method("readFileAsync", (meta, name) => this.readFileAsync(meta, name));
    method("delFileAsync", (meta, name) => this.delFileAsync(meta, name));
    method("delObjectAsync", (id) => this.delObjectAsync(id));
    method("encrypt", (value) => this.encrypt(value));
    method("decrypt", (value) => this.decrypt(value));
    method("setTimeout", (cb, ms) => this.setTimeout(cb, ms));
    method("clearTimeout", (h) => this.clearTimeout(h));
    read("deviceRegistry", () => this.deviceRegistry);
    read("deviceManager", () => this.deviceManager);
    read("stateManager", () => this.stateManager);
    read("lanClient", () => this.lanClient);
    read("mqttClient", () => this.mqttClient);
    read("openapiMqttClient", () => this.openapiMqttClient);
    read("cloudClient", () => this.cloudClient);
    read("rateLimiter", () => this.rateLimiter);
    read("localSnapshots", () => this.localSnapshots);
    read("snapshotHandler", () => this.snapshotHandler);
    read("groupFanout", () => this.groupFanout);
    read("actionableProblems", () => this.actionableProblems);
    read("diagnosticsLastRun", () => this.diagnosticsLastRun);
    read("stateCreationQueue", () => this.stateCreationQueue);
    read("channelStatus", () => this.channelStatus);
    read("lanScanDone", () => this.lanScanDone);
    read("statesReady", () => this.statesReady);
    read("cloudInitDone", () => this.cloudInitDone);
    read("appApiInitialPollDone", () => this.appApiInitialPollDone);
    read("unloading", () => this.unloading);
    readWrite(
      "readyLogged",
      () => this.readyLogged,
      (v) => this.readyLogged = v
    );
    readWrite(
      "lastConnectionState",
      () => this.lastConnectionState,
      (v) => this.lastConnectionState = v
    );
    readWrite(
      "cloudWasConnected",
      () => this.cloudWasConnected,
      (v) => this.cloudWasConnected = v
    );
    readWrite(
      "cloudInitTimer",
      () => this.cloudInitTimer,
      (v) => this.cloudInitTimer = v
    );
    readWrite(
      "cloudRetry",
      () => this.cloudRetry,
      (v) => this.cloudRetry = v
    );
    readWrite(
      "segmentWizard",
      () => this.segmentWizard,
      (v) => this.segmentWizard = v
    );
    method("loadCloudStates", (only) => this.loadCloudStates(only));
    method(
      "applyManualSegments",
      (device, mode, indices) => this.applyManualSegments(device, mode, indices)
    );
    method("syncDevicesManually", () => this.syncDevicesManually());
    method("reapStaleDevices", () => this.reapStaleDevices());
    method("stateToCommand", (suffix) => dropdownReset.stateToCommand(suffix));
    method(
      "sendMusicCommand",
      (device, prefix, suffix, value) => stateChangeRouter.sendMusicCommand(host, device, prefix, suffix, value)
    );
    method(
      "fireCloudDataReady",
      (device, allDevices) => deviceEvents.onCloudDataReady(host, device, allDevices)
    );
    return host;
  }
  /**
   * Clear a leftover `supportedMessages.stopInstance` from THIS instance's object.
   *
   * The entry lives in two places: in the adapter's manifest, and as a copy in the
   * instance object in the database. An update merges the manifest into that copy —
   * it never removes a field. Without this correction the host keeps killing the
   * process outright on every installation that ever ran a version carrying the
   * entry, `onUnload` never runs, and every state written there is dead code.
   *
   * Writing the instance object makes the host restart this instance once — that is
   * the price, and it happens exactly once because the condition is false afterwards.
   *
   * @returns true when the correction was written and the restart is coming; the
   *   caller has to stop right there, or it arms timers of a process the host is
   *   already shutting down.
   */
  async clearStopInstanceFlag() {
    var _a;
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.supportedMessages;
      if (!(supported == null ? void 0 : supported.stopInstance)) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version \u2014 this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: { stopInstance: false } } });
      return true;
    } catch (e) {
      this.log.debug(`Could not check the instance object: ${(0, import_types.errMessage)(e)}`);
      return false;
    }
  }
  async onReady() {
    var _a, _b, _c, _d, _e;
    try {
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      await import_adapter_core.I18n.init(path.join(this.adapterDir, "admin"), this);
      await this.readHostVersions();
      const config = this.config;
      void connectionState.refreshLiveAppVersion(this.handlerHost).catch((e) => this.log.debug(`App version refresh error: ${(0, import_types.errMessage)(e)}`));
      await this.delObjectAsync("info.refresh_cloud_data").catch(() => void 0);
      await this.delObjectAsync("info.manual_sync_devices").catch(() => void 0);
      await this.delObjectAsync("info.appVersionDrift").catch(() => void 0);
      await this.delObjectAsync("info.wizardStatus").catch(() => void 0);
      await cloudCreds.migrateCredentialsMetaOnce(this.handlerHost, utils.getAbsoluteInstanceDataDir(this));
      if (config.apiKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.apiKey)) {
        this.log.error(
          "The Govee API key does not look like a valid key (expected UUID format like 12345678-1234-1234-1234-123456789abc) \u2014 check for typos or copied whitespace in the adapter settings. If this appeared right after upgrading a very old install (v2.11.0 encryption migration), re-enter the API key, Govee password and verification code once."
        );
      }
      const accountEmail = ((_a = config.goveeEmail) != null ? _a : "").trim();
      const hasAccountCreds = !!(accountEmail && ((_b = config.goveePassword) == null ? void 0 : _b.trim()));
      this.channelStatus = {
        lan: "off",
        // LAN listener always exists; flips to "on" after first discovery
        cloud: config.apiKey ? "off" : "n/a",
        mqtt: hasAccountCreds ? "off" : "n/a",
        openapi: config.apiKey ? "off" : "n/a"
      };
      (0, import_log_prefix.installLogPrefix)(this.log, () => this.channelStatus);
      this.actionableProblems = new import_actionable_problems.ActionableProblems({
        logWarn: (m) => this.log.warn(m),
        logInfo: (m) => this.log.info(m),
        notify: (m) => this.registerNotification("govee-smart", "userActionRequired", m).catch(
          (e) => this.log.debug(`Could not raise notification: ${(0, import_types.errMessage)(e)}`)
        )
      });
      await this.setState("info.connection", { val: false, ack: true });
      await this.setState("info.mqttConnected", { val: false, ack: true });
      await this.setState("info.cloudConnected", { val: false, ack: true });
      await this.setState("info.openapiMqttConnected", {
        val: false,
        ack: true
      });
      await this.setState("info.verificationPending", { val: false, ack: true });
      this.deviceRegistry = new import_device_registry.DeviceRegistry({
        experimental: config.experimentalQuirks === true,
        log: this.log
      });
      this.stateManager = new import_state_manager.StateManager(this, this.deviceRegistry);
      this.stateManager.setCloudOnlineProvider(() => this.cloudWasConnected);
      await this.stateManager.markAllOffline().catch(() => void 0);
      await this.stateManager.cleanupSameModeGroupOrphansOnce().catch(() => void 0);
      await this.stateManager.createGroupsOnlineState(false);
      this.deviceManager = new import_device_manager.DeviceManager(this.log, this, this.deviceRegistry);
      const dataDir = utils.getAbsoluteInstanceDataDir(this);
      this.skuCache = new import_sku_cache.SkuCache(dataDir, this.log);
      await this.migrateLocalSnapshotsToMetaUser(dataDir);
      this.localSnapshots = new import_local_snapshots.LocalSnapshotStore(this, this.log);
      await this.localSnapshots.init();
      this.snapshotHandler = new import_snapshot_handler.SnapshotHandler(snapshotHandlerGlue.buildSnapshotHost(this.handlerHost));
      this.groupFanout = new import_group_fanout.GroupFanoutHandler(groupFanoutHandler.buildGroupFanoutHost(this.handlerHost));
      this.messageRouter = new import_message_router.MessageRouter(this.buildMessageRouterHost());
      this.deviceManager.setSkuCache(this.skuCache);
      const diag = this.deviceManager.getDiagnostics();
      diag.setCacheSnapshotProvider((sku, deviceId) => {
        var _a2, _b2;
        return (_b2 = (_a2 = this.skuCache) == null ? void 0 : _a2.loadOne(sku, deviceId)) != null ? _b2 : null;
      });
      diag.setLocalSnapshotsProvider((sku, deviceId) => {
        var _a2, _b2;
        return (_b2 = (_a2 = this.localSnapshots) == null ? void 0 : _a2.getSnapshots(sku, deviceId)) != null ? _b2 : [];
      });
      diag.setRuntimeStateProvider(() => {
        var _a2, _b2, _c2, _d2, _e2, _f, _g, _h, _i, _j, _k, _l, _m, _n;
        const errorCats = (_a2 = this.deviceManager) == null ? void 0 : _a2.getErrorCategorySnapshot();
        return {
          deviceManagerLastErrorCategory: (_b2 = errorCats == null ? void 0 : errorCats.deviceManager) != null ? _b2 : null,
          appApiLastErrorCategory: (_c2 = errorCats == null ? void 0 : errorCats.appApi) != null ? _c2 : null,
          groupMembersLastErrorCategory: (_d2 = errorCats == null ? void 0 : errorCats.groupMembers) != null ? _d2 : null,
          cloudFailureReason: (_f = (_e2 = this.cloudClient) == null ? void 0 : _e2.getFailureReason()) != null ? _f : null,
          mqttFailureReason: (_h = (_g = this.mqttClient) == null ? void 0 : _g.getFailureReason()) != null ? _h : null,
          rateLimiter: (_j = (_i = this.rateLimiter) == null ? void 0 : _i.getUsageSnapshot()) != null ? _j : null,
          wizardSession: (_l = (_k = this.segmentWizard) == null ? void 0 : _k.getSessionSnapshot()) != null ? _l : null,
          lanSeenDeviceIps: (_n = (_m = this.lanClient) == null ? void 0 : _m.getDiagSnapshot().seenDeviceIps) != null ? _n : []
        };
      });
      diag.setDeviceNamesProvider(() => {
        var _a2, _b2;
        return (_b2 = (_a2 = this.deviceManager) == null ? void 0 : _a2.getDevices().map((d) => d.name)) != null ? _b2 : [];
      });
      diag.setEnvironmentProvider(() => {
        var _a2, _b2, _c2;
        const devices = (_b2 = (_a2 = this.deviceManager) == null ? void 0 : _a2.getDevices()) != null ? _b2 : [];
        return {
          node: process.version,
          jsController: this.hostVersions.jsController,
          admin: this.hostVersions.admin,
          platform: `${process.platform} ${process.arch}`,
          compactMode: ((_c2 = this.common) == null ? void 0 : _c2.compact) === true,
          credentialTier: this.mqttClient ? "account" : this.cloudClient ? "apiKey" : "lan",
          deviceCount: devices.length,
          reachableCount: devices.filter((d) => (0, import_lookups.resolveDeviceReachability)(d, this.cloudWasConnected).online).length,
          channels: { ...this.channelStatus }
        };
      });
      diag.setObjectTreeProvider((prefix) => this.readObjectTree(prefix));
      const apiClient = this.makeApiClient(this.log);
      apiClient.setEmail(accountEmail);
      this.deviceManager.setApiClient(apiClient);
      this.deviceManager.setCallbacks({
        onUpdate: (device, state) => deviceEvents.onDeviceStateUpdate(this.handlerHost, device, state),
        onLanDeviceReady: (device, allDevices) => deviceEvents.onLanDeviceReady(this.handlerHost, device, allDevices),
        onCloudDataReady: (device, allDevices) => deviceEvents.onCloudDataReady(this.handlerHost, device, allDevices),
        onGroupMembersReady: (group, allDevices) => deviceEvents.onGroupMembersReady(this.handlerHost, group, allDevices)
      });
      this.deviceManager.onDevicesRemoved = () => {
        void this.reapStaleDevices().catch((e) => this.log.debug(`Post-eviction cleanup failed: ${(0, import_types.errMessage)(e)}`));
      };
      this.deviceManager.onLanIpChanged = (device, ip) => {
        if (device.gateway) {
          return;
        }
        const prefix = this.stateManager.devicePrefix(device);
        this.setState(`${prefix}.info.ip`, { val: ip, ack: true }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
      };
      this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
        const prefix = this.stateManager.devicePrefix(device);
        const cap = physicalSegmentCap(device);
        for (const idx of batch.segments) {
          if (cap === 0 || idx >= cap) {
            continue;
          }
          if (batch.color !== void 0) {
            const hex = (0, import_types.rgbIntToHex)(batch.color);
            this.setState(`${prefix}.segments.${idx}.color`, {
              val: hex,
              ack: true
            }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
          }
          if (batch.brightness !== void 0) {
            this.setState(`${prefix}.segments.${idx}.brightness`, {
              val: batch.brightness,
              ack: true
            }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
          }
        }
      };
      this.deviceManager.onMqttSegmentUpdate = (device, segments) => {
        const prefix = this.stateManager.devicePrefix(device);
        const cap = physicalSegmentCap(device);
        for (const seg of segments) {
          if (cap === 0 || seg.index >= cap) {
            continue;
          }
          this.setState(`${prefix}.segments.${seg.index}.color`, {
            val: (0, import_types.rgbToHex)(seg.r, seg.g, seg.b),
            ack: true
          }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
          this.setState(`${prefix}.segments.${seg.index}.brightness`, {
            val: seg.brightness,
            ack: true
          }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
        }
      };
      this.deviceManager.onSegmentCountChanged = (device) => {
        if (!this.stateManager || !this.deviceManager) {
          return;
        }
        this.stateManager.createSegmentStates(device, this.deviceManager.syncSegmentCount(device)).catch((e) => {
          this.log.warn(
            `Failed to rebuild segment tree for ${(0, import_types.deviceLabel)(device)} after count change: ${(0, import_types.errMessage)(e)}`
          );
        });
      };
      const startChannels = ["LAN"];
      if (config.apiKey) {
        startChannels.push("Cloud");
      }
      if (hasAccountCreds) {
        startChannels.push("MQTT");
      }
      this.log.info(
        `Starting (${startChannels.join(", ")}) \u2014 please wait, a "ready" message will follow when all channels are up`
      );
      this.lanClient = this.makeLanClient(this.log, this);
      this.deviceManager.setLanClient(this.lanClient);
      this.lanClient.onInterfaceError = (message) => {
        this.actionableProblems.report({
          key: "lan-interface",
          title: "LAN unavailable on the selected network interface",
          action: message
        });
      };
      this.lanClient.onListenReady = () => {
        this.actionableProblems.resolve("lan-interface", "LAN listening on the selected network interface");
      };
      this.lanClient.setSendHook((ip, cmd, payload, bytes, error) => {
        var _a2;
        const dev = (_a2 = this.deviceManager) == null ? void 0 : _a2.getDevices().find((d) => d.lanIp === ip);
        if (!dev) {
          return;
        }
        this.deviceManager.getDiagnostics().addLanSend(dev.deviceId, ip, cmd, payload, bytes, error);
      });
      this.lanClient.setStatusRecordHook((ip, status) => {
        var _a2;
        const dev = (_a2 = this.deviceManager) == null ? void 0 : _a2.getDevices().find((d) => d.lanIp === ip);
        if (!dev) {
          return;
        }
        this.deviceManager.getDiagnostics().recordApiSuccess(dev.deviceId, "lan://devStatus", status);
      });
      this.lanClient.setScanRecordHook((lanDevice) => {
        var _a2;
        (_a2 = this.deviceManager) == null ? void 0 : _a2.getDiagnostics().addLog(lanDevice.device, "debug", `LAN scan reply: ip=${lanDevice.ip} sku=${lanDevice.sku}`);
      });
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
        import_timing_constants.LAN_SCAN_INTERVAL_MS,
        config.networkInterface || ""
      );
      this.lanScanTimer = this.setTimeout(() => {
        this.lanScanDone = true;
        if (this.deviceManager) {
          this.deviceManager.accountReconcileEnabled = true;
        }
        connectionState.checkAllReady(this.handlerHost);
      }, import_timing_constants.LAN_SCAN_INITIAL_WAIT_MS);
      if (hasAccountCreds) {
        this.mqttClient = this.makeMqttClient(accountEmail, config.goveePassword, this.log, this);
        this.mqttClient.setPacketHook((deviceId, topic, payload) => {
          var _a2;
          (_a2 = this.deviceManager) == null ? void 0 : _a2.getDiagnostics().addMqttPacket(deviceId, topic, payload);
        });
        this.mqttClient.setVerificationCode((_c = config.mqttVerificationCode) != null ? _c : "");
        this.mqttClient.setOnVerificationConsumed(() => {
          cloudCreds.clearVerificationCodeSetting(this.handlerHost).catch((e) => {
            this.log.warn(`Could not clear mqttVerificationCode: ${(0, import_types.errMessage)(e)}`);
          });
        });
        this.mqttClient.setOnVerificationFailed((reason) => {
          this.setState("info.verificationPending", { val: true, ack: true }).catch(
            (0, import_types.logRejected)(this.log, "best-effort write")
          );
          if (reason === "failed") {
            cloudCreds.clearVerificationCodeSetting(this.handlerHost).catch((0, import_types.logRejected)(this.log, "clear the verification code setting"));
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee rejected the verification code for real-time status",
              action: "open the adapter settings \u2014 the connection card requests a fresh code; enter the one Govee e-mails you"
            });
          } else {
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee requires a verification code to enable real-time status (lights/sensors stay readable)",
              action: "open the adapter settings \u2014 the connection card requests a code and takes the one Govee e-mails you"
            });
          }
        });
        this.mqttClient.setOnAuthFailed(() => {
          this.actionableProblems.report({
            key: "mqtt-auth",
            title: "Govee rejected the account login for real-time status",
            action: "check the Govee email and password in the adapter settings (connection card)"
          });
        });
        this.mqttClient.setOnLoginBlocked(() => {
          this.actionableProblems.report({
            key: "mqtt-login-blocked",
            title: "Govee stopped accepting the account login for real-time status",
            action: "Govee rejected repeated login attempts (the account may be temporarily locked). Automatic retries are stopped \u2014 check your Govee account, then restart the adapter"
          });
        });
        await cloudCreds.cleanupLegacyMqttNativeOnce(this.handlerHost);
        const cachedCreds = await cloudCreds.loadPersistedCreds(this.handlerHost, dataDir);
        if (cachedCreds) {
          this.mqttClient.setPersistedCredentials(cachedCreds);
        }
        this.mqttClient.setOnCredentialsRefresh((creds) => {
          cloudCreds.persistCreds(this.handlerHost, dataDir, creds).catch((e) => {
            this.log.warn(`Could not persist MQTT credentials: ${(0, import_types.errMessage)(e)}`);
          });
        });
        await this.mqttClient.connect(
          (update) => this.deviceManager.handleMqttStatus(update),
          (connected) => {
            this.setState("info.mqttConnected", {
              val: connected,
              ack: true
            }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
            if (connected) {
              this.actionableProblems.resolve(
                "mqtt-verification",
                "Govee real-time status connected \u2014 verification accepted"
              );
              this.actionableProblems.resolve("mqtt-auth", "Govee account login accepted");
              this.actionableProblems.resolve("mqtt-login-blocked", "Govee account login accepted");
              this.setState("info.verificationPending", { val: false, ack: true }).catch(
                (0, import_types.logRejected)(this.log, "best-effort write")
              );
              connectionState.checkAllReady(this.handlerHost);
            }
            connectionState.updateConnectionState(this.handlerHost);
          },
          // Forward every fresh bearer token — fires on initial login and on
          // each reconnect-login, so the API client never runs with a stale one.
          (token) => apiClient.setBearerToken(token)
        );
      }
      const cachedOk = this.deviceManager.loadFromCache();
      if (config.apiKey) {
        this.cloudClient = this.makeCloudClient(config.apiKey, this.log);
        this.cloudClient.setResponseHook((deviceId, endpoint, body) => {
          var _a2;
          (_a2 = this.deviceManager) == null ? void 0 : _a2.getDiagnostics().recordApiSuccess(deviceId, endpoint, body);
        });
        this.deviceManager.setCloudClient(this.cloudClient);
        this.deviceManager.setOnCloudCapabilities((device, caps) => {
          cloudStateLoader.applyCloudCapabilities(this.handlerHost, device, caps).catch((e) => this.log.warn(`applyCloudCapabilities failed for ${device.sku}: ${(0, import_types.errMessage)(e)}`));
        });
        this.rateLimiter = this.makeRateLimiter(this.log, this, import_timing_constants.CLOUD_FULL_LIMITS.perMinute, import_timing_constants.CLOUD_FULL_LIMITS.perDay);
        this.rateLimiter.start();
        this.deviceManager.setRateLimiter(this.rateLimiter);
        this.openapiMqttClient = this.makeOpenapiMqttClient(config.apiKey, this.log, this);
        this.openapiMqttClient.connect(
          (event) => {
            var _a2;
            return (_a2 = this.deviceManager) == null ? void 0 : _a2.handleOpenApiEvent(event);
          },
          (connected) => {
            this.setState("info.openapiMqttConnected", {
              val: connected,
              ack: true
            }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
            if (connected) {
              connectionState.checkAllReady(this.handlerHost);
            }
          },
          // v2.9.1 — raw payload hook. Cloud-events MQTT topic is account-wide
          // (`GA/<apiKey>`), payload carries `sku`/`device`. Parse here so the
          // raw envelope lands per-device in the diag (same model as AWS-IoT).
          // Account-level bucket would have meant a new diag struct; per-device
          // keeps shape consistent with all other capture paths.
          (rawJson) => {
            if (!this.deviceManager) {
              return;
            }
            try {
              const parsed = JSON.parse(rawJson);
              if (typeof (parsed == null ? void 0 : parsed.device) === "string" && parsed.device) {
                this.deviceManager.getDiagnostics().addMqttPacket(parsed.device, "openapi-events", { rawJson });
              }
            } catch {
            }
          }
        );
        const triggerAppApiPoll = () => {
          var _a2;
          (_a2 = this.deviceManager) == null ? void 0 : _a2.pollAppApi().then(() => {
            if (!this.appApiInitialPollDone) {
              this.appApiInitialPollDone = true;
              connectionState.checkAllReady(this.handlerHost);
            }
          }).catch((e) => this.log.debug(`pollAppApi failed: ${(0, import_types.errMessage)(e)}`));
        };
        this.appApiPollTimer = this.setInterval(triggerAppApiPoll, import_timing_constants.APP_API_POLL_INTERVAL_MS);
        this.appApiInitialTimer = this.setTimeout(triggerAppApiPoll, import_timing_constants.APP_API_INITIAL_DELAY_MS);
        if (!cachedOk) {
          const result = await cloudRetryHandler.cloudInitWithTimeout(this.handlerHost);
          this.cloudWasConnected = result.ok;
          cloudRetryHandler.ensureCloudRetry(this.handlerHost).setConnected(result.ok);
          this.setState("info.cloudConnected", {
            val: result.ok,
            ack: true
          }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
          (_d = this.stateManager) == null ? void 0 : _d.updateGroupsOnline(result.ok).catch((0, import_types.logRejected)(this.log, "write groups.info.online"));
          if (result.ok) {
            await cloudStateLoader.loadCloudStates(this.handlerHost);
          } else {
            cloudRetryHandler.handleCloudFailure(this.handlerHost, result);
          }
        } else {
          this.log.debug(`Using cached device data \u2014 no Cloud calls needed`);
          this.cloudWasConnected = true;
          cloudRetryHandler.ensureCloudRetry(this.handlerHost).setConnected(true);
          this.setState("info.cloudConnected", {
            val: true,
            ack: true
          }).catch((0, import_types.logRejected)(this.log, "best-effort write"));
          (_e = this.stateManager) == null ? void 0 : _e.updateGroupsOnline(true).catch((0, import_types.logRejected)(this.log, "write groups.info.online"));
        }
        await this.deviceManager.loadGroupMembers();
        this.cloudInitDone = true;
      }
      while (this.stateCreationQueue.length > 0) {
        const pending = this.stateCreationQueue;
        this.stateCreationQueue = [];
        await Promise.all(pending);
      }
      if (this.stateManager && this.deviceManager) {
        for (const device of this.deviceManager.getDevices()) {
          if (device.lanIp && device.capabilities.length === 0) {
            const prefix = this.stateManager.devicePrefix(device);
            const deleted = await this.stateManager.cleanupCloudOwnedStates(prefix, []).catch((e) => {
              this.log.debug(`Legacy cloud-state cleanup failed for ${(0, import_types.deviceLabel)(device)}: ${(0, import_types.errMessage)(e)}`);
              return 0;
            });
            if (deleted > 0) {
              this.log.info(`Removed ${deleted} legacy cloud-owned state(s) for ${(0, import_types.deviceLabel)(device)} (pure-LAN)`);
            }
          }
        }
        for (const device of this.deviceManager.getDevices()) {
          await this.stateManager.migrateLegacyColorStateIds(device).catch((e) => {
            this.log.debug(`B2 colour-state migration failed for ${(0, import_types.deviceLabel)(device)}: ${(0, import_types.errMessage)(e)}`);
          });
        }
      }
      this.statesReady = true;
      await this.subscribeStatesAsync("devices.*");
      await this.subscribeStatesAsync("groups.*");
      await this.subscribeStatesAsync("info.manualSyncDevices");
      this.cleanupTimer = this.setTimeout(() => {
        connectionState.reapStaleDevices(this.handlerHost).catch((e) => this.log.debug(`Device cleanup failed: ${(0, import_types.errMessage)(e)}`));
      }, import_timing_constants.STALE_DEVICE_CLEANUP_DELAY_MS);
      this.onlineSyncTimer = this.setInterval(() => {
        if (this.unloading || !this.stateManager || !this.deviceManager) {
          return;
        }
        void (async () => {
          let anyLightChanged = false;
          for (const device of this.deviceManager.getDevices()) {
            const changed = await this.stateManager.syncInfoOnline(device).catch(() => false);
            if (changed) {
              anyLightChanged = true;
            }
          }
          if (anyLightChanged) {
            groupFanoutHandler.updateGroupReachability(this.handlerHost);
          }
          await this.stateManager.writeDeviceRollup().catch((e) => {
            this.log.debug(`Device rollup failed: ${(0, import_types.errMessage)(e)}`);
          });
        })();
      }, import_timing_constants.ONLINE_SYNC_INTERVAL_MS);
      this.appVersionCheckTimer = this.setInterval(() => {
        connectionState.refreshLiveAppVersion(this.handlerHost).catch((e) => this.log.debug(`App version refresh error: ${(0, import_types.errMessage)(e)}`));
      }, import_timing_constants.APP_VERSION_CHECK_INTERVAL_MS);
      connectionState.updateConnectionState(this.handlerHost);
      connectionState.checkAllReady(this.handlerHost);
      this.readyTimer = this.setTimeout(() => {
        if (!this.readyLogged) {
          this.readyLogged = true;
          connectionState.logDeviceSummary(this.handlerHost);
        }
      }, import_timing_constants.READY_SAFETY_TIMEOUT_MS);
    } catch (error) {
      this.log.error(`onReady failed: ${(0, import_types.errMessage)(error)}`);
      if (error instanceof Error && error.stack) {
        this.log.debug(error.stack);
      }
    }
  }
  /**
   * One-shot migration: copy snapshots from the pre-v2.11 filesystem location
   * (`<dataDir>/snapshots/*.json`) into the `<namespace>.snapshots` meta.user
   * object. After migration the FS files are deleted so iob backup picks up
   * the new location. No-op if the old directory doesn't exist.
   *
   * @param dataDir Adapter instance data directory
   */
  async migrateLocalSnapshotsToMetaUser(dataDir) {
    const oldDir = path.join(dataDir, "snapshots");
    if (!fs.existsSync(oldDir)) {
      return;
    }
    let files;
    try {
      files = fs.readdirSync(oldDir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      this.log.warn(`Snapshot migration: cannot read ${oldDir}: ${(0, import_types.errMessage)(e)}`);
      return;
    }
    if (files.length === 0) {
      try {
        fs.rmdirSync(oldDir);
      } catch {
      }
      return;
    }
    this.log.info(`Migrating ${files.length} local snapshots from ${oldDir} to backup-included storage...`);
    let migrated = 0;
    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(oldDir, file));
        await this.writeFileAsync(`${this.namespace}.snapshots`, file, data);
        fs.unlinkSync(path.join(oldDir, file));
        migrated++;
      } catch (e) {
        this.log.warn(`Snapshot migration of ${file} failed: ${(0, import_types.errMessage)(e)}`);
      }
    }
    try {
      fs.rmdirSync(oldDir);
    } catch {
    }
    this.log.info(`Snapshot migration complete: ${migrated}/${files.length} files moved to meta.user storage.`);
  }
  async onStateChange(id, state) {
    try {
      await stateChangeRouter.onStateChange(this.handlerHost, id, state);
    } catch (e) {
      this.log.warn(`onStateChange crashed for ${id}: ${(0, import_types.errMessage)(e)}`);
    }
  }
  onMessage(obj) {
    var _a;
    try {
      (_a = this.messageRouter) == null ? void 0 : _a.onMessage(obj);
    } catch (e) {
      this.log.warn(`onMessage crashed: ${(0, import_types.errMessage)(e)}`);
    }
  }
  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  /**
   * js-controller and admin versions for the diagnostics report.
   */
  async readHostVersions() {
    var _a, _b;
    const host = await this.getForeignObjectAsync(`system.host.${this.host}`).catch(() => null);
    const admin = await this.getForeignObjectAsync("system.adapter.admin").catch(() => null);
    this.hostVersions = {
      jsController: (_a = host == null ? void 0 : host.common) == null ? void 0 : _a.installedVersion,
      admin: (_b = admin == null ? void 0 : admin.common) == null ? void 0 : _b.version
    };
  }
  /**
   * The datapoints below ONE device prefix, with type, role, unit and current
   * value — the view the user actually sees in the object tree.
   *
   * Deliberately scoped to a single prefix: a full-instance scan is exactly
   * what 2.27.1 removed from the periodic round, and this runs behind a button
   * a user can press repeatedly. One export therefore reads one device's
   * subtree, never the whole instance.
   *
   * @param prefix Device prefix, e.g. `devices.h61be_1d6f`
   * @returns One entry per datapoint, or an empty list if the tree cannot be read
   */
  async readObjectTree(prefix) {
    var _a;
    const start = `${this.namespace}.${prefix}.`;
    const view = await this.getObjectViewAsync("system", "state", {
      startkey: start,
      endkey: `${start}\u9999`
    }).catch(() => null);
    if (!(view == null ? void 0 : view.rows)) {
      return [];
    }
    const entries = [];
    for (const row of view.rows) {
      const localId = row.id.replace(`${this.namespace}.`, "");
      const common = (_a = row.value) == null ? void 0 : _a.common;
      const state = await this.getStateAsync(localId).catch(() => null);
      entries.push({
        id: localId.replace(`${prefix}.`, ""),
        type: common == null ? void 0 : common.type,
        role: common == null ? void 0 : common.role,
        unit: common == null ? void 0 : common.unit,
        write: common == null ? void 0 : common.write,
        val: state == null ? void 0 : state.val,
        ack: state == null ? void 0 : state.ack
      });
    }
    return entries;
  }
  onUnload(callback) {
    var _a, _b, _c, _d, _e, _f;
    this.unloading = true;
    try {
      if (this.lanScanTimer) {
        this.clearTimeout(this.lanScanTimer);
        this.lanScanTimer = void 0;
      }
      if (this.cleanupTimer) {
        this.clearTimeout(this.cleanupTimer);
        this.cleanupTimer = void 0;
      }
      if (this.readyTimer) {
        this.clearTimeout(this.readyTimer);
        this.readyTimer = void 0;
      }
      if (this.appApiPollTimer) {
        this.clearInterval(this.appApiPollTimer);
        this.appApiPollTimer = void 0;
      }
      if (this.onlineSyncTimer) {
        this.clearInterval(this.onlineSyncTimer);
        this.onlineSyncTimer = void 0;
      }
      if (this.appApiInitialTimer) {
        this.clearTimeout(this.appApiInitialTimer);
        this.appApiInitialTimer = void 0;
      }
      if (this.cloudInitTimer) {
        this.clearTimeout(this.cloudInitTimer);
        this.cloudInitTimer = void 0;
      }
      if (this.appVersionCheckTimer) {
        this.clearInterval(this.appVersionCheckTimer);
        this.appVersionCheckTimer = void 0;
      }
      (_a = this.cloudRetry) == null ? void 0 : _a.dispose();
      (_b = this.segmentWizard) == null ? void 0 : _b.dispose();
      (_c = this.lanClient) == null ? void 0 : _c.stop();
      (_d = this.mqttClient) == null ? void 0 : _d.disconnect();
      (_e = this.openapiMqttClient) == null ? void 0 : _e.disconnect();
      (_f = this.rateLimiter) == null ? void 0 : _f.stop();
      const done = () => callback();
      const writes = [
        this.setState("info.connection", { val: false, ack: true }),
        this.setState("info.mqttConnected", { val: false, ack: true }),
        this.setState("info.openapiMqttConnected", { val: false, ack: true }),
        this.setState("info.cloudConnected", { val: false, ack: true })
      ];
      if (this.stateManager) {
        writes.push(this.stateManager.markAllOffline());
      }
      void Promise.all(writes).catch((e) => {
        this.log.debug(`onUnload: final states rejected: ${(0, import_types.errMessage)(e)}`);
      }).finally(done);
      return;
    } catch {
    }
    callback();
  }
  /** Delete objects for devices no longer present — the connection-state handler holds the implementation. */
  reapStaleDevices() {
    return connectionState.reapStaleDevices(this.handlerHost);
  }
  /**
   * Manual "sync devices" button (info.manualSyncDevices): pull the fresh
   * Govee account device list and reconcile it — new devices are onboarded,
   * devices deleted from the account are removed — without a restart. Existing
   * devices' scene/snapshot data is untouched (use the per-device refresh).
   */
  async syncDevicesManually() {
    if (!this.deviceManager) {
      return;
    }
    const result = await this.deviceManager.loadFromCloud();
    if (!result.ok) {
      this.log.warn(`Manual device sync failed (${result.reason}) \u2014 see earlier log for details`);
      cloudRetryHandler.handleCloudFailure(this.handlerHost, result);
      return;
    }
    await this.reapStaleDevices();
  }
  /**
   * Reload the Cloud-state tree — after a recovered connection or for one
   * refreshed device.
   *
   * @param only Optional single device to reload; omit to reload every device's cloud states
   */
  loadCloudStates(only) {
    return cloudStateLoader.loadCloudStates(this.handlerHost, only);
  }
  /**
   * Central entry point for manual-segment updates (the wizard and the
   * state-change router both end here). Sets the device flags, rebuilds the
   * segment tree (which writes manual_mode + manual_list with ack=true), and
   * persists to cache.
   *
   * @param device Target device
   * @param mode    Whether manual mode should be active
   * @param indices Physical indices when mode=true, ignored otherwise
   */
  async applyManualSegments(device, mode, indices) {
    if (!this.stateManager || !this.deviceManager) {
      return;
    }
    device.manualMode = mode;
    device.manualSegments = mode && Array.isArray(indices) && indices.length > 0 ? indices.slice() : void 0;
    await this.stateManager.createSegmentStates(device, this.deviceManager.syncSegmentCount(device));
    this.deviceManager.persistDeviceToCache(device);
  }
  // ───────── Segment-Detection-Wizard ─────────
  /** Construct host object for MessageRouter. */
  buildMessageRouterHost() {
    return {
      log: this.log,
      getConfig: () => {
        const config = this.config;
        return {
          goveeEmail: config.goveeEmail,
          goveePassword: config.goveePassword,
          mqttVerificationCode: config.mqttVerificationCode
        };
      },
      sendResponse: (obj, data) => this.sendMessageResponse(obj, data),
      createMqttProbeClient: (email, password) => {
        const probe = new import_govee_mqtt_client.GoveeMqttClient(email, password, this.log, this);
        probe.enableProbeMode();
        return probe;
      },
      getSegmentDeviceList: () => {
        var _a, _b;
        const devices = (_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
        return devices.filter(
          (d) => {
            var _a2;
            return d.sku !== "BaseGroup" && ((_a2 = d.state) == null ? void 0 : _a2.online) === true && (0, import_lookups.resolveSegmentCount)(d, this.deviceRegistry) > 0;
          }
        ).map((d) => ({
          value: wizardHandler.deviceKeyFor(d),
          label: (0, import_i18n.resolveLabel)(
            "segmentWizardDeviceOption",
            d.name,
            d.sku,
            (0, import_lookups.resolveSegmentCount)(d, this.deviceRegistry)
          )
        }));
      },
      runWizardStep: (action, deviceKey, payload) => wizardHandler.runWizardStep(this.handlerHost, action, deviceKey, payload),
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: (handle) => this.clearTimeout(handle)
    };
  }
  /**
   * Send a sendTo response back to the caller, if the message expects one.
   *
   * @param obj ioBroker message object
   * @param data Response data payload
   */
  sendMessageResponse(obj, data) {
    if (obj.callback && obj.from) {
      this.sendTo(obj.from, obj.command, data, obj.callback);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeAdapter
});
//# sourceMappingURL=main.js.map
