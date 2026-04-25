import * as utils from "@iobroker/adapter-core";
import {
  buildDeviceStateDefs,
  getDefaultLanStates,
  mapCloudStateValue,
} from "./lib/capability-mapper.js";
import { initDeviceRegistry } from "./lib/device-registry.js";
import {
  DeviceManager,
  resolveSegmentCount,
  SEGMENT_HARD_MAX,
} from "./lib/device-manager.js";
import { GoveeApiClient } from "./lib/govee-api-client.js";
import { GoveeCloudClient } from "./lib/govee-cloud-client.js";
import { GoveeLanClient } from "./lib/govee-lan-client.js";
import { GoveeMqttClient } from "./lib/govee-mqtt-client.js";
import { GoveeOpenapiMqttClient } from "./lib/govee-openapi-mqtt-client.js";
import {
  LocalSnapshotStore,
  type LocalSnapshot,
  type SnapshotSegment,
} from "./lib/local-snapshots.js";
import { CloudRetryLoop, type CloudRetryHost } from "./lib/cloud-retry.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import {
  SegmentWizard,
  wizardIdleText,
  type WizardHost,
  type WizardResult,
} from "./lib/segment-wizard.js";
import { SkuCache } from "./lib/sku-cache.js";
import { StateManager } from "./lib/state-manager.js";
import {
  hexToRgb,
  parseSegmentList,
  resolveStatesValue,
  rgbIntToHex,
  rgbToHex,
  type AdapterConfig,
  type CloudLoadResult,
  type CloudStateCapability,
  type DeviceState,
  type GoveeDevice,
} from "./lib/types.js";

/**
 * Rate limit defaults — full Cloud API budget (8/min, 9000/day). v2 no
 * longer halves this with govee-appliances because that adapter is
 * deprecated and won't run alongside govee-smart.
 */
const FULL_LIMITS = { perMinute: 8, perDay: 9000 };

/**
 * State-suffix → command-name lookup for writable states. Segment indices
 * are dynamic and handled by regex in stateToCommand — everything else is
 * a straight string mapping.
 */
const STATE_TO_COMMAND: Readonly<Record<string, string>> = {
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
  "segments.command": "segmentBatch",
};

