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
var cloud_merge_exports = {};
__export(cloud_merge_exports, {
  applyOnlineCap: () => applyOnlineCap,
  mergeCloudDevices: () => mergeCloudDevices
});
module.exports = __toCommonJS(cloud_merge_exports);
var import_govee_constants = require("../govee-constants");
var import_mapping = require("./mapping");
var import_lookups = require("./lookups");
function mergeCloudDevices(adapter, cloudDevices) {
  var _a;
  let changed = false;
  if (!Array.isArray(cloudDevices)) {
    return false;
  }
  for (const cd of cloudDevices) {
    if (!cd || typeof cd.sku !== "string" || typeof cd.device !== "string") {
      continue;
    }
    if (cd.sku === "SameModeGroup") {
      adapter.log.debug(
        `Cloud: skipping SameModeGroup pseudo-device ${(_a = cd.deviceName) != null ? _a : cd.device} (not a real device)`
      );
      continue;
    }
    const existing = adapter.devices.get((0, import_lookups.deviceKey)(cd.sku, cd.device));
    if (existing) {
      existing.name = cd.deviceName || existing.name;
      existing.capabilities = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      existing.type = cd.type || existing.type;
      existing.channels.cloud = true;
    } else {
      const device = (0, import_mapping.cloudDeviceToGoveeDevice)(cd);
      adapter.devices.set((0, import_lookups.deviceKey)(cd.sku, cd.device), device);
      changed = true;
      adapter.log.debug(`Cloud: New device ${cd.deviceName} (${cd.sku})`);
      adapter.maybeNudgeSeedSku(cd.sku, cd.deviceName);
    }
    const quirks = adapter.registry.getQuirks(cd.sku);
    if (quirks == null ? void 0 : quirks.brokenPlatformApi) {
      adapter.log.debug(`${cd.sku} has known broken platform API metadata \u2014 capabilities may be incomplete`);
    }
  }
  return changed;
}
function applyOnlineCap(adapter, device, caps) {
  var _a;
  let online;
  for (const c of caps) {
    if (c && typeof c.type === "string" && (c.type === import_govee_constants.GOVEE_CAP_TYPE.ONLINE || c.type === "online") && c.state && typeof c.state.value === "boolean") {
      online = c.state.value;
      break;
    }
  }
  if (online === void 0 && caps.length > 0) {
    online = true;
  }
  if (online === void 0) {
    return;
  }
  device.state.cloudReportedOnline = online;
  if (device.state.online === online && online === true) {
    device.lastSeenOnNetwork = Date.now();
    return;
  }
  device.state.online = online;
  if (online) {
    device.lastSeenOnNetwork = Date.now();
  }
  (_a = adapter.onDeviceUpdate) == null ? void 0 : _a.call(adapter, device, { online });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyOnlineCap,
  mergeCloudDevices
});
//# sourceMappingURL=cloud-merge.js.map
