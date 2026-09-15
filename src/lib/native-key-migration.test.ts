import { describe, expect, it } from "vitest";
import { migrateNativeKeys, NATIVE_KEY_RENAMES, type NativeKeyMigrationAdapter } from "./native-key-migration";

interface Rig {
  adapter: NativeKeyMigrationAdapter;
  writes: Array<{ id: string; native: Record<string, unknown> }>;
  logs: string[];
}

/**
 * An adapter whose instance object carries the given `native` block.
 *
 * @param native the instance object's native block — `null` = object missing
 * @param failing reject every object read (the database is away)
 * @returns the rig
 */
function makeRig(native: Record<string, unknown> | null, failing = false): Rig {
  const writes: Rig["writes"] = [];
  const logs: string[] = [];
  const adapter: NativeKeyMigrationAdapter = {
    namespace: "govee-smart.0",
    log: {
      info: (msg: string) => {
        logs.push(`info:${msg}`);
      },
      debug: (msg: string) => {
        logs.push(`debug:${msg}`);
      },
    },
    getForeignObjectAsync: (id: string) => {
      if (failing) {
        return Promise.reject(new Error("objects db is away"));
      }
      expect(id).toBe("system.adapter.govee-smart.0");
      return Promise.resolve(native === null ? null : { native });
    },
    extendForeignObjectAsync: (id: string, obj: { native: Record<string, unknown> }) => {
      writes.push({ id, native: obj.native });
      return Promise.resolve();
    },
  };
  return { adapter, writes, logs };
}

describe("migrateNativeKeys", () => {
  it("carries the old listen-address key into bind and deletes the old key — restart follows", async () => {
    // After the upgrade js-controller has added `bind` with the manifest default
    // and left `networkInterface` untouched: both keys, the user's value under the old one.
    const rig = makeRig({ networkInterface: "192.168.1.9", bind: "0.0.0.0", apiKey: "k" });
    expect(await migrateNativeKeys(rig.adapter)).toBe(true);
    expect(rig.writes).toEqual([
      { id: "system.adapter.govee-smart.0", native: { bind: "192.168.1.9", networkInterface: null } },
    ]);
    expect(rig.logs).toEqual([
      "info:Carrying settings over from an earlier version (networkInterface → bind) — this instance restarts once",
    ]);
  });

  it("removes an old key that carries nothing worth keeping and leaves the new default alone", async () => {
    const rig = makeRig({ networkInterface: "", bind: "0.0.0.0" });
    expect(await migrateNativeKeys(rig.adapter)).toBe(true);
    expect(rig.writes).toEqual([{ id: "system.adapter.govee-smart.0", native: { networkInterface: null } }]);
    expect(rig.logs[0]).toMatch(/^info:Removing settings keys of an earlier version/);
  });

  it("does nothing on an instance that never had the old key — a fresh install starts without a restart", async () => {
    const rig = makeRig({ bind: "0.0.0.0", port: 4002, apiKey: "" });
    expect(await migrateNativeKeys(rig.adapter)).toBe(false);
    expect(rig.writes).toEqual([]);
    expect(rig.logs).toEqual([]);
  });

  it("runs once: after the write the old key is gone and the next start finds nothing to do", async () => {
    const first = makeRig({ networkInterface: "10.0.0.5", bind: "0.0.0.0" });
    expect(await migrateNativeKeys(first.adapter)).toBe(true);
    const afterRestart = { bind: "10.0.0.5" }; // what the extend left behind: value carried, old key deleted
    const second = makeRig(afterRestart);
    expect(await migrateNativeKeys(second.adapter)).toBe(false);
    expect(second.writes).toEqual([]);
  });

  it("drops a value of the wrong type instead of writing it into the new key", async () => {
    const rig = makeRig({ networkInterface: 42, bind: "0.0.0.0" });
    expect(await migrateNativeKeys(rig.adapter)).toBe(true);
    expect(rig.writes[0]?.native).toEqual({ networkInterface: null });
  });

  it("treats an unreadable instance object as nothing to migrate and says so on debug", async () => {
    const away = makeRig(null, true);
    expect(await migrateNativeKeys(away.adapter)).toBe(false);
    expect(away.writes).toEqual([]);
    expect(away.logs).toEqual(["debug:Could not migrate the settings keys: objects db is away"]);
    const missing = makeRig(null);
    expect(await migrateNativeKeys(missing.adapter)).toBe(false);
  });

  it("applies every rename of the list in one write", async () => {
    const rig = makeRig({ a: "x", b: 7, keep: true });
    const renames = [
      { from: "a", to: "alpha", coerce: (v: unknown) => v },
      { from: "b", to: "beta", coerce: (v: unknown) => (typeof v === "number" ? String(v) : undefined) },
      { from: "c", to: "gamma", coerce: (v: unknown) => v },
    ];
    expect(await migrateNativeKeys(rig.adapter, renames)).toBe(true);
    expect(rig.writes).toEqual([
      { id: "system.adapter.govee-smart.0", native: { alpha: "x", a: null, beta: "7", b: null } },
    ]);
  });

  it("declares exactly the 2.37.0 rename networkInterface → bind", () => {
    expect(NATIVE_KEY_RENAMES.map(r => [r.from, r.to])).toEqual([["networkInterface", "bind"]]);
    const [rename] = NATIVE_KEY_RENAMES;
    expect(rename?.coerce(" 192.168.1.9 ")).toBe("192.168.1.9");
    expect(rename?.coerce("   ")).toBeUndefined();
    expect(rename?.coerce(null)).toBeUndefined();
  });
});
