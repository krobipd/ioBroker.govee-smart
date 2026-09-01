import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => key),
  },
}));

import { StateManager } from "./state-manager";
import type { GoveeDevice } from "./types";
import { LAN_STATE_IDS, type StateDefinition } from "./capability-mapper";

/**
 * Test helper — runs the full state-creation sequence (info + LAN + Cloud)
 * for a device with pre-built stateDefs. Mirrors what the old
 * createDeviceStates used to do internally; kept as a test helper so the
 * production module stays free of legacy wrappers.
 */
async function createAllStatesForTest(
  sm: StateManager,
  device: GoveeDevice,
  stateDefs: StateDefinition[],
): Promise<void> {
  await sm.createInfoStates(device);
  await sm.createLanStates(device);
  const cloudDefs = stateDefs.filter(d => !LAN_STATE_IDS.has(d.id));
  await sm.createCloudStates(device, cloudDefs);
}

/** Track adapter method calls */
interface CallRecord {
  method: string;
  args: unknown[];
}

/** Create a mock adapter with call tracking */
function createMockAdapter(): {
  adapter: Record<string, unknown>;
  calls: CallRecord[];
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, ioBroker.State>;
} {
  const calls: CallRecord[] = [];
  const objects = new Map<string, Record<string, unknown>>();
  const states = new Map<string, ioBroker.State>();

  const adapter = {
    namespace: "govee-smart.0",
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      silly: () => {},
      level: "debug",
    },
    extendObject: async (id: string, obj: Record<string, unknown>, opts?: Record<string, unknown>) => {
      calls.push({ method: "extendObject", args: [id, obj, opts] });
      // Merge-faithful mock: js-controller extendObject deep-merges via
      // node.extend (verified against js-controller 7.2.2) — same-key values
      // are replaced (even object → string), but keys absent from the patch
      // SURVIVE. A plain objects.set() here would hide exactly the class of
      // bug repairCommonStatesIfBuggy exists for.
      const deepExtend = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
        for (const [k, v] of Object.entries(source)) {
          if (v === undefined) {
            continue;
          }
          const cur = target[k];
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            target[k] = deepExtend(
              cur !== null && typeof cur === "object" && !Array.isArray(cur)
                ? { ...(cur as Record<string, unknown>) }
                : {},
              v as Record<string, unknown>,
            );
          } else {
            target[k] = v;
          }
        }
        return target;
      };
      const existing = objects.get(id);
      objects.set(id, existing ? deepExtend({ ...existing }, obj) : obj);
    },
    setObject: async (id: string, obj: Record<string, unknown>) => {
      calls.push({ method: "setObject", args: [id, obj] });
      objects.set(id, obj);
    },
    setObjectNotExistsAsync: async (id: string, obj: Record<string, unknown>) => {
      calls.push({ method: "setObjectNotExistsAsync", args: [id, obj] });
      // js-controller no-ops if the object already exists.
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
    },
    setState: async (id: string, val: Record<string, unknown>) => {
      calls.push({ method: "setState", args: [id, val] });
      states.set(id, val as unknown as ioBroker.State);
    },
    setStateChangedAsync: async (id: string, val: Record<string, unknown>) => {
      const prev = states.get(id) as { val?: unknown } | undefined;
      const changed = !prev || prev.val !== (val as { val?: unknown }).val;
      calls.push({ method: "setStateChangedAsync", args: [id, val, { changed }] });
      if (changed) {
        states.set(id, val as unknown as ioBroker.State);
      }
      return { id } as never;
    },
    getStateAsync: async (id: string) => {
      calls.push({ method: "getStateAsync", args: [id] });
      return states.get(id) ?? null;
    },
    getObjectAsync: async (id: string) => {
      calls.push({ method: "getObjectAsync", args: [id] });
      return objects.get(id) ?? null;
    },
    delObjectAsync: async (id: string, _opts?: Record<string, unknown>) => {
      calls.push({ method: "delObjectAsync", args: [id] });
      // Remove all matching keys
      for (const key of objects.keys()) {
        if (key === id || key.startsWith(id + ".")) {
          objects.delete(key);
        }
      }
    },
    delStateAsync: async (id: string) => {
      calls.push({ method: "delStateAsync", args: [id] });
      states.delete(id);
    },
    getObjectViewAsync: async (_type: string, viewType: string, opts: { startkey: string; endkey: string }) => {
      calls.push({ method: "getObjectViewAsync", args: [_type, viewType, opts] });
      const rows: Array<{ id: string; value: unknown }> = [];
      const prefix = opts.startkey.replace("govee-smart.0.", "");
      for (const [key, obj] of objects.entries()) {
        if (key.startsWith(prefix)) {
          // Filter by object type if viewType is specified (device, state, channel)
          const objType = (obj as Record<string, unknown>)?.type as string;
          if (objType && objType !== viewType) {
            continue;
          }
          rows.push({ id: `govee-smart.0.${key}`, value: obj });
        }
      }
      return { rows };
    },
  };
  return { adapter, calls, objects, states };
}

/** Create a test device */
function createTestDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6160",
    deviceId: "AABBCCDDEEFF0011",
    name: "Test Light",
    type: "devices.types.light",
    lanIp: "192.168.1.100",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    // Fresh LAN-reply timestamp so StateManager.syncInfoOnline resolves
    // info.online to true for Light test devices (matches the
    // pre-fix default which had a direct setState write).
    lastLanReplyAt: Date.now(),
    channels: { lan: true, mqtt: false, cloud: false },
    ...overrides,
  };
}

/** Basic control state definitions */
function basicControlDefs(): StateDefinition[] {
  return [
    {
      id: "power",
      name: "Power",
      type: "boolean",
      role: "switch",
      write: true,
      def: false,
      capabilityType: "on_off",
      capabilityInstance: "powerSwitch",
    },
    {
      id: "brightness",
      name: "Brightness",
      type: "number",
      role: "level.brightness",
      write: true,
      min: 0,
      max: 100,
      unit: "%",
      def: 0,
      capabilityType: "range",
      capabilityInstance: "brightness",
    },
  ];
}

