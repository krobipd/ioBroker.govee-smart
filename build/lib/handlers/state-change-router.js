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
var state_change_router_exports = {};
__export(state_change_router_exports, {
  findDeviceForState: () => findDeviceForState,
  handleGenericCapabilityCommand: () => handleGenericCapabilityCommand,
  handleManualSegmentsChange: () => handleManualSegmentsChange,
  onStateChange: () => onStateChange,
  resolveDropdownInput: () => resolveDropdownInput,
  sendMusicCommand: () => sendMusicCommand
});
module.exports = __toCommonJS(state_change_router_exports);
var import_device_manager = require("../device-manager");
var import_govee_constants = require("../govee-constants");
var import_types = require("../types");
var cloudRetryHandler = __toESM(require("./cloud-retry-handler"));
var diagnosticsHandler = __toESM(require("./diagnostics-handler"));
var dropdownReset = __toESM(require("./dropdown-reset-helpers"));
function findDeviceForState(adapter, localId) {
  if (!adapter.deviceManager || !adapter.stateManager) {
    return void 0;
  }
  for (const device of adapter.deviceManager.getDevices()) {
    const prefix = adapter.stateManager.devicePrefix(device);
    if (localId.startsWith(`${prefix}.`)) {
      return device;
    }
  }
  return void 0;
}
async function resolveDropdownInput(adapter, id, raw) {
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
  const obj = await adapter.getObjectAsync(id);
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
async function sendMusicCommand(adapter, device, prefix, changedSuffix, newValue) {
  var _a, _b;
  const musicBase = `${adapter.namespace}.${prefix}.music`;
  const modeState = await adapter.getStateAsync(`${musicBase}.music_mode`);
  const sensState = await adapter.getStateAsync(`${musicBase}.music_sensitivity`);
  const autoState = await adapter.getStateAsync(`${musicBase}.music_auto_color`);
  const musicMode = changedSuffix === "music.music_mode" ? parseInt(String(newValue), 10) : parseInt(String((_a = modeState == null ? void 0 : modeState.val) != null ? _a : 0), 10);
  const sensitivity = changedSuffix === "music.music_sensitivity" ? newValue : (_b = sensState == null ? void 0 : sensState.val) != null ? _b : 100;
  const autoColor = changedSuffix === "music.music_auto_color" ? newValue ? 1 : 0 : (autoState == null ? void 0 : autoState.val) ? 1 : 0;
  if (!musicMode || musicMode === 0) {
    adapter.log.debug("Music mode not selected, skipping command");
    return;
  }
  if (device.lanIp && adapter.lanClient) {
    let r = 0, g = 0, b = 0;
    if (musicMode === 1 || musicMode === 2) {
      const colorState = await adapter.getStateAsync(`${adapter.namespace}.${prefix}.control.colorRgb`);
      if ((colorState == null ? void 0 : colorState.val) && typeof colorState.val === "string") {
        ({ r, g, b } = (0, import_types.hexToRgb)(colorState.val));
      }
    }
    adapter.lanClient.setMusicMode(device.lanIp, musicMode, r, g, b);
    return;
  }
  const structValue = {
    musicMode,
    sensitivity,
    autoColor
  };
  await adapter.deviceManager.sendCapabilityCommand(device, import_govee_constants.GOVEE_CAP_TYPE.MUSIC_SETTING, "musicMode", structValue);
}
async function handleManualSegmentsChange(adapter, device, suffix, newValue) {
  const modeVal = suffix === "segments.manual_mode" ? Boolean(newValue) : device.manualMode === true;
  const listVal = suffix === "segments.manual_list" ? typeof newValue === "string" ? newValue : "" : Array.isArray(device.manualSegments) ? device.manualSegments.join(",") : "";
  if (!modeVal) {
    adapter.log.info(`${device.name}: manual segments disabled \u2014 strip treated as contiguous`);
    await adapter.applyManualSegments(device, false);
    return;
  }
  const maxIndex = typeof device.segmentCount === "number" && device.segmentCount > 0 ? device.segmentCount - 1 : import_device_manager.SEGMENT_HARD_MAX;
  const parsed = (0, import_types.parseSegmentList)(listVal, maxIndex);
  if (parsed.error) {
    adapter.log.warn(`${device.name}: manual_list invalid (${parsed.error}) \u2014 disabling manual mode`);
    await adapter.applyManualSegments(device, false);
    return;
  }
  adapter.log.debug(`${device.name}: manual segments active \u2014 ${parsed.indices.length} physical indices (${listVal})`);
  await adapter.applyManualSegments(device, true, parsed.indices);
}
async function handleGenericCapabilityCommand(adapter, device, id, stateSuffix, val) {
  var _a, _b;
  if (!adapter.deviceManager) {
    return;
  }
  const obj = await adapter.getObjectAsync(id);
  const capType = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.capabilityType;
  const capInstance = (_b = obj == null ? void 0 : obj.native) == null ? void 0 : _b.capabilityInstance;
  if (typeof capType === "string" && typeof capInstance === "string") {
    try {
      adapter.log.debug(
        `Routing to generic capability for ${device.name}: cap=${capType}/${capInstance} state=${stateSuffix} val=${JSON.stringify(val)}`
      );
      await adapter.deviceManager.sendCapabilityCommand(device, capType, capInstance, val);
      await adapter.setStateAsync(id, { val, ack: true });
    } catch (err) {
      adapter.log.warn(`Command failed for ${device.name}: ${(0, import_types.errMessage)(err)}`);
    }
  } else {
    adapter.log.debug(
      `No handler matched for ${device.name} (${device.sku}) state=${stateSuffix} val=${JSON.stringify(val)} \u2014 writable state without command mapping or capability metadata, silently ignored`
    );
  }
}
async function onStateChange(adapter, id, state) {
  var _a, _b;
  if (!state || state.ack) {
    return;
  }
  if (!adapter.deviceManager || !adapter.stateManager) {
    adapter.log.debug(`onStateChange ignored ${id}: adapter not ready (deviceManager/stateManager missing)`);
    return;
  }
  if (adapter.unloading) {
    adapter.log.debug(`onStateChange ignored ${id}: adapter is unloading`);
    return;
  }
  const localId = id.replace(`${adapter.namespace}.`, "");
  if (localId === "info.manual_sync_devices") {
    if (state.val) {
      adapter.log.info("Manual device sync requested \u2014 refreshing the device list from your Govee account");
      await ((_a = adapter.syncDevicesManually) == null ? void 0 : _a.call(adapter));
    }
    await adapter.setStateAsync(id, { val: false, ack: true });
    return;
  }
  if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
    adapter.log.debug(`onStateChange ignored ${id}: not a devices.* / groups.* path`);
    return;
  }
  const device = findDeviceForState(adapter, localId);
  if (!device) {
    adapter.log.debug(`onStateChange ignored ${id}: no device matches this state path`);
    return;
  }
  const prefix = adapter.stateManager.devicePrefix(device);
  const stateSuffix = localId.slice(prefix.length + 1);
  adapter.log.debug(
    `onStateChange ${id}: device=${device.name} (${device.sku}) suffix=${stateSuffix} val=${JSON.stringify(state.val)}`
  );
  adapter.deviceManager.getDiagnostics().addLog(device.deviceId, "debug", `User-write ${stateSuffix}=${JSON.stringify(state.val)}`);
  const resolved = await resolveDropdownInput(adapter, id, state.val);
  if (!resolved.ok) {
    adapter.log.warn(`Unknown dropdown value for ${id}: ${String(state.val)} \u2014 ignoring`);
    return;
  }
  const val = resolved.val;
  if (device.sku === "BaseGroup" && device.groupMembers) {
    await adapter.groupFanout.fanOut(device, stateSuffix, val);
    await adapter.setStateAsync(id, { val, ack: true });
    if (stateSuffix === "scenes.light_scene" || stateSuffix === "music.music_mode") {
      await dropdownReset.resetRelatedDropdowns(
        adapter,
        prefix,
        stateSuffix === "scenes.light_scene" ? "lightScene" : "music"
      );
    }
    return;
  }
  if (stateSuffix === "snapshots.snapshot_save" && typeof val === "string" && val.trim()) {
    await adapter.snapshotHandler.save(device, val.trim());
    await adapter.setStateAsync(id, { val: "", ack: true });
    return;
  }
  if (stateSuffix === "snapshots.snapshot_local") {
    if (val !== "0" && val !== 0) {
      await adapter.snapshotHandler.restore(device, val);
      await dropdownReset.resetRelatedDropdowns(adapter, prefix, "snapshotLocal");
    }
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }
  if (stateSuffix === "snapshots.snapshot_delete" && typeof val === "string" && val.trim()) {
    await adapter.snapshotHandler.delete(device, val.trim());
    await adapter.setStateAsync(id, { val: "", ack: true });
    return;
  }
  if (stateSuffix === "snapshots.refresh_cloud" && val) {
    if (adapter.deviceManager) {
      adapter.log.info(`Refresh cloud data for ${device.name} (${device.sku}): re-fetching scenes and snapshots`);
      try {
        const changed = await adapter.deviceManager.refreshSceneDataForDevice(device.deviceId);
        if (changed) {
          await cloudRetryHandler.reloadCloudStates(adapter);
        }
      } catch (e) {
        adapter.log.warn(`Refresh cloud data for ${device.name} failed: ${(0, import_types.errMessage)(e)}`);
      }
    }
    await adapter.setStateAsync(id, { val: false, ack: true });
    return;
  }
  if (stateSuffix === "segments.manual_mode" || stateSuffix === "segments.manual_list") {
    await handleManualSegmentsChange(adapter, device, stateSuffix, val);
    return;
  }
  if (stateSuffix === "diag.export" && val) {
    if (adapter.deviceManager) {
      await diagnosticsHandler.handleDiagnosticsExport(
        adapter,
        adapter.deviceManager,
        adapter.diagnosticsLastRun,
        device,
        prefix,
        id
      );
    }
    return;
  }
  const command = dropdownReset.stateToCommand(stateSuffix);
  if (!command) {
    await handleGenericCapabilityCommand(adapter, device, id, stateSuffix, val);
    return;
  }
  if ((command === "lightScene" || command === "diyScene" || command === "snapshot") && (val === "0" || val === 0)) {
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }
  if (command === "sceneSpeed") {
    const level = typeof val === "number" ? val : parseInt(String(val), 10);
    if (!isNaN(level)) {
      device.sceneSpeed = level;
      (_b = adapter.deviceManager) == null ? void 0 : _b.persistDeviceToCache(device);
    }
    await adapter.setStateAsync(id, { val, ack: true });
    return;
  }
  try {
    if (command === "music") {
      if (stateSuffix === "music.music_mode" && (val === "0" || val === 0)) {
        await adapter.setStateAsync(id, { val, ack: true });
        return;
      }
      await sendMusicCommand(adapter, device, prefix, stateSuffix, val);
      await adapter.setStateAsync(id, { val, ack: true });
      if (stateSuffix === "music.music_mode") {
        await dropdownReset.resetRelatedDropdowns(adapter, prefix, "music");
      }
      return;
    }
    await adapter.deviceManager.sendCommand(device, command, val);
    await adapter.setStateAsync(id, { val, ack: true });
    if (command === "power" && val === false) {
      await dropdownReset.resetModeDropdowns(adapter, prefix, "");
    } else {
      await dropdownReset.resetRelatedDropdowns(adapter, prefix, command);
    }
  } catch (err) {
    adapter.log.warn(`Command failed for ${device.name}: ${(0, import_types.errMessage)(err)}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  findDeviceForState,
  handleGenericCapabilityCommand,
  handleManualSegmentsChange,
  onStateChange,
  resolveDropdownInput,
  sendMusicCommand
});
//# sourceMappingURL=state-change-router.js.map
