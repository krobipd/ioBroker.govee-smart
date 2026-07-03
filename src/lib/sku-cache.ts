import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage, type CloudCapability, type CloudScene } from "./types";
import { treeKey } from "./device-key";

/** Data persisted per device in the SKU cache */
export interface CachedDeviceData {
  /** Product model (e.g. "H61BE") */
  sku: string;
  /** Device identifier */
  deviceId: string;
  /** Display name */
  name: string;
  /** Device type (e.g. "devices.types.light") */
  type: string;
  /** Cloud API capabilities */
  capabilities: CloudCapability[];
  /** Cloud light scenes */
  scenes: CloudScene[];
  /** Cloud DIY scenes */
  diyScenes: CloudScene[];
  /** Cloud snapshots */
  snapshots: CloudScene[];
  /** Scene library from undocumented API */
  sceneLibrary: Array<{
    name: string;
    sceneCode: number;
    scenceParam?: string;
    speedInfo?: {
      supSpeed: boolean;
      speedIndex: number;
      config: string;
    };
  }>;
  /** Music effect library from undocumented API */
  musicLibrary: Array<{
    name: string;
    musicCode: number;
    scenceParam?: string;
    mode?: number;
  }>;
  /** DIY effect library from undocumented API */
  diyLibrary: Array<{
    name: string;
    diyCode: number;
    scenceParam?: string;
  }>;
  /** SKU feature flags from undocumented API */
  skuFeatures: Record<string, unknown> | null;
  /** BLE packets per cloud snapshot for ptReal [snapshotIdx][cmdIdx][packetBase64] */
  snapshotBleCmds?: string[][][];
  /** Timestamp when data was cached */
  cachedAt: number;
  /** True after a Cloud scene-fetch attempt has completed (success or confirmed empty). */
  scenesChecked?: boolean;
  /** Timestamp (ms) when device was last seen on local network (LAN/MQTT). */
  lastSeenOnNetwork?: number;
  /** Consecutive account-reconcile misses — debounce for the irreversible auto-removal. */
  accountMissCount?: number;
  /**
   * Physical segment count for this device. Resolved from (in order):
   * 1. MQTT `AA A5` stream — authoritative, the real device tells us
   * 2. Wizard result — user-measured
   * 3. Cloud capabilities — initial best guess (min of reported values)
   * Once set, wins over Cloud capability re-reads across restarts.
   */
  segmentCount?: number;
  /** Cut-strip mode: `manualSegments` lists the physically-present indices. */
  manualMode?: boolean;
  /** Physical indices when manualMode=true; undefined when contiguous. */
  manualSegments?: number[];
  /**
   * User-selected scene speed level (0-N). Persisted so the adapter
   *  re-applies the same speed after a restart instead of resetting to 0.
   */
  sceneSpeed?: number;
}

/**
 * Persistent SKU cache — stores Cloud/API data as JSON per device.
 * After first fetch, the adapter runs without Cloud calls.
 */
export class SkuCache {
  private readonly cacheDir: string;
  private readonly log: ioBroker.Logger;

