import * as path from "node:path";
import { deviceLabel, errText, type CloudCapability, type CloudScene, type SnapshotPackets } from "./types";
import { cacheKey, treeKey } from "./device-key";
import { listDataFiles, readDataFile, removeDataFile, writeDataFile } from "./data-file";
import { LogOnce } from "./log-once";

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
  /**
   * BLE packets per cloud snapshot for ptReal, by name. A cache written before
   * 2.40.0 holds the old index-aligned `string[][][]` — read as absent and
   * fetched anew (`snapshotPacketsFromCache`).
   */
  snapshotBleCmds?: SnapshotPackets[] | string[][][];
  /** Timestamp when data was cached */
  cachedAt: number;
  /** True after a Cloud scene-fetch attempt has completed (success or confirmed empty). */
  scenesChecked?: boolean;
  /** When the SKU libraries were last confirmed (an empty answer expires after LIBRARY_RECHECK_MS). */
  librariesCheckedAt?: number;
  /** Timestamp (ms) when device was last seen on local network (LAN/MQTT). */
  lastSeenOnNetwork?: number;
  /** Consecutive account-reconcile misses — debounce for the irreversible auto-removal. */
  accountMissCount?: number;
  /** Gateway identity for BLE→gateway sensors (see GoveeDevice.gateway); persisted so it survives restart. */
  gateway?: string;
  /**
   * Physical segment count for this device. Resolved from (in order):
   * 1. MQTT `AA A5` stream — authoritative, the real device tells us
   * 2. Wizard result — user-measured
   * 3. Cloud capabilities — initial best guess (min of reported values)
   * Once set, wins over Cloud capability re-reads across restarts.
   */
  segmentCount?: number;
  /** Who taught the count — the device's segment push or the wizard (absent on a count learned before the origin was recorded). */
  segmentCountOrigin?: "push" | "wizard";
  /** Cut-strip mode: `manualSegments` lists the physically-present indices. */
  manualMode?: boolean;
  /** Physical indices when manualMode=true; undefined when contiguous. */
  manualSegments?: number[];
  /** The datapoints the device's own status push has carried (GV-13) — see `GoveeDevice.pushReports`. */
  pushReports?: string[];
  /**
   * User-selected scene speed level (0-N). Persisted so the adapter
   *  re-applies the same speed after a restart instead of resetting to 0.
   */
  sceneSpeed?: number;
}

/**
 * Persistent SKU cache — stores Cloud/API data as JSON per device, one file per device in `<dataDir>/cache`, every
 * access through the fleet master `data-file.ts`. After first fetch, the adapter runs without Cloud calls.
 */
export class SkuCache {
  private readonly cacheDir: string;
  private readonly log: ioBroker.Logger;
  /**
   * Payload last written per file (without `cachedAt`) — a save that would
   * write byte-identical device data is skipped. `saveDevicesToCache` runs for
   * every device at start-up (twice), after each Cloud list, after a manual sync
   * … most of those writes carried nothing new.
   */
  private readonly lastWritten = new Map<string, string>();
  /** The fleet's log rule for failed writes: the first of a kind warns, a repeat is debug (log-once.ts). */
  private readonly logOnce: LogOnce;
  /** A write failed and none has succeeded since — the next success says so once. */
  private writeFailing = false;

  /**
   * @param dataDir Adapter data directory (adapter.getDataDir())
   * @param log ioBroker logger
   */
  constructor(dataDir: string, log: ioBroker.Logger) {
    this.cacheDir = path.join(dataDir, "cache");
    this.log = log;
    this.logOnce = new LogOnce(log);
    // The folder itself is created by the first save (writeDataFile). Listing it here finds a cache path that can
    // never hold the files — a file in its way, a folder that cannot be read; a missing folder lists as empty. Caught:
    // a throw here would throw in onReady → adapter restart loop. On failure dataAvailable=false is set and save/load
    // skip silently.
    try {
      listDataFiles(this.cacheDir);
      this.dataAvailable = true;
    } catch (e) {
      this.dataAvailable = false;
      this.log.warn(`Cache directory not writable (${this.cacheDir}): ${errText(e)}`);
    }
  }

  /** False when the cache dir is not accessible — save/load then skip. */
  private dataAvailable = false;

  /**
   * Save device data to cache. Never rejects — a failed write is a warn line,
   * the adapter keeps running on its in-memory data.
   *
   * Written at once through the fleet master (`writeDataFile`: a temporary file
   * renamed into place, so a crash mid-write leaves the previous file intact
   * instead of a torn one). The write is synchronous, so two saves of one device
   * never overlap; the promise stays for the callers.
   *
   * @param data Device data to persist
   * @returns Resolves once the file is written, or the failed write is logged
   */
  save(data: CachedDeviceData): Promise<void> {
    if (!this.dataAvailable) {
      return Promise.resolve();
    }
    const file = this.cacheFile(data.sku, data.deviceId);
    const { cachedAt: _cachedAt, ...comparable } = data;
    const fingerprint = JSON.stringify(comparable);
    if (this.lastWritten.get(file) === fingerprint) {
      this.log.debug(`Cache unchanged for ${data.sku} — not rewritten`);
      return Promise.resolve();
    }
    this.lastWritten.set(file, fingerprint);
    try {
      writeDataFile(this.cacheDir, file, data);
    } catch (e) {
      // Forget the fingerprint so the next save retries the write. Said once per kind of failure: a data folder that
      // cannot hold the cache (read-only, no `cache/` yet) fails every save of every device the same way.
      this.lastWritten.delete(file);
      this.writeFailing = true;
      this.logOnce.report("cache-write", `Cache write failed for ${data.sku}: ${errText(e)}`, {
        kind: (e as NodeJS.ErrnoException).code ?? "write",
      });
      return Promise.resolve();
    }
    if (this.writeFailing) {
      this.writeFailing = false;
      this.logOnce.recovered("cache-write", `Cache writes work again (${this.cacheDir})`);
    }
    const sceneN = Array.isArray(data.sceneLibrary) ? data.sceneLibrary.length : 0;
    const musicN = Array.isArray(data.musicLibrary) ? data.musicLibrary.length : 0;
    const diyN = Array.isArray(data.diyLibrary) ? data.diyLibrary.length : 0;
    const snapN = Array.isArray(data.snapshotBleCmds) ? data.snapshotBleCmds.length : 0;
    this.log.debug(
      `Cache saved for ${data.sku} (scenes=${sceneN}, music=${musicN}, diy=${diyN}, snapshotBleCmds=${snapN})`,
    );
    this.removeLegacyFile(data.sku, data.deviceId);
    return Promise.resolve();
  }

