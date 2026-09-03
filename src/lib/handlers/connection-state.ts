import type { DeviceManager } from "../device-manager";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import type { GoveeOpenapiMqttClient } from "../govee-openapi-mqtt-client";
import type { GoveeLanClient } from "../govee-lan-client";
import type { StateManager } from "../state-manager";
import { httpsRequest } from "../http-client";
import { sessionKey } from "../device-key";
import type { ChannelStatusSnapshot } from "../log-prefix";
import { deviceLabel, errMessage, logRejected } from "../types";
import { GOVEE_APP_VERSION, GOVEE_DEVICE_TYPE, getAppVersion, setAppVersion } from "../govee-constants";
import { resolveDeviceReachability } from "../device-manager/lookups";

/**
 * Adapter surface required by the connection-state helpers — covers the
 * info.connection bookkeeping plus ready-summary + app-version drift
 * monitoring + stale-device reaping.
 */
export interface ConnectionStateAdapter {
  readonly log: ioBroker.Logger;
  /** Credential presence check for the sensors-without-account hint (M9). */
  readonly config: { goveeEmail?: string; goveePassword?: string };
  readonly deviceManager: DeviceManager | null;
  readonly cloudClient: GoveeCloudClient | null;
  readonly cloudWasConnected: boolean;
  readonly diagnosticsLastRun: Map<string, number>;
  readonly mqttClient: GoveeMqttClient | null;
  readonly openapiMqttClient: GoveeOpenapiMqttClient | null;
  readonly lanClient: GoveeLanClient | null;
  readonly stateManager: StateManager | null;
  readonly lanScanDone: boolean;
  readonly statesReady: boolean;
  readonly cloudInitDone: boolean;
  readonly appApiInitialPollDone: boolean;
  readyLogged: boolean;
  lastConnectionState: boolean | null;
  /** In-memory channel-status snapshot pulled by the log-prefix wrapper. */
  channelStatus?: ChannelStatusSnapshot;
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
}

/**
 * Update global `info.connection` — the ioBroker-IDC indicator.
 *
 * Semantics:
 * - With devices: `connected = true` when AT LEAST one device is online.
 *   If all are offline → false (the user sees: no device responds).
 * - Without devices: `connected = true` when the LAN stack is running,
 *   otherwise false (e.g. EADDRINUSE or a bind error).
 *
 * Write-only-on-change cache (lastConnectionState) so we don't spam
 * setState on every device-state-update.
 *
 */
export function updateConnectionState(adapter: ConnectionStateAdapter): void {
  const devices = adapter.deviceManager?.getDevices() ?? [];
  const hasDevices = devices.length > 0;
  // This is NOT the per-device marker and must not become it. `info.connection`
  // answers "is the adapter working?", `<device>.info.online` answers "is that
  // device there?" — different questions, deliberately different rules
  // (v2.13.0 contract). A device with no local API keeps the adapter's
  // indicator green while the Cloud is up, because the adapter genuinely can
  // reach it; whether the device itself answers is the device marker's job and
  // needs evidence. 2.29.0 collapsed the two and got both wrong.
  const anyOnline = devices.some(
    d =>
      resolveDeviceReachability(d, adapter.cloudWasConnected).online ||
      (d.type === GOVEE_DEVICE_TYPE.LIGHT && !d.lanIp && d.channels.cloud && adapter.cloudWasConnected),
  );
  const lanRunning = adapter.lanClient !== null;
  const connected = hasDevices ? anyOnline : lanRunning;
  if (connected !== adapter.lastConnectionState) {
    adapter.lastConnectionState = connected;
    adapter
      .setState("info.connection", { val: connected, ack: true })
      .catch(logRejected(adapter.log, "write info.connection"));
  }

  // Sync the in-memory channelStatus snapshot used by the log-prefix wrapper.
  // Only flips between "on" and "off" — "n/a" (not configured) is set once
  // in onReady from config and never overridden here.
  const cs = adapter.channelStatus;
  if (cs) {
    if (cs.lan !== "n/a") {
      cs.lan = hasDevices ? "on" : "off";
    }
    if (cs.cloud !== "n/a") {
      cs.cloud = adapter.cloudWasConnected ? "on" : "off";
    }
    if (cs.mqtt !== "n/a") {
      cs.mqtt = adapter.mqttClient?.connected ? "on" : "off";
    }
    if (cs.openapi !== "n/a") {
      cs.openapi = adapter.openapiMqttClient?.connected ? "on" : "off";
    }
  }
}

