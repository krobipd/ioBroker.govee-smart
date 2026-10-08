// GV-24 — A device behind a Govee gateway is supported only through the gateway; the gateway is its reachability device.
// krobi 2026-09-03 (note): "and gateway devices we support only through the gateway, the gateway is then our online/offline
// device"
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
import { resolveDeviceReachability } from "../lib/device-manager/lookups";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};
const timers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  clearTimeout: () => undefined,
  setTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

function device(sku: string, deviceId: string, type: string, extra: Partial<GoveeDevice>): GoveeDevice {
  return {
    sku,
    deviceId,
    name: sku,
    type,
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    channels: { lan: false, mqtt: false, cloud: true },
    ...extra,
  } as GoveeDevice;
}

/**
 * The sensor just delivered a reading — on its own evidence it counts as reachable.
 *
 * @param gatewayDeviceId the gateway the sensor names, if any
 */
function sensor(gatewayDeviceId?: string): GoveeDevice {
  return device("H5109", "AA:BB:CC:DD:EE:FF:00:24", "devices.types.thermometer", {
    gatewayDeviceId,
    state: { online: true, cloudLivenessAt: Date.now() - 30_000 },
  });
}

function resolved(devices: GoveeDevice[]): void {
  const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
  const map = (dm as unknown as { devices: Map<string, GoveeDevice> }).devices;
  devices.forEach((d, i) => map.set(`k${i}`, d));
  (dm as unknown as { resolveGatewayReachability(): void }).resolveGatewayReachability();
}

describe("GV-24 the gateway is the reachability device", () => {
  it("a dead gateway makes the sensor behind it not reachable, however fresh its last reading", () => {
    const s = sensor("11:22:33:44:55:66:77:88");
    const gateway = device("H5042", "11:22:33:44:55:66:77:88", "devices.types.gateway", { state: { online: false } });
    resolved([s, gateway]);
    expect(resolveDeviceReachability(s).online).toBe(false);
  });

  it("the same sensor with no gateway named is decided by its own reading (positive control)", () => {
    const s = sensor(undefined);
    resolved([s]);
    expect(resolveDeviceReachability(s).online).toBe(true);
  });
});
