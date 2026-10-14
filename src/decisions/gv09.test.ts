// GV-09 — Whether a device without a local interface is alive, the adapter asks over the account broker (status request,
// as govee2mqtt does) instead of believing the account list. Models with a different request version get it through a quirk.
// krobi 2026-09-22 10:13 chose "status request over the account broker"; 12:49: "1, and where is your problem? do it"
// (point 1: the statusCmdVersion quirk for the H6121)
import { describe, expect, it, vi } from "vitest";

// device-manager pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { brokerStatusRequester, DeviceManager } from "../lib/device-manager";
import { resolveDeviceReachability } from "../lib/device-manager/lookups";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import { GoveeMqttClient } from "../lib/govee-mqtt-client";
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
  delay: () => Promise.resolve(),
  setTimeout: (cb: () => void) => {
    cb();
    return undefined;
  },
} as never;

const registry = new DeviceRegistry({
  data: {
    devices: {
      H6121: { name: "Light strip", type: "light", status: "reported", quirks: { statusCmdVersion: 1 } },
      H6199: { name: "Light strip", type: "light", status: "reported" },
    },
  },
});

function cloudLight(sku: string, deviceId: string): GoveeDevice {
  return {
    sku,
    deviceId,
    name: sku,
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    iotTopic: `GD/${deviceId}`,
    state: { online: false },
    channels: { lan: false, mqtt: true, cloud: true },
  };
}

/** The account client with its socket replaced: every publish is recorded, the broker counts as connected. */
function client(): { mqtt: GoveeMqttClient; published: Array<{ topic: string; msg: Record<string, unknown> }> } {
  const mqtt = new GoveeMqttClient("user@example.com", "secret", log, timers);
  const published: Array<{ topic: string; msg: Record<string, unknown> }> = [];
  (mqtt as unknown as { client: unknown }).client = {
    connected: true,
    publish: (topic: string, payload: string) =>
      published.push({ topic, msg: (JSON.parse(payload) as { msg: Record<string, unknown> }).msg }),
  };
  return { mqtt, published };
}

describe("GV-09 status request over the account broker with the quirk's version", () => {
  it("a device without LAN is asked over the account broker — the H6121 with the version of its quirk, the other model with version 2", () => {
    const { mqtt, published } = client();
    const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
    dm.setStatusRequester(brokerStatusRequester(() => mqtt));
    const devices = (dm as unknown as { devices: Map<string, GoveeDevice> }).devices;
    devices.set("H6121_A", cloudLight("H6121", "AA:BB:CC:DD:EE:FF:00:21"));
    devices.set("H6199_B", cloudLight("H6199", "AA:BB:CC:DD:EE:FF:00:99"));
    dm.requestStaleStatuses(Date.now());
    expect(published.map(p => [p.topic, p.msg.cmd, p.msg.cmdVersion])).toEqual([
      ["GD/AA:BB:CC:DD:EE:FF:00:21", "status", 1],
      ["GD/AA:BB:CC:DD:EE:FF:00:99", "status", 2],
    ]);
  });

  it("the device's answer counts, not the account list: a fresh status push stays online against a polled 'offline' (list or state read share one cap)", () => {
    const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
    const strip = cloudLight("H6199", "AA:BB:CC:DD:EE:FF:00:99");
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", strip);
    const listSaysOffline = [{ type: "devices.capabilities.online", instance: "online", state: { value: false } }];
    // positive control: without an answer of the device, the list's word stands
    dm.applyCloudStateOnline(strip, listSaysOffline);
    expect(resolveDeviceReachability(strip).online).toBe(false);
    // the status request's answer — the device's own voice, stamped now
    dm.handleMqttStatus({
      sku: "H6199",
      device: strip.deviceId,
      cmd: "status",
      transaction: `x_${Date.now()}001`,
      state: { onOff: 1 },
    });
    dm.applyCloudStateOnline(strip, listSaysOffline);
    expect(resolveDeviceReachability(strip).online).toBe(true);
  });
});
