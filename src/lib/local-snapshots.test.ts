import { LocalSnapshotStore, type LocalSnapshot, type LocalSnapshotStoreAdapter } from "./local-snapshots";

const mockLog: ioBroker.Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
};

/**
 * In-memory mock of the ioBroker file-storage API. The store writes/reads
 * `<namespace>.snapshots` files; the mock tracks them in a Map keyed by
 * `<meta>/<filename>`.
 *
 * @param namespace Adapter namespace the snapshot store files live under
 */
function createMockAdapter(namespace = "govee-smart.0"): {
  adapter: LocalSnapshotStoreAdapter;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const key = (meta: string, name: string): string => `${meta}/${name}`;
  return {
    files,
    adapter: {
      namespace,
      readFileAsync(meta, name) {
        const k = key(meta, name);
        if (!files.has(k)) {
          return Promise.reject(new Error(`ENOENT: ${k}`));
        }
        return Promise.resolve({ file: files.get(k)!, mimeType: "application/json" });
      },
      writeFileAsync(meta, name, data) {
        files.set(key(meta, name), typeof data === "string" ? data : data.toString("utf-8"));
        return Promise.resolve();
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
    },
  };
}

describe("LocalSnapshotStore", () => {
  let store: LocalSnapshotStore;
  let files: Map<string, string>;

  beforeEach(async () => {
    const mock = createMockAdapter();
    files = mock.files;
    store = new LocalSnapshotStore(mock.adapter, mockLog);
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

  it("should keep separate files per device", async () => {
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
    // Pre-populate the storage with corrupt content before init().
    const mock = createMockAdapter();
    mock.files.set("govee-smart.0.snapshots/h6160_0011.json", "NOT JSON!");
    const corruptStore = new LocalSnapshotStore(mock.adapter, mockLog);
    await corruptStore.init();
    expect(corruptStore.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("should return empty array when snapshots field is not an array", async () => {
    const mock = createMockAdapter();
    mock.files.set("govee-smart.0.snapshots/h6160_0011.json", JSON.stringify({ snapshots: "hello" }));
    const driftStore = new LocalSnapshotStore(mock.adapter, mockLog);
    await driftStore.init();
    expect(driftStore.getSnapshots("H6160", "AABBCCDDEEFF0011")).toEqual([]);
  });

  it("should return empty array when snapshots field is missing", async () => {
    const mock = createMockAdapter();
    mock.files.set("govee-smart.0.snapshots/h6160_0011.json", JSON.stringify({ version: 1 }));
    const driftStore = new LocalSnapshotStore(mock.adapter, mockLog);
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

  it("should remove file when last snapshot for a device is deleted", async () => {
    const snap: LocalSnapshot = {
      name: "Single",
      power: true,
      brightness: 50,
      colorRgb: "#ffffff",
      colorTemperature: 0,
      savedAt: 1000,
    };
    await store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
    expect(files.has("govee-smart.0.snapshots/h6160_0011.json")).toBe(true);
    await store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "Single");
    expect(files.has("govee-smart.0.snapshots/h6160_0011.json")).toBe(false);
  });
});

describe("LocalSnapshotStore — storage not initialised", () => {
  it("refuses to save and says why instead of pretending it worked", async () => {
    const warns: string[] = [];
    const mock = createMockAdapter();
    const store = new LocalSnapshotStore(mock.adapter, {
      ...mockLog,
      warn: (m: string) => warns.push(m),
    });
    // init() deliberately NOT called — mirrors a start where meta.user is not
    // reachable. Saving anyway would put the snapshot in the in-memory cache
    // only: the dropdown shows it, and it is gone after the next restart.
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
    expect(mock.files.size).toBe(0);
  });
});
