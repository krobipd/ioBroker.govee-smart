import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rulesFromSchema, validateCatalog } from "./devices-validation";

const root = path.resolve(__dirname, "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "devices.schema.json"), "utf-8")) as Record<string, unknown>;
const real = JSON.parse(fs.readFileSync(path.join(root, "devices.json"), "utf-8")) as {
  devices: Record<string, unknown>;
};

/**
 * A catalog with one entry.
 *
 * @param entry The entry under SKU H6160
 * @param sku The SKU
 */
function one(entry: Record<string, unknown>, sku = "H6160"): unknown {
  return { devices: { [sku]: entry } };
}

const light = { name: "Strip", type: "light", status: "verified", since: "2.0.0" };

describe("validateCatalog — the schema is the one spec (audit S9)", () => {
  it("the real catalog is valid", () => {
    expect(Object.keys(real.devices).length).toBeGreaterThan(600);
    expect(validateCatalog(real, schema)).toEqual([]);
  });

  it("a plain entry is valid", () => {
    expect(validateCatalog(one(light), schema)).toEqual([]);
  });

  it("rejects a type, a tier, a field and a SKU the schema does not know", () => {
    const msgs = (e: Record<string, unknown>, sku?: string): string[] =>
      validateCatalog(one(e, sku), schema).map(i => i.msg);
    expect(msgs({ ...light, type: "lamp" })[0]).toMatch(/invalid 'type'/);
    expect(msgs({ ...light, status: "tested" })[0]).toMatch(/invalid 'status'/);
    expect(msgs({ ...light, note: "x" })[0]).toMatch(/unknown field 'note'/);
    expect(msgs(light, "h6160")[0]).toMatch(/SKU does not match/);
    expect(msgs({ ...light, since: "2.0" })[0]).toMatch(/semver/);
    expect(msgs({ type: "light", status: "seed" })[0]).toMatch(/missing 'name'/);
  });

  it("rejects an unknown quirk, an unknown override command, a wrong target and a segment count past the bitmask", () => {
    const msgs = (quirks: Record<string, unknown>): string[] =>
      validateCatalog(one({ ...light, quirks }), schema).map(i => i.msg);
    expect(msgs({ colourTempRange: { min: 2000, max: 6500 } })[0]).toMatch(/unknown quirk field/);
    expect(msgs({ transportOverrides: { music: "cloud" } })[0]).toMatch(/unknown command 'music'/);
    expect(msgs({ transportOverrides: { power: "ble" } })[0]).toMatch(/invalid target/);
    expect(msgs({ segmentCount: 57 })[0]).toMatch(/1\.\.56/);
    expect(msgs({ segmentCount: 56 })).toEqual([]);
    expect(msgs({ colorTempRange: { min: 6500, max: 2000 } })[0]).toMatch(/min < max/);
    expect(msgs({ statusCmdVersion: 3 })[0]).toMatch(/statusCmdVersion/);
    expect(msgs({ platformTempUnit: "C" })[0]).toMatch(/platformTempUnit/);
    expect(msgs({ ignoredCloudCapabilities: ["a", "a"] })[0]).toMatch(/distinct/);
    expect(msgs({ brokenPlatformApi: "yes" })[0]).toMatch(/boolean/);
  });

  it("a schema path that is gone fails loudly instead of accepting everything", () => {
    const broken = JSON.parse(JSON.stringify(schema)) as {
      definitions: { quirks: { properties: Record<string, unknown> } };
    };
    delete broken.definitions.quirks.properties.transportOverrides;
    expect(() => rulesFromSchema(broken)).toThrow(/transportOverrides/);
    expect(() => rulesFromSchema({})).toThrow(/devices.schema.json has no/);
  });
});
