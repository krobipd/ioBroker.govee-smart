// GV-25 — An untested model (seed) asks in the log for the experimental switch and a diagnostics report. It never claims
// that it runs.
// krobi 2026-07-23 (note, no wording kept): the AI had neutralised the hint on its own; krobi took that back over several
// messages. Approved 2026-10-08 09:39 ("gv24,25,27 yes").
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
    H9R01: { name: "Lamp", type: "light", status: "reported" },
  },
} as const;

function linesFor(sku: string, experimental: boolean): string[] {
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
  const dm = new DeviceManager(
    log,
    timers,
    new DeviceRegistry({ data: catalog, experimental }),
    new DeviceIdRegistry(),
  );
  dm.maybeNudgeSeedSku(sku, "My device");
  return lines;
}

const CLAIMS_TO_WORK = /\bworks?\b|\bworking\b|\bruns\b|\bsupported\b/i;

describe("GV-25 an untested model asks for the switch and a report", () => {
  for (const sku of ["H9S01", "H9S02"]) {
    it(`${sku} with the switch off asks for the experimental switch and a diagnostics report, without claiming it works`, () => {
      const lines = linesFor(sku, false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Enable experimental device support");
      expect(lines[0]).toContain("diagnostics report");
      expect(lines[0]).not.toMatch(CLAIMS_TO_WORK);
    });
  }

  it("with the switch already on it still asks for the report and does not claim it works", () => {
    const lines = linesFor("H9S01", true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("diagnostics report");
    expect(lines[0]).not.toMatch(CLAIMS_TO_WORK);
  });

  it("a reported model asks for nothing (positive control)", () => {
    expect(linesFor("H9R01", false)).toEqual([]);
  });
});
