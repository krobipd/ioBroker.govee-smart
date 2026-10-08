// GV-19 — App groups are not asked for their state at start. Govee answers "400 devices not exist"; the call cost one
// cloud call per group on every start.
// krobi 2026-09-22 21:02: "then do it"; 2026-10-07 20:27: "govee tells us nothing here, so we need not ask"
import { describe, expect, it, vi } from "vitest";

// capability-mapper pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { loadCloudStates, type CloudStateLoaderAdapter } from "../lib/handlers/cloud-state-loader";
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

function device(sku: string, deviceId: string): GoveeDevice {
  return {
    sku,
    deviceId,
    name: sku,
    type: "devices.types.light",
    capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
    scenes: [],
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

describe("GV-19 no state read for app groups", () => {
  it("the start load asks Govee for the state of a cloud light, never for the app group", async () => {
    const asked: string[] = [];
    const devices = [device("BaseGroup", "1234567"), device("H6199", "AA:BB:CC:DD:EE:FF:00:19")];
    const adapter: CloudStateLoaderAdapter = {
      log,
      rateLimiter: null,
      deviceRegistry: new DeviceRegistry({ data: { devices: {} } }),
      cloudClient: {
        getDeviceState: (sku: string) => {
          asked.push(sku);
          return Promise.resolve([]);
        },
      } as never,
      deviceManager: {
        getDevices: () => devices,
        applyCloudStateOnline: () => {},
        getDiagnostics: () => ({ recordApiFailure: () => {} }),
      } as never,
      stateManager: {
        devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}`,
        resolveStatePath: (prefix: string, stateId: string) => `${prefix}.control.${stateId}`,
      } as never,
      setState: () => Promise.resolve(),
      setStateChanged: () => Promise.resolve(),
    };
    await loadCloudStates(adapter);
    expect(asked).toEqual(["H6199"]);
  });
});
