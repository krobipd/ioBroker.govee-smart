import {
  normalizeDeviceId,
  deviceLabel,
  formatGatewayLabel,
  classifyError,
  rgbToHex,
  hexToRgb,
  rgbIntToHex,
  parseSegmentList,
  disambiguateLabels,
  buildUniqueLabelMap,
  resolveStatesValue,
  errMessage,
  maskSecret,
  coerceFiniteNumber,
  logDedup,
  type ErrorCategory,
} from "./types";

describe("Types utilities", () => {
  describe("deviceLabel", () => {
    it("formats name plus model", () => {
      expect(deviceLabel({ name: "Wifi Thermometer", sku: "H5179" })).toBe("Wifi Thermometer (H5179)");
    });

    it("falls back to the bare SKU when no name is known", () => {
      expect(deviceLabel({ sku: "H5179" })).toBe("H5179");
      expect(deviceLabel({ name: "", sku: "H5179" })).toBe("H5179");
      expect(deviceLabel({ name: "   ", sku: "H5179" })).toBe("H5179");
      expect(deviceLabel({ name: 42 as unknown as string, sku: "H5179" })).toBe("H5179");
    });

    it("collapses name === SKU to the bare SKU (no 'H5179 (H5179)')", () => {
      expect(deviceLabel({ name: "H5179", sku: "H5179" })).toBe("H5179");
    });

    it("keeps the LAN-only fallback name distinct from the SKU", () => {
      expect(deviceLabel({ name: "H6159_c31b", sku: "H6159" })).toBe("H6159_c31b (H6159)");
    });
  });

  describe("formatGatewayLabel", () => {
    it("formats gateway SKU plus BLE name", () => {
      expect(formatGatewayLabel({ sku: "H5042", bleName: "ihoment_H5042_3795" })).toBe("H5042 (ihoment_H5042_3795)");
    });

    it("falls back to the bare SKU when no BLE name is present", () => {
      expect(formatGatewayLabel({ sku: "H5042" })).toBe("H5042");
      expect(formatGatewayLabel({ sku: "H5042", bleName: "" })).toBe("H5042");
      expect(formatGatewayLabel({ sku: "H5042", bleName: "  " })).toBe("H5042");
    });

    it("returns undefined without a usable gateway SKU (so no garbage info.gateway)", () => {
      expect(formatGatewayLabel(undefined)).toBeUndefined();
      expect(formatGatewayLabel({})).toBeUndefined();
      expect(formatGatewayLabel({ sku: "" })).toBeUndefined();
      expect(formatGatewayLabel({ sku: "   " })).toBeUndefined();
      expect(formatGatewayLabel({ sku: 42 as unknown as string, bleName: "x" })).toBeUndefined();
      expect(formatGatewayLabel({ bleName: "orphan" })).toBeUndefined();
    });

    it("never surfaces auth secrets even if present on the object", () => {
      const label = formatGatewayLabel({
        sku: "H5042",
        bleName: "ihoment_H5042_3795",
        secretCode: "VYb5QvZVkjE=",
        topic: "GD/deadbeef",
      } as never);
      expect(label).toBe("H5042 (ihoment_H5042_3795)");
      expect(label).not.toContain("VYb5QvZVkjE=");
      expect(label).not.toContain("GD/");
    });
  });

  describe("normalizeDeviceId", () => {
    it("should remove colons and lowercase", () => {
      expect(normalizeDeviceId("AA:BB:CC:DD:EE:FF:00:11")).toBe("aabbccddeeff0011");
    });

    it("should lowercase already clean IDs", () => {
      expect(normalizeDeviceId("AABBCCDDEEFF0011")).toBe("aabbccddeeff0011");
    });

    it("should handle already normalized IDs", () => {
      expect(normalizeDeviceId("aabbccddeeff0011")).toBe("aabbccddeeff0011");
    });

    it("should handle empty string", () => {
      expect(normalizeDeviceId("")).toBe("");
    });

    it("should return empty string for undefined input", () => {
      expect(normalizeDeviceId(undefined as unknown as string)).toBe("");
    });

    it("should return empty string for null input", () => {
      expect(normalizeDeviceId(null as unknown as string)).toBe("");
    });

    it("should return empty string for number input", () => {
      expect(normalizeDeviceId(12345 as unknown as string)).toBe("");
    });

    it("should not throw on object input", () => {
      expect(() => normalizeDeviceId({} as unknown as string)).not.toThrow();
      expect(normalizeDeviceId({} as unknown as string)).toBe("");
    });
  });

  describe("rgbToHex", () => {
    it("should convert RGB to hex", () => {
      expect(rgbToHex(255, 102, 0)).toBe("#ff6600");
    });

    it("should pad single-digit hex values", () => {
      expect(rgbToHex(0, 0, 0)).toBe("#000000");
    });

    it("should handle white", () => {
      expect(rgbToHex(255, 255, 255)).toBe("#ffffff");
    });

    // Drift guards — v1.6.3 hardening. Upstream could pass NaN (from
    // division-by-zero) or out-of-range values (from buggy capability data).
    it("should clamp values above 255 to 255", () => {
      expect(rgbToHex(300, 500, 1000)).toBe("#ffffff");
    });

    it("should clamp negative values to 0", () => {
      expect(rgbToHex(-10, -1, -500)).toBe("#000000");
    });

    it("should return #000000 for NaN channels", () => {
      expect(rgbToHex(NaN, NaN, NaN)).toBe("#000000");
    });

    it("should coerce non-numeric (undefined) to 0", () => {
      expect(rgbToHex(undefined as unknown as number, 128, 0)).toBe("#008000");
    });

    it("should round fractional channels", () => {
      expect(rgbToHex(127.6, 127.4, 0)).toBe("#80" + "7f" + "00");
    });
  });

  describe("hexToRgb", () => {
    it("should parse hex with #", () => {
      expect(hexToRgb("#ff6600")).toEqual({ r: 255, g: 102, b: 0 });
    });

    it("should parse hex without #", () => {
      expect(hexToRgb("ff6600")).toEqual({ r: 255, g: 102, b: 0 });
    });

    it("should parse black", () => {
      expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("should handle invalid hex as black", () => {
      expect(hexToRgb("xyz")).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("rejects wrong-length hex instead of guessing a colour", () => {
      // "f60" would parse to r=0 g=15 b=96 via parseInt truncation and
      // "ff6600ff" to a sign-extended value — both silently wrong colours.
      expect(hexToRgb("#f60")).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb("#ff66")).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb("#ff6600ff")).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb("#")).toEqual({ r: 0, g: 0, b: 0 });
      // Six characters that are not all hex digits must not slip through.
      expect(hexToRgb("#gg6600")).toEqual({ r: 0, g: 0, b: 0 });
    });

    // Drift guard — MQTT/Cloud could deliver non-string in color fields.
    it("should return black for non-string input (undefined)", () => {
      expect(hexToRgb(undefined as unknown as string)).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("should return black for non-string input (null)", () => {
      expect(hexToRgb(null as unknown as string)).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("should return black for non-string input (number)", () => {
      expect(hexToRgb(0xff6600 as unknown as string)).toEqual({ r: 0, g: 0, b: 0 });
    });
  });

  describe("rgbIntToHex", () => {
    it("should convert packed int to hex", () => {
      expect(rgbIntToHex(0xff6600)).toBe("#ff6600");
    });

    it("should handle zero", () => {
      expect(rgbIntToHex(0)).toBe("#000000");
    });

    it("should handle white", () => {
      expect(rgbIntToHex(0xffffff)).toBe("#ffffff");
    });
  });

  describe("classifyError", () => {
    it("should classify ECONNREFUSED as NETWORK", () => {
      expect(classifyError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe("NETWORK");
    });

    it("should classify ENOTFOUND as NETWORK", () => {
      expect(classifyError(new Error("getaddrinfo ENOTFOUND api.govee.com"))).toBe("NETWORK");
    });

    it("should classify ENETUNREACH as NETWORK", () => {
      expect(classifyError(new Error("ENETUNREACH"))).toBe("NETWORK");
    });

    it("should classify ECONNRESET as NETWORK", () => {
      expect(classifyError(new Error("read ECONNRESET"))).toBe("NETWORK");
    });

    it("should classify errors with .code property as NETWORK", () => {
      const err = new Error("connect failed") as NodeJS.ErrnoException;
      err.code = "EHOSTUNREACH";
      expect(classifyError(err)).toBe("NETWORK");

      const err2 = new Error("DNS lookup failed") as NodeJS.ErrnoException;
      err2.code = "EAI_AGAIN";
      expect(classifyError(err2)).toBe("NETWORK");
    });

    it("should classify ETIMEDOUT via .code as TIMEOUT", () => {
      const err = new Error("connect failed") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      expect(classifyError(err)).toBe("TIMEOUT");
    });

    it("should classify timeout errors as TIMEOUT", () => {
      expect(classifyError(new Error("Request timed out"))).toBe("TIMEOUT");
      expect(classifyError(new Error("Timeout waiting for response"))).toBe("TIMEOUT");
    });

    it("should classify 401/403 as AUTH", () => {
      expect(classifyError(new Error("HTTP 401 Unauthorized"))).toBe("AUTH");
      expect(classifyError(new Error("HTTP 403 Forbidden"))).toBe("AUTH");
    });

    it("should classify Login failed as AUTH", () => {
      expect(classifyError(new Error("Login failed: invalid credentials"))).toBe("AUTH");
    });

    it("should classify 429 as RATE_LIMIT", () => {
      expect(classifyError(new Error("HTTP 429 Too Many Requests"))).toBe("RATE_LIMIT");
    });

    it("should classify Rate limit as RATE_LIMIT", () => {
      expect(classifyError(new Error("Rate limit exceeded"))).toBe("RATE_LIMIT");
    });

    it("should classify Rate limited by Govee as RATE_LIMIT", () => {
      expect(classifyError(new Error("Rate limited by Govee: too many requests (status 429)"))).toBe("RATE_LIMIT");
    });

    it("should classify unknown errors as UNKNOWN", () => {
      expect(classifyError(new Error("Something unexpected happened"))).toBe("UNKNOWN");
    });

    it("classifies an HTTP error by its status field even when the message carries no marker", () => {
      // http-client rejects with `HttpError("HTTP 401", 401)` — the number is
      // a field, the message is just a label.
      const auth = Object.assign(new Error("HTTP 401"), { statusCode: 401 });
      const forbidden = Object.assign(new Error("HTTP 403"), { statusCode: 403 });
      const limited = Object.assign(new Error("HTTP 429"), { statusCode: 429 });
      const server = Object.assign(new Error("HTTP 503"), { statusCode: 503 });
      expect(classifyError(auth)).toBe("AUTH");
      expect(classifyError(forbidden)).toBe("AUTH");
      expect(classifyError(limited)).toBe("RATE_LIMIT");
      expect(classifyError(server)).toBe("UNKNOWN");
    });

    it("does NOT classify a quoted foreign body as AUTH just because it contains 'auth' or '401'", () => {
      // An "Invalid JSON" error quotes the first 100 chars of a Govee maintenance
      // page — treating that as AUTH stopped the Cloud retry loop for good and
      // told the user to check a valid API key.
      const html = new Error(
        'Invalid JSON in HTTP 200 response: Unexpected token < — body starts with: <html><meta name="author" content="ops 401">',
      );
      expect(classifyError(html)).toBe("UNKNOWN");
      expect(classifyError(new Error("device H1401 rejected the command"))).toBe("UNKNOWN");
    });

    it("classifies the mqtt.js credential-refused reason codes as AUTH", () => {
      const notAuthorized = Object.assign(new Error("Connection refused: Not authorized"), { code: 5 });
      const badCreds = Object.assign(new Error("Connection refused: Bad username or password"), { code: 4 });
      expect(classifyError(notAuthorized)).toBe("AUTH");
      expect(classifyError(badCreds)).toBe("AUTH");
      // The same texts without a code still classify by their words.
      expect(classifyError(new Error("Connection refused: Not authorized"))).toBe("AUTH");
    });

    it("should handle string errors", () => {
      expect(classifyError("ECONNREFUSED")).toBe("NETWORK");
    });

    it("should handle non-Error objects", () => {
      expect(classifyError({ code: "ERR" })).toBe("UNKNOWN");
    });
  });

  describe("parseSegmentList", () => {
    it("should parse comma-separated indices", () => {
      const r = parseSegmentList("0,1,2,3", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([0, 1, 2, 3]);
    });

    it("should parse a range", () => {
      const r = parseSegmentList("0-9", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("should parse mixed ranges and individuals", () => {
      const r = parseSegmentList("0-2,4-6,10", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([0, 1, 2, 4, 5, 6, 10]);
    });

    it("should tolerate whitespace", () => {
      const r = parseSegmentList("0, 3, 5 - 7, 10-12", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([0, 3, 5, 6, 7, 10, 11, 12]);
    });

    it("should dedupe entries", () => {
      const r = parseSegmentList("0,0,1,1,2", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([0, 1, 2]);
    });

    it("should sort ascending", () => {
      const r = parseSegmentList("5,3,1,4,2", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([1, 2, 3, 4, 5]);
    });

    it("should reject empty string", () => {
      const r = parseSegmentList("", 14);
      expect(r.error).not.toBeNull();
      expect(r.indices).toEqual([]);
    });

    it("should reject whitespace-only", () => {
      const r = parseSegmentList("   ", 14);
      expect(r.error).not.toBeNull();
    });

    it("should reject negative numbers", () => {
      const r = parseSegmentList("-1,0,1", 14);
      expect(r.error).not.toBeNull();
    });

    it("should reject indices above per-device max", () => {
      const r = parseSegmentList("0-15", 14);
      expect(r.error).not.toBeNull();
      expect(r.error).toContain("15");
      expect(r.error).toContain("0-14");
    });

    it("clamps to the hard backstop SEGMENT_HARD_MAX (55): accepts 55, rejects 56 (I3)", () => {
      // A large maxIndex must not let indices past the protocol limit through.
      expect(parseSegmentList("55", 200).error).toBeNull(); // 55 == effectiveMax → accepted
      expect(parseSegmentList("56", 200).error).not.toBeNull(); // 56 > 55 → rejected
    });

    it("should reject non-numeric tokens", () => {
      const r = parseSegmentList("0,abc,2", 14);
      expect(r.error).not.toBeNull();
    });

    it("should reject reversed range", () => {
      const r = parseSegmentList("9-0", 14);
      expect(r.error).not.toBeNull();
      expect(r.error).toContain("start");
    });

    it("should handle single index", () => {
      const r = parseSegmentList("5", 14);
      expect(r.error).toBeNull();
      expect(r.indices).toEqual([5]);
    });

    it("should handle non-string input safely", () => {
      const r = parseSegmentList(null as unknown as string, 14);
      expect(r.error).not.toBeNull();
      expect(r.indices).toEqual([]);
    });

    it("falls back to the hard backstop 55 when maxIndex is invalid (I3)", () => {
      expect(parseSegmentList("55", -1).error).toBeNull(); // effectiveMax = 55
      expect(parseSegmentList("56", -1).error).not.toBeNull(); // 56 > 55 → rejected
    });
  });

  describe("disambiguateLabels", () => {
    it("should pass through unique names unchanged", () => {
      expect(disambiguateLabels(["Aurora", "Movie", "Sunset"])).toEqual(["Aurora", "Movie", "Sunset"]);
    });

    it("should suffix duplicates with (2), (3), …", () => {
      expect(disambiguateLabels(["Movie", "Aurora", "Movie", "Movie"])).toEqual([
        "Movie",
        "Aurora",
        "Movie (2)",
        "Movie (3)",
      ]);
    });

    it("should keep first occurrence of each name unchanged", () => {
      expect(disambiguateLabels(["A", "B", "A", "B", "A"])).toEqual(["A", "B", "A (2)", "B (2)", "A (3)"]);
    });

    it("should handle empty list", () => {
      expect(disambiguateLabels([])).toEqual([]);
    });

    it("does not collide with an input that already carries a (N) suffix (I4)", () => {
      // Old code produced two "Aurora (2)" entries here; the reverse-lookup then
      // maps two dropdown keys to the same label. Each output must be unique.
      const out = disambiguateLabels(["Aurora", "Aurora", "Aurora (2)"]);
      expect(out).toEqual(["Aurora", "Aurora (2)", "Aurora (2) (2)"]);
      expect(new Set(out).size).toBe(out.length); // all unique
    });

    it("should treat empty strings as duplicates after first", () => {
      expect(disambiguateLabels(["", "x", ""])).toEqual(["", "x", " (2)"]);
    });
  });

  describe("buildUniqueLabelMap", () => {
    it("should build a 0-based sentinel map for unique names", () => {
      const result = buildUniqueLabelMap([{ name: "Aurora" }, { name: "Movie" }, { name: "Sunset" }]);
      expect(result).toEqual({ 0: "---", 1: "Aurora", 2: "Movie", 3: "Sunset" });
    });

    it("should disambiguate duplicates in the map values", () => {
      const result = buildUniqueLabelMap([{ name: "Movie" }, { name: "Aurora" }, { name: "Movie" }]);
      expect(result).toEqual({ 0: "---", 1: "Movie", 2: "Aurora", 3: "Movie (2)" });
    });

    it("should accept a custom sentinel label", () => {
      const result = buildUniqueLabelMap([{ name: "X" }], "off");
      expect(result).toEqual({ 0: "off", 1: "X" });
    });

    it("should produce just the sentinel for empty input", () => {
      expect(buildUniqueLabelMap([])).toEqual({ 0: "---" });
    });

    it("should accept any T extends {name: string}", () => {
      const result = buildUniqueLabelMap([{ name: "Z", id: 42, extra: { foo: "bar" } }]);
      expect(result[1]).toBe("Z");
    });
  });

  describe("resolveStatesValue", () => {
    const sceneMap = { 0: "---", 1: "Aurora", 2: "Movie", 3: "Movie (2)" };
    const modeMap = { 0: "---", spectrum: "Spectrum", rolling: "Rolling Tides" };

    it("should resolve numeric input to its key", () => {
      const r = resolveStatesValue(1, sceneMap);
      expect(r).toEqual({ key: "1", canonical: "Aurora" });
    });

    it("should resolve numeric-string input to its key", () => {
      const r = resolveStatesValue("2", sceneMap);
      expect(r).toEqual({ key: "2", canonical: "Movie" });
    });

    it("should resolve label input case-insensitively", () => {
      const r = resolveStatesValue("aurora", sceneMap);
      expect(r).toEqual({ key: "1", canonical: "Aurora" });
    });

    it("should resolve label input with surrounding whitespace", () => {
      const r = resolveStatesValue("  AURORA  ", sceneMap);
      expect(r).toEqual({ key: "1", canonical: "Aurora" });
    });

    it("should match disambiguated label exactly", () => {
      const r = resolveStatesValue("Movie (2)", sceneMap);
      expect(r).toEqual({ key: "3", canonical: "Movie (2)" });
    });

    it("should match the first occurrence when label is the original (non-suffixed) form", () => {
      const r = resolveStatesValue("Movie", sceneMap);
      expect(r).toEqual({ key: "2", canonical: "Movie" });
    });

    it("should resolve string-keyed maps via direct key match", () => {
      const r = resolveStatesValue("spectrum", modeMap);
      expect(r).toEqual({ key: "spectrum", canonical: "Spectrum" });
    });

    it("should resolve string-keyed maps via label match", () => {
      const r = resolveStatesValue("rolling tides", modeMap);
      expect(r).toEqual({ key: "rolling", canonical: "Rolling Tides" });
    });

    it("does not resolve inherited prototype members (__proto__ / toString / constructor) (SEC-GC2)", () => {
      // Direct key lookup used to hit Object.prototype members, falsely returning
      // a non-null result (canonical = a function) for a non-existent state.
      for (const evil of ["__proto__", "toString", "constructor", "hasOwnProperty", "valueOf"]) {
        expect(resolveStatesValue(evil, sceneMap)).toBeNull();
      }
    });

    it("should return null on unknown numeric index", () => {
      expect(resolveStatesValue(99, sceneMap)).toBeNull();
    });

    it("should return null on unknown label", () => {
      expect(resolveStatesValue("nonexistent", sceneMap)).toBeNull();
    });

    it("should return null on empty string", () => {
      expect(resolveStatesValue("", sceneMap)).toBeNull();
    });

    it("should return null on non-finite number", () => {
      expect(resolveStatesValue(NaN, sceneMap)).toBeNull();
      expect(resolveStatesValue(Infinity, sceneMap)).toBeNull();
    });

    it("should return null on non-string/non-number input", () => {
      expect(resolveStatesValue(null, sceneMap)).toBeNull();
      expect(resolveStatesValue(undefined, sceneMap)).toBeNull();
      expect(resolveStatesValue(true, sceneMap)).toBeNull();
      expect(resolveStatesValue({}, sceneMap)).toBeNull();
      expect(resolveStatesValue([], sceneMap)).toBeNull();
    });

    it("should resolve the sentinel '0' from numeric or string input", () => {
      expect(resolveStatesValue(0, sceneMap)).toEqual({ key: "0", canonical: "---" });
      expect(resolveStatesValue("0", sceneMap)).toEqual({ key: "0", canonical: "---" });
    });

    it("should ignore non-string label entries (drift safety)", () => {
      // Drifted map where one value isn't a string — should not crash, just skip
      const drifted = { 0: "---", 1: 42 as unknown as string };
      expect(resolveStatesValue("42", drifted)).toBeNull();
      expect(resolveStatesValue(1, drifted)).toEqual({ key: "1", canonical: 42 as unknown as string });
    });
  });

  describe("maskSecret", () => {
    it("reveals only a short prefix and never the full secret", () => {
      expect(maskSecret("3f2a9c10-dead-beef-cafe")).toBe("3f2a***");
      expect(maskSecret("3f2a9c10-dead-beef-cafe")).not.toContain("dead");
    });

    it("fully masks empty or too-short input", () => {
      expect(maskSecret("")).toBe("***");
      expect(maskSecret("abcd")).toBe("***");
    });
  });

  describe("errMessage", () => {
    it("should return only e.message for Errors — the stack stays out of warn/error lines (v2.10.1 contract)", () => {
      const e = new Error("boom");
      const out = errMessage(e);
      expect(out).toBe("boom");
      // A stack trace would contain call-site lines ("at ...") — must not leak.
      expect(out).not.toContain("at ");
    });

    it("should return String() for non-Error values", () => {
      expect(errMessage("plain string")).toBe("plain string");
      expect(errMessage(42)).toBe("42");
      expect(errMessage(null)).toBe("null");
      expect(errMessage(undefined)).toBe("undefined");
      expect(errMessage({ msg: "obj" })).toBe("[object Object]");
    });
  });

  describe("coerceFiniteNumber", () => {
    it("should accept finite numbers", () => {
      expect(coerceFiniteNumber(0)).toBe(0);
      expect(coerceFiniteNumber(42)).toBe(42);
      expect(coerceFiniteNumber(-1.5)).toBe(-1.5);
    });

    it("should reject NaN/Infinity", () => {
      expect(coerceFiniteNumber(NaN)).toBeNull();
      expect(coerceFiniteNumber(Infinity)).toBeNull();
      expect(coerceFiniteNumber(-Infinity)).toBeNull();
    });

    it("should accept numeric strings (Govee API quirk)", () => {
      expect(coerceFiniteNumber("50")).toBe(50);
      expect(coerceFiniteNumber("3.14")).toBe(3.14);
      expect(coerceFiniteNumber("-7")).toBe(-7);
    });

    it("should reject non-numeric strings", () => {
      expect(coerceFiniteNumber("abc")).toBeNull();
      expect(coerceFiniteNumber("12abc")).toBeNull();
      expect(coerceFiniteNumber("")).toBeNull();
      expect(coerceFiniteNumber("   ")).toBeNull();
    });

    it("should reject other types", () => {
      expect(coerceFiniteNumber(null)).toBeNull();
      expect(coerceFiniteNumber(undefined)).toBeNull();
      expect(coerceFiniteNumber(true)).toBeNull();
      expect(coerceFiniteNumber({})).toBeNull();
      expect(coerceFiniteNumber([])).toBeNull();
    });
  });

  describe("logDedup", () => {
    function makeMockLog(): {
      log: ioBroker.Logger;
      warns: string[];
      debugs: string[];
    } {
      const warns: string[] = [];
      const debugs: string[] = [];
      const log: ioBroker.Logger = {
        info: () => {},
        warn: (m: string) => warns.push(m),
        error: () => {},
        debug: (m: string) => debugs.push(m),
        silly: () => {},
        level: "debug",
      };
      return { log, warns, debugs };
    }

    it("should warn on first error of a category", () => {
      const { log, warns, debugs } = makeMockLog();
      const cat = logDedup(log, null, "Cloud", new Error("ECONNREFUSED something"));
      expect(cat).toBe("NETWORK");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("Cloud:");
      expect(debugs).toHaveLength(0);
    });

    it("should debug on repeated same category", () => {
      const { log, warns, debugs } = makeMockLog();
      const e1 = new Error("ECONNREFUSED first");
      const e2 = new Error("ECONNREFUSED second");
      const cat1 = logDedup(log, null, "Cloud", e1);
      const cat2 = logDedup(log, cat1, "Cloud", e2);
      expect(cat2).toBe("NETWORK");
      expect(warns).toHaveLength(1);
      expect(debugs).toHaveLength(1);
      expect(debugs[0]).toContain("repeated");
    });

    it("should warn again on category change", () => {
      const { log, warns } = makeMockLog();
      const lastCat: ErrorCategory | null = logDedup(log, null, "Cloud", new Error("ECONNREFUSED"));
      logDedup(log, lastCat, "Cloud", new Error("status 401 unauthorized"));
      expect(warns).toHaveLength(2);
    });
  });
});
