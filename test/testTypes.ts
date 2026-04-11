import { expect } from "chai";
import { normalizeDeviceId, classifyError, rgbToHex, hexToRgb, rgbIntToHex } from "../src/lib/types";

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
});
