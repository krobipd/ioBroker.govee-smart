import { GOVEE_DEVICE_TYPE } from "../govee-constants";
import type { GoveeDevice } from "../types";
import {
  ABSENT_SOURCE,
  isSensorType,
  reconcileAccountMembership,
  type ReconcileSource,
  type ReconcileSources,
} from "./reconciler";

const keyOf = (sku: string, id: string): string => `${sku}:${id}`;

function mk(over: Partial<GoveeDevice> & { sku: string; deviceId: string }): GoveeDevice {
  return {
    name: over.sku,
    type: GOVEE_DEVICE_TYPE.LIGHT,
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: false },
    ...over,
  } as GoveeDevice;
}

const src = (ok: boolean, keys: string[] = []): ReconcileSource => ({ ok, keys: new Set(keys) });

function sources(over: Partial<ReconcileSources> = {}): ReconcileSources {
  return { cloud: ABSENT_SOURCE, app: ABSENT_SOURCE, group: ABSENT_SOURCE, ...over };
}

/** Evict in one call by pre-loading the miss counter to threshold-1. */
function reconcileOnce(devices: GoveeDevice[], s: ReconcileSources, threshold = 2): GoveeDevice[] {
  return reconcileAccountMembership({ sources: s, devices, keyOf, evictThreshold: threshold });
}

