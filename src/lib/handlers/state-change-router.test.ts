import { vi } from "vitest";

// state-change-router pulls device-manager → capability-mapper → i18n →
// @iobroker/adapter-core, whose import-time controller lookup process.exits
// outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import {
  findDeviceForState,
  handleManualSegmentsChange,
  onStateChange,
  resolveDropdownInput,
  sendMusicCommand,
  type StateChangeRouterAdapter,
} from "./state-change-router";
import type { GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../test-helpers";
import { GOVEE_CAP_TYPE } from "../govee-constants";

const NS = "govee-smart.0";

interface Rig {
  adapter: StateChangeRouterAdapter;
  warns: string[];
  commands: Array<{ device: string; command: string; value: unknown }>;
  capCommands: Array<{ device: string; type: string; instance: string; value: unknown }>;
  acks: Array<{ id: string; val: unknown }>;
  fanOuts: Array<{ suffix: string; value: unknown }>;
  snapshotCalls: string[];
  refreshCalls: string[];
  loadCloudStatesCalls: number[];
  manualApplied: Array<{ mode: boolean; indices?: number[] }>;
  persisted: GoveeDevice[];
  lanMusic: Array<{ ip: string; mode: number; includeRgb: boolean; r: number; g: number; b: number }>;
  objects: Map<string, unknown>;
  states: Map<string, ioBroker.StateValue>;
  syncCalls: number[];
  setSendFailure(fn: () => Error | null): void;
  setFanOutResult(v: boolean): void;
}

function makeRig(devices: GoveeDevice[], opts: { refreshChanged?: boolean } = {}): Rig {
  const warns: string[] = [];
  const commands: Array<{ device: string; command: string; value: unknown }> = [];
  const capCommands: Array<{ device: string; type: string; instance: string; value: unknown }> = [];
  const acks: Array<{ id: string; val: unknown }> = [];
  const fanOuts: Array<{ suffix: string; value: unknown }> = [];
  const snapshotCalls: string[] = [];
  const refreshCalls: string[] = [];
  const loadCloudStatesCalls: number[] = [];
  const manualApplied: Array<{ mode: boolean; indices?: number[] }> = [];
  const persisted: GoveeDevice[] = [];
  const lanMusic: Array<{ ip: string; mode: number; includeRgb: boolean; r: number; g: number; b: number }> = [];
  const syncCalls: number[] = [];
  const objects = new Map<string, unknown>();
  const states = new Map<string, ioBroker.StateValue>();
  /** meta.user file store — the diagnostics export writes its report here. */
  const files = new Map<string, string>();
  let sendFailure: () => Error | null = () => null;
  let fanOutResult = true; // group fan-out reached a member (ack-worthy) by default

  const adapter: StateChangeRouterAdapter = {
    log: {
      ...mockLog,
      warn: (m: string) => warns.push(m),
    },
    namespace: NS,
    version: "9.9.9",
    writeFileAsync: (meta: string, name: string, data: Buffer | string) => {
      files.set(`${meta}/${name}`, String(data));
      return Promise.resolve();
    },
    readDirAsync: (meta: string) =>
      Promise.resolve(
        [...files.keys()]
          .filter(k => k.startsWith(`${meta}/`))
          .map(k => ({ file: k.slice(meta.length + 1), isDir: false })),
      ),
    delFileAsync: (meta: string, name: string) => {
      files.delete(`${meta}/${name}`);
      return Promise.resolve();
    },
    unloading: false,
    deviceManager: {
      getDevices: () => devices,
      getDiagnostics: () => ({ addLog: () => undefined }),
      sendCommand: (device: GoveeDevice, command: string, value: unknown) => {
        const err = sendFailure();
        if (err) {
          return Promise.reject(err);
        }
        commands.push({ device: device.deviceId, command, value });
        return Promise.resolve();
      },
      sendCapabilityCommand: (device: GoveeDevice, type: string, instance: string, value: unknown) => {
        capCommands.push({ device: device.deviceId, type, instance, value });
        return Promise.resolve();
      },
      refreshSceneDataForDevice: (deviceId: string) => {
        refreshCalls.push(deviceId);
        return Promise.resolve(opts.refreshChanged ?? false);
      },
      persistDeviceToCache: (device: GoveeDevice) => {
        persisted.push(device);
      },
      generateDiagnostics: (d: GoveeDevice) => ({ adapter: "iobroker.govee-smart", sku: d.sku }),
    } as never,
    stateManager: {
      devicePrefix: (d: GoveeDevice) =>
        d.sku === "BaseGroup" ? `groups.basegroup_${d.deviceId}` : `devices.${d.sku.toLowerCase()}_0011`,
    } as never,
    snapshotHandler: {
      save: (_d: GoveeDevice, name: string) => Promise.resolve(snapshotCalls.push(`save:${name}`)),
      restore: (_d: GoveeDevice, val: unknown) => Promise.resolve(snapshotCalls.push(`restore:${String(val)}`)),
      delete: (_d: GoveeDevice, name: string) => Promise.resolve(snapshotCalls.push(`delete:${name}`)),
    } as never,
    groupFanout: {
      fanOut: (_g: GoveeDevice, suffix: string, value: unknown): Promise<boolean> => {
        fanOuts.push({ suffix, value });
        return Promise.resolve(fanOutResult);
      },
    } as never,
    lanClient: {
      setMusicMode: (ip: string, mode: number, includeRgb: boolean, r: number, g: number, b: number) =>
        lanMusic.push({ ip, mode, includeRgb, r, g, b }),
    } as never,
    diagnosticsLastRun: new Map<string, number>(),
    getStateAsync: id =>
      Promise.resolve(states.has(id) ? ({ val: states.get(id), ack: true } as ioBroker.State) : null),
    setState: (id, state) => {
      acks.push({ id, val: (state as { val: unknown }).val });
      return Promise.resolve();
    },
    getObjectAsync: id => Promise.resolve(objects.get(id) ?? null),
    loadCloudStates: () => {
      loadCloudStatesCalls.push(1);
      return Promise.resolve();
    },
    applyManualSegments: (_device, mode, indices) => {
      manualApplied.push({ mode, indices });
      return Promise.resolve();
    },
    syncDevicesManually: () => {
      syncCalls.push(1);
      return Promise.resolve();
    },
  };
  return {
    adapter,
    warns,
    commands,
    capCommands,
    acks,
    fanOuts,
    snapshotCalls,
    refreshCalls,
    loadCloudStatesCalls,
    manualApplied,
    persisted,
    lanMusic,
    objects,
    states,
    syncCalls,
    setSendFailure: fn => {
      sendFailure = fn;
    },
    setFanOutResult: v => {
      fanOutResult = v;
    },
  };
}

function write(rig: Rig, fullId: string, val: ioBroker.StateValue): Promise<void> {
  return onStateChange(rig.adapter, fullId, { val, ack: false } as ioBroker.State);
}

const device = createTestDevice(); // sku H6160 → prefix devices.h6160_0011
const PREFIX = `devices.h6160_0011`;
const id = (suffix: string): string => `${NS}.${PREFIX}.${suffix}`;

// A music_setting capability advertising the given per-mode device values in
// order. The dropdown is index-based (0 = "---" sentinel), so state index N
// maps to values[N-1] — the value actually sent to the device.
function musicSettingCap(values: number[]): GoveeDevice["capabilities"][number] {
  return {
    type: GOVEE_CAP_TYPE.MUSIC_SETTING,
    instance: "musicMode",
    parameters: {
      dataType: "STRUCT",
      fields: [
        { fieldName: "musicMode", options: values.map((v, i) => ({ name: `Mode${i}`, value: v })) },
        { fieldName: "sensitivity", range: { min: 0, max: 100, precision: 1 } },
        { fieldName: "autoColor" },
      ],
    },
  };
}

// Test device that also advertises music modes (the default light caps lack them).
function musicDevice(values: number[], overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  const base = createTestDevice(overrides);
  return { ...base, capabilities: [...base.capabilities, musicSettingCap(values)] };
}

// Music device with NAMED modes (Spectrum/Rolling/Energic/…) so the name-based
// RGB gate (A2) can be exercised independently of the numeric mode value.
function musicDeviceNamed(modes: { name: string; value: number }[], overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  const base = createTestDevice(overrides);
  const cap = {
    type: GOVEE_CAP_TYPE.MUSIC_SETTING,
    instance: "musicMode",
    parameters: {
      dataType: "STRUCT",
      fields: [
        { fieldName: "musicMode", options: modes },
        { fieldName: "sensitivity", range: { min: 0, max: 100, precision: 1 } },
        { fieldName: "autoColor" },
      ],
    },
  } as GoveeDevice["capabilities"][number];
  return { ...base, capabilities: [...base.capabilities, cap] };
}

describe("findDeviceForState", () => {
  it("resolves a state path to its owning device via prefix match", () => {
    const rig = makeRig([device]);
    expect(findDeviceForState(rig.adapter, `${PREFIX}.control.power`)).toBe(device);
  });

  it("returns undefined for foreign paths and while managers are missing", () => {
    const rig = makeRig([device]);
    expect(findDeviceForState(rig.adapter, "devices.other_9999.control.power")).toBeUndefined();
    (rig.adapter as { deviceManager: unknown }).deviceManager = null;
    expect(findDeviceForState(rig.adapter, `${PREFIX}.control.power`)).toBeUndefined();
  });
});

describe("resolveDropdownInput (number-OR-name dual input, Pattern 45)", () => {
  function withStates(rig: Rig, stateId: string, map: Record<string, string>): void {
    rig.objects.set(stateId, { common: { states: map } });
  }

  it("resolves numeric, numeric-string and case-insensitive label input to the SAME canonical key", async () => {
    const rig = makeRig([device]);
    withStates(rig, id("scenes.light_scene"), { 0: "---", 1: "Aurora", 2: "Movie" });
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), 1)).toEqual({ val: "1", ok: true });
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), "2")).toEqual({ val: "2", ok: true });
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), "aurora")).toEqual({
      val: "1",
      ok: true,
    });
  });

  it("passes reset sentinels (0/'0'/'') through without an object lookup", async () => {
    const rig = makeRig([device]);
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), 0)).toEqual({ val: 0, ok: true });
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), "")).toEqual({ val: "", ok: true });
  });

  it("passes non-dropdown states through unchanged (no common.states)", async () => {
    const rig = makeRig([device]);
    expect(await resolveDropdownInput(rig.adapter, id("control.brightness"), 50)).toEqual({ val: 50, ok: true });
  });

  it("flags unknown dropdown input as ok=false so the caller can warn and skip", async () => {
    const rig = makeRig([device]);
    withStates(rig, id("scenes.light_scene"), { 0: "---", 1: "Aurora" });
    expect(await resolveDropdownInput(rig.adapter, id("scenes.light_scene"), "Nonexistent")).toEqual({
      val: "Nonexistent",
      ok: false,
    });
  });
});

