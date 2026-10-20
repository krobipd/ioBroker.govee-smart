import { describe, expect, it } from "vitest";
import { colorModeOf, isColorPlaceholder, KELVIN_OF_TABLE_COLOR, restoresAsColorTemperature } from "./color-mode";

describe("colorModeOf — the colour mode a report names (GV-32)", () => {
  it("Kelvin > 0 is colour temperature: Govee's colour beside it is a placeholder, not the light's colour", () => {
    // #57 H6199 status 16:25:52: 255/255/255 with 6667 K; #50 H1741: 0/0/0 with 2700 K — white or black per model
    expect(colorModeOf({ r: 255, g: 255, b: 255 }, 6667)).toEqual({ colorRgb: null, colorTemperature: 6667 });
    expect(colorModeOf({ r: 0, g: 0, b: 0 }, 2700)).toEqual({ colorRgb: null, colorTemperature: 2700 });
  });

  it("Kelvin 0 is RGB: the colour temperature has no value", () => {
    // #57 H6199 status: 255/0/0 with Kelvin 0
    expect(colorModeOf({ r: 255, g: 0, b: 0 }, 0)).toEqual({ colorRgb: "#ff0000", colorTemperature: null });
  });

  it("an RGB that is exactly a table colour is a colour temperature — the app's own way on these models (#57)", () => {
    // the four app commands of #57 (16:25:53–16:26:15), each sent as RGB with Kelvin 0
    expect(colorModeOf({ r: 255, g: 246, b: 243 }, 0)).toEqual({ colorRgb: "#fff6f3", colorTemperature: 6200 });
    expect(colorModeOf({ r: 255, g: 217, b: 171 }, 0)).toEqual({ colorRgb: "#ffd9ab", colorTemperature: 4200 });
    expect(colorModeOf({ r: 255, g: 240, b: 228 }, 0)).toEqual({ colorRgb: "#fff0e4", colorTemperature: 5700 });
    expect(colorModeOf({ r: 255, g: 223, b: 184 }, 0)).toEqual({ colorRgb: "#ffdfb8", colorTemperature: 4500 });
    // #40 H1310 status 255/178/91 = 2800 K; #56 9000 K as #d9e1ff — beyond homebridge's 7100-K table
    expect(colorModeOf({ r: 255, g: 178, b: 91 }, 0).colorTemperature).toBe(2800);
    expect(colorModeOf({ r: 217, g: 225, b: 255 }, 0).colorTemperature).toBe(9000);
  });

  it("a colour next to a table colour is no colour temperature (#56: 255/161/61, 254/250/255)", () => {
    expect(colorModeOf({ r: 255, g: 161, b: 61 }, 0).colorTemperature).toBeNull();
    expect(colorModeOf({ r: 254, g: 250, b: 255 }, 0).colorTemperature).toBeNull();
  });
});

describe("the colour-temperature table", () => {
  it("reads back to exactly one Kelvin per colour — both columns of 51 steps from 2000 to 9000 K", () => {
    expect(KELVIN_OF_TABLE_COLOR.size).toBe(102);
    const kelvins = [...new Set(KELVIN_OF_TABLE_COLOR.values())];
    expect(kelvins).toHaveLength(51);
    expect(Math.min(...kelvins)).toBe(2000);
    expect(Math.max(...kelvins)).toBe(9000);
  });
});

describe("restoresAsColorTemperature — snapshots and the wizard baseline", () => {
  it("a Kelvin with no colour or with Govee's placeholder comes back as colour temperature", () => {
    expect(restoresAsColorTemperature(undefined, 4000)).toBe(true);
    expect(restoresAsColorTemperature(null, 4000)).toBe(true);
    expect(restoresAsColorTemperature("#000000", 4000)).toBe(true);
    expect(restoresAsColorTemperature("#FFFFFF", 4000)).toBe(true);
  });

  it("a Kelvin beside a real colour — the stale value of RGB mode, or a table colour — comes back as the colour", () => {
    expect(restoresAsColorTemperature("#fff3ea", 9000)).toBe(false);
    expect(restoresAsColorTemperature("#ffdfb8", 4500)).toBe(false);
  });

  it("no Kelvin is no colour temperature", () => {
    expect(restoresAsColorTemperature("#000000", 0)).toBe(false);
    expect(restoresAsColorTemperature(undefined, null)).toBe(false);
    expect(isColorPlaceholder("#ff0000")).toBe(false);
  });
});
