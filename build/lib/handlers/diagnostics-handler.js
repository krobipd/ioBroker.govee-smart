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
var diagnostics_handler_exports = {};
__export(diagnostics_handler_exports, {
  handleDiagnosticsExport: () => handleDiagnosticsExport
});
module.exports = __toCommonJS(diagnostics_handler_exports);
var import_timing_constants = require("../timing-constants");
var import_device_key = require("../device-key");
async function handleDiagnosticsExport(adapter, deviceManager, lastRun, device, prefix, triggerStateId) {
  var _a, _b;
  const deviceKey = (0, import_device_key.sessionKey)(device.sku, device.deviceId);
  const now = Date.now();
  const last = (_a = lastRun.get(deviceKey)) != null ? _a : 0;
  if (now - last < import_timing_constants.DIAGNOSTICS_EXPORT_THROTTLE_MS) {
    adapter.log.debug(`Diagnostics export throttled for ${device.name} \u2014 last run ${now - last}ms ago`);
    await adapter.setState(triggerStateId, { val: false, ack: true });
    return;
  }
  lastRun.set(deviceKey, now);
  const diag = deviceManager.generateDiagnostics(device, (_b = adapter.version) != null ? _b : "unknown");
  const resultId = `${adapter.namespace}.${prefix}.diag.result`;
  await adapter.setState(resultId, {
    val: JSON.stringify(diag, null, 2),
    ack: true
  });
  await adapter.setState(triggerStateId, { val: false, ack: true });
  adapter.log.info(`Diagnostics exported for ${device.name} (${device.sku})`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handleDiagnosticsExport
});
//# sourceMappingURL=diagnostics-handler.js.map
