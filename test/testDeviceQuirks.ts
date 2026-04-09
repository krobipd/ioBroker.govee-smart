import { expect } from "chai";
import { getDeviceQuirks, applyColorTempQuirk } from "../src/lib/device-quirks";

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

    it("should return noMqtt for H6121", () => {
        const quirks = getDeviceQuirks("H6121");
        expect(quirks).to.not.be.undefined;
        expect(quirks!.noMqtt).to.be.true;
    });

    it("should return all brokenPlatformApi devices", () => {
        const brokenSkus = ["H6141", "H6159", "H6003", "H6102", "H6053", "H617C", "H617E", "H617F", "H6119"];
        for (const sku of brokenSkus) {
            const quirks = getDeviceQuirks(sku);
            expect(quirks?.brokenPlatformApi, `${sku} should have brokenPlatformApi`).to.be.true;
        }
    });

    it("should return all noMqtt devices", () => {
        const noMqttSkus = ["H6121", "H6154", "H6176"];
        for (const sku of noMqttSkus) {
            const quirks = getDeviceQuirks(sku);
            expect(quirks?.noMqtt, `${sku} should have noMqtt`).to.be.true;
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
