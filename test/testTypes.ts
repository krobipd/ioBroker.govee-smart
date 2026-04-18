import { expect } from "chai";
import { normalizeDeviceId, classifyError, rgbToHex, hexToRgb, rgbIntToHex, parseSegmentList } from "../src/lib/types";

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
            expect(r.error).to.include("Start");
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
});
