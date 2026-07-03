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
var device_events_exports = {};
__export(device_events_exports, {
  onCloudDataReady: () => onCloudDataReady,
  onDeviceStateUpdate: () => onDeviceStateUpdate,
  onGroupMembersReady: () => onGroupMembersReady,
  onLanDeviceReady: () => onLanDeviceReady
});
module.exports = __toCommonJS(device_events_exports);
var import_capability_mapper = require("../capability-mapper");
var import_device_registry = require("../device-registry");
var import_govee_constants = require("../govee-constants");
var import_types = require("../types");
var connectionState = __toESM(require("./connection-state"));
var groupFanoutHandler = __toESM(require("./group-fanout-handler"));
var dropdownReset = __toESM(require("./dropdown-reset-helpers"));
function onDeviceStateUpdate(adapter, device, state) {
  if (adapter.statesReady && adapter.stateManager) {
    adapter.stateManager.updateDeviceState(device, state).catch(() => {
    });
  }
  connectionState.updateConnectionState(adapter);
  if (state.online !== void 0) {
    groupFanoutHandler.updateGroupReachability(adapter);
    if (device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && adapter.stateManager) {
      adapter.stateManager.syncInfoOnline(device).catch(() => void 0);
    }
  }
  const powerOff = state.power === false || state.power === 0;
  if (powerOff && adapter.stateManager) {
    const prefix = adapter.stateManager.devicePrefix(device);
    dropdownReset.resetModeDropdowns(adapter, prefix, "").catch(() => void 0);
  }
}
function trackStateCreation(adapter, p) {
  if (!adapter.statesReady) {
    adapter.stateCreationQueue.push(p);
  } else {
    void p;
  }
}
function onLanDeviceReady(adapter, device, _allDevices) {
  if (!adapter.stateManager) {
    return;
  }
  const sm = adapter.stateManager;
  const p = (async () => {
    await sm.createInfoStates(device);
    await sm.createLanStates(device);
  })().catch((e) => {
    adapter.log.error(`onLanDeviceReady failed for ${device.name}: ${(0, import_types.errMessage)(e)}`);
  });
  trackStateCreation(adapter, p);
  connectionState.updateConnectionState(adapter);
}
function onCloudDataReady(adapter, device, allDevices) {
  var _a, _b;
  if (!adapter.stateManager) {
    return;
  }
  const sm = adapter.stateManager;
  const localSnaps = (_a = adapter.localSnapshots) == null ? void 0 : _a.getSnapshots(device.sku, device.deviceId);
  let memberDevices;
  if (device.sku === "BaseGroup" && device.groupMembers) {
    memberDevices = groupFanoutHandler.resolveGroupMembers(device, allDevices);
  }
  const cloudDefs = (0, import_capability_mapper.buildCloudStateDefs)(device, adapter.log, localSnaps, memberDevices);
  const capN = Array.isArray(device.capabilities) ? device.capabilities.length : 0;
  adapter.log.debug(
    `buildCloudStateDefs for ${device.sku} ${device.deviceId}: ${capN} cap(s) in \u2192 ${cloudDefs.length} state def(s) out`
  );
  const p = (async () => {
    await sm.createInfoStates(device);
    await sm.createLanStates(device);
    await sm.createCloudStates(device, cloudDefs);
    await sm.migrateLegacyDiagnostics(device);
    await sm.updateDeviceTier(device, (0, import_device_registry.getDeviceTier)(device.sku));
  })().catch((e) => {
    adapter.log.error(`onCloudDataReady failed for ${device.name}: ${(0, import_types.errMessage)(e)}`);
  });
  trackStateCreation(adapter, p);
  connectionState.updateConnectionState(adapter);
  if (adapter.statesReady) {
    (_b = adapter.reapStaleDevices) == null ? void 0 : _b.call(adapter).catch(() => void 0);
  }
}
function onGroupMembersReady(adapter, group, allDevices) {
  onCloudDataReady(adapter, group, allDevices);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  onCloudDataReady,
  onDeviceStateUpdate,
  onGroupMembersReady,
  onLanDeviceReady
});
//# sourceMappingURL=device-events.js.map
