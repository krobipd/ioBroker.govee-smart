import { DiagnosticsCollector } from "./diagnostics";
import { DeviceRegistry } from "./device-registry";
import { HttpError } from "./http-client";
import type { GoveeDevice } from "./types";

/** A catalog with no entries — tests that don't care about quirks. */
const emptyRegistry = (): DeviceRegistry => new DeviceRegistry({ data: { devices: {} } });
/** The catalog the constructed modules read — reassigned per suite where quirks matter. */
let registry: DeviceRegistry = emptyRegistry();

function makeDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H61BE",
    deviceId: "AA:BB:CC:DD:EE:FF:1D:6F",
    name: "Test Light",
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
    channels: { lan: true, mqtt: true, cloud: true },
    ...overrides,
  };
}

describe("DiagnosticsCollector", () => {
  describe("addLog", () => {
    it("appends entries with timestamp + level + msg", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addLog("dev1", "warn", "First warning");
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const logs = result.recentLogs as Array<Record<string, unknown>>;
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("warn");
      expect(logs[0].msg).toBe("First warning");
      expect(logs[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("bounds at 100 entries — newest 100 retained (v2.9.1 raised cap)", async () => {
      const c = new DiagnosticsCollector(registry);
      for (let i = 0; i < 120; i++) {
        c.addLog("dev1", "info", `entry ${i}`);
      }
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const logs = result.recentLogs as Array<{ msg: string }>;
      expect(logs).toHaveLength(100);
      expect(logs[0].msg).toBe("entry 20");
      expect(logs[99].msg).toBe("entry 119");
    });

    it("ignores empty/non-string deviceId", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addLog("", "info", "msg");
      c.addLog(undefined as never, "info", "msg");
      const result = await c.generate(makeDevice(), "2.0.0");
      expect(result.recentLogs).toEqual([]);
    });

    it("ignores non-string msg without crashing", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addLog("dev1", "info", 42 as never);
      c.addLog("dev1", "info", { obj: 1 } as never);
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      expect(result.recentLogs).toEqual([]);
    });
  });

  describe("addMqttPacket", () => {
    it("captures packets with topic + hex", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addMqttPacket("dev1", "GA/abc/123", "qqgFAQEEAAAAA=");
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const packets = result.lastMqttPackets as Array<Record<string, unknown>>;
      expect(packets).toHaveLength(1);
      expect(packets[0].topic).toBe("GA/abc/123");
      expect(packets[0].hex).toBe("qqgFAQEEAAAAA=");
    });

    it("bounds at 50 packets — newest 50 retained (v2.9.1 raised cap)", async () => {
      const c = new DiagnosticsCollector(registry);
      for (let i = 0; i < 60; i++) {
        c.addMqttPacket("dev1", "GA/topic", `hex${i}`);
      }
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const packets = result.lastMqttPackets as Array<{ hex: string }>;
      expect(packets).toHaveLength(50);
      expect(packets[0].hex).toBe("hex10");
      expect(packets[49].hex).toBe("hex59");
    });

    it("rejects empty hex strings", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addMqttPacket("dev1", "topic", "");
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      expect(result.lastMqttPackets).toEqual([]);
    });
  });

  describe("recordApiSuccess / recordApiFailure", () => {
    it("stores response history per endpoint with most-recent at the end", async () => {
      const c = new DiagnosticsCollector(registry);
      c.recordApiSuccess("dev1", "/api/state", { code: 200, foo: "bar" });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const hist = result.apiHistory as Record<string, unknown[]>;
      const list = hist["/api/state"];
      expect(list).toHaveLength(1);
      const entry = list[0] as Record<string, unknown>;
      expect(entry.body).toEqual({ code: 200, foo: "bar" });
      expect(entry.endpoint).toBe("/api/state");
      expect(entry.ok).toBe(true);
      expect(entry.statusCode).toBe(200);
    });

    it("redacts secretCode and topic from recorded API responses so they never reach the diag export (SEC-ISSUE1)", async () => {
      const c = new DiagnosticsCollector(registry);
      c.recordApiSuccess("dev1", "/device/rest/devices/v1/list", {
        sku: "H5109",
        settings: {
          battery: 100,
          gatewayInfo: { secretCode: "VYb5QvZVkjE=", topic: "GD/f501fb9140eaf7", bleName: "ihoment_H5042_3795" },
        },
      });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const json = JSON.stringify(result);
      expect(json).not.toContain("VYb5QvZVkjE="); // gateway secret must be masked
      expect(json).not.toContain("GD/f501fb"); // gateway push topic must be masked
      expect(json).toContain("ihoment_H5042_3795"); // non-secret device metadata is kept
      const entry = (result.apiHistory as Record<string, Array<{ body: unknown }>>)["/device/rest/devices/v1/list"][0];
      const gw = (entry.body as { settings: { gatewayInfo: Record<string, unknown> } }).settings.gatewayInfo;
      expect(gw.secretCode).toBe("***");
      expect(gw.bleName).toBe("ihoment_H5042_3795");
    });

    it("keeps multiple slots per endpoint (no overwrite)", async () => {
      const c = new DiagnosticsCollector(registry);
      c.recordApiSuccess("dev1", "/api/state", { v: 1 });
      c.recordApiSuccess("dev1", "/api/state", { v: 2 });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const list = (result.apiHistory as Record<string, unknown[]>)["/api/state"] as Array<{ body: unknown }>;
      expect(list).toHaveLength(2);
      expect(list[0].body).toEqual({ v: 1 });
      expect(list[1].body).toEqual({ v: 2 });
    });

    it("evicts oldest entry when endpoint exceeds the per-endpoint cap (v2.9.1 cap=6)", async () => {
      const c = new DiagnosticsCollector(registry);
      for (let i = 1; i <= 8; i++) {
        c.recordApiSuccess("dev1", "/api/state", { v: i });
      }
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const list = (result.apiHistory as Record<string, unknown[]>)["/api/state"] as Array<{ body: unknown }>;
      // Cap is MAX_RESPONSES_PER_ENDPOINT = 6 — oldest dropped, newest at end.
      expect(list).toHaveLength(6);
      expect(list[0].body).toEqual({ v: 3 });
      expect(list[5].body).toEqual({ v: 8 });
    });

    it("evicts oldest endpoint when more than 24 distinct endpoints are tracked (v2.9.1 cap=24)", async () => {
      const c = new DiagnosticsCollector(registry);
      // 25 distinct endpoints — first should be evicted.
      for (let i = 0; i < 25; i++) {
        c.recordApiSuccess("dev1", `/ep${i}`, { v: i });
      }
      const hist = (await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0")).apiHistory as Record<
        string,
        unknown[]
      >;
      expect(hist["/ep0"]).toBeUndefined();
      expect(hist["/ep24"]).toBeDefined();
    });

    it("truncates large bodies with marker (v2.9.1 cap=65536)", async () => {
      const c = new DiagnosticsCollector(registry);
      // Body must exceed MAX_BODY_BYTES (65_536) to trigger truncation. Use
      // ~70 KB so the cloneAndCap branch fires.
      const big = "x".repeat(70_000);
      c.recordApiSuccess("dev1", "/api/big", { huge: big });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const list = (result.apiHistory as Record<string, Array<{ body: unknown }>>)["/api/big"];
      expect(typeof list[0].body).toBe("string");
      expect(list[0].body as string).toContain("<truncated");
    });

    it("keeps a device's API history under the byte budget — oldest entries anywhere go first, the newest stays", async () => {
      // 24 endpoints × 6 slots × 64 KB is >9 MB per device in theory; a light with
      // a big scene library really sat at a megabyte. Budget: 512 KB per device.
      const c = new DiagnosticsCollector(registry);
      const big = "x".repeat(60_000); // ~60 KB per entry, under the per-body cap
      for (let i = 0; i < 6; i++) {
        c.recordApiSuccess("dev1", "/api/scenes", { i, big });
      }
      for (let i = 0; i < 6; i++) {
        c.recordApiSuccess("dev1", "/api/library", { i, big });
      }
      const hist = (await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0")).apiHistory as Record<
        string,
        Array<{ body: { i: number }; bytes: number }>
      >;
      const all = [...(hist["/api/scenes"] ?? []), ...(hist["/api/library"] ?? [])];
      const total = all.reduce((sum, e) => sum + e.bytes, 0);
      expect(total).toBeLessThanOrEqual(512 * 1024);
      // 12 × ~60 KB = ~720 KB were recorded — the oldest scene entries were evicted
      // first, the newest library entry is always present.
      expect(all.length).toBeLessThan(12);
      expect(hist["/api/library"][hist["/api/library"].length - 1].body.i).toBe(5);
      expect(hist["/api/scenes"]?.[0]?.body.i ?? 6).toBeGreaterThan(0);
    });

    it("caps a captured MQTT envelope and a LAN payload instead of storing them whole", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addMqttPacket("dev1", "topic", { rawJson: "y".repeat(20_000), hex: "aa" });
      c.addLanSend("dev1", "10.0.0.5", "ptReal", { command: ["z".repeat(40_000)] });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const packet = (result.lastMqttPackets as Array<{ rawJson: string; hex: string }>)[0];
      expect(packet.hex).toBe("aa");
      expect(packet.rawJson.length).toBeLessThan(4_200);
      expect(packet.rawJson).toContain("<truncated 20000b>");
      const send = (result.lanSends as Array<{ payload: unknown }>)[0];
      expect(typeof send.payload).toBe("string");
      expect(send.payload as string).toContain("<truncated");
    });

    it("falls back to String() when body is non-serialisable", async () => {
      const c = new DiagnosticsCollector(registry);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      c.recordApiSuccess("dev1", "/api/cycle", cyclic);
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const list = (result.apiHistory as Record<string, Array<{ body: unknown }>>)["/api/cycle"];
      expect(typeof list[0].body).toBe("string");
    });

    it("recordApiFailure captures the error + status code so silent fetch failures become visible", async () => {
      const c = new DiagnosticsCollector(registry);
      c.recordApiFailure("dev1", "/light-effect-libraries", new Error("403 Forbidden"), 403);
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.0.0");
      const list = (result.apiHistory as Record<string, Array<Record<string, unknown>>>)["/light-effect-libraries"];
      expect(list).toHaveLength(1);
      expect(list[0].ok).toBe(false);
      expect(list[0].statusCode).toBe(403);
      expect(list[0].body).toEqual({ error: "403 Forbidden", status: 403 });
    });
  });

  describe("the report names WHY a device shows the reachability it shows", () => {
    it("a LAN light: the LAN reply decides, and the cloud sources are named as silent", async () => {
      // Tracing one device's reachability cost hours of reading the adapter's
      // source (2026-09-03) because the report carried the value and nothing
      // else. The deciding source, its last evidence and the sources that stay
      // silent by design are what actually answer "why does it show offline".
      const c = new DiagnosticsCollector(registry);
      const r = (await c.generate(
        makeDevice({ lanIp: "10.0.0.5", lastLanReplyAt: 1_700_000_000_000 }),
        "2.30.0",
      )) as Record<string, { reachabilitySource?: Record<string, unknown> }>;
      const src = r.device.reachabilitySource!;
      expect(src.decidedBy).toContain("LAN");
      expect(src.lastEvidenceAt).toBe(1_700_000_000_000);
      expect((src.silentSources as string[]).join(" ")).toContain("account push");
    });

    it("a cloud-only light: says the poll runs ONCE at start — the fact that took hours to find", async () => {
      const c = new DiagnosticsCollector(registry);
      const r = (await c.generate(makeDevice({ lanIp: undefined, state: { online: false } }), "2.30.0")) as Record<
        string,
        { reachabilitySource?: Record<string, unknown> }
      >;
      const src = r.device.reachabilitySource!;
      expect(String(src.refreshedBy)).toContain("ONCE");
      expect((src.silentSources as string[]).join(" ")).toContain("no local API");
    });
  });

  describe("the report says HOW the device is driven — the question it exists for", () => {
    it("names the channel and the reason per writable datapoint", async () => {
      // Adding a stranger's model means knowing which datapoint is reached over
      // which channel and why. The report carried the capability list and the
      // object tree — the two ends — but never the routing between them, so
      // "this control does nothing on my model" was unanswerable from a report.
      const c = new DiagnosticsCollector(registry);
      c.setObjectTreeProvider(() =>
        Promise.resolve([
          { id: "control.power", type: "boolean", role: "switch", write: true, val: true, ack: true },
          { id: "control.brightness", type: "number", role: "level.dimmer", write: true, val: 50, ack: true },
          { id: "info.online", type: "boolean", role: "indicator.reachable", write: false, val: true, ack: true },
        ]),
      );
      c.setControlPathProvider((_d, ids) =>
        ids.map(id => ({ stateId: id, command: "power", transport: "lan", reason: "default" })),
      );
      const r = await c.generate(makeDevice({ lanIp: "10.0.0.5" }), "2.29.4", "devices.h61be_1d6f");
      const paths = r.controlPaths as Array<Record<string, unknown>>;
      // Only WRITABLE datapoints — a read-only marker has no control path.
      expect(paths).toHaveLength(2);
      expect(paths[0]).toMatchObject({ transport: "lan", reason: "default" });
      expect(paths.map(p => p.stateId)).not.toContain("info.online");
    });

    it("stays null when nothing resolved it, instead of pretending an empty list", async () => {
      // An empty list would read as "this device has no controls at all" — a
      // wrong statement. Absent means "not determined".
      const c = new DiagnosticsCollector(registry);
      const r = await c.generate(makeDevice(), "2.29.4");
      expect(r.controlPaths).toBeNull();
    });
  });

  describe("account calls reach the report — without any credentials", () => {
    it("records the verdict and Govee's own message, never the credentials", async () => {
      // Two filed issues are exactly this case ("email not registered",
      // "too many logins"). The report used to show a dead push channel and
      // no reason at all.
      const c = new DiagnosticsCollector(registry);
      c.recordAccountCall("/account/rest/account/v2/login", false, 400, "Incorrect user name or password");
      c.recordAccountCall("/app/v1/account/iot/key", true, 200);
      const r = await c.generate(makeDevice(), "2.30.0");
      const calls = r.accountCalls as Array<Record<string, unknown>>;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ ok: false, statusCode: 400 });
      expect(String(calls[0].message)).toContain("Incorrect user name");
      // The whole report must not carry a password field, however Govee answers.
      expect(JSON.stringify(r)).not.toContain('password":');
    });

    it("a repeated rejection keeps the FIRST occurrence — the one that says when it started", async () => {
      // The client retries a rejected login, and the 24 h lockout in issue #39
      // came from that loop. A plain ring buffer would keep ten identical
      // entries and drop the first — losing the only one that dates the start.
      const c = new DiagnosticsCollector(registry);
      for (let i = 0; i < 15; i++) {
        c.recordAccountCall("/account/rest/account/v2/login", false, 400, "Incorrect user name or password");
      }
      c.recordAccountCall("/app/v1/account/iot/key", true, 200);
      const r = await c.generate(makeDevice(), "2.29.4");
      const calls = r.accountCalls as Array<Record<string, unknown>>;
      // Fifteen attempts, two distinct outcomes — not fifteen entries.
      expect(calls).toHaveLength(2);
      expect(calls[0].count).toBe(15);
      expect(calls[0].ts).toBeTruthy();
      expect(calls[0].lastTs).toBeTruthy();
    });

    it("an address echoed back by Govee never reaches the finished report", async () => {
      // Checks the OUTCOME, not the mechanism: the report-wide pass would catch
      // it too, so a test tied to the recorder's own call would pass either way
      // (measured — the mutation probe stayed green until this was rewritten).
      const c = new DiagnosticsCollector(registry);
      c.recordAccountCall("/account/rest/account/v2/login", false, 400, "no account for someone@example.com");
      const r = await c.generate(makeDevice(), "2.30.0");
      const calls = r.accountCalls as Array<Record<string, unknown>>;
      expect(String(calls[0].message)).not.toContain("someone@example.com");
    });
  });

  describe("generate — output shape", () => {
    beforeEach(() => {
      registry = new DeviceRegistry({
        data: {
          devices: {
            H6141: {
              name: "LED Strip",
              type: "light",
              status: "seed",
              quirks: { brokenPlatformApi: true },
            },
          },
        } as never,
        experimental: true,
      });
    });
    afterEach(() => {
      registry = emptyRegistry();
    });

    it("contains all v1.x top-level fields plus the v2 ring buffers", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(makeDevice(), "2.0.0");
      const keys = Object.keys(result).sort();
      expect(keys).toEqual(
        expect.arrayContaining([
          "adapter",
          "version",
          "exportedAt",
          "device",
          "capabilities",
          "scenes",
          "diyScenes",
          "snapshots",
          "sceneLibrary",
          "musicLibrary",
          "diyLibrary",
          "quirks",
          "skuFeatures",
          "state",
          "recentLogs",
          "lastMqttPackets",
          "apiHistory",
        ]),
      );
    });

    it("attaches active quirks for known SKUs", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(makeDevice({ sku: "H6141" }), "2.0.0");
      expect(result.quirks).toEqual({ brokenPlatformApi: true });
    });

    it("returns null quirks for unknown SKU", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(makeDevice({ sku: "H9999" }), "2.0.0");
      expect(result.quirks).toBeNull();
    });

    it("yields empty buffers if no hooks fired", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(makeDevice(), "2.0.0");
      expect(result.recentLogs).toEqual([]);
      expect(result.lastMqttPackets).toEqual([]);
      expect(result.apiHistory).toEqual({});
    });
  });

  // ===========================================================================
  // v2.9.1 diag-coverage wave — at least one regression test per class.
  // Finding classes A-K from the brief `feedback_diag_system_self_service.md`.
  // ===========================================================================

  describe("v2.9.1 Class A — raw Bytes in generate() (TUKEY-Blocker)", () => {
    it("A1 — snapshotBleCmds raw packets exposed per-snapshot", async () => {
      // H61BE n8licht fixture from research-snapshot-ptreal.md Z.69-86.
      // Two cmd-groups: brightness (cmdType 17) + A3 scene-data (cmdType 18).
      // Used as canonical test fixture so the test outlives Govee API drift.
      const N8LICHT_BLE_CMDS: string[][] = [
        ["MwRkAAAAAAAAAAAAAAAAAAAAAFM="],
        ["owABBEACABT/ypEAAQIDBAUGB1Q=", "owEICQoLDA0ODxAREhMBFGQAAdI=", "owIBAgMEBQYHCAkKCwwNDg8QERIToA=="],
      ];
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(
        makeDevice({
          snapshots: [{ name: "n8licht", value: 2719361 }],
          snapshotBleCmds: [N8LICHT_BLE_CMDS],
        }),
        "2.9.1",
      );
      const snaps = result.snapshots as { count: number; bleCmds: Array<{ name: string; packets: string[][] }> };
      expect(snaps.count).toBe(1);
      expect(snaps.bleCmds).toHaveLength(1);
      expect(snaps.bleCmds[0].name).toBe("n8licht");
      expect(snaps.bleCmds[0].packets).toEqual(N8LICHT_BLE_CMDS);
    });

    it("A2 — sceneLibrary surfaces scenceParam + speedInfo.config (not just hasParam)", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(
        makeDevice({
          sceneLibrary: [
            {
              name: "Easter",
              sceneCode: 11217,
              scenceParam: "AyYAAQAKAgH/GQG0Cgo=",
              speedInfo: { supSpeed: true, speedIndex: 1, config: '[{"page":0,"moveIn":[252,253,255]}]' },
            },
          ],
        }),
        "2.9.1",
      );
      const lib = result.sceneLibrary as { entries: Array<Record<string, unknown>> };
      expect(lib.entries[0].scenceParam).toBe("AyYAAQAKAgH/GQG0Cgo=");
      const speedInfo = lib.entries[0].speedInfo as { supSpeed: boolean; config: string };
      expect(speedInfo.supSpeed).toBe(true);
      expect(speedInfo.config).toContain("moveIn");
    });

    it("A4+A5 — diyLibrary and musicLibrary surface scenceParam", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(
        makeDevice({
          diyLibrary: [{ name: "MyDIY", diyCode: 10, scenceParam: "DIY_PARAM_BASE64" }],
          musicLibrary: [{ name: "Spectrum", musicCode: 1, scenceParam: "MUSIC_PARAM_BASE64", mode: 1 }],
        }),
        "2.9.1",
      );
      const diy = result.diyLibrary as { entries: Array<Record<string, unknown>> };
      const music = result.musicLibrary as { entries: Array<Record<string, unknown>> };
      expect(diy.entries[0].scenceParam).toBe("DIY_PARAM_BASE64");
      expect(music.entries[0].scenceParam).toBe("MUSIC_PARAM_BASE64");
    });
  });

  describe("v2.9.1 Class C3 — HttpError.responseBody flows into recordApiFailure", () => {
    it("captures responseBody so the diag JSON shows the body, not just the status", async () => {
      const c = new DiagnosticsCollector(registry);
      const err = new HttpError("HTTP 401", 401, {}, '{"message":"API key invalid"}');
      c.recordApiFailure("dev1", "/router/api/v1/user/devices", err, 401);
      const list = (
        (await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1")).apiHistory as Record<
          string,
          Array<Record<string, unknown>>
        >
      )["/router/api/v1/user/devices"];
      const body = list[0].body as Record<string, unknown>;
      expect(body.error).toBe("HTTP 401");
      expect(body.status).toBe(401);
      expect(body.responseBody).toBe('{"message":"API key invalid"}');
    });

    it("truncates the responseBody when it would exceed the cap", async () => {
      const c = new DiagnosticsCollector(registry);
      const huge = "x".repeat(80_000);
      const err = new HttpError("HTTP 500", 500, {}, huge);
      c.recordApiFailure("dev1", "/api/oops", err, 500);
      const list = (
        (await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1")).apiHistory as Record<
          string,
          Array<Record<string, unknown>>
        >
      )["/api/oops"];
      const body = list[0].body as Record<string, unknown>;
      expect((body.responseBody as string).length).toBeLessThan(80_000);
      expect((body.responseBody as string).endsWith("…")).toBe(true);
    });
  });

  describe("v2.9.1 Class E — LAN UDP send capture", () => {
    it("addLanSend records outgoing ptReal payloads per-device", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addLanSend("dev1", "192.168.1.36", "ptReal", { command: ["pkt1", "pkt2"] }, 572);
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      const sends = result.lanSends as Array<Record<string, unknown>>;
      expect(sends).toHaveLength(1);
      // The destination is pseudonymised — a marker, never the real address —
      // but it stays a stable one, so two sends to the same device remain
      // recognisably the same device.
      expect(sends[0].ip).toBe("address-local-1");
      expect(JSON.stringify(result)).not.toContain("192.168.1.36");
      expect(sends[0].cmd).toBe("ptReal");
      expect(sends[0].bytes).toBe(572);
      expect((sends[0].payload as Record<string, unknown[]>).command).toEqual(["pkt1", "pkt2"]);
    });

    it("captures error field when the UDP send fails", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addLanSend("dev1", "192.168.1.36", "ptReal", { command: ["pkt1"] }, 0, "EHOSTUNREACH");
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      const sends = result.lanSends as Array<Record<string, unknown>>;
      expect(sends[0].error).toBe("EHOSTUNREACH");
    });

    it("bounds at 30 lan-sends — newest 30 retained", async () => {
      const c = new DiagnosticsCollector(registry);
      for (let i = 0; i < 40; i++) {
        c.addLanSend("dev1", "192.168.1.36", "turn", { value: i }, 50);
      }
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      const sends = result.lanSends as Array<Record<string, unknown>>;
      expect(sends).toHaveLength(30);
    });
  });

  describe("v2.9.1 Class F1 — AWS-IoT MQTT envelope durchgereicht", () => {
    it("addMqttPacket accepts {hex, rawJson} so state-only pushes are captured too", async () => {
      const c = new DiagnosticsCollector(registry);
      const envelope = JSON.stringify({ sku: "H61BE", device: "AA:BB:CC", state: { onOff: 1 } });
      c.addMqttPacket("dev1", "GA/account", { hex: "abc123", rawJson: envelope });
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      const packets = result.lastMqttPackets as Array<Record<string, unknown>>;
      expect(packets[0].hex).toBe("abc123");
      expect(packets[0].rawJson).toBe(envelope);
    });

    it("addMqttPacket accepts rawJson-only (no op.command in MQTT message)", async () => {
      const c = new DiagnosticsCollector(registry);
      const envelope = JSON.stringify({ sku: "H61BE", device: "AA:BB:CC", state: { onOff: 1 } });
      c.addMqttPacket("dev1", "GA/account", { rawJson: envelope });
      const packets = (await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1")).lastMqttPackets as Array<
        Record<string, unknown>
      >;
      expect(packets[0].hex).toBeUndefined();
      expect(packets[0].rawJson).toBe(envelope);
    });

    it("ignores empty payload-objects (no hex AND no rawJson)", async () => {
      const c = new DiagnosticsCollector(registry);
      c.addMqttPacket("dev1", "GA/account", {});
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      expect(result.lastMqttPackets).toEqual([]);
    });
  });

  describe("v2.9.1 Class G — device-runtime fields in diag.device", () => {
    it("surfaces sceneSpeed, manualMode/manualSegments, lastSeenOnNetwork, lastLanReplyAt, groupMembers", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(
        makeDevice({
          deviceId: "dev1",
          sceneSpeed: 2,
          manualMode: true,
          manualSegments: [0, 1, 3, 5, 7],
          lastSeenOnNetwork: 1700000000000,
          lastLanReplyAt: 1700000001000,
          groupMembers: [{ sku: "H61BE", deviceId: "11:22:33" }],
        }),
        "2.9.1",
      );
      const dev = result.device as Record<string, unknown>;
      expect(dev.sceneSpeed).toBe(2);
      expect(dev.manualMode).toBe(true);
      expect(dev.manualSegments).toEqual([0, 1, 3, 5, 7]);
      expect(dev.lastSeenOnNetwork).toBe(1700000000000);
      expect(dev.lastLanReplyAt).toBe(1700000001000);
      expect(dev.groupMembers).toEqual([{ sku: "H61BE", deviceId: "11:22:33" }]);
    });
  });

  describe("v2.9.1 Class K — runtime-state provider", () => {
    it("provider returns a snapshot pulled at generate-time", async () => {
      const c = new DiagnosticsCollector(registry);
      c.setRuntimeStateProvider(() => ({
        deviceManagerLastErrorCategory: "TIMEOUT",
        cloudFailureReason: "Cloud request timeout",
        mqttFailureReason: null,
        rateLimiter: { usedToday: 42, usedThisMinute: 3, dailyLimit: 9000, perMinuteLimit: 8, queueLength: 0 },
        wizardSession: null,
        lanSeenDeviceIps: ["AA:BB:CC:DD:EE:FF:1D:6F:10.0.0.1"],
      }));
      const result = await c.generate(makeDevice(), "2.9.1");
      const rt = result.runtimeState as Record<string, unknown>;
      expect(rt.deviceManagerLastErrorCategory).toBe("TIMEOUT");
      expect(rt.cloudFailureReason).toBe("Cloud request timeout");
      expect((rt.rateLimiter as Record<string, number>).usedToday).toBe(42);
      // The discovery trace lists every device seen on the network — the one
      // field that carried addresses of devices the report is not even about.
      expect(rt.lanSeenDeviceIps).toEqual(["id-…1d6f:address-local-1"]);
      expect(JSON.stringify(result)).not.toContain("10.0.0.1");
      expect(JSON.stringify(result)).not.toContain("AA:BB:CC:DD:EE:FF");
    });

    it("yields null runtimeState when no provider is wired", async () => {
      const c = new DiagnosticsCollector(registry);
      const result = await c.generate(makeDevice(), "2.9.1");
      expect(result.runtimeState).toBeNull();
    });

    it("cacheSnapshotProvider returns the persisted view; clone-and-cap protects bigger payloads", async () => {
      const c = new DiagnosticsCollector(registry);
      c.setCacheSnapshotProvider((sku, deviceId) => ({
        cachedAt: 1700000000000,
        sceneLibrary: [{ name: "Forest", sceneCode: 212 }],
        snapshotBleCmds: [[["BASE64_OF_PACKET"]]],
        skuFromArg: sku,
        deviceFromArg: deviceId,
      }));
      const result = await c.generate(makeDevice({ sku: "H61BE", deviceId: "dev1" }), "2.9.1");
      const cache = result.cache as Record<string, unknown>;
      expect(cache.skuFromArg).toBe("H61BE");
      expect(cache.deviceFromArg).toBe("dev1");
      expect(cache.cachedAt).toBe(1700000000000);
    });

    it("localSnapshotsProvider returns user-saved snapshot definitions", async () => {
      const c = new DiagnosticsCollector(registry);
      c.setLocalSnapshotsProvider(() => [
        { name: "Morning", power: true, brightness: 60, colorRgb: "#ffaa00", colorTemperature: 0 },
      ]);
      const result = await c.generate(makeDevice({ deviceId: "dev1" }), "2.9.1");
      const snaps = result.localSnapshots as Array<Record<string, unknown>>;
      expect(snaps).toHaveLength(1);
      expect(snaps[0].name).toBe("Morning");
      expect(snaps[0].brightness).toBe(60);
    });
  });
});

