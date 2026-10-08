// GV-13 (groups) — Where Govee delivers a device report, only that report confirms; elsewhere a clean send or Govee's
// "success" counts, and a failure stays ack:false. An app group has no report of its own: it is confirmed only when every
// member that has to take the command took it without an error. For a music mode only the members that have music count.
// krobi 2026-10-08 09:39: "gv13 fits like this"; 10:08 on the group music: "I would say yes. otherwise in that concrete
// example it could never confirm, which would be just as wrong. so yes, confirm"
import { describe, expect, it, vi } from "vitest";

// the router pulls capability-mapper → i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a
// js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { GroupFanoutHandler } from "../lib/group-fanout";
import { onStateChange } from "../lib/handlers/state-change-router";
import { stateToCommand } from "../lib/handlers/dropdown-reset-helpers";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

function member(deviceId: string, extra: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6199",
    deviceId,
    name: deviceId,
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
    channels: { lan: false, mqtt: false, cloud: true },
    ...extra,
  };
}

const MUSIC = {
  type: "devices.capabilities.music_setting",
  instance: "musicMode",
  parameters: {
    dataType: "STRUCT",
    fields: [{ fieldName: "musicMode", dataType: "ENUM", options: [{ name: "Spectrum", value: 3 }] }],
  },
};

interface Bench {
  write: (suffix: string, val: ioBroker.StateValue) => Promise<void>;
  acked: Map<string, unknown>;
  sent: string[];
}

function bench(members: GoveeDevice[], opts: { failing?: string[]; groupMusic?: Record<string, string> } = {}): Bench {
  const group = member("1234567", {
    sku: "BaseGroup",
    groupMembers: members.map(m => ({ sku: m.sku, deviceId: m.deviceId })),
  });
  const devices = [group, ...members];
  const prefixOf = (d: GoveeDevice): string => (d === group ? "groups.basegroup-4567" : `devices.${d.deviceId}`);
  const acked = new Map<string, unknown>();
  const sent: string[] = [];
  const failing = new Set(opts.failing ?? []);
  const fanout = new GroupFanoutHandler({
    log,
    namespace: "govee-smart.0",
    getDevices: () => devices,
    sendCommand: d => {
      sent.push(d.deviceId);
      return failing.has(d.deviceId) ? Promise.reject(new Error("no answer")) : Promise.resolve();
    },
    devicePrefix: prefixOf,
    stateToCommand: s => stateToCommand(s) ?? undefined,
    getObject: id =>
      Promise.resolve(
        id.endsWith(".music.music_mode")
          ? ({ common: { states: structuredClone(opts.groupMusic ?? {}) } } as unknown as ioBroker.Object)
          : null,
      ),
    sendMusicCommand: d => {
      sent.push(d.deviceId);
      return Promise.resolve(!failing.has(d.deviceId));
    },
  });
  const adapter = {
    log,
    namespace: "govee-smart.0",
    unloading: false,
    deviceManager: { getDevices: () => devices, getDiagnostics: () => ({ addLog: () => {} }) },
    stateManager: { devicePrefix: prefixOf },
    groupFanout: fanout,
    snapshotHandler: null,
    lanClient: null,
    getStateAsync: () => Promise.resolve(null),
    getObjectAsync: (id: string) =>
      Promise.resolve(
        id.endsWith(".music.music_mode")
          ? { common: { type: "mixed", states: structuredClone(opts.groupMusic ?? {}) } }
          : { common: { type: "boolean" } },
      ),
    setState: (id: string, state: { val: unknown; ack?: boolean }) => {
      if (state.ack) {
        acked.set(id.replace("govee-smart.0.", ""), state.val);
      }
      return Promise.resolve();
    },
  };
  return {
    write: (suffix, val) =>
      onStateChange(adapter as never, `govee-smart.0.groups.basegroup-4567.${suffix}`, {
        val,
        ack: false,
      } as ioBroker.State),
    acked,
    sent,
  };
}

describe("GV-13 a group is confirmed only when every member took the command", () => {
  it("every member took it — the group datapoint is confirmed (positive control)", async () => {
    const b = bench([member("A"), member("B")]);
    await b.write("control.power", true);
    expect(b.sent).toEqual(["A", "B"]);
    expect(b.acked.get("groups.basegroup-4567.control.power")).toBe(true);
  });

  it("a member that failed leaves the group unconfirmed", async () => {
    const b = bench([member("A"), member("B")], { failing: ["B"] });
    await b.write("control.power", true);
    expect(b.sent).toEqual(["A", "B"]);
    expect(b.acked.has("groups.basegroup-4567.control.power")).toBe(false);
  });

  it("a LAN member without power (no fresh answer) gets nothing — and the group stays unconfirmed", async () => {
    const unplugged = member("L", {
      lanIp: "192.168.1.40",
      state: { online: false },
      channels: { lan: true, mqtt: false, cloud: true },
    });
    const b = bench([member("A"), unplugged]);
    await b.write("control.power", true);
    expect(b.sent).toEqual(["A"]);
    expect(b.acked.has("groups.basegroup-4567.control.power")).toBe(false);
  });

  it("a music mode is confirmed when every member WITH music took it — a member without music does not count", async () => {
    const b = bench([member("M", { capabilities: [MUSIC as never] }), member("P")], {
      groupMusic: { 0: "---", 1: "Spectrum" },
    });
    await b.write("music.music_mode", "1");
    expect(b.acked.get("groups.basegroup-4567.music.music_mode")).toBe("1");
  });

  it("a member with music that took nothing leaves the music mode unconfirmed", async () => {
    const b = bench(
      [member("M", { capabilities: [MUSIC as never] }), member("N", { capabilities: [MUSIC as never] })],
      {
        failing: ["N"],
        groupMusic: { 0: "---", 1: "Spectrum" },
      },
    );
    await b.write("music.music_mode", "1");
    expect(b.acked.has("groups.basegroup-4567.music.music_mode")).toBe(false);
  });
});
