import { describe, expect, it } from "vitest";
import { DeviceIdRegistry } from "./device-id";
import { migrateDeviceIds, type IdMigrationDeps } from "./device-id-migration";

const NS = "govee-smart.0";
const A_ID = "AB:CD:EF:12:34:56:52:5F";
const B_ID = "11:22:33:44:55:66:52:5F";

/** An object and state store that behaves like the controller for what the migration uses. */
class Db {
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, ioBroker.State>();
  readonly enums = new Map<string, { common: { members: string[] } }>();
  readonly logs: string[] = [];
  /** Every id the migration deleted, in order. */
  readonly deleted: string[] = [];
  failMoveOf: string | undefined;

  deps(): IdMigrationDeps {
    return {
      namespace: NS,
      objects: () => Promise.resolve(structuredClone(Object.fromEntries(this.objects))),
      deviceObjects: () =>
        Promise.resolve(structuredClone(Object.fromEntries([...this.objects].filter(([, o]) => o.type === "device")))),
      states: pattern => {
        const prefix = pattern.replace(/\*$/, "");
        return Promise.resolve(
          structuredClone(Object.fromEntries([...this.states].filter(([id]) => id.startsWith(prefix)))),
        );
      },
      setObject: (id, obj) => {
        if (this.failMoveOf && id.startsWith(this.failMoveOf)) {
          return Promise.reject(new Error("object store refused"));
        }
        this.objects.set(id, structuredClone(obj) as ioBroker.Object);
        return Promise.resolve();
      },
      extendObject: (id, patch) => {
        const existing = (this.objects.get(id) ?? {}) as unknown as Record<string, Record<string, unknown>>;
        const p = patch as unknown as Record<string, Record<string, unknown>>;
        this.objects.set(id, {
          ...existing,
          ...p,
          common: { ...(existing.common ?? {}), ...(p.common ?? {}) },
          native: { ...(existing.native ?? {}), ...(p.native ?? {}) },
        } as unknown as ioBroker.Object);
        return Promise.resolve();
      },
      setState: (id, state) => {
        this.states.set(id, structuredClone(state) as ioBroker.State);
        return Promise.resolve();
      },
      aliases: () =>
        Promise.resolve(
          structuredClone(Object.fromEntries([...this.objects].filter(([id]) => id.startsWith("alias.")))),
        ),
      removeCarryingEnums: (ids, successors) => {
        let carried = 0;
        for (const e of this.enums.values()) {
          const next: string[] = [];
          for (const member of e.common.members) {
            if (ids.includes(member)) {
              for (const id of successors(member)) {
                next.push(id);
                carried++;
              }
            } else {
              next.push(member);
            }
          }
          e.common.members = next;
        }
        for (const id of ids) {
          this.deleted.push(id);
          this.objects.delete(id);
          this.states.delete(id);
        }
        return Promise.resolve(carried);
      },
      log: {
        info: m => this.logs.push(`info: ${m}`),
        debug: m => this.logs.push(`debug: ${m}`),
        warn: m => this.logs.push(`warn: ${m}`),
      },
    };
  }

  /**
   * A 2.x light tree: device, info channel, power with a recording, and its value.
   *
   * @param rel the tree
   * @param deviceId Govee's device id
   * @param native extra device-object native
   */
  tree(rel: string, deviceId: string, native: Record<string, unknown> = {}): void {
    const full = `${NS}.${rel}`;
    this.objects.set(full, {
      type: "device",
      common: { name: "Couch", statusStates: { onlineId: `${full}.info.online` } },
      native: { sku: "H61BE", deviceId, ...native },
    } as unknown as ioBroker.Object);
    this.objects.set(`${full}.control`, {
      type: "channel",
      common: { name: "Control" },
      native: {},
    } as ioBroker.Object);
    this.objects.set(`${full}.control.power`, {
      type: "state",
      common: {
        name: "Power",
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
        custom: { "influxdb.0": { enabled: true } },
      },
      native: {},
    } as unknown as ioBroker.Object);
    this.states.set(`${full}.control.power`, { val: true, ack: true, ts: 11, lc: 7, q: 0 } as ioBroker.State);
  }
}