describe("pruneOrphans — buffers of removed devices are released", () => {
  it("drops every ring buffer of a device that is no longer live and keeps the live ones intact", async () => {
    const c = new DiagnosticsCollector(registry);
    c.addLog("gone", "warn", "old");
    c.addMqttPacket("gone", "GA/t", "aa");
    c.recordApiSuccess("gone", "/api/x", { v: 1 });
    c.addLanSend("gone", "10.0.0.2", "turn", { value: 1 }, 10);
    c.addLog("live", "info", "still here");
    c.recordApiSuccess("live", "/api/x", { v: 2 });

    c.pruneOrphans(new Set(["live"]));

    const goneReport = await c.generate(makeDevice({ deviceId: "gone" }), "2.0.0");
    expect(goneReport.recentLogs).toEqual([]);
    expect(goneReport.lastMqttPackets).toEqual([]);
    expect(goneReport.apiHistory).toEqual({});
    expect(goneReport.lanSends).toEqual([]);
    const liveReport = await c.generate(makeDevice({ deviceId: "live" }), "2.0.0");
    expect(liveReport.recentLogs).toHaveLength(1);
    expect((liveReport.apiHistory as Record<string, unknown[]>)["/api/x"]).toHaveLength(1);
  });

  it("is a no-op when every buffered device is still live", async () => {
    const c = new DiagnosticsCollector(registry);
    c.addLog("a", "info", "x");
    c.pruneOrphans(new Set(["a", "b"]));
    expect((await c.generate(makeDevice({ deviceId: "a" }), "2.0.0")).recentLogs).toHaveLength(1);
  });
});
