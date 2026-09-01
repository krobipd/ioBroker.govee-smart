import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceRegistry } from "./device-registry";

const SAMPLE = {
  devices: {
    H60A1: {
      name: "LED Bulb",
      type: "light",
      status: "seed",
      quirks: { colorTempRange: { min: 2200, max: 6500 } },
    },
    H6022: {
      name: "LED Bulb (RGBWW)",
      type: "light",
      status: "seed",
      quirks: { colorTempRange: { min: 2700, max: 6500 } },
    },
    H6141: {
      name: "LED Strip",
      type: "light",
      status: "seed",
      quirks: { brokenPlatformApi: true },
    },
    H61BE: {
      name: "Glide Wall Light Wide",
      type: "light",
      status: "verified",
      since: "1.0.0",
    },
    H5179: {
      name: "Wifi Thermometer",
      type: "thermometer",
      status: "verified",
      since: "2.0.0",
    },
    H7160: {
      name: "Smart Space Heater",
      type: "heater",
      status: "reported",
      quirks: { brokenPlatformApi: true },
    },
  },
} as const;

describe("DeviceRegistry", () => {
  describe("Loading", () => {
    it("loads inline data without filesystem access", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      // Verify loading via the real lookup API (no production-internal
      // enumeration): a known entry resolves with its parsed fields, an
      // unknown one stays undefined.
      expect(reg.getEntry("H7160")).toMatchObject({ name: "Smart Space Heater", type: "heater", status: "reported" });
      expect(reg.getEntry("H61BE")).toMatchObject({ status: "verified" });
      expect(reg.getEntry("NOPE")).toBeUndefined();
    });

    it("loads from a JSON file on disk", () => {
      const tmp = path.join(os.tmpdir(), `dr-test-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(SAMPLE));
      try {
        const reg = new DeviceRegistry({ filePath: tmp });
        expect(reg.getEntry("H7160")).toMatchObject({ name: "Smart Space Heater" });
        expect(reg.getEntry("H60A1")).toMatchObject({ status: "seed" });
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it("returns empty registry on missing file (no throw)", () => {
      const reg = new DeviceRegistry({
        filePath: "/nonexistent/path/devices.json",
      });
      expect(reg.getEntry("H7160")).toBeUndefined();
    });

    it("returns empty registry on invalid JSON (no throw)", () => {
      const tmp = path.join(os.tmpdir(), `dr-bad-${Date.now()}.json`);
      fs.writeFileSync(tmp, "{ not valid json");
      try {
        const reg = new DeviceRegistry({ filePath: tmp });
        expect(reg.getEntry("H7160")).toBeUndefined();
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it("ignores entries without a devices object", () => {
      const reg = new DeviceRegistry({ data: { devices: undefined } as never });
      expect(reg.getEntry("H7160")).toBeUndefined();
    });

    it("ignores non-object entries within the devices map", () => {
      const reg = new DeviceRegistry({
        data: {
          devices: {
            H1234: null as never,
            H5678: "broken" as never,
            H6022: { name: "x", type: "light", status: "seed" },
          },
        } as never,
      });
      // Only the well-formed entry loads; the null / string entries are dropped.
      expect(reg.getEntry("H6022")).toMatchObject({ name: "x", status: "seed" });
      expect(reg.getEntry("H1234")).toBeUndefined();
      expect(reg.getEntry("H5678")).toBeUndefined();
    });
  });

  describe("Status filter (default: experimental=false)", () => {
    it("activates verified entries (no quirks set)", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      expect(reg.getEntry("H5179")?.status).toBe("verified");
      expect(reg.getQuirks("H5179")).toBeUndefined();
    });

    it("activates reported quirks", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      expect(reg.getQuirks("H7160")).toEqual({
        brokenPlatformApi: true,
      });
    });

    it("hides seed quirks by default", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      expect(reg.getQuirks("H60A1")).toBeUndefined();
      expect(reg.getQuirks("H6022")).toBeUndefined();
      expect(reg.getQuirks("H6141")).toBeUndefined();
    });
  });

  describe("Status filter (experimental=true)", () => {
    it("activates seed quirks when experimental flag is on", () => {
      const reg = new DeviceRegistry({
        data: SAMPLE as never,
        experimental: true,
      });
      expect(reg.getQuirks("H60A1")).toEqual({
        colorTempRange: { min: 2200, max: 6500 },
      });
      expect(reg.getQuirks("H6141")).toEqual({
        brokenPlatformApi: true,
      });
    });
  });

  describe("Lookup helpers", () => {
    const reg = new DeviceRegistry({ data: SAMPLE as never });

    it("getStatus returns the trust tier", () => {
      expect(reg.getStatus("H61BE")).toBe("verified");
      expect(reg.getStatus("H7160")).toBe("reported");
      expect(reg.getStatus("H6022")).toBe("seed");
    });

    it("getStatus returns undefined for unknown SKU", () => {
      expect(reg.getStatus("H9999")).toBeUndefined();
    });

    it("getEntry returns the full entry", () => {
      const e = reg.getEntry("H5179");
      expect(e).toBeDefined();
      expect(e!.name).toBe("Wifi Thermometer");
      expect(e!.type).toBe("thermometer");
      expect(e!.status).toBe("verified");
      expect(e!.since).toBe("2.0.0");
    });

    it("SKU lookup is case-insensitive", () => {
      expect(reg.getQuirks("h7160")).toEqual({ brokenPlatformApi: true });
      expect(reg.getStatus("h61be")).toBe("verified");
    });

    it("loads entries of every status (verified / reported / seed)", () => {
      expect(reg.getEntry("H61BE")?.status).toBe("verified");
      expect(reg.getEntry("H7160")?.status).toBe("reported");
      expect(reg.getEntry("H60A1")?.status).toBe("seed");
    });

    it("safe against non-string SKU input", () => {
      expect(reg.getQuirks(undefined as never)).toBeUndefined();
      expect(reg.getQuirks(null as never)).toBeUndefined();
      expect(reg.getQuirks(42 as never)).toBeUndefined();
      expect(reg.getStatus({} as never)).toBeUndefined();
    });
  });

  describe("instance helpers — one catalog per adapter instance", () => {
    // Deliberately NO module-level registry: in compact mode several instances
    // share one process, and a shared catalog let the instance that started
    // last decide the experimental toggle for all of them.
    it("applyColorTempQuirk falls through to the API range without an active quirk", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      expect(reg.applyColorTempQuirk("H60A1", 2000, 9000)).toEqual({ min: 2000, max: 9000 });
      expect(reg.applyColorTempQuirk("HZZZZ", 2000, 9000)).toEqual({ min: 2000, max: 9000 });
    });

    it("applyColorTempQuirk uses the catalog range once the seed entry is active", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never, experimental: true });
      expect(reg.applyColorTempQuirk("H60A1", 2000, 9000)).toEqual({ min: 2200, max: 6500 });
    });

    it("two instances with different toggles keep their own quirks", () => {
      const plain = new DeviceRegistry({ data: SAMPLE as never });
      const experimental = new DeviceRegistry({ data: SAMPLE as never, experimental: true });
      expect(plain.getQuirks("H6141")).toBeUndefined();
      expect(experimental.getQuirks("H6141")).toEqual({ brokenPlatformApi: true });
      expect(plain.getQuirks("H6141")).toBeUndefined(); // untouched by the other instance
    });

    it("getTier maps the catalog status to a tier label and collapses unknown SKUs to 'unknown'", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never, experimental: true });
      expect(reg.getTier("H60A1")).toBe("seed");
      expect(reg.getTier("H61BE")).toBe("verified");
      expect(reg.getTier("H7160")).toBe("reported");
      expect(reg.getTier("HZZZZ")).toBe("unknown");
    });

    it("getTier is case-insensitive on the SKU", () => {
      const reg = new DeviceRegistry({ data: SAMPLE as never });
      expect(reg.getTier("h60a1")).toBe("seed");
      expect(reg.getTier("H60A1")).toBe("seed");
    });
  });

  describe("devices.json — transportOverrides consistency (mini-validator)", () => {
    // Read the real devices.json and assert every transportOverrides key/value
    // is well-formed. Catches PR typos before runtime ever loads the file.
    // No AJV dependency — manual check is bordmittel and runs as a normal
    // unit test.
    it("all transportOverrides entries use known command names and valid targets", () => {
      const realDevices = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "devices.json"), "utf-8")) as {
        devices: Record<string, { quirks?: { transportOverrides?: Record<string, string> } }>;
      };
      const validCommands = [
        "power",
        "brightness",
        "colorRgb",
        "colorTemperature",
        "lightScene",
        "diyScene",
        "snapshot",
        "gradientToggle",
        "segmentBatch",
      ];
      const validTargets = ["cloud", "lan"];
      let checked = 0;
      for (const [sku, entry] of Object.entries(realDevices.devices)) {
        const overrides = entry.quirks?.transportOverrides;
        if (!overrides) continue;
        for (const [cmd, target] of Object.entries(overrides)) {
          expect(validCommands).toContain(cmd);
          expect(validTargets).toContain(target);
          checked++;
        }
      }
      // Sanity: v2.10.0 ships with H70B3+H70C5 (2 keys each) + H61A8 (1 key) = 5 entries
      expect(checked).toBeGreaterThanOrEqual(5);
    });
  });
});
