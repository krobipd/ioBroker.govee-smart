// GV-06 — Local snapshots are a device's saved settings, shortcuts so to speak. They live in the device itself: no folder
// "snapshots" below the instance root, no datapoint "snapshots.store". They have nothing to do with the diagnostics report.
// krobi 2026-09-14 23:11: "both have their home in the device. so why do they exist at the root"; 23:19: "nobody needs
// snapshots.store"; 2026-10-07 10:09: "local snapshots are something else … saved settings/shortcuts"
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSnapshotStore, type LocalSnapshot, type LocalSnapshotStoreAdapter } from "../lib/local-snapshots";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

interface Recorded {
  extended: Array<{ id: string; native: Record<string, unknown> }>;
  deleted: string[];
}

function store(withLegacyRoot: boolean): { store: LocalSnapshotStore; rec: Recorded } {
  const rec: Recorded = { extended: [], deleted: [] };
  const adapter: LocalSnapshotStoreAdapter = {
    namespace: "govee-smart.0",
    getObjectViewAsync: () =>
      Promise.resolve({ rows: [{ id: "govee-smart.0.devices.h6172-0006", value: { native: {} } }] }),
    getObjectAsync: (id: string) =>
      Promise.resolve(id === "snapshots" ? (withLegacyRoot ? { type: "meta" } : null) : { type: "device" }),
    extendObject: (id, obj) => {
      rec.extended.push({ id, native: obj.native });
      return Promise.resolve();
    },
    readDirAsync: () => Promise.resolve([]),
    readFileAsync: () => Promise.reject(new Error("no file")),
    delFileAsync: () => Promise.resolve(),
    delObjectAsync: (id: string) => {
      rec.deleted.push(id);
      return Promise.resolve();
    },
  };
  return { store: new LocalSnapshotStore(adapter, log, { idFor: () => "h6172-0006" }), rec };
}

const snapshot: LocalSnapshot = {
  name: "Evening",
  power: true,
  brightness: 40,
  colorRgb: "#ff8800",
  colorTemperature: 0,
  savedAt: 1,
};

describe("GV-06 local snapshots live in the device", () => {
  it("a saved snapshot is written into the device object's native.localSnapshots — nowhere else", async () => {
    const { store: s, rec } = store(false);
    await s.init();
    await s.saveSnapshot("H6172", "AA:BB:CC:DD:EE:FF:00:06", snapshot);
    expect(rec.extended).toHaveLength(1);
    expect(rec.extended[0].id).toBe("devices.h6172-0006");
    expect(Object.keys(rec.extended[0].native)).toEqual(["localSnapshots"]);
    expect(JSON.parse(String(rec.extended[0].native.localSnapshots)).snapshots[0].name).toBe("Evening");
  });

  it("a root folder 'snapshots' left by an older version is removed at start", async () => {
    const { store: s, rec } = store(true);
    await s.init();
    expect(rec.deleted).toContain("snapshots");
  });

  it("the instance objects declare neither a root 'snapshots' nor 'snapshots.store'", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "io-package.json"), "utf-8")) as {
      instanceObjects?: Array<{ _id: string }>;
    };
    const ids = (manifest.instanceObjects ?? []).map(o => o._id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter(id => id === "snapshots" || id.startsWith("snapshots."))).toEqual([]);
  });
});
