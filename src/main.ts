import * as path from "node:path";
import * as utils from "@iobroker/adapter-core";
import {
  buildDeviceStateDefs,
  getDefaultLanStates,
  mapCloudStateValue,
} from "./lib/capability-mapper.js";
import { loadCommunityQuirks } from "./lib/device-quirks.js";
import { DeviceManager } from "./lib/device-manager.js";
import { GoveeApiClient } from "./lib/govee-api-client.js";
import { GoveeCloudClient } from "./lib/govee-cloud-client.js";
import { GoveeLanClient } from "./lib/govee-lan-client.js";
import { GoveeMqttClient } from "./lib/govee-mqtt-client.js";
import {
  LocalSnapshotStore,
  type LocalSnapshot,
  type SnapshotSegment,
} from "./lib/local-snapshots.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { SkuCache } from "./lib/sku-cache.js";
import { StateManager } from "./lib/state-manager.js";
import {
  hexToRgb,
  parseSegmentList,
  rgbIntToHex,
  rgbToHex,
  type AdapterConfig,
  type CloudLoadResult,
  type DeviceState,
  type GoveeDevice,
} from "./lib/types.js";

/** Rate limit defaults */
const FULL_LIMITS = { perMinute: 8, perDay: 9000 };
const SHARED_LIMITS = { perMinute: 4, perDay: 4500 };
const SIBLING_ALIVE_ID = "system.adapter.govee-appliances.0.alive";

/** Session state for the interactive segment-detection wizard */
interface SegmentWizardSession {
  /** Target device key (sku_shortid) */
  deviceKey: string;
  /** Device SKU for display */
  sku: string;
  /** Display name */
  name: string;
  /** Current segment index being tested */
  current: number;
  /** Total number of segments to test (from device.segmentCount) */
  total: number;
  /** Indices confirmed visible by user */
  visible: number[];
  /** Timestamp of session start (for idle-timeout) */
  startedAt: number;
  /** Baseline snapshot for restore on abort/finish */
  baseline: {
    power?: boolean;
    brightness?: number;
    colorRgb?: string;
    segmentColors: { idx: number; color: string; brightness: number }[];
  };
}

class GoveeAdapter extends utils.Adapter {
  private deviceManager: DeviceManager | null = null;
  private stateManager: StateManager | null = null;
  private lanClient: GoveeLanClient | null = null;
  private mqttClient: GoveeMqttClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  private skuCache: SkuCache | null = null;
  private localSnapshots: LocalSnapshotStore | null = null;
  private cloudWasConnected = false;
  private readyLogged = false;
  private cloudInitDone = false;
  private lanScanDone = false;
  private statesReady = false;
  private siblingActive = false;
  private stateCreationQueue: Promise<void>[] = [];
  private lanScanTimer: ioBroker.Timeout | undefined;
  private cleanupTimer: ioBroker.Timeout | undefined;
  private readyTimer: ioBroker.Timeout | undefined;
  private cloudRetryTimer: ioBroker.Timeout | undefined;
  private wizardSession: SegmentWizardSession | null = null;
  private wizardTimeoutTimer: ioBroker.Timeout | undefined;

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("message", (obj) => this.onMessage(obj));
    this.on("unload", (callback) => this.onUnload(callback));
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
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
    await this.setStateAsync("info.cloudConnected", { val: false, ack: true });

    this.stateManager = new StateManager(this);
    // General groups online state (reflects Cloud connection)
    await this.stateManager.createGroupsOnlineState(false);
    this.deviceManager = new DeviceManager(this.log);
    const dataDir = utils.getAbsoluteInstanceDataDir(this);

