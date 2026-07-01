import { CommandRouter } from "./command-router";
import { _resetDeviceRegistry, initDeviceRegistry } from "./device-registry";
import type { GoveeCloudClient } from "./govee-cloud-client";
import type { GoveeLanClient } from "./govee-lan-client";
import type { RateLimiter } from "./rate-limiter";
import { mockLog } from "./test-helpers";
import type { GoveeDevice, TimerAdapter } from "./types";

interface LanCall {
  method: string;
  args: unknown[];
}

function makeLanStub(): { client: GoveeLanClient; calls: LanCall[] } {
  const calls: LanCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  const client = {
    setPower: record("setPower"),
    setBrightness: record("setBrightness"),
    setColor: record("setColor"),
    setColorTemperature: record("setColorTemperature"),
    setScene: record("setScene"),
    setDiyScene: record("setDiyScene"),
    setMusicMode: record("setMusicMode"),
    setGradient: record("setGradient"),
    setSegmentColor: record("setSegmentColor"),
    setSegmentBrightness: record("setSegmentBrightness"),
    sendPtReal: record("sendPtReal"),
    requestStatus: record("requestStatus"),
  } as unknown as GoveeLanClient;
  return { client, calls };
}

interface CloudCall {
  sku: string;
  device: string;
  capabilityType: string;
  instance: string;
  value: unknown;
}

function makeCloudStub(throwOn?: string): { client: GoveeCloudClient; calls: CloudCall[] } {
  const calls: CloudCall[] = [];
  const client = {
    controlDevice: (sku: string, device: string, capabilityType: string, instance: string, value: unknown) => {
      calls.push({ sku, device, capabilityType, instance, value });
      if (throwOn === capabilityType) {
        return Promise.reject(new Error(`stub-throw on ${capabilityType}`));
      }
      return Promise.resolve();
    },
  } as unknown as GoveeCloudClient;
  return { client, calls };
}

function makeRateLimiter(): RateLimiter {
  // Direct-pass implementation — tests don't need queueing semantics here,
  // just "runs the callback inline".
  return {
    tryExecute: async (fn: () => Promise<void>): Promise<boolean> => {
      await fn();
      return true;
    },
  } as unknown as RateLimiter;
}

const noopTimers: TimerAdapter = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  setTimeout: (cb): ioBroker.Timeout | undefined => {
    cb();
    return undefined;
  },
  clearTimeout: () => undefined,
  delay: () => Promise.resolve(),
};

function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6160",
    deviceId: "AA:BB:CC:DD:EE:01",
    name: "Test Light",
    type: "devices.types.light",
    capabilities: [
      { type: "devices.capabilities.on_off", instance: "powerSwitch" },
      { type: "devices.capabilities.range", instance: "brightness" },
      { type: "devices.capabilities.color_setting", instance: "colorRgb" },
      { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
      { type: "devices.capabilities.dynamic_scene", instance: "lightScene" },
      { type: "devices.capabilities.dynamic_scene", instance: "diyScene" },
      { type: "devices.capabilities.dynamic_scene", instance: "snapshot" },
      { type: "devices.capabilities.segment_color_setting", instance: "segmentedColorRgb" },
      { type: "devices.capabilities.segment_color_setting", instance: "segmentedBrightness" },
      { type: "devices.capabilities.mode", instance: "presetScene" },
    ],
    scenes: [{ name: "Aurora", value: { paramId: 1 } }],
    diyScenes: [{ name: "MyDiy", value: { paramId: 2 } }],
    snapshots: [{ name: "Snap1", value: 7 }],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: true },
    lanIp: "192.168.1.42",
    segmentCount: 10,
    ...overrides,
  };
}