describe("StateManager", () => {
  describe("forgetPrefix", () => {
    it("clears the namespace-less ensureState cache so a re-pair recreates info states (M4)", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      (sm as any).ensuredStates.add("devices.h6160_0011.info.name");
      (sm as any).ensuredStates.add("devices.h6160_0011.control.power");
      (sm as any).ensuredStates.add("devices.other_9999.info.name"); // unrelated → survives
      (sm as any).forgetPrefix("devices.h6160_0011");
      expect(Array.from((sm as any).ensuredStates as Set<string>)).toEqual(["devices.other_9999.info.name"]);
    });
  });

  describe("markAllOffline", () => {
    it("sets every online marker to false — devices and the group rollup alike", async () => {
      // info.online is what colours a device in the object tree. Left on its last
      // value it keeps every Govee device green while the instance is switched off.
      const { adapter, states, objects } = createMockAdapter();
      objects.set("devices.h6160_0011.info.online", { type: "state" });
      objects.set("devices.h6160_0022.info.online", { type: "state" });
      objects.set("groups.info.online", { type: "state" });
      objects.set("devices.h6160_0011.control.power", { type: "state" });
      states.set("devices.h6160_0011.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      states.set("devices.h6160_0022.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      states.set("groups.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      states.set("devices.h6160_0011.control.power", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);

      const sm = new StateManager(adapter as never);
      const touched = await sm.markAllOffline();

      expect(touched.sort()).toEqual([
        "devices.h6160_0011.info.online",
        "devices.h6160_0022.info.online",
        "groups.info.online",
      ]);
      expect(states.get("devices.h6160_0011.info.online")?.val).toBe(false);
      expect(states.get("groups.info.online")?.val).toBe(false);
      // Everything else is left alone — this is not a blanket reset.
      expect(states.get("devices.h6160_0011.control.power")?.val).toBe(true);
    });

    it("works off the object database, so it also runs before any device is known", async () => {
      // At startup the device map is empty and at shutdown it may already be gone.
      const { adapter, objects, states } = createMockAdapter();
      objects.set("devices.h6160_0011.info.online", { type: "state" });
      states.set("devices.h6160_0011.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      const sm = new StateManager(adapter as never);
      expect(await sm.markAllOffline()).toEqual(["devices.h6160_0011.info.online"]);
    });
  });

  describe("writeDeviceRollup", () => {
    it("counts the real devices and how many of them are reachable", async () => {
      const { adapter, objects, states } = createMockAdapter();
      for (const [id, online] of [
        ["devices.h6160_0011", true],
        ["devices.h6160_0022", true],
        ["devices.h6160_0033", false],
      ] as [string, boolean][]) {
        objects.set(`${id}.info.online`, { type: "state" });
        states.set(`${id}.info.online`, { val: online, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      }
      // The Govee app's groups sit in the tree as pseudo-devices — counting them
      // would show more devices than the user physically owns.
      objects.set("groups.info.online", { type: "state" });
      states.set("groups.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);

      const sm = new StateManager(adapter as never);
      const result = await sm.writeDeviceRollup();

      expect(result).toEqual({ total: 3, online: 2 });
      expect(states.get("info.devicesTotal")?.val).toBe(3);
      expect(states.get("info.devicesOnline")?.val).toBe(2);
      expect(states.get("info.devicesAllOnline")?.val).toBe(false);
    });

    it("all reachable sets the flag", async () => {
      const { adapter, objects, states } = createMockAdapter();
      objects.set("devices.h6160_0011.info.online", { type: "state" });
      states.set("devices.h6160_0011.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      const sm = new StateManager(adapter as never);
      await sm.writeDeviceRollup();
      expect(states.get("info.devicesAllOnline")?.val).toBe(true);
    });

    it("no devices at all does not claim everything is fine", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      expect(await sm.writeDeviceRollup()).toEqual({ total: 0, online: 0 });
      expect(states.get("info.devicesAllOnline")?.val).toBe(false);
    });

    it("markAllOffline zeroes the rollup but keeps the device count", async () => {
      // How many devices exist did not change just because nobody is reading them.
      const { adapter, objects, states } = createMockAdapter();
      objects.set("devices.h6160_0011.info.online", { type: "state" });
      states.set("devices.h6160_0011.info.online", { val: true, ack: true, ts: 0, lc: 0, from: "", q: 0 } as never);
      const sm = new StateManager(adapter as never);
      await sm.writeDeviceRollup();
      expect(states.get("info.devicesTotal")?.val).toBe(1);

      await sm.markAllOffline();

      expect(states.get("info.devicesOnline")?.val).toBe(0);
      expect(states.get("info.devicesAllOnline")?.val).toBe(false);
      expect(states.get("info.devicesTotal")?.val).toBe(1);
    });

    it("a fresh install gets no rollup it never had", async () => {
      // clearDeviceRollup only touches states that already exist.
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.markAllOffline();
      expect(states.has("info.devicesOnline")).toBe(false);
    });
  });

  describe("cleanupCloudOwnedStates", () => {
    it("does not delete the control channel object while LAN states survive under it (L9)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const prefix = "devices.h6160_0011";
      objects.set(`${prefix}.control`, { type: "channel" });
      objects.set(`${prefix}.control.colorRgb`, { type: "state" }); // LAN — skipped by cloud cleanup
      objects.set(`${prefix}.control.power`, { type: "state" }); // LAN — skipped
      objects.set(`${prefix}.control.gradient_toggle`, { type: "state" }); // cloud-owned, now stale
      // Empty cloudStateDefs → gradient_toggle is stale (removed); colorRgb/power are LAN survivors.
      await sm.cleanupCloudOwnedStates(prefix, []);
      const deleted = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0]);
      expect(deleted).toContain(`${prefix}.control.gradient_toggle`); // stale cloud state removed
      expect(deleted).not.toContain(`${prefix}.control`); // channel object preserved (LAN states live)
    });
  });

  describe("cleanupSameModeGroupOrphansOnce", () => {
    it("deletes a leftover devices.samemodegroup_* tree but leaves real devices untouched", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      // Orphan pseudo-device left by a build that merged a SameModeGroup verbatim.
      objects.set("devices.samemodegroup_9100", { type: "device" } as never);
      objects.set("devices.samemodegroup_9100.control", { type: "channel" } as never);
      objects.set("devices.samemodegroup_9100.control.power", { type: "state" } as never);
      // A real device that must survive.
      objects.set("devices.h6160_0011", { type: "device" } as never);
      objects.set("devices.h6160_0011.control.power", { type: "state" } as never);

      const removed = await sm.cleanupSameModeGroupOrphansOnce();

      const deleted = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0]);
      expect(deleted).toContain("devices.samemodegroup_9100");
      expect(deleted).not.toContain("devices.h6160_0011");
      expect(removed).toEqual(["devices.samemodegroup_9100"]);
    });

    it("is a no-op on a clean install (no samemodegroup objects)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      objects.set("devices.h6160_0011", { type: "device" } as never);

      const removed = await sm.cleanupSameModeGroupOrphansOnce();

      expect(removed).toEqual([]);
      expect(calls.some(c => c.method === "delObjectAsync")).toBe(false);
    });
  });

  describe("createInfoStates — gateway-connected sensors", () => {
    it("a gateway sensor gets info.gateway and never an (empty) info.ip", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        sku: "H5109",
        deviceId: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        type: "devices.types.thermometer",
        lanIp: undefined,
        gateway: "H5042 (ihoment_H5042_3795)",
      });
      const prefix = sm.devicePrefix(dev);
      await sm.createInfoStates(dev);
      expect(objects.has(`${prefix}.info.gateway`)).toBe(true);
      expect(objects.has(`${prefix}.info.ip`)).toBe(false);
    });

    it("removes a leftover info.ip when a device becomes gateway-connected — exactly once, no re-toggle", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        sku: "H5109",
        deviceId: "AA:BB:CC:DD:00:00:00:15:FF:FF:00:14:FF:FF:00:1A",
        type: "devices.types.thermometer",
        lanIp: undefined,
      });
      const prefix = sm.devicePrefix(dev);
      // First run as a plain sensor → info.ip exists, no info.gateway yet.
      await sm.createInfoStates(dev);
      expect(objects.has(`${prefix}.info.ip`)).toBe(true);
      expect(objects.has(`${prefix}.info.gateway`)).toBe(false);
      // Now it's discovered behind a gateway.
      dev.gateway = "H5042 (ihoment_H5042_3795)";
      await sm.createInfoStates(dev);
      expect(objects.has(`${prefix}.info.gateway`)).toBe(true);
      expect(objects.has(`${prefix}.info.ip`)).toBe(false);
      const delIpCount = (): number =>
        calls.filter(c => c.method === "delObjectAsync" && c.args[0] === `${prefix}.info.ip`).length;
      expect(delIpCount()).toBe(1);
      // Idempotence: a third pass must not toggle the object tree again.
      await sm.createInfoStates(dev);
      expect(delIpCount()).toBe(1);
      expect(objects.has(`${prefix}.info.gateway`)).toBe(true);
    });

    it("a normal device keeps info.ip and gets no info.gateway", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "H6160", lanIp: "192.168.1.50" });
      const prefix = sm.devicePrefix(dev);
      await sm.createInfoStates(dev);
      expect(objects.has(`${prefix}.info.ip`)).toBe(true);
      expect(objects.has(`${prefix}.info.gateway`)).toBe(false);
    });
  });

  describe("removeSyntheticStateOnce", () => {
    it("deletes an existing phantom sensor_humidity object exactly once (#31)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const path = "devices.h5109_1a.sensor.sensor_humidity"; // inferChannelFromStateId → "sensor"
      objects.set(path, { type: "state", common: {}, native: {} } as never);

      await sm.removeSyntheticStateOnce("devices.h5109_1a", "sensor_humidity");
      expect(objects.has(path)).toBe(false); // datapoint actually disappears
      expect(calls.filter(c => c.method === "delObjectAsync" && c.args[0] === path)).toHaveLength(1);

      // Once-guard: a repeat call skips even the existence-check (no per-poll round-trip)
      await sm.removeSyntheticStateOnce("devices.h5109_1a", "sensor_humidity");
      expect(calls.filter(c => c.method === "getObjectAsync" && c.args[0] === path)).toHaveLength(1);
      expect(calls.filter(c => c.method === "delObjectAsync" && c.args[0] === path)).toHaveLength(1);
    });

    it("is a silent no-op when the state never existed (fresh install)", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.removeSyntheticStateOnce("devices.h5109_1a", "sensor_humidity");
      expect(calls.some(c => c.method === "delObjectAsync")).toBe(false);
    });
  });

  describe("migrateLegacyColorStateIds (B2 hard-cut)", () => {
    it("deletes the legacy camelCase colour objects for a device (existence-checked)", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const device = createTestDevice();
      const prefix = sm.devicePrefix(device);
      objects.set(`${prefix}.control.colorRgb`, { type: "state" });
      objects.set(`${prefix}.control.colorTemperature`, { type: "state" });

      await sm.migrateLegacyColorStateIds(device);
      expect(objects.has(`${prefix}.control.colorRgb`)).toBe(false);
      expect(objects.has(`${prefix}.control.colorTemperature`)).toBe(false);
    });

    it("covers group prefixes too — groups carry fan-out colour states", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const group = createTestDevice({ sku: "BaseGroup", deviceId: "1311" });
      const prefix = sm.devicePrefix(group); // groups.basegroup_...
      objects.set(`${prefix}.control.colorRgb`, { type: "state" });
      await sm.migrateLegacyColorStateIds(group);
      expect(objects.has(`${prefix}.control.colorRgb`)).toBe(false);
    });

    it("is a no-op on fresh installs (no legacy camelCase objects)", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.migrateLegacyColorStateIds(createTestDevice());
      expect(calls.some(c => c.method === "delObjectAsync")).toBe(false);
    });
  });

  describe("devicePrefix", () => {
    it("should generate prefix from SKU + last 4 hex chars of device ID", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "H61BE", deviceId: "AA:BB:CC:DD:EE:FF:1D:6F" });
      expect(sm.devicePrefix(dev)).toBe("devices.h61be_1d6f");
    });

    it("should put BaseGroup under groups/ folder", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "BaseGroup", deviceId: "1280" });
      expect(sm.devicePrefix(dev)).toBe("groups.basegroup_1280");
    });

    it("should sanitize special characters in SKU", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "H6-XY.Z", deviceId: "ABCD" });
      expect(sm.devicePrefix(dev)).toBe("devices.h6-xy_z_abcd");
    });

    it("should handle device ID with colons", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ deviceId: "AA:BB:CC:DD:EE:FF:52:5F" });
      expect(sm.devicePrefix(dev)).toBe("devices.h6160_525f");
    });
  });

  describe("repairCommonStatesIfBuggy (React #31 guard)", () => {
    it("replaces a persisted buggy states map COMPLETELY — stale keys with i18n-object values must not survive", async () => {
      const { adapter, objects, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Persisted object from an old release: values are translation OBJECTS
      // (pre-v2.8.4 tLabel output) and it carries a stale key "9" that the
      // fresh map no longer contains. extendObject deep-merge would fix "0"
      // and "1" but leave "9" as an object → Admin still crashes (React #31).
      objects.set("devices.h6160_0011.scenes.light_scene", {
        type: "state",
        common: {
          name: "Scene",
          type: "mixed",
          role: "state",
          states: {
            "0": { en: "none", de: "keine" },
            "1": { en: "Aurora", de: "Aurora" },
            "9": { en: "stale entry", de: "alter Eintrag" },
          },
        },
        native: {},
      });

      const fresh: Record<string, string> = { "0": "---", "1": "Aurora" };
      await createAllStatesForTest(sm, dev, [
        {
          id: "light_scene",
          name: "Scene",
          type: "mixed",
          role: "state",
          write: true,
          channel: "scenes",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "lightScene",
          states: fresh,
          def: "0",
        },
      ]);

      const obj = objects.get("devices.h6160_0011.scenes.light_scene") as {
        common: { states: Record<string, unknown> };
      };
      // The postcondition of the repair: the persisted map is EXACTLY the
      // fresh plain-string map — no stale keys, no object values.
      expect(obj.common.states).toEqual(fresh);
      for (const v of Object.values(obj.common.states)) {
        expect(typeof v).toBe("string");
      }
      // Mechanism pin: the full-object replace runs as delObject +
      // setObjectNotExists (js-controller-blessed), never setObject
      // (repochecker S5054). extendObject alone cannot drop the stale "9".
      const repairPath = "devices.h6160_0011.scenes.light_scene";
      expect(calls.some(c => c.method === "delObjectAsync" && c.args[0] === repairPath)).toBe(true);
      expect(calls.some(c => c.method === "setObjectNotExistsAsync" && c.args[0] === repairPath)).toBe(true);
      expect(calls.filter(c => c.method === "setObject")).toHaveLength(0);
    });

    it("does not rewrite healthy plain-string maps", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const fresh: Record<string, string> = { "0": "---", "1": "Aurora" };
      await createAllStatesForTest(sm, dev, [
        {
          id: "light_scene",
          name: "Scene",
          type: "mixed",
          role: "state",
          write: true,
          channel: "scenes",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "lightScene",
          states: fresh,
          def: "0",
        },
      ]);
      // Healthy plain-string map → the repair returns early: no full-object
      // replace of any kind (neither the old setObject nor delObject +
      // setObjectNotExists) touches the state.
      const repairPath = "devices.h6160_0011.scenes.light_scene";
      expect(calls.filter(c => c.method === "setObject")).toHaveLength(0);
      expect(calls.some(c => c.method === "delObjectAsync" && c.args[0] === repairPath)).toBe(false);
      expect(calls.some(c => c.method === "setObjectNotExistsAsync" && c.args[0] === repairPath)).toBe(false);
    });
  });

  describe("createDeviceStates", () => {
    it("should create device, info channel, and info states", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      await createAllStatesForTest(sm, dev, []);

      // Device object
      expect(objects.has("devices.h6160_0011")).toBe(true);
      // Info channel
      expect(objects.has("devices.h6160_0011.info")).toBe(true);
      // Info states
      expect(objects.has("devices.h6160_0011.info.name")).toBe(true);
      expect(objects.has("devices.h6160_0011.info.model")).toBe(true);
      expect(objects.has("devices.h6160_0011.info.serial")).toBe(true);
      expect(objects.has("devices.h6160_0011.info.online")).toBe(true);
      expect(objects.has("devices.h6160_0011.info.ip")).toBe(true);
    });

    it("should set info state values from device", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ name: "Living Room", sku: "H612F", lanIp: "10.0.0.5" });

      await createAllStatesForTest(sm, dev, []);

      expect(states.get("devices.h612f_0011.info.name")).toMatchObject({ val: "Living Room" });
      expect(states.get("devices.h612f_0011.info.model")).toMatchObject({ val: "H612F" });
      expect(states.get("devices.h612f_0011.info.ip")).toMatchObject({ val: "10.0.0.5" });
      expect(states.get("devices.h612f_0011.info.online")).toMatchObject({ val: true });
    });

    it("should create control channel and states from definitions", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      await createAllStatesForTest(sm, dev, basicControlDefs());

      expect(objects.has("devices.h6160_0011.control")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.power")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.brightness")).toBe(true);
    });

    it("should set native capabilityType/Instance on LAN-default control states", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // power/brightness/colorRgb/colorTemperature are LAN-default — createLanStates
      // writes them with capabilityType:"lan" regardless of what basicControlDefs says.
      // LAN-state-IDs are the LAN phase's territory.
      await createAllStatesForTest(sm, dev, basicControlDefs());

      const powerObj = objects.get("devices.h6160_0011.control.power") as Record<string, unknown>;
      const native = powerObj?.native as Record<string, unknown>;
      expect(native?.capabilityType).toBe("lan");
      expect(native?.capabilityInstance).toBe("powerSwitch");
    });

    it("should set default value only if no current value exists", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // First call: should set default
      await createAllStatesForTest(sm, dev, basicControlDefs());
      expect(states.get("devices.h6160_0011.control.power")).toMatchObject({ val: false });

      // Simulate user setting the value
      states.set("devices.h6160_0011.control.power", { val: true, ack: false } as ioBroker.State);

      // Second call: should NOT overwrite existing value
      await createAllStatesForTest(sm, dev, basicControlDefs());
      expect(states.get("devices.h6160_0011.control.power")).toMatchObject({ val: true });
    });

    it("should not create control channel for sensor (no lanIp, no caps)", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      // Sensor-style device: no lanIp + no caps → no LAN-phase states + no
      // Cloud-derived control states either. control channel stays empty.
      const dev = createTestDevice({ lanIp: undefined, type: "devices.types.thermometer" });

      await createAllStatesForTest(sm, dev, []);

      expect(objects.has("devices.h6160_0011.control")).toBe(false);
    });

    it("should include unit, min, max, states in common", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        {
          id: "brightness",
          name: "Brightness",
          type: "number",
          role: "level.brightness",
          write: true,
          min: 0,
          max: 100,
          unit: "%",
          def: 50,
          capabilityType: "range",
          capabilityInstance: "brightness",
        },
      ];

      await createAllStatesForTest(sm, dev, defs);

      const obj = objects.get("devices.h6160_0011.control.brightness") as Record<string, unknown>;
      const common = obj?.common as Record<string, unknown>;
      expect(common?.min).toBe(0);
      expect(common?.max).toBe(100);
      expect(common?.unit).toBe("%");
    });

    it("should route light_scene to scenes channel", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          states: { "0": "---", "1": "Sunset", "2": "Rainbow" },
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];

      await createAllStatesForTest(sm, dev, defs);

      // Must be in scenes channel, not control
      expect(objects.has("devices.h6160_0011.scenes")).toBe(true);
      expect(objects.has("devices.h6160_0011.scenes.light_scene")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.light_scene")).toBe(false);

      const obj = objects.get("devices.h6160_0011.scenes.light_scene") as Record<string, unknown>;
      const common = obj?.common as Record<string, unknown>;
      const objStates = common?.states as Record<string, string>;
      expect(objStates?.["1"]).toBe("Sunset");
      expect(objStates?.["2"]).toBe("Rainbow");
    });

    it("should route music states to music channel", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        {
          id: "music_mode",
          name: "Music Mode",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "music_setting",
          capabilityInstance: "musicMode",
          channel: "music",
        },
        {
          id: "music_sensitivity",
          name: "Sensitivity",
          type: "number",
          role: "level",
          write: true,
          min: 0,
          max: 100,
          def: 100,
          capabilityType: "music_setting",
          capabilityInstance: "musicMode",
          channel: "music",
        },
      ];

      await createAllStatesForTest(sm, dev, defs);

      expect(objects.has("devices.h6160_0011.music")).toBe(true);
      expect(objects.has("devices.h6160_0011.music.music_mode")).toBe(true);
      expect(objects.has("devices.h6160_0011.music.music_sensitivity")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.music_mode")).toBe(false);
    });

    it("should route snapshot states to snapshots channel", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        {
          id: "snapshot",
          name: "Snapshot",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "snapshot",
          channel: "snapshots",
        },
        {
          id: "snapshot_local",
          name: "Local Snapshot",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "local",
          capabilityInstance: "snapshotLocal",
          channel: "snapshots",
        },
        {
          id: "snapshot_save",
          name: "Save",
          type: "string",
          role: "text",
          write: true,
          def: "",
          capabilityType: "local",
          capabilityInstance: "snapshotSave",
          channel: "snapshots",
        },
        {
          id: "snapshot_delete",
          name: "Delete",
          type: "string",
          role: "text",
          write: true,
          def: "",
          capabilityType: "local",
          capabilityInstance: "snapshotDelete",
          channel: "snapshots",
        },
      ];

      await createAllStatesForTest(sm, dev, defs);

      expect(objects.has("devices.h6160_0011.snapshots")).toBe(true);
      expect(objects.has("devices.h6160_0011.snapshots.snapshot")).toBe(true);
      expect(objects.has("devices.h6160_0011.snapshots.snapshot_local")).toBe(true);
      expect(objects.has("devices.h6160_0011.snapshots.snapshot_save")).toBe(true);
      expect(objects.has("devices.h6160_0011.snapshots.snapshot_delete")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.snapshot")).toBe(false);
    });

    it("should create multiple channels simultaneously", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        ...basicControlDefs(),
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
        {
          id: "music_mode",
          name: "Music",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "music_setting",
          capabilityInstance: "musicMode",
          channel: "music",
        },
        {
          id: "snapshot_save",
          name: "Save",
          type: "string",
          role: "text",
          write: true,
          def: "",
          capabilityType: "local",
          capabilityInstance: "snapshotSave",
          channel: "snapshots",
        },
      ];

      await createAllStatesForTest(sm, dev, defs);

      expect(objects.has("devices.h6160_0011.control")).toBe(true);
      expect(objects.has("devices.h6160_0011.scenes")).toBe(true);
      expect(objects.has("devices.h6160_0011.music")).toBe(true);
      expect(objects.has("devices.h6160_0011.snapshots")).toBe(true);
    });

    it("should set ip to empty string when no LAN IP", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ lanIp: undefined });

      await createAllStatesForTest(sm, dev, []);

      expect(states.get("devices.h6160_0011.info.ip")).toMatchObject({ val: "" });
    });

    it("should not create model/serial/ip/online for BaseGroup", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "BaseGroup", deviceId: "1280" });

      await createAllStatesForTest(sm, dev, []);

      expect(objects.has("groups.basegroup_1280.info.name")).toBe(true);
      expect(objects.has("groups.basegroup_1280.info.online")).toBe(false);
      expect(objects.has("groups.basegroup_1280.info.model")).toBe(false);
      expect(objects.has("groups.basegroup_1280.info.serial")).toBe(false);
      expect(objects.has("groups.basegroup_1280.info.ip")).toBe(false);
    });
  });

  describe("createGroupsOnlineState", () => {
    it("should create groups.info.online state", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      await sm.createGroupsOnlineState(true);

      expect(objects.has("groups")).toBe(true);
      expect(objects.has("groups.info")).toBe(true);
      expect(objects.has("groups.info.online")).toBe(true);
      expect(states.get("groups.info.online")).toMatchObject({ val: true });
    });

    it("should update groups online state", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      await sm.createGroupsOnlineState(false);
      expect(states.get("groups.info.online")).toMatchObject({ val: false });

      // Simulate object exists for setStateIfExists
      objects.set("groups.info.online", { type: "state" } as never);
      await sm.updateGroupsOnline(true);
      expect(states.get("groups.info.online")).toMatchObject({ val: true });
    });
  });

  describe("group members", () => {
    it("should create info.members for BaseGroup with groupMembers", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        sku: "BaseGroup",
        deviceId: "6781311",
        name: "living",
        groupMembers: [
          { sku: "H61BE", deviceId: "AA:BB:CC:DD:EE:FF:52:5F" },
          { sku: "H61BC", deviceId: "AA:BB:CC:DD:EE:FF:1A:2B" },
        ],
      });

      await createAllStatesForTest(sm, dev, []);

      expect(objects.has("groups.basegroup_1311.info.members")).toBe(true);
      const val = states.get("groups.basegroup_1311.info.members");
      expect(val).toBeDefined();
      expect(val!.val).toBe("h61be_525f, h61bc_1a2b");
    });

    it("should create empty info.members for BaseGroup without groupMembers", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        sku: "BaseGroup",
        deviceId: "6781280",
        name: "test group",
      });

      await createAllStatesForTest(sm, dev, []);

      const val = states.get("groups.basegroup_1280.info.members");
      expect(val).toBeDefined();
      expect(val!.val).toBe("");
    });

    it("should clean up legacy diagnostics + new diag channel for BaseGroup (when objects exist)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
      // Pre-seed legacy objects to simulate an upgrade scenario — without
      // these, safeDeleteState's existence-probe would correctly skip the
      // delete-calls (no-op when object never existed).
      objects.set("groups.basegroup_1311.info.diagnostics_export", { type: "state", common: {} });
      objects.set("groups.basegroup_1311.info.diagnostics_result", { type: "state", common: {} });
      objects.set("groups.basegroup_1311.info.diagnostics_tier", { type: "state", common: {} });
      objects.set("groups.basegroup_1311.diag", { type: "channel", common: {} });

      await createAllStatesForTest(sm, dev, []);

      const delCalls = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0] as string);
      // Legacy v2.1.0 layout (info.diagnostics_*) — dropped via safeDeleteState
      expect(delCalls).toContain("groups.basegroup_1311.info.diagnostics_export");
      expect(delCalls).toContain("groups.basegroup_1311.info.diagnostics_result");
      expect(delCalls).toContain("groups.basegroup_1311.info.diagnostics_tier");
      // v2.1.1 layout — diag channel via direct delObjectAsync (recursive, no probe)
      expect(delCalls).toContain("groups.basegroup_1311.diag");
    });

    it("should NOT trigger del-calls on fresh install when legacy objects never existed (no WARN spam)", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });

      // No pre-seeded objects — fresh install scenario
      await createAllStatesForTest(sm, dev, []);

      const delCalls = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0] as string);
      // safeDeleteState skips the delete because getObjectAsync returns null
      expect(delCalls).not.toContain("groups.basegroup_1311.info.diagnostics_export");
      expect(delCalls).not.toContain("groups.basegroup_1311.info.diagnostics_result");
      expect(delCalls).not.toContain("groups.basegroup_1311.info.diagnostics_tier");
      // diag-channel-recursive stays — operates on the known "groups have no diag" convention
      expect(delCalls).toContain("groups.basegroup_1311.diag");
    });
  });

  describe("updateGroupMembersUnreachable", () => {
    it("should create state and write unreachable list when members are offline", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
      const m1 = createTestDevice({ sku: "H61BE", deviceId: "AABB0011", state: { online: false } });
      const m2 = createTestDevice({ sku: "H61BC", deviceId: "CCDD2233", state: { online: true } });

      await sm.updateGroupMembersUnreachable(group, [m1, m2]);

      expect(objects.has("groups.basegroup_1311.info.membersUnreachable")).toBe(true);
      const val = states.get("groups.basegroup_1311.info.membersUnreachable");
      expect(val!.val).toBe("h61be_0011");
    });

    it("should write empty string when all members are reachable (no delete to avoid race-condition WARN)", async () => {
      const { adapter, calls, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
      const m1 = createTestDevice({ state: { online: true } });

      await sm.updateGroupMembersUnreachable(group, [m1]);

      // State + object keep existing, the content is set to an empty string
      expect(objects.has("groups.basegroup_1311.info.membersUnreachable")).toBe(true);
      const val = states.get("groups.basegroup_1311.info.membersUnreachable");
      expect(val!.val).toBe("");
      // Critical: no delObject/delState at all — otherwise the "has no existing object" WARN
      // appears every 2 min when parallel updateGroupReachability calls produce a race condition
      const delObj = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0] as string);
      const delSt = calls.filter(c => c.method === "delStateAsync").map(c => c.args[0] as string);
      expect(delObj).not.toContain("groups.basegroup_1311.info.membersUnreachable");
      expect(delSt).not.toContain("groups.basegroup_1311.info.membersUnreachable");
    });

    it("should not call delObjectAsync ever (race-condition prevention)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const group = createTestDevice({ sku: "BaseGroup", deviceId: "6781311" });
      // Pre-seed: state existed (from previous unreachable-cycle on disk)
      objects.set("groups.basegroup_1311.info.membersUnreachable", { type: "state", common: {} });
      const m1 = createTestDevice({ state: { online: true } });

      await sm.updateGroupMembersUnreachable(group, [m1]);

      const delCalls = calls.filter(c => c.method === "delObjectAsync").map(c => c.args[0] as string);
      expect(delCalls).not.toContain("groups.basegroup_1311.info.membersUnreachable");
    });
  });

  describe("resolveStatePath", () => {
    it("should route control states to control channel", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      expect(sm.resolveStatePath("devices.h6160_0011", "power")).toBe("devices.h6160_0011.control.power");
      expect(sm.resolveStatePath("devices.h6160_0011", "brightness")).toBe("devices.h6160_0011.control.brightness");
    });

    it("should route scene states to scenes channel", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
        {
          id: "diy_scene",
          name: "DIY",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "diyScene",
          channel: "scenes",
        },
        {
          id: "scene_speed",
          name: "Speed",
          type: "number",
          role: "level",
          write: true,
          def: 0,
          capabilityType: "local",
          capabilityInstance: "sceneSpeed",
          channel: "scenes",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "light_scene")).toBe("devices.h6160_0011.scenes.light_scene");
      expect(sm.resolveStatePath("devices.h6160_0011", "diy_scene")).toBe("devices.h6160_0011.scenes.diy_scene");
      expect(sm.resolveStatePath("devices.h6160_0011", "scene_speed")).toBe("devices.h6160_0011.scenes.scene_speed");
    });

    it("should route music states to music channel", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "music_mode",
          name: "Music",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "music_setting",
          capabilityInstance: "musicMode",
          channel: "music",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "music_mode")).toBe("devices.h6160_0011.music.music_mode");
    });

    it("should route snapshot states to snapshots channel", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "snapshot",
          name: "Snapshot",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "snapshot",
          channel: "snapshots",
        },
        {
          id: "snapshot_local",
          name: "Local",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "local",
          capabilityInstance: "snapshotLocal",
          channel: "snapshots",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "snapshot")).toBe("devices.h6160_0011.snapshots.snapshot");
      expect(sm.resolveStatePath("devices.h6160_0011", "snapshot_local")).toBe(
        "devices.h6160_0011.snapshots.snapshot_local",
      );
    });

    it("should route diagnostics states to diag channel (top-level on device)", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "export",
          name: "Export",
          type: "boolean",
          role: "button",
          write: true,
          def: false,
          capabilityType: "local",
          capabilityInstance: "diagnosticsExport",
          channel: "diag",
        },
        {
          id: "result",
          name: "Result",
          type: "string",
          role: "json",
          write: false,
          def: "",
          capabilityType: "local",
          capabilityInstance: "diagnosticsResult",
          channel: "diag",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "export")).toBe("devices.h6160_0011.diag.export");
      expect(sm.resolveStatePath("devices.h6160_0011", "result")).toBe("devices.h6160_0011.diag.result");
    });

    it("should route unknown states to control channel", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      expect(sm.resolveStatePath("devices.h6160_0011", "gradient_toggle")).toBe(
        "devices.h6160_0011.control.gradient_toggle",
      );
    });

    it("should route sensor states to sensor channel", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "temperature",
          name: "Temperature",
          type: "number",
          role: "value.temperature",
          write: false,
          def: 0,
          unit: "°C",
          capabilityType: "property",
          capabilityInstance: "sensorTemperature",
          channel: "sensor",
        },
        {
          id: "humidity",
          name: "Humidity",
          type: "number",
          role: "value.humidity",
          write: false,
          def: 0,
          unit: "%",
          capabilityType: "property",
          capabilityInstance: "sensorHumidity",
          channel: "sensor",
        },
        {
          id: "battery",
          name: "Battery",
          type: "number",
          role: "value.battery",
          write: false,
          def: 0,
          unit: "%",
          capabilityType: "property",
          capabilityInstance: "battery",
          channel: "sensor",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "temperature")).toBe("devices.h6160_0011.sensor.temperature");
      expect(sm.resolveStatePath("devices.h6160_0011", "humidity")).toBe("devices.h6160_0011.sensor.humidity");
      expect(sm.resolveStatePath("devices.h6160_0011", "battery")).toBe("devices.h6160_0011.sensor.battery");
    });

    it("should route event states to events channel", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, [
        {
          id: "lack_water",
          name: "Lack of Water",
          type: "boolean",
          role: "indicator",
          write: false,
          def: false,
          capabilityType: "event",
          capabilityInstance: "lackWaterEvent",
          channel: "events",
        },
        {
          id: "ice_full",
          name: "Ice Full",
          type: "boolean",
          role: "indicator",
          write: false,
          def: false,
          capabilityType: "event",
          capabilityInstance: "iceFullEvent",
          channel: "events",
        },
      ]);
      expect(sm.resolveStatePath("devices.h6160_0011", "lack_water")).toBe("devices.h6160_0011.events.lack_water");
      expect(sm.resolveStatePath("devices.h6160_0011", "ice_full")).toBe("devices.h6160_0011.events.ice_full");
    });

    it("should route sanitizeId-output sensor IDs (sensor_temperature etc.) to sensor channel via inferChannelFromStateId", () => {
      // No createDeviceStates pre-population — inferChannelFromStateId
      // is the fallback when stateChannelMap doesn't have the ID. Caps
      // from App-API/OpenAPI-MQTT use sanitizeId(camelCase) which produces
      // sensor_temperature, sensor_humidity, sensor_battery — these MUST
      // route to sensor/ even without prior createDeviceStates run.
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      expect(sm.resolveStatePath("devices.h5179_3c1b", "sensor_temperature")).toBe(
        "devices.h5179_3c1b.sensor.sensor_temperature",
      );
      expect(sm.resolveStatePath("devices.h5179_3c1b", "sensor_humidity")).toBe(
        "devices.h5179_3c1b.sensor.sensor_humidity",
      );
      expect(sm.resolveStatePath("devices.h5179_3c1b", "sensor_battery")).toBe(
        "devices.h5179_3c1b.sensor.sensor_battery",
      );
    });

    it("should route sanitizeId-output event IDs (lack_water_event etc.) to events channel via inferChannelFromStateId", () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      expect(sm.resolveStatePath("devices.hxxxx_yy", "lack_water_event")).toBe(
        "devices.hxxxx_yy.events.lack_water_event",
      );
      expect(sm.resolveStatePath("devices.hxxxx_yy", "ice_full_event")).toBe("devices.hxxxx_yy.events.ice_full_event");
      expect(sm.resolveStatePath("devices.hxxxx_yy", "body_appeared")).toBe("devices.hxxxx_yy.events.body_appeared");
      expect(sm.resolveStatePath("devices.hxxxx_yy", "dirt_detected")).toBe("devices.hxxxx_yy.events.dirt_detected");
    });
  });

  describe("ensureSyntheticStateObject", () => {
    it("should create state under sensor/ channel for sensor_temperature", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_temperature");
      // Check Channel-Object created
      expect(objects.has("devices.h5179_3c1b.sensor")).toBe(true);
      // Check State-Object created via extendObject (NOT setObjectNotExists)
      expect(objects.has("devices.h5179_3c1b.sensor.sensor_temperature")).toBe(true);
      // Verify extendObject was used (idempotent + repairs partial-formed)
      const extendCalls = calls.filter(c => c.method === "extendObject");
      const stateExtend = extendCalls.find(c => c.args[0] === "devices.h5179_3c1b.sensor.sensor_temperature");
      expect(stateExtend).toBeDefined();
    });

    it("creates the channel + state objects ONCE per run — a second write issues no object writes", async () => {
      // The App-API poll calls this every two minutes for every value; both
      // objects only have to exist, not be re-written.
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_temperature");
      const first = calls.filter(c => c.method === "extendObject").length;
      expect(first).toBe(2);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_temperature");
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_humidity"); // same channel, new state
      const extendIds = calls.filter(c => c.method === "extendObject").map(c => c.args[0]);
      expect(extendIds).toEqual([
        "devices.h5179_3c1b.sensor",
        "devices.h5179_3c1b.sensor.sensor_temperature",
        "devices.h5179_3c1b.sensor.sensor_humidity",
      ]);
    });

    it("re-creates a synthetic state after removeSyntheticStateOnce dropped it", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_humidity");
      await sm.removeSyntheticStateOnce("devices.h5179_3c1b", "sensor_humidity");
      expect(objects.has("devices.h5179_3c1b.sensor.sensor_humidity")).toBe(false);
      calls.length = 0;
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_humidity");
      expect(objects.has("devices.h5179_3c1b.sensor.sensor_humidity")).toBe(true);
      expect(calls.filter(c => c.method === "extendObject").map(c => c.args[0])).toEqual([
        "devices.h5179_3c1b.sensor.sensor_humidity",
      ]);
    });

    it("should be no-op for unknown stateId (not in SYNTHETIC_STATE_META)", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "unknown_state_xyz");
      const extendCalls = calls.filter(c => c.method === "extendObject");
      expect(extendCalls).toHaveLength(0);
    });

    it("should repair partial-formed object via extendObject (no-op with setObjectNotExists)", async () => {
      const { adapter, objects } = createMockAdapter();
      // Pre-set partial-formed object (missing role) — simulating broken
      // state from older adapter version
      objects.set("devices.h5179_3c1b.sensor.sensor_humidity", {
        type: "state",
        common: { name: "old", type: "number" },
      });
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_humidity");
      const final = objects.get("devices.h5179_3c1b.sensor.sensor_humidity") as Record<string, unknown>;
      // extendObject stores latest write — common should now be the full meta
      const common = final?.common as { role?: string };
      expect(common?.role).toBe("value.humidity");
    });
  });

  describe("updateDeviceState", () => {
    it("should update power state", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Create the object so setStateIfExists finds it
      await createAllStatesForTest(sm, dev, basicControlDefs());

      await sm.updateDeviceState(dev, { power: true });
      expect(states.get("devices.h6160_0011.control.power")).toMatchObject({ val: true });
    });

    it("should update multiple state fields at once", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, basicControlDefs());

      await sm.updateDeviceState(dev, { power: true, brightness: 75 });

      expect(states.get("devices.h6160_0011.control.power")).toMatchObject({ val: true });
      expect(states.get("devices.h6160_0011.control.brightness")).toMatchObject({ val: 75 });
    });

    it("should update online status for non-Light devices via updateDeviceState", async () => {
      // For Lights, info.online is owned by syncInfoOnline (LAN-reply TTL).
      // updateDeviceState writes online only for Sensors/Appliances where
      // applyOnlineCap is still the truth-source.
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({ type: "devices.types.thermometer", sku: "H5179" });
      await createAllStatesForTest(sm, dev, []);

      await sm.updateDeviceState(dev, { online: false });
      expect(states.get("devices.h5179_0011.info.online")).toMatchObject({ val: false });
    });

    it("should NOT write info.online for Lights via updateDeviceState", async () => {
      // Regression guard for the 2026-05-13 info.online fix — Lights must not
      // get periodic ts-rewrites from this path. The 20 s sync-timer and
      // direct call from onDeviceStateUpdate own the write.
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice(); // default type = devices.types.light
      await createAllStatesForTest(sm, dev, []);
      // Capture the initial info.online written via syncInfoOnline from
      // createInfoStates (= true because createTestDevice sets a fresh
      // lastLanReplyAt). Then call updateDeviceState with online=false —
      // it must NOT overwrite info.online for the Light.
      const before = states.get("devices.h6160_0011.info.online");

      await sm.updateDeviceState(dev, { online: false });

      const after = states.get("devices.h6160_0011.info.online");
      expect(after).toEqual(before);
    });

    describe("syncInfoOnline — cloud-only lights (local-first, not local-only)", () => {
      it("cloud-only light (no lanIp): info.online follows the cloud-reported online", async () => {
        const { adapter, states } = createMockAdapter();
        const sm = new StateManager(adapter as never);
        const dev = createTestDevice({
          lanIp: undefined,
          lastLanReplyAt: undefined,
          state: { online: true },
          channels: { lan: false, mqtt: false, cloud: true },
        });
        await createAllStatesForTest(sm, dev, []);
        await sm.syncInfoOnline(dev);
        expect(states.get("devices.h6160_0011.info.online")).toMatchObject({ val: true });
      });

      it("cloud-only light reports offline when the cloud says offline", async () => {
        const { adapter, states } = createMockAdapter();
        const sm = new StateManager(adapter as never);
        const dev = createTestDevice({
          lanIp: undefined,
          lastLanReplyAt: undefined,
          state: { online: false },
          channels: { lan: false, mqtt: false, cloud: true },
        });
        await createAllStatesForTest(sm, dev, []);
        await sm.syncInfoOnline(dev);
        expect(states.get("devices.h6160_0011.info.online")).toMatchObject({ val: false });
      });

      it("LAN-capable light still uses LAN-reply freshness, never stale cloud online (v2.9.0 guard)", async () => {
        const { adapter, states } = createMockAdapter();
        const sm = new StateManager(adapter as never);
        const dev = createTestDevice({
          lanIp: "192.168.1.100",
          lastLanReplyAt: undefined,
          state: { online: true },
        });
        await createAllStatesForTest(sm, dev, []);
        await sm.syncInfoOnline(dev);
        expect(states.get("devices.h6160_0011.info.online")).toMatchObject({ val: false });
      });
    });

    it("should not write anything when given an empty update", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, basicControlDefs());

      const before = calls.filter(c => c.method === "setStateChangedAsync").length;
      await sm.updateDeviceState(dev, {});
      const after = calls.filter(c => c.method === "setStateChangedAsync").length;
      expect(after - before).toBe(0);
    });

    it("should fire writes in parallel, not sequentially", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, basicControlDefs());

      const before = calls.filter(c => c.method === "setStateChangedAsync").length;
      await sm.updateDeviceState(dev, {
        power: true,
        brightness: 75,
        colorRgb: "#ff0000",
      });
      const after = calls.filter(c => c.method === "setStateChangedAsync").length;
      // Three fields set → three setStateChangedAsync calls, no extra getObjectAsync
      expect(after - before).toBe(3);
      const getObjectCalls = calls.filter(c => c.method === "getObjectAsync");
      expect(getObjectCalls.filter(c => String(c.args[0]).includes(".control."))).toHaveLength(0);
    });

    it("uses setStateChangedAsync — a repeated identical value is not re-written", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, basicControlDefs());

      await sm.updateDeviceState(dev, { power: true });
      await sm.updateDeviceState(dev, { power: true }); // identical — LAN poll re-delivery

      const powerWrites = calls.filter(
        c => c.method === "setStateChangedAsync" && String(c.args[0]).endsWith(".control.power"),
      );
      // Invoked both times (we always call setStateChangedAsync), but only the
      // first actually changed the value — the second is a no-op timestamp-wise.
      expect(powerWrites).toHaveLength(2);
      expect((powerWrites[0].args[2] as { changed: boolean }).changed).toBe(true);
      expect((powerWrites[1].args[2] as { changed: boolean }).changed).toBe(false);
    });
  });

  describe("cleanupDevices", () => {
    it("should remove devices not in current list", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      // Create two devices
      const dev1 = createTestDevice({ sku: "H6160", deviceId: "AABB1111" });
      const dev2 = createTestDevice({ sku: "H6161", deviceId: "AABB2222" });
      await createAllStatesForTest(sm, dev1, []);
      await createAllStatesForTest(sm, dev2, []);

      // Cleanup with only dev1 as current
      await sm.cleanupDevices([dev1]);

      const delCalls = calls.filter(c => c.method === "delObjectAsync" && (c.args[0] as string).includes("h6161"));
      expect(delCalls.length).toBeGreaterThan(0);
    });

    it("should not remove devices that still exist", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      const dev = createTestDevice();
      await createAllStatesForTest(sm, dev, []);

      await sm.cleanupDevices([dev]);

      // No delObjectAsync calls should target the device prefix
      const delDeviceCalls = calls.filter(
        c => c.method === "delObjectAsync" && (c.args[0] as string).startsWith("devices.h6160"),
      );
      expect(delDeviceCalls.length).toBe(0);
    });

    it("should delete state values before removing the device object", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      const survivor = createTestDevice({ sku: "H6160", deviceId: "AABB1111" });
      const stale = createTestDevice({ sku: "H6161", deviceId: "AABB2222" });
      await createAllStatesForTest(sm, survivor, basicControlDefs());
      await createAllStatesForTest(sm, stale, basicControlDefs());

      await sm.cleanupDevices([survivor]);

      // Find the indices of delStateAsync calls touching the stale prefix
      // and the delObjectAsync call removing the stale device. The state
      // deletes must come first so historical values don't outlive the
      // device tree on disk.
      const stalePrefix = "devices.h6161_2222";
      const stateDeleteIdx = calls.findIndex(
        c =>
          c.method === "delStateAsync" &&
          typeof c.args[0] === "string" &&
          (c.args[0] as string).startsWith(`${stalePrefix}.`),
      );
      const objectDeleteIdx = calls.findIndex(c => c.method === "delObjectAsync" && c.args[0] === stalePrefix);
      expect(stateDeleteIdx, "delStateAsync was called for the stale prefix").toBeGreaterThan(-1);
      expect(objectDeleteIdx, "delObjectAsync was called for the stale prefix").toBeGreaterThan(-1);
      expect(stateDeleteIdx, "state values must be deleted before the device object").toBeLessThan(objectDeleteIdx);
    });

    it("should keep state values for surviving devices", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);

      const survivor = createTestDevice({ sku: "H6160", deviceId: "AABB1111" });
      await createAllStatesForTest(sm, survivor, basicControlDefs());

      await sm.cleanupDevices([survivor]);

      const survivorPrefix = "devices.h6160_1111";
      const survivorStateDeletes = calls.filter(
        c =>
          c.method === "delStateAsync" &&
          typeof c.args[0] === "string" &&
          (c.args[0] as string).startsWith(`${survivorPrefix}.`),
      );
      expect(survivorStateDeletes).toHaveLength(0);
    });
  });

  describe("cleanupCloudOwnedStates", () => {
    it("should remove stale cloud-owned control states not in current Cloud-phase defs", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Create with a cloud-cap state (gradient_toggle is a `toggle` capability,
      // NOT in LAN_STATE_IDS, so cleanup will touch it).
      const withGradient: StateDefinition[] = [
        {
          id: "gradient_toggle",
          name: "Gradient",
          type: "boolean",
          role: "switch",
          write: true,
          def: false,
          capabilityType: "devices.capabilities.toggle",
          capabilityInstance: "gradientToggle",
        },
      ];
      await createAllStatesForTest(sm, dev, withGradient);
      expect(objects.has("devices.h6160_0011.control.gradient_toggle")).toBe(true);

      // Recreate with no cloud-cap states — gradient_toggle should be cleaned up
      await createAllStatesForTest(sm, dev, []);

      const delCalls = calls.filter(
        c => c.method === "delObjectAsync" && (c.args[0] as string).includes("gradient_toggle"),
      );
      expect(delCalls.length).toBeGreaterThan(0);
    });

    it("keeps the App-API / Cloud-events synthetic sensor + event states across a Cloud-phase rebuild", async () => {
      // battery / sensor_temperature / lack_water are created ad hoc by the
      // App-API poll and never appear in a Cloud state-def — each Cloud rebuild
      // used to delete them and the next poll re-created them (object churn +
      // a value gap). They are foreign-owned survivors, like the LAN ids.
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "battery");
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "sensor_temperature");
      await sm.ensureSyntheticStateObject("devices.h5179_3c1b", "lack_water");
      calls.length = 0;

      const deleted = await sm.cleanupCloudOwnedStates("devices.h5179_3c1b", []);

      expect(deleted).toBe(0);
      expect(calls.filter(c => c.method === "delObjectAsync")).toHaveLength(0);
      expect(objects.has("devices.h5179_3c1b.sensor.battery")).toBe(true);
      expect(objects.has("devices.h5179_3c1b.sensor.sensor_temperature")).toBe(true);
      expect(objects.has("devices.h5179_3c1b.events.lack_water")).toBe(true);
      // The channel objects survive with their states.
      expect(objects.has("devices.h5179_3c1b.sensor")).toBe(true);
      expect(objects.has("devices.h5179_3c1b.events")).toBe(true);
    });

    it("should NEVER remove LAN-owned states (power, brightness, colorRgb, colorTemperature)", async () => {
      const { adapter, calls, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Create with LAN-defaults populated (power, brightness, etc.)
      await createAllStatesForTest(sm, dev, basicControlDefs());
      expect(objects.has("devices.h6160_0011.control.power")).toBe(true);
      expect(objects.has("devices.h6160_0011.control.brightness")).toBe(true);

      // Run cleanupCloudOwnedStates with empty cloudDefs — LAN states must survive
      await sm.cleanupCloudOwnedStates("devices.h6160_0011", []);

      const lanDeletes = calls.filter(
        c =>
          c.method === "delObjectAsync" &&
          typeof c.args[0] === "string" &&
          /control\.(power|brightness|colorRgb|colorTemperature)$/.test(c.args[0] as string),
      );
      expect(lanDeletes.length).toBe(0);
    });

    it("should remove cloud-owned channels entirely when empty (e.g. scenes leftover after cap removal)", async () => {
      const { adapter, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Create a scenes.light_scene state (cloud-owned)
      const withScene: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "mixed",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "devices.capabilities.dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];
      await createAllStatesForTest(sm, dev, withScene);

      // Recreate with no cloud defs — scenes channel should be removed
      await createAllStatesForTest(sm, dev, []);

      const channelDeletes = calls.filter(
        c => c.method === "delObjectAsync" && (c.args[0] as string).endsWith(".scenes"),
      );
      expect(channelDeletes.length).toBeGreaterThan(0);
    });

    it("should migrate states from old control to new channel", async () => {
      const { adapter, objects, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Simulate old layout: light_scene in control channel
      objects.set("devices.h6160_0011.control.light_scene", { type: "state" });

      // Create with light_scene in scenes channel
      const defs: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];
      await createAllStatesForTest(sm, dev, defs);

      // Old control.light_scene should be deleted (it's stale in control)
      const delCalls = calls.filter(
        c => c.method === "delObjectAsync" && (c.args[0] as string) === "devices.h6160_0011.control.light_scene",
      );
      expect(delCalls.length).toBeGreaterThan(0);
      // New scenes.light_scene should exist
      expect(objects.has("devices.h6160_0011.scenes.light_scene")).toBe(true);
    });

    it("should reset dropdown to default when current value is no longer in states map", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      // Create with 3 scenes: {0: "---", 1: "Scene A", 2: "Scene B"}
      const defs: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          states: { 0: "---", 1: "Scene A", 2: "Scene B" },
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];
      await createAllStatesForTest(sm, dev, defs);

      // Simulate user selected scene 2
      states.set("devices.h6160_0011.scenes.light_scene", { val: "2", ack: true } as ioBroker.State);

      // Re-create with only 1 scene — scene 2 no longer valid
      const newDefs: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          states: { 0: "---", 1: "Scene A" },
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];
      await createAllStatesForTest(sm, dev, newDefs);

      // Value should be reset to default "0"
      const final = states.get("devices.h6160_0011.scenes.light_scene");
      expect(final?.val).toBe("0");
    });

    it("should keep dropdown value when it is still valid in states map", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice();

      const defs: StateDefinition[] = [
        {
          id: "light_scene",
          name: "Scene",
          type: "string",
          role: "text",
          write: true,
          def: "0",
          states: { 0: "---", 1: "Scene A", 2: "Scene B" },
          capabilityType: "dynamic_scene",
          capabilityInstance: "lightScene",
          channel: "scenes",
        },
      ];
      await createAllStatesForTest(sm, dev, defs);

      // Simulate user selected scene 1
      states.set("devices.h6160_0011.scenes.light_scene", { val: "1", ack: true } as ioBroker.State);

      // Re-create with same scenes — value should remain
      await createAllStatesForTest(sm, dev, defs);

      const final = states.get("devices.h6160_0011.scenes.light_scene");
      expect(final?.val).toBe("1");
    });
  });

  describe("createSegmentStates", () => {
    it("should create segment channel and per-segment states", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "segment", elementRange: { min: 0, max: 9 } }],
            },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      expect(objects.has("devices.h6160_0011.segments")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.0")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.0.color")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.0.brightness")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.9")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.command")).toBe(true);
      expect(dev.segmentCount).toBe(10);
    });

    it("should return 0 segments when field has no elementRange", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT" as const,
              fields: [{ fieldName: "segment" }],
            },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      expect(dev.segmentCount).toBe(0);
    });

    it("should remove excess segment channels from previous runs", async () => {
      const { adapter, objects, calls } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "segment", elementRange: { min: 0, max: 4 } }],
            },
          },
        ],
      });

      // Simulate old segment channels 0-14 existing
      for (let i = 0; i < 15; i++) {
        objects.set(`devices.h6160_0011.segments.${i}`, { type: "channel" });
      }

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      expect(dev.segmentCount).toBe(5);
      // Segments 5-14 should be deleted
      const delCalls = calls.filter(c => c.method === "delObjectAsync" && /segments\.\d+$/.test(c.args[0] as string));
      expect(delCalls.length).toBe(10);
    });

    it("should return 0 segments when capability has no fields", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: { dataType: "STRUCT" as const },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      expect(dev.segmentCount).toBe(0);
    });

    it("should prefer already-set segmentCount over capability count", async () => {
      // Cache or MQTT discovery has learned 20; capability only says 15.
      // We trust the learned value.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        segmentCount: 20,
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "segment", elementRange: { min: 0, max: 14 } }],
            },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      expect(dev.segmentCount).toBe(20);
      expect(objects.has("devices.h6160_0011.segments.19")).toBe(true);
      expect(objects.has("devices.h6160_0011.segments.14")).toBe(true);
    });

    it("should write manual_mode + manual_list initial values from device", async () => {
      // Cache-restored device with manual mode — state-manager should
      // reflect that back to the state tree (ack=true, no trigger).
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        segmentCount: 15,
        manualMode: true,
        manualSegments: [0, 1, 2, 5, 6, 7],
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "segment", elementRange: { min: 0, max: 14 } }],
            },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      const mode = states.get("devices.h6160_0011.segments.manual_mode");
      const list = states.get("devices.h6160_0011.segments.manual_list");
      expect(mode?.val).toBe(true);
      expect(mode?.ack).toBe(true);
      expect(list?.val).toBe("0,1,2,5,6,7");
      expect(list?.ack).toBe(true);
    });

    it("should clear manual_mode + manual_list when device.manualMode=false", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter as never);
      const dev = createTestDevice({
        segmentCount: 10,
        manualMode: false,
        capabilities: [
          {
            type: "devices.capabilities.segment_color_setting",
            instance: "segmentedColorRgb",
            parameters: {
              dataType: "STRUCT",
              fields: [{ fieldName: "segment", elementRange: { min: 0, max: 9 } }],
            },
          },
        ],
      });

      const segmentDefs: StateDefinition[] = [
        {
          id: "_segment_color",
          name: "Segment",
          type: "string",
          role: "level.color.rgb",
          write: true,
          capabilityType: "segment",
          capabilityInstance: "segmentColor",
        },
      ];

      await createAllStatesForTest(sm, dev, segmentDefs);

      const mode = states.get("devices.h6160_0011.segments.manual_mode");
      const list = states.get("devices.h6160_0011.segments.manual_list");
      expect(mode?.val).toBe(false);
      expect(list?.val).toBe("");
    });
  });
});

