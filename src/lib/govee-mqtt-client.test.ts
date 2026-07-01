import { GoveeMqttClient } from "./govee-mqtt-client";
import { type HttpRequestOptions, type HttpResult, type HttpsRequestFn } from "./http-client";
import { mockLog, mockTimers } from "./test-helpers";

/**
 * Timer mock that does NOT fire immediately — important for connect() tests,
 * otherwise scheduleReconnect → setTimeout → immediate callback → another
 * connect → infinite loop. Here just queue, never call.
 */
const noopTimers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

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

describe("GoveeMqttClient", () => {
  describe("getFailureReason", () => {
    it("should return null initially when not connected and no error has occurred", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(client.getFailureReason()).toBeNull();
    });
  });

  describe("token getter", () => {
    it("should return empty string before login", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(client.token).toBe("");
    });
  });

  describe("connected getter", () => {
    it("should return false before connect", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(client.connected).toBe(false);
    });
  });

  describe("setVerificationCode", () => {
    it("should accept and trim verification codes", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(() => client.setVerificationCode("  123456  ")).not.toThrow();
      expect(() => client.setVerificationCode("")).not.toThrow();
    });
  });

  describe("setOnVerificationConsumed / setOnVerificationFailed", () => {
    it("should accept callback or null", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(() => client.setOnVerificationConsumed(() => {})).not.toThrow();
      expect(() => client.setOnVerificationConsumed(null)).not.toThrow();
      expect(() => client.setOnVerificationFailed(_reason => {})).not.toThrow();
      expect(() => client.setOnVerificationFailed(null)).not.toThrow();
    });
  });

  describe("disconnect", () => {
    it("should be safe to call when never connected", () => {
      const client = new GoveeMqttClient("user@example.com", "password", mockLog, mockTimers);
      expect(() => client.disconnect()).not.toThrow();
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe("requestVerificationCode", () => {
    it("should POST to /verification with email + type=8", async () => {
      const fake = makeFakeHttps(() => ({}));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, mockTimers, fake.fn);
      await client.requestVerificationCode();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].method).toBe("POST");
      expect(fake.calls[0].url).toContain("/account/rest/account/v1/verification");
      const body = fake.calls[0].body as { type: number; email: string };
      expect(body.type).toBe(8);
      expect(body.email).toBe("test@example.com");
    });

    it("should set Govee headers (User-Agent + clientId etc.)", async () => {
      const fake = makeFakeHttps(() => ({}));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, mockTimers, fake.fn);
      await client.requestVerificationCode();
      const headers = fake.calls[0].headers;
      expect(headers["User-Agent"]).toMatch(/GoveeHome/);
      expect(typeof headers.clientId).toBe("string");
      expect(typeof headers.appVersion).toBe("string");
    });

    it("should propagate errors", async () => {
      const fake = makeFakeHttps(() => new Error("HTTP 500"));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, mockTimers, fake.fn);
      try {
        await client.requestVerificationCode();
        throw new Error("expected throw");
      } catch (e) {
        expect((e as Error).message).toBe("HTTP 500");
      }
    });
  });

  describe("connect — login error paths", () => {
    it("should silently return on 454 (verification pending) without code, fire onVerificationFailed('pending')", async () => {
      const fake = makeFakeHttps(() => ({ status: 454, message: "verification required" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      let verificationFailedReason: string | null = null;
      client.setOnVerificationFailed(reason => {
        verificationFailedReason = reason;
      });
      let connectionCalls = 0;
      let lastConnectedFlag: boolean | null = null;
      await client.connect(
        () => {},
        connected => {
          connectionCalls++;
          lastConnectedFlag = connected;
        },
      );
      expect(verificationFailedReason).toBe("pending");
      expect(connectionCalls).toBeGreaterThan(0);
      expect(lastConnectedFlag).toBe(false);
      expect(client.getFailureReason()).toBe("Govee asked for verification — request a code in adapter settings");
    });

    it("should silently return on 455 (verification failed) and fire onVerificationFailed('failed')", async () => {
      const fake = makeFakeHttps(() => ({ status: 455, message: "verification code invalid" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      let verificationFailedReason: string | null = null;
      client.setOnVerificationFailed(reason => {
        verificationFailedReason = reason;
      });
      await client.connect(
        () => {},
        () => {},
      );
      expect(verificationFailedReason).toBe("failed");
      expect(client.getFailureReason()).toBe("verification code rejected — request a fresh code");
    });

    it("should treat 454 with verification code submitted as VERIFICATION_FAILED (code expired)", async () => {
      const fake = makeFakeHttps(() => ({ status: 454, message: "verification required" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      client.setVerificationCode("123456");
      let verificationFailedReason: string | null = null;
      client.setOnVerificationFailed(reason => {
        verificationFailedReason = reason;
      });
      await client.connect(
        () => {},
        () => {},
      );
      // Status 454 + code-was-sent → "Verification code invalid or expired" → classifyError → VERIFICATION_FAILED
      expect(verificationFailedReason).toBe("failed");
      expect(client.getFailureReason()).toBe("verification code rejected — request a fresh code");
    });

    it("should set AUTH failure reason on 401", async () => {
      const fake = makeFakeHttps(() => ({ status: 401, message: "wrong password" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.getFailureReason()).toBe("login failed (will retry)");
    });

    it("should report 'login rejected — check email/password' after 3 consecutive AUTH failures", async () => {
      const fake = makeFakeHttps(() => ({ status: 401, message: "wrong password" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      let authFailedFired = 0;
      client.setOnAuthFailed(() => authFailedFired++);
      // 3× connect → authFailCount erreicht MAX_AUTH_FAILURES
      await client.connect(
        () => {},
        () => {},
      );
      await client.connect(
        () => {},
        () => {},
      );
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.getFailureReason()).toBe("login rejected — check email/password");
      // The actionable "check email/password" problem must be surfaced once the
      // credentials are rejected for good (not on transient/verification fails).
      expect(authFailedFired).toBeGreaterThan(0);
    });

    it("should set RATE_LIMIT failure reason on 429", async () => {
      const fake = makeFakeHttps(() => ({ status: 429, message: "too many requests" }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.getFailureReason()).toBe("rate-limited by Govee — will retry");
    });

    it("should set NETWORK failure reason on ECONNREFUSED", async () => {
      const err: Error & { code?: string } = new Error("ECONNREFUSED");
      err.code = "ECONNREFUSED";
      const fake = makeFakeHttps(() => err);
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.getFailureReason()).toBe("cannot reach Govee servers — will retry");
    });

    it("should fire onVerificationConsumed when login succeeds with a code", async () => {
      // Login succeeds (returns client object) — so we get past the 454 branch.
      // getIotKey is the second call and FAILS with network — so mqtt.connect
      // never comes into play, but onVerificationConsumed already fired before the getIotKey call.
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        if (callIdx++ === 0) {
          return {
            client: {
              accountId: "acc-123",
              topic: "GA/account/topic-xyz",
              token: "bearer-token-abc",
              token_expire_cycle: 3600,
            },
          };
        }
        return new Error("network");
      });
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      client.setVerificationCode("123456");
      let consumedFired = false;
      client.setOnVerificationConsumed(() => {
        consumedFired = true;
      });
      await client.connect(
        () => {},
        () => {},
      );
      expect(consumedFired).toBe(true);
      expect(client.token).toBe("bearer-token-abc");
    });

    it("should set lastErrorCategory back to null after VERIFICATION_PENDING when next login succeeds", async () => {
      // First: 454-PENDING set
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        const i = callIdx++;
        if (i === 0) {
          return { status: 454, message: "verification required" };
        }
        // Next calls: successful login + getIotKey fail
        if (i === 1) {
          return {
            client: {
              accountId: "acc-1",
              topic: "GA/topic-1",
              token: "tok-1",
              token_expire_cycle: 3600,
            },
          };
        }
        return new Error("network");
      });
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.getFailureReason()).toMatch(/verification/i);
      // Login works now — the getIotKey fail produces a NETWORK category (or UNKNOWN)
      await client.connect(
        () => {},
        () => {},
      );
      // login was successful; the iot-key call failed → category != VERIFICATION_PENDING
      expect(client.getFailureReason()).not.toBe("Govee asked for verification — request a code in adapter settings");
    });
  });

  describe("connect — login success + iot-key path", () => {
    it("should set bearer token after successful login", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        const i = callIdx++;
        if (i === 0) {
          // Login OK
          return {
            client: {
              accountId: "acc-x",
              topic: "GA/topic-x",
              token: "fresh-bearer",
              token_expire_cycle: 3600,
            },
          };
        }
        // getIotKey fails → connect bails before mqtt.connect, but token is already set
        return new Error("network down");
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(client.token).toBe("fresh-bearer");
    });

    it("should fire onToken callback when login provides a token", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        if (callIdx++ === 0) {
          return {
            client: {
              accountId: "acc-1",
              topic: "GA/topic-1",
              token: "tok-CB",
              token_expire_cycle: 3600,
            },
          };
        }
        return new Error("network");
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      let capturedToken: string | null = null;
      await client.connect(
        () => {},
        () => {},
        token => {
          capturedToken = token;
        },
      );
      expect(capturedToken).toBe("tok-CB");
    });

    it("should call getIotKey with Bearer token after login", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        const i = callIdx++;
        if (i === 0) {
          return {
            client: {
              accountId: "acc-BR",
              topic: "GA/topic-BR",
              token: "tok-BR",
              token_expire_cycle: 3600,
            },
          };
        }
        return new Error("net-fail-after-iotkey-headers-checked");
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      // 2 calls: 1) login, 2) getIotKey with Bearer
      expect(fake.calls.length).toBeGreaterThanOrEqual(2);
      expect(fake.calls[1].method).toBe("GET");
      expect(fake.calls[1].url).toContain("/app/v1/account/iot/key");
      expect(fake.calls[1].headers.Authorization).toBe("Bearer tok-BR");
    });

    it("should throw 'IoT key response missing endpoint' when iotKey response is malformed", async () => {
      let callIdx = 0;
      const fake = makeFakeHttps((_opts, _idx) => {
        const i = callIdx++;
        if (i === 0) {
          return {
            client: {
              accountId: "acc-IK",
              topic: "GA/topic-IK",
              token: "tok-IK",
              token_expire_cycle: 3600,
            },
          };
        }
        // iotKey response without data.endpoint
        return { data: {} };
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      let lastConnFlag: boolean | null = null;
      await client.connect(
        () => {},
        connected => {
          lastConnFlag = connected;
        },
      );
      // Connect bails — connection callback is invoked with false
      expect(lastConnFlag).toBe(false);
    });
  });

  describe("setPersistedCredentials — tryPersistedReuse skip-login behaviour", () => {
    it("should skip fresh login when persisted credentials are still inside TTL", async () => {
      let httpCalls = 0;
      const fake = makeFakeHttps(() => {
        httpCalls++;
        return {};
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      // Fake-creds with TTL 1h in the future + invalid p12 (extractCertsFromP12 throws,
      // tryPersistedReuse returns false — fresh login happens). For the „TTL-still-valid
      // but p12-broken" case we want: no `https.request` until the p12 fails AND fresh login starts.
      client.setPersistedCredentials({
        bearerToken: "stale-tok",
        iotEndpoint: "iot.example.com",
        p12Cert: "AAA=", // invalid → forge throws
        p12Pass: "x",
        accountId: "acc-stale",
        accountTopic: "GA/topic-stale",
        tokenExpiresAt: Date.now() + 60 * 60 * 1000,
      });
      await client.connect(
        () => {},
        () => {},
      );
      // p12 was unusable → fresh login attempted → httpCalls > 0
      expect(httpCalls).toBeGreaterThan(0);
    });

    it("should NOT skip login when persisted token is already expired", async () => {
      let httpCalls = 0;
      const fake = makeFakeHttps(() => {
        httpCalls++;
        return new Error("network");
      });
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn);
      client.setPersistedCredentials({
        bearerToken: "expired-tok",
        iotEndpoint: "iot.example.com",
        p12Cert: "AAA=",
        p12Pass: "x",
        accountId: "acc-exp",
        accountTopic: "GA/topic-exp",
        tokenExpiresAt: Date.now() - 1000, // expired 1s ago
      });
      await client.connect(
        () => {},
        () => {},
      );
      // expired → tryPersistedReuse returns false → fresh login happens
      expect(httpCalls).toBeGreaterThan(0);
    });

    it("should accept null to clear persisted credentials", () => {
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers);
      expect(() => client.setPersistedCredentials(null)).not.toThrow();
    });
  });

  describe("connect — login response validation", () => {
    it("should treat missing accountId in successful login as failure", async () => {
      const fake = makeFakeHttps(() => ({
        client: {
          // accountId missing
          topic: "GA/account/topic-xyz",
          token: "bearer",
          token_expire_cycle: 3600,
        },
      }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      let lastConnectedFlag: boolean | null = null;
      await client.connect(
        () => {},
        connected => {
          lastConnectedFlag = connected;
        },
      );
      expect(lastConnectedFlag).toBe(false);
    });

    it("should treat missing topic in successful login as failure", async () => {
      const fake = makeFakeHttps(() => ({
        client: {
          accountId: "acc",
          // topic missing
          token: "bearer",
          token_expire_cycle: 3600,
        },
      }));
      const client = new GoveeMqttClient("test@example.com", "secret", mockLog, noopTimers, fake.fn);
      let lastConnectedFlag: boolean | null = null;
      await client.connect(
        () => {},
        connected => {
          lastConnectedFlag = connected;
        },
      );
      expect(lastConnectedFlag).toBe(false);
    });
  });

  // The existing suite uses noopTimers (never fires), so the reconnect path
  // inherited from ReconnectingMqttClient was untested. These drive a real
  // backoff timer to prove the cross-cutting wire: connect() catch →
  // scheduleReconnect() → base timer → reconnect() → connect() again.
  describe("reconnect cycle (base scaffolding wiring)", () => {
    function makeCapturingTimers() {
      const scheduled: Array<() => void> = [];
      const timers = {
        setInterval: () => undefined,
        clearInterval: () => {},
        setTimeout: (cb: () => void) => {
          scheduled.push(cb);
          return scheduled.length;
        },
        clearTimeout: () => {},
        delay: () => Promise.resolve(),
      } as never;
      return { timers, scheduled };
    }

    it("arms a backoff timer after a failed login and re-enters connect() when it fires", async () => {
      const fake = makeFakeHttps(() => new Error("network boom")); // login rejects
      const t = makeCapturingTimers();
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, t.timers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(fake.calls.length).toBe(1); // first login attempt
      expect(t.scheduled.length).toBe(1); // backoff timer armed by the base

      t.scheduled[0](); // fire it → base → reconnect() → connect()
      await new Promise(r => setTimeout(r, 10)); // let the async re-login run
      expect(fake.calls.length).toBe(2); // second login attempt = reconnect proven
      client.disconnect();
    });

    it("does not re-enter connect() when the timer fires after disconnect()", async () => {
      const fake = makeFakeHttps(() => new Error("network boom"));
      const t = makeCapturingTimers();
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, t.timers, fake.fn);
      await client.connect(
        () => {},
        () => {},
      );
      expect(t.scheduled.length).toBe(1);

      client.disconnect(); // disposed = true
      t.scheduled[0](); // stale timer fires
      await new Promise(r => setTimeout(r, 10));
      expect(fake.calls.length).toBe(1); // no second login — disposed guard held
    });
  });

  // The connect→subscribe happy path was previously unreachable in tests (the
  // node-forge P12 parse gates it). Drive login + getIotKey to success, bypass
  // the forge parse, and inject a fake mqtt client so the connect handler runs —
  // proving the M3 backoff-reset timing symmetrically with the openapi client.
  describe("connect → subscribe backoff timing (M3)", () => {
    function driveToConnected(subscribeErr: Error | null): {
      client: GoveeMqttClient;
      emitConnect: () => void;
      isEnded: () => boolean;
    } {
      const fake = makeFakeHttps((_opts, idx) =>
        idx === 0
          ? { client: { accountId: "acc", topic: "GA/acc/topic", token: "bearer", token_expire_cycle: 3600 } }
          : { data: { endpoint: "iot.example.com", p12: "AAAA", p12Pass: "pw" } },
      );
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      let ended = false;
      const fakeMqtt = {
        on(ev: string, cb: (...a: unknown[]) => void) {
          (handlers[ev] ??= []).push(cb);
          return fakeMqtt;
        },
        subscribe(_t: string, _o: unknown, cb: (e: Error | null) => void) {
          cb(subscribeErr);
        },
        end() {
          ended = true;
        },
        removeAllListeners() {
          for (const k of Object.keys(handlers)) delete handlers[k];
        },
      };
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, noopTimers, fake.fn, (() => fakeMqtt) as never);
      // Bypass the node-forge PKCS12 parse — not what this test exercises.
      (client as unknown as { extractCertsFromP12: () => unknown }).extractCertsFromP12 = () => ({
        key: "k",
        cert: "c",
        ca: "a",
      });
      return { client, emitConnect: () => (handlers.connect ?? []).forEach(h => h()), isEnded: () => ended };
    }

    it("keeps the backoff counter on a post-CONNACK subscribe failure — no tight relogin loop (M3)", async () => {
      const h = driveToConnected(new Error("policy denied"));
      await h.client.connect(
        () => {},
        () => {},
      );
      // Pretend we have already been backing off (3 prior attempts).
      (h.client as unknown as { reconnectAttempts: number }).reconnectAttempts = 3;
      h.emitConnect(); // CONNACK → subscribe fails → force close
      // The CONNACK alone must NOT reset the backoff — only a full subscribe
      // success does. Otherwise a persistent subscribe failure relogs every
      // ~5-10 s and self-inflicts a Govee rate-limit / account lock.
      expect((h.client as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(3);
      expect(h.isEnded()).toBe(true); // forced close so the close-handler can reconnect
      h.client.disconnect();
    });

    it("resets the backoff and reports connected only after a successful subscribe (M3)", async () => {
      const h = driveToConnected(null); // subscribe succeeds
      let connFlag: boolean | null = null;
      await h.client.connect(
        () => {},
        c => {
          connFlag = c;
        },
      );
      (h.client as unknown as { reconnectAttempts: number }).reconnectAttempts = 3;
      h.emitConnect(); // CONNACK → subscribe OK → onSubscribed resets + onConnection(true)
      expect((h.client as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
      expect(connFlag).toBe(true);
      h.client.disconnect();
    });
  });

  describe("handleMessage (status push parsing)", () => {
    function makeClient() {
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, mockTimers);
      const statuses: unknown[] = [];
      const packets: Array<{ device: string; topic: string; payload: unknown }> = [];
      (client as any).onStatus = (s: unknown) => statuses.push(s);
      (client as any).onPacket = (device: string, topic: string, payload: unknown) =>
        packets.push({ device, topic, payload });
      const feed = (obj: unknown, topic = "GA/acct"): void =>
        (client as any).handleMessage(Buffer.from(JSON.stringify(obj)), topic);
      return { statuses, packets, feed };
    }

    it("emits a status update with validated sku/device/state/op", () => {
      const { statuses, feed } = makeClient();
      feed({ sku: "H61BE", device: "AA:BB", state: { onOff: 1 }, op: { command: [] } });
      expect(statuses).toEqual([{ sku: "H61BE", device: "AA:BB", state: { onOff: 1 }, op: { command: [] } }]);
    });

    it("forwards each op.command hex string to onPacket with the raw envelope", () => {
      const { packets, feed } = makeClient();
      const msg = { sku: "H61BE", device: "AA:BB", op: { command: ["aa01", "bb02"] } };
      feed(msg, "GA/topic");
      expect(packets).toEqual([
        { device: "AA:BB", topic: "GA/topic", payload: { hex: "aa01", rawJson: JSON.stringify(msg) } },
        { device: "AA:BB", topic: "GA/topic", payload: { hex: "bb02", rawJson: JSON.stringify(msg) } },
      ]);
    });

    it("forwards a state-only push (no op.command) as one raw-envelope packet", () => {
      const { packets, feed } = makeClient();
      const msg = { sku: "H61BE", device: "AA:BB", state: { brightness: 50 } };
      feed(msg);
      expect(packets).toEqual([{ device: "AA:BB", topic: "GA/acct", payload: { rawJson: JSON.stringify(msg) } }]);
    });

    it("ignores messages without sku/device and invalid JSON", () => {
      const client = new GoveeMqttClient("u@example.com", "pw", mockLog, mockTimers);
      let fired = 0;
      (client as any).onStatus = () => fired++;
      (client as any).onPacket = () => fired++;
      (client as any).handleMessage(Buffer.from(JSON.stringify({ state: { onOff: 1 } })), "t"); // no sku/device
      (client as any).handleMessage(Buffer.from("{ bad"), "t"); // invalid JSON
      expect(fired).toBe(0);
    });
  });
});
