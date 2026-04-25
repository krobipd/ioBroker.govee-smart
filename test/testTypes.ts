import { expect } from "chai";
import {
    normalizeDeviceId,
    classifyError,
    rgbToHex,
    hexToRgb,
    rgbIntToHex,
    parseSegmentList,
    disambiguateLabels,
    buildUniqueLabelMap,
    resolveStatesValue,
} from "../src/lib/types";

describe("Types utilities", () => {
    describe("normalizeDeviceId", () => {
        it("should remove colons and lowercase", () => {
            expect(normalizeDeviceId("AA:BB:CC:DD:EE:FF:00:11")).to.equal("aabbccddeeff0011");
        });

        it("should lowercase already clean IDs", () => {
            expect(normalizeDeviceId("AABBCCDDEEFF0011")).to.equal("aabbccddeeff0011");
        });

        it("should handle already normalized IDs", () => {
            expect(normalizeDeviceId("aabbccddeeff0011")).to.equal("aabbccddeeff0011");
        });

        it("should handle empty string", () => {
            expect(normalizeDeviceId("")).to.equal("");
        });

        it("should return empty string for undefined input", () => {
            expect(normalizeDeviceId(undefined as unknown as string)).to.equal("");
        });

        it("should return empty string for null input", () => {
            expect(normalizeDeviceId(null as unknown as string)).to.equal("");
        });

        it("should return empty string for number input", () => {
            expect(normalizeDeviceId(12345 as unknown as string)).to.equal("");
        });

        it("should not throw on object input", () => {
            expect(() => normalizeDeviceId({} as unknown as string)).to.not.throw();
            expect(normalizeDeviceId({} as unknown as string)).to.equal("");
        });
    });

    describe("rgbToHex", () => {
        it("should convert RGB to hex", () => {
            expect(rgbToHex(255, 102, 0)).to.equal("#ff6600");
        });

        it("should pad single-digit hex values", () => {
            expect(rgbToHex(0, 0, 0)).to.equal("#000000");
        });

        it("should handle white", () => {
            expect(rgbToHex(255, 255, 255)).to.equal("#ffffff");
        });

        // Drift guards — v1.6.3 hardening. Upstream could pass NaN (from
        // division-by-zero) or out-of-range values (from buggy capability data).
        it("should clamp values above 255 to 255", () => {
            expect(rgbToHex(300, 500, 1000)).to.equal("#ffffff");
        });

        it("should clamp negative values to 0", () => {
            expect(rgbToHex(-10, -1, -500)).to.equal("#000000");
        });

        it("should return #000000 for NaN channels", () => {
            expect(rgbToHex(NaN, NaN, NaN)).to.equal("#000000");
        });

        it("should coerce non-numeric (undefined) to 0", () => {
            expect(rgbToHex(undefined as unknown as number, 128, 0)).to.equal("#008000");
        });

        it("should round fractional channels", () => {
            expect(rgbToHex(127.6, 127.4, 0)).to.equal("#80" + "7f" + "00");
        });
    });

    describe("hexToRgb", () => {
        it("should parse hex with #", () => {
            expect(hexToRgb("#ff6600")).to.deep.equal({ r: 255, g: 102, b: 0 });
        });

        it("should parse hex without #", () => {
            expect(hexToRgb("ff6600")).to.deep.equal({ r: 255, g: 102, b: 0 });
        });

        it("should parse black", () => {
            expect(hexToRgb("#000000")).to.deep.equal({ r: 0, g: 0, b: 0 });
        });

        it("should handle invalid hex as black", () => {
            expect(hexToRgb("xyz")).to.deep.equal({ r: 0, g: 0, b: 0 });
        });

        // Drift guard — MQTT/Cloud could deliver non-string in color fields.
        it("should return black for non-string input (undefined)", () => {
            expect(hexToRgb(undefined as unknown as string)).to.deep.equal({ r: 0, g: 0, b: 0 });
        });

        it("should return black for non-string input (null)", () => {
            expect(hexToRgb(null as unknown as string)).to.deep.equal({ r: 0, g: 0, b: 0 });
        });

        it("should return black for non-string input (number)", () => {
            expect(hexToRgb(0xff6600 as unknown as string)).to.deep.equal({ r: 0, g: 0, b: 0 });
        });
    });

    describe("rgbIntToHex", () => {
        it("should convert packed int to hex", () => {
            expect(rgbIntToHex(0xff6600)).to.equal("#ff6600");
        });

        it("should handle zero", () => {
            expect(rgbIntToHex(0)).to.equal("#000000");
        });

        it("should handle white", () => {
            expect(rgbIntToHex(0xffffff)).to.equal("#ffffff");
        });
    });

    describe("classifyError", () => {
        it("should classify ECONNREFUSED as NETWORK", () => {
            expect(classifyError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).to.equal("NETWORK");
        });

        it("should classify ENOTFOUND as NETWORK", () => {
            expect(classifyError(new Error("getaddrinfo ENOTFOUND api.govee.com"))).to.equal("NETWORK");
        });

        it("should classify ENETUNREACH as NETWORK", () => {
            expect(classifyError(new Error("ENETUNREACH"))).to.equal("NETWORK");
        });

        it("should classify ECONNRESET as NETWORK", () => {
            expect(classifyError(new Error("read ECONNRESET"))).to.equal("NETWORK");
        });

        it("should classify errors with .code property as NETWORK", () => {
            const err = new Error("connect failed") as NodeJS.ErrnoException;
            err.code = "EHOSTUNREACH";
            expect(classifyError(err)).to.equal("NETWORK");

            const err2 = new Error("DNS lookup failed") as NodeJS.ErrnoException;
            err2.code = "EAI_AGAIN";
            expect(classifyError(err2)).to.equal("NETWORK");
        });

        it("should classify ETIMEDOUT via .code as TIMEOUT", () => {
            const err = new Error("connect failed") as NodeJS.ErrnoException;
            err.code = "ETIMEDOUT";
            expect(classifyError(err)).to.equal("TIMEOUT");
        });

        it("should classify timeout errors as TIMEOUT", () => {
            expect(classifyError(new Error("Request timed out"))).to.equal("TIMEOUT");
            expect(classifyError(new Error("Timeout waiting for response"))).to.equal("TIMEOUT");
        });

        it("should classify 401/403 as AUTH", () => {
            expect(classifyError(new Error("HTTP 401 Unauthorized"))).to.equal("AUTH");
            expect(classifyError(new Error("HTTP 403 Forbidden"))).to.equal("AUTH");
        });

        it("should classify Login failed as AUTH", () => {
            expect(classifyError(new Error("Login failed: invalid credentials"))).to.equal("AUTH");
        });

        it("should classify 429 as RATE_LIMIT", () => {
            expect(classifyError(new Error("HTTP 429 Too Many Requests"))).to.equal("RATE_LIMIT");
        });

        it("should classify Rate limit as RATE_LIMIT", () => {
            expect(classifyError(new Error("Rate limit exceeded"))).to.equal("RATE_LIMIT");
        });

        it("should classify Rate limited by Govee as RATE_LIMIT", () => {
            expect(classifyError(new Error("Rate limited by Govee: too many requests (status 429)"))).to.equal("RATE_LIMIT");
        });

        it("should classify unknown errors as UNKNOWN", () => {
            expect(classifyError(new Error("Something unexpected happened"))).to.equal("UNKNOWN");
        });

        it("should handle string errors", () => {
            expect(classifyError("ECONNREFUSED")).to.equal("NETWORK");
        });

        it("should handle non-Error objects", () => {
            expect(classifyError({ code: "ERR" })).to.equal("UNKNOWN");
        });
    });

    describe("parseSegmentList", () => {
        it("should parse comma-separated indices", () => {
            const r = parseSegmentList("0,1,2,3", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([0, 1, 2, 3]);
        });

        it("should parse a range", () => {
            const r = parseSegmentList("0-9", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        });

        it("should parse mixed ranges and individuals", () => {
            const r = parseSegmentList("0-2,4-6,10", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([0, 1, 2, 4, 5, 6, 10]);
        });

        it("should tolerate whitespace", () => {
            const r = parseSegmentList("0, 3, 5 - 7, 10-12", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([0, 3, 5, 6, 7, 10, 11, 12]);
        });

        it("should dedupe entries", () => {
            const r = parseSegmentList("0,0,1,1,2", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([0, 1, 2]);
        });

        it("should sort ascending", () => {
            const r = parseSegmentList("5,3,1,4,2", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([1, 2, 3, 4, 5]);
        });

        it("should reject empty string", () => {
            const r = parseSegmentList("", 14);
            expect(r.error).to.not.be.null;
            expect(r.indices).to.deep.equal([]);
        });

        it("should reject whitespace-only", () => {
            const r = parseSegmentList("   ", 14);
            expect(r.error).to.not.be.null;
        });

        it("should reject negative numbers", () => {
            const r = parseSegmentList("-1,0,1", 14);
            expect(r.error).to.not.be.null;
        });

        it("should reject indices above per-device max", () => {
            const r = parseSegmentList("0-15", 14);
            expect(r.error).to.not.be.null;
            expect(r.error).to.include("15");
            expect(r.error).to.include("0-14");
        });

        it("should reject indices above hard backstop 99", () => {
            const r = parseSegmentList("0,100", 200); // maxIndex=200, but 100 > 99 backstop
            expect(r.error).to.not.be.null;
        });

        it("should reject non-numeric tokens", () => {
            const r = parseSegmentList("0,abc,2", 14);
            expect(r.error).to.not.be.null;
        });

        it("should reject reversed range", () => {
            const r = parseSegmentList("9-0", 14);
            expect(r.error).to.not.be.null;
            expect(r.error).to.include("start");
        });

        it("should handle single index", () => {
            const r = parseSegmentList("5", 14);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([5]);
        });

        it("should handle non-string input safely", () => {
            const r = parseSegmentList(null as unknown as string, 14);
            expect(r.error).to.not.be.null;
            expect(r.indices).to.deep.equal([]);
        });

        it("should use hard backstop 99 when maxIndex is invalid", () => {
            const r = parseSegmentList("50", -1);
            expect(r.error).to.be.null;
            expect(r.indices).to.deep.equal([50]);
        });
    });

    describe("disambiguateLabels", () => {
        it("should pass through unique names unchanged", () => {
            expect(disambiguateLabels(["Aurora", "Movie", "Sunset"]))
                .to.deep.equal(["Aurora", "Movie", "Sunset"]);
        });

        it("should suffix duplicates with (2), (3), …", () => {
            expect(disambiguateLabels(["Movie", "Aurora", "Movie", "Movie"]))
                .to.deep.equal(["Movie", "Aurora", "Movie (2)", "Movie (3)"]);
        });

        it("should keep first occurrence of each name unchanged", () => {
            expect(disambiguateLabels(["A", "B", "A", "B", "A"]))
                .to.deep.equal(["A", "B", "A (2)", "B (2)", "A (3)"]);
        });

        it("should handle empty list", () => {
            expect(disambiguateLabels([])).to.deep.equal([]);
        });

        it("should treat empty strings as duplicates after first", () => {
            expect(disambiguateLabels(["", "x", ""])).to.deep.equal(["", "x", " (2)"]);
        });
    });

    describe("buildUniqueLabelMap", () => {
        it("should build a 0-based sentinel map for unique names", () => {
            const result = buildUniqueLabelMap([
                { name: "Aurora" },
                { name: "Movie" },
                { name: "Sunset" },
            ]);
            expect(result).to.deep.equal({ 0: "---", 1: "Aurora", 2: "Movie", 3: "Sunset" });
        });

        it("should disambiguate duplicates in the map values", () => {
            const result = buildUniqueLabelMap([
                { name: "Movie" },
                { name: "Aurora" },
                { name: "Movie" },
            ]);
            expect(result).to.deep.equal({ 0: "---", 1: "Movie", 2: "Aurora", 3: "Movie (2)" });
        });

        it("should accept a custom sentinel label", () => {
            const result = buildUniqueLabelMap([{ name: "X" }], "off");
            expect(result).to.deep.equal({ 0: "off", 1: "X" });
        });

        it("should produce just the sentinel for empty input", () => {
            expect(buildUniqueLabelMap([])).to.deep.equal({ 0: "---" });
        });

        it("should accept any T extends {name: string}", () => {
            const result = buildUniqueLabelMap([{ name: "Z", id: 42, extra: { foo: "bar" } }]);
            expect(result[1]).to.equal("Z");
        });
    });

    describe("resolveStatesValue", () => {
        const sceneMap = { 0: "---", 1: "Aurora", 2: "Movie", 3: "Movie (2)" };
        const modeMap = { 0: "---", spectrum: "Spectrum", rolling: "Rolling Tides" };

        it("should resolve numeric input to its key", () => {
            const r = resolveStatesValue(1, sceneMap);
            expect(r).to.deep.equal({ key: "1", canonical: "Aurora" });
        });

        it("should resolve numeric-string input to its key", () => {
            const r = resolveStatesValue("2", sceneMap);
            expect(r).to.deep.equal({ key: "2", canonical: "Movie" });
        });

        it("should resolve label input case-insensitively", () => {
            const r = resolveStatesValue("aurora", sceneMap);
            expect(r).to.deep.equal({ key: "1", canonical: "Aurora" });
        });

        it("should resolve label input with surrounding whitespace", () => {
            const r = resolveStatesValue("  AURORA  ", sceneMap);
            expect(r).to.deep.equal({ key: "1", canonical: "Aurora" });
        });

        it("should match disambiguated label exactly", () => {
            const r = resolveStatesValue("Movie (2)", sceneMap);
            expect(r).to.deep.equal({ key: "3", canonical: "Movie (2)" });
        });

        it("should match the first occurrence when label is the original (non-suffixed) form", () => {
            const r = resolveStatesValue("Movie", sceneMap);
            expect(r).to.deep.equal({ key: "2", canonical: "Movie" });
        });

        it("should resolve string-keyed maps via direct key match", () => {
            const r = resolveStatesValue("spectrum", modeMap);
            expect(r).to.deep.equal({ key: "spectrum", canonical: "Spectrum" });
        });

        it("should resolve string-keyed maps via label match", () => {
            const r = resolveStatesValue("rolling tides", modeMap);
            expect(r).to.deep.equal({ key: "rolling", canonical: "Rolling Tides" });
        });

        it("should return null on unknown numeric index", () => {
            expect(resolveStatesValue(99, sceneMap)).to.be.null;
        });

        it("should return null on unknown label", () => {
            expect(resolveStatesValue("nonexistent", sceneMap)).to.be.null;
        });

        it("should return null on empty string", () => {
            expect(resolveStatesValue("", sceneMap)).to.be.null;
        });

        it("should return null on non-finite number", () => {
            expect(resolveStatesValue(NaN, sceneMap)).to.be.null;
            expect(resolveStatesValue(Infinity, sceneMap)).to.be.null;
        });

        it("should return null on non-string/non-number input", () => {
            expect(resolveStatesValue(null, sceneMap)).to.be.null;
            expect(resolveStatesValue(undefined, sceneMap)).to.be.null;
            expect(resolveStatesValue(true, sceneMap)).to.be.null;
            expect(resolveStatesValue({}, sceneMap)).to.be.null;
            expect(resolveStatesValue([], sceneMap)).to.be.null;
        });

        it("should resolve the sentinel '0' from numeric or string input", () => {
            expect(resolveStatesValue(0, sceneMap)).to.deep.equal({ key: "0", canonical: "---" });
            expect(resolveStatesValue("0", sceneMap)).to.deep.equal({ key: "0", canonical: "---" });
        });

        it("should ignore non-string label entries (drift safety)", () => {
            // Drifted map where one value isn't a string — should not crash, just skip
            const drifted = { 0: "---", 1: 42 as unknown as string };
            expect(resolveStatesValue("42", drifted)).to.be.null;
            expect(resolveStatesValue(1, drifted)).to.deep.equal({ key: "1", canonical: 42 as unknown as string });
        });
    });
});
