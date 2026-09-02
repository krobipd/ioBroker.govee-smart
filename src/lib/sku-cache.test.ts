import { vi } from "vitest";
import type * as FsModule from "node:fs";

/**
 * node:fs is passed through unchanged except for a flush counter on the file
 * handles fs.promises.open hands out — the durability test below needs to see
 * that the save really flushed, and vitest cannot spy on ESM exports.
 */
const fsCounters = vi.hoisted(() => ({ fsync: 0, failNextOpen: null as Error | null }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof FsModule>();
  // save() flushes through FileHandle.sync() on a handle from fs.promises.open —
  // wrap the handle so the durability test can see the flush happen. A queued
  // `failNextOpen` error makes exactly one open() fail (write-failure tests).
  const open: typeof actual.promises.open = async (...args) => {
    if (fsCounters.failNextOpen) {
      const err = fsCounters.failNextOpen;
      fsCounters.failNextOpen = null;
      throw err;
    }
    const handle = await actual.promises.open(...args);
    const origSync = handle.sync.bind(handle);
    handle.sync = async (): Promise<void> => {
      fsCounters.fsync++;
      await origSync();
    };
    return handle;
  };
  const promises = { ...actual.promises, open };
  return { ...actual, default: { ...actual, promises }, promises };
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

  it("should save and load a cache entry", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    await cache.save(data);
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

  it("should overwrite existing cache entry", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    await cache.save(data);
    data.name = "Updated Light";
    data.scenes.push({ name: "Aurora", value: { id: 2 } });
    await cache.save(data);
    const all = cache.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Updated Light");
    expect(all[0].scenes).toHaveLength(2);
  });

  it("should store separate entries for different devices", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    await cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
    const all = cache.loadAll();
    expect(all).toHaveLength(2);
    const skus = all.map(d => d.sku).sort();
    expect(skus).toEqual(["H6160", "H61BE"]);
  });

  it("should store separate entries for same SKU different devices", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:11:11"));
    await cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:22:22"));
    const all = cache.loadAll();
    expect(all).toHaveLength(2);
  });

  it("should loadAll from empty cache", () => {
    const cache = new SkuCache(dir, mockLog);
    expect(cache.loadAll()).toEqual([]);
  });

  it("should clear all cache entries", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    await cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
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

  it("normalises the device id for the file name — colon and colon-less spellings hit the same file", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    // The LAN discovery frame carries the id without colons; the Cloud list
    // with colons. Both must resolve to the one cache entry, or the device is
    // persisted twice and restored twice.
    expect(cache.loadOne("H61BE", "AABBCCDD11223344")?.name).toBe("Test Light");
    expect(cache.loadOne("h61be", "aa:bb:cc:dd:11:22:33:44")?.name).toBe("Test Light");
    await cache.save(createTestData("H61BE", "AABBCCDD11223344"));
    expect(cache.loadAll()).toHaveLength(1);
  });

  it("should preserve all library data types", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.musicLibrary = [
      { name: "Energetic", musicCode: 1, scenceParam: "AQID", mode: 0 },
      { name: "Rhythm", musicCode: 2, mode: 1 },
    ];
    data.diyLibrary = [{ name: "My DIY", diyCode: 10, scenceParam: "BASE64DATA" }];
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.musicLibrary).toHaveLength(2);
    expect(loaded.musicLibrary[0].scenceParam).toBe("AQID");
    expect(loaded.musicLibrary[1].mode).toBe(1);
    expect(loaded.diyLibrary[0].scenceParam).toBe("BASE64DATA");
  });

  it("should handle null skuFeatures", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.skuFeatures = null;
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.skuFeatures).toBeNull();
  });

  it("should not throw when deviceId is non-string", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    (data as unknown as { deviceId: unknown }).deviceId = 12345;
    await expect(cache.save(data)).resolves.toBeUndefined();
  });

  it("should not throw when sku is non-string", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    (data as unknown as { sku: unknown }).sku = null;
    await expect(cache.save(data)).resolves.toBeUndefined();
  });

  describe("save — durability", () => {
    it("flushes the cache file to disk instead of leaving it in the page cache", async () => {
      const before = fsCounters.fsync;
      const cache = new SkuCache(dir, mockLog);
      await cache.save(createTestData("H6100", "FSY:00:00:00:00:00:00:01"));
      // Without the fsync a SIGKILL inside the ~30 s writeback window loses
      // the save silently and the next start reads stale device data.
      expect(fsCounters.fsync).toBeGreaterThan(before);
    });
  });

  describe("pruneStale", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("removes entries older than maxAgeDays", async () => {
      const cache = new SkuCache(dir, mockLog);
      const old = createTestData("H6001", "OLD:00:00:00:00:00:00:01");
      old.lastSeenOnNetwork = Date.now() - 30 * DAY_MS; // 30 days ago
      const fresh = createTestData("H6002", "NEW:00:00:00:00:00:00:02");
      fresh.lastSeenOnNetwork = Date.now() - 2 * DAY_MS; // 2 days ago
      await cache.save(old);
      await cache.save(fresh);

      const pruned = cache.pruneStale(14);
      expect(pruned).toBe(1);
      const remaining = cache.loadAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sku).toBe("H6002");
    });

    it("keeps legacy entries without lastSeenOnNetwork", async () => {
      const cache = new SkuCache(dir, mockLog);
      const legacy = createTestData("H6003", "OLD:00:00:00:00:00:00:03");
      delete (legacy as { lastSeenOnNetwork?: number }).lastSeenOnNetwork;
      await cache.save(legacy);

      const pruned = cache.pruneStale(14);
      expect(pruned).toBe(0);
      expect(cache.loadAll()).toHaveLength(1);
    });

    it("keeps an entry whose timestamp is not a number (hand-edited / foreign file)", async () => {
      const cache = new SkuCache(dir, mockLog);
      const data = createTestData("H6005", "STR:00:00:00:00:00:00:05");
      await cache.save(data);
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

    it("respects custom maxAgeDays threshold", async () => {
      const cache = new SkuCache(dir, mockLog);
      const data = createTestData("H6004", "MID:00:00:00:00:00:00:04");
      data.lastSeenOnNetwork = Date.now() - 5 * DAY_MS; // 5 days ago
      await cache.save(data);

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

  it("should persist scenesChecked flag", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.scenesChecked = true;
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.scenesChecked).toBe(true);
  });

  it("should persist lastSeenOnNetwork timestamp", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    const now = Date.now();
    data.lastSeenOnNetwork = now;
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.lastSeenOnNetwork).toBe(now);
  });

  it("should persist segmentCount (authoritative real count)", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.segmentCount = 20;
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.segmentCount).toBe(20);
  });

  it("should persist manualMode + manualSegments together", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.segmentCount = 15;
    data.manualMode = true;
    data.manualSegments = [0, 1, 2, 5, 6, 7, 8];
    await cache.save(data);
    const loaded = cache.loadAll()[0];
    expect(loaded.manualMode).toBe(true);
    expect(loaded.manualSegments).toEqual([0, 1, 2, 5, 6, 7, 8]);
  });
});

