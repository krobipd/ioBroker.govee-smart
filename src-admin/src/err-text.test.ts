import { describe, it, expect } from "vitest";

import { errText } from "../../src/lib/err-text";

describe("errText (shared with the admin component)", () => {
  it("returns the message of an Error", () => {
    expect(errText(new Error("socket closed"))).toBe("socket closed");
  });

  it("returns a string as it is and renders other primitives with String()", () => {
    expect(errText("timeout")).toBe("timeout");
    expect(errText(42)).toBe("42");
    expect(errText(undefined)).toBe("undefined");
    expect(errText(null)).toBe("null");
  });

  it("renders a thrown plain object's fields, not [object Object]", () => {
    expect(errText({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
  });

  it("falls back to the type tag when the object cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errText(circular)).toBe("[object Object]");
    expect(errText({ big: 1n })).toBe("[object Object]");
  });
});
