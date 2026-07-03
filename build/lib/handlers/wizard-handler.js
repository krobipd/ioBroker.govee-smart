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
var wizard_handler_exports = {};
__export(wizard_handler_exports, {
  applyWizardResult: () => applyWizardResult,
  buildWizardHost: () => buildWizardHost,
  deviceKeyFor: () => deviceKeyFor,
  findDeviceByKey: () => findDeviceByKey,
  runWizardStep: () => runWizardStep
});
module.exports = __toCommonJS(wizard_handler_exports);
var import_segment_wizard = require("../segment-wizard");
var import_types = require("../types");
var import_device_key = require("../device-key");
function deviceKeyFor(device) {
  return (0, import_device_key.sessionKey)(device.sku, device.deviceId);
}
function findDeviceByKey(adapter, key) {
  var _a, _b;
  const devices = (_b = (_a = adapter.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
  return devices.find((d) => deviceKeyFor(d) === key);
}
function buildWizardHost(adapter) {
  return {
    log: adapter.log,
    getState: (id) => adapter.getStateAsync(id),
    sendCommand: async (device, command, value) => {
      var _a;
      await ((_a = adapter.deviceManager) == null ? void 0 : _a.sendCommand(device, command, value));
    },
    flashSegmentAtomic: (device, idx) => {
      if (!device.lanIp || !adapter.lanClient) {
        return Promise.resolve(false);
      }
      adapter.lanClient.flashSingleSegment(device.lanIp, idx);
      return Promise.resolve(true);
    },
    restoreStripAtomic: (device, total, color, brightness) => {
      if (!device.lanIp || !adapter.lanClient) {
        return Promise.resolve(false);
      }
      const r = color >> 16 & 255;
      const g = color >> 8 & 255;
      const b = color & 255;
      adapter.lanClient.restoreAllSegments(device.lanIp, total, r, g, b, brightness);
      return Promise.resolve(true);
    },
    findDevice: (key) => findDeviceByKey(adapter, key),
    namespace: adapter.namespace,
    devicePrefix: (device) => {
      var _a, _b;
      return (_b = (_a = adapter.stateManager) == null ? void 0 : _a.devicePrefix(device)) != null ? _b : "";
    },
    setTimeout: (cb, ms) => adapter.setTimeout(cb, ms),
    clearTimeout: (h) => adapter.clearTimeout(h),
    applyWizardResult: (device, result) => applyWizardResult(adapter, device, result)
  };
}
async function applyWizardResult(adapter, device, result) {
  device.segmentCount = result.segmentCount;
  if (result.hasGaps) {
    const parsed = (0, import_types.parseSegmentList)(result.manualList, result.segmentCount - 1);
    await adapter.applyManualSegments(device, true, parsed.error ? void 0 : parsed.indices);
  } else {
    await adapter.applyManualSegments(device, false);
  }
  adapter.log.debug(
    `applyWizardResult: ${device.sku} \u2192 segmentCount=${result.segmentCount}, manualMode=${device.manualMode}, list="${result.manualList}"`
  );
}
async function runWizardStep(adapter, action, deviceKey) {
  if (!adapter.segmentWizard) {
    adapter.segmentWizard = new import_segment_wizard.SegmentWizard(buildWizardHost(adapter));
  }
  const response = await adapter.segmentWizard.runStep(action, deviceKey);
  const statusText = adapter.segmentWizard.getStatusText();
  await adapter.setState("info.wizardStatus", {
    val: statusText,
    ack: true
  });
  return response;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyWizardResult,
  buildWizardHost,
  deviceKeyFor,
  findDeviceByKey,
  runWizardStep
});
//# sourceMappingURL=wizard-handler.js.map
