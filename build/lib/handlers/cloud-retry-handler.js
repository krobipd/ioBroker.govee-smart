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
var cloud_retry_handler_exports = {};
__export(cloud_retry_handler_exports, {
  buildCloudRetryHost: () => buildCloudRetryHost,
  cloudInitWithTimeout: () => cloudInitWithTimeout,
  ensureCloudRetry: () => ensureCloudRetry,
  handleCloudFailure: () => handleCloudFailure
});
module.exports = __toCommonJS(cloud_retry_handler_exports);
var import_cloud_retry = require("../cloud-retry");
var import_timing_constants = require("../timing-constants");
async function cloudInitWithTimeout(adapter) {
  if (!adapter.deviceManager) {
    return { ok: false, reason: "transient" };
  }
  const loadPromise = adapter.deviceManager.loadFromCloud();
  const timeoutPromise = new Promise((resolve) => {
    adapter.cloudInitTimer = adapter.setTimeout(() => resolve({ ok: false, reason: "transient" }), import_timing_constants.READY_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([loadPromise, timeoutPromise]);
    if (adapter.cloudInitTimer) {
      adapter.clearTimeout(adapter.cloudInitTimer);
      adapter.cloudInitTimer = void 0;
    }
    return result;
  } catch {
    if (adapter.cloudInitTimer) {
      adapter.clearTimeout(adapter.cloudInitTimer);
      adapter.cloudInitTimer = void 0;
    }
    return { ok: false, reason: "transient" };
  }
}
function buildCloudRetryHost(adapter) {
  return {
    log: adapter.log,
    setTimeout: (cb, ms) => adapter.setTimeout(cb, ms),
    clearTimeout: (h) => adapter.clearTimeout(h),
    loadFromCloud: () => cloudInitWithTimeout(adapter),
    onCloudRestored: async () => {
      var _a;
      adapter.actionableProblems.resolve("cloud-auth", "Govee Cloud connected \u2014 API key accepted");
      adapter.cloudWasConnected = true;
      adapter.setState("info.cloudConnected", { val: true, ack: true }).catch(() => {
      });
      (_a = adapter.stateManager) == null ? void 0 : _a.updateGroupsOnline(true).catch(() => {
      });
      await adapter.loadCloudStates();
    }
  };
}
function ensureCloudRetry(adapter) {
  if (!adapter.cloudRetry) {
    adapter.cloudRetry = new import_cloud_retry.CloudRetryLoop(buildCloudRetryHost(adapter));
    adapter.cloudRetry.setConnected(adapter.cloudWasConnected);
  }
  return adapter.cloudRetry;
}
function handleCloudFailure(adapter, result) {
  if (!result.ok && result.reason === "auth-failed") {
    adapter.actionableProblems.report({
      key: "cloud-auth",
      title: "Govee rejected the Cloud API key",
      action: "check the API key in the adapter settings (Cloud API section); generate a fresh one in the Govee Home app if needed"
    });
  }
  ensureCloudRetry(adapter).handleResult(result);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildCloudRetryHost,
  cloudInitWithTimeout,
  ensureCloudRetry,
  handleCloudFailure
});
//# sourceMappingURL=cloud-retry-handler.js.map
