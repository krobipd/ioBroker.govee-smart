import * as fs from "node:fs";
import * as path from "node:path";
import type { CloudCapability, CloudScene } from "./types.js";

/** Data persisted per device in the SKU cache */
export interface CachedDeviceData {
  sku: string;
  deviceId: string;
  name: string;
  type: string;
  capabilities: CloudCapability[];
  scenes: CloudScene[];
  diyScenes: CloudScene[];
  snapshots: CloudScene[];
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
  musicLibrary: Array<{
    name: string;
    musicCode: number;
    scenceParam?: string;
    mode?: number;
  }>;
  diyLibrary: Array<{
    name: string;
    diyCode: number;
    scenceParam?: string;
  }>;
  skuFeatures: Record<string, unknown> | null;
  cachedAt: number;
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
  load(sku: string, deviceId: string): CachedDeviceData | null {
    const file = this.cacheFile(sku, deviceId);
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        return JSON.parse(raw) as CachedDeviceData;
      }
    } catch (e) {
      this.log.debug(
        `Cache read failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }

  /**
   * Save device data to cache.
   *
   * @param data Device data to persist
   */
  save(data: CachedDeviceData): void {
    const file = this.cacheFile(data.sku, data.deviceId);
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
      this.log.debug(`Cache saved for ${data.sku}`);
    } catch (e) {
      this.log.warn(
        `Cache write failed for ${data.sku}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Load all cached devices. */
  loadAll(): CachedDeviceData[] {
    const results: CachedDeviceData[] = [];
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
          results.push(JSON.parse(raw) as CachedDeviceData);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // cache dir doesn't exist yet
    }
    return results;
  }

  /** Delete all cached files. */
  clear(): void {
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
        `Cache clear failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Build cache file path for a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private cacheFile(sku: string, deviceId: string): string {
    const shortId = deviceId.replace(/:/g, "").toLowerCase().slice(-4);
    return path.join(this.cacheDir, `${sku.toLowerCase()}_${shortId}.json`);
  }
}