  /**
   * Drop the 2.x file of a device once its file of the current name is written — `loadAll` reads by
   * content and would otherwise return the device twice. The 2.x name could be shared by two devices
   * of one SKU; the other one then loads its libraries anew, once. Called after a successful write only.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private removeLegacyFile(sku: string, deviceId: string): void {
    const legacy = this.legacyCacheFile(sku, deviceId);
    // A short device id gives both rules one name — that file is the one just written.
    if (legacy === this.cacheFile(sku, deviceId)) {
      return;
    }
    try {
      removeDataFile(this.cacheDir, legacy);
    } catch (e) {
      this.log.debug(`Cache: could not remove the old file of ${sku}: ${errText(e)}`);
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
    try {
      // A device whose cache was last written by 2.x still has the file under the old name — read only while no file
      // of the current name is there; an unusable one is not passed over.
      for (const file of [this.cacheFile(sku, deviceId), this.legacyCacheFile(sku, deviceId)]) {
        const read = readDataFile(this.cacheDir, file);
        if (read.error !== undefined) {
          this.log.debug(`Cache loadOne failed for ${sku}: ${read.error}`);
          return null;
        }
        if ("value" in read) {
          const data = read.value as CachedDeviceData;
          // The 2.x name could be shared by two devices of one SKU — only this device's data counts.
          return cacheKey(data.sku, data.deviceId) === cacheKey(sku, deviceId) ? data : null;
        }
      }
      return null;
    } catch (e) {
      this.log.debug(`Cache loadOne failed for ${sku}: ${errText(e)}`);
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
    // Sorted (listDataFiles): the order devices come back in is the order a cache start assigns their object ids in
    // (DeviceIdRegistry) — with two devices of one SKU ending alike, which one keeps the short id must not depend on
    // the file system's listing order.
    for (const file of this.cacheFiles()) {
      if (!file.endsWith(".json")) {
        skippedFiles++;
        continue;
      }
      const read = readDataFile(this.cacheDir, file);
      if ("value" in read) {
        results.push(read.value as CachedDeviceData);
      } else {
        // Unusable, or gone since the listing.
        corruptCount++;
      }
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
    for (const file of this.cacheFiles()) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const data = readDataFile(this.cacheDir, file).value as CachedDeviceData | null | undefined;
      // Legacy entries without timestamp: keep, set timestamp on next save. An unusable file (no value) is kept too.
      if (typeof data?.lastSeenOnNetwork !== "number") {
        continue;
      }
      if (data.lastSeenOnNetwork < cutoff) {
        const ageDays = Math.round((nowMs - data.lastSeenOnNetwork) / 86400000);
        try {
          removeDataFile(this.cacheDir, file);
        } catch {
          // a file that cannot be removed stays, uncounted
          continue;
        }
        this.lastWritten.delete(file);
        pruned++;
        prunedDetails.push(`${deviceLabel(data)} ${data.deviceId} (${ageDays}d)`);
      }
    }
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
   * @param label Optional display label (name + model) for the log line
   */
  evictDevice(sku: string, deviceId: string, label?: string): void {
    if (!this.dataAvailable) {
      return;
    }
    const file = this.cacheFile(sku, deviceId);
    this.lastWritten.delete(file);
    try {
      const present = this.cacheFiles().includes(file);
      // With a short device id both names are one — the second removal then finds nothing, which is no error.
      removeDataFile(this.cacheDir, this.legacyCacheFile(sku, deviceId));
      removeDataFile(this.cacheDir, file);
      if (present) {
        this.log.debug(`Cache: evicted ${label ?? sku} ${deviceId} (removed from Govee account)`);
      }
    } catch (e) {
      this.log.debug(`Cache evictDevice failed for ${label ?? sku} ${deviceId}: ${errText(e)}`);
    }
  }

  /**
   * The file names in the cache dir, sorted. A missing, vanished or replaced
   * dir lists as empty — load, prune and evict never throw on it.
   *
   * @returns The file names (sub-folders not)
   */
  private cacheFiles(): string[] {
    try {
      return listDataFiles(this.cacheDir);
    } catch {
      return [];
    }
  }

  /**
   * Cache file name of a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private cacheFile(sku: string, deviceId: string): string {
    return `${cacheKey(sku, deviceId)}.json`;
  }

  /**
   * The file name of 2.x — `<sku>_<last 4>.json` ({@link treeKey}).
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private legacyCacheFile(sku: string, deviceId: string): string {
    return `${treeKey(sku, deviceId)}.json`;
  }
}
