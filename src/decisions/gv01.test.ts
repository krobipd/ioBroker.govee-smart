// GV-01 — A new device goes into the catalog and is adapted through the quirk system. No device is written into the code.
// krobi 2026-09-10 21:06: "… whether one hardcodes it — which is not the point of the adapter — or uses the quirk system"
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildLanStateDefs } from "../lib/capability-mapper";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

/** A model no line of the adapter knows — only the catalog entry below can change how it behaves. */
const UNKNOWN_SKU = "H9Q01";

function light(): GoveeDevice {
  return {
    sku: UNKNOWN_SKU,
    deviceId: "AA:BB:CC:DD:EE:FF:00:01",
    name: "New lamp",
    type: "devices.types.light",
    lanIp: "192.168.1.30",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: false },
  };
}

function colourTemperatureRange(registry: DeviceRegistry): { min?: number; max?: number } {
  const ct = buildLanStateDefs(light(), log, registry).find(d => d.id === "color_temperature");
  return { min: ct?.min, max: ct?.max };
}

describe("GV-01 a catalog quirk adapts a model without code for it", () => {
  it("a colorTempRange entry for an unknown model sets its colour-temperature range", () => {
    const registry = new DeviceRegistry({
      data: {
        devices: {
          [UNKNOWN_SKU]: {
            name: "New lamp",
            type: "light",
            status: "reported",
            quirks: { colorTempRange: { min: 2700, max: 6500 } },
          },
        },
      },
    });
    expect(colourTemperatureRange(registry)).toEqual({ min: 2700, max: 6500 });
  });

  it("without the catalog entry the same model keeps the generic LAN range (positive control)", () => {
    const registry = new DeviceRegistry({ data: { devices: {} } });
    expect(colourTemperatureRange(registry)).not.toEqual({ min: 2700, max: 6500 });
  });

  it("a model the code does not know gets its status-push decoder from the catalog entry alone", () => {
    const timers = {
      setInterval: () => undefined,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
      setTimeout: () => undefined,
      delay: () => Promise.resolve(),
    } as never;
    // the battery lamp's own status push, battery 48 % (`aa 42 30`)
    const push = {
      sku: UNKNOWN_SKU,
      device: light().deviceId,
      cmd: "status",
      op: { command: ["qkIwAAAAAAAAAAAAAAAAAAAAANg="] },
    };
    const decoded = (registry: DeviceRegistry): unknown[] => {
      const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
      (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", light());
      dm.releaseHeldPushes();
      const seen: unknown[] = [];
      dm.setOnCloudCapabilities((_device, caps) => seen.push(...caps));
      dm.handleMqttStatus(push);
      return seen;
    };
    const catalog = new DeviceRegistry({
      data: {
        devices: {
          [UNKNOWN_SKU]: {
            name: "New lamp",
            type: "light",
            status: "reported",
            quirks: { pushDecoder: "h1741-battery" },
          },
        },
      },
    });
    expect(decoded(catalog)).toEqual([
      { type: "devices.capabilities.property", instance: "battery", state: { value: 48 } },
    ]);
    // positive control: without the entry the same push decodes nothing
    expect(decoded(new DeviceRegistry({ data: { devices: {} } }))).toEqual([]);
  });

  it("no model id is written into the product code — not as a text, not as a key", () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "decisions") {
            walk(full);
          }
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          fs.readFileSync(full, "utf-8")
            .split("\n")
            .forEach((line, i) => {
              const code = line.replace(/\/\/.*$/, "");
              if (/^\s*(\*|\/\*)/.test(code)) {
                return;
              }
              if (/["'`][HR][0-9][0-9A-Z]{3}["'`]|^\s*[HR][0-9][0-9A-Z]{3}\s*:/.test(code)) {
                found.push(`${path.relative(process.cwd(), full)}:${i + 1}: ${line.trim()}`);
              }
            });
        }
      }
    };
    const src = path.join(process.cwd(), "src");
    walk(src);
    expect(found).toEqual([]);
    // positive control: the walk read the code that once carried such keys
    expect(fs.existsSync(path.join(src, "lib", "appliance-frames.ts"))).toBe(true);
  });
});
