import { vi } from "vitest";
import { GoveeApiClient, parseLastData, parseSettings } from "./govee-api-client";
import { httpsRequest } from "./http-client";

// The scene / music / DIY library walkers call the module-level httpsRequest
// (no DI), so mock it to drive walkCategories + the per-walker extraction.
vi.mock("./http-client", () => ({ httpsRequest: vi.fn() }));
const mockHttp = vi.mocked(httpsRequest);

const apiLog = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  level: "debug",
} as unknown as ioBroker.Logger;

/**
 * Wrap a parsed body as the HttpResult envelope the walkers read via `result.value`.
 *
 * @param data Parsed response body to wrap
 */
function httpOk(data: unknown): never {
  return { value: data, statusCode: 200 } as never;
}

/**
 * App-API parser tests — parseLastData/parseSettings are pure helpers that
 * decode the JSON-in-JSON Govee returns from
 * `POST /device/rest/devices/v1/list`. They live in govee-api-client.ts
 * (same module as the unified GoveeApiClient class).
 *
 * Capability-synthesis tests (`buildCapabilitiesFromAppEntry`) follow in
 * session 6 once the device-manager learns to consume App-API payloads.
 */
describe("AppApiClient — lastDeviceData parser", () => {
  it("parses the full H5179 payload captured from /device/rest/devices/v1/list", () => {
    const raw = '{"online":true,"tem":2370,"hum":4290,"lastTime":1776704461000}';
    const out = parseLastData(raw);
    expect(out).toEqual({
      online: true,
      tem: 2370,
      hum: 4290,
      lastTime: 1776704461000,
    });
  });

  it("accepts numeric online=1/0 (older firmware variants)", () => {
    expect(parseLastData('{"online":1,"tem":100}')).toEqual(expect.objectContaining({ online: true }));
    expect(parseLastData('{"online":0}')).toEqual(expect.objectContaining({ online: false }));
  });

  it("ignores unexpected types for each field", () => {
    const raw = '{"online":"yes","tem":"warm","hum":4290}';
    const out = parseLastData(raw);
    expect(out).toEqual({ hum: 4290 });
  });

  it("ignores NaN/Infinity in tem/hum", () => {
    expect(parseLastData('{"tem":null,"hum":null}')).toEqual({});
  });

  it("returns undefined on malformed JSON", () => {
    expect(parseLastData("not json")).toBe(undefined);
    expect(parseLastData("")).toBe(undefined);
    expect(parseLastData(undefined)).toBe(undefined);
  });

  it("preserves battery when present", () => {
    expect(parseLastData('{"battery":75,"tem":2000}')).toEqual(expect.objectContaining({ battery: 75 }));
  });
});

describe("AppApiClient — deviceSettings parser", () => {
  it("parses the captured H5179 settings payload", () => {
    const raw =
      '{"uploadRate":10,"temMin":-2000,"battery":100,"wifiName":"krobisnet","temMax":6000,"humMin":0,"humMax":10000,"fahOpen":false}';
    const out = parseSettings(raw);
    expect(out).toEqual(
      expect.objectContaining({
        uploadRate: 10,
        temMin: -2000,
        battery: 100,
        wifiName: "krobisnet",
        fahOpen: false,
      }),
    );
  });

  it("returns undefined on malformed input", () => {
    expect(parseSettings("not json")).toBe(undefined);
    expect(parseSettings(undefined)).toBe(undefined);
    expect(parseSettings("")).toBe(undefined);
  });
});