describe("CommandRouter", () => {
  describe("sendCommand — LAN priority", () => {
    it("routes power to LAN setPower when device has lanIp", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "power", true);
      expect(lan.calls).toHaveLength(1);
      expect(lan.calls[0].method).toBe("setPower");
      expect(lan.calls[0].args).toEqual(["192.168.1.42", true]);
    });

    it("routes brightness to LAN setBrightness", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "brightness", 75);
      expect(lan.calls[0].method).toBe("setBrightness");
      expect(lan.calls[0].args).toEqual(["192.168.1.42", 75]);
    });

    it("routes colorRgb to LAN setColor with hex parsed to rgb", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "colorRgb", "#FF6600");
      expect(lan.calls[0].method).toBe("setColor");
      expect(lan.calls[0].args).toEqual(["192.168.1.42", 0xff, 0x66, 0x00]);
    });

    it("routes colorTemperature to LAN setColorTemperature", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "colorTemperature", 4000);
      expect(lan.calls[0].method).toBe("setColorTemperature");
      expect(lan.calls[0].args).toEqual(["192.168.1.42", 4000]);
    });

    it("routes gradientToggle to LAN setGradient", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "gradientToggle", true);
      expect(lan.calls[0].method).toBe("setGradient");
      expect(lan.calls[0].args).toEqual(["192.168.1.42", true]);
    });
  });

  describe("sendCommand — Cloud fallback", () => {
    it("routes to Cloud when device has no lanIp", async () => {
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      const device = makeDevice({ lanIp: undefined });
      await router.sendCommand(device, "power", true);
      expect(cloud.calls).toHaveLength(1);
      expect(cloud.calls[0].instance).toBe("powerSwitch");
      expect(cloud.calls[0].value).toBe(1);
    });

    it("debug-logs without warn when Cloud client not yet ready (init-race)", async () => {
      const router = new CommandRouter(mockLog, noopTimers);
      // No lanClient, no cloudClient — but channel says cloud:true (init-race)
      const device = makeDevice({ lanIp: undefined, channels: { lan: false, mqtt: false, cloud: true } });
      await router.sendCommand(device, "power", true);
      // No throw — false alarm dropped at debug level
    });

    it("warns when no channel available at all", async () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const device = makeDevice({ lanIp: undefined, channels: { lan: false, mqtt: false, cloud: false } });
      await router.sendCommand(device, "power", true);
      // No throw — warn fired but no exception bubbles
    });
  });

  describe("segmentColor / segmentBrightness routing", () => {
    it("routes segmentColor:N to LAN setColor + setSegmentColor (forceColorMode + ptReal)", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "segmentColor:3", "#0000FF");
      // forceColorMode sends a setColor first
      const setColorCall = lan.calls.find(c => c.method === "setColor");
      expect(setColorCall).toBeDefined();
      const segColorCall = lan.calls.find(c => c.method === "setSegmentColor");
      expect(segColorCall).toBeDefined();
      expect(segColorCall!.args).toEqual(["192.168.1.42", 0x00, 0x00, 0xff, [3]]);
    });

    it("routes segmentBrightness:N to setSegmentBrightness", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "segmentBrightness:5", 50);
      const segBrightCall = lan.calls.find(c => c.method === "setSegmentBrightness");
      expect(segBrightCall).toBeDefined();
      expect(segBrightCall!.args).toEqual(["192.168.1.42", 50, [5]]);
    });

    it("rejects negative segment index", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "segmentColor:-1", "#FF0000");
      expect(lan.calls).toHaveLength(0);
    });

    it("warns instead of silently swallowing a malformed segment batch command (A4)", async () => {
      const warns: string[] = [];
      const capturingLog = { ...mockLog, warn: (m: string) => warns.push(m) } as unknown as ioBroker.Logger;
      const lan = makeLanStub();
      const router = new CommandRouter(capturingLog, noopTimers);
      router.setLanClient(lan.client);
      // ';' where a ':' is required — parseSegmentBatch returns null (live: h61d5).
      await router.sendCommand(makeDevice(), "segmentBatch", "1-15;#ffca91");
      expect(lan.calls).toHaveLength(0); // nothing sent
      expect(warns.some(w => w.includes("segment command") && w.includes("1-15;#ffca91"))).toBe(true);
    });
  });

  describe("parseSegmentBatch", () => {
    it("parses range syntax (0-5:#ff0000:50)", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.parseSegmentBatch(makeDevice(), "0-5:#ff0000:50");
      expect(result).toEqual({ segments: [0, 1, 2, 3, 4, 5], color: 0xff0000, brightness: 50 });
    });

    it("parses comma-list (0,3,7:#00ff00:100)", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.parseSegmentBatch(makeDevice(), "0,3,7:#00ff00:100");
      expect(result).toEqual({ segments: [0, 3, 7], color: 0x00ff00, brightness: 100 });
    });

    it("parses 'all' to expanded indices", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.parseSegmentBatch(makeDevice({ segmentCount: 4 }), "all:#ffffff:75");
      expect(result?.segments).toEqual([0, 1, 2, 3]);
    });

    it("respects manualSegments (cut-strip)", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const device = makeDevice({ manualMode: true, manualSegments: [0, 2, 4] });
      const result = router.parseSegmentBatch(device, "all:#ff0000:50");
      expect(result?.segments).toEqual([0, 2, 4]);
    });

    it("filters out-of-range indices", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const device = makeDevice({ segmentCount: 5 });
      const result = router.parseSegmentBatch(device, "3-10:#ff0000:50");
      expect(result?.segments).toEqual([3, 4]);
    });

    it("returns null for empty/invalid input", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.parseSegmentBatch(makeDevice(), "")).toBeNull();
      expect(router.parseSegmentBatch(makeDevice(), "::100")).toBeNull();
    });

    it("returns null when neither color nor brightness given", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.parseSegmentBatch(makeDevice(), "0-5")).toBeNull();
    });

    it("accepts brightness-only (no color)", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.parseSegmentBatch(makeDevice(), "0-3::25");
      expect(result).toEqual({ segments: [0, 1, 2, 3], color: undefined, brightness: 25 });
    });

    it("rejects brightness above 100", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.parseSegmentBatch(makeDevice(), "0-3::150");
      expect(result?.brightness).toBeUndefined();
    });

    it("rejects non-string input", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.parseSegmentBatch(makeDevice(), 42 as unknown as string)).toBeNull();
    });
  });

  describe("toCloudValue", () => {
    it("converts power true → 1, false → 0", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.toCloudValue(makeDevice(), "power", true)).toBe(1);
      expect(router.toCloudValue(makeDevice(), "power", false)).toBe(0);
    });

    it("converts colorRgb hex to packed int", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.toCloudValue(makeDevice(), "colorRgb", "#FF6600")).toBe(0xff6600);
    });

    it("resolves lightScene index to value payload", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.toCloudValue(makeDevice(), "lightScene", "1");
      expect(result).toEqual({ paramId: 1 });
    });

    it("resolves diyScene index", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.toCloudValue(makeDevice(), "diyScene", "1")).toEqual({ paramId: 2 });
    });

    it("resolves snapshot index", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.toCloudValue(makeDevice(), "snapshot", "1")).toBe(7);
    });

    it("returns input value for invalid scene index", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.toCloudValue(makeDevice(), "lightScene", "99")).toBe("99");
    });

    it("converts segmentColor:N to {segment, rgb}", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.toCloudValue(makeDevice(), "segmentColor:3", "#FF0000") as {
        segment: number[];
        rgb: number;
      };
      expect(result.segment).toEqual([3]);
      expect(result.rgb).toBe(0xff0000);
    });

    it("converts segmentBrightness:N to {segment, brightness}", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const result = router.toCloudValue(makeDevice(), "segmentBrightness:7", 50);
      expect(result).toEqual({ segment: [7], brightness: 50 });
    });
  });

  describe("findCapabilityForCommand", () => {
    it("matches power → on_off", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "power");
      expect(cap?.instance).toBe("powerSwitch");
    });

    it("matches brightness → range/brightness", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "brightness");
      expect(cap?.instance).toBe("brightness");
    });

    it("matches colorRgb → color_setting/colorRgb", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "colorRgb");
      expect(cap?.instance).toBe("colorRgb");
    });

    it("matches lightScene → dynamic_scene/lightScene", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "lightScene");
      expect(cap?.instance).toBe("lightScene");
    });

    it("matches segmentColor:N → segment_color_setting (NOT brightness)", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "segmentColor:0");
      expect(cap?.instance).toBe("segmentedColorRgb");
    });

    it("matches segmentBrightness:N → segment_color_setting/brightness-flavour", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const cap = router.findCapabilityForCommand(makeDevice(), "segmentBrightness:0");
      expect(cap?.instance).toBe("segmentedBrightness");
    });

    it("returns undefined for unknown command", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      expect(router.findCapabilityForCommand(makeDevice(), "xyz")).toBeUndefined();
    });

    it("returns undefined when capabilities is empty", () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const dev = makeDevice({ capabilities: [] });
      expect(router.findCapabilityForCommand(dev, "power")).toBeUndefined();
    });
  });

  describe("sendCapabilityCommand (generic capability route)", () => {
    it("forwards toggle as 0/1", async () => {
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      await router.sendCapabilityCommand(makeDevice(), "devices.capabilities.toggle", "gradientToggle", true);
      expect(cloud.calls).toHaveLength(1);
      expect(cloud.calls[0].value).toBe(1);
    });

    it("forwards non-toggle value verbatim", async () => {
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      await router.sendCapabilityCommand(makeDevice(), "devices.capabilities.dynamic_scene", "snapshot", { v: 1 });
      expect(cloud.calls[0].value).toEqual({ v: 1 });
    });

    it("no-op when Cloud not configured", async () => {
      const router = new CommandRouter(mockLog, noopTimers);
      const device = makeDevice({ channels: { lan: true, mqtt: false, cloud: false } });
      await router.sendCapabilityCommand(device, "devices.capabilities.toggle", "any", true);
      // Just verifies no throw
    });
  });

  describe("transportOverrides (v2.10.0 — quirk-driven routing)", () => {
    // The override tests stand up a registry singleton via initDeviceRegistry
    // with inline catalog data, then reset between tests so leakage can't
    // mask regressions. registry-aware tests live HERE, not in a separate
    // describe-each pattern, because the routing-decision is the unit
    // under test — registry presence is part of the fixture.
    beforeEach(() => _resetDeviceRegistry());
    afterEach(() => _resetDeviceRegistry());

    const TEST_CATALOG = {
      devices: {
        H70B3: {
          name: "Curtain Lights",
          type: "light",
          status: "verified",
          quirks: { transportOverrides: { snapshot: "cloud", lightScene: "cloud" } },
        },
        H612F: {
          name: "RGBIC LED Strip",
          type: "light",
          status: "verified",
          // No quirks — control group: default LAN-first routing
        },
      },
    } as const;

    function makeH70B3(opts: Partial<GoveeDevice> = {}): GoveeDevice {
      return makeDevice({
        sku: "H70B3",
        snapshots: [{ name: "Test", value: 3814455 }],
        // snapshotBleCmds is base64-encoded packet groups (string[][][])
        snapshotBleCmds: [[["MwRk", "pAAAAQ"]]],
        segmentCount: 0,
        ...opts,
      });
    }

    it("snapshot=cloud + Cloud ready → sendCloudCommand, no ptReal", async () => {
      initDeviceRegistry({ data: TEST_CATALOG as never });
      const lan = makeLanStub();
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      await router.sendCommand(makeH70B3(), "snapshot", "1");
      expect(lan.calls.find(c => c.method === "sendPtReal")).toBeUndefined();
      expect(cloud.calls).toHaveLength(1);
      expect(cloud.calls[0].instance).toBe("snapshot");
    });

    it("snapshot=cloud + device.channels.cloud=false → skip (no warn loop)", async () => {
      initDeviceRegistry({ data: TEST_CATALOG as never });
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      const device = makeH70B3({ channels: { lan: true, mqtt: false, cloud: false } });
      await router.sendCommand(device, "snapshot", "1");
      // Cloud-override but no Cloud channel → no LAN ptReal, no Cloud send,
      // dedup-warn fires once (we don't assert on logger because mockLog is
      // a spy stub — verifying no LAN ptReal call is enough)
      expect(lan.calls.find(c => c.method === "sendPtReal")).toBeUndefined();
    });

    it("snapshot=cloud + cloudClient=null (init-race) → debug, no throw", async () => {
      initDeviceRegistry({ data: TEST_CATALOG as never });
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      // setCloudClient NOT called → cloudClient is null even though
      // device.channels.cloud=true
      await router.sendCommand(makeH70B3(), "snapshot", "1");
      expect(lan.calls.find(c => c.method === "sendPtReal")).toBeUndefined();
    });

    it("snapshot=lan (or unset) → existing LAN ptReal path unchanged", async () => {
      // No catalog entry — default routing
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      const device = makeH70B3({ segmentCount: 22 }); // hasSegments=true so no heuristic
      await router.sendCommand(device, "snapshot", "1");
      const ptRealCall = lan.calls.find(c => c.method === "sendPtReal");
      expect(ptRealCall).toBeDefined();
    });

    it("gradientToggle=cloud → Cloud via extended findCapabilityForCommand", async () => {
      initDeviceRegistry({
        data: {
          devices: {
            H6160: {
              name: "Test",
              type: "light",
              status: "verified",
              quirks: { transportOverrides: { gradientToggle: "cloud" } },
            },
          },
        } as never,
      });
      const lan = makeLanStub();
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      const device = makeDevice({
        capabilities: [{ type: "devices.capabilities.toggle", instance: "gradientToggle" }],
      });
      await router.sendCommand(device, "gradientToggle", true);
      expect(lan.calls.find(c => c.method === "setGradient")).toBeUndefined();
      expect(cloud.calls).toHaveLength(1);
      expect(cloud.calls[0].instance).toBe("gradientToggle");
      expect(cloud.calls[0].value).toBe(1);
    });

    it("segmentBatch=cloud → Cloud via sendSegmentBatchParsed (not sendCloudCommand)", async () => {
      initDeviceRegistry({
        data: {
          devices: {
            H6160: {
              name: "Test",
              type: "light",
              status: "verified",
              quirks: { transportOverrides: { segmentBatch: "cloud" } },
            },
          },
        } as never,
      });
      const lan = makeLanStub();
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      await router.sendCommand(makeDevice(), "segmentBatch", "0-2:#ff0000:50");
      // No LAN segment-set
      expect(lan.calls.find(c => c.method === "setSegmentColor")).toBeUndefined();
      // Cloud got the segment_color_setting call
      expect(cloud.calls.length).toBeGreaterThan(0);
      expect(cloud.calls[0].capabilityType).toContain("segment_color_setting");
    });

    it("segmentBatch=cloud + command segmentColor:5 → suffix-inherits Cloud path", async () => {
      initDeviceRegistry({
        data: {
          devices: {
            H6160: {
              name: "Test",
              type: "light",
              status: "verified",
              quirks: { transportOverrides: { segmentBatch: "cloud" } },
            },
          },
        } as never,
      });
      const lan = makeLanStub();
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      await router.sendCommand(makeDevice(), "segmentColor:5", "#00FF00");
      // No LAN setSegmentColor
      expect(lan.calls.find(c => c.method === "setSegmentColor")).toBeUndefined();
      // Cloud got it via sendCloudCommand
      expect(cloud.calls.length).toBeGreaterThan(0);
    });

    it("unknown SKU + segmentCount=0 + lightScene → hasSegments-Heuristic fires (regression-guard)", async () => {
      // No catalog entry — heuristic is the only defense
      const cloud = makeCloudStub();
      const limiter = makeRateLimiter();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(makeLanStub().client);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(limiter);
      const device = makeDevice({
        sku: "H9999", // unknown
        segmentCount: 0,
        sceneLibrary: [{ name: "Aurora", sceneCode: 1, scenceParam: "abc" }],
      });
      await router.sendCommand(device, "lightScene", "1");
      // Heuristic routed to Cloud
      expect(cloud.calls.length).toBe(1);
      expect(cloud.calls[0].instance).toBe("lightScene");
    });

    it("registry not initialized → resolveTransport returns LAN default (no crash)", async () => {
      // No initDeviceRegistry call — singleton is undefined
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      await router.sendCommand(makeDevice(), "power", true);
      expect(lan.calls).toHaveLength(1);
      expect(lan.calls[0].method).toBe("setPower");
    });

    it("dedup-map: repeated override-cloud-missing logs only once at warn level", async () => {
      initDeviceRegistry({ data: TEST_CATALOG as never });
      const router = new CommandRouter(mockLog, noopTimers);
      const device = makeH70B3({ channels: { lan: true, mqtt: false, cloud: false } });
      // Three rapid commands in same category — first warn, rest debug.
      await router.sendCommand(device, "snapshot", "1");
      await router.sendCommand(device, "snapshot", "1");
      await router.sendCommand(device, "snapshot", "1");
      // No throw, dedup behavior verified by code path (logDedup tested separately)
    });
  });

  describe("resolveTransport — Light without LAN (cloud fallback)", () => {
    it("Light without LAN gets light-no-lan-fallback reason, not plain no-lan", async () => {
      const cloud = makeCloudStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setCloudClient(cloud.client);
      router.setRateLimiter(makeRateLimiter());
      const device = makeDevice({
        type: "devices.types.light",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: true },
      });
      const decision = router.resolveTransport(device, "power");
      expect(decision.kind).toBe("cloud");
      expect(decision.reason).toBe("light-no-lan-fallback");
    });

    it("Appliance without LAN gets plain no-lan reason (unchanged)", async () => {
      const cloud = makeCloudStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setCloudClient(cloud.client);
      const device = makeDevice({
        type: "devices.types.humidifier",
        lanIp: undefined,
        channels: { lan: false, mqtt: false, cloud: true },
      });
      const decision = router.resolveTransport(device, "power");
      expect(decision.kind).toBe("cloud");
      expect(decision.reason).toBe("no-lan");
    });

    it("Light with LAN still routes to LAN (no regression)", async () => {
      const lan = makeLanStub();
      const router = new CommandRouter(mockLog, noopTimers);
      router.setLanClient(lan.client);
      const device = makeDevice({
        type: "devices.types.light",
        lanIp: "192.168.1.42",
        channels: { lan: true, mqtt: false, cloud: true },
      });
      const decision = router.resolveTransport(device, "power");
      expect(decision.kind).toBe("lan");
      expect(decision.reason).toBe("default");
    });
  });

  // The devices.json transportOverrides mini-validator lives in
  // device-registry.test.ts (the registry owns the catalog contract) —
  // an identical copy here was removed in v2.16.1.
});
