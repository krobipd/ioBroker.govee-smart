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

const GATEWAY_ID = "11:22:33:44:55:66:77:88";

/**
 * One poll of the account list — the way the adapter learns that a sensor hangs off a gateway and judges it by it.
 *
 * @param devices the devices the adapter knows
 * @param gatewayNamed whether the account list names the sensor's gateway
 */
async function polled(devices: GoveeDevice[], gatewayNamed: boolean): Promise<void> {
  const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
  const map = (dm as unknown as { devices: Map<string, GoveeDevice> }).devices;
  devices.forEach(d => map.set(`${d.sku}_${d.deviceId.replace(/:/g, "").toLowerCase()}`, d));
  const entries = devices.map(d => ({
    sku: d.sku,
    device: d.deviceId,
    deviceName: d.name,
    settings: d.sku === "H5109" && gatewayNamed ? { gatewayInfo: { sku: "H5042", device: GATEWAY_ID } } : {},
  }));
  dm.setApiClient({ hasBearerToken: () => true, fetchDeviceList: () => Promise.resolve(entries) } as never);
  await dm.pollAppApi();
}

describe("GV-24 the gateway is the reachability device", () => {
  it("the account list links the sensor to its gateway — the adapter knows the sensor only through it", async () => {
    const s = sensor(undefined);
    const gateway = device("H5042", GATEWAY_ID, "devices.types.gateway", { state: { online: true } });
    await polled([s, gateway], true);
    expect(s.gatewayDeviceId).toBe(GATEWAY_ID);
    expect(s.gateway).toContain("H5042");
  });

  it("a dead gateway makes the sensor behind it not reachable, however fresh its last reading", async () => {
    const s = sensor(undefined);
    const gateway = device("H5042", GATEWAY_ID, "devices.types.gateway", { state: { online: false } });
    await polled([s, gateway], true);
    expect(resolveDeviceReachability(s).online).toBe(false);
  });

  it("the same sensor behind a live gateway, or with no gateway named, is decided by its own reading (positive control)", async () => {
    const live = sensor(undefined);
    await polled([live, device("H5042", GATEWAY_ID, "devices.types.gateway", { state: { online: true } })], true);
    expect(resolveDeviceReachability(live).online).toBe(true);
    const alone = sensor(undefined);
    await polled([alone], false);
    expect(resolveDeviceReachability(alone).online).toBe(true);
  });
});