describe("onStateChange — early gates", () => {
  it("ignores ack=true echoes (our own writes must not loop back into commands)", async () => {
    const rig = makeRig([device]);
    await onStateChange(rig.adapter, id("control.power"), { val: true, ack: true } as ioBroker.State);
    expect(rig.commands).toHaveLength(0);
  });

  it("ignores writes while the adapter is unloading", async () => {
    const rig = makeRig([device]);
    (rig.adapter as { unloading: boolean }).unloading = true;
    await write(rig, id("control.power"), true);
    expect(rig.commands).toHaveLength(0);
  });

  it("ignores paths outside devices.*/groups.* and unknown devices", async () => {
    const rig = makeRig([device]);
    await write(rig, `${NS}.info.connection`, true);
    await write(rig, `${NS}.devices.unknown_9999.control.power`, true);
    expect(rig.commands).toHaveLength(0);
  });

  it("warns and drops a write with an unknown dropdown value (never sends a garbage command)", async () => {
    const rig = makeRig([device]);
    rig.objects.set(id("scenes.light_scene"), { common: { states: { 0: "---", 1: "Aurora" } } });
    await write(rig, id("scenes.light_scene"), "DoesNotExist");
    expect(rig.warns.some(w => w.includes("Unknown dropdown value"))).toBe(true);
    expect(rig.commands).toHaveLength(0);
  });
});

