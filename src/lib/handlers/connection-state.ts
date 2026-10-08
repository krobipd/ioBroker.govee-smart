import type { DeviceManager } from "../device-manager";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import type { GoveeOpenapiMqttClient } from "../govee-openapi-mqtt-client";
import type { GoveeLanClient } from "../govee-lan-client";
import type { StateManager } from "../state-manager";
import type { ChannelStatusSnapshot } from "../log-prefix";
import { deviceLabel, logRejected } from "../types";
import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import { resolveDeviceReachability } from "../device-manager/lookups";
import { cloudReachable } from "../cloud-outage";
import { isOutage } from "../error-category";
import { hasAccountCredentials } from "../account-credentials";

/**
 * Adapter surface of the channel-status reporting: `info.connection`, the log
 * prefix and the ready summary.
 */
export interface ConnectionStateAdapter {
  readonly log: ioBroker.Logger;
  /** Credential presence check for the sensors-without-account hint (M9). */
  readonly config: { goveeEmail?: string; goveePassword?: string };
  readonly deviceManager: DeviceManager | null;
  readonly cloudClient: GoveeCloudClient | null;
  readonly cloudWasConnected: boolean;
  /** Whether real calls say the Cloud is down (issue #51) — read through `cloudReachable`. */
  readonly cloudOutage: { readonly confirmed: boolean };
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
  // A device without a local API is reached only over a cloud path: Govee's
  // REST cloud or the account broker. With neither working right now nothing
  // reaches it, so Govee's last "online" (fresh for up to 30 minutes) must not
  // keep the adapter green (GV-16, issue #51). Whether the device ever pushed
  // over the broker is history, not a connection.
  const cloudUp = cloudReachable(adapter);
  const brokerUp = adapter.mqttClient?.connected ?? false;
  const anyOnline = devices.some(d => {
    if (!d.lanIp && !cloudUp && !brokerUp) {
      return false;
    }
    return (
      resolveDeviceReachability(d).online ||
      (d.type === GOVEE_DEVICE_TYPE.LIGHT && !d.lanIp && d.channels.cloud && cloudUp)
    );
  });
  // A LAN client whose listen socket is not bound (port taken) hears nothing (audit N1).
  const lanRunning = adapter.lanClient?.isListening() ?? false;
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
      cs.cloud = cloudReachable(adapter) ? "on" : "off";
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
  // ✓ (ready) or ✗ (init attempt failed). Each ✗ is followed by a line with a
  // concrete reason + retry behaviour — a warning, or debug when the counterpart
  // simply does not answer. Channel names are renamed so the
  // user can tell them apart (Cloud REST vs Lights Push vs Sensor Push —
  // previously everything was inconsistently called "Cloud", "MQTT",
  // "Cloud-events").
  const allDevices = adapter.deviceManager?.getDevices() ?? [];
  const lights = allDevices.filter(d => d.type === GOVEE_DEVICE_TYPE.LIGHT);
  const anyLightOnLan = lights.some(d => d.lanIp);
  const lanOk = lights.length === 0 || anyLightOnLan;
  const parts: string[] = [lanOk ? "LAN ✓" : "LAN ✗"];
  if (adapter.cloudClient) {
    parts.push(cloudReachable(adapter) ? "Cloud REST ✓" : "Cloud REST ✗");
  }
  if (adapter.mqttClient) {
    parts.push(adapter.mqttClient.connected ? "Lights Push ✓" : "Lights Push ✗");
  }
  if (adapter.openapiMqttClient) {
    parts.push(adapter.openapiMqttClient.connected ? "Sensor Push ✓" : "Sensor Push ✗");
  }
  adapter.log.info(`Govee adapter ready — ${parts.join("  ")}`);

  // Each ✗ names its reason. An unreachable Govee is a state (info.cloudConnected, the ✗ above), not a warning
  // (krobi 2026-10-03, the cloud included) — that reason goes to debug; anything the user has to fix stays a warning.
  if (adapter.cloudClient && !cloudReachable(adapter)) {
    const reason = adapter.cloudClient.getFailureReason();
    const line = reason ? `Cloud REST: ${reason}` : `Cloud REST: not connected — see earlier errors`;
    const unreachable = adapter.cloudOutage.confirmed || isOutage(adapter.cloudClient.getFailureCategory());
    if (unreachable) {
      adapter.log.debug(line);
    } else {
      adapter.log.warn(line);
    }
  }
  if (adapter.mqttClient && !adapter.mqttClient.connected) {
    const reason = adapter.mqttClient.getFailureReason();
    const line = reason ? `Lights Push: ${reason}` : `Lights Push: not connected — see earlier errors`;
    const unreachable = isOutage(adapter.mqttClient.getLastError()?.category);
    if (unreachable) {
      adapter.log.debug(line);
    } else {
      adapter.log.warn(line);
    }
  }
  if (!lanOk) {
    adapter.log.warn(
      "LAN: no lights reachable on local network — cloud-only mode is ~100× slower (5-10s vs 50ms per command) and rate-limited by Govee (2 commands per second per device). Enable the local API in the Govee Home app: https://app-h5.govee.com/user-manual/wlan-guide",
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
  if (sensors.length > 0 && !hasAccountCredentials(adapter.config.goveeEmail, adapter.config.goveePassword)) {
    adapter.log.warn(
      `${sensors.length} sensor(s) found, but no Govee account is configured — sensor readings require email + password (adapter settings, "Govee Account" section)`,
    );
  }
}
