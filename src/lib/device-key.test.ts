import * as fs from "node:fs";
import * as path from "node:path";
import { mapKey, sessionKey, treeKey } from "./device-key";
import { normalizeDeviceId } from "./types";

/**
 * The exact derivations treeKey() replaced — kept here as the migration oracle.
 * `sku-cache.cacheFile` / `local-snapshots.deviceKey` used the cache-file form;
 * `state-manager.devicePrefix` used the sanitize() form. If treeKey ever
 * diverges from BOTH for a real catalog SKU, existing cache/snapshot filenames
 * and state-tree object ids would orphan on upgrade.
 *
 * @param sku Govee model, e.g. H6160
 * @param deviceId Colon-separated device id as Govee reports it
 */
function legacyCacheFileForm(sku: string, deviceId: string): string {
  const shortId = deviceId.replace(/:/g, "").toLowerCase().slice(-4);
  return `${sku.toLowerCase()}_${shortId}`;
}
function legacyDevicePrefixForm(sku: string, deviceId: string): string {
  const shortId = normalizeDeviceId(deviceId).slice(-4);
  return `${sku}_${shortId}`.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

describe("device-key", () => {
  describe("mapKey", () => {
    it("uses the full normalized device id", () => {
      expect(mapKey("H6160", "AA:BB:CC:DD:EE:FF:00:11")).toBe("H6160_aabbccddeeff0011");
    });
    it("is defensive against non-string device ids", () => {
      expect(mapKey("H6160", undefined as never)).toBe("H6160_");
    });
  });

  describe("treeKey", () => {
    it("produces skuLower_last4", () => {
      expect(treeKey("H6160", "AA:BB:CC:DD:EE:FF:1D:6F")).toBe("h6160_1d6f");
    });
    it("strips colons and lowercases the short id", () => {
      expect(treeKey("H61BE", "ab:cd:ef:12:34:56:78:9A")).toBe("h61be_789a");
    });
    it("is defensive against non-string device ids", () => {
      expect(treeKey("H6160", undefined as never)).toBe("h6160_");
    });
  });

  describe("sessionKey", () => {
    it("uses the raw sku:deviceId form", () => {
      expect(sessionKey("H6160", "AA:BB:CC")).toBe("H6160:AA:BB:CC");
    });
  });

  describe("migration safety", () => {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "devices.json"), "utf-8")) as {
      devices: Record<string, unknown>;
    };
    const skus = Object.keys(catalog.devices);
    // Device-id shapes the adapter sees in the wild: colon-separated upper/lower
    // MAC-style ids, already-stripped ids, and short ids.
    const sampleIds = ["AABBCCDDEEFF0011", "AA:BB:CC:DD:EE:FF:1D:6F", "12:34:56:78:9a:bc:de:f0", "abcdef"];

    it("covers a non-trivial catalog", () => {
      expect(skus.length).toBeGreaterThan(5);
    });

    it("treeKey == legacy cache-file AND device-prefix form for every catalog SKU (no orphaning)", () => {
      for (const sku of skus) {
        for (const id of sampleIds) {
          expect(treeKey(sku, id)).toBe(legacyCacheFileForm(sku, id));
          expect(treeKey(sku, id)).toBe(legacyDevicePrefixForm(sku, id));
        }
      }
    });

    it("BaseGroup (virtual group SKU) also maps identically", () => {
      expect(treeKey("BaseGroup", "1311")).toBe(legacyCacheFileForm("BaseGroup", "1311"));
      expect(treeKey("BaseGroup", "1311")).toBe(legacyDevicePrefixForm("BaseGroup", "1311"));
    });
  });
});
