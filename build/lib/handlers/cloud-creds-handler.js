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
var cloud_creds_handler_exports = {};
__export(cloud_creds_handler_exports, {
  cleanupLegacyMqttNativeOnce: () => cleanupLegacyMqttNativeOnce,
  clearVerificationCodeSetting: () => clearVerificationCodeSetting,
  loadPersistedCreds: () => loadPersistedCreds,
  persistCreds: () => persistCreds
});
module.exports = __toCommonJS(cloud_creds_handler_exports);
var import_types = require("../types");
async function clearVerificationCodeSetting(adapter) {
  var _a;
  try {
    const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
    const native = (_a = obj == null ? void 0 : obj.native) != null ? _a : {};
    if (typeof native.mqttVerificationCode !== "string" || native.mqttVerificationCode === "") {
      return;
    }
    await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, {
      native: { mqttVerificationCode: "" }
    });
  } catch (e) {
    adapter.log.warn(`Could not clear mqttVerificationCode: ${(0, import_types.errMessage)(e)}`);
  }
}
const CREDENTIALS_FILE = "mqtt.json";
function credentialsMeta(adapter) {
  return `${adapter.namespace}.credentials`;
}
function parsePersistedBlob(adapter, raw) {
  try {
    const obj = JSON.parse(raw);
    const safeStr = (v) => typeof v === "string" ? v : "";
    const bearerToken = adapter.decrypt(safeStr(obj.bearerToken));
    const p12Cert = adapter.decrypt(safeStr(obj.p12Cert));
    const p12Pass = adapter.decrypt(safeStr(obj.p12Pass));
    const iotEndpoint = safeStr(obj.iotEndpoint);
    const accountId = safeStr(obj.accountId);
    const accountTopic = safeStr(obj.accountTopic);
    const tokenExpiresAt = typeof obj.tokenExpiresAt === "number" ? obj.tokenExpiresAt : 0;
    if (!bearerToken || !iotEndpoint || !p12Cert || !accountId || !accountTopic || !tokenExpiresAt) {
      return null;
    }
    return { bearerToken, iotEndpoint, p12Cert, p12Pass, accountId, accountTopic, tokenExpiresAt };
  } catch {
    return null;
  }
}
async function loadPersistedCreds(adapter) {
  try {
    const { file } = await adapter.readFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE);
    const raw = typeof file === "string" ? file : file.toString("utf-8");
    const creds = raw ? parsePersistedBlob(adapter, raw) : null;
    if (creds) {
      return creds;
    }
  } catch {
  }
  try {
    const s = await adapter.getStateAsync("info.mqttCredentials");
    const raw = typeof (s == null ? void 0 : s.val) === "string" ? s.val : "";
    if (!raw) {
      return null;
    }
    await adapter.writeFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE, raw);
    await adapter.delObjectAsync("info.mqttCredentials").catch(() => void 0);
    adapter.log.info("Migrated persisted MQTT credentials from state to the credentials store");
    return parsePersistedBlob(adapter, raw);
  } catch {
    return null;
  }
}
async function persistCreds(adapter, creds) {
  const blob = JSON.stringify({
    bearerToken: adapter.encrypt(creds.bearerToken),
    iotEndpoint: creds.iotEndpoint,
    p12Cert: adapter.encrypt(creds.p12Cert),
    p12Pass: adapter.encrypt(creds.p12Pass),
    accountId: creds.accountId,
    accountTopic: creds.accountTopic,
    tokenExpiresAt: creds.tokenExpiresAt
  });
  await adapter.writeFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE, blob);
}
async function cleanupLegacyMqttNativeOnce(adapter) {
  var _a;
  try {
    const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
    const native = (_a = obj == null ? void 0 : obj.native) != null ? _a : {};
    const legacy = [
      "mqttBearerToken",
      "mqttIotEndpoint",
      "mqttP12Cert",
      "mqttP12Pass",
      "mqttAccountId",
      "mqttAccountTopic",
      "mqttTokenExpiresAt"
    ];
    const dirty = legacy.some((k) => k in native && native[k] !== "" && native[k] !== 0);
    if (!dirty) {
      return;
    }
    adapter.log.info(`Removing legacy plaintext MQTT credentials from native (one-time migration)`);
    const wipe = {};
    for (const k of legacy) {
      wipe[k] = k === "mqttTokenExpiresAt" ? 0 : "";
    }
    await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: wipe });
  } catch (e) {
    adapter.log.debug(`legacy MQTT cleanup skipped: ${(0, import_types.errMessage)(e)}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cleanupLegacyMqttNativeOnce,
  clearVerificationCodeSetting,
  loadPersistedCreds,
  persistCreds
});
//# sourceMappingURL=cloud-creds-handler.js.map