describe("onStateChange — command dispatch + ack ownership", () => {
  it("sends the command, then acks with the resolved value", async () => {
    const rig = makeRig([device]);
    await write(rig, id("control.power"), true);
    expect(rig.commands).toEqual([{ device: device.deviceId, command: "power", value: true }]);
    expect(rig.acks).toContainEqual({ id: id("control.power"), val: true });
  });

  it("does NOT ack when the command send throws — a failed command must not look applied", async () => {
    const rig = makeRig([device]);
    rig.setSendFailure(() => new Error("LAN unreachable"));
    await write(rig, id("control.power"), true);
    expect(rig.acks).toHaveLength(0);
    expect(rig.warns.some(w => w.includes("Command failed"))).toBe(true);
  });

  it("power-off resets ALL mode dropdowns (off device has no active mode)", async () => {
    const rig = makeRig([device]);
    rig.states.set(id("scenes.light_scene"), "2");
    await write(rig, id("control.power"), false);
    expect(rig.acks).toContainEqual({ id: id("scenes.light_scene"), val: "0" });
  });

  it("a dropdown reset to '0' acks WITHOUT sending a command", async () => {
    const rig = makeRig([device]);
    await write(rig, id("scenes.light_scene"), "0");
    expect(rig.commands).toHaveLength(0);
    expect(rig.acks).toContainEqual({ id: id("scenes.light_scene"), val: "0" });
  });

  it("sceneSpeed is stored on the device + persisted to cache (applies on next activation, no command)", async () => {
    // Own device instance: the shared `device` fixture must not carry a
    // sceneSpeed into the tests that run after this one.
    const own = createTestDevice();
    const rig = makeRig([own]);
    await write(rig, id("scenes.scene_speed"), 3);
    expect(own.sceneSpeed).toBe(3);
    expect(rig.persisted).toContain(own);
    expect(rig.commands).toHaveLength(0);
    expect(device.sceneSpeed).toBeUndefined();
  });
});

