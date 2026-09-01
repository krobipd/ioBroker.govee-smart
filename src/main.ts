import { I18n } from "@iobroker/adapter-core";
import * as utils from "@iobroker/adapter-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { ActionableProblems } from "./lib/actionable-problems";
import { initDeviceRegistry } from "./lib/device-registry";
import { DeviceManager, resolveSegmentCount } from "./lib/device-manager";
import { GoveeApiClient } from "./lib/govee-api-client";
import { GoveeCloudClient } from "./lib/govee-cloud-client";
import { GoveeLanClient } from "./lib/govee-lan-client";
import { GoveeMqttClient } from "./lib/govee-mqtt-client";
import { GoveeOpenapiMqttClient } from "./lib/govee-openapi-mqtt-client";
import { LocalSnapshotStore } from "./lib/local-snapshots";
import { installLogPrefix, type ChannelStatusSnapshot } from "./lib/log-prefix";
import { SnapshotHandler } from "./lib/snapshot-handler";
import { GroupFanoutHandler } from "./lib/group-fanout";
import { MessageRouter, type MessageRouterHost } from "./lib/message-router";
import type { CloudRetryLoop } from "./lib/cloud-retry";
import * as cloudCreds from "./lib/handlers/cloud-creds-handler";
import * as cloudRetryHandler from "./lib/handlers/cloud-retry-handler";
import * as cloudStateLoader from "./lib/handlers/cloud-state-loader";
import * as connectionState from "./lib/handlers/connection-state";
import * as deviceEvents from "./lib/handlers/device-events";
import * as groupFanoutHandler from "./lib/handlers/group-fanout-handler";
import * as dropdownReset from "./lib/handlers/dropdown-reset-helpers";
import * as snapshotHandlerGlue from "./lib/handlers/snapshot-handler-glue";
import * as stateChangeRouter from "./lib/handlers/state-change-router";
import * as wizardHandler from "./lib/handlers/wizard-handler";
import { RateLimiter } from "./lib/rate-limiter";
import type { SegmentWizard } from "./lib/segment-wizard";
import { resolveLabel } from "./lib/i18n";
import { SkuCache } from "./lib/sku-cache";
import { StateManager } from "./lib/state-manager";
// AdapterConfig is augmented globally in src/lib/adapter-config.d.ts —
// TypeScript picks it up via tsconfig.json `include`, no value-import needed.
import { deviceLabel, errMessage, rgbIntToHex, rgbToHex, type GoveeDevice } from "./lib/types";
import {
  APP_API_INITIAL_DELAY_MS,
  APP_API_POLL_INTERVAL_MS,
  APP_VERSION_CHECK_INTERVAL_MS,
  CLOUD_FULL_LIMITS,
  LAN_SCAN_INITIAL_WAIT_MS,
  LAN_SCAN_INTERVAL_MS,
  ONLINE_SYNC_INTERVAL_MS,
  READY_SAFETY_TIMEOUT_MS,
  STALE_DEVICE_CLEANUP_DELAY_MS,
} from "./lib/timing-constants";

// Rate-limit defaults moved to lib/timing-constants.ts as CLOUD_FULL_LIMITS so
// every module that touches Govee budgeting reads the same canonical values.

/**
 * The device's learned physical segment count, or 0 when not yet known — the
 * cap for filtering out echo indices above the real strip length.
 *
 * @param device Device whose learned physical segment count to read
 */
function physicalSegmentCap(device: GoveeDevice): number {
  return typeof device.segmentCount === "number" && device.segmentCount > 0 ? device.segmentCount : 0;
}

/**
 * Exported so the orchestration unit tests can drive the lifecycle handlers
 * directly (fleet harness, see `reference_orchestration_test_harness`). The
 * runtime entry point below still constructs it the same way.
 */
export class GoveeAdapter extends utils.Adapter {
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
  private makeLanClient: (log: ioBroker.Logger, timers: GoveeAdapter) => GoveeLanClient = (log, timers) =>
    new GoveeLanClient(log, timers);
  /**
   * @param email Govee account email
   * @param password Govee account password
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   */
  private makeMqttClient: (
    email: string,
    password: string,
    log: ioBroker.Logger,
    timers: GoveeAdapter,
  ) => GoveeMqttClient = (email, password, log, timers) => new GoveeMqttClient(email, password, log, timers);
  /**
   * @param apiKey Govee Cloud API key
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   */
  private makeOpenapiMqttClient: (
    apiKey: string,
    log: ioBroker.Logger,
    timers: GoveeAdapter,
  ) => GoveeOpenapiMqttClient = (apiKey, log, timers) => new GoveeOpenapiMqttClient(apiKey, log, timers);
  /**
   * @param apiKey Govee Cloud API key
   * @param log Adapter logger
   */
  private makeCloudClient: (apiKey: string, log: ioBroker.Logger) => GoveeCloudClient = (apiKey, log) =>
    new GoveeCloudClient(apiKey, log);
  /** @param log Adapter logger */
  private makeApiClient: (log: ioBroker.Logger) => GoveeApiClient = log => new GoveeApiClient(log);
  /**
   * @param log Adapter logger
   * @param timers Adapter timer wrapper
   * @param perMinute Per-minute Cloud budget
   * @param perDay Per-day Cloud budget
   */
  private makeRateLimiter: (
    log: ioBroker.Logger,
    timers: GoveeAdapter,
    perMinute: number,
    perDay: number,
  ) => RateLimiter = (log, timers, perMinute, perDay) => new RateLimiter(log, timers, perMinute, perDay);
  // ──────────────────────────────────────────────────────────────────────────

  /** Public for handler modules (state-change-router, group-fanout, wizard, snapshot, diagnostics). */
  public deviceManager: DeviceManager | null = null;
  /** Public for handler modules. */
  public stateManager: StateManager | null = null;
  /** Public for handler modules. */
  public lanClient: GoveeLanClient | null = null;
  /** Public for handler modules (connection-state). */
  public mqttClient: GoveeMqttClient | null = null;
  /** Public for handler modules (connection-state). */
  public openapiMqttClient: GoveeOpenapiMqttClient | null = null;

