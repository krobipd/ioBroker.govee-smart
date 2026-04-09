"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const types_1 = require("../src/lib/types");
describe("Types utilities", () => {
    describe("normalizeDeviceId", () => {
        it("should remove colons and lowercase", () => {
            (0, chai_1.expect)((0, types_1.normalizeDeviceId)("AA:BB:CC:DD:EE:FF:00:11")).to.equal("aabbccddeeff0011");
        });
        it("should lowercase already clean IDs", () => {
            (0, chai_1.expect)((0, types_1.normalizeDeviceId)("AABBCCDDEEFF0011")).to.equal("aabbccddeeff0011");
        });
        it("should handle already normalized IDs", () => {
            (0, chai_1.expect)((0, types_1.normalizeDeviceId)("aabbccddeeff0011")).to.equal("aabbccddeeff0011");
        });
        it("should handle empty string", () => {
            (0, chai_1.expect)((0, types_1.normalizeDeviceId)("")).to.equal("");
        });
    });
    describe("classifyError", () => {
        it("should classify ECONNREFUSED as NETWORK", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("connect ECONNREFUSED 1.2.3.4:443"))).to.equal("NETWORK");
        });
        it("should classify ENOTFOUND as NETWORK", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("getaddrinfo ENOTFOUND api.govee.com"))).to.equal("NETWORK");
        });
        it("should classify ENETUNREACH as NETWORK", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("ENETUNREACH"))).to.equal("NETWORK");
        });
        it("should classify ECONNRESET as NETWORK", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("read ECONNRESET"))).to.equal("NETWORK");
        });
        it("should classify errors with .code property as NETWORK", () => {
            const err = new Error("connect failed");
            err.code = "EHOSTUNREACH";
            (0, chai_1.expect)((0, types_1.classifyError)(err)).to.equal("NETWORK");
            const err2 = new Error("DNS lookup failed");
            err2.code = "EAI_AGAIN";
            (0, chai_1.expect)((0, types_1.classifyError)(err2)).to.equal("NETWORK");
        });
        it("should classify ETIMEDOUT via .code as TIMEOUT", () => {
            const err = new Error("connect failed");
            err.code = "ETIMEDOUT";
            (0, chai_1.expect)((0, types_1.classifyError)(err)).to.equal("TIMEOUT");
        });
        it("should classify timeout errors as TIMEOUT", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Request timed out"))).to.equal("TIMEOUT");
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Timeout waiting for response"))).to.equal("TIMEOUT");
        });
        it("should classify 401/403 as AUTH", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("HTTP 401 Unauthorized"))).to.equal("AUTH");
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("HTTP 403 Forbidden"))).to.equal("AUTH");
        });
        it("should classify Login failed as AUTH", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Login failed: invalid credentials"))).to.equal("AUTH");
        });
        it("should classify 429 as RATE_LIMIT", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("HTTP 429 Too Many Requests"))).to.equal("RATE_LIMIT");
        });
        it("should classify Rate limit as RATE_LIMIT", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Rate limit exceeded"))).to.equal("RATE_LIMIT");
        });
        it("should classify Rate limited by Govee as RATE_LIMIT", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Rate limited by Govee: too many requests (status 429)"))).to.equal("RATE_LIMIT");
        });
        it("should classify unknown errors as UNKNOWN", () => {
            (0, chai_1.expect)((0, types_1.classifyError)(new Error("Something unexpected happened"))).to.equal("UNKNOWN");
        });
        it("should handle string errors", () => {
            (0, chai_1.expect)((0, types_1.classifyError)("ECONNREFUSED")).to.equal("NETWORK");
        });
        it("should handle non-Error objects", () => {
            (0, chai_1.expect)((0, types_1.classifyError)({ code: "ERR" })).to.equal("UNKNOWN");
        });
    });
});
//# sourceMappingURL=testTypes.js.map