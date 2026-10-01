import { rgbToHex, hexToRgb, rgbIntToHex } from "./color";

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
