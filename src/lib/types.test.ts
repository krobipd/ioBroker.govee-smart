import {
  normalizeDeviceId,
  deviceLabel,
  formatGatewayLabel,
  errMessage,
  maskSecret,
  coerceFiniteNumber,
  logRejected,
} from "./types";
import { classifyError } from "./error-category";

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
      expect(formatGatewayLabel({ sku: "H5042", bleName: "ihoment_H5042_C0DE" })).toBe("H5042 (ihoment_H5042_C0DE)");
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
        bleName: "ihoment_H5042_C0DE",
        secretCode: "CANARYsecret0=",
        topic: "GD/deadbeef",
      } as never);
      expect(label).toBe("H5042 (ihoment_H5042_C0DE)");
      expect(label).not.toContain("CANARYsecret0=");
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

    it("should return String() for non-Error primitives", () => {
      expect(errMessage("plain string")).toBe("plain string");
      expect(errMessage(42)).toBe("42");
      expect(errMessage(null)).toBe("null");
      expect(errMessage(undefined)).toBe("undefined");
      expect(errMessage(Symbol("sym"))).toBe("Symbol(sym)");
    });

    it("should render a thrown plain object's fields, not [object Object]", () => {
      // The one that sent readers nowhere: a rejected HTTP/socket object used to
      // reach the log as "[object Object]". Its fields ARE the diagnosis.
      expect(errMessage({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
      expect(errMessage({ msg: "obj" })).toBe('{"msg":"obj"}');
    });

    it("should never throw on a value JSON cannot serialise", () => {
      // A logger that throws inside a catch block turns a handled failure into
      // an unhandled rejection — the crash-loop this adapter guards against.
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(errMessage(circular)).toBe("[object Object]");
      expect(errMessage({ big: 1n })).toBe("[object Object]");
      expect(errMessage({ toJSON: () => JSON.parse("{") })).toBe("[object Object]");
    });

    it("classifies a thrown plain object by its fields (the F1 payoff)", () => {
      // Before the object branch the marker test saw "[object Object]" and every
      // thrown object fell through to UNKNOWN — including the network errors
      // that carry their code as a field.
      expect(classifyError({ code: "ECONNRESET" })).toBe("NETWORK");
      expect(classifyError({ something: "else" })).toBe("UNKNOWN");
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
});

describe("logRejected (the handler every best-effort write hangs on its catch)", () => {
  it("logs the context and the error text at debug — an Error and a bare value alike", () => {
    const debugs: string[] = [];
    const log = { debug: (m: string) => debugs.push(m), info: () => {}, warn: () => {}, error: () => {} } as never;
    logRejected(log, "write info.connection")(new Error("db closed"));
    logRejected(log, "reap stale devices")("plain string");
    expect(debugs).toEqual(["write info.connection: db closed", "reap stale devices: plain string"]);
  });
});