describe("onStateChange — group fan-out", () => {
  it("routes BaseGroup writes through the fan-out handler and acks the group state", async () => {
    const group = createTestDevice({
      sku: "BaseGroup",
      deviceId: "1311",
      groupMembers: [{ sku: device.sku, deviceId: device.deviceId }],
    });
    const rig = makeRig([group, device]);
    const groupId = `${NS}.groups.basegroup_1311.control.power`;
    await write(rig, groupId, true);
    expect(rig.fanOuts).toEqual([{ suffix: "control.power", value: true }]);
    expect(rig.acks).toContainEqual({ id: groupId, val: true });
    expect(rig.commands).toHaveLength(0); // fan-out owns member dispatch
  });

  it("does NOT ack a group command when the fan-out reached no member (L3/A6)", async () => {
    const group = createTestDevice({
      sku: "BaseGroup",
      deviceId: "1311",
      groupMembers: [{ sku: device.sku, deviceId: device.deviceId }],
    });
    const rig = makeRig([group, device]);
    rig.setFanOutResult(false); // no reachable member / every member send failed
    const groupId = `${NS}.groups.basegroup_1311.control.power`;
    await write(rig, groupId, true);
    expect(rig.fanOuts).toHaveLength(1); // fan-out was attempted
    expect(rig.acks.find(a => a.id === groupId)).toBeUndefined(); // but NOT falsely acked
  });
});

