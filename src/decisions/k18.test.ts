// K18 — Commands may go over the account broker: LAN first, then the broker, then the Cloud, only with a Govee account. A
// catalog quirk switches the broker off per model; only the device's own report confirms what went over it.
// krobi 2026-10-08 10:02: "k18 sure, as a possible option it is always good"
import { describe, expect, it, vi } from "vitest";

// device-manager pulls capability-mapper → i18n → @iobroker/adapter-core, whose import-time controller lookup exits
// outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { onStateChange } from "../lib/handlers/state-change-router";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import { GroupFanoutHandler } from "../lib/group-fanout";
import { buildGroupFanoutHost } from "../lib/handlers/group-fanout-handler";
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

const TOPIC = "GD/0123456789abcdef0123456789abcd18";

function light(sku: string, extra: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku,
    deviceId: "AA:BB:CC:DD:EE:FF:00:18",
    name: "Strip",
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
    channels: { lan: false, mqtt: true, cloud: true },
    iotTopic: TOPIC,
    ...extra,
  };
}

/**
 * Switch one light on the way a user does, through the real device manager and command router.
 *
 * @param dev the light
 * @param lan whether the LAN client is there
 */
async function switchOn(
  dev: GoveeDevice,
  lan = false,
): Promise<{ published: string[]; cloud: string[]; lanSent: string[]; acked: Map<string, unknown> }> {
  const published: string[] = [];
  const cloud: string[] = [];
  const lanSent: string[] = [];
  const acked = new Map<string, unknown>();
  const catalog = {
    devices: {
      H9K01: { name: "Strip", type: "light", status: "reported" },
      H9K02: { name: "Strip", type: "light", status: "reported", quirks: { brokenBrokerCommands: true } },
    },
  } as const;
  const dm = new DeviceManager(
    log,
    timers,
    new DeviceRegistry({ data: structuredClone(catalog) }),
    new DeviceIdRegistry(),
  );
  (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", dev);
  // Optional call: a build without the broker route has no such method — the guard must then fail on its assertions.
  (dm as unknown as { setBrokerClient?: (client: unknown) => void }).setBrokerClient?.({
    connected: true,
    publishCommand: (topic: string, cmd: string) => {
      published.push(`${topic} ${cmd}`);
      return true;
    },
  });
  dm.setCloudClient({
    controlDevice: (_sku: string, _id: string, _type: string, instance: string) => {
      cloud.push(instance);
      return Promise.resolve();
    },
  } as never);
  const lanClient = {
    isListening: () => true,
    setPower: (ip: string) => {
      lanSent.push(ip);
    },
    requestStatus: () => {},
  };
  if (lan) {
    dm.setLanClient(lanClient as never);
  }
  const adapter = {
    log,
    namespace: "govee-smart.0",
    unloading: false,
    deviceManager: dm,
    stateManager: { devicePrefix: () => "devices.dev" },
    groupFanout: null,
    snapshotHandler: null,
    lanClient: lan ? lanClient : null,
    mqttClient: { connected: true },
    getStateAsync: () => Promise.resolve(null),
    getObjectAsync: () => Promise.resolve(structuredClone({ common: { type: "boolean" }, native: {} })),
    setState: (id: string, state: { val: unknown; ack?: boolean }) => {
      if (state.ack) {
        acked.set(id.replace("govee-smart.0.devices.dev.", ""), state.val);
      }
      return Promise.resolve();
    },
  };
  await onStateChange(adapter as never, "govee-smart.0.devices.dev.control.power", {
    val: true,
    ack: false,
  } as ioBroker.State);
  return { published, cloud, lanSent, acked };
}

describe("K18 commands over the account broker", () => {
  it("a light without LAN switches over the broker, not the Cloud — and the publish alone confirms nothing", async () => {
    const r = await switchOn(light("H9K01"));
    expect(r.published).toEqual([`${TOPIC} turn`]);
    expect(r.cloud).toEqual([]);
    expect(r.acked.has("control.power")).toBe(false);
  });

  it("a model the catalog switches off goes over the Cloud, whose success confirms it", async () => {
    const r = await switchOn(light("H9K02"));
    expect(r.published).toEqual([]);
    expect(r.cloud).toEqual(["powerSwitch"]);
    expect(r.acked.get("control.power")).toBe(true);
  });

  it("an app group whose member switched over the broker stays unconfirmed until that member reports", async () => {
    const published: string[] = [];
    const member = light("H9K01");
    const group = {
      ...light("BaseGroup", { deviceId: "1318", type: "BaseGroup", iotTopic: undefined }),
      groupMembers: [{ sku: member.sku, deviceId: member.deviceId }],
    };
    const dm = new DeviceManager(
      log,
      timers,
      new DeviceRegistry({ data: { devices: { H9K01: { name: "Strip", type: "light", status: "reported" } } } }),
      new DeviceIdRegistry(),
    );
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("m", member);
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("g", group);
    (dm as unknown as { setBrokerClient?: (client: unknown) => void }).setBrokerClient?.({
      connected: true,
      publishCommand: (topic: string, cmd: string) => {
        published.push(`${topic} ${cmd}`);
        return true;
      },
    });
    dm.setCloudClient({ controlDevice: () => Promise.resolve() } as never);
    const handler = new GroupFanoutHandler(
      buildGroupFanoutHost({
        log,
        namespace: "govee-smart.0",
        deviceManager: dm,
        stateManager: { devicePrefix: () => "devices.dev" },
        getObjectAsync: () => Promise.resolve(null),
      } as never),
    );
    const confirmed = await handler.fanOut(group, "control.power", true);
    expect(published).toEqual([`${TOPIC} turn`]);
    expect(confirmed).toBe(false);
  });

  it("a light with LAN takes the LAN and never the broker (positive control: LAN first)", async () => {
    const r = await switchOn(light("H9K01", { lanIp: "192.168.1.18", lastLanReplyAt: Date.now() }), true);
    expect(r.lanSent).toEqual(["192.168.1.18"]);
    expect(r.published).toEqual([]);
    expect(r.cloud).toEqual([]);
  });
});