/**
 * Keep the impersonated Govee-app version current — self-healing, no datapoint.
 *
 * Govee's undocumented app2.govee.com endpoints reject very stale app versions.
 * Instead of comparing a hardcoded constant against the live version and asking
 * a human to bump + release, the adapter looks the live iOS version up (iTunes)
 * and just uses it in the request headers ({@link setAppVersion}). A failed or
 * malformed lookup is silently ignored; the bundled {@link GOVEE_APP_VERSION}
 * stays as the fallback.
 *
 */
export async function refreshLiveAppVersion(adapter: ConnectionStateAdapter): Promise<void> {
  try {
    const result = await httpsRequest<{ resultCount?: number; results?: Array<{ version?: string }> }>({
      method: "GET",
      url: "https://itunes.apple.com/lookup?bundleId=com.ihoment.GoVeeSensor",
      headers: { "User-Agent": "ioBroker.govee-smart" },
      timeout: 10_000,
    });
    const liveVersion = result.value?.results?.[0]?.version;
    // Defence in depth, deliberately kept without its own test: setAppVersion()
    // validates the same thing itself (typeof + /^\d+(\.\d+)+$/), so removing
    // this guard changes nothing but one debug line. Measured as an equivalent
    // mutant in the 2026-08-22 test audit.
    if (typeof liveVersion !== "string" || liveVersion.length === 0) {
      return;
    }
    setAppVersion(liveVersion);
    adapter.log.debug(`Govee app version: using ${getAppVersion()} (bundled fallback ${GOVEE_APP_VERSION})`);
  } catch (e) {
    adapter.log.debug(`App version lookup failed, keeping ${getAppVersion()}: ${errMessage(e)}`);
  }
}

/**
 * Delete ioBroker objects for devices no longer present and drop the same
 * devices from adapter-level maps. Diagnostics-buffer + diagnosticsLastRun
 * are reaped so removed-device data doesn't leak into the next adapter
 * lifetime.
 *
 */
export async function reapStaleDevices(adapter: ConnectionStateAdapter): Promise<void> {
  if (!adapter.stateManager || !adapter.deviceManager) {
    return;
  }
  const currentDevices = adapter.deviceManager.getDevices();
  await adapter.stateManager.cleanupDevices(currentDevices);

  const liveDeviceIds = new Set(currentDevices.map(d => d.deviceId));
  adapter.deviceManager.getDiagnostics().pruneOrphans(liveDeviceIds);

  const liveKeys = new Set(currentDevices.map(d => sessionKey(d.sku, d.deviceId)));
  for (const key of adapter.diagnosticsLastRun.keys()) {
    if (!liveKeys.has(key)) {
      adapter.diagnosticsLastRun.delete(key);
    }
  }
}

/**
 * Check if all configured channels are initialized and log ready message.
 * Called from MQTT onConnection callback and end of onReady.
 *
 */
export function checkAllReady(adapter: ConnectionStateAdapter): void {
  if (adapter.readyLogged) {
    return;
  }
  if (!adapter.lanScanDone) {
    return;
  }
  if (!adapter.statesReady) {
    return;
  }
  if (adapter.cloudClient && !adapter.cloudInitDone) {
    return;
  }
  if (adapter.mqttClient && !adapter.mqttClient.connected) {
    return;
  }
  if (adapter.openapiMqttClient && !adapter.openapiMqttClient.connected) {
    return;
  }
  if (adapter.deviceManager?.hasDeviceNeedingAppApi() && !adapter.appApiInitialPollDone) {
    return;
  }
  adapter.readyLogged = true;
  logDeviceSummary(adapter);
  // Persist any learned changes from the initial load (e.g. resolveSegmentCount
  // collapsing Cloud's 15 to the real 10 on H70D1). One-shot on first ready;
  // subsequent mutations persist themselves (MQTT bumps, wizard, manual-mode).
  adapter.deviceManager?.saveDevicesToCache();
}

