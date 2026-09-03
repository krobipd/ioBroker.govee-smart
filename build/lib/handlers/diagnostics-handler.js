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
  diagnosticsFileName: () => diagnosticsFileName,
  handleDiagnosticsExport: () => handleDiagnosticsExport
});
module.exports = __toCommonJS(diagnostics_handler_exports);
var import_types = require("../types");
var import_timing_constants = require("../timing-constants");
var import_device_key = require("../device-key");
function diagnosticsFileName(device, adapterVersion, now) {
  const shortId = device.deviceId.replace(/:/g, "").slice(-4).toLowerCase();
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `govee-smart_${device.sku}_${shortId}_v${adapterVersion}_${day}_${time}.json`;
}
async function pruneOlderReports(adapter, meta, device) {
  const shortId = device.deviceId.replace(/:/g, "").slice(-4).toLowerCase();
  const prefix = `govee-smart_${device.sku}_${shortId}_`;
  const entries = await adapter.readDirAsync(meta, "").catch(() => []);
  const mine = entries.filter((e) => !e.isDir && e.file.startsWith(prefix)).map((e) => e.file).sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - import_timing_constants.DIAGNOSTICS_KEEP_PER_DEVICE))) {
    await adapter.delFileAsync(meta, stale).catch(() => void 0);
  }
}
async function handleDiagnosticsExport(adapter, deviceManager, lastRun, device, prefix) {
  var _a, _b;
  const deviceKey = (0, import_device_key.sessionKey)(device.sku, device.deviceId);
  const now = Date.now();
  const last = (_a = lastRun.get(deviceKey)) != null ? _a : 0;
  if (now - last < import_timing_constants.DIAGNOSTICS_EXPORT_THROTTLE_MS) {
    adapter.log.debug(`Diagnostics export throttled for ${(0, import_types.deviceLabel)(device)} \u2014 last run ${now - last}ms ago`);
    return null;
  }
  lastRun.set(deviceKey, now);
  const version = (_b = adapter.version) != null ? _b : "unknown";
  const meta = `${adapter.namespace}.diagnostics`;
  const fileName = diagnosticsFileName(device, version, new Date(now));
  try {
    const diag = await deviceManager.generateDiagnostics(device, version, prefix);
    await adapter.writeFileAsync(meta, fileName, JSON.stringify(diag, null, 2));
    await pruneOlderReports(adapter, meta, device);
    await adapter.setState(`${adapter.namespace}.${prefix}.diag.lastExport`, {
      val: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ack: true
    });
    adapter.log.info(`Diagnostics report for ${(0, import_types.deviceLabel)(device)} written to ${fileName}`);
    return fileName;
  } catch (e) {
    adapter.log.warn(
      `Diagnostics export for ${(0, import_types.deviceLabel)(device)} failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  diagnosticsFileName,
  handleDiagnosticsExport
});
//# sourceMappingURL=diagnostics-handler.js.map