// D4 — the scene/music/DIY walkers share walkCategories. These exercise the
// refactored branches: multi-variant naming, the no-effects scene-level code,
// speedInfo carry-through, the defensive guards, the music modeIdx counter and
// the bearer-token gate. Previously the walkers had zero coverage repo-wide.
describe("GoveeApiClient — library walkers (walkCategories)", () => {
  beforeEach(() => mockHttp.mockReset());

  describe("fetchSceneLibrary", () => {
    it("expands multi-variant scenes into Name-suffix entries", async () => {
      mockHttp.mockResolvedValue(
        httpOk({
          data: {
            categories: [
              {
                scenes: [
                  {
                    sceneName: "Aurora",
                    lightEffects: [
                      { sceneCode: 10, scenceName: "A", scenceParam: "p1" },
                      { sceneCode: 11, scenceName: "B", scenceParam: "p2" },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      );
      const scenes = await new GoveeApiClient(apiLog).fetchSceneLibrary("H61BE");
      expect(scenes).toEqual([
        { name: "Aurora-A", sceneCode: 10, scenceParam: "p1" },
        { name: "Aurora-B", sceneCode: 11, scenceParam: "p2" },
      ]);
    });

    it("uses the scene-level code when there are no lightEffects", async () => {
      mockHttp.mockResolvedValue(
        httpOk({ data: { categories: [{ scenes: [{ sceneName: "Solid", sceneCode: 42, lightEffects: [] }] }] } }),
      );
      expect(await new GoveeApiClient(apiLog).fetchSceneLibrary("H61BE")).toEqual([{ name: "Solid", sceneCode: 42 }]);
    });

    it("carries speedInfo only when supSpeed is true", async () => {
      mockHttp.mockResolvedValue(
        httpOk({
          data: {
            categories: [
              {
                scenes: [
                  {
                    sceneName: "Fast",
                    lightEffects: [{ sceneCode: 5, speedInfo: { supSpeed: true, speedIndex: 2, config: "cfg" } }],
                  },
                ],
              },
            ],
          },
        }),
      );
      const scenes = await new GoveeApiClient(apiLog).fetchSceneLibrary("H61BE");
      expect(scenes[0].speedInfo).toEqual({ supSpeed: true, speedIndex: 2, config: "cfg" });
    });

    it("skips non-string sceneNames and codes <= 0 (walkCategories guards)", async () => {
      mockHttp.mockResolvedValue(
        httpOk({
          data: {
            categories: [
              null,
              { scenes: "nope" },
              {
                scenes: [
                  { sceneName: 123, lightEffects: [{ sceneCode: 9 }] },
                  { sceneName: "", lightEffects: [{ sceneCode: 9 }] },
                  { sceneName: "Zero", lightEffects: [{ sceneCode: 0 }] },
                  { sceneName: "Keep", lightEffects: [{ sceneCode: 7 }] },
                ],
              },
            ],
          },
        }),
      );
      expect(await new GoveeApiClient(apiLog).fetchSceneLibrary("H61BE")).toEqual([{ name: "Keep", sceneCode: 7 }]);
    });

    it("returns [] for a non-array categories payload", async () => {
      mockHttp.mockResolvedValue(httpOk({ data: { categories: "broken" } }));
      expect(await new GoveeApiClient(apiLog).fetchSceneLibrary("H61BE")).toEqual([]);
    });
  });

  describe("fetchMusicLibrary", () => {
    it("returns [] without a bearer token (auth-gated)", async () => {
      const modes = await new GoveeApiClient(apiLog).fetchMusicLibrary("H61BE");
      expect(modes).toEqual([]);
      expect(mockHttp).not.toHaveBeenCalled();
    });

    it("assigns an incrementing mode index per scene and uses lightEffects[0]", async () => {
      mockHttp.mockResolvedValue(
        httpOk({
          data: {
            categories: [
              {
                scenes: [
                  { sceneName: "Energic", lightEffects: [{ sceneCode: 20, scenceParam: "m1" }] },
                  { sceneName: "Spectrum", sceneCode: 21, lightEffects: [] },
                ],
              },
            ],
          },
        }),
      );
      const client = new GoveeApiClient(apiLog);
      client.setBearerToken("tok");
      expect(await client.fetchMusicLibrary("H61BE")).toEqual([
        { name: "Energic", musicCode: 20, scenceParam: "m1", mode: 0 },
        { name: "Spectrum", musicCode: 21, mode: 1 },
      ]);
    });
  });

  describe("fetchDiyLibrary", () => {
    it("returns [] without a bearer token (auth-gated)", async () => {
      expect(await new GoveeApiClient(apiLog).fetchDiyLibrary("H61BE")).toEqual([]);
    });

    it("parses diy codes from lightEffects[0]", async () => {
      mockHttp.mockResolvedValue(
        httpOk({
          data: {
            categories: [{ scenes: [{ sceneName: "MyDIY", lightEffects: [{ sceneCode: 30, scenceParam: "d1" }] }] }],
          },
        }),
      );
      const client = new GoveeApiClient(apiLog);
      client.setBearerToken("tok");
      expect(await client.fetchDiyLibrary("H61BE")).toEqual([{ name: "MyDIY", diyCode: 30, scenceParam: "d1" }]);
    });
  });
});

describe("GoveeApiClient — fetchDeviceList (sensor device list)", () => {
  beforeEach(() => mockHttp.mockReset());

  it("returns [] without a bearer token", async () => {
    expect(await new GoveeApiClient(apiLog).fetchDeviceList()).toEqual([]);
    expect(mockHttp).not.toHaveBeenCalled();
  });

  it("parses devices with embedded lastData/settings and skips malformed entries", async () => {
    mockHttp.mockResolvedValue(
      httpOk({
        devices: [
          {
            sku: "H5179",
            device: "AA:BB",
            deviceName: "Thermo",
            deviceId: 7,
            deviceExt: {
              lastDeviceData: '{"online":true,"tem":2370,"hum":4290}',
              deviceSettings: '{"uploadRate":10}',
            },
          },
          { sku: "H6160" }, // no `device` → skipped
          null, // skipped
        ],
      }),
    );
    const client = new GoveeApiClient(apiLog);
    client.setBearerToken("tok");
    const list = await client.fetchDeviceList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sku: "H5179", device: "AA:BB", deviceName: "Thermo", deviceId: 7 });
    expect(list[0].lastData).toMatchObject({ online: true, tem: 2370, hum: 4290 });
    expect(list[0].settings).toMatchObject({ uploadRate: 10 });
  });

  it("falls back deviceName to sku when missing and returns [] for a non-array payload", async () => {
    const client = new GoveeApiClient(apiLog);
    client.setBearerToken("tok");
    mockHttp.mockResolvedValue(httpOk({ devices: [{ sku: "H6172", device: "CC:DD" }] }));
    expect((await client.fetchDeviceList())[0].deviceName).toBe("H6172");

    mockHttp.mockResolvedValue(httpOk({ devices: "broken" }));
    expect(await client.fetchDeviceList()).toEqual([]);
  });
});

describe("GoveeApiClient — fetchSkuFeatures", () => {
  beforeEach(() => mockHttp.mockReset());

  it("returns null without a bearer token", async () => {
    expect(await new GoveeApiClient(apiLog).fetchSkuFeatures("H61BE")).toBeNull();
  });

  it("returns the data object, and null for a null body or a missing data key", async () => {
    const client = new GoveeApiClient(apiLog);
    client.setBearerToken("tok");
    mockHttp.mockResolvedValue(httpOk({ data: { supportScene: true } }));
    expect(await client.fetchSkuFeatures("H61BE")).toEqual({ supportScene: true });
    mockHttp.mockResolvedValue(httpOk(null)); // JSON-null body on some unknown SKUs
    expect(await client.fetchSkuFeatures("H61BE")).toBeNull();
    mockHttp.mockResolvedValue(httpOk({})); // object without `data`
    expect(await client.fetchSkuFeatures("H61BE")).toBeNull();
  });
});

describe("GoveeApiClient — fetchSnapshots (ptReal BLE cmds)", () => {
  beforeEach(() => mockHttp.mockReset());

  it("returns [] without a bearer token", async () => {
    expect(await new GoveeApiClient(apiLog).fetchSnapshots("H61BE", "AA:BB")).toEqual([]);
  });

  it("parses bleCmd packets and drops nameless / malformed-JSON / empty snapshots", async () => {
    const client = new GoveeApiClient(apiLog);
    client.setBearerToken("tok");
    mockHttp.mockResolvedValue(
      httpOk({
        data: {
          snapshots: [
            {
              name: "Movie",
              cmds: [{ bleCmds: JSON.stringify({ bleCmd: "AA,BB,CC" }) }, { bleCmds: "not json" }],
            },
            { name: "", cmds: [{ bleCmds: JSON.stringify({ bleCmd: "XX" }) }] }, // no name → skipped
            { name: "Empty", cmds: [{ bleCmds: JSON.stringify({ bleCmd: "" }) }] }, // no packets → not pushed
          ],
        },
      }),
    );
    expect(await client.fetchSnapshots("H61BE", "AA:BB")).toEqual([{ name: "Movie", bleCmds: [["AA", "BB", "CC"]] }]);
  });
});

describe("GoveeApiClient — fetchGroupMembers", () => {
  beforeEach(() => mockHttp.mockReset());

  it("returns [] without a bearer token", async () => {
    expect(await new GoveeApiClient(apiLog).fetchGroupMembers()).toEqual([]);
  });

  it("parses groups, drops those without gId or valid devices, falls back name to ''", async () => {
    const client = new GoveeApiClient(apiLog);
    client.setBearerToken("tok");
    mockHttp.mockResolvedValue(
      httpOk({
        data: {
          components: [
            {
              groups: [
                { gId: 1, name: "Living", devices: [{ sku: "H61BE", device: "AA" }, { sku: "H6160" }] },
                { gId: 2, devices: [{ sku: "H6172", device: "BB" }] }, // no name → ""
                { name: "NoId", devices: [{ sku: "H6160", device: "CC" }] }, // no gId → skipped
                { gId: 3, devices: [{ sku: "H6160" }] }, // no valid device → not pushed
              ],
            },
          ],
        },
      }),
    );
    expect(await client.fetchGroupMembers()).toEqual([
      { groupId: 1, name: "Living", devices: [{ sku: "H61BE", deviceId: "AA" }] },
      { groupId: 2, name: "", devices: [{ sku: "H6172", deviceId: "BB" }] },
    ]);
  });
});
