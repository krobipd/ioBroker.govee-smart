// GV-33 — A device's trust tier stands as `info.tier` in the device's info channel; there is no separate `diag` channel.
// krobi 2026-10-27 14:46, answering the manual test of the 3.3.0 build: "looks good, but what we still change is that the
// tier information goes from diag into info — we really don't need an extra folder just for diag"; 14:52: "pass the
// decision on to the Werkbank so we can enter it"
import { describe, expect, it, vi } from "vitest";

// capability-mapper and state-manager pull i18n → @iobroker/adapter-core, whose import-time controller lookup exits
// outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { buildCloudStateDefs } from "../lib/capability-mapper";
import { DeviceRegistry } from "../lib/device-registry";
import { StateManager } from "../lib/state-manager";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

/** A light as the cloud lists it. */
function light(): GoveeDevice {
  return {
    sku: "H6172",
    deviceId: "AA:BB:CC:DD:EE:FF:00:11",
    name: "Strip",
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
  };
}

/**
 * An object store with js-controller's semantics for the calls the migration makes: own ids get the namespace, a
 * merge keeps the keys a patch leaves out, deleting a state object deletes its value.
 *
 * @param namespace The adapter namespace
 */
function store(namespace: string): {
  adapter: Record<string, unknown>;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, unknown>;
} {
  const objects = new Map<string, Record<string, unknown>>();
  const states = new Map<string, unknown>();
  const own = (id: string): string => `${namespace}.${id}`;
  const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  const merge = (target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    for (const [k, v] of Object.entries(patch)) {
      const cur = target[k];
      target[k] =
        v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
          ? merge({ ...(cur as Record<string, unknown>) }, v as Record<string, unknown>)
          : v;
    }
    return target;
  };
  const adapter = {
    namespace,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, silly: () => {}, level: "info" },
    getObjectAsync: (id: string) => Promise.resolve(copy(objects.get(own(id)) ?? null)),
    extendObject: (id: string, patch: Record<string, unknown>) => {
      objects.set(own(id), merge({ ...(objects.get(own(id)) ?? {}) }, patch));
      return Promise.resolve();
    },
    delObjectAsync: (id: string) => {
      objects.delete(own(id));
      states.delete(own(id));
      return Promise.resolve();
    },
    getForeignObjectsAsync: (pattern: string) => {
      const head = pattern.replace(/\*$/, "");
      return Promise.resolve(
        Object.fromEntries([...objects].filter(([k]) => k.startsWith(head)).map(([k, v]) => [k, copy(v)])),
      );
    },
    getForeignObjectAsync: (id: string) => Promise.resolve(copy(objects.get(id) ?? null)),
    setForeignObject: (id: string, obj: Record<string, unknown>) => {
      objects.set(id, copy(obj));
      return Promise.resolve();
    },
  };
  return { adapter, objects, states };
}

describe("GV-33 the trust tier stands in the info channel, there is no diag channel", () => {
  it("the state builder puts the tier into the device's info channel and builds nothing named diag", () => {
    const defs = buildCloudStateDefs(light(), log, new DeviceRegistry({ data: { devices: {} } }));
    const tier = defs.find(d => d.id === "tier");
    expect(tier, "a real device gets its trust tier").toBeDefined();
    expect(tier!.channel).toBe("info");
    expect(defs.filter(d => d.channel === "diag" || d.id === "diag").map(d => `${d.channel}.${d.id}`)).toEqual([]);
  });

  it("an existing installation ends without diag: diag.tier moves to info.tier and the diag channel is deleted", async () => {
    const ns = "govee-smart.0";
    const { adapter, objects, states } = store(ns);
    const sm = new StateManager(adapter as never, new DeviceRegistry({ data: { devices: {} } }));
    const device = light();
    const prefix = `${ns}.${sm.devicePrefix(device)}`;
    objects.set(`${prefix}.diag`, { type: "channel", common: { name: "Diagnostics" } });
    objects.set(`${prefix}.diag.tier`, {
      type: "state",
      common: { name: "Tier", type: "string", custom: { "influxdb.0": { enabled: true } } },
    });
    states.set(`${prefix}.diag.tier`, { val: "seed", ack: true });
    // the build that runs the migration has created the new datapoint already
    objects.set(`${prefix}.info.tier`, { type: "state", common: { name: "Tier", type: "string" } });

    await sm.migrateLegacyDiagnostics(device);

    // positive control: the move ran — the recording went along to info.tier
    expect((objects.get(`${prefix}.info.tier`)?.common as { custom?: unknown }).custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: `${prefix}.diag.tier` },
    });
    expect(objects.has(`${prefix}.diag.tier`)).toBe(false);
    expect(states.has(`${prefix}.diag.tier`)).toBe(false);
    expect(objects.has(`${prefix}.diag`)).toBe(false);
  });
});