describe("reconcileAccountMembership", () => {
  describe("guard: a failed / empty source never removes a device", () => {
    it("keeps a cloud-only light when the cloud source is not ok (failed/empty fetch)", () => {
      const light = mk({ sku: "H61BE", deviceId: "AA", accountMissCount: 5 });
      const evicted = reconcileOnce([light], sources({ cloud: src(false, []) }));
      expect(evicted).toEqual([]);
      // not-ok authoritative source → counter left untouched, never incremented
      expect(light.accountMissCount).toBe(5);
    });

    it("keeps every device when no source was queried at all", () => {
      const light = mk({ sku: "H61BE", deviceId: "AA" });
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      expect(reconcileOnce([light, sensor], sources())).toEqual([]);
    });
  });

  describe("guard: positive membership keeps + resets", () => {
    it("resets the miss counter when a light reappears in the cloud list", () => {
      const light = mk({ sku: "H61BE", deviceId: "AA", accountMissCount: 1 });
      const evicted = reconcileOnce([light], sources({ cloud: src(true, ["H61BE:AA"]) }));
      expect(evicted).toEqual([]);
      expect(light.accountMissCount).toBe(0);
    });

    it("keeps an offline / dead-battery sensor that is still listed (presence, not freshness)", () => {
      const sensor = mk({
        sku: "H5179",
        deviceId: "BB",
        type: GOVEE_DEVICE_TYPE.THERMOMETER,
        state: { online: false },
        accountMissCount: 1,
      });
      const evicted = reconcileOnce([sensor], sources({ app: src(true, ["H5179:BB"]) }));
      expect(evicted).toEqual([]);
      expect(sensor.accountMissCount).toBe(0);
    });
  });

  describe("guard: LAN-first — a locally reachable device is never removed", () => {
    it("keeps + resets a LAN light even when absent from a fresh cloud list", () => {
      const light = mk({
        sku: "H61BE",
        deviceId: "AA",
        lanIp: "10.0.0.5",
        channels: { lan: true, mqtt: false, cloud: false },
        accountMissCount: 9,
      });
      const evicted = reconcileOnce([light], sources({ cloud: src(true, ["OTHER:ZZ"]) }));
      expect(evicted).toEqual([]);
      expect(light.accountMissCount).toBe(0);
    });
  });

  describe("guard: type-aware authority (the advisor blocker)", () => {
    it("does NOT remove a cloud-only light when only the App-API list is ok (light absent there)", () => {
      // cloud failed → cloud.ok=false; app ok but carries no lights. A light's
      // authoritative source is cloud, so app-absence must not delete it.
      const light = mk({ sku: "H61BE", deviceId: "AA", accountMissCount: 1 });
      const evicted = reconcileOnce([light], sources({ cloud: src(false, []), app: src(true, ["H5179:BB"]) }));
      expect(evicted).toEqual([]);
      expect(light.accountMissCount).toBe(1); // unchanged — cloud not queried
    });

    it("does NOT remove a sensor when only the cloud list is ok (cloud never lists sensors)", () => {
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.SENSOR, accountMissCount: 1 });
      const evicted = reconcileOnce([sensor], sources({ cloud: src(true, ["H61BE:AA"]), app: src(false, []) }));
      expect(evicted).toEqual([]);
      expect(sensor.accountMissCount).toBe(1);
    });
  });

  describe("guard: union ownership (belt-and-suspenders)", () => {
    it("keeps a light that shows up in the App list even though absent from the cloud list", () => {
      const light = mk({ sku: "H61BE", deviceId: "AA", accountMissCount: 1 });
      const evicted = reconcileOnce([light], sources({ cloud: src(true, []), app: src(true, ["H61BE:AA"]) }));
      expect(evicted).toEqual([]);
      expect(light.accountMissCount).toBe(0);
    });
  });

  describe("debounce: consecutive misses before eviction", () => {
    it("increments but does not evict on the first miss", () => {
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      const evicted = reconcileOnce([sensor], sources({ app: src(true, ["OTHER:ZZ"]) }));
      expect(evicted).toEqual([]);
      expect(sensor.accountMissCount).toBe(1);
    });

    it("evicts on the second consecutive miss (default threshold 2)", () => {
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      const s = sources({ app: src(true, ["OTHER:ZZ"]) });
      expect(reconcileOnce([sensor], s)).toEqual([]); // 0 → 1
      const evicted = reconcileOnce([sensor], s); // 1 → 2 → evict
      expect(evicted).toEqual([sensor]);
      expect(sensor.accountMissCount).toBe(2);
    });

    it("a reappearance between misses resets the counter (no eviction)", () => {
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      const absent = sources({ app: src(true, ["OTHER:ZZ"]) });
      const present = sources({ app: src(true, ["H5179:BB"]) });
      reconcileOnce([sensor], absent); // → 1
      reconcileOnce([sensor], present); // → 0 (reappeared)
      const evicted = reconcileOnce([sensor], absent); // → 1, still not evicted
      expect(evicted).toEqual([]);
      expect(sensor.accountMissCount).toBe(1);
    });

    it("honours a custom threshold of 3", () => {
      const sensor = mk({ sku: "H5179", deviceId: "BB", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      const s = sources({ app: src(true, ["OTHER:ZZ"]) });
      expect(reconcileAccountMembership({ sources: s, devices: [sensor], keyOf, evictThreshold: 3 })).toEqual([]);
      expect(reconcileAccountMembership({ sources: s, devices: [sensor], keyOf, evictThreshold: 3 })).toEqual([]);
      expect(reconcileAccountMembership({ sources: s, devices: [sensor], keyOf, evictThreshold: 3 })).toEqual([sensor]);
    });
  });

  describe("the reported bug: sold H5179 sensor is removed", () => {
    it("evicts a cache-restored sensor no longer in the account after the debounce", () => {
      // cache-restored → channels all false, no LAN. Owner has Email+PW → app.ok.
      const h5179 = mk({
        sku: "H5179",
        deviceId: "CC:DD",
        type: GOVEE_DEVICE_TYPE.THERMOMETER,
        accountMissCount: 1, // one miss already survived a restart (persisted)
      });
      const active = mk({ sku: "H61BE", deviceId: "EE", channels: { lan: true, mqtt: false, cloud: false } });
      const ownedSensor = mk({ sku: "H5075", deviceId: "FF", type: GOVEE_DEVICE_TYPE.THERMOMETER });
      const s = sources({ cloud: src(true, ["H61BE:EE"]), app: src(true, ["H5075:FF"]) });
      const evicted = reconcileOnce([h5179, active, ownedSensor], s);
      expect(evicted).toEqual([h5179]); // gone
      expect(active.accountMissCount).toBe(0); // LAN light kept
      expect(ownedSensor.accountMissCount).toBe(0); // owned sensor kept
    });
  });

  describe("groups", () => {
    it("never evicts a BaseGroup when the group source is absent (deferred group reconcile)", () => {
      const group = mk({ sku: "BaseGroup", deviceId: "1311", accountMissCount: 9 });
      const evicted = reconcileOnce([group], sources({ cloud: src(true, []), app: src(true, []) }));
      expect(evicted).toEqual([]);
      expect(group.accountMissCount).toBe(9); // group source not ok → untouched
    });

    it("evicts a BaseGroup absent from an ok group source after the debounce", () => {
      const group = mk({ sku: "BaseGroup", deviceId: "1311", accountMissCount: 1 });
      const evicted = reconcileOnce([group], sources({ group: src(true, ["BaseGroup:9999"]) }));
      expect(evicted).toEqual([group]);
    });
  });

  describe("isSensorType", () => {
    it("classifies thermometer + sensor as sensor types, everything else as cloud", () => {
      expect(isSensorType(GOVEE_DEVICE_TYPE.THERMOMETER)).toBe(true);
      expect(isSensorType(GOVEE_DEVICE_TYPE.SENSOR)).toBe(true);
      expect(isSensorType(GOVEE_DEVICE_TYPE.LIGHT)).toBe(false);
      expect(isSensorType(GOVEE_DEVICE_TYPE.HEATER)).toBe(false);
      expect(isSensorType(GOVEE_DEVICE_TYPE.HUMIDIFIER)).toBe(false);
    });
  });
});
