import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkuCache, type CachedDeviceData } from "../src/lib/sku-cache";

const mockLog: ioBroker.Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
};

function createTestData(
  sku = "H61BE",
  deviceId = "AA:BB:CC:DD:11:22:33:44",
): CachedDeviceData {
  return {
    sku,
    deviceId,
    name: "Test Light",
    type: "light",
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
    expect(fs.existsSync(path.join(dir, "cache"))).to.be.true;
  });

  it("should return null for non-existent cache entry", () => {
    const cache = new SkuCache(dir, mockLog);
    expect(cache.load("H61BE", "AA:BB:CC:DD:11:22:33:44")).to.be.null;
  });

  it("should save and load a cache entry", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    cache.save(data);
    const loaded = cache.load("H61BE", "AA:BB:CC:DD:11:22:33:44");
    expect(loaded).to.not.be.null;
    expect(loaded!.sku).to.equal("H61BE");
    expect(loaded!.name).to.equal("Test Light");
    expect(loaded!.scenes).to.have.length(1);
    expect(loaded!.sceneLibrary).to.have.length(1);
    expect(loaded!.musicLibrary).to.have.length(1);
    expect(loaded!.diyLibrary).to.have.length(1);
    expect(loaded!.skuFeatures).to.deep.equal({
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
    const loaded = cache.load("H61BE", "AA:BB:CC:DD:11:22:33:44");
    expect(loaded!.name).to.equal("Updated Light");
    expect(loaded!.scenes).to.have.length(2);
  });

  it("should store separate entries for different devices", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
    const all = cache.loadAll();
    expect(all).to.have.length(2);
    const skus = all.map((d) => d.sku).sort();
    expect(skus).to.deep.equal(["H6160", "H61BE"]);
  });

  it("should store separate entries for same SKU different devices", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:11:11"));
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:22:22"));
    const all = cache.loadAll();
    expect(all).to.have.length(2);
  });

  it("should loadAll from empty cache", () => {
    const cache = new SkuCache(dir, mockLog);
    expect(cache.loadAll()).to.deep.equal([]);
  });

  it("should clear all cache entries", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    cache.save(createTestData("H6160", "EE:FF:00:11:22:33:44:55"));
    expect(cache.loadAll()).to.have.length(2);
    cache.clear();
    expect(cache.loadAll()).to.have.length(0);
  });

  it("should handle corrupt JSON gracefully", () => {
    const cache = new SkuCache(dir, mockLog);
    const cacheDir = path.join(dir, "cache");
    fs.writeFileSync(path.join(cacheDir, "corrupt_1234.json"), "not json");
    expect(cache.loadAll()).to.deep.equal([]);
    expect(cache.load("corrupt", "000000001234")).to.be.null;
  });

  it("should use normalized device ID for file naming", () => {
    const cache = new SkuCache(dir, mockLog);
    cache.save(createTestData("H61BE", "AA:BB:CC:DD:11:22:33:44"));
    // Same device without colons should hit same file
    const loaded = cache.load("H61BE", "aabbccdd11223344");
    expect(loaded).to.not.be.null;
    expect(loaded!.sku).to.equal("H61BE");
  });

  it("should preserve all library data types", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.musicLibrary = [
      { name: "Energetic", musicCode: 1, scenceParam: "AQID", mode: 0 },
      { name: "Rhythm", musicCode: 2, mode: 1 },
    ];
    data.diyLibrary = [
      { name: "My DIY", diyCode: 10, scenceParam: "BASE64DATA" },
    ];
    cache.save(data);
    const loaded = cache.load(data.sku, data.deviceId)!;
    expect(loaded.musicLibrary).to.have.length(2);
    expect(loaded.musicLibrary[0].scenceParam).to.equal("AQID");
    expect(loaded.musicLibrary[1].mode).to.equal(1);
    expect(loaded.diyLibrary[0].scenceParam).to.equal("BASE64DATA");
  });

  it("should handle null skuFeatures", () => {
    const cache = new SkuCache(dir, mockLog);
    const data = createTestData();
    data.skuFeatures = null;
    cache.save(data);
    const loaded = cache.load(data.sku, data.deviceId)!;
    expect(loaded.skuFeatures).to.be.null;
  });
});
