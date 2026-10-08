// GV-03 — An empty scene list shows "---". That is on purpose: a light may have no scenes right now and get some later.
// krobi 2026-09-10 19:20: "logical, because a light may currently have NO scenes, but later you store some, and --- is on purpose"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildCloudStateDefs } from "../lib/capability-mapper";
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

function light(scenes: { name: string }[]): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:03",
    name: "Strip",
    type: "devices.types.light",
    capabilities: [{ type: "devices.capabilities.dynamic_scene", instance: "lightScene" }],
    scenes: scenes.map((s, i) => ({ name: s.name, value: { id: i + 1, paramId: i + 1 } })),
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: true },
  };
}

function sceneStates(device: GoveeDevice): Record<string, string> | undefined {
  const registry = new DeviceRegistry({ data: { devices: {} } });
  return buildCloudStateDefs(device, log, registry).find(d => d.id === "light_scene")?.states;
}

describe("GV-03 empty scene list", () => {
  it("offers the scene datapoint with exactly {0: '---'} when the light has no scenes", () => {
    expect(sceneStates(light([]))).toEqual({ 0: "---" });
  });

  it("puts the scenes behind '---' once the light has some (positive control)", () => {
    expect(sceneStates(light([{ name: "Aurora" }]))).toEqual({ 0: "---", 1: "Aurora" });
  });
});
