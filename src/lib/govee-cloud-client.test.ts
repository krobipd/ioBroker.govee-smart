import { GoveeCloudClient } from "./govee-cloud-client";
import { HttpError, type HttpRequestOptions, type HttpResult, type HttpsRequestFn } from "./http-client";
import { mockLog } from "./test-helpers";

/**
 * Helper to build a fake httpsRequest impl. The recorder collects every
 * call, the response is a function so tests can vary the result per call.
 *
 * Tests may return either a bare value (auto-wrapped as `{value, statusCode:200}`),
 * a pre-built `HttpResult<T>`, or an Error (becomes a rejection).
 */
interface FakeHttpsRequest {
  fn: HttpsRequestFn;
  calls: HttpRequestOptions[];
}

function isHttpResult(x: unknown): x is HttpResult<unknown> {
  return typeof x === "object" && x !== null && "statusCode" in x && "value" in x;
}

function makeFakeHttps(respond: (call: HttpRequestOptions, idx: number) => unknown): FakeHttpsRequest {
  const calls: HttpRequestOptions[] = [];
  const fn: HttpsRequestFn = <T>(options: HttpRequestOptions): Promise<HttpResult<T>> => {
    calls.push(options);
    const result = respond(options, calls.length - 1);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    if (isHttpResult(result)) {
      return Promise.resolve(result as HttpResult<T>);
    }
    return Promise.resolve({ value: result as T, statusCode: 200 });
  };
  return { fn, calls };
}

