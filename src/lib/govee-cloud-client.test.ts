import { CloudControlRejected, GoveeCloudClient } from "./govee-cloud-client";
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

/**
 * Govee's real answer to POST /router/api/v1/device/state — the H7127 purifier
 * from issue #47's 2.34.0 export (Ressourcen/govee-smart/issue47-fixtures/
 * get_device_state_h7127_live_2026-09-11.json). The envelope is `payload`, the
 * message field is `msg`; `data` is the envelope of the device LIST only.
 */
const H7127_STATE_ENVELOPE = {
  requestId: "state_1789104406298_1",
  msg: "success",
  code: 200,
  payload: {
    sku: "H7127",
    device: "AA:BB",
    capabilities: [
      { type: "devices.capabilities.online", instance: "online", state: { value: true } },
      { type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 0 } },
      {
        type: "devices.capabilities.work_mode",
        instance: "workMode",
        state: { value: { workMode: 2, modeValue: 0 } },
      },
      { type: "devices.capabilities.property", instance: "filterLifeTime", state: { value: 72 } },
      { type: "devices.capabilities.property", instance: "airQuality", state: { value: 6 } },
    ],
  },
};

describe("GoveeCloudClient", () => {
  describe("getFailureReason", () => {
    it("should return null when no error has occurred", () => {
      const client = new GoveeCloudClient("test-api-key", mockLog);
      expect(client.getFailureReason()).toBeNull();
    });

    it("should return AUTH message after a 401 response (via the 401 status, not the message — L26)", async () => {
      // Message deliberately does NOT contain "auth" so this exercises the 401
      // status-code classification, not an accidental substring match.
      const fake = makeFakeHttps(() => new HttpError("Access denied", 401, {}));
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
      } catch {
        // expected
      }
      expect(client.getFailureReason()).toBe("cannot reach Govee servers — will retry");
    });

    it("should reset lastErrorCategory on next successful call", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps(() => {
        if (callIdx++ === 0) {
          return new HttpError("Access denied", 401, {}); // 401 via status, not an "auth" substring (L26)
        }
        return { data: [] };
      });
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      try {
        await client.getDevices();
      } catch {
        // expected
      }
      expect(client.getFailureReason()).toBe("API key rejected — check Govee API key");
      // Erfolgreicher Call resettet
      const result = await client.getDevices();
      expect(result).toEqual([]);
      expect(client.getFailureReason()).toBeNull();
    });
  });

  describe("setContactHook", () => {
    it("reports an accepted call as ok and a 401/403 as auth-failed", async () => {
      const answers: unknown[] = [
        { data: [] },
        new HttpError("Access denied", 401, {}),
        new HttpError("Forbidden", 403, {}),
      ];
      const fake = makeFakeHttps((_c, idx) => answers[idx]);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const seen: string[] = [];
      client.setContactHook(o => seen.push(o));
      await client.getDevices();
      await expect(client.getDevices()).rejects.toBeInstanceOf(HttpError);
      await expect(client.getDevices()).rejects.toBeInstanceOf(HttpError);
      expect(seen).toEqual(["ok", "auth-failed", "auth-failed"]);
    });

    it("reports a call that never reached Govee as unreachable, with its error text (issue #51)", async () => {
      const answers: unknown[] = [
        Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("getaddrinfo ENOTFOUND openapi.api.govee.com"), { code: "ENOTFOUND" }),
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        new Error("Timeout after 15000ms for POST openapi.api.govee.com/router/api/v1/device/control"),
        new HttpError("HTTP 500", 500, {}),
        new HttpError("Bad gateway", 502, {}),
        new HttpError("HTTP 503", 503, {}),
        Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      ];
      const fake = makeFakeHttps((_c, idx) => answers[idx]);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const seen: Array<[string, string | undefined]> = [];
      client.setContactHook((o, r) => seen.push([o, r]));
      for (let i = 0; i < answers.length; i++) {
        await expect(client.getDevices()).rejects.toBeDefined();
      }
      expect(seen.map(([o]) => o)).toEqual(Array(answers.length).fill("unreachable"));
      expect(seen[1][1]).toContain("ENOTFOUND");
      expect(seen[6][1]).toContain("503");
    });

    it("stays silent where Govee answered or the adapter aborted — 429, 400, 404, Aborted", async () => {
      const answers: unknown[] = [
        new HttpError("Too many requests", 429, { "retry-after": "60" }),
        new HttpError("HTTP 400", 400, {}),
        new HttpError("HTTP 404", 404, {}),
        new Error("Aborted"),
      ];
      const fake = makeFakeHttps((_c, idx) => answers[idx]);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const seen: string[] = [];
      client.setContactHook(o => seen.push(o));
      for (let i = 0; i < answers.length; i++) {
        await expect(client.getDevices()).rejects.toBeDefined();
      }
      expect(seen).toEqual([]);
    });

    it("a throwing hook never fails the request", async () => {
      const fake = makeFakeHttps(() => ({ data: [] }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      client.setContactHook(() => {
        throw new Error("hook broke");
      });
      await expect(client.getDevices()).resolves.toEqual([]);
    });
  });

  describe("setResponseHook", () => {
    it("fires for every device list response with the whole list under the account pseudo-id, and null clears it", async () => {
      const fake = makeFakeHttps(() => ({ data: [{ sku: "H6160", device: "AABBCC", deviceName: "Test" }] }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const calls: Array<{ deviceId: string; endpoint: string; body: unknown }> = [];
      client.setResponseHook((deviceId, endpoint, body) => {
        calls.push({ deviceId, endpoint, body });
      });
      await client.getDevices();
      expect(calls).toHaveLength(1);
      expect(calls[0].endpoint).toBe("/router/api/v1/user/devices");
      expect(calls[0].deviceId).toBe("AABBCC"); // per-device entry so the diag of that device carries its list row
      client.setResponseHook(null);
      await client.getDevices();
      expect(calls).toHaveLength(1); // cleared — no further captures
    });

    it("records a rejected answer NOT as a success — the caller's failure entry is the one record (issue #50 follow-up)", async () => {
      // Measured on krobi's installation (2.39.1): a group's state read came back
      // `400 devices not exist` and stood in the report twice — once `ok: true`
      // from this hook, once as the loader's failure.
      const rejected = {
        requestId: "x",
        msg: "devices not exist",
        code: 400,
        payload: { sku: "BaseGroup", device: "1" },
      };
      const fake = makeFakeHttps(() => rejected);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const captured: string[] = [];
      client.setResponseHook((_d, endpoint) => captured.push(endpoint));
      await expect(client.getDeviceState("BaseGroup", "1")).rejects.toThrow(/code=400 — devices not exist/);
      await expect(client.getScenes("BaseGroup", "1")).rejects.toThrow(/code=400 — devices not exist/);
      await expect(client.getDiyScenes("BaseGroup", "1")).rejects.toThrow(/code=400 — devices not exist/);
      expect(captured).toEqual([]);
    });

    it("should fire the hook on getDeviceState", async () => {
      const fake = makeFakeHttps(() => H7127_STATE_ENVELOPE);
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const captured: Array<{ deviceId: string; endpoint: string }> = [];
      client.setResponseHook((deviceId, endpoint, _body) => captured.push({ deviceId, endpoint }));
      await client.getDeviceState("H6160", "AABBCC");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({ deviceId: "AABBCC", endpoint: "/router/api/v1/device/state" });
    });
  });

  describe("Govee's rate-limit headers (2.39.0, measurement for the daily numbers)", () => {
    // The daily limits in the adapter (9,000 / 90 per appliance) come from the
    // v1 PDF; the v2 page names none. Whether v2 sends the rate-limit headers
    // the v1 docs describe — and with which numbers — no export had ever
    // shown, because the client dropped them. Now every answer's headers are
    // read, the newest set is kept, and the per-device history carries them.
    const withHeaders = (headers: Record<string, string>): HttpResult<unknown> => ({
      value: { data: [] },
      statusCode: 200,
      headers,
    });

    it("reads day and minute headers case-insensitively and remembers the newest set", async () => {
      const fake = makeFakeHttps(() =>
        withHeaders({
          "x-ratelimit-limit": "10000",
          "x-ratelimit-remaining": "9876",
          "x-ratelimit-reset": "1790000000",
          "API-RateLimit-Limit": "10",
          "API-RateLimit-Remaining": "7",
          "API-RateLimit-Reset": "1789999960",
        }),
      );
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      expect(client.getLastRateLimit()).toBeNull();
      await client.getDevices();
      expect(client.getLastRateLimit()).toMatchObject({
        endpoint: "/router/api/v1/user/devices",
        dayLimit: 10000,
        dayRemaining: 9876,
        dayReset: 1790000000,
        minuteLimit: 10,
        minuteRemaining: 7,
        minuteReset: 1789999960,
      });
    });

    it("keeps every header whose name mentions the rate limit verbatim — the measurement must not depend on the v1 names", async () => {
      const fake = makeFakeHttps(() =>
        withHeaders({ "x-govee-ratelimit-device": "30", "content-type": "application/json" }),
      );
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      await client.getDevices();
      expect(client.getLastRateLimit()?.raw).toEqual({ "x-govee-ratelimit-device": "30" });
      expect(client.getLastRateLimit()?.dayLimit).toBeUndefined();
    });

    it("an answer without such headers leaves the last set untouched and records none", async () => {
      const fake = makeFakeHttps(() => withHeaders({ "content-type": "application/json" }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      await client.getDevices();
      expect(client.getLastRateLimit()).toBeNull();
    });

    it("keeps the headers of a REJECTED answer too — the 429 is the one that says how much is left", async () => {
      const fake = makeFakeHttps(
        () =>
          new HttpError("Too many requests", 429, {
            "x-ratelimit-remaining": "0",
            "api-ratelimit-remaining": "0",
            "retry-after": "60",
          }),
      );
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      await client.getDevices().catch(() => undefined);
      expect(client.getLastRateLimit()).toMatchObject({ dayRemaining: 0, minuteRemaining: 0 });
    });

    it("hands the headers of THAT answer to the response hook", async () => {
      const fake = makeFakeHttps(() => ({
        value: H7127_STATE_ENVELOPE,
        statusCode: 200,
        headers: { "API-RateLimit-Remaining": "29" },
      }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const seen: unknown[] = [];
      client.setResponseHook((_d, _e, _b, rateLimit) => {
        seen.push(rateLimit);
      });
      await client.getDeviceState("H7127", "18:A9:CC:8D:A2:A1:9A:E4");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ minuteRemaining: 29 });
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

    it("a rejection inside the envelope throws with Govee's reason — never an empty account (A11)", async () => {
      // The list names its reason `message` (CloudDeviceListResponse), the other envelopes `msg`.
      const fake = makeFakeHttps(() => ({ code: 401, message: "Unauthorized", data: [] }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDevices()).rejects.toThrow("Device list rejected: code=401 — Unauthorized");
    });

    it("an envelope reason under `msg` is read too", async () => {
      const fake = makeFakeHttps(() => ({ code: 500, msg: "system busy" }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDevices()).rejects.toThrow("code=500 — system busy");
    });

    it("a code-200 envelope with an empty list stays an empty list", async () => {
      const fake = makeFakeHttps(() => ({ code: 200, message: "success", data: [] }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDevices()).resolves.toEqual([]);
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
    it("returns the capabilities of Govee's real envelope — `payload`, not `data` (issue #47)", async () => {
      // Three captures agree (the reporter's export, tukey42's H61A8 from May,
      // Govee's own docs); the scene endpoints in this file always read
      // `payload`. Reading `data` here returned [] for every state read since
      // v0.1.0, so no value from this endpoint ever reached a datapoint.
      const fake = makeFakeHttps(() => H7127_STATE_ENVELOPE);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const caps = await client.getDeviceState("H7127", "AA:BB");
      expect(caps).toHaveLength(5);
      expect(caps.map(c => c.instance)).toEqual(["online", "powerSwitch", "workMode", "filterLifeTime", "airQuality"]);
    });

    it("returns [] when the payload carries no capabilities", async () => {
      const fake = makeFakeHttps(() => ({ requestId: "x", msg: "success", code: 200, payload: {} }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const caps = await client.getDeviceState("H6160", "AABB");
      expect(caps).toEqual([]);
    });

    it("throws on the list-style envelope — an answer without payload is a broken read, not an empty device", async () => {
      // This is the shape the parser expected for the adapter's whole life.
      // Folding it into [] is what kept the bug invisible: "no value" and
      // "wrong field" rendered the same. A shape this endpoint does not use
      // is a failure — the callers record it in the diagnostics report.
      const fake = makeFakeHttps(() => ({
        code: 200,
        message: "success",
        data: { capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch", state: { value: 1 } }] },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDeviceState("H6160", "AABB")).rejects.toThrow(/carries no payload/);
    });

    it("throws on a bare-array answer — Govee sent `[]` once for the H7127 (export v2.34.0, 2026-09-11)", async () => {
      // apiHistory["/router/api/v1/device/state"] of the reporter's second export
      // holds one `[]` next to two proper payload envelopes. Until 2.35.0 the
      // parser turned it into "no capabilities"; it is a read without an answer.
      const fake = makeFakeHttps(() => []);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDeviceState("H7127", "AABB")).rejects.toThrow(/carries no payload/);
    });

    it("throws on a rejection in the envelope — the reason reaches the diagnostics report", async () => {
      // Same rule as controlDevice: Govee can answer HTTP 200 with a body
      // code that is not 200, and the reason sits in `msg`.
      const fake = makeFakeHttps(() => ({ requestId: "x", msg: "Invalid parameter type", code: 400 }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDeviceState("H7127", "AA:BB")).rejects.toThrow(/code=400 — Invalid parameter type/);
    });

    it("should send POST with sku+device payload", async () => {
      const fake = makeFakeHttps(() => H7127_STATE_ENVELOPE);
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

    it("resolves on Govee's real success answer and forwards it to the response hook (audit 2026-09-11)", async () => {
      // Verbatim from research-issue47-followup-2026-09-11.export-v2.34.0.json — the
      // success answer is NOT wrapped in `data`, carries `code: 200` in the body and
      // `capability.state.status: "success"`. `{ok:true}` never reached the 200 comparison.
      const real = {
        requestId: "ctrl_1789105601701_3",
        msg: "success",
        code: 200,
        capability: {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: { status: "success" },
          value: 1,
        },
      };
      const fake = makeFakeHttps(() => real);
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const captured: unknown[] = [];
      client.setResponseHook((_d, _e, body) => captured.push(body));
      await expect(
        client.controlDevice("H7127", "AABB", "devices.capabilities.on_off", "powerSwitch", 1),
      ).resolves.toBeUndefined();
      expect(captured).toHaveLength(1);
      const hookBody = captured[0] as { request: unknown; response: unknown };
      expect(Object.keys(hookBody).sort()).toEqual(["request", "response"]);
      expect(hookBody.response).toEqual(real);
    });
  });

  describe("controlDevice — the rejection names whether the device was offline (2.39.0, issue #46)", () => {
    it("'Device is offline' is a CloudControlRejected with deviceOffline=true", async () => {
      const fake = makeFakeHttps(() => ({
        requestId: "ctrl_1",
        msg: "Device is offline. Please check the Wi-Fi connection.",
        code: 400,
        capability: {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: {
            status: "failure",
            errorCode: 400,
            errorMsg: "Device is offline. Please check the Wi-Fi connection.",
          },
        },
      }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const err = await client
        .controlDevice("H600D", "AA:BB", "devices.capabilities.on_off", "powerSwitch", 1)
        .catch(e => e);
      expect(err).toBeInstanceOf(CloudControlRejected);
      expect((err as CloudControlRejected).deviceOffline).toBe(true);
      expect(String((err as Error).message)).toContain("Device is offline");
    });

    it("a 200 envelope whose capability state failed carries the offline flag as well", async () => {
      // Govee answers 200 while the per-capability state says failure — the
      // second throw. Its flag decides whether the command is held (#46).
      const fake = makeFakeHttps(() => ({
        requestId: "ctrl_3",
        msg: "Device is offline. Please check the Wi-Fi connection.",
        code: 200,
        capability: {
          type: "devices.capabilities.on_off",
          instance: "powerSwitch",
          state: { status: "failure", errorCode: 400 },
        },
      }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const err = await client
        .controlDevice("H600D", "AA:BB", "devices.capabilities.on_off", "powerSwitch", 1)
        .catch(e => e);
      expect(err).toBeInstanceOf(CloudControlRejected);
      expect((err as CloudControlRejected).deviceOffline).toBe(true);
    });

    it("any other rejection is a CloudControlRejected with deviceOffline=false", async () => {
      const fake = makeFakeHttps(() => ({ requestId: "ctrl_2", msg: "Invalid parameter type", code: 400 }));
      const client = new GoveeCloudClient("test-api-key", mockLog, fake.fn);
      const err = await client
        .controlDevice("H7127", "AA:BB", "devices.capabilities.work_mode", "workMode", 1)
        .catch(e => e);
      expect(err).toBeInstanceOf(CloudControlRejected);
      expect((err as CloudControlRejected).deviceOffline).toBe(false);
    });
  });

  describe("controlDevice — payload-level failures", () => {
    it("rejects when Govee answers HTTP 200 with a logical error code", async () => {
      // The device never received the command; a resolved promise would ack
      // the ioBroker state and show the user a change that did not happen.
      const fake = makeFakeHttps(() => ({ code: 400, message: "capability not allowed" }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(
        client.controlDevice("H6160", "AABB", "devices.capabilities.on_off", "powerSwitch", 1),
      ).rejects.toThrow(/code=400.*capability not allowed/);
    });

    it("carries Govee's own reason — the field is `msg`, not `message` (issue #47)", async () => {
      // Captured verbatim from the H7127 export. Reading `resp.message` left the
      // log line at a bare "code=400" and threw away the only actionable half.
      const fake = makeFakeHttps(() => ({
        requestId: "ctrl_1",
        msg: "Invalid parameter type",
        code: 400,
        capability: {
          type: "devices.capabilities.work_mode",
          instance: "workMode",
          state: { status: "failure", errorCode: 400, errorMsg: "Invalid parameter type" },
          value: "3",
        },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(
        client.controlDevice("H7127", "AABB", "devices.capabilities.work_mode", "workMode", "3"),
      ).rejects.toThrow(/code=400.*Invalid parameter type/);
    });

    it("rejects a per-capability failure even when the envelope says 200", async () => {
      const fake = makeFakeHttps(() => ({
        requestId: "ctrl_2",
        code: 200,
        capability: { state: { status: "failure", errorCode: 400, errorMsg: "Device offline" } },
      }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(
        client.controlDevice("H6160", "AABB", "devices.capabilities.on_off", "powerSwitch", 1),
      ).rejects.toThrow(/Device offline/);
    });

    it("accepts the two success codes Govee uses (200 and 0)", async () => {
      for (const code of [200, 0]) {
        const fake = makeFakeHttps(() => ({ code }));
        const client = new GoveeCloudClient("k", mockLog, fake.fn);
        await expect(
          client.controlDevice("H6160", "AABB", "devices.capabilities.on_off", "powerSwitch", 1),
        ).resolves.toBeUndefined();
      }
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

    it("throws on a rejection in the envelope — it is not a device without scenes", async () => {
      // Read as empty, a rejection took the snapshot list from the capability
      // fallback and let the scenes count as checked; thrown, the loader keeps
      // the cached lists (its error path) and records the reason.
      const fake = makeFakeHttps(() => ({ requestId: "x", msg: "devices not exist", code: 400 }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getScenes("H6160", "AABB")).rejects.toThrow(
        /Scenes rejected for H6160\/AABB: code=400 — devices not exist/,
      );
    });

    it("accepts Govee's success envelope (`code: 200`, `msg: success`) and a bare `code: 0`", async () => {
      const ok = (code: number): Record<string, unknown> => ({
        requestId: "x",
        msg: "success",
        code,
        payload: { capabilities: [] },
      });
      for (const code of [200, 0]) {
        const client = new GoveeCloudClient("k", mockLog, makeFakeHttps(() => ok(code)).fn);
        await expect(client.getScenes("H6160", "AABB")).resolves.toEqual({
          lightScenes: [],
          diyScenes: [],
          snapshots: [],
        });
        await expect(client.getDiyScenes("H6160", "AABB")).resolves.toEqual([]);
      }
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

    it("throws on a rejection in the envelope, naming the DIY call", async () => {
      const fake = makeFakeHttps(() => ({ requestId: "x", msg: "Invalid parameter type", code: 400 }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      await expect(client.getDiyScenes("H6160", "AABB")).rejects.toThrow(
        /DIY scenes rejected for H6160\/AABB: code=400 — Invalid parameter type/,
      );
    });

    it("should return [] when no capabilities", async () => {
      const fake = makeFakeHttps(() => ({ payload: { capabilities: [] } }));
      const client = new GoveeCloudClient("k", mockLog, fake.fn);
      const scenes = await client.getDiyScenes("H6160", "AABB");
      expect(scenes).toEqual([]);
    });
  });
});