describe("onStateChange — local snapshots", () => {
  it("snapshot_save: trims the name, saves, and clears the text field", async () => {
    const rig = makeRig([device]);
    await write(rig, id("snapshots.snapshot_save"), "  Abend  ");
    expect(rig.snapshotCalls).toEqual(["save:Abend"]);
    expect(rig.acks).toContainEqual({ id: id("snapshots.snapshot_save"), val: "" });
  });

  it("snapshot_local: restores on a real index, plain ack on the '0' reset", async () => {
    const rig = makeRig([device]);
    await write(rig, id("snapshots.snapshot_local"), "2");
    expect(rig.snapshotCalls).toEqual(["restore:2"]);

    rig.snapshotCalls.length = 0;
    await write(rig, id("snapshots.snapshot_local"), "0");
    expect(rig.snapshotCalls).toHaveLength(0);
    expect(rig.acks).toContainEqual({ id: id("snapshots.snapshot_local"), val: "0" });
  });

  it("snapshot_delete: deletes by trimmed name and clears the field", async () => {
    const rig = makeRig([device]);
    await write(rig, id("snapshots.snapshot_delete"), "Abend ");
    expect(rig.snapshotCalls).toEqual(["delete:Abend"]);
    expect(rig.acks).toContainEqual({ id: id("snapshots.snapshot_delete"), val: "" });
  });
});

describe("onStateChange — per-device cloud refresh", () => {
  it("refreshes scene data and reloads cloud states only when something changed", async () => {
    const changed = makeRig([device], { refreshChanged: true });
    await write(changed, id("snapshots.refresh_cloud"), true);
    expect(changed.refreshCalls).toEqual([device.deviceId]);
    expect(changed.loadCloudStatesCalls).toHaveLength(1);
    // Button always resets so the next click works
    expect(changed.acks).toContainEqual({ id: id("snapshots.refresh_cloud"), val: false });

    const unchanged = makeRig([device], { refreshChanged: false });
    await write(unchanged, id("snapshots.refresh_cloud"), true);
    expect(unchanged.loadCloudStatesCalls).toHaveLength(0);
    expect(unchanged.acks).toContainEqual({ id: id("snapshots.refresh_cloud"), val: false });
  });
});

describe("onStateChange — manual segments (ack ownership stays in the handler)", () => {
  it("routes manual_mode/manual_list to the handler WITHOUT an outer ack (a parse-reject must not resurrect)", async () => {
    const rig = makeRig([device]);
    await write(rig, id("segments.manual_mode"), true);
    expect(rig.manualApplied.length).toBeGreaterThan(0);
    expect(rig.acks.find(a => a.id === id("segments.manual_mode"))).toBeUndefined();
  });
});

describe("onStateChange — generic capability routing", () => {
  it("routes unmapped states via native.capabilityType/Instance and acks on success", async () => {
    const rig = makeRig([device]);
    rig.objects.set(id("control.oscillation_toggle"), {
      native: { capabilityType: "devices.capabilities.toggle", capabilityInstance: "oscillationToggle" },
    });
    await write(rig, id("control.oscillation_toggle"), true);
    expect(rig.capCommands).toEqual([
      { device: device.deviceId, type: "devices.capabilities.toggle", instance: "oscillationToggle", value: true },
    ]);
    expect(rig.acks).toContainEqual({ id: id("control.oscillation_toggle"), val: true });
  });

  it("silently ignores writable states without command mapping or capability metadata (debug-only)", async () => {
    const rig = makeRig([device]);
    await write(rig, id("control.mystery_state"), 42);
    expect(rig.capCommands).toHaveLength(0);
    expect(rig.warns).toHaveLength(0);
  });
});

