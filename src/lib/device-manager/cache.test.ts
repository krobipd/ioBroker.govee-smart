import type { GoveeDevice } from "../types";
import type { CachedDeviceData, SkuCache } from "../sku-cache";
import {
  type DeviceCacheAdapter,
  cachedToGoveeDevice,
  goveeDeviceToCached,
  persistDeviceToCache,
  populateScenesFromLibrary,
  saveDevicesToCache,
} from "./cache";

const glueLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
} as ioBroker.Logger;

/**
 * Tests for the cache <-> device round-trip. These are architecture-invariant
 * tests, not happy-path tests:
 *
 * - Round-trip preserves all cacheable fields automatically (spread, not
 *   hand-listed). Drift between save and load directions is structurally
 *   impossible.
 * - Runtime-only fields (state/channels/lanIp/groupMembers) are NEVER
 *   restored from the cache — they reset to their boot defaults so LAN
 *   discovery, MQTT status push, and groupMembers-refetch take over.
 */
describe("cache.cachedToGoveeDevice / goveeDeviceToCached", () => {
  function makeFullDevice(): GoveeDevice {
    return {
      sku: "H6172",
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Living Room Strip",
      type: "devices.types.light",
      lanIp: "192.168.1.42",
      capabilities: [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
      ],
      scenes: [{ name: "Aurora", value: { paramId: 1, sceneCode: 100 } }],
      diyScenes: [{ name: "MyDIY", value: { paramId: 2, sceneCode: 200 } }],
      snapshots: [{ name: "Movie Night", value: { paramId: 3 } }],
      sceneLibrary: [{ name: "Aurora", sceneCode: 100, scenceParam: "base64data" }],
      musicLibrary: [{ name: "Rolling", musicCode: 5, mode: 1 }],
      diyLibrary: [{ name: "MyDIY", diyCode: 200 }],
      skuFeatures: { someFeature: true },
      groupMembers: [{ sku: "H6172", deviceId: "OTHER" }],
      state: { online: true, power: true, brightness: 80 },
      channels: { lan: true, mqtt: true, cloud: true },
      segmentCount: 15,
      manualMode: true,
      manualSegments: [0, 1, 2, 5, 6, 7],
      sceneSpeed: 3,
      snapshotBleCmds: [[["aGV4ZGF0YQ=="]]],
      scenesChecked: true,
      lastSeenOnNetwork: 1234567890,
    };
  }

  describe("Runtime-only field exclusion (architecture invariant)", () => {
    it("does NOT persist 'state' to cache (recomputed from LAN/MQTT each boot)", () => {
      const original = makeFullDevice();
      const cached = goveeDeviceToCached(original);
      expect(cached).not.toHaveProperty("state");
    });

    it("does NOT persist 'channels' to cache (recomputed from connection results each boot)", () => {
      const original = makeFullDevice();
      const cached = goveeDeviceToCached(original);
      expect(cached).not.toHaveProperty("channels");
    });

    it("does NOT persist 'lanIp' to cache (re-discovered by LAN UDP scan each boot)", () => {
      const original = makeFullDevice();
      const cached = goveeDeviceToCached(original);
      expect(cached).not.toHaveProperty("lanIp");
    });

    it("does NOT persist 'groupMembers' to cache (re-resolved by loadGroupMembers each boot)", () => {
      const original = makeFullDevice();
      const cached = goveeDeviceToCached(original);
      expect(cached).not.toHaveProperty("groupMembers");
    });

    it("restored device has runtime-defaults for state/channels/lanIp/groupMembers", () => {
      const cached = goveeDeviceToCached(makeFullDevice());
      const restored = cachedToGoveeDevice(cached);
      expect(restored.state).toEqual({ online: false });
      expect(restored.channels).toEqual({ lan: false, mqtt: false, cloud: false });
      expect(restored.lanIp).toBe(undefined);
      expect(restored.groupMembers).toBe(undefined);
    });

    it("does NOT persist 'lastLanReplyAt' to cache (live LAN-freshness timestamp) — L11", () => {
      const original = { ...makeFullDevice(), lastLanReplyAt: 1_700_000_000_000 };
      const cached = goveeDeviceToCached(original);
      expect(cached).not.toHaveProperty("lastLanReplyAt");
    });

    it("restored device cannot carry a forged lastLanReplyAt from a tampered cache (L11)", () => {
      const cached = { ...goveeDeviceToCached(makeFullDevice()), lastLanReplyAt: 1_700_000_000_000 };
      const restored = cachedToGoveeDevice(cached);
      expect(restored.lastLanReplyAt).toBe(undefined);
    });

    it("restored device cannot carry a forged lanIp from a tampered cache entry", () => {
      const cached = goveeDeviceToCached(makeFullDevice());
      // Tamper with the cache as if a malicious or stale write injected lanIp.
      // Because the destructure in cachedToGoveeDevice doesn't pull it, the
      // tampered value cannot survive into runtime.
      (cached as unknown as Record<string, unknown>).lanIp = "10.0.0.1";
      const restored = cachedToGoveeDevice(cached);
      expect(restored.lanIp).toBe(undefined);
    });
  });

  describe("Round-trip preservation for cacheable fields", () => {
    it("all non-runtime fields survive cache → restore", () => {
      const original = makeFullDevice();
      const restored = cachedToGoveeDevice(goveeDeviceToCached(original));

      // Identity + display
      expect(restored.sku).toBe(original.sku);
      expect(restored.deviceId).toBe(original.deviceId);
      expect(restored.name).toBe(original.name);
      expect(restored.type).toBe(original.type);

      // Cloud data
      expect(restored.capabilities).toEqual(original.capabilities);
      expect(restored.scenes).toEqual(original.scenes);
      expect(restored.diyScenes).toEqual(original.diyScenes);
      expect(restored.snapshots).toEqual(original.snapshots);

      // Libraries
      expect(restored.sceneLibrary).toEqual(original.sceneLibrary);
      expect(restored.musicLibrary).toEqual(original.musicLibrary);
      expect(restored.diyLibrary).toEqual(original.diyLibrary);
      expect(restored.skuFeatures).toEqual(original.skuFeatures);

      // Segment state (cut-strip + learned)
      expect(restored.segmentCount).toBe(original.segmentCount);
      expect(restored.manualMode).toBe(original.manualMode);
      expect(restored.manualSegments).toEqual(original.manualSegments);
      expect(restored.sceneSpeed).toBe(original.sceneSpeed);

      // BLE + diagnostic
      expect(restored.snapshotBleCmds).toEqual(original.snapshotBleCmds);
      expect(restored.scenesChecked).toBe(original.scenesChecked);
      expect(restored.lastSeenOnNetwork).toBe(original.lastSeenOnNetwork);
    });

    it("normalize drops segmentCount=0, manualMode=false, sceneSpeed=0 from the cache", () => {
      const original = makeFullDevice();
      original.segmentCount = 0;
      original.manualMode = false;
      original.manualSegments = [];
      original.sceneSpeed = 0;
      const cached = goveeDeviceToCached(original);
      expect(cached.segmentCount).toBe(undefined);
      expect(cached.manualMode).toBe(undefined);
      expect(cached.manualSegments).toBe(undefined);
      expect(cached.sceneSpeed).toBe(undefined);
    });

    it("a corrupt segment count / index list in the cache file is dropped on load", () => {
      // The cache is a host-local, editable file — an absurd count must never
      // become the number of segment channels the adapter builds.
      const cached = goveeDeviceToCached(makeFullDevice());
      (cached as { segmentCount?: number }).segmentCount = 1_000_000_000;
      (cached as { manualSegments?: unknown }).manualSegments = [0, 1_000_000_000, -1, "x", 2];
      const restored = cachedToGoveeDevice(cached);
      expect(restored.segmentCount).toBeUndefined();
      expect(restored.manualSegments).toEqual([0, 2]);
    });
  });

  describe("adapter glue functions", () => {
    function makeAdapter(devices: GoveeDevice[] = []): { adapter: DeviceCacheAdapter; saved: CachedDeviceData[] } {
      const saved: CachedDeviceData[] = [];
      const skuCache = { save: (d: CachedDeviceData) => saved.push(d) } as unknown as SkuCache;
      const map = new Map<string, GoveeDevice>();
      devices.forEach((d, i) => map.set(`k${i}`, d));
      return { adapter: { log: glueLog, skuCache, devices: map }, saved };
    }

    it("populateScenesFromLibrary fills scenes from the library when Cloud scenes are missing", () => {
      const d = makeFullDevice();
      d.scenes = [];
      populateScenesFromLibrary(makeAdapter().adapter, d);
      expect(d.scenes).toEqual([{ name: "Aurora", value: {} }]);
    });

    it("populateScenesFromLibrary is a no-op when Cloud scenes already exist", () => {
      const d = makeFullDevice(); // already carries a scene
      const before = d.scenes;
      populateScenesFromLibrary(makeAdapter().adapter, d);
      expect(d.scenes).toBe(before);
    });

    it("persistDeviceToCache saves through the SKU cache", () => {
      const { adapter, saved } = makeAdapter();
      persistDeviceToCache(adapter, makeFullDevice());
      expect(saved).toHaveLength(1);
      expect(saved[0].sku).toBe("H6172");
    });

    it("persistDeviceToCache is a safe no-op without a cache", () => {
      const adapter: DeviceCacheAdapter = { log: glueLog, skuCache: null, devices: new Map() };
      expect(() => persistDeviceToCache(adapter, makeFullDevice())).not.toThrow();
    });

    it("saveDevicesToCache skips lights whose scenes were not yet checked", () => {
      const unchecked = makeFullDevice();
      unchecked.scenesChecked = false;
      const checked = makeFullDevice();
      checked.scenesChecked = true;
      const { adapter, saved } = makeAdapter([unchecked, checked]);
      saveDevicesToCache(adapter);
      expect(saved).toHaveLength(1); // only the checked light is persisted
    });
  });
});
