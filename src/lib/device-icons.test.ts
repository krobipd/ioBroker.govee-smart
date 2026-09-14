import { GROUP_ICON, iconForGoveeType, shortenGoveeType } from "./device-icons";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";

describe("device-icons", () => {
  describe("iconForGoveeType", () => {
    it("returns a base64 svg data-URI for every known device type", () => {
      for (const t of Object.values(GOVEE_DEVICE_TYPE)) {
        expect(iconForGoveeType(t)).toMatch(/^data:image\/svg\+xml;base64,/);
      }
    });

    it("maps thermometer and sensor to the same icon", () => {
      expect(iconForGoveeType(GOVEE_DEVICE_TYPE.SENSOR)).toBe(iconForGoveeType(GOVEE_DEVICE_TYPE.THERMOMETER));
    });

    it("maps humidifier and dehumidifier to the same icon", () => {
      expect(iconForGoveeType(GOVEE_DEVICE_TYPE.DEHUMIDIFIER)).toBe(iconForGoveeType(GOVEE_DEVICE_TYPE.HUMIDIFIER));
    });

    it("falls back to the light icon for unknown / undefined types", () => {
      expect(iconForGoveeType(undefined)).toBe(iconForGoveeType(GOVEE_DEVICE_TYPE.LIGHT));
      expect(iconForGoveeType("devices.types.something_new")).toBe(iconForGoveeType(GOVEE_DEVICE_TYPE.LIGHT));
    });

    it("GROUP_ICON is a distinct data-URI (not the light fallback)", () => {
      expect(GROUP_ICON).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(GROUP_ICON).not.toBe(iconForGoveeType(GOVEE_DEVICE_TYPE.LIGHT));
    });
  });

  // The Admin inlines a data:image/svg+xml icon into the object tree row, so
  // the markup inherits the row's text colour ONLY through `currentColor` —
  // it does not invert or recolour anything (measured at admin 7.9.13 and
  // 8.0.12, 2026-09-12). Until 2.36.1 every icon here carried no fill at all:
  // default black, invisible on both dark themes. And the row's cell CSS
  // zeroes the width of rect/image/use/nested svg/foreignObject inside the
  // inlined markup, so only path and circle may draw.
  describe("every icon is theme-true in the inlined object-tree row", () => {
    const decode = (uri: string): string =>
      Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
    const icons = [...new Set([...Object.values(GOVEE_DEVICE_TYPE).map(iconForGoveeType), GROUP_ICON])];

    it("the root svg fills with currentColor and nothing carries a fixed colour", () => {
      for (const uri of icons) {
        const svg = decode(uri);
        expect(svg, svg).toMatch(/^<svg[^>]*\sfill="currentColor"[^>]*>/);
        const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map(m => m[1]);
        expect(
          colours.every(c => c === "currentColor" || c === "none"),
          svg,
        ).toBe(true);
      }
    });

    it("draws with path and circle only", () => {
      for (const uri of icons) {
        const svg = decode(uri);
        const elements = [...svg.matchAll(/<([a-zA-Z]+)[\s/>]/g)].map(m => m[1]).filter(e => e !== "svg");
        expect(elements.length, svg).toBeGreaterThan(0);
        expect(
          elements.every(e => e === "path" || e === "circle"),
          svg,
        ).toBe(true);
      }
    });
  });

  describe("shortenGoveeType", () => {
    it("strips the devices.types. prefix", () => {
      expect(shortenGoveeType("devices.types.light")).toBe("light");
      expect(shortenGoveeType("devices.types.air_purifier")).toBe("air_purifier");
    });

    it("returns 'unknown' for missing / non-string / prefix-only input", () => {
      expect(shortenGoveeType(undefined)).toBe("unknown");
      expect(shortenGoveeType("")).toBe("unknown");
      expect(shortenGoveeType(42 as never)).toBe("unknown");
      expect(shortenGoveeType("devices.types.")).toBe("unknown");
    });
  });
});
