import { GroupFanoutHandler, type GroupFanoutHost } from "./group-fanout";
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
  device: string;
  command: string;
  value: unknown;
}

interface RecordedMusic {
  device: string;
  prefix: string;
  suffix: string;
  value: unknown;
}

function makeMember(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6160",
    deviceId: "AA:BB:CC:01",
    name: "Member1",
    type: "devices.types.light",
    capabilities: [],
    scenes: [{ name: "Aurora", value: { paramId: 1 } }],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [{ name: "Spectrum", musicCode: 5, mode: 1 }],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: true },
    lanIp: "10.0.0.1",
    ...overrides,
  };
}

function makeGroup(memberRefs: { sku: string; deviceId: string }[]): GoveeDevice {
  return {
    sku: "BaseGroup",
    deviceId: "1311",
    name: "TestGroup",
    type: "BaseGroup",
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
    groupMembers: memberRefs,
  };
}

function makeHost(opts: {
  devices: GoveeDevice[];
  commandToSuffix?: Record<string, string>;
  groupSceneStates?: Record<string, string>;
  groupMusicStates?: Record<string, string>;
}): {
  host: GroupFanoutHost;
  commands: RecordedCommand[];
  musicCalls: RecordedMusic[];
} {
  const commands: RecordedCommand[] = [];
  const musicCalls: RecordedMusic[] = [];
  const objects = new Map<string, ioBroker.Object>();
  if (opts.groupSceneStates) {
    objects.set("govee-smart.0.groups.basegroup_1311.scenes.light_scene", {
      common: { states: opts.groupSceneStates },
    } as unknown as ioBroker.Object);
  }
  if (opts.groupMusicStates) {
    objects.set("govee-smart.0.groups.basegroup_1311.music.music_mode", {
      common: { states: opts.groupMusicStates },
    } as unknown as ioBroker.Object);
  }
  const stateToCommandMap: Record<string, string> = {
    "control.power": "power",
    "control.brightness": "brightness",
    "control.colorRgb": "colorRgb",
    "scenes.light_scene": "lightScene",
    "music.music_mode": "music",
    "music.music_sensitivity": "music",
    "music.music_auto_color": "music",
    ...opts.commandToSuffix,
  };
  const host: GroupFanoutHost = {
    log: mockLog,
    namespace: "govee-smart.0",
    getDevices: () => opts.devices,
    sendCommand: async (device, command, value) => {
      commands.push({ device: device.deviceId, command, value });
    },
    devicePrefix: device =>
      device.sku === "BaseGroup"
        ? `groups.basegroup_${device.deviceId}`
        : `devices.${device.sku.toLowerCase()}_${device.deviceId.replace(/:/g, "").slice(-4).toLowerCase()}`,
    stateToCommand: suffix => stateToCommandMap[suffix],
    getObject: id => Promise.resolve(objects.get(id) ?? null),
    sendMusicCommand: async (device, devicePrefix, stateSuffix, value) => {
      musicCalls.push({ device: device.deviceId, prefix: devicePrefix, suffix: stateSuffix, value });
    },
  };
  return { host, commands, musicCalls };
}

