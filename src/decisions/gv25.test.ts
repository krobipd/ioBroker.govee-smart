// GV-25 — An untested model says in the log that it is untested and asks for a diagnostics report. It never claims that
// it runs. There is no experimental switch. A catalog correction always applies to exactly the model it is written
// for, whatever the model's status.
// krobi 2026-11-03 (translated): 13:36 "the switch was meant to activate untested devices for testing, but it has
// nothing to do with the quirks — if there is a quirk for a device, it must always be active"; 13:38 "it has nothing,
// absolutely nothing to do with the quirks"; 13:40 "we remove this switch; if a device has the status untested, that
// is what the log shows (only for untested)"; 13:42 "they apply to exactly the model that has a correction"; the
// wording above confirmed 13:42 ("ja ist ok."). Replaces the version of 2026-10-08 that asked for the switch.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// device-manager pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";

const timers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  clearTimeout: () => undefined,
  setTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

const catalog = {
  devices: {
    H9S01: { name: "Bulb", type: "light", status: "seed" },
    H9S02: { name: "Strip", type: "light", status: "seed", quirks: { segmentCount: 10 } },
    H9R01: { name: "Lamp", type: "light", status: "reported", quirks: { segmentCount: 12 } },
    H9V01: { name: "Panel", type: "light", status: "verified" },
  },
} as const;

function linesFor(sku: string): string[] {
  const lines: string[] = [];
  const record = (m: string): void => {
    lines.push(m);
  };
  const log: ioBroker.Logger = {
    info: record,
    warn: record,
    error: record,
    debug: () => {},
    silly: () => {},
    level: "info",
  };
  const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: catalog }), new DeviceIdRegistry());
  dm.maybeNudgeSeedSku(sku, "My device");
  return lines;
}

const CLAIMS_TO_WORK = /\bworks?\b|\bworking\b|\bruns\b|\brunning\b|\bsupported\b/i;
const ROOT = path.resolve(__dirname, "..", "..");

describe("GV-25 an untested model says so; there is no switch; a correction applies to its model", () => {
  it("(a) an untested model names its status and asks for a diagnostics report", () => {
    for (const sku of ["H9S01", "H9S02"]) {
      const lines = linesFor(sku);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("untested");
      expect(lines[0]).toContain("diagnostics report");
    }
  });

  it("(a) a reported or verified model writes no such line — the line is only for untested ones", () => {
    expect(linesFor("H9R01")).toEqual([]);
    expect(linesFor("H9V01")).toEqual([]);
    expect(linesFor("H9S01")).toHaveLength(1); // positive control in the same catalog
  });

  it("(b) the line never claims the model works, and never names a switch", () => {
    for (const sku of ["H9S01", "H9S02"]) {
      const [line] = linesFor(sku);
      expect(line).not.toMatch(CLAIMS_TO_WORK);
      expect(line).not.toMatch(/experimental|switch|toggle/i);
    }
  });

  it("(c) there is no experimental switch — not in the settings page, not in the manifest, not in the registry", () => {
    const jsonConfig = fs.readFileSync(path.join(ROOT, "admin", "jsonConfig.json"), "utf-8");
    expect(jsonConfig).not.toContain("experimentalQuirks");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "io-package.json"), "utf-8")) as {
      native: Record<string, unknown>;
    };
    expect(Object.keys(manifest.native)).not.toContain("experimentalQuirks");
    // the registry takes no such option — handing the old one over changes nothing
    const withOldOption = new DeviceRegistry({ data: catalog, experimental: false } as never);
    expect(withOldOption.getQuirks("H9S02")).toEqual({ segmentCount: 10 });
  });

  it("(d) an untested model with a correction gets it, a model without a correction gets none", () => {
    const reg = new DeviceRegistry({ data: catalog });
    expect(reg.getStatus("H9S02")).toBe("seed");
    expect(reg.getQuirks("H9S02")).toEqual({ segmentCount: 10 });
    expect(reg.getQuirks("H9R01")).toEqual({ segmentCount: 12 });
    expect(reg.getQuirks("H9S01")).toBeUndefined();
    expect(reg.getQuirks("H9V01")).toBeUndefined();
  });
});