  /** Registry surfacing user-actionable problems (verification, credentials). */
  public actionableProblems!: ActionableProblems;
  /** Public for handler modules. */
  public cloudClient: GoveeCloudClient | null = null;
  /** Public for handler modules (cloud-state-loader budgets its /device/state calls). */
  public rateLimiter: RateLimiter | null = null;
  /** Repeating timer for the App-API poll (sensor-state pull). */
  private appApiPollTimer: ioBroker.Interval | undefined;
  /**
   * One-shot timer for the FIRST app-api poll (5s after start) — kept as a
   * handle so onUnload can clear it before it fires into the void.
   */
  private appApiInitialTimer: ioBroker.Timeout | undefined;
  /** One-shot timer for cloud-init 60s safety timeout — same pattern. */
  /** Public for handler modules. */
  public cloudInitTimer: ioBroker.Timeout | undefined;
  /**
   * Last info.connection value — cached so not every device update issues an
   * unnecessary setState (H4).
   */
  /** Public for handler modules (connection-state). */
  public lastConnectionState: boolean | null = null;
  // === Lifecycle flags (adapter boot sequence) ===
  // checkAllReady() checks all 5 preconditions at once — they run in parallel,
  // not a linear STATE_MACHINE pattern, because the channels connect
  // independently.
  /** LAN-Scan-Initial-Wait abgeschlossen — public for connection-state handler. */
  public lanScanDone = false;
  /** State-Tree-Erstellung fertig — public for connection-state + device-events handlers. */
  public statesReady = false;
  /** Cloud-Init-Phase abgeschlossen — public for connection-state handler. */
  public cloudInitDone = false;
  /** App-API-Poll fertig — public for connection-state handler. */
  public appApiInitialPollDone = false;
  /** Mehrfach-Ready-Log-Guard — public for connection-state handler. */
  public readyLogged = false;
  /** Cloud was connected at least once — for the "restored" log after a down. */
  /** Public for handler modules. */
  public cloudWasConnected = false;
  /** Daily interval for the app-version-drift check against the app store. */
  private appVersionCheckTimer: ioBroker.Interval | undefined;
  /**
   * 20 s Timer that re-evaluates `info.online` for every device via
   * StateManager.syncInfoOnline. Drives the offline-transition for Lights
   * (TTL-based on lastLanReplyAt) and the no-op write-suppression for all
   * devices. Cleared synchronously in onUnload.
   */
  private onlineSyncTimer: ioBroker.Interval | undefined;
  // === Sub-Komponenten ===
  private skuCache: SkuCache | null = null;
  /** Public for handler modules. */
  public localSnapshots: LocalSnapshotStore | null = null;
  /** Public for handler modules (state-change-router). */
  public snapshotHandler: SnapshotHandler | null = null;
  /** Public for handler modules (state-change-router). */
  public groupFanout: GroupFanoutHandler | null = null;
  private messageRouter: MessageRouter | null = null;
  /** Current channel status — pulled by the log-prefix wrapper on every log call. */
  public channelStatus: ChannelStatusSnapshot = { lan: "n/a", cloud: "n/a", mqtt: "n/a", openapi: "n/a" };
  /** Public for handler modules (device-events). */
  public stateCreationQueue: Promise<void>[] = [];
  private lanScanTimer: ioBroker.Timeout | undefined;
  private cleanupTimer: ioBroker.Timeout | undefined;
  private readyTimer: ioBroker.Timeout | undefined;
  /** Public for handler modules. Undefined until first ensureCloudRetry() call. */
  public cloudRetry: CloudRetryLoop | undefined;
  /** Public for handlers/wizard-handler — lazily instantiated by `runWizardStep`. */
  public segmentWizard: SegmentWizard | null = null;
  /** Per-device timestamp of the last diagnostics export — throttle gate */
  /** Public for handler modules (state-change-router, diagnostics). */
  public diagnosticsLastRun = new Map<string, number>();
  /**
   * Set true at the start of onUnload — async paths (onStateChange,
   * applyCloudCapabilities, retrySceneData, …) check this between awaits
   * and bail before further setState against a torn-down adapter.
   */
  /** Public for handler modules (state-change-router). */
  public unloading = false;

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "govee-smart" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
    // No process-level unhandledRejection/uncaughtException handlers: in
    // compact mode they catch OTHER adapters' errors, mislabel them as
    // govee-smart and suppress Node's default crash-exit. The structural
    // protection is the boundary try/catch in every async entry point
    // (onReady/onStateChange/onMessage) plus `.catch()` on all callbacks.
  }

  /** Adapter started — initialize all channels */
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
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages as { stopInstance?: unknown } | undefined;
      if (!supported?.stopInstance) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: { stopInstance: false } } });
      return true;
    } catch (e) {
      this.log.debug(`Could not check the instance object: ${errMessage(e)}`);
      return false;
    }
  }

  private async onReady(): Promise<void> {
    try {
      // First of all: without this the whole shutdown path stays dead on an updated
      // install, and the correction restarts us — so nothing else may start up here.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      await I18n.init(path.join(this.adapterDir, "admin"), this);
      const config = this.config;

      // Fetch the live Govee-app version early (fire-and-forget) so the first
      // login / requests already use a current version — the undocumented
      // endpoints reject stale ones. GOVEE_APP_VERSION stays the fallback until
      // this resolves; a daily timer keeps it fresh.
      void connectionState
        .refreshLiveAppVersion(this)
        .catch(e => this.log.debug(`App version refresh error: ${errMessage(e)}`));

      // One-shot cleanup: the global info.refresh_cloud_data button was removed
      // in v2.7.0 but its object lingers on upgraded installs; it is replaced by
      // info.manualSyncDevices (BUG-1). Drop the dead orphan.
      await this.delObjectAsync("info.refresh_cloud_data").catch(() => undefined);

      // One-shot cleanup: the manual-sync button was spelled info.manual_sync_devices
      // from v2.17.0 to v2.27.1 — the only snake_case id in the otherwise camelCase
      // info channel. It was never subscribed either, so no script can depend on the
      // old spelling; the instanceObjects entry now declares info.manualSyncDevices.
      await this.delObjectAsync("info.manual_sync_devices").catch(() => undefined);

      // One-shot cleanup: info.appVersionDrift was removed in v2.18.0 — the
      // Govee-app version now self-heals in the background, so there is nothing
      // to surface. Drop the dead orphan on upgraded installs (e.g. from 2.17.0).
      await this.delObjectAsync("info.appVersionDrift").catch(() => undefined);

      // One-shot cleanup: info.wizardStatus was removed in v2.21.0 — the segment
      // wizard is now a React admin component that owns its own status, so the
      // UI-only mirror state is gone. Drop the dead orphan on upgraded installs.
      await this.delObjectAsync("info.wizardStatus").catch(() => undefined);

      // One-shot migration + cleanup: the <namespace>.credentials meta object
      // (v2.18.0–v2.18.2) is replaced by an encrypted file in the instance data
      // directory — the credentials are a re-derivable cache (the account
      // settings ARE in every backup), and the visible object node disappears.
      await cloudCreds.migrateCredentialsMetaOnce(this, utils.getAbsoluteInstanceDataDir(this));

      // v2.11.0 credential-encryption migration check: if encryptedNative was
      // added retroactively, js-controller still decrypts existing plaintext
      // values via the legacy XOR fallback — the adapter sees garbage that
      // bears no resemblance to the original. Detect: Govee API keys are
      // strict UUIDv4 (8-4-4-4-12 hex). Non-empty + non-UUID = needs re-entry.
      if (config.apiKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.apiKey)) {
        // The same symptom has two very different causes — lead with the
        // common one (typo/whitespace on a fresh install) instead of
        // frightening every new user with 'encryption migration corrupted'
        // and demanding a password re-entry the key alone doesn't need (M10).
        this.log.error(
          "The Govee API key does not look like a valid key (expected UUID format like 12345678-1234-1234-1234-123456789abc) — check for typos or copied whitespace in the adapter settings. " +
            "If this appeared right after upgrading a very old install (v2.11.0 encryption migration), re-enter the API key, Govee password and verification code once.",
        );
      }

      // Account credentials gate — trimmed so a stray space in a field can't
      // trip the truthy check into a login with junk data (issue #39). Drives
      // the status prefix, the startup log and the MQTT init below alike.
      // The trimmed e-mail is also what the login SENDS: the admin card's
      // "Connect" test trims it too, so a pasted trailing space must not make
      // the test succeed and the real start-up login fail on the same value.
      // The password stays untouched — surrounding spaces can be part of it.
      const accountEmail = (config.goveeEmail ?? "").trim();
      const hasAccountCreds = !!(accountEmail && config.goveePassword?.trim());

      // Channel-status prefix for every log line — must run BEFORE sub-libraries
      // are constructed so they pick up the wrapped adapter.log automatically.
      // Initial snapshot reflects which credentials the user provided; status
      // flips to "on" / "off" as connections come up or fail.
      this.channelStatus = {
        lan: "off", // LAN listener always exists; flips to "on" after first discovery
        cloud: config.apiKey ? "off" : "n/a",
        mqtt: hasAccountCreds ? "off" : "n/a",
        openapi: config.apiKey ? "off" : "n/a",
      };
      installLogPrefix(this.log, () => this.channelStatus);

      // One registry for problems that need the USER to act (verification,
      // rejected credentials). Surfaces each once — a clear warn + a persistent
      // ioBroker notification — and a positive resolution line when it clears.
      // Transient failures never reach here. Spam-free by construction.
      this.actionableProblems = new ActionableProblems({
        logWarn: m => this.log.warn(m),
        logInfo: m => this.log.info(m),
        notify: m =>
          this.registerNotification("govee-smart", "userActionRequired", m).catch(e =>
            this.log.debug(`Could not raise notification: ${errMessage(e)}`),
          ),
      });

      // info channel + states are declared as instanceObjects in
      // io-package.json, so js-controller materialises them on install /
      // upgrade. We only initialise the runtime values here.
      await this.setState("info.connection", { val: false, ack: true });
      await this.setState("info.mqttConnected", { val: false, ack: true });
      await this.setState("info.cloudConnected", { val: false, ack: true });
      await this.setState("info.openapiMqttConnected", {
        val: false,
        ack: true,
      });
      // Clear any stale 2FA-pending flag from a previous run — it is set true
      // again by the login flow if Govee still wants a code, so leaving an old
      // true here would keep the connection card's code field open forever.
      await this.setState("info.verificationPending", { val: false, ack: true });

      this.stateManager = new StateManager(this);
      // Nothing has been asked yet, so nothing may still claim to be reachable from
      // the previous run — least of all after a crash, where no shutdown code ran at
      // all and the old values would stand until the 20-second sync catches up.
      await this.stateManager.markAllOffline().catch(() => undefined);
      // One-shot orphan cleanup: builds up to v2.21.0 merged a Govee app
      // "SameModeGroup" pseudo-device into a generic device; the fix skips it at
      // intake, but an object tree already created that way never re-enters the
      // device map and so is never reaped. Drop any leftover on upgraded installs.
      await this.stateManager.cleanupSameModeGroupOrphansOnce().catch(() => undefined);
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
      // One-shot migration: pull pre-v2.11 snapshot files from the instance data
      // dir into the meta.user storage so they're included in iob backup. Runs
      // before LocalSnapshotStore.init() so the files are visible to the cache.
      await this.migrateLocalSnapshotsToMetaUser(dataDir);
      this.localSnapshots = new LocalSnapshotStore(this, this.log);
      await this.localSnapshots.init();
      this.snapshotHandler = new SnapshotHandler(snapshotHandlerGlue.buildSnapshotHost(this));
      this.groupFanout = new GroupFanoutHandler(groupFanoutHandler.buildGroupFanoutHost(this));
      this.messageRouter = new MessageRouter(this.buildMessageRouterHost());
      this.deviceManager.setSkuCache(this.skuCache);

      // v2.9.1 — wire diag providers so generate() can render persisted-cache,
      // local-snapshots and adapter-runtime state. Providers are pulled at
      // diag.export time, so a wizard that's running THEN gets captured even
      // though the collector itself doesn't track it live.
      const diag = this.deviceManager.getDiagnostics();
      diag.setCacheSnapshotProvider((sku, deviceId) => this.skuCache?.loadOne(sku, deviceId) ?? null);
      diag.setLocalSnapshotsProvider((sku, deviceId) => this.localSnapshots?.getSnapshots(sku, deviceId) ?? []);
      diag.setRuntimeStateProvider(() => {
        const errorCats = this.deviceManager?.getErrorCategorySnapshot();
        return {
          deviceManagerLastErrorCategory: errorCats?.deviceManager ?? null,
          appApiLastErrorCategory: errorCats?.appApi ?? null,
          groupMembersLastErrorCategory: errorCats?.groupMembers ?? null,
          cloudFailureReason: this.cloudClient?.getFailureReason() ?? null,
          mqttFailureReason: this.mqttClient?.getFailureReason() ?? null,
          rateLimiter: this.rateLimiter?.getUsageSnapshot() ?? null,
          wizardSession: this.segmentWizard?.getSessionSnapshot() ?? null,
          lanSeenDeviceIps: this.lanClient?.getDiagSnapshot().seenDeviceIps ?? [],
        };
      });

      // API client for undocumented scene/music/DIY libraries (always available)
      const apiClient = this.makeApiClient(this.log);
      apiClient.setEmail(accountEmail);
      this.deviceManager.setApiClient(apiClient);

      this.deviceManager.setCallbacks({
        onUpdate: (device, state) => deviceEvents.onDeviceStateUpdate(this, device, state),
        onLanDeviceReady: (device, allDevices) => deviceEvents.onLanDeviceReady(this, device, allDevices),
        onCloudDataReady: (device, allDevices) => deviceEvents.onCloudDataReady(this, device, allDevices),
        onGroupMembersReady: (group, allDevices) => deviceEvents.onGroupMembersReady(this, group, allDevices),
      });

      // After an account-reconcile eviction, clean up the now-orphan objects +
      // diagnostics buffers. A poll-driven eviction never fires onCloudDataReady,
      // so reapStaleDevices must be triggered explicitly here.
      this.deviceManager.onDevicesRemoved = () => {
        void this.reapStaleDevices().catch(e => this.log.debug(`Post-eviction cleanup failed: ${errMessage(e)}`));
      };

      // Update info.ip when LAN IP changes
      this.deviceManager.onLanIpChanged = (device, ip) => {
        // A gateway-connected sensor has info.gateway, not info.ip — writing here
        // would create an orphan state value. It is never LAN-discovered anyway,
        // but guard defensively.
        if (device.gateway) {
          return;
        }
        const prefix = this.stateManager!.devicePrefix(device);
        this.setState(`${prefix}.info.ip`, { val: ip, ack: true }).catch(() => {});
      };

      // Sync individual segment states after batch command.
      // Important: the wizard sends `segmentBatch` with indices 0..SEGMENT_HARD_MAX
      // so the device reveals its real strip length itself. But we may only
      // write that ECHO into states that actually exist — otherwise js-controller
      // produces the "has no existing object" WARN for every index above the cap
      // (e.g. segments.51..55 on a 19-segment strip).
      this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
        const prefix = this.stateManager!.devicePrefix(device);
        const cap = physicalSegmentCap(device);
        for (const idx of batch.segments) {
          if (cap === 0 || idx >= cap) {
            continue;
          }
          if (batch.color !== undefined) {
            const hex = rgbIntToHex(batch.color);
            this.setState(`${prefix}.segments.${idx}.color`, {
              val: hex,
              ack: true,
            }).catch(() => {});
          }
          if (batch.brightness !== undefined) {
            this.setState(`${prefix}.segments.${idx}.brightness`, {
              val: batch.brightness,
              ack: true,
            }).catch(() => {});
          }
        }
      };

      // Sync per-segment states from MQTT BLE status push (AA A5 packets).
      // Gleicher Cap-Filter wie bei batch — defensive vor stale Pakete.
      this.deviceManager.onMqttSegmentUpdate = (device, segments) => {
        const prefix = this.stateManager!.devicePrefix(device);
        const cap = physicalSegmentCap(device);
        for (const seg of segments) {
          if (cap === 0 || seg.index >= cap) {
            continue;
          }
          this.setState(`${prefix}.segments.${seg.index}.color`, {
            val: rgbToHex(seg.r, seg.g, seg.b),
            ack: true,
          }).catch(() => {});
          this.setState(`${prefix}.segments.${seg.index}.brightness`, {
            val: seg.brightness,
            ack: true,
          }).catch(() => {});
        }
      };

      // When MQTT reveals the device's real segment count differs from what
      // Cloud advertised, rebuild the state tree so the datapoints match
      // (extra indices added, excess ones pruned).
      this.deviceManager.onSegmentCountChanged = device => {
        if (!this.stateManager) {
          return;
        }
        this.stateManager.createSegmentStates(device).catch(e => {
          this.log.warn(
            `Failed to rebuild segment tree for ${deviceLabel(device)} after count change: ${errMessage(e)}`,
          );
        });
      };

      // Log startup with configured channels
      const startChannels: string[] = ["LAN"];
      if (config.apiKey) {
        startChannels.push("Cloud");
      }
      if (hasAccountCreds) {
        startChannels.push("MQTT");
      }
      this.log.info(
        `Starting (${startChannels.join(", ")}) — please wait, a "ready" message will follow when all channels are up`,
      );

      // --- LAN (always active) ---
      this.lanClient = this.makeLanClient(this.log, this);
      this.deviceManager.setLanClient(this.lanClient);

      // A socket error on a PINNED interface is user-fixable config (the
      // selected IP is gone after a DHCP/network change) — surface it once
      // via the actionable-problems registry instead of a debug line that
      // left the LAN channel silently dead (M11).
      this.lanClient.onInterfaceError = message => {
        this.actionableProblems.report({
          key: "lan-interface",
          title: "LAN unavailable on the selected network interface",
          action: message,
        });
      };
      this.lanClient.onListenReady = () => {
        this.actionableProblems.resolve("lan-interface", "LAN listening on the selected network interface");
      };

      // v2.9.1 — wire LAN-traffic into the diag-collector. Resolves
      // destination-IP → device on every send/status/scan so the diag
      // JSON carries the verbatim UDP bytes per device. Closes Class E
      // of the v2.9.1 audit (LAN UDP completely silent in diag before).
      this.lanClient.setSendHook((ip, cmd, payload, bytes, error) => {
        const dev = this.deviceManager?.getDevices().find(d => d.lanIp === ip);
        if (!dev) {
          return;
        }
        this.deviceManager!.getDiagnostics().addLanSend(dev.deviceId, ip, cmd, payload, bytes, error);
      });
      this.lanClient.setStatusRecordHook((ip, status) => {
        const dev = this.deviceManager?.getDevices().find(d => d.lanIp === ip);
        if (!dev) {
          return;
        }
        this.deviceManager!.getDiagnostics().recordApiSuccess(dev.deviceId, "lan://devStatus", status);
      });
      this.lanClient.setScanRecordHook(lanDevice => {
        this.deviceManager
          ?.getDiagnostics()
          .addLog(lanDevice.device, "debug", `LAN scan reply: ip=${lanDevice.ip} sku=${lanDevice.sku}`);
      });

      this.lanClient.start(
        lanDevice => {
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
        LAN_SCAN_INTERVAL_MS,
        config.networkInterface || "",
      );

      // Wait for first LAN scan responses (UDP multicast, devices respond within 1-2s)
      this.lanScanTimer = this.setTimeout(() => {
        this.lanScanDone = true;
        // Enable the account-reconcile only now — before this a cache-restored
        // LAN device hasn't had channels.lan set and would count a false miss.
        if (this.deviceManager) {
          this.deviceManager.accountReconcileEnabled = true;
        }
        connectionState.checkAllReady(this);
      }, LAN_SCAN_INITIAL_WAIT_MS);

      // --- MQTT (if account credentials provided) ---
      // Initialize MQTT before Cloud so scene library can load on first cycle
      if (hasAccountCreds) {
        this.mqttClient = this.makeMqttClient(accountEmail, config.goveePassword, this.log, this);

        // Forward every parsed MQTT message into the diagnostics ring buffer
        // so diag.export contains the recent packets per device. v2.9.1: the
        // hook gets both BLE-hex (op.command) and the raw JSON envelope so
        // state-only pushes are also captured.
        this.mqttClient.setPacketHook((deviceId, topic, payload) => {
          this.deviceManager?.getDiagnostics().addMqttPacket(deviceId, topic, payload);
        });

        // 2FA: forward optional code from settings into the next login attempt;
        // clear the field automatically once Govee has accepted it.
        this.mqttClient.setVerificationCode(config.mqttVerificationCode ?? "");
        this.mqttClient.setOnVerificationConsumed(() => {
          cloudCreds.clearVerificationCodeSetting(this).catch(e => {
            this.log.warn(`Could not clear mqttVerificationCode: ${errMessage(e)}`);
          });
        });
        this.mqttClient.setOnVerificationFailed(reason => {
          // On 'failed' (455 / 454+code-was-sent) blank the code so the user
          // doesn't keep retrying with a stale value. On 'pending' (454 + no
          // code) we leave the field as-is — the user is about to fill it.
          // Surface the "code needed" state on info.verificationPending so the
          // connection card can show it live (the notification below is only a
          // nudge for when the user isn't in the settings — the actual flow
          // runs through the card, never a second login path).
          this.setState("info.verificationPending", { val: true, ack: true }).catch(() => {});
          if (reason === "failed") {
            cloudCreds.clearVerificationCodeSetting(this).catch(() => {});
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee rejected the verification code for real-time status",
              action:
                "open the adapter settings — the connection card requests a fresh code; enter the one Govee e-mails you",
            });
          } else {
            this.actionableProblems.report({
              key: "mqtt-verification",
              title: "Govee requires a verification code to enable real-time status (lights/sensors stay readable)",
              action:
                "open the adapter settings — the connection card requests a code and takes the one Govee e-mails you",
            });
          }
        });
        this.mqttClient.setOnAuthFailed(() => {
          this.actionableProblems.report({
            key: "mqtt-auth",
            title: "Govee rejected the account login for real-time status",
            action: "check the Govee email and password in the adapter settings (connection card)",
          });
        });
        this.mqttClient.setOnLoginBlocked(() => {
          this.actionableProblems.report({
            key: "mqtt-login-blocked",
            title: "Govee stopped accepting the account login for real-time status",
            action:
              "Govee rejected repeated login attempts (the account may be temporarily locked). Automatic retries are stopped — check your Govee account, then restart the adapter",
          });
        });

        // Re-use cached MQTT credentials across restarts. Stored (encrypted) in
        // a FILE in the instance data directory — not a state and not a meta
        // object (so the credentials are neither a visible datapoint nor a
        // visible object-tree node) and not adapter native (a native write
        // would trigger a js-controller restart, looping endlessly on every
        // login). loadPersistedCreds migrates an older info.mqttCredentials
        // state into the file on first run; the v2.18.x meta object is
        // migrated + dropped earlier in onReady (migrateCredentialsMetaOnce).
        //
        // One-shot: clean up legacy v2.1.0/v2.1.1/v2.1.2 native fields
        // that contained plaintext credentials. Best-effort.
        await cloudCreds.cleanupLegacyMqttNativeOnce(this);
        const cachedCreds = await cloudCreds.loadPersistedCreds(this, dataDir);
        if (cachedCreds) {
          this.mqttClient.setPersistedCredentials(cachedCreds);
        }
        this.mqttClient.setOnCredentialsRefresh(creds => {
          cloudCreds.persistCreds(this, dataDir, creds).catch(e => {
            this.log.warn(`Could not persist MQTT credentials: ${errMessage(e)}`);
          });
        });

        await this.mqttClient.connect(
          update => this.deviceManager!.handleMqttStatus(update),
          connected => {
            this.setState("info.mqttConnected", {
              val: connected,
              ack: true,
            }).catch(() => {});
            if (connected) {
              this.actionableProblems.resolve(
                "mqtt-verification",
                "Govee real-time status connected — verification accepted",
              );
              this.actionableProblems.resolve("mqtt-auth", "Govee account login accepted");
              this.actionableProblems.resolve("mqtt-login-blocked", "Govee account login accepted");
              this.setState("info.verificationPending", { val: false, ack: true }).catch(() => {});
              connectionState.checkAllReady(this);
            }
            connectionState.updateConnectionState(this);
          },
          // Forward every fresh bearer token — fires on initial login and on
          // each reconnect-login, so the API client never runs with a stale one.
          token => apiClient.setBearerToken(token),
        );
      }

      // --- Device data: Cache first, Cloud only on cache miss ---
      const cachedOk = this.deviceManager.loadFromCache();

      if (config.apiKey) {
        this.cloudClient = this.makeCloudClient(config.apiKey, this.log);
        // Capture the most recent Cloud response per (deviceId, endpoint) for
        // diagnostics — bounded by the DiagnosticsCollector's response slot cap.
        this.cloudClient.setResponseHook((deviceId, endpoint, body) => {
          this.deviceManager?.getDiagnostics().recordApiSuccess(deviceId, endpoint, body);
        });
        this.deviceManager.setCloudClient(this.cloudClient);

        // Bridge synthetic capabilities (App-API, OpenAPI-MQTT events) into the
        // same setState pipeline as polled Cloud state. Keeps mapCloudStateValue
        // as the single source of truth for value coercion + state-id resolution.
        this.deviceManager.setOnCloudCapabilities((device, caps) => {
          cloudStateLoader
            .applyCloudCapabilities(this, device, caps)
            .catch(e => this.log.warn(`applyCloudCapabilities failed for ${device.sku}: ${errMessage(e)}`));
        });

        this.rateLimiter = this.makeRateLimiter(this.log, this, CLOUD_FULL_LIMITS.perMinute, CLOUD_FULL_LIMITS.perDay);
        this.rateLimiter.start();
        this.deviceManager.setRateLimiter(this.rateLimiter);

        // OpenAPI-MQTT — push channel for appliance/sensor events
        // (lackWater, iceFull, bodyAppeared etc.). API key is enough; no
        // separate credentials required. Connection runs in parallel to
        // the AWS-IoT MQTT used for status push of regular devices.
        this.openapiMqttClient = this.makeOpenapiMqttClient(config.apiKey, this.log, this);
        this.openapiMqttClient.connect(
          event => this.deviceManager?.handleOpenApiEvent(event),
          connected => {
            this.setState("info.openapiMqttConnected", {
              val: connected,
              ack: true,
            }).catch(() => {});
            if (connected) {
              // Cloud-events (Sensor Push) is a Ready precondition — re-check so
              // the adapter logs "ready" as soon as it connects instead of
              // waiting on the 60 s safety timer (L10). Mirrors the AWS-IoT
              // onConnection callback above.
              connectionState.checkAllReady(this);
            }
          },
          // v2.9.1 — raw payload hook. Cloud-events MQTT topic is account-wide
          // (`GA/<apiKey>`), payload carries `sku`/`device`. Parse here so the
          // raw envelope lands per-device in the diag (same model as AWS-IoT).
          // Account-level bucket would have meant a new diag struct; per-device
          // keeps shape consistent with all other capture paths.
          rawJson => {
            if (!this.deviceManager) {
              return;
            }
            try {
              const parsed = JSON.parse(rawJson) as { sku?: unknown; device?: unknown };
              if (typeof parsed?.device === "string" && parsed.device) {
                this.deviceManager.getDiagnostics().addMqttPacket(parsed.device, "openapi-events", { rawJson });
              }
            } catch {
              /* malformed — already debug-logged in the client */
            }
          },
        );

        // App-API poll — every 2 minutes, pulls state for sensors like H5179
        // where OpenAPI v2 /device/state returns empty. Bearer token comes
        // from the AWS-IoT MQTT login, so a no-op until that succeeds.
        const triggerAppApiPoll = (): void => {
          this.deviceManager
            ?.pollAppApi()
            .then(() => {
              // H2 — mark initial-poll-done and re-check Ready so the adapter
              // can log "ready" as soon as sensor values are in.
              if (!this.appApiInitialPollDone) {
                this.appApiInitialPollDone = true;
                connectionState.checkAllReady(this);
              }
            })
            .catch(e => this.log.debug(`pollAppApi failed: ${errMessage(e)}`));
        };
        this.appApiPollTimer = this.setInterval(triggerAppApiPoll, APP_API_POLL_INTERVAL_MS);
        // Initial poll: gives MQTT time for the bearer login. Without this
        // immediate poll, sensors like the H5179 stay offline for the first
        // 2 minutes after start (the online signal only comes via App-API).
        // Kept in a member variable so onUnload can clear the timer.
        this.appApiInitialTimer = this.setTimeout(triggerAppApiPoll, APP_API_INITIAL_DELAY_MS);

        if (!cachedOk) {
          // No cache — first start, fetch from Cloud with 60s hard-timeout.
          // If Cloud hangs/fails, we don't want to block adapter startup indefinitely.
          const result = await cloudRetryHandler.cloudInitWithTimeout(this);
          this.cloudWasConnected = result.ok;
          cloudRetryHandler.ensureCloudRetry(this).setConnected(result.ok);
          this.setState("info.cloudConnected", {
            val: result.ok,
            ack: true,
          }).catch(() => {});
          this.stateManager?.updateGroupsOnline(result.ok).catch(() => {});

          if (result.ok) {
            await cloudStateLoader.loadCloudStates(this);
          } else {
            cloudRetryHandler.handleCloudFailure(this, result);
          }
        } else {
          // device-manager already logged "Loaded N device(s) from cache" at
          // info — keep this one on debug so a cache-only start isn't announced
          // twice (C9).
          this.log.debug(`Using cached device data — no Cloud calls needed`);
          this.cloudWasConnected = true;
          cloudRetryHandler.ensureCloudRetry(this).setConnected(true);
          this.setState("info.cloudConnected", {
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

      // v2.8.0 one-shot migration: pure-LAN devices (no API key, never went
      // through a Cloud-phase) on prior versions had scenes/music/snapshots
      // states briefly created then orphaned. Wipe those leftovers now.
      // Idempotent — second run does nothing, the LAN_STATE_IDS skip in
      // cleanupCloudOwnedStates protects power/brightness/color_rgb/color_temperature.
      if (this.stateManager && this.deviceManager) {
        for (const device of this.deviceManager.getDevices()) {
          if (device.lanIp && device.capabilities.length === 0) {
            const prefix = this.stateManager.devicePrefix(device);
            const deleted = await this.stateManager.cleanupCloudOwnedStates(prefix, []).catch(e => {
              this.log.debug(`Legacy cloud-state cleanup failed for ${deviceLabel(device)}: ${errMessage(e)}`);
              return 0;
            });
            // Only announce when something was actually removed: pure-LAN
            // devices (no API key) match this condition on EVERY start, and
            // an info-level "Migrated" line for a no-op was permanent log
            // noise for exactly the credential-less target group (M7).
            if (deleted > 0) {
              this.log.info(`Removed ${deleted} legacy cloud-owned state(s) for ${deviceLabel(device)} (pure-LAN)`);
            }
          }
        }

        // B2 one-shot migration: the control colour states were renamed from
        // camelCase (control.colorRgb / control.colorTemperature) to snake_case
        // (control.color_rgb / control.color_temperature). Delete the old
        // objects on upgraded installs so they don't linger as dead duplicates.
        // Idempotent + existence-checked; covers devices AND groups.
        for (const device of this.deviceManager.getDevices()) {
          await this.stateManager.migrateLegacyColorStateIds(device).catch(e => {
            this.log.debug(`B2 colour-state migration failed for ${deviceLabel(device)}: ${errMessage(e)}`);
          });
        }
      }

      this.statesReady = true;

      // Subscribe to all writable device and group states, plus the adapter-level
      // manual-sync button. The button lives under `info`, which the two wildcard
      // patterns do not cover — without its own subscription the state change never
      // reaches onStateChange and the button is dead (v2.17.0–v2.27.1).
      await this.subscribeStatesAsync("devices.*");
      await this.subscribeStatesAsync("groups.*");
      await this.subscribeStatesAsync("info.manualSyncDevices");

      // Cleanup stale devices after initial discovery (30s delay for LAN scan).
      // Reaps devices from every adapter-level map that was keyed on them so the
      // process doesn't leak memory across Cloud-side device turnover.
      this.cleanupTimer = this.setTimeout(() => {
        connectionState.reapStaleDevices(this).catch(e => this.log.debug(`Device cleanup failed: ${errMessage(e)}`));
      }, STALE_DEVICE_CLEANUP_DELAY_MS);

      // info.online sync — re-evaluates per-device online truth every 20 s.
      // For Lights this drives the offline-transition (lastLanReplyAt TTL).
      // For all devices it suppresses ts-rewrite-spam (no setState when
      // value is unchanged). When a Light flips online/offline, also refreshes
      // group-reachability since the original onDeviceUpdate path no longer
      // sees those transitions for Lights.
      this.onlineSyncTimer = this.setInterval(() => {
        if (this.unloading || !this.stateManager || !this.deviceManager) {
          return;
        }
        void (async (): Promise<void> => {
          let anyLightChanged = false;
          for (const device of this.deviceManager!.getDevices()) {
            const changed = await this.stateManager!.syncInfoOnline(device).catch(() => false);
            if (changed) {
              anyLightChanged = true;
            }
          }
          if (anyLightChanged) {
            groupFanoutHandler.updateGroupReachability(this);
          }
          // The rollup rides on the same round: it is derived from exactly the
          // markers that were just re-evaluated, so it can never drift away from
          // what the individual devices say.
          await this.stateManager!.writeDeviceRollup().catch(e => {
            this.log.debug(`Device rollup failed: ${errMessage(e)}`);
          });
        })();
      }, ONLINE_SYNC_INTERVAL_MS);

      // Keep the impersonated Govee-app version current — daily refresh (the
      // initial fetch is fired early in onReady, above).
      this.appVersionCheckTimer = this.setInterval(() => {
        connectionState
          .refreshLiveAppVersion(this)
          .catch(e => this.log.debug(`App version refresh error: ${errMessage(e)}`));
      }, APP_VERSION_CHECK_INTERVAL_MS);

      connectionState.updateConnectionState(this);

      // Check if all channels are ready — may already be true if MQTT connected fast
      connectionState.checkAllReady(this);
      // Safety timeout: log ready anyway even if a channel takes too long.
      // READY_SAFETY_TIMEOUT_MS covers a normal MQTT connect + 1 reconnect.
      this.readyTimer = this.setTimeout(() => {
        if (!this.readyLogged) {
          this.readyLogged = true;
          connectionState.logDeviceSummary(this);
        }
      }, READY_SAFETY_TIMEOUT_MS);
    } catch (error) {
      this.log.error(`onReady failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
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
  private async migrateLocalSnapshotsToMetaUser(dataDir: string): Promise<void> {
    const oldDir = path.join(dataDir, "snapshots");
    if (!fs.existsSync(oldDir)) {
      return;
    }
    let files: string[];
    try {
      files = fs.readdirSync(oldDir).filter(f => f.endsWith(".json"));
    } catch (e) {
      this.log.warn(`Snapshot migration: cannot read ${oldDir}: ${errMessage(e)}`);
      return;
    }
    if (files.length === 0) {
      try {
        fs.rmdirSync(oldDir);
      } catch {
        /* dir already gone or non-empty with non-JSON, ignore */
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
        this.log.warn(`Snapshot migration of ${file} failed: ${errMessage(e)}`);
      }
    }
    try {
      fs.rmdirSync(oldDir);
    } catch {
      /* dir still has files we failed to migrate — leave for retry on next start */
    }
    this.log.info(`Snapshot migration complete: ${migrated}/${files.length} files moved to meta.user storage.`);
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      await stateChangeRouter.onStateChange(this, id, state);
    } catch (e) {
      this.log.warn(`onStateChange crashed for ${id}: ${errMessage(e)}`);
    }
  }

  private onMessage(obj: ioBroker.Message): void {
    try {
      this.messageRouter?.onMessage(obj);
    } catch (e) {
      this.log.warn(`onMessage crashed: ${errMessage(e)}`);
    }
  }

  /**
   * Adapter stopping — MUST be synchronous.
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
    // Set first — async paths read this between awaits and bail before
    // further setState, sendCommand, etc. against a torn-down adapter.
    this.unloading = true;
    try {
      if (this.lanScanTimer) {
        this.clearTimeout(this.lanScanTimer);
        this.lanScanTimer = undefined;
      }
      if (this.cleanupTimer) {
        this.clearTimeout(this.cleanupTimer);
        this.cleanupTimer = undefined;
      }
      if (this.readyTimer) {
        this.clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      if (this.appApiPollTimer) {
        this.clearInterval(this.appApiPollTimer);
        this.appApiPollTimer = undefined;
      }
      if (this.onlineSyncTimer) {
        this.clearInterval(this.onlineSyncTimer);
        this.onlineSyncTimer = undefined;
      }
      if (this.appApiInitialTimer) {
        this.clearTimeout(this.appApiInitialTimer);
        this.appApiInitialTimer = undefined;
      }
      if (this.cloudInitTimer) {
        this.clearTimeout(this.cloudInitTimer);
        this.cloudInitTimer = undefined;
      }
      if (this.appVersionCheckTimer) {
        this.clearInterval(this.appVersionCheckTimer);
        this.appVersionCheckTimer = undefined;
      }
      this.cloudRetry?.dispose();
      this.segmentWizard?.dispose();
      this.lanClient?.stop();
      this.mqttClient?.disconnect();
      this.openapiMqttClient?.disconnect();
      this.rateLimiter?.stop();
      // The callback is the "we are done" signal to the host, and it comes AFTER
      // these writes: issued fire-and-forget and followed by an immediate callback,
      // not one of them reaches the database — the process is gone first (measured
      // on a live server 2026-08-27). The host allows a second before it ends the
      // process; these writes take about a tenth of that.
      //
      // The per-device markers belong here just as much: `info.online` is what
      // colours a device in the object tree, so writing only the four connection
      // flags leaves every Govee device standing green while the instance is off.
      const done = (): void => callback();
      const writes: Promise<unknown>[] = [
        this.setState("info.connection", { val: false, ack: true }),
        this.setState("info.mqttConnected", { val: false, ack: true }),
        this.setState("info.openapiMqttConnected", { val: false, ack: true }),
        this.setState("info.cloudConnected", { val: false, ack: true }),
      ];
      if (this.stateManager) {
        // Covers the per-device markers, the group marker and the rollup.
        writes.push(this.stateManager.markAllOffline());
      }
      void Promise.all(writes)
        .catch((e: unknown) => {
          // States DB already going down — nothing left to report to.
          this.log.debug(`onUnload: final states rejected: ${errMessage(e)}`);
        })
        .finally(done);
      return;
    } catch {
      // ignore
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
  public async sendMusicCommand(
    device: GoveeDevice,
    prefix: string,
    changedSuffix: string,
    newValue: ioBroker.StateValue,
  ): Promise<void> {
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
  public fireCloudDataReady(device: GoveeDevice, allDevices: GoveeDevice[]): void {
    deviceEvents.onCloudDataReady(this, device, allDevices);
  }

  /** Public delegate — connection-state handler exports the real implementation. */
  public reapStaleDevices(): Promise<void> {
    return connectionState.reapStaleDevices(this);
  }

  /**
   * Manual "sync devices" button (info.manualSyncDevices): pull the fresh
   * Govee account device list and reconcile it — new devices are onboarded,
   * devices deleted from the account are removed — without a restart. Existing
   * devices' scene/snapshot data is untouched (use the per-device refresh).
   */
  public async syncDevicesManually(): Promise<void> {
    if (!this.deviceManager) {
      return;
    }
    const result = await this.deviceManager.loadFromCloud();
    if (!result.ok) {
      // Same single mechanism as the init/retry path: auth-failed reaches the
      // ActionableProblems registry, transient failures arm the retry loop.
      // Plus one non-deduplicated line — the user explicitly pressed the
      // button and must see why nothing happened (M4).
      this.log.warn(`Manual device sync failed (${result.reason}) — see earlier log for details`);
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
  public stateToCommand(suffix: string): string | null {
    return dropdownReset.stateToCommand(suffix);
  }

  /**
   * Public delegate for cloud-retry-handler's CloudRetryHandlerAdapter interface.
   *
   * @param only Optional single device to reload; omit to reload every device's cloud states
   */
  public loadCloudStates(only?: GoveeDevice): Promise<void> {
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
  public async applyManualSegments(device: GoveeDevice, mode: boolean, indices?: number[]): Promise<void> {
    if (!this.stateManager) {
      return;
    }
    device.manualMode = mode;
    device.manualSegments = mode && Array.isArray(indices) && indices.length > 0 ? indices.slice() : undefined;
    await this.stateManager.createSegmentStates(device);
    this.deviceManager?.persistDeviceToCache(device);
  }

  // ───────── Segment-Detection-Wizard ─────────

  /** Construct host object for MessageRouter. */
  private buildMessageRouterHost(): MessageRouterHost {
    return {
      log: this.log,
      getConfig: () => {
        const config = this.config;
        return {
          goveeEmail: config.goveeEmail,
          goveePassword: config.goveePassword,
          mqttVerificationCode: config.mqttVerificationCode,
        };
      },
      sendResponse: (obj, data) => this.sendMessageResponse(obj, data),
      createMqttProbeClient: (email: string, password: string) => {
        const probe = new GoveeMqttClient(email, password, this.log, this);
        // One-shot probe: a failed login must not arm the reconnect backoff —
        // it could fire a second login against Govee inside the probe window.
        probe.enableProbeMode();
        return probe;
      },
      getSegmentDeviceList: () => {
        const devices = this.deviceManager?.getDevices() ?? [];
        return devices
          .filter(d => d.sku !== "BaseGroup" && d.state?.online === true && resolveSegmentCount(d) > 0)
          .map(d => ({
            value: wizardHandler.deviceKeyFor(d),
            label: resolveLabel("segmentWizardDeviceOption", d.name, d.sku, resolveSegmentCount(d)),
          }));
      },
      runWizardStep: (action, deviceKey, payload) => wizardHandler.runWizardStep(this, action, deviceKey, payload),
      setTimeout: (cb, ms) => this.setTimeout(cb, ms),
      clearTimeout: handle => this.clearTimeout(handle),
    };
  }

  /**
   * Send a sendTo response back to the caller, if the message expects one.
   *
   * @param obj ioBroker message object
   * @param data Response data payload
   */
  private sendMessageResponse(obj: ioBroker.Message, data: unknown): void {
    if (obj.callback && obj.from) {
      this.sendTo(obj.from, obj.command, data as Record<string, unknown>, obj.callback);
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new GoveeAdapter(options);
} else {
  (() => new GoveeAdapter())();
}
