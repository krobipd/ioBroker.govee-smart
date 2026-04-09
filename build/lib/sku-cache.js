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
var sku_cache_exports = {};
__export(sku_cache_exports, {
  SkuCache: () => SkuCache
});
module.exports = __toCommonJS(sku_cache_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
class SkuCache {
  cacheDir;
  log;
  /**
   * @param dataDir Adapter data directory (adapter.getDataDir())
   * @param log ioBroker logger
   */
  constructor(dataDir, log) {
    this.cacheDir = path.join(dataDir, "cache");
    this.log = log;
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }
  /**
   * Load cached data for a specific device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  load(sku, deviceId) {
    const file = this.cacheFile(sku, deviceId);
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        return JSON.parse(raw);
      }
    } catch (e) {
      this.log.debug(
        `Cache read failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return null;
  }
  /**
   * Save device data to cache.
   *
   * @param data Device data to persist
   */
  save(data) {
    const file = this.cacheFile(data.sku, data.deviceId);
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
      this.log.debug(`Cache saved for ${data.sku}`);
    } catch (e) {
      this.log.warn(
        `Cache write failed for ${data.sku}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  /** Load all cached devices. */
  loadAll() {
    const results = [];
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return results;
      }
      for (const file of fs.readdirSync(this.cacheDir)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        try {
          const raw = fs.readFileSync(path.join(this.cacheDir, file), "utf-8");
          results.push(JSON.parse(raw));
        } catch {
        }
      }
    } catch {
    }
    return results;
  }
  /** Delete all cached files. */
  clear() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return;
      }
      for (const file of fs.readdirSync(this.cacheDir)) {
        if (file.endsWith(".json")) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      this.log.debug("Cache cleared");
    } catch (e) {
      this.log.debug(
        `Cache clear failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  /**
   * Build cache file path for a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  cacheFile(sku, deviceId) {
    const shortId = deviceId.replace(/:/g, "").toLowerCase().slice(-4);
    return path.join(this.cacheDir, `${sku.toLowerCase()}_${shortId}.json`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SkuCache
});
//# sourceMappingURL=sku-cache.js.map
