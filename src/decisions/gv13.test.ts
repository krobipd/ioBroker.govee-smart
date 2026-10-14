// GV-13 — Where Govee delivers a device report, only that report confirms a command; elsewhere a clean send or Govee's
// "success" counts. A failure stays ack:false.
// krobi 2026-10-08 09:31: "in this concrete case a small exception to 'commands are always confirmed by the device'";
// 09:39: "gv13 fits like this"
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
import { onDeviceStateUpdate } from "../lib/handlers/device-events";
import { DeviceManager } from "../lib/device-manager";
import { cachedToGoveeDevice, goveeDeviceToCached } from "../lib/device-manager/cache";
import { DeviceIdRegistry } from "../lib/device-id";
import { StateManager } from "../lib/state-manager";
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

function device(extra: Partial<GoveeDevice>): GoveeDevice {
  return {
    sku: "H6172",
    deviceId: "AA:BB:CC:DD:EE:FF:00:13",
    name: "Desk",
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: true },
    ...extra,
  };
}

const LAN_LIGHT = (): GoveeDevice => device({ lanIp: "192.168.1.13", lastLanReplyAt: Date.now() });

const WORK_MODE = {
  type: "devices.capabilities.work_mode",
  instance: "workMode",
  parameters: {
    dataType: "STRUCT",
    fields: [
      { fieldName: "workMode", dataType: "ENUM", options: [{ name: "Manual", value: 1 }] },
      { fieldName: "modeValue", dataType: "ENUM", options: [{ name: "Manual", options: [{ value: 2 }] }] },
    ],
  },
};

const PURIFIER = (pushReports?: string[]): GoveeDevice =>
  device({
    sku: "H7127",
    pushReports,
    type: "devices.types.air_purifier",
    iotTopic: "GD/purifier",
    capabilities: [WORK_MODE as never],
    channels: { lan: false, mqtt: true, cloud: true },
  });

/**
 * Write one datapoint the way a user does; the router sends it and decides the ack.
 *
 * @param dev the device written to
 * @param suffix the datapoint below the device
 * @param val the value the user writes
 * @param opts the report channels and the send outcome
 * @param opts.lanListening whether the LAN listener is bound
 * @param opts.brokerConnected whether the account broker is connected
 * @param opts.failing whether the send fails
 * @param opts.native the datapoint's native (capability of a generic write)
 * @param opts.common extra common of the datapoint (a dropdown's states)
 */
async function write(
  dev: GoveeDevice,
  suffix: string,
  val: ioBroker.StateValue,
  opts: {
    lanListening?: boolean;
    brokerConnected?: boolean;
    failing?: boolean;
    native?: Record<string, string>;
    common?: Record<string, unknown>;
  } = {},
): Promise<{ acked: Map<string, unknown>; sent: number; writes: string[] }> {
  const acked = new Map<string, unknown>();
  const writes: string[] = [];
  let sent = 0;
  const send = (): Promise<unknown> => {
    sent++;
    return opts.failing ? Promise.reject(new Error("no answer")) : Promise.resolve(val);
  };
  const adapter = {
    log,
    namespace: "govee-smart.0",
    unloading: false,
    deviceManager: {
      getDevices: () => [dev],
      getDiagnostics: () => ({ addLog: () => {} }),
      sendCommand: send,
      sendCapabilityCommand: send,
      transportUsed: () => undefined,
    },
    stateManager: { devicePrefix: () => "devices.dev" },
    groupFanout: null,
    snapshotHandler: null,
    lanClient: {
      isListening: () => opts.lanListening ?? true,
      setMusicMode: () => {
        sent++;
      },
    },
    mqttClient: { connected: opts.brokerConnected ?? false },
    getStateAsync: () => Promise.resolve(null),
    getObjectAsync: () =>
      Promise.resolve(structuredClone({ common: { type: "mixed", ...opts.common }, native: opts.native ?? {} })),
    setState: (id: string, state: { val: unknown; ack?: boolean }) => {
      writes.push(id.replace("govee-smart.0.devices.dev.", ""));
      if (state.ack) {
        acked.set(id.replace("govee-smart.0.devices.dev.", ""), state.val);
      }
      return Promise.resolve();
    },
  };
  await onStateChange(adapter as never, `govee-smart.0.devices.dev.${suffix}`, { val, ack: false } as ioBroker.State);
  return { acked, sent, writes };
}