describe("handleManualSegmentsChange", () => {
  it("valid list → manual mode ON with parsed indices", async () => {
    const rig = makeRig([device]);
    const dev = createTestDevice({ segmentCount: 15, manualMode: true });
    await handleManualSegmentsChange(rig.adapter, dev, "segments.manual_list", "0-2,5");
    expect(rig.manualApplied).toEqual([{ mode: true, indices: [0, 1, 2, 5] }]);
  });

  it("invalid list → manual mode is DISABLED so the rejected value cannot survive", async () => {
    const rig = makeRig([device]);
    const dev = createTestDevice({ segmentCount: 15, manualMode: true });
    await handleManualSegmentsChange(rig.adapter, dev, "segments.manual_list", "99-1");
    expect(rig.manualApplied).toEqual([{ mode: false, indices: undefined }]);
    expect(rig.warns.some(w => w.includes("manual_list invalid"))).toBe(true);
  });

  it("toggle off → contiguous strip restored", async () => {
    const rig = makeRig([device]);
    const dev = createTestDevice({ segmentCount: 15, manualMode: true, manualSegments: [0, 1] });
    await handleManualSegmentsChange(rig.adapter, dev, "segments.manual_mode", false);
    expect(rig.manualApplied).toEqual([{ mode: false, indices: undefined }]);
  });
});

