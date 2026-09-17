import { describe, it, expect } from "vitest";

import { errMessage } from "./err-message";

describe("errMessage (admin component)", () => {
  it("returns the message of an Error", () => {
    expect(errMessage(new Error("socket closed"))).toBe("socket closed");
  });

  it("returns a string as it is and renders other primitives with String()", () => {
    expect(errMessage("timeout")).toBe("timeout");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(undefined)).toBe("undefined");
    expect(errMessage(null)).toBe("null");
  });

  it("renders a thrown plain object's fields, not [object Object]", () => {
    expect(errMessage({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
  });

  it("falls back to the type tag when the object cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errMessage(circular)).toBe("[object Object]");
    expect(errMessage({ big: 1n })).toBe("[object Object]");
  });
});
