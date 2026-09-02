import { vi } from "vitest";
import { GoveeOpenapiMqttClient } from "./govee-openapi-mqtt-client";
import type { TimerAdapter } from "./types";

/**
 * Lifecycle tests for the OpenAPI-MQTT client (constructor + disconnect) plus
 * the connect/subscribe/reconnect paths inherited from ReconnectingMqttClient.
 *
 * The client calls mqtt.connect() directly (no DI), so the module is mocked
 * with a minimal fake client whose events the test drives by hand.
 */

const mqttMock = vi.hoisted(() => {
  interface FakeClient {
    connected: boolean;
    ended: boolean | null;
    on(ev: string, cb: (...args: unknown[]) => void): FakeClient;
    emit(ev: string, ...args: unknown[]): void;
    subscribe(topic: string, opts: unknown, cb: (e: Error | null) => void): void;
    end(force: boolean): void;
    removeAllListeners(): FakeClient;
  }
  const clients: FakeClient[] = [];
  let subscribeBehavior: (cb: (e: Error | null) => void) => void = cb => cb(null);
  return {
    connect: (): FakeClient => {
      const handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {};
      const c: FakeClient = {
        connected: false,
        ended: null,
        on(ev, cb) {
          handlers[ev] = cb;
          return c;
        },
        emit(ev, ...args) {
          handlers[ev]?.(...args);
        },
        subscribe(_topic, _opts, cb) {
          subscribeBehavior(cb);
        },
        end(force) {
          c.ended = force;
        },
        removeAllListeners() {
          for (const k of Object.keys(handlers)) {
            delete handlers[k];
          }
          return c;
        },
      };
      clients.push(c);
      return c;
    },
    clients,
    setSubscribeBehavior: (fn: (cb: (e: Error | null) => void) => void) => {
      subscribeBehavior = fn;
    },
    reset: () => {
      clients.length = 0;
      subscribeBehavior = cb => cb(null);
    },
  };
});

vi.mock("mqtt", () => ({ connect: () => mqttMock.connect() }));

const mockLog: ioBroker.Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  silly: () => {},
  level: "debug",
};

const mockTimers = {
  setInterval: () => undefined,
  clearInterval: () => {},
  setTimeout: () => undefined,
  clearTimeout: () => {},
  delay: () => Promise.resolve(),
};

