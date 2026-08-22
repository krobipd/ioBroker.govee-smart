import { vi } from "vitest";

/**
 * node:fs is passed through unchanged except for a fsyncSync counter — the
 * durability test below needs to see that the save really flushed, and vitest
 * cannot spy on ESM exports.
 */
const fsCounters = vi.hoisted(() => ({ fsync: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fsyncSync = (fd: number): void => {
    fsCounters.fsync++;
    actual.fsyncSync(fd);
  };
  return { ...actual, default: { ...actual, fsyncSync }, fsyncSync };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkuCache, type CachedDeviceData } from "./sku-cache";

const mockLog: ioBroker.Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
};

function createTestData(sku = "H61BE", deviceId = "AA:BB:CC:DD:11:22:33:44"): CachedDeviceData {
  return {
    sku,
    deviceId,
    name: "Test Light",
    type: "devices.types.light",
    capabilities: [
      {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        parameters: { dataType: "ENUM", options: [{ name: "on", value: 1 }] },
      },
    ],
    scenes: [{ name: "Sunset", value: { id: 1 } }],
    diyScenes: [{ name: "My DIY", value: { id: 100 } }],
    snapshots: [{ name: "Snap1", value: { id: 200 } }],
    sceneLibrary: [{ name: "Sunset", sceneCode: 42, scenceParam: "AQID" }],
    musicLibrary: [{ name: "Energetic", musicCode: 1, mode: 0 }],
    diyLibrary: [{ name: "My DIY", diyCode: 10 }],
    skuFeatures: { musicMode: true, gradient: true },
    cachedAt: Date.now(),
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sku-cache-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("SkuCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("should create cache directory on construction", () => {
    new SkuCache(dir, mockLog);
    expect(fs.existsSync(path.join(dir, "cache"))).toBe(true);
  });

  it("should return empty for non-existent cache", () => {
    const cache = new SkuCache(dir, mockLog);
    expect(cache.loadAll()).toEqual([]);
  });

  it("should save and load a cache entry", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    cache.save(data);
    const all = cache.loadAll();
    expect(all).toHaveLength(1);
    const loaded = all[0];
    expect(loaded.sku).toBe("H61BE");
    expect(loaded.name).toBe("Test Light");
    expect(loaded.scenes).toHaveLength(1);
    expect(loaded.sceneLibrary).toHaveLength(1);
    expect(loaded.musicLibrary).toHaveLength(1);
    expect(loaded.diyLibrary).toHaveLength(1);
    expect(loaded.skuFeatures).toEqual({
      musicMode: true,
      gradient: true,
    });
  });

  it("should overwrite existing cache entry", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    cache.save(data);
    data.name = "Updated Light";
    data.scenes.push({ name: "Aurora", value: { id: 2 } });
    cache.save(data);
    const all = cache.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Updated Light");
    expect(all[0].scenes).toHaveLength(2);
  });

  it("should store separate entries for different devices", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
    const all = cache.loadAll();
    expect(all).toHaveLength(2);
    const skus = all.map(d => d.sku).sort();
    expect(skus).toEqual(["H6160", "H61BE"]);
  });

  it("should store separate entries for same SKU different devices", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:11:11"));
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:22:22"));
    const all = cache.loadAll();
    expect(all).toHaveLength(2);
  });

  it("should loadAll from empty cache", () => {
    const cache = new SkuCache(dir, mockLog);
    expect(cache.loadAll()).toEqual([]);
  });

  it("should clear all cache entries", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
    expect(cache.loadAll()).toHaveLength(2);
    cache.clear();
    expect(cache.loadAll()).toHaveLength(0);
  });

  it("should handle corrupt JSON gracefully", () => {
    const cache = new SkuCache(dir, mockLog);
    const cacheDir = path.join(dir, "cache");
    fs.writeFileSync(path.join(cacheDir, "corrupt_1234.json"), "not json");
    expect(cache.loadAll()).toEqual([]);
  });

  it("should use normalized device ID for file naming", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    // Same device without colons should hit same file (loadAll finds the single entry)
    const all = cache.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].sku).toBe("H61BE");
  });

  it("should preserve all library data types", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.musicLibrary = [
      { name: "Energetic", musicCode: 1, scenceParam: "AQID", mode: 0 },
      { name: "Rhythm", musicCode: 2, mode: 1 },
    ];
    data.diyLibrary = [{ name: "My DIY", diyCode: 10, scenceParam: "BASE64DATA" }];
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.musicLibrary).toHaveLength(2);
    expect(loaded.musicLibrary[0].scenceParam).toBe("AQID");
    expect(loaded.musicLibrary[1].mode).toBe(1);
    expect(loaded.diyLibrary[0].scenceParam).toBe("BASE64DATA");
  });

  it("should handle null skuFeatures", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.skuFeatures = null;
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.skuFeatures).toBeNull();
  });

  it("should not throw when deviceId is non-string", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    (data as unknown as { deviceId: unknown }).deviceId = 12345;
    expect(() => cache.save(data)).not.toThrow();
  });

  it("should not throw when sku is non-string", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    (data as unknown as { sku: unknown }).sku = null;
    expect(() => cache.save(data)).not.toThrow();
  });

  describe("save — durability", () => {
    it("flushes the cache file to disk instead of leaving it in the page cache", () => {
      const before = fsCounters.fsync;
      const cache = new SkuCache(dir, mockLog);
      cache.save(createTestData("H6100", "FSY:00:00:00:00:00:00:01"));
      // Without the fsync a SIGKILL inside the ~30 s writeback window loses
      // the save silently and the next start reads stale device data.
      expect(fsCounters.fsync).toBeGreaterThan(before);
    });
  });

  describe("pruneStale", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("removes entries older than maxAgeDays", () => {
      const cache = new SkuCache(dir, mockLog);
      const old = createTestData("H6001", "OLD:00:00:00:00:00:00:01");
      old.lastSeenOnNetwork = Date.now() - 30 * DAY_MS; // 30 days ago
      const fresh = createTestData("H6002", "NEW:00:00:00:00:00:00:02");
      fresh.lastSeenOnNetwork = Date.now() - 2 * DAY_MS; // 2 days ago
      cache.save(old);
      cache.save(fresh);

      const pruned = cache.pruneStale(14);
      expect(pruned).toBe(1);
      const remaining = cache.loadAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sku).toBe("H6002");
    });

    it("keeps legacy entries without lastSeenOnNetwork", () => {
      const cache = new SkuCache(dir, mockLog);
      const legacy = createTestData("H6003", "OLD:00:00:00:00:00:00:03");
      delete (legacy as { lastSeenOnNetwork?: number }).lastSeenOnNetwork;
      cache.save(legacy);

      const pruned = cache.pruneStale(14);
      expect(pruned).toBe(0);
      expect(cache.loadAll()).toHaveLength(1);
    });

    it("keeps an entry whose timestamp is not a number (hand-edited / foreign file)", () => {
      const cache = new SkuCache(dir, mockLog);
      const data = createTestData("H6005", "STR:00:00:00:00:00:00:05");
      cache.save(data);
      // A string timestamp compares as `"..." < cutoff` → true, so an
      // unchecked prune would delete a perfectly current entry.
      const file = fs.readdirSync(path.join(dir, "cache"))[0];
      const full = path.join(dir, "cache", file);
      const raw = JSON.parse(fs.readFileSync(full, "utf-8")) as Record<string, unknown>;
      // Old enough that an unguarded `"..." < cutoff` comparison deletes it.
      raw.lastSeenOnNetwork = String(Date.now() - 30 * DAY_MS);
      fs.writeFileSync(full, JSON.stringify(raw));

      expect(cache.pruneStale(14)).toBe(0);
      expect(cache.loadAll()).toHaveLength(1);
    });

    it("returns 0 on empty cache", () => {
      const cache = new SkuCache(dir, mockLog);
      expect(cache.pruneStale(14)).toBe(0);
    });

    it("respects custom maxAgeDays threshold", () => {
      const cache = new SkuCache(dir, mockLog);
      const data = createTestData("H6004", "MID:00:00:00:00:00:00:04");
      data.lastSeenOnNetwork = Date.now() - 5 * DAY_MS; // 5 days ago
      cache.save(data);

      // With 7-day threshold: still fresh
      expect(cache.pruneStale(7)).toBe(0);
      expect(cache.loadAll()).toHaveLength(1);
      // With 3-day threshold: stale
      expect(cache.pruneStale(3)).toBe(1);
      expect(cache.loadAll()).toHaveLength(0);
    });

    it("skips corrupt cache files silently", () => {
      const cache = new SkuCache(dir, mockLog);
      const cacheDir = path.join(dir, "cache");
      fs.writeFileSync(path.join(cacheDir, "corrupt_1234.json"), "not json");
      expect(() => cache.pruneStale(14)).not.toThrow();
    });
  });

  it("should persist scenesChecked flag", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.scenesChecked = true;
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.scenesChecked).toBe(true);
  });

  it("should persist lastSeenOnNetwork timestamp", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    const now = Date.now();
    data.lastSeenOnNetwork = now;
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.lastSeenOnNetwork).toBe(now);
  });

  it("should persist segmentCount (authoritative real count)", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.segmentCount = 20;
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.segmentCount).toBe(20);
  });

  it("should persist manualMode + manualSegments together", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.segmentCount = 15;
    data.manualMode = true;
    data.manualSegments = [0, 1, 2, 5, 6, 7, 8];
    cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.manualMode).toBe(true);
    expect(loaded.manualSegments).toEqual([0, 1, 2, 5, 6, 7, 8]);
  });
});