describe("migrateDeviceIds", () => {
  it("moves a 2.x tree to its id with values, recordings, aliases and rooms, and says so", async () => {
    const db = new Db();
    db.tree("devices.h61be_525f", A_ID);
    db.objects.set("alias.0.couch.power", {
      type: "state",
      common: { name: "Couch", alias: { id: `${NS}.devices.h61be_525f.control.power` } },
      native: {},
    } as unknown as ioBroker.Object);
    db.enums.set("enum.rooms.living", { common: { members: [`${NS}.devices.h61be_525f`, "hm-rpc.0.X"] } });
    const ids = new DeviceIdRegistry();

    expect(await migrateDeviceIds(db.deps(), ids)).toBe(1);

    const NEW = `${NS}.devices.h61be-525f`;
    expect(db.objects.has(`${NS}.devices.h61be_525f`)).toBe(false);
    expect(db.objects.get(NEW)?.native).toMatchObject({ sku: "H61BE", deviceId: A_ID, idScheme: 3 });
    expect(db.objects.get(NEW)?.native).not.toHaveProperty("movingTo");
    expect((db.objects.get(NEW)?.common as { statusStates: { onlineId: string } }).statusStates.onlineId).toBe(
      `${NEW}.info.online`,
    );
    expect(db.states.get(`${NEW}.control.power`)).toMatchObject({ val: true, ack: true, ts: 11, lc: 7, q: 0 });
    expect((db.objects.get(`${NEW}.control.power`)?.common as { custom: unknown }).custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: `${NS}.devices.h61be_525f.control.power` },
    });
    expect((db.objects.get("alias.0.couch.power")?.common as { alias: { id: string } }).alias.id).toBe(
      `${NEW}.control.power`,
    );
    expect(db.enums.get("enum.rooms.living")?.common.members).toEqual([NEW, "hm-rpc.0.X"]);
    expect(ids.prefixFor("H61BE", A_ID)).toBe("devices.h61be-525f");
    expect(db.logs.filter(l => l.startsWith("info"))).toEqual([
      'info: Device "Couch": object ID is now devices.h61be-525f (was devices.h61be_525f) — moved 1 datapoint(s) with 1 room/function entry and 1 alias(es); 1 recording(s) keep their history',
    ]);
  });

  it("records a tree that already carries the mark and moves nothing", async () => {
    const db = new Db();
    db.tree("devices.h61be-525f", A_ID, { idScheme: 3 });
    const before = structuredClone(Object.fromEntries(db.objects));
    const ids = new DeviceIdRegistry();
    expect(await migrateDeviceIds(db.deps(), ids)).toBe(0);
    expect(Object.fromEntries(db.objects)).toEqual(before);
    expect(ids.prefixFor("H61BE", A_ID)).toBe("devices.h61be-525f");
  });

  it("gives an old tree the long form when a marked tree of another device holds the short one", async () => {
    const db = new Db();
    db.tree("devices.h61be-525f", B_ID, { idScheme: 3 });
    db.tree("devices.h61be_525f", A_ID);
    const ids = new DeviceIdRegistry();
    await migrateDeviceIds(db.deps(), ids);
    expect(db.objects.get(`${NS}.devices.h61be-525f`)?.native).toMatchObject({ deviceId: B_ID });
    expect(db.objects.get(`${NS}.devices.h61be-abcdef123456525f`)?.native).toMatchObject({
      deviceId: A_ID,
      idScheme: 3,
    });
  });

  it("decides the order by Govee's device id, not by the listing", async () => {
    // Two old trees of one model whose ids end alike (a 2.x install could only have them when one
    // device was renamed in between — the order of the listing must not pick the winner).
    const db = new Db();
    db.tree("devices.zz_old", B_ID);
    db.tree("devices.aa_old", A_ID);
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    // 1122… sorts before abcd…: the device B keeps the short form.
    expect(db.objects.get(`${NS}.devices.h61be-525f`)?.native).toMatchObject({ deviceId: B_ID });
    expect(db.objects.get(`${NS}.devices.h61be-abcdef123456525f`)?.native).toMatchObject({ deviceId: A_ID });
  });

  it("finishes an interrupted move to the journal's target", async () => {
    const db = new Db();
    // The journal names a target the rule would not pick today — the journal decides.
    db.tree("devices.h61be_525f", A_ID, { movingTo: "devices.h61be-abcdef123456525f" });
    db.objects.set(`${NS}.devices.h61be-abcdef123456525f.control`, {
      type: "channel",
      common: { name: "Control" },
      native: {},
    } as ioBroker.Object);
    const ids = new DeviceIdRegistry();
    await migrateDeviceIds(db.deps(), ids);
    expect(db.objects.has(`${NS}.devices.h61be_525f`)).toBe(false);
    expect(db.objects.get(`${NS}.devices.h61be-abcdef123456525f`)?.native).toMatchObject({ idScheme: 3 });
    expect(ids.prefixFor("H61BE", A_ID)).toBe("devices.h61be-abcdef123456525f");
  });

  it("lets a leftover of a device whose tree is in place only fill in what is missing", async () => {
    const db = new Db();
    db.tree("devices.h61be-525f", A_ID, { idScheme: 3 });
    db.states.set(`${NS}.devices.h61be-525f.control.power`, { val: false, ack: true, ts: 99 } as ioBroker.State);
    db.tree("devices.h61be_525f", A_ID, { movingTo: "devices.h61be-525f" });
    db.objects.set(`${NS}.devices.h61be_525f.control.brightness`, {
      type: "state",
      common: { name: "Brightness", type: "number" },
      native: {},
    } as unknown as ioBroker.Object);
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    expect(db.objects.has(`${NS}.devices.h61be_525f`)).toBe(false);
    // The kept tree's value wins; the missing datapoint arrives.
    expect(db.states.get(`${NS}.devices.h61be-525f.control.power`)?.val).toBe(false);
    expect(db.objects.has(`${NS}.devices.h61be-525f.control.brightness`)).toBe(true);
    expect(db.logs).toContain(
      'info: Device "Couch": finished the interrupted move of devices.h61be_525f to devices.h61be-525f',
    );
  });

  it("only marks a tree that already sits under its id", async () => {
    const db = new Db();
    db.tree("devices.h61be-525f", A_ID);
    expect(await migrateDeviceIds(db.deps(), new DeviceIdRegistry())).toBe(0);
    expect(db.objects.get(`${NS}.devices.h61be-525f`)?.native).toMatchObject({ idScheme: 3 });
    expect(db.states.get(`${NS}.devices.h61be-525f.control.power`)?.val).toBe(true);
  });

  it("moves groups inside groups.", async () => {
    const db = new Db();
    db.objects.set(`${NS}.groups.basegroup_1311`, {
      type: "device",
      common: { name: "Living" },
      native: { sku: "BaseGroup", deviceId: "9901311" },
    } as unknown as ioBroker.Object);
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    expect(db.objects.get(`${NS}.groups.basegroup-1311`)?.native).toMatchObject({ idScheme: 3 });
  });

  it("leaves pseudo-devices, trees without a device id and foreign objects alone", async () => {
    const db = new Db();
    const pseudo = { type: "device", common: { name: "S" }, native: { sku: "SameModeGroup", deviceId: "9100" } };
    const nameless = { type: "device", common: { name: "N" }, native: { sku: "H6160" } };
    db.objects.set(`${NS}.devices.samemodegroup_9100`, pseudo as unknown as ioBroker.Object);
    db.objects.set(`${NS}.devices.h6160_0011`, nameless as unknown as ioBroker.Object);
    db.objects.set("other.0.devices.h61be_525f", {
      type: "device",
      common: { name: "X" },
      native: { sku: "H61BE", deviceId: A_ID },
    } as unknown as ioBroker.Object);
    expect(await migrateDeviceIds(db.deps(), new DeviceIdRegistry())).toBe(0);
    expect(db.objects.has(`${NS}.devices.samemodegroup_9100`)).toBe(true);
    expect(db.objects.has(`${NS}.devices.h6160_0011`)).toBe(true);
    expect(db.objects.has("other.0.devices.h61be_525f")).toBe(true);
  });

  it("takes only a device object for a tree — a channel that names a device is not one", async () => {
    const db = new Db();
    db.objects.set(`${NS}.devices.h61be_525f`, {
      type: "channel",
      common: { name: "Stray" },
      native: { sku: "H61BE", deviceId: A_ID },
    } as unknown as ioBroker.Object);
    expect(await migrateDeviceIds(db.deps(), new DeviceIdRegistry())).toBe(0);
    expect(db.objects.has(`${NS}.devices.h61be_525f`)).toBe(true);
    expect(db.objects.has(`${NS}.devices.h61be-525f`)).toBe(false);
  });

  it("keeps going when one tree cannot be moved, and keeps that one for the next start", async () => {
    const db = new Db();
    db.tree("devices.h61be_525f", A_ID);
    db.objects.set(`${NS}.devices.h6160_0011`, {
      type: "device",
      common: { name: "Desk" },
      native: { sku: "H6160", deviceId: "AA:BB:CC:DD:EE:FF:00:11" },
    } as unknown as ioBroker.Object);
    db.failMoveOf = `${NS}.devices.h61be-525f`;
    expect(await migrateDeviceIds(db.deps(), new DeviceIdRegistry())).toBe(1);
    expect(db.objects.has(`${NS}.devices.h61be_525f`)).toBe(true);
    expect(db.objects.get(`${NS}.devices.h61be_525f`)?.native).toMatchObject({ movingTo: "devices.h61be-525f" });
    expect(db.objects.has(`${NS}.devices.h6160-0011`)).toBe(true);
    expect(db.logs.some(l => l.startsWith('warn: Device "Couch": could not move devices.h61be_525f'))).toBe(true);
  });

  it("a tree that cannot move stays under its old id this session, unmarked — the next start moves it with its recording (M8, 3.1.0)", async () => {
    const db = new Db();
    db.tree("devices.h61be_525f", A_ID);
    db.failMoveOf = `${NS}.devices.h61be-525f`;
    const first = new DeviceIdRegistry();
    await migrateDeviceIds(db.deps(), first);
    expect(first.prefixFor("H61BE", A_ID)).toBe("devices.h61be_525f");
    expect(first.isUnmoved("devices.h61be_525f")).toBe(true);
    // Next start, the store works again: the move completes and the recording travels with power.
    db.failMoveOf = undefined;
    const second = new DeviceIdRegistry();
    expect(await migrateDeviceIds(db.deps(), second)).toBe(1);
    expect(second.prefixFor("H61BE", A_ID)).toBe("devices.h61be-525f");
    const custom = (db.objects.get(`${NS}.devices.h61be-525f.control.power`)?.common as { custom?: unknown }).custom;
    expect(custom).toEqual({ "influxdb.0": { enabled: true, aliasId: `${NS}.devices.h61be_525f.control.power` } });
  });

  it("deletes the old tree deepest first and the root with its journal last (M9, round 72)", async () => {
    const db = new Db();
    db.tree("devices.h61be_525f", A_ID);
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    const old = `${NS}.devices.h61be_525f`;
    expect(db.deleted.at(-1)).toBe(old);
    expect(db.deleted.indexOf(`${old}.control.power`)).toBeLessThan(db.deleted.indexOf(`${old}.control`));
  });

  it("a leftover hands its recording to the kept datapoint that has none — the same datapoint lives on (M8, 3.1.0)", async () => {
    const db = new Db();
    // A tree a session built after a failed move: no recording on power.
    db.tree("devices.h61be-525f", A_ID, { idScheme: 3 });
    const kept = db.objects.get(`${NS}.devices.h61be-525f.control.power`)!;
    delete (kept.common as { custom?: unknown }).custom;
    db.tree("devices.h61be_525f", A_ID, { movingTo: "devices.h61be-525f" });
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    const custom = (db.objects.get(`${NS}.devices.h61be-525f.control.power`)?.common as { custom?: unknown }).custom;
    expect(custom).toEqual({ "influxdb.0": { enabled: true, aliasId: `${NS}.devices.h61be_525f.control.power` } });
  });

  it("a leftover never overwrites a recording the kept datapoint already has", async () => {
    const db = new Db();
    db.tree("devices.h61be-525f", A_ID, { idScheme: 3 });
    const kept = db.objects.get(`${NS}.devices.h61be-525f.control.power`)!;
    (kept.common as { custom?: unknown }).custom = { "history.0": { enabled: true } };
    db.tree("devices.h61be_525f", A_ID, { movingTo: "devices.h61be-525f" });
    await migrateDeviceIds(db.deps(), new DeviceIdRegistry());
    const custom = (db.objects.get(`${NS}.devices.h61be-525f.control.power`)?.common as { custom?: unknown }).custom;
    expect(custom).toEqual({ "history.0": { enabled: true } });
  });
});