describe("GoveeOpenapiMqttClient", () => {
  describe("lifecycle without a broker", () => {
    it("starts disconnected, and a disconnect() that never connected is a silent no-op", () => {
      const client = new GoveeOpenapiMqttClient("test-api-key", mockLog, mockTimers);
      expect(client.connected).toBe(false);
      client.disconnect();
      client.disconnect();
      expect(client.connected).toBe(false);
      expect(mqttMock.clients).toHaveLength(0); // nothing was ever opened
    });
  });

  describe("session ID stability", () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it("generates a UUID-shaped session id once per instance", () => {
      const client = new GoveeOpenapiMqttClient("test-api-key", mockLog, mockTimers);
      const sid = (client as unknown as { sessionUuid: string }).sessionUuid;
      expect(sid).toMatch(UUID_RE);
    });

    it("keeps the same session id for the lifetime of the instance", () => {
      const client = new GoveeOpenapiMqttClient("test-api-key", mockLog, mockTimers);
      const before = (client as unknown as { sessionUuid: string }).sessionUuid;
      // Simulate adapter activity that previously rotated the id
      client.disconnect();
      const after = (client as unknown as { sessionUuid: string }).sessionUuid;
      expect(after).toBe(before);
    });

    it("uses a different session id per client instance", () => {
      const a = new GoveeOpenapiMqttClient("k", mockLog, mockTimers);
      const b = new GoveeOpenapiMqttClient("k", mockLog, mockTimers);
      const sa = (a as unknown as { sessionUuid: string }).sessionUuid;
      const sb = (b as unknown as { sessionUuid: string }).sessionUuid;
      expect(sa).not.toBe(sb);
    });
  });

  describe("connect / subscribe / reconnect (base scaffolding wiring)", () => {
    function makeCapturingTimers(): { timers: TimerAdapter; scheduled: Array<() => void> } {
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

    beforeEach(() => mqttMock.reset());

    it("subscribes on connect and reports onConnection(true)", () => {
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("key", mockLog, t.timers);
      let connFlag: boolean | null = null;
      client.connect(
        () => {},
        c => {
          connFlag = c;
        },
      );
      mqttMock.clients[0].emit("connect"); // → subscribe (default success) → onConnection(true)
      expect(connFlag).toBe(true);
      client.disconnect();
    });

    it("forces a close and does NOT report connected when subscribe fails", () => {
      mqttMock.setSubscribeBehavior(cb => cb(new Error("policy denied")));
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("key", mockLog, t.timers);
      let connFlag: boolean | null = null;
      client.connect(
        () => {},
        c => {
          connFlag = c;
        },
      );
      const fake = mqttMock.clients[0];
      fake.emit("connect");
      expect(fake.ended).toBe(true); // forced close so the close-handler can reconnect
      expect(connFlag).toBeNull(); // onConnection(true) was NOT called
      client.disconnect();
    });

    it("stops retrying after repeated auth rejections — a bad API key must not loop forever", () => {
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("bad-key", mockLog, t.timers);
      let connFlag: boolean | null = null;
      client.connect(
        () => {},
        c => {
          connFlag = c;
        },
      );
      const fake = mqttMock.clients[0];
      const authErr = Object.assign(new Error("Connection refused: Not authorized"), { code: 5 });

      // Below the cap the client keeps going (a single rejection can be a
      // Govee hiccup) — no forced end, no onConnection(false).
      fake.emit("error", authErr);
      expect(fake.ended).toBeNull();

      // At the cap (5 consecutive auth errors) it gives up: reports the outage
      // and closes for good, so the adapter stops hammering Govee with a key
      // it already rejected.
      for (let i = 0; i < 4; i++) {
        fake.emit("error", authErr);
      }
      expect(connFlag).toBe(false);
      expect(fake.ended).toBe(true);
      client.disconnect();
    });

    it("keeps the backoff counter on a post-CONNACK subscribe failure — no tight relogin loop (M3)", () => {
      mqttMock.setSubscribeBehavior(cb => cb(new Error("policy denied")));
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("key", mockLog, t.timers);
      client.connect(
        () => {},
        () => {},
      );
      // Pretend we have already been backing off (3 prior attempts).
      (client as unknown as { reconnectAttempts: number }).reconnectAttempts = 3;
      mqttMock.clients[0].emit("connect"); // CONNACK → subscribe fails → force close
      // The CONNACK alone must NOT reset the backoff — only a full subscribe
      // success (onSubscribed) does. Otherwise a persistent subscribe failure
      // relogs every ~5-10 s and self-inflicts a Govee rate-limit.
      expect((client as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(3);
      client.disconnect();
    });

    it("re-enters connect() when the backoff timer fires after a close", () => {
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("key", mockLog, t.timers);
      client.connect(
        () => {},
        () => {},
      );
      expect(mqttMock.clients).toHaveLength(1);
      mqttMock.clients[0].emit("close"); // → scheduleReconnect → backoff timer armed
      expect(t.scheduled).toHaveLength(1);
      t.scheduled[0](); // fire → base → reconnect() → connect() again
      expect(mqttMock.clients).toHaveLength(2); // second mqtt.connect = reconnect proven
      client.disconnect();
    });

    it("does not re-enter connect() when the timer fires after disconnect()", () => {
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient("key", mockLog, t.timers);
      client.connect(
        () => {},
        () => {},
      );
      mqttMock.clients[0].emit("close");
      expect(t.scheduled).toHaveLength(1);
      client.disconnect(); // disposed = true
      t.scheduled[0](); // stale timer fires
      expect(mqttMock.clients).toHaveLength(1); // no second connect — disposed guard held
    });

    it("masks the API key in topic= log lines — the raw key never reaches the log (H1)", () => {
      const apiKey = "3f2a9c10-dead-beef-cafe-0123456789ab";
      const logged: string[] = [];
      const capturingLog = {
        debug: (m: string) => logged.push(String(m)),
        info: (m: string) => logged.push(String(m)),
        warn: (m: string) => logged.push(String(m)),
        error: () => {},
        silly: () => {},
        level: "debug",
      } as unknown as ioBroker.Logger;
      const t = makeCapturingTimers();
      const client = new GoveeOpenapiMqttClient(apiKey, capturingLog, t.timers);
      // Force the INFO "connection restored" path (line ~106) — the default-loglevel leak.
      (client as unknown as { lastErrorCategory: string | null }).lastErrorCategory = "NETWORK";
      client.connect(
        () => {},
        () => {},
      );
      mqttMock.clients[0].emit("connect");
      const all = logged.join("\n");
      expect(all).toContain("Cloud-events connection restored"); // we exercised the info line
      expect(all).not.toContain(apiKey); // the raw key must never appear in any log line
      client.disconnect();
    });
  });

  describe("handleMessage (event parsing)", () => {
    function makeClient(): { events: unknown[]; raws: string[]; feed: (obj: unknown) => void } {
      const client = new GoveeOpenapiMqttClient("key", mockLog, mockTimers);
      const events: unknown[] = [];
      const raws: string[] = [];
      (client as any).onEvent = (e: unknown) => events.push(e);
      (client as any).onRaw = (r: string) => raws.push(r);
      const feed = (obj: unknown): void => (client as any).handleMessage(Buffer.from(JSON.stringify(obj)));
      return { events, raws, feed };
    }

    it("emits an event with the valid capabilities and forwards raw JSON", () => {
      const { events, raws, feed } = makeClient();
      const msg = {
        sku: "H5179",
        device: "AA:BB",
        capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature", state: { value: 23 } }],
      };
      feed(msg);
      expect(events).toEqual([{ sku: "H5179", device: "AA:BB", capabilities: msg.capabilities }]);
      expect(raws).toEqual([JSON.stringify(msg)]);
    });

    it("drops messages without device info, without/empty/all-malformed capabilities", () => {
      const { events, feed } = makeClient();
      feed({ capabilities: [{ type: "x", instance: "y" }] }); // no sku/device
      feed({ sku: "H5179", device: "AA" }); // no capabilities key
      feed({ sku: "H5179", device: "AA", capabilities: [] }); // empty
      feed({ sku: "H5179", device: "AA", capabilities: [{ type: 1 }, null] }); // all malformed
      expect(events).toHaveLength(0);
    });

    it("forwards raw JSON even when the body is unparseable, and emits no event", () => {
      const client = new GoveeOpenapiMqttClient("key", mockLog, mockTimers);
      const raws: string[] = [];
      let events = 0;
      (client as any).onRaw = (r: string) => raws.push(r);
      (client as any).onEvent = () => events++;
      (client as any).handleMessage(Buffer.from("{ bad json"));
      expect(raws).toEqual(["{ bad json"]);
      expect(events).toBe(0);
    });

    it("drops an oversized message before forwarding raw or parsing (SEC-I2 payload cap)", () => {
      const client = new GoveeOpenapiMqttClient("key", mockLog, mockTimers);
      const raws: string[] = [];
      let events = 0;
      (client as any).onRaw = (r: string) => raws.push(r);
      (client as any).onEvent = () => events++;
      // 64 KB + 1 byte — over the cap. Must be dropped before onRaw + JSON.parse,
      // so (unlike the unparseable case above) the raw is NOT forwarded.
      (client as any).handleMessage(Buffer.alloc(64 * 1024 + 1, 0x61));
      expect(raws).toEqual([]);
      expect(events).toBe(0);
    });
  });
});