/**
 * Log final ready message with device/group/channel summary.
 *
 */
export function logDeviceSummary(adapter: ConnectionStateAdapter): void {
  // Device/sensor/group counts are intentionally not logged here: at
  // ready-time the LAN scan and MQTT push are still settling, so an
  // "X online, Y offline" summary often shows lights as offline that
  // come up moments later. The user-visible online state lives in the
  // state tree where it stays accurate.
  //
  // Channel status (v2.10.1): only configured channels are shown, with
  // ✓ (ready) or ✗ (init attempt failed). Each ✗ is followed by a WARN line
  // with a concrete reason + retry behaviour. Channel names are renamed so the
  // user can tell them apart (Cloud REST vs Lights Push vs Sensor Push —
  // previously everything was inconsistently called "Cloud", "MQTT",
  // "Cloud-events").
  const allDevices = adapter.deviceManager?.getDevices() ?? [];
  const lights = allDevices.filter(d => d.type === GOVEE_DEVICE_TYPE.LIGHT);
  const anyLightOnLan = lights.some(d => d.lanIp);
  const lanOk = lights.length === 0 || anyLightOnLan;
  const parts: string[] = [lanOk ? "LAN ✓" : "LAN ✗"];
  if (adapter.cloudClient) {
    parts.push(adapter.cloudWasConnected ? "Cloud REST ✓" : "Cloud REST ✗");
  }
  if (adapter.mqttClient) {
    parts.push(adapter.mqttClient.connected ? "Lights Push ✓" : "Lights Push ✗");
  }
  if (adapter.openapiMqttClient) {
    parts.push(adapter.openapiMqttClient.connected ? "Sensor Push ✓" : "Sensor Push ✗");
  }
  adapter.log.info(`Govee adapter ready — ${parts.join("  ")}`);

  if (adapter.cloudClient && !adapter.cloudWasConnected) {
    const reason = adapter.cloudClient.getFailureReason();
    adapter.log.warn(reason ? `Cloud REST: ${reason}` : `Cloud REST: not connected — see earlier errors`);
  }
  if (adapter.mqttClient && !adapter.mqttClient.connected) {
    const reason = adapter.mqttClient.getFailureReason();
    adapter.log.warn(reason ? `Lights Push: ${reason}` : `Lights Push: not connected — see earlier errors`);
  }
  if (!lanOk) {
    adapter.log.warn(
      "LAN: no lights reachable on local network — cloud-only mode is ~100× slower (5-10s vs 50ms per command) and rate-limited (10/min). Enable the local API in the Govee Home app: https://app-h5.govee.com/user-manual/wlan-guide",
    );
    for (const d of lights) {
      if (!d.lanIp) {
        adapter.log.info(`${deviceLabel(d)}: no LAN — enable the local API in the Govee Home app`);
      }
    }
  }

  // Sensors deliver their values ONLY via the account-authenticated App-API /
  // MQTT path — with an API key alone their states stay empty forever. Say it
  // once at ready time so "thermometer shows no temperature" ends here and
  // not in the forum (M9).
  const sensors = allDevices.filter(
    d => d.type === GOVEE_DEVICE_TYPE.SENSOR || d.type === GOVEE_DEVICE_TYPE.THERMOMETER,
  );
  if (sensors.length > 0 && (!adapter.config.goveeEmail || !adapter.config.goveePassword)) {
    adapter.log.warn(
      `${sensors.length} sensor(s) found, but no Govee account is configured — sensor readings require email + password (adapter settings, "Govee Account" section)`,
    );
  }
}