describe("GroupFanoutHandler", () => {
  describe("fanOut — basic controls", () => {
    it("sends power to every online member", async () => {
      const m1 = makeMember({ deviceId: "AA:01" });
      const m2 = makeMember({ deviceId: "AA:02", state: { online: true } });
      const m3 = makeMember({ deviceId: "AA:03", state: { online: false } });
      const group = makeGroup([
        { sku: m1.sku, deviceId: m1.deviceId },
        { sku: m2.sku, deviceId: m2.deviceId },
        { sku: m3.sku, deviceId: m3.deviceId },
      ]);
      const { host, commands } = makeHost({ devices: [m1, m2, m3] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "control.power", true);
      // m3 offline → skipped
      expect(commands).toHaveLength(2);
      expect(commands.map(c => c.device).sort()).toEqual(["AA:01", "AA:02"]);
    });

    it("forwards brightness verbatim", async () => {
      const m1 = makeMember();
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, commands } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "control.brightness", 75);
      expect(commands[0]).toEqual(expect.objectContaining({ command: "brightness", value: 75 }));
    });

    it("no-op when no online members", async () => {
      const m1 = makeMember({ state: { online: false } });
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, commands } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "control.power", true);
      expect(commands).toHaveLength(0);
    });

    it("no-op when group has no groupMembers", async () => {
      const group: GoveeDevice = { ...makeGroup([]), groupMembers: undefined };
      const { host, commands } = makeHost({ devices: [] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "control.power", true);
      expect(commands).toHaveLength(0);
    });
  });

  describe("fanOut — result signals ack-worthiness (L3/A6)", () => {
    it("returns false and warns once when no members are reachable", async () => {
      const warns: string[] = [];
      const m1 = makeMember({ state: { online: false } });
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host } = makeHost({ devices: [m1] });
      host.log = { ...mockLog, warn: (m: string) => warns.push(m) } as unknown as ioBroker.Logger;
      const handler = new GroupFanoutHandler(host);
      const result = await handler.fanOut(group, "control.power", true);
      expect(result).toBe(false); // caller must NOT ack "success"
      expect(warns).toHaveLength(1);
    });

    it("returns false and warns when every member command throws", async () => {
      const warns: string[] = [];
      const m1 = makeMember({ deviceId: "AA:01" });
      const m2 = makeMember({ deviceId: "AA:02" });
      const group = makeGroup([
        { sku: m1.sku, deviceId: m1.deviceId },
        { sku: m2.sku, deviceId: m2.deviceId },
      ]);
      const { host } = makeHost({ devices: [m1, m2] });
      host.log = { ...mockLog, warn: (m: string) => warns.push(m) } as unknown as ioBroker.Logger;
      host.sendCommand = async () => {
        throw new Error("unreachable");
      };
      const handler = new GroupFanoutHandler(host);
      const result = await handler.fanOut(group, "control.power", true);
      expect(result).toBe(false);
      expect(warns).toHaveLength(1);
    });

    it("returns true when at least one member command succeeds", async () => {
      const m1 = makeMember({ deviceId: "AA:01" });
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      const result = await handler.fanOut(group, "control.power", true);
      expect(result).toBe(true);
    });

    it("returns true on a dropdown reset (value 0) — a legit no-op", async () => {
      const m1 = makeMember({ deviceId: "AA:01" });
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, commands } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      const result = await handler.fanOut(group, "scenes.light_scene", 0);
      expect(result).toBe(true);
      expect(commands).toHaveLength(0);
    });
  });

  describe("fanOut — scene matching by name", () => {
    it("looks up the group dropdown name and resolves to the per-member scene index", async () => {
      const memberA = makeMember({
        deviceId: "MA:01",
        scenes: [
          { name: "Boring", value: { x: 1 } },
          { name: "Aurora", value: { x: 2 } },
          { name: "Sunset", value: { x: 3 } },
        ],
      });
      const memberB = makeMember({
        deviceId: "MB:01",
        scenes: [
          { name: "Aurora", value: { y: 1 } },
          { name: "Different", value: { y: 2 } },
        ],
      });
      const group = makeGroup([
        { sku: memberA.sku, deviceId: memberA.deviceId },
        { sku: memberB.sku, deviceId: memberB.deviceId },
      ]);
      const { host, commands } = makeHost({
        devices: [memberA, memberB],
        groupSceneStates: { 0: "---", 1: "Aurora" },
      });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "scenes.light_scene", "1");
      // Aurora is index 2 in memberA, index 1 in memberB → 1-based → "2" and "1"
      const auroraA = commands.find(c => c.device === memberA.deviceId);
      const auroraB = commands.find(c => c.device === memberB.deviceId);
      expect(auroraA?.value).toBe(2);
      expect(auroraB?.value).toBe(1);
    });

    it("skips scene that no member has", async () => {
      const memberA = makeMember({ scenes: [{ name: "Aurora", value: {} }] });
      const group = makeGroup([{ sku: memberA.sku, deviceId: memberA.deviceId }]);
      const { host, commands } = makeHost({
        devices: [memberA],
        groupSceneStates: { 0: "---", 1: "MissingScene" },
      });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "scenes.light_scene", "1");
      expect(commands).toHaveLength(0);
    });

    it("ignores scene-reset (value=0)", async () => {
      const memberA = makeMember();
      const group = makeGroup([{ sku: memberA.sku, deviceId: memberA.deviceId }]);
      const { host, commands } = makeHost({ devices: [memberA] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "scenes.light_scene", "0");
      expect(commands).toHaveLength(0);
    });
  });

  describe("fanOut — music", () => {
    it("matches musicLibrary by name", async () => {
      const m1 = makeMember({
        deviceId: "MM:01",
        musicLibrary: [
          { name: "Spectrum", musicCode: 1, mode: 0 },
          { name: "Rolling", musicCode: 2, mode: 1 },
        ],
      });
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, musicCalls } = makeHost({
        devices: [m1],
        groupMusicStates: { 0: "---", 1: "Rolling" },
      });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "music.music_mode", "1");
      expect(musicCalls).toHaveLength(1);
      expect(musicCalls[0].value).toBe(2); // index 2 in memberA's musicLibrary (1-based)
    });

    it("forwards sensitivity directly to sendMusicCommand", async () => {
      const m1 = makeMember();
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, musicCalls } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "music.music_sensitivity", 80);
      expect(musicCalls).toHaveLength(1);
      expect(musicCalls[0].value).toBe(80);
    });

    it("ignores music-mode 0 (reset)", async () => {
      const m1 = makeMember();
      const group = makeGroup([{ sku: m1.sku, deviceId: m1.deviceId }]);
      const { host, commands, musicCalls } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      await handler.fanOut(group, "music.music_mode", 0);
      expect(commands).toHaveLength(0);
      expect(musicCalls).toHaveLength(0);
    });
  });

  describe("resolveMembers", () => {
    it("filters out unknown member references", () => {
      const m1 = makeMember({ deviceId: "MK:01" });
      const group = makeGroup([
        { sku: m1.sku, deviceId: m1.deviceId },
        { sku: "Phantom", deviceId: "FF:FF" }, // not in devices list
      ]);
      const { host } = makeHost({ devices: [m1] });
      const handler = new GroupFanoutHandler(host);
      const resolved = handler.resolveMembers(group, [m1]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].deviceId).toBe("MK:01");
    });

    it("returns empty array for group with no members declared", () => {
      const group: GoveeDevice = { ...makeGroup([]), groupMembers: undefined };
      const { host } = makeHost({ devices: [] });
      const handler = new GroupFanoutHandler(host);
      expect(handler.resolveMembers(group, [])).toEqual([]);
    });
  });
});
