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

  it("keeps the exact id every installation already registered with Govee", () => {
    // Govee binds the one-time account verification (login code 454) to this
    // id. Any other value — even a correct UUIDv5 of a different namespace —
    // makes every user re-verify by email. Golden values of UUIDv5(seed, NIL),
    // cross-checked against the `uuid` package and Python's uuid.uuid5.
    expect(deriveGoveeClientId("someone@example.com")).toBe("59fd741edc7e5f98aac49ea17ad61950");
    expect(deriveGoveeClientId(undefined)).toBe("185ab25f93035db58b9a8ffc40fe14e7");
  });
});