describe("GoveeCloudClient", () => {
  describe("getFailureReason", () => {
    it("should return null when no error has occurred", () => {
      const client = new GoveeCloudClient("test-api-key", mockLog);
      expect(client.getFailureReason()).toBeNull();
    });

    it("should return AUTH message after a 401 response", async () => {
      const fake = makeFakeHttps(() => new HttpError("Unauthorized", 401, {}));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      try {
        await client.getDevices();
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
      }
      expect(client.getFailureReason()).toBe("API key rejected — check Govee API key");
    });

    it("should return RATE_LIMIT message after 429", async () => {
      const fake = makeFakeHttps(() => new HttpError("Too many requests", 429, { "retry-after": "60" }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      try {
        await client.getDevices();
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        // 429 is re-thrown with a retry-after hint
        expect((e as HttpError).message).toContain("retry after 60s");
      }
      expect(client.getFailureReason()).toBe("rate-limited by Govee — will retry");
    });

    it("should return NETWORK message after generic Error (ECONNRESET-Style)", async () => {
      const err: Error & { code?: string } = new Error("ECONNRESET");
      err.code = "ECONNRESET";
      const fake = makeFakeHttps(() => err);
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      try {
        await client.getDevices();
        throw new Error("expected throw");
      } catch (_e) {
        // expected
      }
      expect(client.getFailureReason()).toBe("cannot reach Govee servers — will retry");
    });

    it("should reset lastErrorCategory on next successful call", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps(() => {
        if (callIdx++ === 0) {
          return new HttpError("Unauthorized", 401, {});
        }
        return { data: [] };
      });
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      try {
        await client.getDevices();
      } catch (_e) {
        // expected
      }
      expect(client.getFailureReason()).toBe("API key rejected — check Govee API key");
      // Erfolgreicher Call resettet
      const result = await client.getDevices();
      expect(result).toEqual([]);
      expect(client.getFailureReason()).toBeNull();
    });
  });

  describe("setResponseHook", () => {
    it("should accept a callback", () => {
      const client = new GoveeCloudClient("test-api-key", mockLog);
      const calls: Array<{ deviceId: string; endpoint: string; body: unknown }> = [];
      client.setResponseHook((deviceId, endpoint, body) => {
        calls.push({ deviceId, endpoint, body });
      });
      expect(calls).toHaveLength(0);
    });

    it("should accept null to clear the hook", () => {
      const client = new GoveeCloudClient("test-api-key", mockLog);
      client.setResponseHook(() => {});
      expect(() => client.setResponseHook(null)).not.toThrow();
    });

    it("should fire the hook on getDeviceState", async () => {
      const fake = makeFakeHttps(() => ({
        data: { capabilities: [{ type: "x", instance: "y", state: { value: 1 } }] },
      }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const captured: Array<{ deviceId: string; endpoint: string }> = [];
      client.setResponseHook((deviceId, endpoint, _body) => captured.push({ deviceId, endpoint }));
      await client.getDeviceState("H6160", "AABBCC");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({ deviceId: "AABBCC", endpoint: "/router/api/v1/device/state" });
    });
  });

  describe("getDevices", () => {
    it("should return the data array on success", async () => {
      const fake = makeFakeHttps(() => ({ data: [{ sku: "H6160", device: "AABBCC", deviceName: "Test" }] }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const devices = await client.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].sku).toBe("H6160");
    });

    it("should return [] when data is missing or non-array (defensive)", async () => {
      const fake = makeFakeHttps(() => ({ data: "not-an-array" }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const devices = await client.getDevices();
      expect(devices).toEqual([]);
    });

    it("should return [] when response is empty object", async () => {
      const fake = makeFakeHttps(() => ({}));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const devices = await client.getDevices();
      expect(devices).toEqual([]);
    });

    it("should send GET to /router/api/v1/user/devices with API key header", async () => {
      const fake = makeFakeHttps(() => ({ data: [] }));
      const client = new GoveeCloudClient("the-key", mockLog, fake.fn);
      await client.getDevices();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].method).toBe("GET");
      expect(fake.calls[0].url).toContain("/router/api/v1/user/devices");
      expect(fake.calls[0].headers["Govee-API-Key"]).toBe("the-key");
    });
  });

  describe("getDeviceState", () => {
    it("should return capabilities array on success", async () => {
      const fake = makeFakeHttps(() => ({
        data: {
          capabilities: [
            { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } },
            { type: "devices.capabilities.range", instance: "brightness", state: { value: 80 } },
          ],
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const caps = await client.getDeviceState("H6160", "AABB");
      expect(caps).toHaveLength(2);
    });

    it("should return [] when capabilities missing", async () => {
      const fake = makeFakeHttps(() => ({ data: {} }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const caps = await client.getDeviceState("H6160", "AABB");
      expect(caps).toEqual([]);
    });

    it("should send POST with sku+device payload", async () => {
      const fake = makeFakeHttps(() => ({ data: { capabilities: [] } }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await client.getDeviceState("H6160", "AABB");
      expect(fake.calls[0].method).toBe("POST");
      expect(fake.calls[0].url).toContain("/router/api/v1/device/state");
      const body = fake.calls[0].body as { payload: { sku: string; device: string } };
      expect(body.payload.sku).toBe("H6160");
      expect(body.payload.device).toBe("AABB");
    });
  });

  describe("controlDevice", () => {
    it("should send POST to /router/api/v1/device/control with capability payload", async () => {
      const fake = makeFakeHttps(() => ({}));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await client.controlDevice("H6160", "AABB", "devices.capabilities.on_off", "powerSwitch", 1);
      expect(fake.calls[0].method).toBe("POST");
      expect(fake.calls[0].url).toContain("/router/api/v1/device/control");
      const body = fake.calls[0].body as {
        payload: { capability: { type: string; instance: string; value: unknown } };
      };
      expect(body.payload.capability.type).toBe("devices.capabilities.on_off");
      expect(body.payload.capability.instance).toBe("powerSwitch");
      expect(body.payload.capability.value).toBe(1);
    });

    it("should fire the response hook with request + response shape", async () => {
      const fake = makeFakeHttps(() => ({ ok: true }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const captured: unknown[] = [];
      client.setResponseHook((_d, _e, body) => captured.push(body));
      await client.controlDevice("H6160", "AABB", "devices.capabilities.on_off", "powerSwitch", 1);
      expect(captured).toHaveLength(1);
      const hookBody = captured[0] as { request: unknown; response: unknown };
      expect(Object.keys(hookBody).sort()).toEqual(["request", "response"]);
    });
  });

  describe("getScenes", () => {
    it("should split lightScene/diyScene/snapshot into separate buckets", async () => {
      const fake = makeFakeHttps(() => ({
        payload: {
          capabilities: [
            {
              type: "devices.capabilities.dynamic_scene",
              instance: "lightScene",
              parameters: {
                options: [
                  { name: "Sunset", value: { id: 1, paramId: "abc" } },
                  { name: "Sunrise", value: { id: 2, paramId: "def" } },
                ],
              },
            },
            {
              type: "devices.capabilities.dynamic_scene",
              instance: "diyScene",
              parameters: { options: [{ name: "MyDIY", value: { id: 100, paramId: "xyz" } }] },
            },
            {
              type: "devices.capabilities.dynamic_scene",
              instance: "snapshot",
              parameters: { options: [{ name: "Snap1", value: { id: 5, paramId: "snp" } }] },
            },
          ],
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const result = await client.getScenes("H6160", "AABB");
      expect(result.lightScenes).toHaveLength(2);
      expect(result.diyScenes).toHaveLength(1);
      expect(result.snapshots).toHaveLength(1);
    });

    it("should defend against malformed capability entries", async () => {
      const fake = makeFakeHttps(() => ({
        payload: {
          capabilities: [
            null,
            { instance: 123 }, // non-string instance
            {
              instance: "lightScene",
              parameters: {
                options: [
                  { name: "valid", value: { x: 1 } },
                  { name: 42, value: {} }, // non-string name → filtered
                  { value: { x: 2 } }, // missing name → filtered
                ],
              },
            },
          ],
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const result = await client.getScenes("H6160", "AABB");
      expect(result.lightScenes).toHaveLength(1);
      expect(result.lightScenes[0].name).toBe("valid");
    });

    it("should return empty buckets for missing payload", async () => {
      const fake = makeFakeHttps(() => ({}));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const result = await client.getScenes("H6160", "AABB");
      expect(result.lightScenes).toEqual([]);
      expect(result.diyScenes).toEqual([]);
      expect(result.snapshots).toEqual([]);
    });

    it("keeps integer-valued snapshot options and rejects null-valued phantoms (L7)", async () => {
      const fake = makeFakeHttps(() => ({
        payload: {
          capabilities: [
            {
              type: "devices.capabilities.dynamic_scene",
              instance: "snapshot",
              parameters: {
                options: [
                  { name: "IntSnap", value: 7 }, // snapshots use integer values — must be KEPT
                  { name: "Phantom", value: null }, // typeof null === "object" slipped through — must be REJECTED
                ],
              },
            },
          ],
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const result = await client.getScenes("H6160", "AABB");
      expect(result.snapshots).toEqual([{ name: "IntSnap", value: 7 }]);
    });
  });

  describe("getDiyScenes", () => {
    it("should return scenes array on success", async () => {
      const fake = makeFakeHttps(() => ({
        payload: {
          capabilities: [
            {
              instance: "diyScene",
              parameters: {
                options: [
                  { name: "DIY1", value: { id: 100 } },
                  { name: "DIY2", value: { id: 101 } },
                ],
              },
            },
          ],
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const scenes = await client.getDiyScenes("H6160", "AABB");
      expect(scenes).toHaveLength(2);
    });

    it("should return [] when no capabilities", async () => {
      const fake = makeFakeHttps(() => ({ payload: { capabilities: [] } }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const scenes = await client.getDiyScenes("H6160", "AABB");
      expect(scenes).toEqual([]);
    });
  });
});