describe("sendMusicCommand", () => {
  it("mode 0 / unset skips the command entirely", async () => {
    const rig = makeRig([device]);
    await sendMusicCommand(rig.adapter, device, PREFIX, "music.music_mode", 0);
    expect(rig.lanMusic).toHaveLength(0);
    expect(rig.capCommands).toHaveLength(0);
  });

  it("the '---' sentinel (index 0) sends nothing even on a device WITH music modes", async () => {
    // The plain `device` above has no music library, so it would skip for that
    // reason alone — a device with real options is what makes this test bite.
    const lanDev = musicDeviceNamed([
      { name: "Spectrum", value: 1 },
      { name: "Rolling", value: 2 },
    ]);
    const rig = makeRig([lanDev]);
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_mode", 0);
    expect(rig.lanMusic).toHaveLength(0);
    expect(rig.capCommands).toHaveLength(0);

    // Index 1 on the same device DOES send — proves the guard is the only
    // thing holding the sentinel back.
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_mode", 1);
    expect(rig.lanMusic).toHaveLength(1);
  });

  it("LAN device + Spectrum: reads control.color_rgb and sends the mode + RGB over LAN", async () => {
    const lanDev = musicDeviceNamed([
      { name: "Spectrum", value: 1 },
      { name: "Rolling", value: 2 },
    ]);
    const rig = makeRig([lanDev]);
    rig.states.set(id("control.color_rgb"), "#ff8000");
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_mode", 1); // index 1 → Spectrum
    expect(rig.lanMusic).toEqual([{ ip: lanDev.lanIp, mode: 1, includeRgb: true, r: 255, g: 128, b: 0 }]);
    expect(rig.capCommands).toHaveLength(0); // LAN handled it — no Cloud call
  });

  it("LAN + Spectrum at a NON-standard value still sends RGB — name-keyed, not value-keyed (A2)", async () => {
    // A SKU whose Spectrum is at value 6 (not 1): the old value gate (1||2)
    // withheld its colour; the name gate sends it.
    const lanDev = musicDeviceNamed([
      { name: "Energic", value: 5 },
      { name: "Spectrum", value: 6 },
    ]);
    const rig = makeRig([lanDev]);
    rig.states.set(id("control.color_rgb"), "#00ff00");
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_mode", 2); // index 2 → Spectrum(value 6)
    expect(rig.lanMusic).toEqual([{ ip: lanDev.lanIp, mode: 6, includeRgb: true, r: 0, g: 255, b: 0 }]);
  });

  it("LAN + a non-colour mode (Energic) sends no RGB even at value 1 (no value-based leak, A2)", async () => {
    const lanDev = musicDeviceNamed([
      { name: "Energic", value: 1 },
      { name: "Rhythm", value: 2 },
    ]);
    const rig = makeRig([lanDev]);
    rig.states.set(id("control.color_rgb"), "#ff0000");
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_mode", 1); // index 1 → Energic(value 1)
    expect(rig.lanMusic).toEqual([{ ip: lanDev.lanIp, mode: 1, includeRgb: false, r: 0, g: 0, b: 0 }]);
  });

  it("cloud-only device: combines mode + sibling sensitivity/autoColor into ONE STRUCT call", async () => {
    const cloudDev = musicDevice([1, 2, 3, 4, 5, 6], { deviceId: "CC:01", lanIp: undefined });
    const rig = makeRig([cloudDev]);
    rig.states.set(`${NS}.${PREFIX}.music.music_sensitivity`, 60);
    rig.states.set(`${NS}.${PREFIX}.music.music_auto_color`, true);
    // 1-based SKU: dropdown index 5 → options[4].value = 5 (unchanged behaviour).
    await sendMusicCommand(rig.adapter, cloudDev, PREFIX, "music.music_mode", 5);
    expect(rig.capCommands).toHaveLength(1);
    expect(rig.capCommands[0].value).toEqual({ musicMode: 5, sensitivity: 60, autoColor: 1 });
  });

  it("0-based SKU: dropdown index 1 sends device value 0 — the first mode is reachable (A1)", async () => {
    // h612f-class: options start at value 0. Old code keyed the dropdown by the
    // device value, so value 0 collided with the "---" sentinel/skip and the
    // first mode was unreachable. Index-based: index 1 → options[0].value = 0,
    // and the skip is gated on the INDEX (0), not the resolved value.
    const dev = musicDevice([0, 1, 2], { deviceId: "MM:00", lanIp: undefined });
    const rig = makeRig([dev]);
    rig.states.set(`${NS}.${PREFIX}.music.music_sensitivity`, 50);
    rig.states.set(`${NS}.${PREFIX}.music.music_auto_color`, false);
    await sendMusicCommand(rig.adapter, dev, PREFIX, "music.music_mode", 1);
    expect(rig.capCommands).toHaveLength(1);
    expect(rig.capCommands[0].value).toEqual({ musicMode: 0, sensitivity: 50, autoColor: 0 });
  });

  it("0-based SKU: index 3 maps to the last device value 2 (A1 round-trip)", async () => {
    const dev = musicDevice([0, 1, 2], { deviceId: "MM:01", lanIp: undefined });
    const rig = makeRig([dev]);
    rig.states.set(`${NS}.${PREFIX}.music.music_sensitivity`, 70);
    rig.states.set(`${NS}.${PREFIX}.music.music_auto_color`, true);
    await sendMusicCommand(rig.adapter, dev, PREFIX, "music.music_mode", 3);
    expect(rig.capCommands[0].value).toEqual({ musicMode: 2, sensitivity: 70, autoColor: 1 });
  });

  it("index past the option list is ignored (no command)", async () => {
    const dev = musicDevice([0, 1, 2], { deviceId: "MM:02", lanIp: undefined });
    const rig = makeRig([dev]);
    await sendMusicCommand(rig.adapter, dev, PREFIX, "music.music_mode", 9);
    expect(rig.capCommands).toHaveLength(0);
    expect(rig.lanMusic).toHaveLength(0);
  });

  it("warns instead of silently dropping LAN music sensitivity / auto-color (A3)", async () => {
    // The local music packet carries no sensitivity/auto-color, so changing them
    // on a LAN device used to re-send just the mode and ack "ok" silently.
    const lanDev = musicDevice([1, 2, 3]); // has lanIp (default) → LAN music path
    const rig = makeRig([lanDev]);
    rig.states.set(`${NS}.${PREFIX}.music.music_mode`, 1); // a mode is selected
    await sendMusicCommand(rig.adapter, lanDev, PREFIX, "music.music_sensitivity", 80);
    expect(rig.lanMusic).toHaveLength(0); // no pointless mode re-send
    expect(rig.warns.some(w => w.toLowerCase().includes("sensitivity"))).toBe(true);
  });
});

