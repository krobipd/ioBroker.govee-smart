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
 */
async function write(
  dev: GoveeDevice,
  suffix: string,
  val: ioBroker.StateValue,
  opts: { lanListening?: boolean; brokerConnected?: boolean; failing?: boolean; native?: Record<string, string> } = {},
): Promise<{ acked: Map<string, unknown>; sent: number }> {
  const acked = new Map<string, unknown>();
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
    },
    stateManager: { devicePrefix: () => "devices.dev" },
    groupFanout: null,
    snapshotHandler: null,
    lanClient: { isListening: () => opts.lanListening ?? true },
    mqttClient: { connected: opts.brokerConnected ?? false },
    getStateAsync: () => Promise.resolve(null),
    getObjectAsync: () => Promise.resolve(structuredClone({ common: { type: "mixed" }, native: opts.native ?? {} })),
    setState: (id: string, state: { val: unknown; ack?: boolean }) => {
      if (state.ack) {
        acked.set(id.replace("govee-smart.0.devices.dev.", ""), state.val);
      }
      return Promise.resolve();
    },
  };
  await onStateChange(adapter as never, `govee-smart.0.devices.dev.${suffix}`, { val, ack: false } as ioBroker.State);
  return { acked, sent };
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

  it("the report itself writes the device's value with ack", async () => {
    const written: Array<{ id: string; ack?: boolean; val: unknown }> = [];
    const sm = new StateManager(
      {
        namespace: "govee-smart.0",
        log,
        setStateChangedAsync: (id: string, state: { val: unknown; ack?: boolean }) => {
          written.push({ id, ...state });
          return Promise.resolve();
        },
      } as never,
      new DeviceRegistry({ data: { devices: {} } }),
    );
    const dev = LAN_LIGHT();
    await sm.updateDeviceState(dev, { power: true, brightness: 40 });
    const power = written.find(w => w.id.endsWith(".control.power"));
    expect(power).toMatchObject({ val: true, ack: true });
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
    const { acked, sent } = await write(LAN_LIGHT(), "control.gradient_toggle", true, { failing: true });
    expect(sent).toBe(1);
    expect(acked.size).toBe(0);
  });
});