describe("GV-13 a device report confirms where there is one; elsewhere the clean send", () => {
  it("a LAN light's power, brightness, colour and colour temperature are left to its devStatus report", async () => {
    for (const [suffix, val] of [
      ["control.power", true],
      ["control.brightness", 40],
      ["control.color_rgb", "#ff0000"],
      ["control.color_temperature", 4000],
    ] as const) {
      const { acked, sent } = await write(LAN_LIGHT(), suffix, val);
      expect(sent, suffix).toBe(1);
      expect(acked.has(suffix), suffix).toBe(false);
    }
  });

  it("only the status answer confirms: it writes the value it carries with ack — the value sent stays unconfirmed when the light reports another", async () => {
    const written: Array<{ id: string; ack?: boolean; val: unknown }> = [];
    const record = (id: string, state: { val: unknown; ack?: boolean }): Promise<void> => {
      written.push({ id: id.replace("govee-smart.0.", ""), ...state });
      return Promise.resolve();
    };
    const timers = {
      setInterval: () => undefined,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
      setTimeout: () => undefined,
      delay: () => Promise.resolve(),
    } as never;
    const registry = new DeviceRegistry({ data: { devices: {} } });
    const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
    const light = LAN_LIGHT();
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", light);
    const host = {
      log,
      namespace: "govee-smart.0",
      config: {},
      statesReady: true,
      deviceManager: dm,
      cloudClient: null,
      cloudWasConnected: false,
      cloudOutage: { confirmed: false },
      mqttClient: null,
      openapiMqttClient: null,
      lanClient: { isListening: () => true },
      lastConnectionState: null,
      groupReachabilityPrimed: true,
      setState: record,
      setStateChangedAsync: record,
      getObjectViewAsync: () => Promise.resolve({ rows: [] }),
    };
    (host as { stateManager?: StateManager }).stateManager = new StateManager(host as never, registry);
    dm.setCallbacks({
      onUpdate: (dev, state, changes) => onDeviceStateUpdate(host as never, dev, state, changes),
      onLanDeviceReady: () => {},
      onCloudDataReady: () => {},
      onGroupMembersReady: () => {},
    });
    const power = (): Array<{ val: unknown; ack?: boolean }> =>
      written.filter(w => w.id === "devices.h6172-0013.control.power").map(({ val, ack }) => ({ val, ack }));
    // the user switched it on; the light answers that it is still off — its own value, confirmed
    dm.handleLanStatus("192.168.1.13", { onOff: 0, brightness: 40, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(power()).toEqual([{ val: false, ack: true }]);
    // the answer that carries the value sent confirms it
    dm.handleLanStatus("192.168.1.13", { onOff: 1, brightness: 40, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(power().at(-1)).toEqual({ val: true, ack: true });
  });

  it("over LAN a scene, a cloud snapshot, a segment and the music mode have no report — the clean send confirms each", async () => {
    const dropdown = { states: { 0: "---", 1: "Aurora" } };
    const scene = await write(LAN_LIGHT(), "scenes.light_scene", "1", { common: dropdown });
    expect(scene.sent).toBe(1);
    expect(scene.acked.get("scenes.light_scene")).toBe("1");
    const snapshot = await write(LAN_LIGHT(), "snapshots.snapshot_cloud", "1", { common: dropdown });
    expect(snapshot.sent).toBe(1);
    expect(snapshot.acked.get("snapshots.snapshot_cloud")).toBe("1");
    const segment = await write(LAN_LIGHT(), "segments.0.color", "#00ff00");
    expect(segment.sent).toBe(1);
    expect(segment.acked.get("segments.0.color")).toBe("#00ff00");
    const music = await write(
      device({
        lanIp: "192.168.1.13",
        lastLanReplyAt: Date.now(),
        capabilities: [
          {
            type: "devices.capabilities.music_setting",
            instance: "musicMode",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "musicMode", dataType: "ENUM", options: [{ name: "Energic", value: 5 }] }],
            },
          } as never,
        ],
      }),
      "music.music_mode",
      "1",
    );
    expect(music.sent).toBe(1);
    expect(music.acked.get("music.music_mode")).toBe("1");
  });

  it("a failed command asks the device once — its answer corrects the datapoint", async () => {
    const asked: string[] = [];
    const patches: Array<Record<string, unknown>> = [];
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
    const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
    const strip = device({
      sku: "H6199",
      iotTopic: "GD/strip",
      channels: { lan: false, mqtt: true, cloud: false },
      state: { online: true, devicePushAt: Date.now() },
    });
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", strip);
    dm.setStatusRequester(d => {
      asked.push(d.sku);
      return true;
    });
    dm.setCallbacks({
      onUpdate: (_dev, state) => patches.push(state),
      onLanDeviceReady: () => {},
      onCloudDataReady: () => {},
      onGroupMembersReady: () => {},
    });
    // positive control: a fresh push needs no question
    dm.requestStaleStatuses(Date.now());
    expect(asked).toEqual([]);
    await expect(dm.sendCommand(strip, "power", true)).rejects.toThrow();
    dm.requestStaleStatuses(Date.now() + 1);
    dm.requestStaleStatuses(Date.now() + 2);
    expect(asked).toEqual(["H6199"]);
    dm.handleMqttStatus({ sku: "H6199", device: strip.deviceId, cmd: "status", state: { onOff: 0 } });
    expect(patches.at(-1)).toMatchObject({ power: false });
    expect(strip.unconfirmedSince).toBeUndefined();
  });

  it("a LAN light whose listener is down has no report — the clean send confirms", async () => {
    const { acked } = await write(LAN_LIGHT(), "control.power", true, { lanListening: false });
    expect(acked.get("control.power")).toBe(true);
  });

  it("a datapoint the LAN light does not report (gradient) is confirmed by the clean send", async () => {
    const { acked } = await write(LAN_LIGHT(), "control.gradient_toggle", true);
    expect(acked.get("control.gradient_toggle")).toBe(true);
  });

  it("a field this device's push has carried waits for the push over a connected broker; an unlearned field is confirmed by the send", async () => {
    const learned = await write(PURIFIER(["control.work_mode"]), "control.work_mode", "1", { brokerConnected: true });
    expect(learned.sent).toBe(1);
    expect(learned.acked.has("control.work_mode")).toBe(false);
    const unlearned = await write(PURIFIER(["control.power"]), "control.work_mode", "1", { brokerConnected: true });
    expect(unlearned.acked.has("control.work_mode")).toBe(true);
    const brokerDown = await write(PURIFIER(["control.work_mode"]), "control.work_mode", "1", {
      brokerConnected: false,
    });
    expect(brokerDown.acked.has("control.work_mode")).toBe(true);
  });

  it("the device's own push teaches which fields it carries, per device and field, and the cache keeps them across a restart", () => {
    const timers = {
      setInterval: () => undefined,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
      setTimeout: () => undefined,
      delay: () => Promise.resolve(),
    } as never;
    const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
    const cloudLight = device({ sku: "H6199", channels: { lan: false, mqtt: true, cloud: true } });
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", cloudLight);
    dm.handleMqttStatus({ sku: "H6199", device: cloudLight.deviceId, cmd: "status", state: { onOff: 1 } });
    expect(cloudLight.pushReports).toEqual(["control.power"]);
    expect(cachedToGoveeDevice(goveeDeviceToCached(cloudLight)).pushReports).toEqual(["control.power"]);
  });

  it("the device-sync button is confirmed only after a sync that ran — without the Cloud nothing ran, it stays unconfirmed", async () => {
    const acked: string[] = [];
    const adapter = {
      log,
      namespace: "govee-smart.0",
      unloading: false,
      cloudClient: null,
      deviceManager: { getDevices: () => [] },
      stateManager: { devicePrefix: () => "devices.dev" },
      setState: (id: string, state: { ack?: boolean }) => {
        if (state.ack) {
          acked.push(id);
        }
        return Promise.resolve();
      },
    };
    await onStateChange(adapter as never, "govee-smart.0.info.manualSyncDevices", {
      val: true,
      ack: false,
    } as ioBroker.State);
    expect(acked).toEqual([]);
    await onStateChange(adapter as never, "govee-smart.0.info.manualSyncDevices", {
      val: false,
      ack: false,
    } as ioBroker.State);
    expect(acked).toEqual(["govee-smart.0.info.manualSyncDevices"]);
  });

  it("a failed send stays ack:false, also where the send would have confirmed", async () => {
    const { acked, sent, writes } = await write(LAN_LIGHT(), "control.gradient_toggle", true, { failing: true });
    expect(sent).toBe(1);
    expect(acked.size).toBe(0);
    // nor is the old value written back blindly — nothing is written at all
    expect(writes).toEqual([]);
    // positive control: the same write that goes out is written (and confirmed)
    expect((await write(LAN_LIGHT(), "control.gradient_toggle", true)).writes).toEqual(["control.gradient_toggle"]);
  });
});