describe("StateManager — invariants without a test (mutation audit)", () => {
  it("a LAN light goes offline once its last LAN reply ages past the freshness window", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const dev = createTestDevice({ lanIp: "192.168.1.100", lastLanReplyAt: Date.now(), state: { online: true } });
    await createAllStatesForTest(sm, dev, []);

    await sm.syncInfoOnline(dev);
    expect(states.get("devices.h6160_0011.info.online")).toMatchObject({ val: true });

    // 91 s without a reply: the device is gone even though the last reply
    // timestamp is still set — a truthy check alone would keep it "online"
    // forever after the very first discovery.
    dev.lastLanReplyAt = Date.now() - 91_000;
    await sm.syncInfoOnline(dev);
    expect(states.get("devices.h6160_0011.info.online")).toMatchObject({ val: false });
  });

  it("info.online is written only when the value actually changes", async () => {
    const { adapter, calls } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const dev = createTestDevice({ lanIp: "192.168.1.100", lastLanReplyAt: Date.now() });
    await createAllStatesForTest(sm, dev, []);
    const countWrites = (): number =>
      calls.filter(c => c.method === "setState" && c.args[0] === "devices.h6160_0011.info.online").length;

    await sm.syncInfoOnline(dev); // settle whatever createInfoStates left behind
    const before = countWrites();
    await sm.syncInfoOnline(dev);
    await sm.syncInfoOnline(dev);
    await sm.syncInfoOnline(dev);
    // Runs every 20 s per device — a write per pass is pure timestamp spam in
    // every history/InfluxDB attached to the state.
    expect(countWrites()).toBe(before);

    dev.lastLanReplyAt = Date.now() - 91_000;
    await sm.syncInfoOnline(dev);
    expect(countWrites()).toBe(before + 1); // a real change still writes
  });

  it("syncInfoOnline ignores groups (they have no own reachability)", async () => {
    const { adapter, calls } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const group = createTestDevice({ sku: "BaseGroup", deviceId: "9001", name: "Living room" });
    const before = calls.length;
    expect(await sm.syncInfoOnline(group)).toBe(false);
    expect(calls.length).toBe(before); // not a single adapter call
  });

  it("a manual segment list may raise the segment count, never lower it", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const dev = createTestDevice({
      capabilities: [
        {
          type: "devices.capabilities.segment_color_setting",
          instance: "segmentedColorRgb",
          parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", elementRange: { min: 0, max: 9 } }] },
        },
      ],
      manualMode: true,
      // A cut strip whose user-entered list reaches beyond what Cloud reports.
      manualSegments: [0, 5, 13],
    });
    await sm.createSegmentStates(dev);
    expect(objects.has("devices.h6160_0011.segments.13")).toBe(true);
    expect(dev.segmentCount).toBe(14);
  });

  it("ensureState writes an object once per id, not on every call", async () => {
    const { adapter, calls } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const dev = createTestDevice();
    const ensured = (): string[] =>
      calls.filter(c => c.method === "extendObject" && String(c.args[0]).endsWith(".info.name")).map(c => String(c.args[0]));
    await sm.createInfoStates(dev);
    expect(ensured()).toHaveLength(1);
    // Called again on every cloud refresh / reconnect — without the cache this
    // rewrites the same object each time.
    await sm.createInfoStates(dev);
    await sm.createInfoStates(dev);
    expect(ensured()).toHaveLength(1);
  });

  it("creates buttons write-only (role catalogue) and everything else readable", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    const dev = createTestDevice();
    await sm.createCloudStates(dev, [
      {
        id: "refresh_cloud",
        name: "Refresh",
        type: "boolean",
        role: "button",
        write: true,
        capabilityType: "devices.capabilities.on_off",
        capabilityInstance: "refresh",
      },
      {
        id: "power_state",
        name: "Power",
        type: "boolean",
        role: "switch",
        write: true,
        capabilityType: "devices.capabilities.on_off",
        capabilityInstance: "powerSwitch",
      },
    ] as StateDefinition[]);
    expect((objects.get("devices.h6160_0011.control.refresh_cloud")?.common as { read: boolean }).read).toBe(false);
    expect((objects.get("devices.h6160_0011.control.power_state")?.common as { read: boolean }).read).toBe(true);
  });
});
