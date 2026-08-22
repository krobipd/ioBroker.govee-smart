import { deriveGoveeClientId } from "./govee-constants";

describe("deriveGoveeClientId", () => {
  it("derives a distinct, stable id per account", () => {
    const a = deriveGoveeClientId("someone@example.com");
    const b = deriveGoveeClientId("other@example.com");
    // One id shared by every user looks like a single bot account to Govee —
    // that is what gets rate-limited or flagged.
    expect(a).not.toBe(b);
    // Same input → same id across restarts (UUIDv5, no random component).
    expect(deriveGoveeClientId("someone@example.com")).toBe(a);
  });

  it("normalises case and whitespace so the id survives a re-typed address", () => {
    const base = deriveGoveeClientId("someone@example.com");
    expect(deriveGoveeClientId("  SomeOne@Example.com  ")).toBe(base);
  });

  it("falls back to a deterministic id when no email is known yet", () => {
    const fallback = deriveGoveeClientId(undefined);
    expect(fallback).toBe(deriveGoveeClientId(""));
    expect(fallback).toBe(deriveGoveeClientId("   "));
    expect(fallback).not.toBe(deriveGoveeClientId("someone@example.com"));
  });

  it("returns a 32-char hex client id (no dashes — Govee's format)", () => {
    expect(deriveGoveeClientId("someone@example.com")).toMatch(/^[0-9a-f]{32}$/);
  });
});
