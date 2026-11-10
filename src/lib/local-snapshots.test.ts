import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSnapshotStore, type LocalSnapshot, type LocalSnapshotStoreAdapter } from "./local-snapshots";
import { mockLog } from "../../test/test-helpers";
import { DeviceIdRegistry } from "./device-id";

type StoredObject = { type?: string; common?: Record<string, unknown>; native?: Record<string, unknown> };

/**
 * In-memory stand-in for the object database and — for the carry-over of
 * 2.11.0–2.36.0 — the root file store. Objects are keyed by their id relative
 * to the namespace; files by `<meta>/<filename>`. `extendObject` deep-merges
 * like js-controller does, so a test sees whether a foreign `native` key
 * survives a write.
 *
 * @param namespace Adapter namespace
 */
function createMockAdapter(namespace = "govee-smart.0"): {
  adapter: LocalSnapshotStoreAdapter;
  objects: Map<string, StoredObject>;
  files: Map<string, string>;
  extendCalls: Array<{ id: string; obj: { native: Record<string, unknown> } }>;
} {
  const objects = new Map<string, StoredObject>();
  const files = new Map<string, string>();
  const extendCalls: Array<{ id: string; obj: { native: Record<string, unknown> } }> = [];
  const rel = (id: string): string => id.replace(`${namespace}.`, "");
  const key = (meta: string, name: string): string => `${meta}/${name}`;
  return {
    objects,
    files,
    extendCalls,
    adapter: {
      namespace,
      getObjectViewAsync(_design, type, params) {
        const prefix = rel(params.startkey);
        const rows: Array<{ id: string; value: StoredObject }> = [];
        for (const [id, obj] of objects) {
          if (id.startsWith(prefix) && obj.type === type) {
            rows.push({ id: `${namespace}.${id}`, value: structuredClone(obj) });
          }
        }
        return Promise.resolve({ rows });
      },
      getObjectAsync(id) {
        return Promise.resolve(structuredClone(objects.get(rel(id)) ?? null));
      },
      extendObject(id, obj) {
        extendCalls.push({ id, obj });
        const existing = objects.get(rel(id)) ?? {};
        objects.set(rel(id), { ...existing, native: { ...(existing.native ?? {}), ...obj.native } });
        return Promise.resolve();
      },
      readFileAsync(meta, name) {
        const k = key(meta, name);
        if (!files.has(k)) {
          return Promise.reject(new Error(`ENOENT: ${k}`));
        }
        return Promise.resolve({ file: files.get(k)!, mimeType: "application/json" });
      },
      delFileAsync(meta, name) {
        files.delete(key(meta, name));
        return Promise.resolve();
      },
      readDirAsync(meta) {
        const prefix = `${meta}/`;
        const entries: { file: string; isDir: boolean }[] = [];
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) {
            entries.push({ file: k.slice(prefix.length), isDir: false });
          }
        }
        return Promise.resolve(entries);
      },
      delObjectAsync(id) {
        objects.delete(rel(id));
        return Promise.resolve();
      },
    },
  };
}

/**
 * A device object as the state manager writes it — the store must not touch anything but `native.localSnapshots`.
 *
 * @param sku Product model
 * @param deviceId Device identifier
 * @param name The user's device name
 */
function deviceObject(sku: string, deviceId: string, name: string): StoredObject {
  return { type: "device", common: { name, icon: "data:…" }, native: { sku, deviceId } };
}

/**
 * The two devices every test may write to.
 *
 * @param objects The rig's object map
 */
function seedDevices(objects: Map<string, StoredObject>): void {
  objects.set("devices.h6160-0011", deviceObject("H6160", "AABBCCDDEEFF0011", "Strip"));
  objects.set("devices.h6160-2222", deviceObject("H6160", "AABBCCDDEEFF2222", "Bulb"));
}

/**
 * What the device object carries after the store wrote it.
 *
 * @param objects The rig's object map
 * @param key Object id relative to the namespace
 */
function storedList(objects: Map<string, StoredObject>, key: string): unknown {
  const raw = objects.get(key)?.native?.localSnapshots;
  return typeof raw === "string" && raw !== "" ? (JSON.parse(raw) as { snapshots: unknown }).snapshots : raw;
}

