"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var connection_state_exports = {};
__export(connection_state_exports, {
  checkAllReady: () => checkAllReady,
  logDeviceSummary: () => logDeviceSummary,
  reapStaleDevices: () => reapStaleDevices,
  refreshLiveAppVersion: () => refreshLiveAppVersion,
  updateConnectionState: () => updateConnectionState
});
module.exports = __toCommonJS(connection_state_exports);
var import_http_client = require("../http-client");
var import_device_key = require("../device-key");
var import_types = require("../types");
var import_govee_constants = require("../govee-constants");
function updateConnectionState(adapter) {
  var _a, _b, _c, _d;
  const devices = (_b = (_a = adapter.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
  const hasDevices = devices.length > 0;
  const anyOnline = devices.some(
    (d) => d.state.online || d.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && !d.lanIp && d.channels.cloud && adapter.cloudWasConnected
  );
  const lanRunning = adapter.lanClient !== null;
  const connected = hasDevices ? anyOnline : lanRunning;
  if (connected !== adapter.lastConnectionState) {
    adapter.lastConnectionState = connected;
    adapter.setState("info.connection", { val: connected, ack: true }).catch((0, import_types.logRejected)(adapter.log, "write info.connection"));
  }
  const cs = adapter.channelStatus;
  if (cs) {
    if (cs.lan !== "n/a") {
      cs.lan = hasDevices ? "on" : "off";
    }
    if (cs.cloud !== "n/a") {
      cs.cloud = adapter.cloudWasConnected ? "on" : "off";
    }
    if (cs.mqtt !== "n/a") {
      cs.mqtt = ((_c = adapter.mqttClient) == null ? void 0 : _c.connected) ? "on" : "off";
    }
    if (cs.openapi !== "n/a") {
      cs.openapi = ((_d = adapter.openapiMqttClient) == null ? void 0 : _d.connected) ? "on" : "off";
    }
  }
}
async function refreshLiveAppVersion(adapter) {
  var _a, _b, _c;
  try {
    const result = await (0, import_http_client.httpsRequest)({
      method: "GET",
      url: "https://itunes.apple.com/lookup?bundleId=com.ihoment.GoVeeSensor",
      headers: { "User-Agent": "ioBroker.govee-smart" },
      timeout: 1e4
    });
    const liveVersion = (_c = (_b = (_a = result.value) == null ? void 0 : _a.results) == null ? void 0 : _b[0]) == null ? void 0 : _c.version;
    if (typeof liveVersion !== "string" || liveVersion.length === 0) {
      return;
    }
    (0, import_govee_constants.setAppVersion)(liveVersion);
    adapter.log.debug(`Govee app version: using ${(0, import_govee_constants.getAppVersion)()} (bundled fallback ${import_govee_constants.GOVEE_APP_VERSION})`);
  } catch (e) {
    adapter.log.debug(`App version lookup failed, keeping ${(0, import_govee_constants.getAppVersion)()}: ${(0, import_types.errMessage)(e)}`);
  }
}
async function reapStaleDevices(adapter) {
  if (!adapter.stateManager || !adapter.deviceManager) {
    return;
  }
  const currentDevices = adapter.deviceManager.getDevices();
  await adapter.stateManager.cleanupDevices(currentDevices);
  const liveDeviceIds = new Set(currentDevices.map((d) => d.deviceId));
  adapter.deviceManager.getDiagnostics().pruneOrphans(liveDeviceIds);
  const liveKeys = new Set(currentDevices.map((d) => (0, import_device_key.sessionKey)(d.sku, d.deviceId)));
  for (const key of adapter.diagnosticsLastRun.keys()) {
    if (!liveKeys.has(key)) {
      adapter.diagnosticsLastRun.delete(key);
    }
  }
}
function checkAllReady(adapter) {
  var _a, _b;
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
  if (((_a = adapter.deviceManager) == null ? void 0 : _a.hasDeviceNeedingAppApi()) && !adapter.appApiInitialPollDone) {
    return;
  }
  adapter.readyLogged = true;
  logDeviceSummary(adapter);
  (_b = adapter.deviceManager) == null ? void 0 : _b.saveDevicesToCache();
}
function logDeviceSummary(adapter) {
  var _a, _b;
  const allDevices = (_b = (_a = adapter.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
  const lights = allDevices.filter((d) => d.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT);
  const anyLightOnLan = lights.some((d) => d.lanIp);
  const lanOk = lights.length === 0 || anyLightOnLan;
  const parts = [lanOk ? "LAN \u2713" : "LAN \u2717"];
  if (adapter.cloudClient) {
    parts.push(adapter.cloudWasConnected ? "Cloud REST \u2713" : "Cloud REST \u2717");
  }
  if (adapter.mqttClient) {
    parts.push(adapter.mqttClient.connected ? "Lights Push \u2713" : "Lights Push \u2717");
  }
  if (adapter.openapiMqttClient) {
    parts.push(adapter.openapiMqttClient.connected ? "Sensor Push \u2713" : "Sensor Push \u2717");
  }
  adapter.log.info(`Govee adapter ready \u2014 ${parts.join("  ")}`);
  if (adapter.cloudClient && !adapter.cloudWasConnected) {
    const reason = adapter.cloudClient.getFailureReason();
    adapter.log.warn(reason ? `Cloud REST: ${reason}` : `Cloud REST: not connected \u2014 see earlier errors`);
  }
  if (adapter.mqttClient && !adapter.mqttClient.connected) {
    const reason = adapter.mqttClient.getFailureReason();
    adapter.log.warn(reason ? `Lights Push: ${reason}` : `Lights Push: not connected \u2014 see earlier errors`);
  }
  if (!lanOk) {
    adapter.log.warn(
      "LAN: no lights reachable on local network \u2014 cloud-only mode is ~100\xD7 slower (5-10s vs 50ms per command) and rate-limited (10/min). Enable the local API in the Govee Home app: https://app-h5.govee.com/user-manual/wlan-guide"
    );
    for (const d of lights) {
      if (!d.lanIp) {
        adapter.log.info(`${(0, import_types.deviceLabel)(d)}: no LAN \u2014 enable the local API in the Govee Home app`);
      }
    }
  }
  const sensors = allDevices.filter(
    (d) => d.type === import_govee_constants.GOVEE_DEVICE_TYPE.SENSOR || d.type === import_govee_constants.GOVEE_DEVICE_TYPE.THERMOMETER
  );
  if (sensors.length > 0 && (!adapter.config.goveeEmail || !adapter.config.goveePassword)) {
    adapter.log.warn(
      `${sensors.length} sensor(s) found, but no Govee account is configured \u2014 sensor readings require email + password (adapter settings, "Govee Account" section)`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkAllReady,
  logDeviceSummary,
  reapStaleDevices,
  refreshLiveAppVersion,
  updateConnectionState
});
//# sourceMappingURL=connection-state.js.map
