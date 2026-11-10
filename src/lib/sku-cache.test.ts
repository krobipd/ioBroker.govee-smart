import { vi } from "vitest";
import type * as DataFileModule from "./data-file";

/**
 * The fleet master data-file.ts runs unchanged except for one fault switch: while
 * `failRemove` holds an error, removeDataFile throws it (removal-failure tests).
 * A file that cannot be removed has no portable real form — chmod is ignored on
 * Windows and as root — and vitest cannot spy on ESM exports.
 */
const faults = vi.hoisted(() => ({ failRemove: null as Error | null }));
vi.mock("./data-file", async importOriginal => {
  const actual = await importOriginal<typeof DataFileModule>();
  return {
    ...actual,
    removeDataFile: (dir: string, file: string): void => {
      if (faults.failRemove) {
        throw faults.failRemove;
      }
      actual.removeDataFile(dir, file);
    },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkuCache, type CachedDeviceData } from "./sku-cache";
import { mockLog } from "../../test/test-helpers";

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
  faults.failRemove = null;
}

/**
 * The cache folder of a data dir, created — for tests that put files there by
 * hand before any save (the first save creates it otherwise).
 *
 * @param dir The data dir
 * @returns The cache folder
 */
function cacheDirOf(dir: string): string {
  const cacheDir = path.join(dir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

describe("SkuCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("creates the cache directory with the first save — construction writes nothing", async () => {
    const cache = new SkuCache(dir, mockLog);
    expect(fs.existsSync(path.join(dir, "cache"))).toBe(false);
    await cache.save(createTestData());
    expect(fs.readdirSync(path.join(dir, "cache"))).toEqual(["h61be_aabbccdd11223344.json"]);
  });

  it("a cache directory that cannot be created leaves loads empty; one removed later reads as a miss", async () => {
    // A file where the data directory should be — the cache folder can never be listed or created.
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "");
    expect(new SkuCache(blocked, mockLog).loadAll()).toEqual([]);
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData());
    fs.rmSync(path.join(dir, "cache"), { recursive: true, force: true });
    expect(cache.loadAll()).toEqual([]);
  });

  it("a cache folder replaced by a file after the start reads as empty — load, prune and evict never throw", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData());
    fs.rmSync(path.join(dir, "cache"), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, "cache"), "x");
    expect(cache.loadAll()).toEqual([]);
    expect(cache.pruneStale(14)).toBe(0);
    expect(cache.loadOne("H61BE", "AA:BB:CC:DD:11:22:33:44")).toBeNull();
    expect(() => cache.evictDevice("H61BE", "AA:BB:CC:DD:11:22:33:44")).not.toThrow();
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

  it("should handle corrupt JSON gracefully", () => {
    const cache = new SkuCache(dir, mockLog);
    const cacheDir = cacheDirOf(dir);
    fs.writeFileSync(path.join(cacheDir, "corrupt_1234.json"), "not json");
    expect(cache.loadAll()).toEqual([]);
  });

  it("loadAll returns the good entries beside an unusable file and counts what it skipped", async () => {
    const debug = vi.fn();
    const cache = new SkuCache(dir, { ...mockLog, debug });
    await cache.save(createTestData("H6100", "LA:00:00:00:00:00:00:01"));
    fs.writeFileSync(path.join(dir, "cache", "corrupt_1234.json"), "not json");
    fs.writeFileSync(path.join(dir, "cache", "notes.txt"), "not a cache file");
    expect(cache.loadAll().map(e => e.sku)).toEqual(["H6100"]);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "1 device(s) (no age data, legacy entries), 1 corrupt file(s) skipped, 1 non-json file(s) skipped",
      ),
    );
  });

  it("reads a file as version 3.2.1 wrote it (pretty JSON without a trailing newline)", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = { ...createTestData("H6100", "OLD:00:00:00:00:00:00:21"), lastSeenOnNetwork: 1_700_000_000_000 };
    fs.writeFileSync(path.join(cacheDirOf(dir), "h6100_old00000000000021.json"), JSON.stringify(data, null, 2));
    expect(cache.loadAll()).toEqual([data]);
    expect(cache.loadOne("H6100", "OLD:00:00:00:00:00:00:21")).toEqual(data);
  });

  it("keeps two devices of one SKU whose ids end alike in two files (3.0.0)", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "First" });
    await cache.save({ ...createTestData("H61BE", "11:22:33:44:55:66:52:5F"), name: "Second" });
    expect(fs.readdirSync(path.join(dir, "cache")).sort()).toEqual([
      "h61be_112233445566525f.json",
      "h61be_abcdef123456525f.json",
    ]);
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")?.name).toBe("First");
    expect(cache.loadOne("H61BE", "11:22:33:44:55:66:52:5F")?.name).toBe("Second");
  });

  it("reads a 2.x file under its old name and replaces it at the next save", async () => {
    const cache = new SkuCache(dir, mockLog);
    const legacy = path.join(cacheDirOf(dir), "h61be_525f.json");
    fs.writeFileSync(legacy, JSON.stringify({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "Old" }));
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")?.name).toBe("Old");
    await cache.save({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "New" });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(cache.loadAll().map(e => e.name)).toEqual(["New"]);
  });

  it("keeps the 2.x file while the file of the current name could not be written", async () => {
    const cache = new SkuCache(dir, mockLog);
    const legacy = path.join(cacheDirOf(dir), "h61be_525f.json");
    fs.writeFileSync(legacy, JSON.stringify({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "Old" }));
    // A folder where the master's temporary file goes — the write fails on every platform.
    fs.mkdirSync(path.join(dir, "cache", "h61be_abcdef123456525f.json.tmp"));
    await cache.save({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "New" });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")?.name).toBe("Old");
  });

  it("a 2.x file that cannot be removed stays — a debug line, the save itself succeeds", async () => {
    const debug = vi.fn();
    const cache = new SkuCache(dir, { ...mockLog, debug });
    const legacy = path.join(cacheDirOf(dir), "h61be_525f.json");
    fs.writeFileSync(legacy, JSON.stringify({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "Old" }));
    faults.failRemove = new Error("EBUSY: resource busy");
    await expect(
      cache.save({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "New" }),
    ).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Cache: could not remove the old file of H61BE: EBUSY"));
    expect(fs.existsSync(legacy)).toBe(true);
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")?.name).toBe("New");
  });

  it("a device id of four characters keeps its one file — both name rules give the same name", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H6100", "AB:CD"));
    expect(fs.readdirSync(path.join(dir, "cache"))).toEqual(["h6100_abcd.json"]);
    expect(cache.loadOne("H6100", "AB:CD")?.sku).toBe("H6100");
  });

  it("does not pass over an unusable file of the current name to the 2.x file", () => {
    const debug = vi.fn();
    const cache = new SkuCache(dir, { ...mockLog, debug });
    const cacheDir = cacheDirOf(dir);
    fs.writeFileSync(path.join(cacheDir, "h61be_abcdef123456525f.json"), "{ not json");
    fs.writeFileSync(
      path.join(cacheDir, "h61be_525f.json"),
      JSON.stringify({ ...createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F"), name: "Old" }),
    );
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Cache loadOne failed for H61BE: no JSON"));
  });

  it("does not hand one device the 2.x file of another that shared its old name", () => {
    const cache = new SkuCache(dir, mockLog);
    fs.writeFileSync(
      path.join(cacheDirOf(dir), "h61be_525f.json"),
      JSON.stringify({ ...createTestData("H61BE", "11:22:33:44:55:66:52:5F"), name: "Other" }),
    );
    expect(cache.loadOne("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBeNull();
    expect(cache.loadOne("H61BE", "11:22:33:44:55:66:52:5F")?.name).toBe("Other");
  });

  it("evicts a device's 2.x file together with its current one", () => {
    const cache = new SkuCache(dir, mockLog);
    const legacy = path.join(cacheDirOf(dir), "h61be_525f.json");
    fs.writeFileSync(legacy, JSON.stringify(createTestData("H61BE", "AB:CD:EF:12:34:56:52:5F")));
    cache.evictDevice("H61BE", "AB:CD:EF:12:34:56:52:5F");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("evictDevice logs the eviction only for a file that was there; a removal that fails is a debug line", async () => {
    const debug = vi.fn();
    const cache = new SkuCache(dir, { ...mockLog, debug });
    const data = createTestData("H6100", "EV:00:00:00:00:00:00:01");
    await cache.save(data);
    cache.evictDevice("H6100", "EV:00:00:00:00:00:00:01", "Lamp (H6100)");
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Cache: evicted Lamp (H6100) EV:00:00:00:00:00:00:01"));
    debug.mockClear();
    cache.evictDevice("H6100", "EV:00:00:00:00:00:00:01", "Lamp (H6100)");
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("Cache: evicted"));
    await cache.save(data);
    faults.failRemove = new Error("EBUSY: resource busy");
    expect(() => cache.evictDevice("H6100", "EV:00:00:00:00:00:00:01", "Lamp (H6100)")).not.toThrow();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Cache evictDevice failed for Lamp (H6100)"));
    expect(cache.loadOne("H6100", "EV:00:00:00:00:00:00:01")?.sku).toBe("H6100");
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
      const cacheDir = cacheDirOf(dir);
      fs.writeFileSync(path.join(cacheDir, "corrupt_1234.json"), "not json");
      fs.writeFileSync(path.join(cacheDir, "null_1234.json"), "null");
      expect(() => cache.pruneStale(14)).not.toThrow();
      expect(cache.pruneStale(14)).toBe(0);
      expect(fs.readdirSync(cacheDir).sort()).toEqual(["corrupt_1234.json", "null_1234.json"]);
    });

    it("keeps a stale entry it cannot remove and does not count it", async () => {
      const cache = new SkuCache(dir, mockLog);
      const old = createTestData("H6001", "OLD:00:00:00:00:00:00:06");
      old.lastSeenOnNetwork = Date.now() - 30 * DAY_MS;
      await cache.save(old);
      faults.failRemove = new Error("EBUSY: resource busy");
      expect(cache.pruneStale(14)).toBe(0);
      expect(cache.loadAll()).toHaveLength(1);
      faults.failRemove = null;
      expect(cache.pruneStale(14)).toBe(1);
      expect(cache.loadAll()).toHaveLength(0);
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
    // A marker on disk shows whether a later save touched the file.
    fs.writeFileSync(path.join(cacheDir(), "h6100_dc00000000000001.json"), JSON.stringify({ ...data, name: "Marker" }));
    await cache.save({ ...data });
    await cache.save({ ...data, cachedAt: data.cachedAt + 60_000 });
    // saveDevicesToCache runs for every device twice per start — most of those
    // carry nothing new and must not touch the disk (SD-card wear, event loop).
    expect(cache.loadAll()[0].name).toBe("Marker");
    await cache.save({ ...data, name: "Renamed" });
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

  it("evictDevice() also forgets the fingerprint — a later identical save writes", async () => {
    const cache = new SkuCache(dir, mockLog);
    const a = createTestData("H6100", "CL:00:00:00:00:00:00:01");
    await cache.save(a);
    expect(cache.loadAll()).toHaveLength(1);

    cache.evictDevice("H6100", "CL:00:00:00:00:00:00:01", "Evicted (H6100)");
    expect(cache.loadOne("H6100", "CL:00:00:00:00:00:00:01")).toBeNull();
    await cache.save(a);
    expect(cache.loadOne("H6100", "CL:00:00:00:00:00:00:01")?.sku).toBe("H6100");
    // Evicting something that is not there is a silent no-op.
    expect(() => cache.evictDevice("H9999", "NO:PE")).not.toThrow();
  });

  it("a failed write warns once per kind with its reason, never rejects, and the next save of the same data retries", async () => {
    const lines: Array<[string, string]> = [];
    const log = {
      ...mockLog,
      debug: (m: string) => void lines.push(["debug", m]),
      info: (m: string) => void lines.push(["info", m]),
      warn: (m: string) => void lines.push(["warn", m]),
    } as ioBroker.Logger;
    const cache = new SkuCache(dir, log);
    const data = createTestData("H6100", "FA:00:00:00:00:00:00:01");
    const other = createTestData("H6100", "FA:00:00:00:00:00:00:02");
    // Folders where the master's temporary files go — the writes fail on every platform, the same way.
    const blockers = ["h6100_fa00000000000001.json.tmp", "h6100_fa00000000000002.json.tmp"].map(f =>
      path.join(cacheDir(), f),
    );
    blockers.forEach(b => fs.mkdirSync(b, { recursive: true }));
    await expect(cache.save(data)).resolves.toBeUndefined();
    await cache.save(other);
    const failed = lines.filter(([, m]) => m.includes("Cache write failed for H6100"));
    expect(failed.map(([level]) => level)).toEqual(["warn", "debug"]);
    expect(failed[0][1]).toMatch(/EISDIR|EPERM|EEXIST/);
    expect(cache.loadAll()).toHaveLength(0);
    blockers.forEach(b => fs.rmSync(b, { recursive: true }));
    // The fingerprint was NOT kept for the failed write — the retry is a real write, and says once that writes work.
    await cache.save(data);
    await cache.save(other);
    expect(cache.loadAll()).toHaveLength(2);
    expect(lines.filter(([level, m]) => level === "info" && m.includes("Cache writes work again"))).toHaveLength(1);
  });

  it("a saved entry names how many scenes, music modes, DIY scenes and snapshot packets it holds", async () => {
    const debug = vi.fn();
    const cache = new SkuCache(dir, { ...mockLog, debug });
    const base = createTestData("H6100", "CT:00:00:00:00:00:00:01");
    await cache.save({
      ...base,
      musicLibrary: [...base.musicLibrary, ...base.musicLibrary],
      diyLibrary: [...base.diyLibrary, ...base.diyLibrary, ...base.diyLibrary],
      snapshotBleCmds: [
        { name: "a", cmds: [] },
        { name: "b", cmds: [] },
        { name: "c", cmds: [] },
        { name: "d", cmds: [] },
      ],
    });
    expect(debug).toHaveBeenCalledWith("Cache saved for H6100 (scenes=1, music=2, diy=3, snapshotBleCmds=4)");
  });

  it("pruneStale leaves a file that is no cache entry alone — a temporary file is never pruned or counted", () => {
    const cache = new SkuCache(dir, mockLog);
    fs.mkdirSync(cacheDir(), { recursive: true });
    const old = { ...createTestData("H6100", "PT:00:00:00:00:00:00:01"), lastSeenOnNetwork: 1 };
    fs.writeFileSync(path.join(cacheDir(), "h6100_pt00000000000001.json.tmp"), JSON.stringify(old));
    expect(cache.pruneStale(14)).toBe(0);
    expect(fs.readdirSync(cacheDir())).toEqual(["h6100_pt00000000000001.json.tmp"]);
  });

  it("loadOne returns the stored entry, null for an unknown device and null for a corrupt file", async () => {
    const cache = new SkuCache(dir, mockLog);
    await cache.save(createTestData("H6100", "LO:00:00:00:00:00:00:01"));
    expect(cache.loadOne("H6100", "LO:00:00:00:00:00:00:01")?.name).toBe("Test Light");
    const debug = vi.fn();
    const quiet = new SkuCache(dir, { ...mockLog, debug });
    expect(quiet.loadOne("H6100", "LO:00:00:00:00:00:00:99")).toBeNull();
    // No file is the ordinary miss of a device seen for the first time — not a failed read.
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("loadOne failed"));
    const file = fs.readdirSync(cacheDir())[0];
    fs.writeFileSync(path.join(cacheDir(), file), "{ not json");
    expect(cache.loadOne("H6100", "LO:00:00:00:00:00:00:01")).toBeNull();
  });

  it("an unusable data directory disables the cache with one warning — save/load/evict become no-ops, nothing throws", async () => {
    // A regular file where the cache directory should be, so it can never be
    // listed or created (broken instance storage). The file is the cache path
    // itself: listing it fails on every platform, while a file higher up reads
    // as "not there" on Windows.
    fs.writeFileSync(path.join(dir, "cache"), "x");
    const { log, warns } = warnLog();
    const cache = new SkuCache(dir, log);
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
