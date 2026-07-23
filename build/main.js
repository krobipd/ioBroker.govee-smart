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
var import_adapter_core = require("@iobroker/adapter-core");
var utils = __toESM(require("@iobroker/adapter-core"));
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var import_actionable_problems = require("./lib/actionable-problems");
var import_device_registry = require("./lib/device-registry");
var import_device_manager = require("./lib/device-manager");
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
  /** Public for handler modules (state-change-router, group-fanout, wizard, snapshot, diagnostics). */
  deviceManager = null;
  /** Public for handler modules. */
  stateManager = null;
  /** Public for handler modules. */
  lanClient = null;
  /** Public for handler modules (connection-state). */
  mqttClient = null;
  /** Public for handler modules (connection-state). */
  openapiMqttClient = null;
  /** Registry surfacing user-actionable problems (verification, credentials). */
  actionableProblems;
  /** Public for handler modules. */
  cloudClient = null;
  /** Public for handler modules (cloud-state-loader budgets its /device/state calls). */
  rateLimiter = null;
  /** Repeating timer for the App-API poll (sensor-state pull). */
  appApiPollTimer;
  /**
   * One-shot timer for the FIRST app-api poll (5s after start) — kept as a
   * handle so onUnload can clear it before it fires into the void.
   */
  appApiInitialTimer;
  /** One-shot timer for cloud-init 60s safety timeout — same pattern. */
  /** Public for handler modules. */
  cloudInitTimer;
  /**
   * Last info.connection value — cached so not every device update issues an
   * unnecessary setState (H4).
   */
  /** Public for handler modules (connection-state). */
  lastConnectionState = null;
  // === Lifecycle flags (adapter boot sequence) ===
  // checkAllReady() checks all 5 preconditions at once — they run in parallel,
  // not a linear STATE_MACHINE pattern, because the channels connect
  // independently.
  /** LAN-Scan-Initial-Wait abgeschlossen — public for connection-state handler. */
  lanScanDone = false;
  /** State-Tree-Erstellung fertig — public for connection-state + device-events handlers. */
  statesReady = false;
  /** Cloud-Init-Phase abgeschlossen — public for connection-state handler. */
  cloudInitDone = false;
  /** App-API-Poll fertig — public for connection-state handler. */
  appApiInitialPollDone = false;
  /** Mehrfach-Ready-Log-Guard — public for connection-state handler. */
  readyLogged = false;
  /** Cloud was connected at least once — for the "restored" log after a down. */
  /** Public for handler modules. */
  cloudWasConnected = false;
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
  /** Public for handler modules. */
  localSnapshots = null;
  /** Public for handler modules (state-change-router). */
  snapshotHandler = null;
  /** Public for handler modules (state-change-router). */
  groupFanout = null;
  messageRouter = null;
  /** Current channel status — pulled by the log-prefix wrapper on every log call. */
  channelStatus = { lan: "n/a", cloud: "n/a", mqtt: "n/a", openapi: "n/a" };
  /** Public for handler modules (device-events). */
  stateCreationQueue = [];
  lanScanTimer;
  cleanupTimer;
  readyTimer;
  /** Public for handler modules. Undefined until first ensureCloudRetry() call. */
  cloudRetry;
  /** Public for handlers/wizard-handler — lazily instantiated by `runWizardStep`. */
  segmentWizard = null;
  /** Per-device timestamp of the last diagnostics export — throttle gate */
  /** Public for handler modules (state-change-router, diagnostics). */
  diagnosticsLastRun = /* @__PURE__ */ new Map();
  /**
   * Set true at the start of onUnload — async paths (onStateChange,
   * applyCloudCapabilities, retrySceneData, …) check this between awaits
   * and bail before further setState against a torn-down adapter.
   */
  /** Public for handler modules (state-change-router). */
  unloading = false;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** Adapter started — initialize all channels */
  async onReady() {
    var _a, _b, _c, _d;
    try {
      await import_adapter_core.I18n.init(path.join(this.adapterDir, "admin"), this);
      const config = this.config;
      void connectionState.refreshLiveAppVersion(this).catch((e) => this.log.debug(`App version refresh error: ${(0, import_types.errMessage)(e)}`));
      await this.delObjectAsync("info.refresh_cloud_data").catch(() => void 0);
      await this.delObjectAsync("info.appVersionDrift").catch(() => void 0);
      await this.delObjectAsync("info.wizardStatus").catch(() => void 0);
      await cloudCreds.migrateCredentialsMetaOnce(this, utils.getAbsoluteInstanceDataDir(this));
      if (config.apiKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.apiKey)) {
        this.log.error(
          "The Govee API key does not look like a valid key (expected UUID format like 12345678-1234-1234-1234-123456789abc) \u2014 check for typos or copied whitespace in the adapter settings. If this appeared right after upgrading a very old install (v2.11.0 encryption migration), re-enter the API key, Govee password and verification code once."
        );
      }
      this.channelStatus = {
        lan: "off",
        // LAN listener always exists; flips to "on" after first discovery
        cloud: config.apiKey ? "off" : "n/a",
        mqtt: config.goveeEmail && config.goveePassword ? "off" : "n/a",
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
      this.stateManager = new import_state_manager.StateManager(this);
      await this.stateManager.cleanupSameModeGroupOrphansOnce().catch(() => void 0);
      await this.stateManager.createGroupsOnlineState(false);
      this.deviceManager = new import_device_manager.DeviceManager(this.log, this);
      const dataDir = utils.getAbsoluteInstanceDataDir(this);
      (0, import_device_registry.initDeviceRegistry)({
        experimental: config.experimentalQuirks === true,
        log: this.log
      });
      this.skuCache = new import_sku_cache.SkuCache(dataDir, this.log);
      await this.migrateLocalSnapshotsToMetaUser(dataDir);
      this.localSnapshots = new import_local_snapshots.LocalSnapshotStore(this, this.log);
      await this.localSnapshots.init();
      this.snapshotHandler = new import_snapshot_handler.SnapshotHandler(snapshotHandlerGlue.buildSnapshotHost(this));
      this.groupFanout = new import_group_fanout.GroupFanoutHandler(groupFanoutHandler.buildGroupFanoutHost(this));
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
        var _a2, _b2, _c2, _d2, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
        const errorCats = (_a2 = this.deviceManager) == null ? void 0 : _a2.getErrorCategorySnapshot();
        return {
          deviceManagerLastErrorCategory: (_b2 = errorCats == null ? void 0 : errorCats.deviceManager) != null ? _b2 : null,
          appApiLastErrorCategory: (_c2 = errorCats == null ? void 0 : errorCats.appApi) != null ? _c2 : null,
          groupMembersLastErrorCategory: (_d2 = errorCats == null ? void 0 : errorCats.groupMembers) != null ? _d2 : null,
          cloudFailureReason: (_f = (_e = this.cloudClient) == null ? void 0 : _e.getFailureReason()) != null ? _f : null,
          mqttFailureReason: (_h = (_g = this.mqttClient) == null ? void 0 : _g.getFailureReason()) != null ? _h : null,
          rateLimiter: (_j = (_i = this.rateLimiter) == null ? void 0 : _i.getUsageSnapshot()) != null ? _j : null,
          wizardSession: (_l = (_k = this.segmentWizard) == null ? void 0 : _k.getSessionSnapshot()) != null ? _l : null,
          lanSeenDeviceIps: (_n = (_m = this.lanClient) == null ? void 0 : _m.getDiagSnapshot().seenDeviceIps) != null ? _n : []
        };
      });
      const apiClient = new import_govee_api_client.GoveeApiClient(this.log);
      apiClient.setEmail(config.goveeEmail);
      this.deviceManager.setApiClient(apiClient);
      this.deviceManager.setCallbacks({
        onUpdate: (device, state) => deviceEvents.onDeviceStateUpdate(this, device, state),
        onLanDeviceReady: (device, allDevices) => deviceEvents.onLanDeviceReady(this, device, allDevices),
        onCloudDataReady: (device, allDevices) => deviceEvents.onCloudDataReady(this, device, allDevices),
        onGroupMembersReady: (group, allDevices) => deviceEvents.onGroupMembersReady(this, group, allDevices)
      });
      this.deviceManager.onDevicesRemoved = () => {
        void this.reapStaleDevices().catch((e) => this.log.debug(`Post-eviction cleanup failed: ${(0, import_types.errMessage)(e)}`));
      };
      this.deviceManager.onLanIpChanged = (device, ip) => {
        if (device.gateway) {
          return;
        }
        const prefix = this.stateManager.devicePrefix(device);
        this.setState(`${prefix}.info.ip`, { val: ip, ack: true }).catch(() => {
        });
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
            }).catch(() => {
            });
          }
          if (batch.brightness !== void 0) {
            this.setState(`${prefix}.segments.${idx}.brightness`, {
              val: batch.brightness,
              ack: true
            }).catch(() => {
            });
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
          }).catch(() => {
          });
          this.setState(`${prefix}.segments.${seg.index}.brightness`, {
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
            `Failed to rebuild segment tree for ${(0, import_types.deviceLabel)(device)} after count growth: ${(0, import_types.errMessage)(e)}`
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
        `Starting (${startChannels.join(", ")}) \u2014 please wait, a "ready" message will follow when all channels are up`
      );
      this.lanClient = new import_govee_lan_client.GoveeLanClient(this.log, this);
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
        connectionState.checkAllReady(this);
      }, import_timing_constants.LAN_SCAN_INITIAL_WAIT_MS);
      if (config.goveeEmail && config.goveePassword) {
        this.mqttClient = new import_govee_mqtt_client.GoveeMqttClient(config.goveeEmail, config.goveePassword, this.log, this);
        this.mqttClient.setPacketHook((deviceId, topic, payload) => {
          var _a2;
          (_a2 = this.deviceManager) == null ? void 0 : _a2.getDiagnostics().addMqttPacket(deviceId, topic, payload);
        });
        this.mqttClient.setVerificationCode((_a = config.mqttVerificationCode) != null ? _a : "");
        this.mqttClient.setOnVerificationConsumed(() => {
          cloudCreds.clearVerificationCodeSetting(this).catch((e) => {
            this.log.warn(`Could not clear mqttVerificationCode: ${(0, import_types.errMessage)(e)}`);
          });
        });
        this.mqttClient.setOnVerificationFailed((reason) => {
          if (reason === "failed") {
            cloudCreds.clearVerificationCodeSetting(this).catch(() => {
            });
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee rejected the verification code for real-time status",
              action: "request a fresh code in the adapter settings (Govee Account section) and paste the one Govee e-mails you"
            });
          } else {
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee requires a verification code to enable real-time status (lights/sensors stay readable)",
              action: "open the adapter settings (Govee Account section), request a code, and paste the one Govee e-mails you"
            });
          }
        });
        this.mqttClient.setOnAuthFailed(() => {
          this.actionableProblems.report({
            key: "mqtt-auth",
            title: "Govee rejected the account login for real-time status",
            action: "check the Govee e-mail and password in the adapter settings (Govee Account section)"
          });
        });
        await cloudCreds.cleanupLegacyMqttNativeOnce(this);
        const cachedCreds = await cloudCreds.loadPersistedCreds(this, dataDir);
        if (cachedCreds) {
          this.mqttClient.setPersistedCredentials(cachedCreds);
        }
        this.mqttClient.setOnCredentialsRefresh((creds) => {
          cloudCreds.persistCreds(this, dataDir, creds).catch((e) => {
            this.log.warn(`Could not persist MQTT credentials: ${(0, import_types.errMessage)(e)}`);
          });
        });
        await this.mqttClient.connect(
          (update) => this.deviceManager.handleMqttStatus(update),
          (connected) => {
            this.setState("info.mqttConnected", {
              val: connected,
              ack: true
            }).catch(() => {
            });
            if (connected) {
              this.actionableProblems.resolve(
                "mqtt-verification",
                "Govee real-time status connected \u2014 verification accepted"
              );
              this.actionableProblems.resolve("mqtt-auth", "Govee account login accepted");
              connectionState.checkAllReady(this);
            }
            connectionState.updateConnectionState(this);
          },
          // Forward every fresh bearer token — fires on initial login and on
          // each reconnect-login, so the API client never runs with a stale one.
          (token) => apiClient.setBearerToken(token)
        );
      }
      const cachedOk = this.deviceManager.loadFromCache();
      if (config.apiKey) {
        this.cloudClient = new import_govee_cloud_client.GoveeCloudClient(config.apiKey, this.log);
        this.cloudClient.setResponseHook((deviceId, endpoint, body) => {
          var _a2;
          (_a2 = this.deviceManager) == null ? void 0 : _a2.getDiagnostics().recordApiSuccess(deviceId, endpoint, body);
        });
        this.deviceManager.setCloudClient(this.cloudClient);
        this.deviceManager.setOnCloudCapabilities((device, caps) => {
          cloudStateLoader.applyCloudCapabilities(this, device, caps).catch((e) => this.log.warn(`applyCloudCapabilities failed for ${device.sku}: ${(0, import_types.errMessage)(e)}`));
        });
        this.rateLimiter = new import_rate_limiter.RateLimiter(this.log, this, import_timing_constants.CLOUD_FULL_LIMITS.perMinute, import_timing_constants.CLOUD_FULL_LIMITS.perDay);
        this.rateLimiter.start();
        this.deviceManager.setRateLimiter(this.rateLimiter);
        this.openapiMqttClient = new import_govee_openapi_mqtt_client.GoveeOpenapiMqttClient(config.apiKey, this.log, this);
        this.openapiMqttClient.connect(
          (event) => {
            var _a2;
            return (_a2 = this.deviceManager) == null ? void 0 : _a2.handleOpenApiEvent(event);
          },
          (connected) => {
            this.setState("info.openapiMqttConnected", {
              val: connected,
              ack: true
            }).catch(() => {
            });
            if (connected) {
              connectionState.checkAllReady(this);
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
              connectionState.checkAllReady(this);
            }
          }).catch((e) => this.log.debug(`pollAppApi failed: ${(0, import_types.errMessage)(e)}`));
        };
        this.appApiPollTimer = this.setInterval(triggerAppApiPoll, import_timing_constants.APP_API_POLL_INTERVAL_MS);
        this.appApiInitialTimer = this.setTimeout(triggerAppApiPoll, import_timing_constants.APP_API_INITIAL_DELAY_MS);
        if (!cachedOk) {
          const result = await cloudRetryHandler.cloudInitWithTimeout(this);
          this.cloudWasConnected = result.ok;
          cloudRetryHandler.ensureCloudRetry(this).setConnected(result.ok);
          this.setState("info.cloudConnected", {
            val: result.ok,
            ack: true
          }).catch(() => {
          });
          (_b = this.stateManager) == null ? void 0 : _b.updateGroupsOnline(result.ok).catch(() => {
          });
          if (result.ok) {
            await cloudStateLoader.loadCloudStates(this);
          } else {
            cloudRetryHandler.handleCloudFailure(this, result);
          }
        } else {
          this.log.debug(`Using cached device data \u2014 no Cloud calls needed`);
          this.cloudWasConnected = true;
          cloudRetryHandler.ensureCloudRetry(this).setConnected(true);
          this.setState("info.cloudConnected", {
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
      this.cleanupTimer = this.setTimeout(() => {
        connectionState.reapStaleDevices(this).catch((e) => this.log.debug(`Device cleanup failed: ${(0, import_types.errMessage)(e)}`));
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
            groupFanoutHandler.updateGroupReachability(this);
          }
        })();
      }, import_timing_constants.ONLINE_SYNC_INTERVAL_MS);
      this.appVersionCheckTimer = this.setInterval(() => {
        connectionState.refreshLiveAppVersion(this).catch((e) => this.log.debug(`App version refresh error: ${(0, import_types.errMessage)(e)}`));
      }, import_timing_constants.APP_VERSION_CHECK_INTERVAL_MS);
      connectionState.updateConnectionState(this);
      connectionState.checkAllReady(this);
      this.readyTimer = this.setTimeout(() => {
        if (!this.readyLogged) {
          this.readyLogged = true;
          connectionState.logDeviceSummary(this);
        }
      }, import_timing_constants.READY_SAFETY_TIMEOUT_MS);
    } catch (error) {
      this.log.error(`onReady failed: ${error instanceof Error ? (_d = error.stack) != null ? _d : error.message : String(error)}`);
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
      await stateChangeRouter.onStateChange(this, id, state);
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
      this.setState("info.connection", { val: false, ack: true }).catch(() => {
      });
      this.setState("info.mqttConnected", { val: false, ack: true }).catch(() => {
      });
      this.setState("info.openapiMqttConnected", {
        val: false,
        ack: true
      }).catch(() => {
      });
      this.setState("info.cloudConnected", { val: false, ack: true }).catch(() => {
      });
    } catch {
    }
    callback();
  }
  /**
   * Public delegate to stateChangeRouter — required by GroupFanoutHandlerAdapter interface.
   *
   * @param device Target device
   * @param prefix Device state prefix
   * @param changedSuffix State suffix that changed
   * @param newValue New value written
   */
  async sendMusicCommand(device, prefix, changedSuffix, newValue) {
    return stateChangeRouter.sendMusicCommand(this, device, prefix, changedSuffix, newValue);
  }
  /**
   * Public delegate for snapshot-glue + state-change-router modules — a
   * Cloud-data event (new snapshot in app, refresh-button, etc.) needs a
   * full Cloud-phase rebuild for the affected device.
   *
   * @param device Target device
   * @param allDevices Full device list
   */
  fireCloudDataReady(device, allDevices) {
    deviceEvents.onCloudDataReady(this, device, allDevices);
  }
  /** Public delegate — connection-state handler exports the real implementation. */
  reapStaleDevices() {
    return connectionState.reapStaleDevices(this);
  }
  /**
   * Manual "sync devices" button (info.manual_sync_devices): pull the fresh
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
      cloudRetryHandler.handleCloudFailure(this, result);
      return;
    }
    await this.reapStaleDevices();
  }
  /**
   * Map a state suffix to a command name — public delegate for handler modules,
   * stateless lookup in lib/handlers/dropdown-reset-helpers. Simple suffixes live
   * in a lookup table; segment indices need regex extraction because they're
   * dynamic. The three music states all route to the same "music" command —
   * the handler reads sibling values.
   *
   * @param suffix State ID suffix (e.g. "power", "brightness")
   */
  stateToCommand(suffix) {
    return dropdownReset.stateToCommand(suffix);
  }
  /**
   * Public delegate for cloud-retry-handler's CloudRetryHandlerAdapter interface.
   *
   * @param only Optional single device to reload; omit to reload every device's cloud states
   */
  loadCloudStates(only) {
    return cloudStateLoader.loadCloudStates(this, only);
  }
  /**
   * Central entry point for manual-segment updates (public for the wizard +
   * state-change-router). Sets the device flags, rebuilds the segment tree
   * (which writes manual_mode + manual_list with ack=true), and persists to
   * cache. Both the user state-change handler and the wizard route their final
   * decisions here.
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
      createMqttProbeClient: () => {
        const config = this.config;
        const probe = new import_govee_mqtt_client.GoveeMqttClient(config.goveeEmail, config.goveePassword, this.log, this);
        probe.enableProbeMode();
        return probe;
      },
      getSegmentDeviceList: () => {
        var _a, _b;
        const devices = (_b = (_a = this.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
        return devices.filter((d) => {
          var _a2;
          return d.sku !== "BaseGroup" && ((_a2 = d.state) == null ? void 0 : _a2.online) === true && (0, import_device_manager.resolveSegmentCount)(d) > 0;
        }).map((d) => ({
          value: wizardHandler.deviceKeyFor(d),
          label: (0, import_i18n.resolveLabel)("segmentWizardDeviceOption", d.name, d.sku, (0, import_device_manager.resolveSegmentCount)(d))
        }));
      },
      runWizardStep: (action, deviceKey, payload) => wizardHandler.runWizardStep(this, action, deviceKey, payload),
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
//# sourceMappingURL=main.js.map