class GoveeAdapter extends utils.Adapter {
  private deviceManager: DeviceManager | null = null;
  private stateManager: StateManager | null = null;
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private openapiMqttClient: GoveeOpenapiMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  /** Repeating timer for the App-API poll (sensor-state pull). */
  private appApiPollTimer: ioBroker.Interval | undefined;
  private skuCache: SkuCache | null = null;
  private localSnapshots: LocalSnapshotStore | null = null;
  private cloudWasConnected = false;
  private readyLogged = false;
  private cloudInitDone = false;
  private lanScanDone = false;
  private statesReady = false;
  private stateCreationQueue: Promise<void>[] = [];
  private lanScanTimer: ioBroker.Timeout | undefined;
  private cleanupTimer: ioBroker.Timeout | undefined;
  private readyTimer: ioBroker.Timeout | undefined;
  private cloudRetry: CloudRetryLoop | null = null;
  private segmentWizard: SegmentWizard | null = null;
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
  private uncaughtExceptionHandler: ((err: Error) => void) | null = null;
  /** Per-device timestamp of the last diagnostics export — throttle gate */
  private diagnosticsLastRun = new Map<string, number>();
  /** Cached admin language from system.config — used for wizard UI text */
  private adminLanguage = "en";

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "govee-smart" });
    // Per ioBroker rule: async handlers registered on events MUST .catch,
    // otherwise rejections become unhandled → SIGKILL code 6 → restart loop.
    this.on("ready", () =>
      this.onReady().catch((e) =>
        this.log.error(
          `onReady crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        ),
      ),
    );
    this.on("stateChange", (id, state) =>
      this.onStateChange(id, state).catch((e) =>
        this.log.warn(
          `onStateChange crashed for ${id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ),
    );
    this.on("message", (obj) => this.onMessage(obj));
    this.on("unload", (callback) => this.onUnload(callback));
    // Last-line-of-defence against unhandled rejections / sync throws from
    // fire-and-forget paths. The per-handler .catch() wrappers cover the
    // direct entry points; this catches whatever slips past them so the
    // adapter logs the cause instead of triggering js-controller SIGKILL.
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.log.error(
        `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
      );
    };
    this.uncaughtExceptionHandler = (err: Error) => {
      this.log.error(`Uncaught exception: ${err.stack ?? err.message}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  /** Adapter started — initialize all channels */
  private async onReady(): Promise<void> {
    const config = this.config as unknown as AdapterConfig;

    // Ensure info.connection exists
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection status",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.mqttConnected", {
      type: "state",
      common: {
        name: "MQTT connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.cloudConnected", {
      type: "state",
      common: {
        name: "Cloud API connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.openapiMqttConnected", {
      type: "state",
      common: {
        name: "Govee OpenAPI MQTT connected",
        desc: "Push channel for sensor and appliance events. Independent of the AWS-IoT MQTT used for status push of regular Govee lights.",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.wizardStatus", {
      type: "state",
      common: {
        name: "Segment-Wizard status",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
      },
      native: {},
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
        def: false,
      },
      native: {},
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });
    await this.setStateAsync("info.openapiMqttConnected", {
      val: false,
      ack: true,
    });
    await this.setStateAsync("info.refresh_cloud_data", {
      val: false,
      ack: true,
    });
    // Load admin language from system.config so wizard prose matches the
    // user's Admin UI. Falls back to English on any lookup failure.
    try {
      const sysConf = await this.getForeignObjectAsync("system.config");
      const lang = (sysConf?.common as { language?: string } | undefined)
        ?.language;
      if (typeof lang === "string" && lang.length > 0) {
        this.adminLanguage = lang;
      }
    } catch {
      // Keep default "en"
    }
    await this.setStateAsync("info.wizardStatus", {
      val: wizardIdleText(this.adminLanguage),
      ack: true,
    });

    this.stateManager = new StateManager(this);
    // General groups online state (reflects Cloud connection)
    await this.stateManager.createGroupsOnlineState(false);
    this.deviceManager = new DeviceManager(this.log, this);
    const dataDir = utils.getAbsoluteInstanceDataDir(this);

    // Load device registry from devices.json in the adapter package root.
    // Status filter: verified+reported active by default; seed-status entries
    // require the experimentalQuirks config toggle.
    initDeviceRegistry({
      experimental: config.experimentalQuirks === true,
      log: this.log,
    });
    this.skuCache = new SkuCache(dataDir, this.log);
    this.localSnapshots = new LocalSnapshotStore(dataDir, this.log);
    this.deviceManager.setSkuCache(this.skuCache);

    // API client for undocumented scene/music/DIY libraries (always available)
    const apiClient = new GoveeApiClient();
    this.deviceManager.setApiClient(apiClient);

    this.deviceManager.setCallbacks(
      (device, state) => this.onDeviceStateUpdate(device, state),
      (devices) => this.onDeviceListChanged(devices),
    );

    // Update info.ip when LAN IP changes
    this.deviceManager.onLanIpChanged = (device, ip) => {
      const prefix = this.stateManager!.devicePrefix(device);
      this.setStateAsync(`${prefix}.info.ip`, { val: ip, ack: true }).catch(
        () => {},
      );
    };

    // Sync individual segment states after batch command
    this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
      const prefix = this.stateManager!.devicePrefix(device);
      for (const idx of batch.segments) {
        if (batch.color !== undefined) {
          const hex = rgbIntToHex(batch.color);
          this.setStateAsync(`${prefix}.segments.${idx}.color`, {
            val: hex,
            ack: true,
          }).catch(() => {});
        }
        if (batch.brightness !== undefined) {
          this.setStateAsync(`${prefix}.segments.${idx}.brightness`, {
            val: batch.brightness,
            ack: true,
          }).catch(() => {});
        }
      }
    };

    // Sync per-segment states from MQTT BLE status push (AA A5 packets)
    this.deviceManager.onMqttSegmentUpdate = (device, segments) => {
      const prefix = this.stateManager!.devicePrefix(device);
      for (const seg of segments) {
        this.setStateAsync(`${prefix}.segments.${seg.index}.color`, {
          val: rgbToHex(seg.r, seg.g, seg.b),
          ack: true,
        }).catch(() => {});
        this.setStateAsync(`${prefix}.segments.${seg.index}.brightness`, {
          val: seg.brightness,
          ack: true,
        }).catch(() => {});
      }
    };

    // When MQTT reveals more segments than the Cloud advertised, rebuild
    // the device's state tree so the extra segments get their datapoints.
    this.deviceManager.onSegmentCountGrown = (device) => {
      if (!this.stateManager) {
        return;
      }
      this.stateManager.createSegmentStates(device).catch((e) => {
        this.log.warn(
          `Failed to rebuild segment tree for ${device.name} after count growth: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    };

    // Log startup with configured channels
    const startChannels: string[] = ["LAN"];
    if (config.apiKey) {
      startChannels.push("Cloud");
    }
    if (config.goveeEmail && config.goveePassword) {
      startChannels.push("MQTT");
    }
    this.log.info(
      `Starting with channels: ${startChannels.join(", ")} — please wait...`,
    );

    // --- LAN (always active) ---
    this.lanClient = new GoveeLanClient(this.log, this);
    this.deviceManager.setLanClient(this.lanClient);

    this.lanClient.start(
      (lanDevice) => {
        this.deviceManager!.handleLanDiscovery(lanDevice);
        // Poll status only when MQTT is unavailable. With an active MQTT
        // subscription Govee pushes state changes authoritatively, so the
        // LAN devStatus request would be duplicate traffic.
        if (!this.mqttClient?.connected) {
          this.lanClient!.requestStatus(lanDevice.ip);
        }
      },
      (sourceIp, status) => {
        this.deviceManager!.handleLanStatus(sourceIp, status);
      },
      30_000,
      config.networkInterface || "",
    );

    // Wait for first LAN scan responses (UDP multicast, devices respond within 1-2s)
    this.lanScanTimer = this.setTimeout(() => {
      this.lanScanDone = true;
      this.checkAllReady();
    }, 3_000);

    // --- MQTT (if account credentials provided) ---
    // Initialize MQTT before Cloud so scene library can load on first cycle
    if (config.goveeEmail && config.goveePassword) {
      this.mqttClient = new GoveeMqttClient(
        config.goveeEmail,
        config.goveePassword,
        this.log,
        this,
      );

      // Forward every parsed MQTT op.command into the diagnostics ring buffer
      // so info.diagnostics_export contains the recent packets per device.
      this.mqttClient.setPacketHook((deviceId, topic, hex) => {
        this.deviceManager
          ?.getDiagnostics()
          .addMqttPacket(deviceId, topic, hex);
      });

      await this.mqttClient.connect(
        (update) => this.deviceManager!.handleMqttStatus(update),
        (connected) => {
          this.setStateAsync("info.mqttConnected", {
            val: connected,
            ack: true,
          }).catch(() => {});
          if (connected) {
            this.checkAllReady();
          }
          this.updateConnectionState();
        },
        // Forward every fresh bearer token — fires on initial login and on
        // each reconnect-login, so the API client never runs with a stale one.
        (token) => apiClient.setBearerToken(token),
      );
    }

    // --- Device data: Cache first, Cloud only on cache miss ---
    const cachedOk = this.deviceManager.loadFromCache();

    if (config.apiKey) {
      this.cloudClient = new GoveeCloudClient(config.apiKey, this.log);
      // Capture the most recent Cloud response per (deviceId, endpoint) for
      // diagnostics — bounded by the DiagnosticsCollector's response slot cap.
      this.cloudClient.setResponseHook((deviceId, endpoint, body) => {
        this.deviceManager
          ?.getDiagnostics()
          .setApiResponse(deviceId, endpoint, body);
      });
      this.deviceManager.setCloudClient(this.cloudClient);

      // Bridge synthetic capabilities (App-API, OpenAPI-MQTT events) into the
      // same setState pipeline as polled Cloud state. Keeps mapCloudStateValue
      // as the single source of truth for value coercion + state-id resolution.
      this.deviceManager.setOnCloudCapabilities((device, caps) => {
        this.applyCloudCapabilities(device, caps).catch((e) =>
          this.log.warn(
            `applyCloudCapabilities failed for ${device.sku}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      });

      this.rateLimiter = new RateLimiter(
        this.log,
        this,
        FULL_LIMITS.perMinute,
        FULL_LIMITS.perDay,
      );
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);

      // OpenAPI-MQTT — push channel for appliance/sensor events
      // (lackWater, iceFull, bodyAppeared etc.). API key is enough; no
      // separate credentials required. Connection runs in parallel to
      // the AWS-IoT MQTT used for status push of regular devices.
      this.openapiMqttClient = new GoveeOpenapiMqttClient(
        config.apiKey,
        this.log,
        this,
      );
      this.openapiMqttClient.connect(
        (event) => this.deviceManager?.handleOpenApiEvent(event),
        (connected) => {
          this.setStateAsync("info.openapiMqttConnected", {
            val: connected,
            ack: true,
          }).catch(() => {});
        },
      );

      // App-API poll — every 2 minutes, pulls state for sensors like H5179
      // where OpenAPI v2 /device/state returns empty. Bearer token comes
      // from the AWS-IoT MQTT login, so a no-op until that succeeds.
      this.appApiPollTimer = this.setInterval(
        () => {
          this.deviceManager
            ?.pollAppApi()
            .catch((e) =>
              this.log.debug(
                `pollAppApi failed: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
        },
        2 * 60 * 1000,
      );

      if (!cachedOk) {
        // No cache — first start, fetch from Cloud with 60s hard-timeout.
        // If Cloud hangs/fails, we don't want to block adapter startup indefinitely.
        const result = await this.cloudInitWithTimeout();
        this.cloudWasConnected = result.ok;
        this.ensureCloudRetry().setConnected(result.ok);
        this.setStateAsync("info.cloudConnected", {
          val: result.ok,
          ack: true,
        }).catch(() => {});
        this.stateManager?.updateGroupsOnline(result.ok).catch(() => {});

        if (result.ok) {
          await this.loadCloudStates();
        } else {
          this.handleCloudFailure(result);
        }
      } else {
        this.log.info("Using cached device data — no Cloud calls needed");
        this.cloudWasConnected = true;
        this.ensureCloudRetry().setConnected(true);
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true,
        }).catch(() => {});
        this.stateManager?.updateGroupsOnline(true).catch(() => {});
      }
      // Load group membership from undocumented API (needs bearer token + device map)
      await this.deviceManager.loadGroupMembers();

      this.cloudInitDone = true;
    }

    // Wait for all state creation from cache/cloud load to complete.
    // Drain-loop: a callback that fires during the await (e.g. a late LAN
    // discovery) can push fresh promises into the queue — we need to await
    // those too before flipping statesReady, otherwise the initial state
    // tree would be incomplete on very fast startups.
    while (this.stateCreationQueue.length > 0) {
      const pending = this.stateCreationQueue;
      this.stateCreationQueue = [];
      await Promise.all(pending);
    }
    this.statesReady = true;

    // Subscribe to all writable device and group states
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");
    await this.subscribeStatesAsync("info.refresh_cloud_data");

    // Cleanup stale devices after initial discovery (30s delay for LAN scan).
    // Reaps devices from every adapter-level map that was keyed on them so the
    // process doesn't leak memory across Cloud-side device turnover.
    this.cleanupTimer = this.setTimeout(() => {
      this.reapStaleDevices().catch((e) =>
        this.log.debug(
          `Device cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }, 30_000);

    this.updateConnectionState();

    // Check if all channels are ready — may already be true if MQTT connected fast
    this.checkAllReady();
    // Safety timeout: log ready even if a channel takes too long.
    // 60s deckt normalen MQTT-Connect + 1 Reconnect-Attempt ab.
    this.readyTimer = this.setTimeout(() => {
      if (!this.readyLogged) {
        this.readyLogged = true;
        this.logDeviceSummary();
      }
    }, 60_000);
  }

  /**
   * Initial Cloud-Load mit 60-Sekunden-Hardtimeout.
   * Blockiert nicht länger — wenn Cloud hängt, geht Adapter mit LAN+MQTT weiter,
   * und der Retry-Loop probiert's passend zum Fehlergrund erneut.
   */
  private async cloudInitWithTimeout(): Promise<CloudLoadResult> {
    if (!this.deviceManager) {
      return { ok: false, reason: "transient" };
    }
    const loadPromise = this.deviceManager.loadFromCloud();
    const timeoutPromise = new Promise<CloudLoadResult>((resolve) => {
      this.setTimeout(
        () => resolve({ ok: false, reason: "transient" }),
        60_000,
      );
    });
    try {
      return await Promise.race([loadPromise, timeoutPromise]);
    } catch {
      return { ok: false, reason: "transient" };
    }
  }

  /** Build the host object for {@link CloudRetryLoop}. */
  private buildCloudRetryHost(): CloudRetryHost {
    return {
      log: this.log,
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: (h) => this.clearTimeout(h as ioBroker.Timeout),
      loadFromCloud: () => this.cloudInitWithTimeout(),
      onCloudRestored: async () => {
        this.cloudWasConnected = true;
        this.setStateAsync("info.cloudConnected", {
          val: true,
          ack: true,
        }).catch(() => {});
        this.stateManager?.updateGroupsOnline(true).catch(() => {});
        await this.loadCloudStates();
      },
    };
  }

  /** Lazy-initialise the retry loop on first use. */
  private ensureCloudRetry(): CloudRetryLoop {
    if (!this.cloudRetry) {
      this.cloudRetry = new CloudRetryLoop(this.buildCloudRetryHost());
      this.cloudRetry.setConnected(this.cloudWasConnected);
    }
    return this.cloudRetry;
  }

  /**
   * React to a Cloud-load outcome — delegates to {@link CloudRetryLoop}.
   *
   * @param result CloudLoadResult from initial load or retry attempt
   */
  private handleCloudFailure(result: CloudLoadResult): void {
    this.ensureCloudRetry().handleResult(result);
  }

  /**
   * React to the user writing `info.refresh_cloud_data = true`. Performs one
   * full Cloud reload cycle so newly created scenes/snapshots from the Govee
   * Home app show up without an adapter restart.
   */
  private async handleManualCloudRefresh(): Promise<void> {
    if (!this.deviceManager || !this.cloudClient) {
      this.log.info(
        "Refresh cloud data: no Cloud client configured (API key missing) — nothing to do",
      );
      return;
    }
    this.log.info(
      "Refresh cloud data: re-fetching scenes and snapshots for all devices",
    );
    try {
      const changed = await this.deviceManager.refreshSceneData();
      if (changed) {
        await this.loadCloudStates();
      }
      this.log.info("Refresh cloud data: done");
    } catch (e) {
      this.log.warn(
        `Refresh cloud data failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
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
      if (this.appApiPollTimer) {
        this.clearInterval(this.appApiPollTimer);
        this.appApiPollTimer = undefined;
      }
      this.cloudRetry?.dispose();
      this.segmentWizard?.dispose();
      this.lanClient?.stop();
      this.mqttClient?.disconnect();
      this.openapiMqttClient?.disconnect();
      this.rateLimiter?.stop();
      // Remove process-level handlers so an adapter restart doesn't stack them.
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      // onUnload MUST be synchronous — don't await, but silence potential
      // promise rejection during teardown to avoid "unhandled rejection" warnings.
      this.setState("info.connection", { val: false, ack: true }).catch(
        () => {},
      );
      this.setState("info.mqttConnected", { val: false, ack: true }).catch(
        () => {},
      );
      this.setState("info.openapiMqttConnected", {
        val: false,
        ack: true,
      }).catch(() => {});
      this.setState("info.cloudConnected", { val: false, ack: true }).catch(
        () => {},
      );
    } catch {
      // ignore
    }
    callback();
  }

  /**
   * Handle state changes from user (write operations).
   *
   * @param id State ID
   * @param state New state value
   */
  private async onStateChange(
    id: string,
    state: ioBroker.State | null | undefined,
  ): Promise<void> {
    if (!state || state.ack || !this.deviceManager || !this.stateManager) {
      return;
    }

    // Global refresh button — triggers one fresh cloud fetch across all
    // devices and re-builds the state tree. Handy after creating a new
    // snapshot in the Govee Home app without restarting the adapter.
    if (id === `${this.namespace}.info.refresh_cloud_data` && state.val) {
      await this.handleManualCloudRefresh();
      await this.setStateAsync(id, { val: false, ack: true });
      return;
    }

    // Find which device this state belongs to
    const localId = id.replace(`${this.namespace}.`, "");
    if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
      return;
    }

    const device = this.findDeviceForState(localId);
    if (!device) {
      return;
    }

    // Determine command from state suffix after device prefix
    const prefix = this.stateManager.devicePrefix(device);
    const stateSuffix = localId.slice(prefix.length + 1);

    // Resolve dropdown input — accept Number, numeric String, or label
    // (case-insensitive) against the state's common.states map. Returns
    // the canonical key as String so the rest of the handler sees the
    // same shape it always saw (e.g. "1"). Non-dropdown states are
    // passed through unchanged.
    const resolved = await this.resolveDropdownInput(id, state.val);
    if (!resolved.ok) {
      this.log.warn(
        `Unknown dropdown value for ${id}: ${String(state.val)} — ignoring`,
      );
      return;
    }
    const val = resolved.val;

    // Group fan-out: route commands to each member device
    if (device.sku === "BaseGroup" && device.groupMembers) {
      await this.handleGroupFanOut(device, stateSuffix, val);
      await this.setStateAsync(id, { val, ack: true });
      if (
        stateSuffix === "scenes.light_scene" ||
        stateSuffix === "music.music_mode"
      ) {
        await this.resetRelatedDropdowns(
          prefix,
          stateSuffix === "scenes.light_scene" ? "lightScene" : "music",
        );
      }
      return;
    }

    // Handle local snapshot commands (no Cloud/MQTT needed)
    if (
      stateSuffix === "snapshots.snapshot_save" &&
      typeof val === "string" &&
      val.trim()
    ) {
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
    if (
      stateSuffix === "snapshots.snapshot_delete" &&
      typeof val === "string" &&
      val.trim()
    ) {
      this.handleSnapshotDelete(device, val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }

    // Manual segments toggle/list — handler owns the ack because a parse
    // error rewrites manual_mode to false, and an outer ack with the
    // raw value would resurrect the rejected entry.
    if (
      stateSuffix === "segments.manual_mode" ||
      stateSuffix === "segments.manual_list"
    ) {
      await this.handleManualSegmentsChange(device, stateSuffix, val);
      return;
    }

    // Diagnostics export button — throttled to 2 s per device so a repeated
    // or scripted trigger can't produce a burst of JSON serialisations.
    if (stateSuffix === "info.diagnostics_export" && val) {
      const deviceKey = `${device.sku}:${device.deviceId}`;
      const now = Date.now();
      const last = this.diagnosticsLastRun.get(deviceKey) ?? 0;
      if (now - last < 2000) {
        this.log.debug(
          `Diagnostics export throttled for ${device.name} — last run ${now - last}ms ago`,
        );
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
      this.diagnosticsLastRun.set(deviceKey, now);
      const diag = this.deviceManager.generateDiagnostics(
        device,
        this.version ?? "unknown",
      );
      const resultId = `${this.namespace}.${prefix}.info.diagnostics_result`;
      await this.setStateAsync(resultId, {
        val: JSON.stringify(diag, null, 2),
        ack: true,
      });
      await this.setStateAsync(id, { val: false, ack: true });
      this.log.info(`Diagnostics exported for ${device.name} (${device.sku})`);
      return;
    }

    const command = this.stateToCommand(stateSuffix);

    if (!command) {
      // Try generic capability routing via state object metadata
      const obj = await this.getObjectAsync(id);
      const capType = obj?.native?.capabilityType;
      const capInstance = obj?.native?.capabilityInstance;
      if (typeof capType === "string" && typeof capInstance === "string") {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            capType,
            capInstance,
            val,
          );
          await this.setStateAsync(id, { val, ack: true });
        } catch (err) {
          this.log.warn(
            `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.log.debug(`Unknown writable state: ${stateSuffix}`);
      }
      return;
    }

    // Dropdown reset to "---" (value 0) — acknowledge without sending command
    if (
      (command === "lightScene" ||
        command === "diyScene" ||
        command === "snapshot") &&
      (val === "0" || val === 0)
    ) {
      await this.setStateAsync(id, { val, ack: true });
      return;
    }

    // Scene speed: store on device, applied on next scene activation
    if (command === "sceneSpeed") {
      const level = typeof val === "number" ? val : parseInt(String(val), 10);
      if (!isNaN(level)) {
        device.sceneSpeed = level;
      }
      await this.setStateAsync(id, { val, ack: true });
      return;
    }

    try {
      // Music mode: combine all music states into one STRUCT command
      if (command === "music") {
        // music_mode "---" (value 0) — acknowledge without sending command
        if (stateSuffix === "music.music_mode" && (val === "0" || val === 0)) {
          await this.setStateAsync(id, { val, ack: true });
          return;
        }
        await this.sendMusicCommand(device, prefix, stateSuffix, val);
        await this.setStateAsync(id, { val, ack: true });
        // Reset scene/snapshot dropdowns when activating music mode
        if (stateSuffix === "music.music_mode") {
          await this.resetRelatedDropdowns(prefix, "music");
        }
        return;
      }

      await this.deviceManager.sendCommand(device, command, val);
      // Optimistic ack
      await this.setStateAsync(id, { val, ack: true });
      // Reset related dropdowns when switching modes.
      // Power-off is a special case — the device is off, so no mode is
      // active anymore; reset every mode dropdown so the UI reflects the
      // reality (scene/music/snapshot selections are now just history).
      if (command === "power" && val === false) {
        await this.resetModeDropdowns(prefix, "");
      } else {
        await this.resetRelatedDropdowns(prefix, command);
      }
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
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
  private async resolveDropdownInput(
    id: string,
    raw: ioBroker.StateValue,
  ): Promise<{ val: ioBroker.StateValue; ok: boolean }> {
    if (raw === null || raw === undefined) {
      return { val: raw, ok: true };
    }
    // Reset sentinels — let the existing branch handle them.
    if (raw === 0 || raw === "0" || raw === "") {
      return { val: raw, ok: true };
    }
    // Only dropdown candidates have common.states; non-dropdown inputs
    // can't be resolved here so they pass through.
    if (typeof raw !== "number" && typeof raw !== "string") {
      return { val: raw, ok: true };
    }
    const obj = await this.getObjectAsync(id);
    const states = obj?.common?.states;
    if (!states || typeof states !== "object") {
      return { val: raw, ok: true };
    }
    const resolved = resolveStatesValue(raw, states as Record<string, string>);
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
  private async sendMusicCommand(
    device: GoveeDevice,
    prefix: string,
    changedSuffix: string,
    newValue: ioBroker.StateValue,
  ): Promise<void> {
    const musicBase = `${this.namespace}.${prefix}.music`;

    // Read current sibling values
    const modeState = await this.getStateAsync(`${musicBase}.music_mode`);
    const sensState = await this.getStateAsync(
      `${musicBase}.music_sensitivity`,
    );
    const autoState = await this.getStateAsync(`${musicBase}.music_auto_color`);

    // Apply the changed value, use siblings for the rest
    const musicMode =
      changedSuffix === "music.music_mode"
        ? parseInt(String(newValue), 10)
        : parseInt(String(modeState?.val ?? 0), 10);
    const sensitivity =
      changedSuffix === "music.music_sensitivity"
        ? (newValue as number)
        : ((sensState?.val as number) ?? 100);
    const autoColor =
      changedSuffix === "music.music_auto_color"
        ? newValue
          ? 1
          : 0
        : autoState?.val
          ? 1
          : 0;

    if (!musicMode || musicMode === 0) {
      this.log.debug("Music mode not selected, skipping command");
      return;
    }

    // LAN first: send via ptReal BLE if device is on LAN
    if (device.lanIp && this.lanClient) {
      // Read current color for RGB-modes (Spectrum=1, Rolling=2)
      let r = 0,
        g = 0,
        b = 0;
      if (musicMode === 1 || musicMode === 2) {
        const colorState = await this.getStateAsync(
          `${this.namespace}.${prefix}.control.colorRgb`,
        );
        if (colorState?.val && typeof colorState.val === "string") {
          ({ r, g, b } = hexToRgb(colorState.val));
        }
      }
      this.lanClient.setMusicMode(device.lanIp, musicMode, r, g, b);
      return;
    }

    // Cloud fallback
    const structValue: Record<string, unknown> = {
      musicMode,
      sensitivity,
      autoColor,
    };

    await this.deviceManager!.sendCapabilityCommand(
      device,
      "devices.capabilities.music_setting",
      "musicMode",
      structValue,
    );
  }

  /**
   * Called by device-manager when a device state changes
   *
   * @param device Updated device
   * @param state Changed state values
   */
  private onDeviceStateUpdate(
    device: GoveeDevice,
    state: Partial<DeviceState>,
  ): void {
    if (this.stateManager) {
      this.stateManager.updateDeviceState(device, state).catch(() => {});
    }
    this.updateConnectionState();

    // Update group reachability when member online status changes
    if (state.online !== undefined) {
      this.updateGroupReachability();
    }

    // Mirror power-off to mode-dropdown reset. Covers MQTT/LAN-initiated
    // power changes (Govee app or physical remote) so the UI stays honest:
    // a device that's off can't be "playing Aurora-A" anymore.
    if (state.power === false && this.stateManager) {
      const prefix = this.stateManager.devicePrefix(device);
      this.resetModeDropdowns(prefix, "").catch(() => undefined);
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
  private async handleGroupFanOut(
    group: GoveeDevice,
    stateSuffix: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    if (!this.deviceManager || !group.groupMembers) {
      return;
    }

    const devices = this.deviceManager.getDevices();
    const members = this.resolveGroupMembers(group, devices).filter(
      (d) => d.state.online,
    );

    if (members.length === 0) {
      this.log.debug(`Group "${group.name}": no reachable members for fan-out`);
      return;
    }

    const command = this.stateToCommand(stateSuffix);
    if (!command) {
      return;
    }

    // Dropdown reset — no command needed
    if (
      (command === "lightScene" || command === "music") &&
      (value === "0" || value === 0)
    ) {
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
          `Group fan-out to ${member.name}: ${err instanceof Error ? err.message : String(err)}`,
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
  private async fanOutScene(
    group: GoveeDevice,
    member: GoveeDevice,
    value: ioBroker.StateValue,
  ): Promise<void> {
    if (!this.deviceManager || !this.stateManager) {
      return;
    }

    // Get group scene name from dropdown value (1-based index)
    const groupPrefix = this.stateManager.devicePrefix(group);
    const obj = await this.getObjectAsync(
      `${this.namespace}.${groupPrefix}.scenes.light_scene`,
    );
    const groupStates = obj?.common?.states as
      | Record<string, string>
      | undefined;
    const sceneName = groupStates?.[String(value)];
    if (!sceneName) {
      return;
    }

    // Find the same scene name in the member's scene list (1-based)
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
  private async fanOutMusic(
    group: GoveeDevice,
    member: GoveeDevice,
    stateSuffix: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    if (!this.deviceManager || !this.stateManager) {
      return;
    }

    // For sensitivity/auto_color, forward directly — these are numeric values
    if (stateSuffix !== "music.music_mode") {
      await this.sendMusicCommand(
        member,
        this.stateManager.devicePrefix(member),
        stateSuffix,
        value,
      );
      return;
    }

    // Get group music name from dropdown value (1-based index)
    const groupPrefix = this.stateManager.devicePrefix(group);
    const obj = await this.getObjectAsync(
      `${this.namespace}.${groupPrefix}.music.music_mode`,
    );
    const groupStates = obj?.common?.states as
      | Record<string, string>
      | undefined;
    const musicName = groupStates?.[String(value)];
    if (!musicName) {
      return;
    }

    // Find the same music name in the member's music library (1-based)
    const memberIdx = member.musicLibrary.findIndex(
      (m) => m.name === musicName,
    );
    if (memberIdx >= 0) {
      // Build the music command struct for the member
      const memberPrefix = this.stateManager.devicePrefix(member);
      // Temporarily write the music mode value to trigger the member's music command
      await this.sendMusicCommand(
        member,
        memberPrefix,
        "music.music_mode",
        memberIdx + 1,
      );
    }
  }

  /**
   * Resolve group member references to actual device objects.
   *
   * @param group BaseGroup device with groupMembers
   * @param devices Full device list to search
   */
  private resolveGroupMembers(
    group: GoveeDevice,
    devices: GoveeDevice[],
  ): GoveeDevice[] {
    if (!group.groupMembers) {
      return [];
    }
    return group.groupMembers
      .map((m) =>
        devices.find((d) => d.sku === m.sku && d.deviceId === m.deviceId),
      )
      .filter((d): d is GoveeDevice => d !== undefined);
  }

  /**
   * Recalculate info.membersUnreachable for all groups.
   * Called when any device's online status changes.
   */
  private updateGroupReachability(): void {
    if (!this.deviceManager || !this.stateManager) {
      return;
    }
    const devices = this.deviceManager.getDevices();
    for (const group of devices) {
      if (group.sku !== "BaseGroup" || !group.groupMembers) {
        continue;
      }
      const memberDevices = this.resolveGroupMembers(group, devices);
      this.stateManager
        .updateGroupMembersUnreachable(group, memberDevices)
        .catch(() => {});
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
  private refreshDeviceStates(
    device: GoveeDevice,
    allDevices: GoveeDevice[],
  ): void {
    if (!this.stateManager) {
      return;
    }
    const localSnaps = this.localSnapshots?.getSnapshots(
      device.sku,
      device.deviceId,
    );
    let memberDevices: GoveeDevice[] | undefined;
    if (device.sku === "BaseGroup" && device.groupMembers) {
      memberDevices = this.resolveGroupMembers(device, allDevices);
    }
    const stateDefs = buildDeviceStateDefs(device, localSnaps, memberDevices);
    const p = this.stateManager
      .createDeviceStates(device, stateDefs)
      .catch((e) => {
        this.log.error(
          `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    // Until ready, collect so onReady can await the whole initial batch.
    // After ready, fire-and-forget — the queue would otherwise keep growing
    // with resolved promises for the lifetime of the adapter.
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
  private onDeviceListChanged(devices: GoveeDevice[]): void {
    if (!this.stateManager) {
      return;
    }

    for (const device of devices) {
      this.refreshDeviceStates(device, devices);
    }

    this.updateConnectionState();
    // Cache sync happens once after the initial setup completes (see
    // checkAllReady) — triggering here would fire on every device update
    // and spam the log.

    // Keep adapter-level per-device maps (diagnosticsLastRun, ...) aligned
    // with the new device list so removed devices don't leave orphan keys.
    // Skip during the initial boot phase — the startup cleanupTimer handles
    // that pass with proper LAN-scan-settled timing.
    if (this.statesReady) {
      this.reapStaleDevices().catch(() => undefined);
    }
  }

  /** Update global info.connection */
  private updateConnectionState(): void {
    const devices = this.deviceManager?.getDevices() ?? [];
    const hasDevices = devices.length > 0;
    const anyOnline = devices.some((d) => d.state.online);
    const lanRunning = this.lanClient !== null;
    const connected = hasDevices ? anyOnline : lanRunning;
    this.setStateAsync("info.connection", { val: connected, ack: true }).catch(
      () => {},
    );
  }

  /**
   * Delete ioBroker objects for devices no longer present and drop the same
   * devices from adapter-level maps. Called after the initial-discovery
   * window and every time the device list changes so per-device state
   * (diagnostics throttle, etc.) doesn't outlive the device in the tree.
   */
  private async reapStaleDevices(): Promise<void> {
    if (!this.stateManager || !this.deviceManager) {
      return;
    }
    const currentDevices = this.deviceManager.getDevices();
    await this.stateManager.cleanupDevices(currentDevices);

    // Adapter-level maps are keyed by sku:deviceId. Drop any entry that
    // doesn't match a currently-known device so the maps stay bounded.
    const liveKeys = new Set(
      currentDevices.map((d) => `${d.sku}:${d.deviceId}`),
    );
    for (const key of this.diagnosticsLastRun.keys()) {
      if (!liveKeys.has(key)) {
        this.diagnosticsLastRun.delete(key);
      }
    }
  }

  /**
   * Check if all configured channels are initialized and log ready message.
   * Called from MQTT onConnection callback and end of onReady.
   */
  private checkAllReady(): void {
    if (this.readyLogged) {
      return;
    }
    // Wait for first LAN scan (always active)
    if (!this.lanScanDone) {
      return;
    }
    // Wait for initial state creation to complete
    if (!this.statesReady) {
      return;
    }
    // Wait for Cloud init if configured
    if (this.cloudClient && !this.cloudInitDone) {
      return;
    }
    // Wait for MQTT connection if configured
    if (this.mqttClient && !this.mqttClient.connected) {
      return;
    }
    this.readyLogged = true;
    this.logDeviceSummary();
    // Persist any learned changes from the initial load (e.g. resolveSegmentCount
    // collapsing Cloud's 15 to the real 10 on H70D1). One-shot on first ready;
    // subsequent mutations persist themselves (MQTT bumps, wizard, manual-mode).
    this.deviceManager?.saveDevicesToCache();
  }

  /**
   * Log final ready message with device/group/channel summary.
   */
  private logDeviceSummary(): void {
    if (!this.deviceManager) {
      return;
    }
    const all = this.deviceManager.getDevices();
    const devices = all.filter((d) => d.sku !== "BaseGroup");
    const groups = all.filter((d) => d.sku === "BaseGroup");

    const channels: string[] = ["LAN"];
    if (this.cloudWasConnected) {
      channels.push("Cloud");
    }
    if (this.mqttClient?.connected) {
      channels.push("MQTT");
    }

    // If a channel is configured but not connected, note it honestly —
    // background reconnect will continue and log "restored" on success.
    const pending: string[] = [];
    if (this.cloudClient && !this.cloudWasConnected) {
      pending.push("Cloud");
    }
    if (this.mqttClient && !this.mqttClient.connected) {
      pending.push("MQTT");
    }
    const pendingNote =
      pending.length > 0
        ? `, ${pending.join("+")} noch im Aufbau — wird im Hintergrund fortgesetzt`
        : "";

    if (devices.length === 0 && groups.length === 0) {
      this.log.info(
        `Govee adapter ready — no devices found (channels: ${channels.join("+")}${pendingNote})`,
      );
      return;
    }

    // Summary line
    const parts: string[] = [];
    if (devices.length > 0) {
      parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
    }
    if (groups.length > 0) {
      parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
    }
    this.log.info(
      `Govee adapter ready — ${parts.join(", ")} (channels: ${channels.join("+")}${pendingNote})`,
    );
  }

  /**
   * Load current state for all Cloud devices and populate state values.
   * Called once after initial Cloud device list load.
   */
  private async loadCloudStates(): Promise<void> {
    if (!this.cloudClient || !this.deviceManager || !this.stateManager) {
      return;
    }

    const devices = this.deviceManager.getDevices();
    // LAN-first: never overwrite LAN states with Cloud values
    const lanStateIds = new Set(getDefaultLanStates().map((s) => s.id));
    let loaded = 0;

    for (const device of devices) {
      if (!device.channels.cloud || device.capabilities.length === 0) {
        continue;
      }

      try {
        const caps = await this.cloudClient.getDeviceState(
          device.sku,
          device.deviceId,
        );
        const prefix = this.stateManager.devicePrefix(device);

        const writes: Promise<unknown>[] = [];
        for (const cap of caps) {
          const mapped = mapCloudStateValue(cap);
          if (!mapped) {
            continue;
          }
          // Skip LAN-covered states for LAN-capable devices
          if (device.lanIp && lanStateIds.has(mapped.stateId)) {
            continue;
          }
          const statePath = this.stateManager.resolveStatePath(
            prefix,
            mapped.stateId,
          );
          // Fire-and-forget — States are created before loadCloudStates runs;
          // a rejection here means the state was deleted out-of-band and
          // can be safely ignored.
          writes.push(
            this.setStateAsync(statePath, {
              val: mapped.value,
              ack: true,
            }).catch(() => undefined),
          );
        }
        await Promise.all(writes);
        loaded++;
      } catch {
        this.log.debug(
          `Could not load Cloud state for ${device.name} (${device.sku})`,
        );
      }
    }

    if (loaded > 0) {
      this.log.debug(`Cloud states loaded for ${loaded} devices`);
    }
  }

  /**
   * Apply a list of synthesized Cloud-state capabilities to a single
   * device — the App-API poll and OpenAPI-MQTT events both use this path
   * so their values flow through the same `mapCloudStateValue` pipeline
   * that polled Cloud states use.
   *
   * @param device Target Govee device
   * @param caps Capabilities to apply
   */
  private async applyCloudCapabilities(
    device: GoveeDevice,
    caps: CloudStateCapability[],
  ): Promise<void> {
    if (!this.stateManager) {
      return;
    }
    const lanStateIds = new Set(getDefaultLanStates().map((s) => s.id));
    const prefix = this.stateManager.devicePrefix(device);
    const writes: Promise<unknown>[] = [];
    for (const cap of caps) {
      const mapped = mapCloudStateValue(cap);
      if (!mapped) {
        continue;
      }
      // Skip LAN-covered states for LAN-capable devices — same rule as
      // the Cloud-poll path so LAN sub-second updates aren't overwritten.
      if (device.lanIp && lanStateIds.has(mapped.stateId)) {
        continue;
      }
      const statePath = this.stateManager.resolveStatePath(
        prefix,
        mapped.stateId,
      );
      writes.push(
        this.setStateAsync(statePath, {
          val: mapped.value,
          ack: true,
        }).catch(() => undefined),
      );
    }
    await Promise.all(writes);
  }

  /**
   * Find device for a state ID
   *
   * @param localId Local state ID without namespace prefix
   */
  private findDeviceForState(localId: string): GoveeDevice | undefined {
    if (!this.deviceManager || !this.stateManager) {
      return undefined;
    }

    for (const device of this.deviceManager.getDevices()) {
      const prefix = this.stateManager.devicePrefix(device);
      if (localId.startsWith(`${prefix}.`)) {
        return device;
      }
    }
    return undefined;
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
  private stateToCommand(suffix: string): string | null {
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
  private async applyManualSegments(
    device: GoveeDevice,
    mode: boolean,
    indices?: number[],
  ): Promise<void> {
    if (!this.stateManager) {
      return;
    }
    device.manualMode = mode;
    device.manualSegments =
      mode && Array.isArray(indices) && indices.length > 0
        ? indices.slice()
        : undefined;
    await this.stateManager.createSegmentStates(device);
    this.deviceManager?.persistDeviceToCache(device);
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
  private async handleManualSegmentsChange(
    device: GoveeDevice,
    suffix: string,
    newValue: unknown,
  ): Promise<void> {
    // Peer value that wasn't just written comes from the device object
    // (kept in sync via createSegmentStates), not a separate state read.
    const modeVal =
      suffix === "segments.manual_mode"
        ? Boolean(newValue)
        : device.manualMode === true;
    const listVal =
      suffix === "segments.manual_list"
        ? typeof newValue === "string"
          ? newValue
          : ""
        : Array.isArray(device.manualSegments)
          ? device.manualSegments.join(",")
          : "";

    if (!modeVal) {
      this.log.info(
        `${device.name}: manual segments disabled — strip treated as contiguous`,
      );
      await this.applyManualSegments(device, false);
      return;
    }

    // Upper bound: cap at the real length if known, otherwise the protocol limit.
    // Real length can still grow via MQTT discovery, so SEGMENT_HARD_MAX is the
    // absolute safety net.
    const maxIndex =
      typeof device.segmentCount === "number" && device.segmentCount > 0
        ? device.segmentCount - 1
        : SEGMENT_HARD_MAX;
    const parsed = parseSegmentList(listVal, maxIndex);
    if (parsed.error) {
      this.log.warn(
        `${device.name}: manual_list invalid (${parsed.error}) — disabling manual mode`,
      );
      await this.applyManualSegments(device, false);
      return;
    }

    this.log.info(
      `${device.name}: manual segments active — ${parsed.indices.length} physical indices (${listVal})`,
    );
    await this.applyManualSegments(device, true, parsed.indices);
  }

  // ───────── Segment-Detection-Wizard ─────────

  /**
   * Handle incoming sendTo messages (from jsonConfig).
   *
   * @param obj ioBroker message object
   */
  private onMessage(obj: ioBroker.Message): void {
    if (!obj?.command) {
      return;
    }
    // Never let a rejection bubble up from the event handler — the ioBroker
    // event emitter doesn't catch it, which would crash the adapter.
    this.handleMessage(obj).catch((e) => {
      this.log.warn(
        `onMessage handler crashed for ${obj.command}: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.sendMessageResponse(obj, {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  private async handleMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (obj.command === "getSegmentDevices") {
        const devices = this.deviceManager?.getDevices() ?? [];
        const list = devices
          .filter(
            (d) =>
              d.sku !== "BaseGroup" &&
              d.state?.online === true &&
              resolveSegmentCount(d) > 0,
          )
          .map((d) => {
            const count = resolveSegmentCount(d);
            return {
              value: this.deviceKeyFor(d),
              label: `${d.name} (${d.sku}, bisher ${count} Segmente)`,
            };
          });
        // selectSendTo expects the array directly, not wrapped in an object
        this.sendMessageResponse(obj, list);
        return;
      }
      if (obj.command === "segmentWizard") {
        const payload = (obj.message ?? {}) as {
          action?: string;
          device?: string;
        };
        const response = await this.runWizardStep(
          payload.action ?? "",
          payload.device ?? "",
        );
        this.sendMessageResponse(obj, response);
        return;
      }
    } catch (e) {
      this.log.warn(
        `onMessage failed for ${obj.command}: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.sendMessageResponse(obj, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private sendMessageResponse(obj: ioBroker.Message, data: unknown): void {
    if (obj.callback && obj.from) {
      this.sendTo(
        obj.from,
        obj.command,
        data as Record<string, unknown>,
        obj.callback,
      );
    }
  }

  /**
   * Stable device key for wizard session tracking.
   *
   * @param device Target device
   */
  private deviceKeyFor(device: GoveeDevice): string {
    return `${device.sku}:${device.deviceId}`;
  }

  private findDeviceByKey(key: string): GoveeDevice | undefined {
    const devices = this.deviceManager?.getDevices() ?? [];
    return devices.find((d) => this.deviceKeyFor(d) === key);
  }

  /** Construct the host object passed into SegmentWizard. */
  private buildWizardHost(): WizardHost {
    return {
      log: this.log,
      getState: (id) => this.getStateAsync(id),
      sendCommand: async (device, command, value) => {
        await this.deviceManager?.sendCommand(device, command, value);
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
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        this.lanClient.restoreAllSegments(
          device.lanIp,
          total,
          r,
          g,
          b,
          brightness,
        );
        return Promise.resolve(true);
      },
      findDevice: (key) => this.findDeviceByKey(key),
      namespace: this.namespace,
      devicePrefix: (device) => this.stateManager?.devicePrefix(device) ?? "",
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: (h) => this.clearTimeout(h as ioBroker.Timeout),
      applyWizardResult: (device, result) =>
        this.applyWizardResult(device, result),
      getLanguage: () => this.adminLanguage,
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
  private async applyWizardResult(
    device: GoveeDevice,
    result: WizardResult,
  ): Promise<void> {
    device.segmentCount = result.segmentCount;
    if (result.hasGaps) {
      const parsed = parseSegmentList(
        result.manualList,
        result.segmentCount - 1,
      );
      await this.applyManualSegments(
        device,
        true,
        parsed.error ? undefined : parsed.indices,
      );
    } else {
      await this.applyManualSegments(device, false);
    }
    this.log.debug(
      `applyWizardResult: ${device.sku} → segmentCount=${result.segmentCount}, ` +
        `manualMode=${device.manualMode}, list="${result.manualList}"`,
    );
  }

  /**
   * Execute one wizard step (start/yes/no/abort). Delegates to
   * {@link SegmentWizard} — see `lib/segment-wizard.ts`.
   *
   * @param action "start" | "yes" | "no" | "abort"
   * @param deviceKey device identifier (only required for "start")
   */
  private async runWizardStep(
    action: string,
    deviceKey: string,
  ): Promise<Record<string, unknown>> {
    if (!this.segmentWizard) {
      this.segmentWizard = new SegmentWizard(this.buildWizardHost());
    }
    const response = await this.segmentWizard.runStep(action, deviceKey);
    // Mirror the current wizard status into a plain state so admin's
    // `type: "state"` component can show it live via state subscription.
    const statusText = this.segmentWizard.getStatusText();
    await this.setStateAsync("info.wizardStatus", {
      val: statusText,
      ack: true,
    });
    return response;
  }

  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  private async handleSnapshotSave(
    device: GoveeDevice,
    name: string,
  ): Promise<void> {
    if (!this.localSnapshots || !this.stateManager) {
      return;
    }

    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;

    // Read device-level state in parallel
    const [powerState, brightState, colorState, ctState] = await Promise.all([
      this.getStateAsync(`${ns}.${prefix}.control.power`),
      this.getStateAsync(`${ns}.${prefix}.control.brightness`),
      this.getStateAsync(`${ns}.${prefix}.control.colorRgb`),
      this.getStateAsync(`${ns}.${prefix}.control.colorTemperature`),
    ]);

    // Read per-segment states in parallel — 20 segments × 2 reads used to run
    // sequentially (~80ms), parallel completes in a single round-trip.
    let segments: SnapshotSegment[] | undefined;
    const segCount = device.segmentCount ?? 0;
    if (segCount > 0) {
      const segReads: Promise<
        [ioBroker.State | null | undefined, ioBroker.State | null | undefined]
      >[] = [];
      for (let i = 0; i < segCount; i++) {
        segReads.push(
          Promise.all([
            this.getStateAsync(`${ns}.${prefix}.segments.${i}.color`),
            this.getStateAsync(`${ns}.${prefix}.segments.${i}.brightness`),
          ]),
        );
      }
      const segResults = await Promise.all(segReads);
      segments = segResults.map(([segColor, segBright]) => ({
        color: typeof segColor?.val === "string" ? segColor.val : "#000000",
        brightness: typeof segBright?.val === "number" ? segBright.val : 100,
      }));
    }

    const snapshot: LocalSnapshot = {
      name,
      power: powerState?.val === true,
      brightness: typeof brightState?.val === "number" ? brightState.val : 0,
      colorRgb:
        typeof colorState?.val === "string" ? colorState.val : "#000000",
      colorTemperature: typeof ctState?.val === "number" ? ctState.val : 0,
      segments,
      savedAt: Date.now(),
    };

    this.localSnapshots.saveSnapshot(device.sku, device.deviceId, snapshot);
    this.log.info(`Local snapshot saved: "${name}" for ${device.name}`);

    // Targeted refresh — only this device's snapshot_local dropdown changed.
    this.refreshDeviceStates(device, this.deviceManager!.getDevices());
  }

  /**
   * Restore a local snapshot by index.
   *
   * @param device Target device
   * @param val Dropdown index value
   */
  private async handleSnapshotRestore(
    device: GoveeDevice,
    val: ioBroker.StateValue,
  ): Promise<void> {
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

    // Send each state via LAN → Cloud routing
    await this.deviceManager.sendCommand(device, "power", snap.power);
    if (snap.power) {
      await this.deviceManager.sendCommand(
        device,
        "brightness",
        snap.brightness,
      );
      if (snap.colorTemperature > 0) {
        await this.deviceManager.sendCommand(
          device,
          "colorTemperature",
          snap.colorTemperature,
        );
      } else {
        await this.deviceManager.sendCommand(device, "colorRgb", snap.colorRgb);
      }

      // Restore per-segment states via ptReal
      if (snap.segments && snap.segments.length > 0) {
        for (let i = 0; i < snap.segments.length; i++) {
          const seg = snap.segments[i];
          await this.deviceManager.sendCommand(
            device,
            `segmentColor:${i}`,
            seg.color,
          );
          await this.deviceManager.sendCommand(
            device,
            `segmentBrightness:${i}`,
            seg.brightness,
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
  private handleSnapshotDelete(device: GoveeDevice, name: string): void {
    if (!this.localSnapshots) {
      return;
    }

    if (this.localSnapshots.deleteSnapshot(device.sku, device.deviceId, name)) {
      this.log.info(`Local snapshot deleted: "${name}" for ${device.name}`);
      // Targeted refresh — only this device's snapshot_local dropdown changed.
      this.refreshDeviceStates(device, this.deviceManager!.getDevices());
    } else {
      this.log.warn(`Local snapshot "${name}" not found for ${device.name}`);
    }
  }

  /** Dropdowns whose value is a mode-selection — reset to "---" (0) when the mode stops. */
  private static readonly MODE_DROPDOWNS = [
    "scenes.light_scene",
    "scenes.diy_scene",
    "snapshots.snapshot_cloud",
    "snapshots.snapshot_local",
    "music.music_mode",
  ];

  /** Map command → its own dropdown path (excluded from reset when that mode is the one that was just activated). */
  private static readonly COMMAND_DROPDOWN: Record<string, string> = {
    lightScene: "scenes.light_scene",
    diyScene: "scenes.diy_scene",
    snapshot: "snapshots.snapshot_cloud",
    snapshotLocal: "snapshots.snapshot_local",
    music: "music.music_mode",
    colorRgb: "",
    colorTemperature: "",
  };

  /**
   * Reset related dropdown states when switching between scenes/snapshots/colors.
   * Each mode-switch resets all OTHER mode dropdowns to "---" (0).
   *
   * @param prefix Device state prefix
   * @param activeCommand The command that was just executed
   */
  private async resetRelatedDropdowns(
    prefix: string,
    activeCommand: string,
  ): Promise<void> {
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
  private async resetModeDropdowns(
    prefix: string,
    keep: string,
  ): Promise<void> {
    await Promise.all(
      GoveeAdapter.MODE_DROPDOWNS.filter((d) => d !== keep).map(
        async (dropdown) => {
          const stateId = `${this.namespace}.${prefix}.${dropdown}`;
          const current = await this.getStateAsync(stateId);
          if (current?.val && current.val !== "0" && current.val !== 0) {
            await this.setStateAsync(stateId, { val: "0", ack: true });
          }
        },
      ),
    );
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
