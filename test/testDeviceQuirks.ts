import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "chai";
import { getDeviceQuirks, applyColorTempQuirk, loadCommunityQuirks } from "../src/lib/device-quirks";

describe("getDeviceQuirks", () => {
    it("should return quirks for known SKU", () => {
        const quirks = getDeviceQuirks("H60A1");
        expect(quirks).to.not.be.undefined;
        expect(quirks!.colorTempRange).to.deep.equal({ min: 2200, max: 6500 });
    });

    it("should be case-insensitive", () => {
        const quirks = getDeviceQuirks("h60a1");
        expect(quirks).to.not.be.undefined;
        expect(quirks!.colorTempRange).to.deep.equal({ min: 2200, max: 6500 });
    });

    it("should return undefined for unknown SKU", () => {
        expect(getDeviceQuirks("H9999")).to.be.undefined;
    });

    it("should return brokenPlatformApi for H6141", () => {
        const quirks = getDeviceQuirks("H6141");
        expect(quirks).to.not.be.undefined;
        expect(quirks!.brokenPlatformApi).to.be.true;
    });

    it("should return all brokenPlatformApi devices", () => {
        const brokenSkus = ["H6141", "H6159", "H6003", "H6102", "H6053", "H617C", "H617E", "H617F", "H6119"];
        for (const sku of brokenSkus) {
            const quirks = getDeviceQuirks(sku);
            expect(quirks?.brokenPlatformApi, `${sku} should have brokenPlatformApi`).to.be.true;
        }
    });

});

describe("applyColorTempQuirk", () => {
    it("should override range for known SKU", () => {
        const result = applyColorTempQuirk("H60A1", 2000, 9000);
        expect(result).to.deep.equal({ min: 2200, max: 6500 });
    });

    it("should pass through range for unknown SKU", () => {
        const result = applyColorTempQuirk("H9999", 2000, 9000);
        expect(result).to.deep.equal({ min: 2000, max: 9000 });
    });

    it("should pass through range for SKU without colorTempRange quirk", () => {
        const result = applyColorTempQuirk("H6141", 2000, 9000);
        expect(result).to.deep.equal({ min: 2000, max: 9000 });
    });

    it("should override for H6022", () => {
        const result = applyColorTempQuirk("H6022", 2000, 9000);
        expect(result).to.deep.equal({ min: 2700, max: 6500 });
    });

    it("should be case-insensitive", () => {
        const result = applyColorTempQuirk("h6022", 2000, 9000);
        expect(result).to.deep.equal({ min: 2700, max: 6500 });
    });
});

describe("loadCommunityQuirks", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quirks-test-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should load community quirks and override built-in", () => {
        const quirksData = {
            version: 1,
            quirks: {
                H60A1: { colorTempRange: { min: 2400, max: 6000 } },
            },
        };
        const filePath = path.join(tmpDir, "community-quirks.json");
        fs.writeFileSync(filePath, JSON.stringify(quirksData));

        loadCommunityQuirks(filePath);
        const quirks = getDeviceQuirks("H60A1");
        expect(quirks?.colorTempRange).to.deep.equal({ min: 2400, max: 6000 });
    });

    it("should add new SKU from community quirks", () => {
        const quirksData = {
            version: 1,
            quirks: {
                H9999: { colorTempRange: { min: 3000, max: 5000 } },
            },
        };
        const filePath = path.join(tmpDir, "community-quirks.json");
        fs.writeFileSync(filePath, JSON.stringify(quirksData));

        loadCommunityQuirks(filePath);
        const quirks = getDeviceQuirks("H9999");
        expect(quirks).to.not.be.undefined;
        expect(quirks!.colorTempRange).to.deep.equal({ min: 3000, max: 5000 });
    });

    it("should handle missing file gracefully", () => {
        loadCommunityQuirks(path.join(tmpDir, "nonexistent.json"));
        // Built-in quirks should still work
        expect(getDeviceQuirks("H6141")?.brokenPlatformApi).to.be.true;
    });

    it("should handle corrupt JSON gracefully", () => {
        const filePath = path.join(tmpDir, "bad.json");
        fs.writeFileSync(filePath, "not valid json{{{");

        loadCommunityQuirks(filePath);
        // Built-in quirks should still work
        expect(getDeviceQuirks("H6141")?.brokenPlatformApi).to.be.true;
    });

    it("should be case-insensitive for community SKUs", () => {
        const quirksData = {
            version: 1,
            quirks: {
                h7777: { brokenPlatformApi: true },
            },
        };
        const filePath = path.join(tmpDir, "community-quirks.json");
        fs.writeFileSync(filePath, JSON.stringify(quirksData));

        loadCommunityQuirks(filePath);
        expect(getDeviceQuirks("H7777")?.brokenPlatformApi).to.be.true;
    });
});