  /**
   * @param dataDir Adapter data directory (adapter.getDataDir())
   * @param log ioBroker logger
   */
  constructor(dataDir: string, log: ioBroker.Logger) {
    this.cacheDir = path.join(dataDir, "cache");
    this.log = log;
    // mkdir try/catch — a permission / read-only FS must not crash the
    // constructor (that would throw in onReady → adapter restart loop). On
    // failure dataAvailable=false is set and save/load skip silently.
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      this.dataAvailable = true;
    } catch (e) {
      this.dataAvailable = false;
      this.log.warn(`Cache directory not writable (${this.cacheDir}): ${errMessage(e)}`);
    }
  }

  /** False when the cache dir is not accessible — save/load then skip. */
  private dataAvailable = false;

  /**
   * Save device data to cache.
   *
   * @param data Device data to persist
   */
  save(data: CachedDeviceData): void {
    if (!this.dataAvailable) {
      return;
    }
    const file = this.cacheFile(data.sku, data.deviceId);
    try {
      // openSync + writeSync + fsyncSync + closeSync instead of writeFileSync
      // so the data hits disk before the call returns. Plain writeFileSync
      // only pushes to the kernel page cache — if the adapter gets SIGKILLed
      // within the dirty-writeback window (~30s), the save is silently lost
      // and cache-load on the next start sees stale data.
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
        `Cache saved for ${data.sku} (scenes=${sceneN}, music=${musicN}, diy=${diyN}, snapshotBleCmds=${snapN})`,
      );
    } catch (e) {
      this.log.warn(`Cache write failed for ${data.sku}: ${errMessage(e)}`);
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
  loadOne(sku: string, deviceId: string): CachedDeviceData | null {
    if (!this.dataAvailable) {
      return null;
    }
    const file = this.cacheFile(sku, deviceId);
    try {
      if (!fs.existsSync(file)) {
        return null;
      }
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw) as CachedDeviceData;
    } catch (e) {
      this.log.debug(`Cache loadOne failed for ${sku}: ${errMessage(e)}`);
      return null;
    }
  }

  /** Load all cached devices. */
  loadAll(): CachedDeviceData[] {
    const results: CachedDeviceData[] = [];
    if (!this.dataAvailable) {
      this.log.debug(`Cache load: skipped — cache directory not available (${this.cacheDir})`);
      return results;
    }
    let corruptCount = 0;
    let skippedFiles = 0;
    try {
      if (!fs.existsSync(this.cacheDir)) {
        this.log.debug(`Cache load: miss — directory does not exist yet (${this.cacheDir})`);
        return results;
      }
      for (const file of fs.readdirSync(this.cacheDir)) {
        if (!file.endsWith(".json")) {
          skippedFiles++;
          continue;
        }
        try {
          const raw = fs.readFileSync(path.join(this.cacheDir, file), "utf-8");
          results.push(JSON.parse(raw) as CachedDeviceData);
        } catch {
          corruptCount++;
        }
      }
    } catch {
      // race: dir disappeared between existsSync and readdir — fall through
    }
    if (results.length === 0) {
      this.log.debug(`Cache load: miss — no cached devices found in ${this.cacheDir}`);
    } else {
      const now = Date.now();
      const ages = results
        .map(d => (typeof d.lastSeenOnNetwork === "number" ? now - d.lastSeenOnNetwork : -1))
        .filter(a => a >= 0);
      const ageInfo =
        ages.length === results.length
          ? ` (oldest=${Math.round(Math.max(...ages) / 86400000)}d, newest=${Math.round(Math.min(...ages) / 86400000)}d)`
          : ages.length === 0
            ? " (no age data, legacy entries)"
            : ` (${results.length - ages.length} legacy entry/entries without age)`;
      this.log.debug(
        `Cache load: hit — ${results.length} device(s)${ageInfo}${corruptCount > 0 ? `, ${corruptCount} corrupt file(s) skipped` : ""}${skippedFiles > 0 ? `, ${skippedFiles} non-json file(s) skipped` : ""}`,
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
  pruneStale(maxAgeDays = 14): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    let pruned = 0;
    const prunedDetails: string[] = [];
    this.forEachCacheFile(full => {
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const data = JSON.parse(raw) as CachedDeviceData;
        // Legacy entries without timestamp: keep, set timestamp on next save
        if (typeof data.lastSeenOnNetwork !== "number") {
          return;
        }
        if (data.lastSeenOnNetwork < cutoff) {
          const ageDays = Math.round((nowMs - data.lastSeenOnNetwork) / 86400000);
          fs.unlinkSync(full);
          pruned++;
          prunedDetails.push(`${data.sku} ${data.deviceId} (${ageDays}d)`);
        }
      } catch {
        // skip corrupt files
      }
    });
    if (pruned > 0) {
      this.log.info(
        `Cache: pruned ${pruned} stale entries (not seen for ${maxAgeDays}+ days): ${prunedDetails.join(", ")}`,
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
  evictDevice(sku: string, deviceId: string): void {
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
      this.log.debug(`Cache evictDevice failed for ${sku} ${deviceId}: ${errMessage(e)}`);
    }
  }

  /** Delete all cached files. */
  clear(): void {
    try {
      this.forEachCacheFile(full => fs.unlinkSync(full));
      this.log.debug("Cache cleared");
    } catch (e) {
      this.log.debug(`Cache clear failed: ${errMessage(e)}`);
    }
  }

  /**
   * Iterate the `*.json` files in the cache dir, calling `cb` with each file's
   * absolute path. A missing or vanished dir is swallowed (cb not called).
   * Centralises the existsSync + readdir + json-filter shared by prune/clear.
   *
   * @param cb Callback invoked with each cache file's absolute path
   */
  private forEachCacheFile(cb: (fullPath: string) => void): void {
    let files: string[];
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
  private cacheFile(sku: string, deviceId: string): string {
    return path.join(this.cacheDir, `${treeKey(sku, deviceId)}.json`);
  }
}
