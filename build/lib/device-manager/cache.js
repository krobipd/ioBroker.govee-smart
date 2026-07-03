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
var cache_exports = {};
__export(cache_exports, {
  cachedToGoveeDevice: () => cachedToGoveeDevice,
  goveeDeviceToCached: () => goveeDeviceToCached,
  persistDeviceToCache: () => persistDeviceToCache,
  populateScenesFromLibrary: () => populateScenesFromLibrary,
  saveDevicesToCache: () => saveDevicesToCache
});
module.exports = __toCommonJS(cache_exports);
var import_govee_constants = require("../govee-constants");
function populateScenesFromLibrary(adapter, device) {
  if (device.scenes.length === 0 && device.sceneLibrary.length > 0) {
    device.scenes = device.sceneLibrary.map((entry) => ({
      name: entry.name,
      value: {}
      // ptReal uses sceneLibrary directly, Cloud payload not needed
    }));
    adapter.log.debug(`${device.sku}: ${device.scenes.length} scenes from library (Cloud scenes missing)`);
  }
}
function cachedToGoveeDevice(cached) {
  const {
    cachedAt: _cachedAt,
    // Cast-through 'unknown' because TypeScript doesn't know the malformed
    // cache could carry these fields; we want the destructure-discard either way.
    state: _state,
    channels: _channels,
    lanIp: _lanIp,
    groupMembers: _groupMembers,
    lastLanReplyAt: _lastLanReplyAt,
    ...rest
  } = cached;
  return {
    ...rest,
    state: { online: false },
    channels: { lan: false, mqtt: false, cloud: false }
  };
}
function goveeDeviceToCached(device) {
  const {
    state: _state,
    channels: _channels,
    lanIp: _lanIp,
    groupMembers: _groupMembers,
    lastLanReplyAt: _lastLanReplyAt,
    ...cacheable
  } = device;
  return {
    ...normalize(cacheable),
    cachedAt: Date.now()
  };
}
function normalize(d) {
  const segmentCount = typeof d.segmentCount === "number" && d.segmentCount > 0 ? d.segmentCount : void 0;
  const manualMode = d.manualMode ? true : void 0;
  const manualSegments = manualMode && Array.isArray(d.manualSegments) && d.manualSegments.length > 0 ? d.manualSegments.slice() : void 0;
  const sceneSpeed = typeof d.sceneSpeed === "number" && d.sceneSpeed > 0 ? d.sceneSpeed : void 0;
  const accountMissCount = typeof d.accountMissCount === "number" && d.accountMissCount > 0 ? d.accountMissCount : void 0;
  return {
    ...d,
    segmentCount,
    manualMode,
    manualSegments,
    sceneSpeed,
    accountMissCount
  };
}
function persistDeviceToCache(adapter, device) {
  if (!adapter.skuCache) {
    return;
  }
  adapter.skuCache.save(goveeDeviceToCached(device));
}
function saveDevicesToCache(adapter) {
  if (!adapter.skuCache) {
    return;
  }
  let cachedCount = 0;
  let skippedCount = 0;
  for (const device of adapter.devices.values()) {
    const isLight = device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT;
    if (isLight && !device.scenesChecked) {
      skippedCount++;
      adapter.log.debug(`Not caching ${device.name} (${device.sku}) \u2014 scenes not yet checked`);
    } else {
      adapter.skuCache.save(goveeDeviceToCached(device));
      cachedCount++;
    }
  }
  if (skippedCount > 0) {
    adapter.log.debug(`Cached ${cachedCount} device(s), skipped ${skippedCount} not yet checked`);
  } else {
    adapter.log.debug(`Cached ${cachedCount} device(s) \u2014 next start uses cache`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cachedToGoveeDevice,
  goveeDeviceToCached,
  persistDeviceToCache,
  populateScenesFromLibrary,
  saveDevicesToCache
});
//# sourceMappingURL=cache.js.map
