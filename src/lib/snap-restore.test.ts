import type { LocalSnapshot, LocalSnapshotStore, SnapshotSegment } from "./local-snapshots";
import { SnapshotHandler, type SnapshotHandlerHost } from "./snapshot-handler";
import type { GoveeDevice } from "./types";

const mockLog = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  level: "info",
} as unknown as ioBroker.Logger;

interface RecordedCommand {
  command: string;
  value: unknown;
}

function makeHost(opts: { initialSnapshots?: LocalSnapshot[]; initialState?: Record<string, ioBroker.State> }): {
  host: SnapshotHandlerHost;
  commands: RecordedCommand[];
  saved: LocalSnapshot[];
  deletedNames: string[];
  refreshes: GoveeDevice[];
} {
  const commands: RecordedCommand[] = [];
  const saved: LocalSnapshot[] = [];
  const deletedNames: string[] = [];
  const refreshes: GoveeDevice[] = [];
  const states = new Map(Object.entries(opts.initialState ?? {}));
  let snapshots = (opts.initialSnapshots ?? []).slice();

  const store = {
    getSnapshots: () => snapshots.slice(),
    saveSnapshot: async (_sku: string, _id: string, snap: LocalSnapshot): Promise<void> => {
      saved.push(snap);
      snapshots = snapshots.filter(s => s.name !== snap.name).concat(snap);
    },
    deleteSnapshot: async (_sku: string, _id: string, name: string): Promise<boolean> => {
      const before = snapshots.length;
      snapshots = snapshots.filter(s => s.name !== name);
      const removed = before !== snapshots.length;
      if (removed) {
        deletedNames.push(name);
      }
      return removed;
    },
  } as unknown as LocalSnapshotStore;

  const host: SnapshotHandlerHost = {
    log: mockLog,
    store,
    namespace: "govee-smart.0",
    devicePrefix: () => "devices.h6160_dead",
    getState: id => Promise.resolve(states.get(id) ?? null),
    sendCommand: async (_dev, command, value) => {
      commands.push({ command, value });
    },
    refreshDeviceStates: device => {
      refreshes.push(device);
    },
  };

  return { host, commands, saved, deletedNames, refreshes };
}

function makeDevice(): GoveeDevice {
  return {
    sku: "H6160",
    deviceId: "AA:BB:CC:DE:AD",
    name: "TestStrip",
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
    channels: { lan: true, mqtt: false, cloud: false },
    lanIp: "10.0.0.1",
    segmentCount: 6,
  };
}