describe("LocalSnapshotStore", () => {
  let store: LocalSnapshotStore;
  let objects: Map<string, StoredObject>;

  beforeEach(async () => {
    const mock = createMockAdapter();
    objects = mock.objects;
    seedDevices(objects);
    store = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await store.init();
  });

  it("should return empty array for device with no snapshots", () => {
    const snaps = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(snaps).toEqual([]);
  });

  it("should save and retrieve a snapshot", async () => {
    const snap: LocalSnapshot = {
      name: "Abendstimmung",
      power: true,
      brightness: 80,
      colorRgb: "#ff6600",
      colorTemperature: 0,
      savedAt: 1712700000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Abendstimmung");
    expect(result[0].power).toBe(true);
    expect(result[0].brightness).toBe(80);
    expect(result[0].colorRgb).toBe("#ff6600");
    expect(result[0].colorTemperature).toBe(0);
  });

  it("should overwrite snapshot with same name", async () => {
    const snap1: LocalSnapshot = {
      name: "Test",
      power: true,
      brightness: 50,
      colorRgb: "#ff0000",
      colorTemperature: 0,
      savedAt: 1000,
    };
    const snap2: LocalSnapshot = {
      name: "Test",
      power: false,
      brightness: 0,
      colorRgb: "#000000",
      colorTemperature: 0,
      savedAt: 2000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(1);
    expect(result[0].power).toBe(false);
    expect(result[0].savedAt).toBe(2000);
  });

  it("should store multiple snapshots", async () => {
    const snap1: LocalSnapshot = {
      name: "Morning",
      power: true,
      brightness: 100,
      colorRgb: "#ffffff",
      colorTemperature: 6500,
      savedAt: 1000,
    };
    const snap2: LocalSnapshot = {
      name: "Night",
      power: true,
      brightness: 10,
      colorRgb: "#ff3300",
      colorTemperature: 0,
      savedAt: 2000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Morning");
    expect(result[1].name).toBe("Night");
  });

  it("should delete a snapshot by name", async () => {
    const snap: LocalSnapshot = {
      name: "ToDelete",
      power: true,
      brightness: 50,
      colorRgb: "#aabbcc",
      colorTemperature: 0,
      savedAt: 1000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    const deleted = await store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "ToDelete");
    expect(deleted).toBe(true);

    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(0);
  });

  it("should return false when deleting non-existent snapshot", async () => {
    const deleted = await store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "Nope");
    expect(deleted).toBe(false);
  });

  it("should keep separate lists per device", async () => {
    const snap1: LocalSnapshot = {
      name: "Device1Snap",
      power: true,
      brightness: 50,
      colorRgb: "#ff0000",
      colorTemperature: 0,
      savedAt: 1000,
    };
    const snap2: LocalSnapshot = {
      name: "Device2Snap",
      power: false,
      brightness: 0,
      colorRgb: "#00ff00",
      colorTemperature: 4000,
      savedAt: 2000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
    await store.saveSnapshot("H6160", "AABBCCDDEEFF2222", snap2);

    const result1 = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    const result2 = store.getSnapshots("H6160", "AABBCCDDEEFF2222");
    expect(result1).toHaveLength(1);
    expect(result1[0].name).toBe("Device1Snap");
    expect(result2).toHaveLength(1);
    expect(result2[0].name).toBe("Device2Snap");
  });

  it("should handle corrupt JSON gracefully on init", async () => {
    // A damaged device object must not take the store down — that device
    // simply has no snapshots until the next save.
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.get("devices.h6160-0011")!.native!.localSnapshots = "NOT JSON!";
    const corruptStore = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await corruptStore.init();
    expect(corruptStore.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("should return empty array when snapshots field is not an array", async () => {
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.get("devices.h6160-0011")!.native!.localSnapshots = JSON.stringify({ snapshots: "hello" });
    const driftStore = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await driftStore.init();
    expect(driftStore.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("should return empty array when the field holds something that is not text", async () => {
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.get("devices.h6160-0011")!.native!.localSnapshots = { snapshots: [] };
    const driftStore = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await driftStore.init();
    expect(driftStore.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("should save and retrieve snapshot with segment data", async () => {
    const snap: LocalSnapshot = {
      name: "Segments",
      power: true,
      brightness: 80,
      colorRgb: "#ff6600",
      colorTemperature: 0,
      segments: [
        { color: "#ff0000", brightness: 100 },
        { color: "#00ff00", brightness: 50 },
        { color: "#0000ff", brightness: 75 },
      ],
      savedAt: 3000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(1);
    expect(result[0].segments).toHaveLength(3);
    expect(result[0].segments![0]).toEqual({ color: "#ff0000", brightness: 100 });
    expect(result[0].segments![1]).toEqual({ color: "#00ff00", brightness: 50 });
    expect(result[0].segments![2]).toEqual({ color: "#0000ff", brightness: 75 });
  });

  it("should handle snapshot without segments (backwards compatible)", async () => {
    const snap: LocalSnapshot = {
      name: "NoSegments",
      power: true,
      brightness: 50,
      colorRgb: "#ffffff",
      colorTemperature: 4000,
      savedAt: 4000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result[0].segments).toBeUndefined();
  });

  it("should overwrite segment data when updating snapshot", async () => {
    const snap1: LocalSnapshot = {
      name: "SegUpdate",
      power: true,
      brightness: 80,
      colorRgb: "#ff0000",
      colorTemperature: 0,
      segments: [{ color: "#ff0000", brightness: 100 }],
      savedAt: 1000,
    };
    const snap2: LocalSnapshot = {
      name: "SegUpdate",
      power: true,
      brightness: 80,
      colorRgb: "#00ff00",
      colorTemperature: 0,
      segments: [
        { color: "#00ff00", brightness: 50 },
        { color: "#0000ff", brightness: 25 },
      ],
      savedAt: 2000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result).toHaveLength(1);
    expect(result[0].segments).toHaveLength(2);
    expect(result[0].segments![0].color).toBe("#00ff00");
  });

  it("should preserve color temperature in snapshot", async () => {
    const snap: LocalSnapshot = {
      name: "Warm",
      power: true,
      brightness: 60,
      colorRgb: "#000000",
      colorTemperature: 3200,
      savedAt: 1000,
    };

    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
    expect(result[0].colorTemperature).toBe(3200);
  });

  it("should not throw when deviceId is non-string", () => {
    expect(() => store.getSnapshots("H6160", 12345 as unknown as string)).not.toThrow();
  });

  it("should not throw when sku is non-string", () => {
    expect(() => store.getSnapshots(null as unknown as string, "AABBCCDDEEFF0011")).not.toThrow();
  });

  it("clears the field when the last snapshot of a device is deleted", async () => {
    const snap: LocalSnapshot = {
      name: "Single",
      power: true,
      brightness: 50,
      colorRgb: "#ffffff",
      colorTemperature: 0,
      savedAt: 1000,
    };
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    expect(storedList(objects, "devices.h6160-0011")).toEqual([snap]);
    await store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "Single");
    // `extendObject` cannot remove a key — the empty list is written as "".
    expect(objects.get("devices.h6160-0011")!.native!.localSnapshots).toBe("");
  });

  it("writes nothing but native.localSnapshots — name, icon and identity stay", async () => {
    // The state manager owns the device object; the store is a guest in its
    // `native`. A write that carried `common` would replace the user's name.
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    const s = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await s.init();
    await s.saveSnapshot("H6160", "AABBCCDDEEFF0011", {
      name: "Evening",
      power: true,
      brightness: 30,
      colorRgb: "#ff8800",
      colorTemperature: 0,
      savedAt: 5,
    });
    expect(mock.extendCalls).toHaveLength(1);
    expect(mock.extendCalls[0].id).toBe("devices.h6160-0011");
    expect(Object.keys(mock.extendCalls[0].obj)).toEqual(["native"]);
    expect(Object.keys(mock.extendCalls[0].obj.native)).toEqual(["localSnapshots"]);
    const obj = mock.objects.get("devices.h6160-0011")!;
    expect(obj.common).toEqual({ name: "Strip", icon: "data:…" });
    expect(obj.native!.sku).toBe("H6160");
    expect(obj.native!.deviceId).toBe("AABBCCDDEEFF0011");
  });

  it("reads what a previous run stored on the device objects", async () => {
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    const snap = { name: "Kept", power: false, brightness: 0, colorRgb: "#000000", colorTemperature: 0, savedAt: 1 };
    mock.objects.get("devices.h6160-2222")!.native!.localSnapshots = JSON.stringify({ snapshots: [snap] });
    const s = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await s.init();
    expect(s.getSnapshots("H6160", "AABBCCDDEEFF2222")).toEqual([snap]);
    expect(s.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("refuses to write onto a device that is not in the tree", async () => {
    // A device that left the account has no object; writing `native` there
    // would create a bare object that nothing ever deletes.
    const warns: string[] = [];
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    const s = new LocalSnapshotStore(
      mock.adapter,
      { ...mockLog, warn: (m: string) => warns.push(m) },
      new DeviceIdRegistry(),
    );
    await s.init();
    await s.saveSnapshot("H7000", "AABBCCDDEEFF9999", {
      name: "Orphan",
      power: true,
      brightness: 1,
      colorRgb: "#000000",
      colorTemperature: 0,
      savedAt: 1,
    });
    expect(mock.objects.has("devices.h7000-9999")).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("devices.h7000-9999 does not exist");
  });

  it("stays closed when the device objects cannot be read", async () => {
    // An empty cache after a failed read would let the next save write that
    // emptiness over the device's real list.
    const warns: string[] = [];
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.adapter.getObjectViewAsync = () => Promise.reject(new Error("db down"));
    const s = new LocalSnapshotStore(
      mock.adapter,
      { ...mockLog, warn: (m: string) => warns.push(m) },
      new DeviceIdRegistry(),
    );
    await s.init();
    expect(warns[0]).toContain("device objects unreadable");
    await s.saveSnapshot("H6160", "AABBCCDDEEFF0011", {
      name: "Lost",
      power: true,
      brightness: 1,
      colorRgb: "#000000",
      colorTemperature: 0,
      savedAt: 1,
    });
    expect(mock.extendCalls).toHaveLength(0);
  });
});

describe("LocalSnapshotStore — carry-over from the stores of earlier versions", () => {
  const snapA = { name: "A", power: true, brightness: 10, colorRgb: "#111111", colorTemperature: 0, savedAt: 1 };
  const snapB = { name: "B", power: false, brightness: 20, colorRgb: "#222222", colorTemperature: 2700, savedAt: 2 };

  it("moves the root-store files of 2.11.0–2.36.0 into the device objects and removes the folder", async () => {
    const infos: string[] = [];
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.set("snapshots", { type: "meta", common: { type: "meta.user" } });
    mock.files.set("govee-smart.0.snapshots/h6160_0011.json", JSON.stringify({ snapshots: [snapA] }, null, 2));
    mock.files.set("govee-smart.0.snapshots/h6160_2222.json", JSON.stringify({ snapshots: [snapB] }, null, 2));
    const s = new LocalSnapshotStore(
      mock.adapter,
      { ...mockLog, info: (m: string) => infos.push(m) },
      new DeviceIdRegistry(),
    );
    await s.init();

    expect(storedList(mock.objects, "devices.h6160-0011")).toEqual([snapA]);
    expect(storedList(mock.objects, "devices.h6160-2222")).toEqual([snapB]);
    expect(s.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([snapA]);
    expect(mock.files.size).toBe(0);
    expect(mock.objects.has("snapshots")).toBe(false);
    expect(infos.some(m => m.includes("moved into their device objects: 2 device(s)"))).toBe(true);
  });

  it("drops a file whose device is gone, says so, and still removes the folder", async () => {
    const infos: string[] = [];
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.set("snapshots", { type: "meta", common: { type: "meta.user" } });
    mock.files.set("govee-smart.0.snapshots/h7000_9999.json", JSON.stringify({ snapshots: [snapA] }));
    const s = new LocalSnapshotStore(
      mock.adapter,
      { ...mockLog, info: (m: string) => infos.push(m) },
      new DeviceIdRegistry(),
    );
    await s.init();
    expect(mock.objects.has("devices.h7000-9999")).toBe(false);
    expect(mock.files.size).toBe(0);
    expect(mock.objects.has("snapshots")).toBe(false);
    expect(infos.some(m => m.includes("h7000_9999.json") && m.includes("no longer in the account"))).toBe(true);
  });

  it("an unreadable file is dropped with a warning, the readable ones still move", async () => {
    const warns: string[] = [];
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    mock.objects.set("snapshots", { type: "meta", common: { type: "meta.user" } });
    mock.files.set("govee-smart.0.snapshots/h6160_0011.json", "NOT JSON!");
    mock.files.set("govee-smart.0.snapshots/h6160_2222.json", JSON.stringify({ snapshots: [snapB] }));
    const s = new LocalSnapshotStore(
      mock.adapter,
      { ...mockLog, warn: (m: string) => warns.push(m) },
      new DeviceIdRegistry(),
    );
    await s.init();
    expect(s.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
    expect(s.getSnapshots("H6160", "AABBCCDDEEFF2222")).toEqual([snapB]);
    expect(warns.some(m => m.includes("h6160_0011.json") && m.includes("unreadable"))).toBe(true);
    expect(mock.objects.has("snapshots")).toBe(false);
  });

  it("without the root object nothing is read or deleted — a fresh install", async () => {
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    let listed = 0;
    const inner = mock.adapter.readDirAsync;
    mock.adapter.readDirAsync = (meta, p) => {
      listed++;
      return inner(meta, p);
    };
    const s = new LocalSnapshotStore(mock.adapter, mockLog, new DeviceIdRegistry());
    await s.init();
    expect(listed).toBe(0);
  });
});

describe("LocalSnapshotStore — carry-over from the instance data directory of 2.10 and earlier", () => {
  const snapA = { name: "A", power: true, brightness: 10, colorRgb: "#111111", colorTemperature: 0, savedAt: 1 };
  const snapB = { name: "B", power: false, brightness: 20, colorRgb: "#222222", colorTemperature: 2700, savedAt: 2 };
  let dataDir: string;
  let snapDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-snap-"));
    snapDir = path.join(dataDir, "snapshots");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * One file as 2.10.1 wrote it (`JSON.stringify(data, null, 2)`, no trailing newline).
   *
   * @param name File name in the old snapshots folder
   * @param content The text of the file
   */
  function seedFile(name: string, content: string): void {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, name), content);
  }

  /**
   * A store over the two seeded devices whose log lines land in `lines`.
   *
   * @param lines Collects every info, warn and debug line by level
   * @param lines.info info lines
   * @param lines.warn warn lines
   * @param lines.debug debug lines
   */
  function storeWithLog(lines: { info: string[]; warn: string[]; debug: string[] }): {
    store: LocalSnapshotStore;
    mock: ReturnType<typeof createMockAdapter>;
  } {
    const mock = createMockAdapter();
    seedDevices(mock.objects);
    const store = new LocalSnapshotStore(
      mock.adapter,
      {
        ...mockLog,
        info: (m: string) => lines.info.push(m),
        warn: (m: string) => lines.warn.push(m),
        debug: (m: string) => lines.debug.push(m),
      },
      new DeviceIdRegistry(),
    );
    return { store, mock };
  }

  it("moves the files into the device objects, removes them and leaves the emptied folder", async () => {
    seedFile("h6160_0011.json", JSON.stringify({ snapshots: [snapA] }, null, 2));
    seedFile("h6160_2222.json", JSON.stringify({ snapshots: [snapB] }, null, 2));
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(storedList(mock.objects, "devices.h6160-0011")).toEqual([snapA]);
    expect(storedList(mock.objects, "devices.h6160-2222")).toEqual([snapB]);
    expect(store.getSnapshots("H6160", "AABBCCDDEEFF2222")).toEqual([snapB]);
    // The data-file module removes files, never folders — the empty folder stays.
    expect(fs.readdirSync(snapDir)).toEqual([]);
    expect(lines.info.some(m => m.includes(`moved from ${snapDir}`) && m.includes("2/2 file(s)"))).toBe(true);
    expect(lines.warn).toEqual([]);
    expect(lines.debug.some(m => m.includes("Snapshot read failed"))).toBe(false);
  });

  it("an unreadable file is dropped with a warning and its reason on debug, the readable one still moves", async () => {
    seedFile("h6160_0011.json", "NOT JSON!");
    seedFile("h6160_2222.json", JSON.stringify({ snapshots: [snapB] }, null, 2));
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store } = storeWithLog(lines);
    await store.init(dataDir);
    expect(store.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
    expect(store.getSnapshots("H6160", "AABBCCDDEEFF2222")).toEqual([snapB]);
    expect(lines.warn.some(m => m.includes("h6160_0011.json") && m.includes("unreadable and was dropped"))).toBe(true);
    expect(lines.debug.some(m => m.includes("Snapshot read failed for h6160_0011.json: no JSON"))).toBe(true);
    // Only the broken file says why it failed — a readable one has nothing to report.
    expect(lines.debug.some(m => m.includes("Snapshot read failed for h6160_2222.json"))).toBe(false);
    expect(fs.readdirSync(snapDir)).toEqual([]);
    expect(lines.info.some(m => m.includes("1/2 file(s)"))).toBe(true);
  });

  it("a file whose snapshots are no list, or that holds null, is dropped as unreadable — never as an empty list", async () => {
    // An empty `native.localSnapshots` field is the empty list; a file holding
    // `null` never was — it was unreadable before the data-file module as well.
    seedFile("h6160_0011.json", JSON.stringify({ snapshots: "hello" }));
    seedFile("h6160_2222.json", "null");
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(storedList(mock.objects, "devices.h6160-0011")).toBeUndefined();
    expect(lines.warn.some(m => m.includes("h6160_0011.json") && m.includes("unreadable"))).toBe(true);
    expect(lines.warn.some(m => m.includes("h6160_2222.json") && m.includes("unreadable"))).toBe(true);
    expect(fs.readdirSync(snapDir)).toEqual([]);
  });

  it("a file with an empty list moves nothing and is removed without a warning", async () => {
    seedFile("h6160_0011.json", JSON.stringify({ snapshots: [] }, null, 2));
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(mock.extendCalls).toHaveLength(0);
    expect(lines.warn).toEqual([]);
    expect(fs.readdirSync(snapDir)).toEqual([]);
    expect(lines.info.some(m => m.includes("0/1 file(s)"))).toBe(true);
  });

  it("an empty file (a crash between truncate and write in 2.10) is dropped as unreadable", async () => {
    // Behaviour since the data-file module: the old text path read "" as the
    // empty list and dropped the file silently; the file is still removed and
    // nothing moves, only the warning is new.
    seedFile("h6160_0011.json", "");
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(mock.extendCalls).toHaveLength(0);
    expect(lines.warn.some(m => m.includes("h6160_0011.json") && m.includes("unreadable"))).toBe(true);
    expect(fs.readdirSync(snapDir)).toEqual([]);
  });

  it("a file whose device write fails stays for the next start", async () => {
    seedFile("h6160_0011.json", JSON.stringify({ snapshots: [snapA] }, null, 2));
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    mock.adapter.extendObject = () => Promise.reject(new Error("db down"));
    await store.init(dataDir);
    expect(lines.warn.some(m => m.includes("carry-over of h6160_0011.json failed") && m.includes("db down"))).toBe(
      true,
    );
    expect(fs.readdirSync(snapDir)).toEqual(["h6160_0011.json"]);
    expect(lines.info.some(m => m.includes("0/1 file(s)"))).toBe(true);
  });

  it("only .json files are carried — other files and sub-folders stay untouched", async () => {
    seedFile("notes.txt", "keep me");
    fs.mkdirSync(path.join(snapDir, "h6160_2222.json"));
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(mock.extendCalls).toHaveLength(0);
    expect(lines.warn).toEqual([]);
    expect(lines.info.some(m => m.includes(`moved from ${snapDir}`))).toBe(false);
    expect(fs.readdirSync(snapDir).sort()).toEqual(["h6160_2222.json", "notes.txt"]);
  });

  it("a later start over the emptied folder carries nothing and says nothing", async () => {
    seedFile("h6160_0011.json", JSON.stringify({ snapshots: [snapA] }, null, 2));
    const first = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    await storeWithLog(first).store.init(dataDir);
    expect(first.info.some(m => m.includes("1/1 file(s)"))).toBe(true);
    const later = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(later);
    await store.init(dataDir);
    expect(mock.extendCalls).toHaveLength(0);
    expect(later.info).toEqual([]);
    expect(later.warn).toEqual([]);
  });

  it("without the old folder nothing is read, logged or created", async () => {
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store, mock } = storeWithLog(lines);
    await store.init(dataDir);
    expect(mock.extendCalls).toHaveLength(0);
    expect(lines.info).toEqual([]);
    expect(lines.warn).toEqual([]);
    expect(fs.existsSync(snapDir)).toBe(false);
  });

  it("a snapshots entry that is no folder is reported and left alone", async () => {
    fs.writeFileSync(snapDir, "not a folder");
    const lines = { info: [] as string[], warn: [] as string[], debug: [] as string[] };
    const { store } = storeWithLog(lines);
    await store.init(dataDir);
    expect(lines.warn.some(m => m.includes(`cannot read ${snapDir}`))).toBe(true);
    expect(fs.readFileSync(snapDir, "utf8")).toBe("not a folder");
  });
});

describe("LocalSnapshotStore — storage not initialised", () => {
  it("refuses to save and says why instead of pretending it worked", async () => {
    const warns: string[] = [];
    const mock = createMockAdapter();
    const store = new LocalSnapshotStore(
      mock.adapter,
      {
        ...mockLog,
        warn: (m: string) => warns.push(m),
      },
      new DeviceIdRegistry(),
    );
    // init() deliberately NOT called — mirrors a start where the objects are
    // not reachable. Saving anyway would put the snapshot in the in-memory
    // cache only: the dropdown shows it, and it is gone after the next restart.
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", {
      name: "Ghost",
      power: true,
      brightness: 80,
      colorRgb: "#ff6600",
      colorTemperature: 0,
      savedAt: 1712700000,
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("not initialised");
    expect(store.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
    expect(mock.extendCalls).toHaveLength(0);
  });
});
