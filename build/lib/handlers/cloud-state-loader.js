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
var cloud_state_loader_exports = {};
__export(cloud_state_loader_exports, {
  applyCloudCapabilities: () => applyCloudCapabilities,
  loadCloudStates: () => loadCloudStates
});
module.exports = __toCommonJS(cloud_state_loader_exports);
var import_capability_mapper = require("../capability-mapper");
var import_types = require("../types");
async function loadCloudStates(adapter, only) {
  if (!adapter.cloudClient || !adapter.deviceManager || !adapter.stateManager) {
    return;
  }
  const targets = adapter.deviceManager.getDevices().filter((d) => d.channels.cloud && d.capabilities.length > 0 && (!only || d === only));
  for (const device of targets) {
    const loadOne = async () => {
      var _a;
      if (!adapter.cloudClient || !adapter.stateManager) {
        return;
      }
      try {
        const caps = await adapter.cloudClient.getDeviceState(device.sku, device.deviceId);
        (_a = adapter.deviceManager) == null ? void 0 : _a.applyCloudStateOnline(device, caps);
        const prefix = adapter.stateManager.devicePrefix(device);
        const writes = [];
        for (const cap of caps) {
          const mapped = (0, import_capability_mapper.mapCloudStateValue)(cap);
          if (!mapped) {
            continue;
          }
          if (device.lanIp && import_capability_mapper.LAN_STATE_IDS.has(mapped.stateId)) {
            continue;
          }
          const statePath = adapter.stateManager.resolveStatePath(prefix, mapped.stateId);
          writes.push(
            adapter.setState(statePath, { val: mapped.value, ack: true }).catch((0, import_types.logRejected)(adapter.log, `write ${statePath}`))
          );
        }
        await Promise.all(writes);
        adapter.log.debug(`Cloud state loaded for ${(0, import_types.deviceLabel)(device)}`);
      } catch (e) {
        if (adapter.deviceManager) {
          const status = e && typeof e === "object" && "statusCode" in e ? e.statusCode : void 0;
          adapter.deviceManager.getDiagnostics().recordApiFailure(device.deviceId, "/router/api/v1/device/state", e, status);
        }
        adapter.log.debug(`Could not load Cloud state for ${(0, import_types.deviceLabel)(device)}`);
      }
    };
    if (adapter.rateLimiter) {
      await adapter.rateLimiter.tryExecute(loadOne, 2);
    } else {
      await loadOne();
    }
  }
  if (targets.length > 0) {
    adapter.log.debug(`Cloud state load dispatched for ${targets.length} device(s) (rate-limited)`);
  }
}
async function applyCloudCapabilities(adapter, device, caps) {
  if (!adapter.stateManager) {
    return;
  }
  const prefix = adapter.stateManager.devicePrefix(device);
  const planned = (0, import_capability_mapper.planCloudCapabilityWrites)(caps, Boolean(device.lanIp), import_capability_mapper.LAN_STATE_IDS);
  for (const mapped of planned) {
    await adapter.stateManager.ensureSyntheticStateObject(prefix, mapped.stateId);
    if (mapped.value !== null && mapped.value !== void 0) {
      device.state[mapped.stateId] = mapped.value;
    }
  }
  const writes = planned.map((mapped) => {
    const statePath = adapter.stateManager.resolveStatePath(prefix, mapped.stateId);
    return adapter.setState(statePath, { val: mapped.value, ack: true }).catch((0, import_types.logRejected)(adapter.log, `write ${statePath}`));
  });
  await Promise.all(writes);
  const hasTempCap = device.capabilities.some((c) => c.instance === "sensorTemperature");
  const hasHumidityCap = device.capabilities.some((c) => c.instance === "sensorHumidity");
  if (hasTempCap && !hasHumidityCap) {
    await adapter.stateManager.removeSyntheticStateOnce(prefix, "humidity");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyCloudCapabilities,
  loadCloudStates
});
//# sourceMappingURL=cloud-state-loader.js.map