    // Load community quirks from persistent data directory
    const quirksPath = path.join(dataDir, "community-quirks.json");
    loadCommunityQuirks(quirksPath, this.log);
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
        // Request status after discovery
        this.lanClient!.requestStatus(lanDevice.ip);
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
      );

      // Forward bearer token to API client for authenticated library endpoints
      if (this.mqttClient.token) {
        apiClient.setBearerToken(this.mqttClient.token);
      }
    }

    // --- Device data: Cache first, Cloud only on cache miss ---
    const cachedOk = this.deviceManager.loadFromCache();

    if (config.apiKey) {
      this.cloudClient = new GoveeCloudClient(config.apiKey, this.log);
      this.deviceManager.setCloudClient(this.cloudClient);

      this.rateLimiter = new RateLimiter(
        this.log,
        this,
        FULL_LIMITS.perMinute,
        FULL_LIMITS.perDay,
      );
      this.rateLimiter.start();
      this.deviceManager.setRateLimiter(this.rateLimiter);

      // Detect sibling adapter (govee-appliances) for shared rate limits
      await this.detectSiblingAdapter();

      if (!cachedOk) {
        // No cache — first start, fetch from Cloud with 60s hard-timeout.
        // If Cloud hangs/fails, we don't want to block adapter startup indefinitely.
        const result = await this.cloudInitWithTimeout();
        this.cloudWasConnected = result.ok;
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

    // Wait for all state creation from cache/cloud load to complete
    await Promise.all(this.stateCreationQueue);
    this.stateCreationQueue = [];
    this.statesReady = true;

    // Subscribe to all writable device and group states
    await this.subscribeStatesAsync("devices.*");
    await this.subscribeStatesAsync("groups.*");

    // Cleanup stale devices after initial discovery (30s delay for LAN scan)
    this.cleanupTimer = this.setTimeout(() => {
      if (this.stateManager && this.deviceManager) {
        this.stateManager
          .cleanupDevices(this.deviceManager.getDevices())
          .catch(() => {});
      }
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

  /**
   * React to a failed Cloud load — schedule retry or stop depending on reason.
   *
   * @param result CloudLoadResult from initial load or retry attempt
   */
  private handleCloudFailure(result: CloudLoadResult): void {
    if (result.ok) {
      return;
    }
    switch (result.reason) {
      case "auth-failed":
        this.log.warn(
          `Govee Cloud: authentication failed — check API-Key in adapter settings. Not retrying automatically.`,
        );
        // Kein Retry bei Auth-Fail — User muss Config korrigieren
        return;
      case "rate-limited":
        this.log.warn(
          `Govee Cloud: rate-limited — pausing for ${Math.round(result.retryAfterMs / 1000)}s before retry`,
        );
        this.scheduleCloudRetry(result.retryAfterMs);
        return;
      case "transient":
      default:
        // Netzwerk/Timeout — moderater Retry nach 5 Min
        this.scheduleCloudRetry(5 * 60_000);
        return;
    }
  }

  /**
   * Background-Retry für Cloud mit expliziter Delay (aus Rate-Limit oder Standard).
   * Erneuter Versuch; bei Erfolg "restored"-Log + loadCloudStates.
   *
   * @param delayMs Wartezeit bis zum nächsten Retry in Millisekunden
   */
  private scheduleCloudRetry(delayMs: number): void {
    if (this.cloudRetryTimer) {
      return; // already scheduled
    }
    this.cloudRetryTimer = this.setTimeout(() => {
      this.cloudRetryTimer = undefined;
      void this.retryCloudOnce();
    }, delayMs);
  }

  private async retryCloudOnce(): Promise<void> {
    if (!this.deviceManager || this.cloudWasConnected) {
      return; // meanwhile restored elsewhere
    }
    const result = await this.cloudInitWithTimeout();
    if (result.ok) {
      this.cloudWasConnected = true;
      this.log.info("Govee Cloud connection restored");
      this.setStateAsync("info.cloudConnected", { val: true, ack: true }).catch(
        () => {},
      );
      this.stateManager?.updateGroupsOnline(true).catch(() => {});
      await this.loadCloudStates();
    } else {
      this.handleCloudFailure(result);
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
      if (this.cloudRetryTimer) {
        this.clearTimeout(this.cloudRetryTimer);
      }
      if (this.wizardTimeoutTimer) {
        this.clearTimeout(this.wizardTimeoutTimer);
      }
      this.lanClient?.stop();
      this.mqttClient?.disconnect();
      this.rateLimiter?.stop();
      void this.setState("info.connection", { val: false, ack: true });
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
    // Sibling adapter alive state change (foreign state, always ack)
    if (id === SIBLING_ALIVE_ID) {
      this.applySiblingLimits(state?.val === true);
      return;
    }

    if (!state || state.ack || !this.deviceManager || !this.stateManager) {
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

    // Group fan-out: route commands to each member device
    if (device.sku === "BaseGroup" && device.groupMembers) {
      await this.handleGroupFanOut(device, stateSuffix, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
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
      typeof state.val === "string" &&
      state.val.trim()
    ) {
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
    if (
      stateSuffix === "snapshots.snapshot_delete" &&
      typeof state.val === "string" &&
      state.val.trim()
    ) {
      this.handleSnapshotDelete(device, state.val.trim());
      await this.setStateAsync(id, { val: "", ack: true });
      return;
    }

    // Manual segments toggle/list — reconfigure segment tree on change
    if (
      stateSuffix === "segments.manual_mode" ||
      stateSuffix === "segments.manual_list"
    ) {
      await this.handleManualSegmentsChange(device, stateSuffix, state.val);
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }

    // Diagnostics export button
    if (stateSuffix === "info.diagnostics_export" && state.val) {
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
      if (obj?.native?.capabilityType && obj?.native?.capabilityInstance) {
        try {
          await this.deviceManager.sendCapabilityCommand(
            device,
            obj.native.capabilityType as string,
            obj.native.capabilityInstance as string,
            state.val,
          );
          await this.setStateAsync(id, { val: state.val, ack: true });
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
      (state.val === "0" || state.val === 0)
    ) {
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }

    // Scene speed: store on device, applied on next scene activation
    if (command === "sceneSpeed") {
      const level =
        typeof state.val === "number"
          ? state.val
          : parseInt(String(state.val), 10);
      if (!isNaN(level)) {
        device.sceneSpeed = level;
      }
      await this.setStateAsync(id, { val: state.val, ack: true });
      return;
    }

    try {
      // Music mode: combine all music states into one STRUCT command
      if (command === "music") {
        // music_mode "---" (value 0) — acknowledge without sending command
        if (
          stateSuffix === "music.music_mode" &&
          (state.val === "0" || state.val === 0)
        ) {
          await this.setStateAsync(id, { val: state.val, ack: true });
          return;
        }
        await this.sendMusicCommand(device, prefix, stateSuffix, state.val);
        await this.setStateAsync(id, { val: state.val, ack: true });
        // Reset scene/snapshot dropdowns when activating music mode
        if (stateSuffix === "music.music_mode") {
          await this.resetRelatedDropdowns(prefix, "music");
        }
        return;
      }

      await this.deviceManager.sendCommand(device, command, state.val);
      // Optimistic ack
      await this.setStateAsync(id, { val: state.val, ack: true });
      // Reset related dropdowns when switching modes
      await this.resetRelatedDropdowns(prefix, command);
    } catch (err) {
      this.log.warn(
        `Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`,
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
   * Called by device-manager when the device list changes
   *
   * @param devices Current list of all devices
   */
  private onDeviceListChanged(devices: GoveeDevice[]): void {
    if (!this.stateManager) {
      return;
    }

    for (const device of devices) {
      const localSnaps = this.localSnapshots?.getSnapshots(
        device.sku,
        device.deviceId,
      );

      // Resolve group members for BaseGroup devices
      let memberDevices: GoveeDevice[] | undefined;
      if (device.sku === "BaseGroup" && device.groupMembers) {
        memberDevices = this.resolveGroupMembers(device, devices);
      }

      const stateDefs = buildDeviceStateDefs(device, localSnaps, memberDevices);

      const p = this.stateManager
        .createDeviceStates(device, stateDefs)
        .catch((e) => {
          this.log.error(
            `createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      this.stateCreationQueue.push(p);
    }

    this.updateConnectionState();
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
   * Detect if sibling adapter (govee-appliances) is running and adjust rate limits.
   * Subscribes to alive state for dynamic updates.
   */
  private async detectSiblingAdapter(): Promise<void> {
    try {
      const alive = await this.getForeignStateAsync(SIBLING_ALIVE_ID);
      this.applySiblingLimits(alive?.val === true);
      await this.subscribeForeignStatesAsync(SIBLING_ALIVE_ID);
    } catch {
      // Sibling not installed — use full limits
      this.applySiblingLimits(false);
    }
  }

  /**
   * Apply rate limits based on sibling adapter presence.
   *
   * @param siblingAlive Whether the sibling adapter is running
   */
  private applySiblingLimits(siblingAlive: boolean): void {
    if (!this.rateLimiter || this.siblingActive === siblingAlive) {
      return;
    }
    this.siblingActive = siblingAlive;

    if (siblingAlive) {
      this.rateLimiter.updateLimits(
        SHARED_LIMITS.perMinute,
        SHARED_LIMITS.perDay,
      );
      this.log.info(
        `govee-appliances detected — sharing API budget (${SHARED_LIMITS.perMinute}/min, ${SHARED_LIMITS.perDay}/day)`,
      );
    } else {
      this.rateLimiter.updateLimits(FULL_LIMITS.perMinute, FULL_LIMITS.perDay);
      this.log.info(
        `govee-appliances not active — using full API budget (${FULL_LIMITS.perMinute}/min, ${FULL_LIMITS.perDay}/day)`,
      );
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
          const obj = await this.getObjectAsync(statePath);
          if (obj) {
            await this.setStateAsync(statePath, {
              val: mapped.value,
              ack: true,
            });
          }
        }
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
   * Map state suffix to command name
   *
   * @param suffix State ID suffix (e.g. "power", "brightness")
   */
  private stateToCommand(suffix: string): string | null {
    // Control channel — basic device controls
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
    // Scenes channel
    if (suffix === "scenes.light_scene") {
      return "lightScene";
    }
    if (suffix === "scenes.diy_scene") {
      return "diyScene";
    }
    if (suffix === "scenes.scene_speed") {
      return "sceneSpeed";
    }
    // Music channel
    if (
      suffix === "music.music_mode" ||
      suffix === "music.music_sensitivity" ||
      suffix === "music.music_auto_color"
    ) {
      return "music";
    }
    // Snapshots channel
    if (suffix === "snapshots.snapshot") {
      return "snapshot";
    }
    // Segment commands — encode segment index in command name
    const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
    if (segColorMatch) {
      return `segmentColor:${segColorMatch[1]}`;
    }
    const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
    if (segBrightMatch) {
      return `segmentBrightness:${segBrightMatch[1]}`;
    }
    // Batch segment command
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
  private async handleManualSegmentsChange(
    device: GoveeDevice,
    suffix: string,
    newValue: unknown,
  ): Promise<void> {
    if (!this.stateManager) {
      return;
    }
    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;

    // Read both states (the one not being written we get from current state)
    const modeVal =
      suffix === "segments.manual_mode"
        ? Boolean(newValue)
        : Boolean(
            (await this.getStateAsync(`${ns}.${prefix}.segments.manual_mode`))
              ?.val,
          );
    const listVal =
      suffix === "segments.manual_list"
        ? typeof newValue === "string"
          ? newValue
          : ""
        : String(
            (await this.getStateAsync(`${ns}.${prefix}.segments.manual_list`))
              ?.val ?? "",
          );

    if (!modeVal) {
      // Manual mode off → back to Cloud defaults
      device.manualMode = false;
      device.manualSegments = undefined;
      this.log.info(
        `${device.name}: manual segments disabled — using Cloud defaults`,
      );
      await this.stateManager.createSegmentStates(device);
      return;
    }

    // Manual mode on: parse list, validate against device.segmentCount
    const maxIdx = Math.max(0, (device.segmentCount ?? 0) - 1);
    const parsed = parseSegmentList(listVal, maxIdx);
    if (parsed.error) {
      this.log.warn(
        `${device.name}: manual_list invalid (${parsed.error}) — disabling manual mode`,
      );
      // Revert toggle in state and runtime
      device.manualMode = false;
      device.manualSegments = undefined;
      await this.setStateAsync(`${ns}.${prefix}.segments.manual_mode`, {
        val: false,
        ack: true,
      });
      return;
    }

    device.manualMode = true;
    device.manualSegments = parsed.indices;
    this.log.info(
      `${device.name}: manual segments active — ${parsed.indices.length} physical segments (${listVal})`,
    );
    await this.stateManager.createSegmentStates(device);
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
    void this.handleMessage(obj);
  }

  private async handleMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (obj.command === "getSegmentDevices") {
        const devices = this.deviceManager?.getDevices() ?? [];
        const list = devices
          .filter(
            (d) =>
              d.sku !== "BaseGroup" &&
              typeof d.segmentCount === "number" &&
              d.segmentCount > 0,
          )
          .map((d) => ({
            value: this.deviceKeyFor(d),
            label: `${d.name} (${d.sku}, ${d.segmentCount} segs)`,
          }));
        this.sendMessageResponse(obj, { list });
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

  private sendMessageResponse(
    obj: ioBroker.Message,
    data: Record<string, unknown>,
  ): void {
    if (obj.callback && obj.from) {
      this.sendTo(obj.from, obj.command, data, obj.callback);
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

  /**
   * Execute one wizard step (start/yes/no/abort).
   *
   * @param action "start" | "yes" | "no" | "abort"
   * @param deviceKey device identifier (only required for "start")
   */
  private async runWizardStep(
    action: string,
    deviceKey: string,
  ): Promise<Record<string, unknown>> {
    if (action === "start") {
      return this.wizardStart(deviceKey);
    }
    if (!this.wizardSession) {
      return {
        error: "Kein Wizard aktiv. Bitte zuerst 'Start' klicken.",
      };
    }
    if (action === "abort") {
      return this.wizardAbort();
    }
    if (action === "yes" || action === "no") {
      return this.wizardAnswer(action === "yes");
    }
    return { error: `Unbekannte Aktion: ${action}` };
  }

  private async wizardStart(
    deviceKey: string,
  ): Promise<Record<string, unknown>> {
    if (this.wizardSession) {
      return {
        error: `Wizard bereits aktiv für ${this.wizardSession.name}. Bitte zuerst abbrechen.`,
      };
    }
    const device = this.findDeviceByKey(deviceKey);
    if (!device) {
      return { error: `Gerät nicht gefunden: ${deviceKey}` };
    }
    const total = device.segmentCount ?? 0;
    if (total <= 0) {
      return { error: `${device.name} hat keine Segmente (segmentCount=0)` };
    }

    // Capture baseline
    const baseline = await this.captureWizardBaseline(device);

    this.wizardSession = {
      deviceKey,
      sku: device.sku,
      name: device.name,
      current: 0,
      total,
      visible: [],
      startedAt: Date.now(),
      baseline,
    };
    this.scheduleWizardTimeout();

    // Step 1: all segments black, first segment bright white
    await this.setAllSegmentsBlack(device);
    await this.flashSegment(device, 0);

    return {
      status: `Segment 0 von ${total} leuchtet weiß. Siehst du Licht auf dem Strip?`,
      progress: `1 / ${total}`,
      active: true,
    };
  }

  private async wizardAnswer(
    wasVisible: boolean,
  ): Promise<Record<string, unknown>> {
    if (!this.wizardSession) {
      return { error: "Kein Wizard aktiv" };
    }
    const session = this.wizardSession;
    if (wasVisible) {
      session.visible.push(session.current);
    }
    session.current += 1;
    this.scheduleWizardTimeout();

    if (session.current >= session.total) {
      return this.wizardFinish();
    }

    const device = this.findDeviceByKey(session.deviceKey);
    if (!device) {
      this.wizardSession = null;
      return { error: "Gerät während des Wizards verschwunden" };
    }
    await this.flashSegment(device, session.current);
    return {
      status: `Segment ${session.current} von ${session.total} leuchtet weiß. Siehst du Licht?`,
      progress: `${session.current + 1} / ${session.total}`,
      active: true,
    };
  }

  private async wizardFinish(): Promise<Record<string, unknown>> {
    const session = this.wizardSession;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    const device = this.findDeviceByKey(session.deviceKey);
    if (!device || !this.stateManager) {
      this.wizardSession = null;
      return { error: "Gerät verschwunden" };
    }
    const listStr = session.visible.join(",");
    const prefix = this.stateManager.devicePrefix(device);
    const ns = this.namespace;

    // Write manual_list first, then manual_mode=true — triggers reconfig via onStateChange
    await this.setStateAsync(`${ns}.${prefix}.segments.manual_list`, {
      val: listStr,
      ack: false,
    });
    await this.setStateAsync(`${ns}.${prefix}.segments.manual_mode`, {
      val: true,
      ack: false,
    });

    // Restore baseline after reconfig (async, don't block)
    await this.restoreWizardBaseline(device, session.baseline);

    const found = session.visible.length;
    this.log.info(
      `Segment-Wizard für ${device.name}: ${found} von ${session.total} Segmenten sichtbar → manual_list="${listStr}"`,
    );

    this.wizardSession = null;
    if (this.wizardTimeoutTimer) {
      this.clearTimeout(this.wizardTimeoutTimer);
      this.wizardTimeoutTimer = undefined;
    }

    return {
      status: `Fertig: ${found} von ${session.total} Segmenten sichtbar. Liste "${listStr}" gespeichert, manual_mode aktiv.`,
      progress: `${session.total} / ${session.total}`,
      done: true,
      result: found,
      list: listStr,
    };
  }

  private async wizardAbort(): Promise<Record<string, unknown>> {
    const session = this.wizardSession;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    const device = this.findDeviceByKey(session.deviceKey);
    if (device) {
      await this.restoreWizardBaseline(device, session.baseline);
    }
    this.wizardSession = null;
    if (this.wizardTimeoutTimer) {
      this.clearTimeout(this.wizardTimeoutTimer);
      this.wizardTimeoutTimer = undefined;
    }
    return {
      status: "Wizard abgebrochen, Strip auf Ausgangszustand zurückgesetzt.",
      done: true,
      aborted: true,
    };
  }

  private scheduleWizardTimeout(): void {
    if (this.wizardTimeoutTimer) {
      this.clearTimeout(this.wizardTimeoutTimer);
    }
    this.wizardTimeoutTimer = this.setTimeout(() => {
      if (this.wizardSession) {
        this.log.warn(
          `Segment-Wizard für ${this.wizardSession.name}: Idle-Timeout (5 Min), abgebrochen`,
        );
        void this.wizardAbort();
      }
    }, 5 * 60_000);
  }

  private async captureWizardBaseline(
    device: GoveeDevice,
  ): Promise<SegmentWizardSession["baseline"]> {
    const prefix = this.stateManager?.devicePrefix(device) ?? "";
    const ns = this.namespace;
    const power = (await this.getStateAsync(`${ns}.${prefix}.control.power`))
      ?.val;
    const brightness = (
      await this.getStateAsync(`${ns}.${prefix}.control.brightness`)
    )?.val;
    const colorRgb = (
      await this.getStateAsync(`${ns}.${prefix}.control.colorRgb`)
    )?.val;
    const segmentColors: SegmentWizardSession["baseline"]["segmentColors"] = [];
    const total = device.segmentCount ?? 0;
    for (let i = 0; i < total; i++) {
      const c = (
        await this.getStateAsync(`${ns}.${prefix}.segments.${i}.color`)
      )?.val;
      const b = (
        await this.getStateAsync(`${ns}.${prefix}.segments.${i}.brightness`)
      )?.val;
      segmentColors.push({
        idx: i,
        color: typeof c === "string" ? c : "#ffffff",
        brightness: typeof b === "number" ? b : 100,
      });
    }
    return {
      power: typeof power === "boolean" ? power : undefined,
      brightness: typeof brightness === "number" ? brightness : undefined,
      colorRgb: typeof colorRgb === "string" ? colorRgb : undefined,
      segmentColors,
    };
  }

  /**
   * Set all segments to solid black (prepares for wizard flash).
   *
   * @param device Target device
   */
  private async setAllSegmentsBlack(device: GoveeDevice): Promise<void> {
    const total = device.segmentCount ?? 0;
    if (total <= 0) {
      return;
    }
    await this.deviceManager?.sendCommand(device, "segmentBatch", {
      segments: Array.from({ length: total }, (_, i) => i),
      color: 0, // #000000
      brightness: 1, // lowest non-zero to stay in color-mode
    });
  }

  /**
   * Flash a single segment bright white for visual identification.
   *
   * @param device Target device
   * @param idx Segment index to flash white (others go black)
   */
  private async flashSegment(device: GoveeDevice, idx: number): Promise<void> {
    // First black everything else, then white the target
    const total = device.segmentCount ?? 0;
    const others = Array.from({ length: total }, (_, i) => i).filter(
      (i) => i !== idx,
    );
    if (others.length > 0) {
      await this.deviceManager?.sendCommand(device, "segmentBatch", {
        segments: others,
        color: 0,
        brightness: 1,
      });
    }
    await this.deviceManager?.sendCommand(device, "segmentBatch", {
      segments: [idx],
      color: 0xffffff,
      brightness: 100,
    });
  }

  private async restoreWizardBaseline(
    device: GoveeDevice,
    baseline: SegmentWizardSession["baseline"],
  ): Promise<void> {
    if (baseline.colorRgb && /^#[0-9a-fA-F]{6}$/.test(baseline.colorRgb)) {
      const total = device.segmentCount ?? 0;
      if (total > 0) {
        await this.deviceManager?.sendCommand(device, "segmentBatch", {
          segments: Array.from({ length: total }, (_, i) => i),
          color: parseInt(baseline.colorRgb.slice(1), 16),
          brightness: baseline.brightness ?? 100,
        });
      }
    }
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

    // Read current state values
    const powerState = await this.getStateAsync(
      `${ns}.${prefix}.control.power`,
    );
    const brightState = await this.getStateAsync(
      `${ns}.${prefix}.control.brightness`,
    );
    const colorState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorRgb`,
    );
    const ctState = await this.getStateAsync(
      `${ns}.${prefix}.control.colorTemperature`,
    );

    // Read per-segment states if device has segments
    let segments: SnapshotSegment[] | undefined;
    const segCount = device.segmentCount ?? 0;
    if (segCount > 0) {
      segments = [];
      for (let i = 0; i < segCount; i++) {
        const segColor = await this.getStateAsync(
          `${ns}.${prefix}.segments.${i}.color`,
        );
        const segBright = await this.getStateAsync(
          `${ns}.${prefix}.segments.${i}.brightness`,
        );
        segments.push({
          color: typeof segColor?.val === "string" ? segColor.val : "#000000",
          brightness: typeof segBright?.val === "number" ? segBright.val : 100,
        });
      }
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

    // Refresh device states to update the dropdown
    this.onDeviceListChanged(this.deviceManager!.getDevices());
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

    // Send each state via LAN → MQTT → Cloud routing
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
      // Refresh device states to update the dropdown
      this.onDeviceListChanged(this.deviceManager!.getDevices());
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
  private async resetRelatedDropdowns(
    prefix: string,
    activeCommand: string,
  ): Promise<void> {
    const ALL_DROPDOWNS = [
      "scenes.light_scene",
      "scenes.diy_scene",
      "snapshots.snapshot",
      "snapshots.snapshot_local",
      "music.music_mode",
    ];

    // Map command → its own dropdown path (excluded from reset)
    const COMMAND_DROPDOWN: Record<string, string> = {
      lightScene: "scenes.light_scene",
      diyScene: "scenes.diy_scene",
      snapshot: "snapshots.snapshot",
      snapshotLocal: "snapshots.snapshot_local",
      music: "music.music_mode",
      colorRgb: "",
      colorTemperature: "",
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
      if (current?.val && current.val !== "0" && current.val !== 0) {
        await this.setStateAsync(stateId, { val: "0", ack: true });
      }
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
