// K17 — A mode change sets the other mode selections to "---" (pick a scene and, for example, the music mode jumps to "---").
// krobi 2026-10-08 09:53: "k17 yes"
import { describe, expect, it, vi } from "vitest";

// the router pulls capability-mapper → i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a
// js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { onStateChange } from "../lib/handlers/state-change-router";
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

const PREFIX = "devices.h6199-0017";
const MODES = [
  "scenes.light_scene",
  "scenes.diy_scene",
  "snapshots.snapshot_cloud",
  "snapshots.snapshot_local",
  "music.music_mode",
];

/** A LAN light with music — every mode it offers goes out over LAN. */
function light(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:17",
    name: "Strip",
    type: "devices.types.light",
    lanIp: "192.168.1.17",
    lastLanReplyAt: Date.now(),
    capabilities: [
      {
        type: "devices.capabilities.music_setting",
        instance: "musicMode",
        parameters: {
          dataType: "STRUCT",
          fields: [
            {
              fieldName: "musicMode",
              dataType: "ENUM",
              options: [
                { name: "Energic", value: 5 },
                { name: "Rhythm", value: 3 },
                { name: "Spectrum", value: 4 },
              ],
            },
          ],
        },
      },
    ],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: true },
  };
}

const at = (m: string): string => `govee-smart.0.${PREFIX}.${m}`;

/** Every mode dropdown currently shows a selection; the user writes one datapoint the way the admin does. */
function rig(): { write: (suffix: string, val: ioBroker.StateValue) => Promise<void>; values: Map<string, unknown> } {
  const values = new Map<string, unknown>(MODES.map(m => [at(m), "3"]));
  const dev = light();
  const adapter = {
    log,
    namespace: "govee-smart.0",
    unloading: false,
    deviceRegistry: new DeviceRegistry({ data: { devices: {} } }),
    deviceManager: {
      getDevices: () => [dev],
      getDiagnostics: () => ({ addLog: () => {} }),
      sendCommand: () => Promise.resolve(),
      sendCapabilityCommand: () => Promise.resolve(),
      transportUsed: () => undefined,
    },
    stateManager: { devicePrefix: () => PREFIX },
    groupFanout: null,
    snapshotHandler: { restore: () => Promise.resolve() },
    lanClient: { isListening: () => true, setMusicMode: () => {} },
    mqttClient: null,
    getStateAsync: (id: string) =>
      Promise.resolve(values.has(id) ? ({ val: values.get(id), ack: true } as ioBroker.State) : null),
    getObjectAsync: () =>
      Promise.resolve({ common: { type: "mixed", states: { 0: "---", 1: "One", 2: "Two", 3: "Three" } }, native: {} }),
    setState: (id: string, state: { val: unknown }) => {
      values.set(id, state.val);
      return Promise.resolve();
    },
  };
  return {
    write: (suffix, val) => onStateChange(adapter as never, at(suffix), { val, ack: false } as ioBroker.State),
    values,
  };
}

describe("K17 a mode change resets the other mode selections", () => {
  for (const mode of MODES) {
    it(`choosing ${mode} sets every other mode selection to '---' and keeps its own`, async () => {
      const { write, values } = rig();
      await write(mode, "1");
      expect(values.get(at(mode))).toBe("1");
      for (const other of MODES.filter(m => m !== mode)) {
        expect(values.get(at(other)), other).toBe("0");
      }
    });
  }

  it("a music sensitivity change is no mode change and resets nothing — where a scene choice of the same light does (positive control)", async () => {
    const { write, values } = rig();
    await write("music.music_sensitivity", 50);
    for (const m of MODES) {
      expect(values.get(at(m)), m).toBe("3");
    }
    await write("scenes.light_scene", "1");
    expect(values.get(at("music.music_mode"))).toBe("0");
  });
});