describe("onStateChange — music routing branch", () => {
  it("music_mode write sends the music command, acks, and resets the OTHER mode dropdowns", async () => {
    const rig = makeRig([musicDevice([1, 2, 3])]);
    rig.states.set(id("control.color_rgb"), "#ff0000");
    rig.states.set(id("scenes.light_scene"), "2"); // active scene to be reset
    await write(rig, id("music.music_mode"), 1);
    expect(rig.lanMusic).toHaveLength(1); // LAN device → setMusicMode path
    expect(rig.acks).toContainEqual({ id: id("music.music_mode"), val: 1 });
    expect(rig.acks).toContainEqual({ id: id("scenes.light_scene"), val: "0" });
  });

  it("music_mode reset to 0 acks WITHOUT sending a command", async () => {
    const rig = makeRig([device]);
    await write(rig, id("music.music_mode"), 0);
    expect(rig.lanMusic).toHaveLength(0);
    expect(rig.capCommands).toHaveLength(0);
    expect(rig.acks).toContainEqual({ id: id("music.music_mode"), val: 0 });
  });

  it("control.scene reset (0) acks WITHOUT firing a spurious preset-scene command (L4)", async () => {
    const rig = makeRig([device]);
    await write(rig, id("control.scene"), 0);
    expect(rig.commands.find(c => c.command === "scene")).toBeUndefined();
    expect(rig.acks).toContainEqual({ id: id("control.scene"), val: 0 });
  });

  it("control.scene deselect (empty) acks WITHOUT firing a command (L4)", async () => {
    const rig = makeRig([device]);
    await write(rig, id("control.scene"), "");
    expect(rig.commands.find(c => c.command === "scene")).toBeUndefined();
  });

  it("music_sensitivity routes through the shared music command without resetting dropdowns", async () => {
    const cloudDev = musicDevice([1, 2, 3, 4, 5, 6], { deviceId: "CC:02", lanIp: undefined });
    const rig = makeRig([cloudDev]);
    rig.states.set(`${NS}.${PREFIX}.music.music_mode`, 5); // stored index 5 → device value 5
    rig.states.set(id("scenes.light_scene"), "2");
    await write(rig, id("music.music_sensitivity"), 80);
    expect(rig.capCommands).toHaveLength(1);
    expect((rig.capCommands[0].value as { sensitivity: number }).sensitivity).toBe(80);
    // sensitivity is a tweak, not a mode switch — no dropdown reset
    expect(rig.acks.find(a => a.id === id("scenes.light_scene"))).toBeUndefined();
  });
});

describe("onStateChange — manual device sync button (BUG-1)", () => {
  it("syncs devices and resets the button on write true", async () => {
    const rig = makeRig([device]);
    await onStateChange(rig.adapter, `${NS}.info.manualSyncDevices`, { val: true, ack: false } as ioBroker.State);
    expect(rig.syncCalls).toEqual([1]);
    expect(rig.acks).toContainEqual({ id: `${NS}.info.manualSyncDevices`, val: false });
  });

  it("ignores an ack'd echo (no sync)", async () => {
    const rig = makeRig([device]);
    await onStateChange(rig.adapter, `${NS}.info.manualSyncDevices`, { val: true, ack: true } as ioBroker.State);
    expect(rig.syncCalls).toEqual([]);
  });
});

describe("onStateChange — diag.export routing branch", () => {
  it("delegates to the diagnostics handler: report file written + trigger reset", async () => {
    const rig = makeRig([device]);
    await write(rig, id("diag.export"), true);
    // The report is a file now; the datapoint carries its name.
    expect(rig.acks.some(a => a.id === id("diag.lastExport"))).toBe(true);
    expect(rig.acks).toContainEqual({ id: id("diag.export"), val: false });
  });
});