describe("SnapshotHandler", () => {
  describe("save", () => {
    it("captures power, brightness, colorRgb, colorTemperature and segments", async () => {
      const { host, saved, refreshes } = makeHost({
        initialState: {
          "govee-smart.0.devices.h6160_dead.control.power": { val: true, ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.control.brightness": { val: 80, ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.control.color_rgb": { val: "#ff0000", ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.control.color_temperature": { val: 0, ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.segments.0.color": { val: "#aabbcc", ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.segments.0.brightness": { val: 50, ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.segments.1.color": { val: "#112233", ack: true } as ioBroker.State,
          "govee-smart.0.devices.h6160_dead.segments.1.brightness": { val: 75, ack: true } as ioBroker.State,
        },
      });
      const handler = new SnapshotHandler(host);
      await handler.save(makeDevice(), "MySnap");
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe("MySnap");
      expect(saved[0].power).toBe(true);
      expect(saved[0].brightness).toBe(80);
      expect(saved[0].colorRgb).toBe("#ff0000");
      expect(saved[0].segments).toHaveLength(6);
      expect(saved[0].segments![0]).toEqual({ color: "#aabbcc", brightness: 50 });
      expect(saved[0].segments![1]).toEqual({ color: "#112233", brightness: 75 });
      // Default fallback for missing segments
      expect(saved[0].segments![2]).toEqual({ color: "#000000", brightness: 100 });
      expect(refreshes).toHaveLength(1);
    });

    it("falls back to safe defaults when state values are unset", async () => {
      const { host, saved } = makeHost({});
      const handler = new SnapshotHandler(host);
      await handler.save(makeDevice(), "Empty");
      expect(saved[0].power).toBe(false);
      expect(saved[0].brightness).toBe(0);
      expect(saved[0].colorRgb).toBe("#000000");
      expect(saved[0].colorTemperature).toBe(0);
    });
  });

  describe("restore", () => {
    it("sends power=false and skips other commands when snapshot.power=false", async () => {
      const snap: LocalSnapshot = {
        name: "Off",
        power: false,
        brightness: 0,
        colorRgb: "#000000",
        colorTemperature: 0,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      expect(commands).toEqual([{ command: "power", value: false }]);
    });

    it("sends colorRgb when colorTemperature=0", async () => {
      const snap: LocalSnapshot = {
        name: "Red",
        power: true,
        brightness: 80,
        colorRgb: "#ff0000",
        colorTemperature: 0,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      const cmds = commands.map(c => c.command);
      expect(cmds).toContain("power");
      expect(cmds).toContain("brightness");
      expect(cmds).toContain("colorRgb");
      expect(cmds).not.toContain("colorTemperature");
    });

    it("sends colorTemperature when set instead of colorRgb", async () => {
      const snap: LocalSnapshot = {
        name: "Warm",
        power: true,
        brightness: 60,
        colorRgb: "#ff0000",
        colorTemperature: 3000,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      const cmds = commands.map(c => c.command);
      expect(cmds).toContain("colorTemperature");
      expect(cmds).not.toContain("colorRgb");
    });

    it("groups uniform segments into a single segmentBatch (SH1 fix)", async () => {
      const segments: SnapshotSegment[] = Array.from({ length: 6 }, () => ({ color: "#0000FF", brightness: 100 }));
      const snap: LocalSnapshot = {
        name: "Uniform",
        power: true,
        brightness: 100,
        colorRgb: "#0000FF",
        colorTemperature: 0,
        segments,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      const segmentBatchCalls = commands.filter(c => c.command === "segmentBatch");
      // All 6 segments share (color, brightness) → exactly one batch.
      expect(segmentBatchCalls).toHaveLength(1);
      const payload = segmentBatchCalls[0].value as { segments: number[]; color: number; brightness: number };
      expect(payload.segments).toEqual([0, 1, 2, 3, 4, 5]);
      expect(payload.color).toBe(0x0000ff);
      expect(payload.brightness).toBe(100);
    });

    it("groups segments by (color, brightness) — 3 zones → 3 batches", async () => {
      const segments: SnapshotSegment[] = [
        { color: "#FF0000", brightness: 100 },
        { color: "#FF0000", brightness: 100 },
        { color: "#00FF00", brightness: 50 },
        { color: "#00FF00", brightness: 50 },
        { color: "#0000FF", brightness: 75 },
        { color: "#0000FF", brightness: 75 },
      ];
      const snap: LocalSnapshot = {
        name: "Tricolor",
        power: true,
        brightness: 100,
        colorRgb: "#FF0000",
        colorTemperature: 0,
        segments,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      const segmentBatchCalls = commands.filter(c => c.command === "segmentBatch");
      expect(segmentBatchCalls).toHaveLength(3);
    });

    it("warns and bails on out-of-range index", async () => {
      const snap: LocalSnapshot = {
        name: "Snap",
        power: true,
        brightness: 80,
        colorRgb: "#ff0000",
        colorTemperature: 0,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "99");
      expect(commands).toHaveLength(0);
    });

    it("ignores idx<1 (dropdown reset to '---')", async () => {
      const snap: LocalSnapshot = {
        name: "Snap",
        power: true,
        brightness: 80,
        colorRgb: "#ff0000",
        colorTemperature: 0,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "0");
      expect(commands).toHaveLength(0);
    });

    it("handles malformed segment color hex by defaulting to black", async () => {
      const segments: SnapshotSegment[] = [{ color: "garbage", brightness: 50 }];
      const snap: LocalSnapshot = {
        name: "Bad",
        power: true,
        brightness: 80,
        colorRgb: "#ff0000",
        colorTemperature: 0,
        segments,
        savedAt: 0,
      };
      const { host, commands } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.restore(makeDevice(), "1");
      const batch = commands.find(c => c.command === "segmentBatch")?.value as {
        segments: number[];
        color: number;
        brightness: number;
      };
      expect(batch.color).toBe(0); // black fallback
    });
  });

  describe("delete", () => {
    it("removes the named snapshot and triggers a refresh", async () => {
      const snap: LocalSnapshot = {
        name: "GoAway",
        power: true,
        brightness: 80,
        colorRgb: "#000000",
        colorTemperature: 0,
        savedAt: 0,
      };
      const { host, deletedNames, refreshes } = makeHost({ initialSnapshots: [snap] });
      const handler = new SnapshotHandler(host);
      await handler.delete(makeDevice(), "GoAway");
      expect(deletedNames).toEqual(["GoAway"]);
      expect(refreshes).toHaveLength(1);
    });

    it("warns when name not found, no refresh fired", async () => {
      const { host, deletedNames, refreshes } = makeHost({});
      const handler = new SnapshotHandler(host);
      await handler.delete(makeDevice(), "NonExistent");
      expect(deletedNames).toHaveLength(0);
      expect(refreshes).toHaveLength(0);
    });
  });
});
