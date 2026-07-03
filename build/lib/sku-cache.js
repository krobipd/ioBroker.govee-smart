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
var import_types = require("./types");
var import_device_key = require("./device-key");
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
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      this.dataAvailable = true;
    } catch (e) {
      this.dataAvailable = false;
      this.log.warn(`Cache directory not writable (${this.cacheDir}): ${(0, import_types.errMessage)(e)}`);
    }
  }
  /** False when the cache dir is not accessible — save/load then skip. */
  dataAvailable = false;
  /**
   * Save device data to cache.
   *
   * @param data Device data to persist
   */
  save(data) {
    if (!this.dataAvailable) {
      return;
    }
    const file = this.cacheFile(data.sku, data.deviceId);
    try {
      const fd = fs.openSync(file, "w");
      try {
        fs.writeSync(fd, JSON.stringify(data, null, 2), 0, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const sceneN = Array.isArray(data.sceneLibrary) ? data.sceneLibrary.length : 0;
      const musicN = Array.isArray(data.musicLibrary) ? data.musicLibrary.length : 0;
      const diyN = Array.isArray(data.diyLibrary) ? data.diyLibrary.length : 0;
      const snapN = Array.isArray(data.snapshotBleCmds) ? data.snapshotBleCmds.length : 0;
      this.log.debug(
        `Cache saved for ${data.sku} (scenes=${sceneN}, music=${musicN}, diy=${diyN}, snapshotBleCmds=${snapN})`
      );
    } catch (e) {
      this.log.warn(`Cache write failed for ${data.sku}: ${(0, import_types.errMessage)(e)}`);
    }
  }
  /**
   * Load a single cached entry by sku+deviceId — used by the diag-export
   * pipeline to surface the on-disk view per-device without re-reading the
   * whole cache dir. Returns null when no file exists or the JSON is corrupt.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  loadOne(sku, deviceId) {
    if (!this.dataAvailable) {
      return null;
    }
    const file = this.cacheFile(sku, deviceId);
    try {
      if (!fs.existsSync(file)) {
        return null;
      }
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      this.log.debug(`Cache loadOne failed for ${sku}: ${(0, import_types.errMessage)(e)}`);
      return null;
    }
  }
  /** Load all cached devices. */
  loadAll() {
    const results = [];
    if (!this.dataAvailable) {
      this.log.debug(`Cache load: skipped \u2014 cache directory not available (${this.cacheDir})`);
      return results;
    }
    let corruptCount = 0;
    let skippedFiles = 0;
    try {
      if (!fs.existsSync(this.cacheDir)) {
        this.log.debug(`Cache load: miss \u2014 directory does not exist yet (${this.cacheDir})`);
        return results;
      }
      for (const file of fs.readdirSync(this.cacheDir)) {
        if (!file.endsWith(".json")) {
          skippedFiles++;
          continue;
        }
        try {
          const raw = fs.readFileSync(path.join(this.cacheDir, file), "utf-8");
          results.push(JSON.parse(raw));
        } catch {
          corruptCount++;
        }
      }
    } catch {
    }
    if (results.length === 0) {
      this.log.debug(`Cache load: miss \u2014 no cached devices found in ${this.cacheDir}`);
    } else {
      const now = Date.now();
      const ages = results.map((d) => typeof d.lastSeenOnNetwork === "number" ? now - d.lastSeenOnNetwork : -1).filter((a) => a >= 0);
      const ageInfo = ages.length === results.length ? ` (oldest=${Math.round(Math.max(...ages) / 864e5)}d, newest=${Math.round(Math.min(...ages) / 864e5)}d)` : ages.length === 0 ? " (no age data, legacy entries)" : ` (${results.length - ages.length} legacy entry/entries without age)`;
      this.log.debug(
        `Cache load: hit \u2014 ${results.length} device(s)${ageInfo}${corruptCount > 0 ? `, ${corruptCount} corrupt file(s) skipped` : ""}${skippedFiles > 0 ? `, ${skippedFiles} non-json file(s) skipped` : ""}`
      );
    }
    return results;
  }
  /**
   * Remove cache entries that have not been seen on the local network within maxAgeDays.
   * Entries without `lastSeenOnNetwork` (legacy) are treated as just seen to avoid
   * accidentally deleting them on first upgrade.
   *
   * @param maxAgeDays  Age threshold in days (default 14)
   * @returns  Number of pruned entries
   */
  pruneStale(maxAgeDays = 14) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3;
    const nowMs = Date.now();
    let pruned = 0;
    const prunedDetails = [];
    this.forEachCacheFile((full) => {
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data.lastSeenOnNetwork !== "number") {
          return;
        }
        if (data.lastSeenOnNetwork < cutoff) {
          const ageDays = Math.round((nowMs - data.lastSeenOnNetwork) / 864e5);
          fs.unlinkSync(full);
          pruned++;
          prunedDetails.push(`${data.sku} ${data.deviceId} (${ageDays}d)`);
        }
      } catch {
      }
    });
    if (pruned > 0) {
      this.log.info(
        `Cache: pruned ${pruned} stale entries (not seen for ${maxAgeDays}+ days): ${prunedDetails.join(", ")}`
      );
    }
    return pruned;
  }
  /**
   * Delete the cache file for a single device — used by the account-reconciler
   * when a device is removed from the Govee account, so the next start does not
   * rehydrate the deleted device from cache (the third store the removal must
   * touch, alongside the in-memory map and the ioBroker objects). No-op when
   * the file is already gone.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  evictDevice(sku, deviceId) {
    if (!this.dataAvailable) {
      return;
    }
    const file = this.cacheFile(sku, deviceId);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        this.log.debug(`Cache: evicted ${sku} ${deviceId} (removed from Govee account)`);
      }
    } catch (e) {
      this.log.debug(`Cache evictDevice failed for ${sku} ${deviceId}: ${(0, import_types.errMessage)(e)}`);
    }
  }
  /** Delete all cached files. */
  clear() {
    try {
      this.forEachCacheFile((full) => fs.unlinkSync(full));
      this.log.debug("Cache cleared");
    } catch (e) {
      this.log.debug(`Cache clear failed: ${(0, import_types.errMessage)(e)}`);
    }
  }
  /**
   * Iterate the `*.json` files in the cache dir, calling `cb` with each file's
   * absolute path. A missing or vanished dir is swallowed (cb not called).
   * Centralises the existsSync + readdir + json-filter shared by prune/clear.
   *
   * @param cb Callback invoked with each cache file's absolute path
   */
  forEachCacheFile(cb) {
    let files;
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return;
      }
      files = fs.readdirSync(this.cacheDir);
    } catch {
      return;
    }
    for (const file of files) {
      if (file.endsWith(".json")) {
        cb(path.join(this.cacheDir, file));
      }
    }
  }
  /**
   * Build cache file path for a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  cacheFile(sku, deviceId) {
    return path.join(this.cacheDir, `${(0, import_device_key.treeKey)(sku, deviceId)}.json`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SkuCache
});
//# sourceMappingURL=sku-cache.js.map