describe("SkuCache — dirty check, write serialisation, failure paths (2.28.0)", () => {
  let dir: string;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cacheDir = (): string => path.join(dir, "cache");
  const warnLog = (): { log: ioBroker.Logger; warns: string[] } => {
    const warns: string[] = [];
    return { log: { ...mockLog, warn: (m: string) => warns.push(m) }, warns };
  };

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it("does not rewrite a byte-identical payload, nor one that differs only in cachedAt", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData("H6100", "DC:00:00:00:00:00:00:01");
    await cache.save(data);
    const flushed = fsCounters.fsync;
    await cache.save({ ...data });
    await cache.save({ ...data, cachedAt: data.cachedAt + 60_000 });
    // saveDevicesToCache runs for every device twice per start — most of those
    // carry nothing new and must not touch the disk (SD-card wear, event loop).
    expect(fsCounters.fsync).toBe(flushed);
    await cache.save({ ...data, name: "Renamed" });
    expect(fsCounters.fsync).toBe(flushed + 1);
    expect(cache.loadAll()[0].name).toBe("Renamed");
  });

  it("a pruned entry is written again by the next save of the same data (fingerprint forgotten)", async () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData("H6001", "PR:00:00:00:00:00:00:01");
    data.lastSeenOnNetwork = Date.now() - 30 * DAY_MS;
    await cache.save(data);
    expect(cache.pruneStale(14)).toBe(1);
    expect(cache.loadAll()).toHaveLength(0);
    // Same bytes as before — without the reset the device would never be
    // persisted again for the rest of the run.
    await cache.save(data);
    expect(cache.loadAll()).toHaveLength(1);
  });

  it("clear() and evictDevice() also forget the fingerprint — a later identical save writes", async () => {
    const cache = new SkuCache(dir, mockLog);
    const a = createTestData("H6100", "CL:00:00:00:00:00:00:01");
    const b = createTestData("H6101", "EV:00:00:00:00:00:00:02");
    await cache.save(a);
    await cache.save(b);
    cache.clear();
    expect(cache.loadAll()).toHaveLength(0);
    await cache.save(a);
    expect(cache.loadAll()).toHaveLength(1);

    cache.evictDevice("H6100", "CL:00:00:00:00:00:00:01", "Evicted (H6100)");
    expect(cache.loadOne("H6100", "CL:00:00:00:00:00:00:01")).toBeNull();
    await cache.save(a);
    expect(cache.loadOne("H6100", "CL:00:00:00:00:00:00:01")?.sku).toBe("H6100");
    // Evicting something that is not there is a silent no-op.
    expect(() => cache.evictDevice("H9999", "NO:PE")).not.toThrow();
  });

  it("two overlapping saves of one device leave the LAST payload on disk and no temp file behind", async () => {
    const cache = new SkuCache(dir, mockLog);
    const first = createTestData("H6100", "OV:00:00:00:00:00:00:01");
    const second = { ...first, name: "Second write" };
    await Promise.all([cache.save(first), cache.save(second)]);
    const files = fs.readdirSync(cacheDir());
    expect(files.filter(f => f.endsWith(".tmp"))).toEqual([]);
    expect(files).toHaveLength(1);
    expect(cache.loadAll()[0].name).toBe("Second write");
  });

  it("a failed write warns, never rejects, and the next save of the same data retries", async () => {
    const { log, warns } = warnLog();
    const cache = new SkuCache(dir, log);
    const data = createTestData("H6100", "FA:00:00:00:00:00:00:01");
    fsCounters.failNextOpen = new Error("EACCES: permission denied");
    await expect(cache.save(data)).resolves.toBeUndefined();
    expect(warns.some(m => m.includes("Cache write failed for H6100") && m.includes("EACCES"))).toBe(true);
    expect(cache.loadAll()).toHaveLength(0);
    // The fingerprint was NOT kept for the failed write — the retry is a real write.
    await cache.save(data);
    expect(cache.loadAll()).toHaveLength(1);
  });

  it("loadOne returns the stored entry, null for an unknown device and null for a corrupt file", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H6100", "LO:00:00:00:00:00:00:01"));
    expect(cache.loadOne("H6100", "LO:00:00:00:00:00:00:01")?.name).toBe("Test Light");
    expect(cache.loadOne("H6100", "LO:00:00:00:00:00:00:99")).toBeNull();
    const file = fs.readdirSync(cacheDir())[0];
    fs.writeFileSync(path.join(cacheDir(), file), "{ not json");
    expect(cache.loadOne("H6100", "LO:00:00:00:00:00:00:01")).toBeNull();
  });

  it("an unusable data directory disables the cache with one warning — save/load/evict become no-ops, nothing throws", async () => {
    // The parent of the data dir is a regular file, so the cache directory can
    // never be created (read-only or broken instance storage).
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const { log, warns } = warnLog();
    const cache = new SkuCache(path.join(blocker, "data"), log);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("Cache directory not writable");
    await expect(cache.save(createTestData())).resolves.toBeUndefined();
    expect(cache.loadAll()).toEqual([]);
    expect(cache.loadOne("H61BE", "AA:BB:CC:DD:11:22:33:44")).toBeNull();
    expect(() => cache.evictDevice("H61BE", "AA:BB:CC:DD:11:22:33:44")).not.toThrow();
    expect(cache.pruneStale(14)).toBe(0);
    expect(warns).toHaveLength(1); // the no-ops stay silent
  });
});
