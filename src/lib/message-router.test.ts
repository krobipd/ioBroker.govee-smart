import { MessageRouter, type MessageRouterHost } from "./message-router";
import type { GoveeMqttClient } from "./govee-mqtt-client";

const { enJson } = vi.hoisted(() => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  return {
    enJson: JSON.parse(readFileSync(join(__dirname, "../../admin/i18n/en.json"), "utf8")) as Record<string, string>,
  };
});

// MessageRouter routes mqttAuth result strings through adapter-core I18n; resolve
// them against the real en.json with positional %s substitution (mirrors
// I18n.translate) so the content assertions below hold without booting
// js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string, ...args: (string | number)[]) => {
      let i = 0;
      return (enJson[key] ?? key).replace(/%s/g, () => String(args[i++] ?? "%s"));
    }),
  },
}));

const mockLog = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  level: "info",
} as unknown as ioBroker.Logger;

interface FakeProbeOpts {
  /** When set, simulate a successful login + connected state. */
  connected?: boolean;
  /** Throw this error from probe.connect (overrides connected). */
  connectError?: Error;
  /** Throw this from probe.requestVerificationCode. */
  requestError?: Error;
  /** Called whenever probe.disconnect() runs — lets a test assert disposal. */
  onDisconnect?: () => void;
}

function makeProbe(opts: FakeProbeOpts): GoveeMqttClient {
  const probe = {
    setVerificationCode: (_code: string) => {},
    disconnect: () => opts.onDisconnect?.(),
    requestVerificationCode: async (): Promise<void> => {
      if (opts.requestError) {
        throw opts.requestError;
      }
    },
    connect: async (_onStatus: unknown, onConnection: (connected: boolean) => void): Promise<void> => {
      if (opts.connectError) {
        throw opts.connectError;
      }
      // The real client resolves connect() after the login + cert handshake and
      // only issues the MQTT connect — the "connected" edge (onConnection(true))
      // arrives asynchronously AFTER this resolves, via the mqtt "connect" event
      // → subscribe. Model that timing so a probe that reads `connected`
      // synchronously right after connect() sees false (the M2 bug).
      if (opts.connected) {
        setTimeout(() => onConnection(true), 0);
      }
    },
  } as unknown as GoveeMqttClient;
  return probe;
}

interface RecordedResponse {
  obj: ioBroker.Message;
  data: unknown;
}

function makeHost(opts: {
  email?: string;
  password?: string;
  segmentDevices?: Array<{ value: string; label: string }>;
  wizardResponse?: Record<string, unknown>;
  probe?: GoveeMqttClient;
}): { host: MessageRouterHost; responses: RecordedResponse[] } {
  const responses: RecordedResponse[] = [];
  const host: MessageRouterHost = {
    log: mockLog,
    getConfig: () => ({
      goveeEmail: opts.email ?? "user@example.com",
      goveePassword: opts.password ?? "password",
      mqttVerificationCode: "",
    }),
    sendResponse: (obj, data) => responses.push({ obj, data }),
    createMqttProbeClient: () => opts.probe ?? makeProbe({ connected: false }),
    getSegmentDeviceList: () => opts.segmentDevices ?? [],
    runWizardStep: () => Promise.resolve(opts.wizardResponse ?? { ok: true }),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as ioBroker.Timeout,
    clearTimeout: handle => globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
  };
  return { host, responses };
}

function makeMessage(command: string, message?: unknown): ioBroker.Message {
  return {
    command,
    message: message as never,
    from: "system.adapter.test.0",
    callback: { id: 1 } as unknown as ioBroker.Message["callback"],
    _id: 1,
  } as ioBroker.Message;
}

describe("MessageRouter", () => {
  describe("getSegmentDevices", () => {
    it("forwards the host's device list verbatim", async () => {
      const list = [
        { value: "H6160:AA:01", label: "Strip 1" },
        { value: "H6160:AA:02", label: "Strip 2" },
      ];
      const { host, responses } = makeHost({ segmentDevices: list });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("getSegmentDevices"));
      // Allow the catch-then chain to settle (sync in fact)
      await new Promise(r => setTimeout(r, 0));
      expect(responses).toHaveLength(1);
      expect(responses[0].data).toEqual(list);
    });

    it("returns empty list when host has no segment-capable devices", async () => {
      const { host, responses } = makeHost({ segmentDevices: [] });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("getSegmentDevices"));
      await new Promise(r => setTimeout(r, 0));
      expect(responses[0].data).toEqual([]);
    });
  });

  describe("segmentWizard", () => {
    it("forwards action+device payload to runWizardStep and returns the result", async () => {
      const { host, responses } = makeHost({
        wizardResponse: { progress: "Segment 1", active: true },
      });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("segmentWizard", { action: "start", device: "H6160:AA:01" }));
      await new Promise(r => setTimeout(r, 0));
      expect(responses).toHaveLength(1);
      expect(responses[0].data).toEqual({ progress: "Segment 1", active: true });
    });

    it("handles missing payload gracefully (defaults action='', device='')", async () => {
      const { host, responses } = makeHost({ wizardResponse: { error: "no action" } });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("segmentWizard"));
      await new Promise(r => setTimeout(r, 0));
      expect(responses[0].data).toEqual({ error: "no action" });
    });
  });

  describe("mqttAuth — test action", () => {
    it("returns success message when probe connects", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      expect(responses).toHaveLength(1);
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("Login successful");
    });

    it("reports 'MQTT not up' when login succeeds but the connect edge never arrives (M2 timeout)", async () => {
      // connected:false → connect() resolves, onConnection(true) never fires →
      // the bounded probe timeout decides. Short timeout injected for the test.
      const { host, responses } = makeHost({ probe: makeProbe({ connected: false }) });
      const router = new MessageRouter(host, 20);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 60));
      expect(responses).toHaveLength(1);
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("MQTT connection is not up");
    });

    it("disposes the probe on the timeout path — no socket leak (M2)", async () => {
      let disconnects = 0;
      const probe = makeProbe({ connected: false, onDisconnect: () => (disconnects += 1) });
      const { host } = makeHost({ probe });
      const router = new MessageRouter(host, 20);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 60));
      expect(disconnects).toBe(1);
    });

    it("disposes the probe on the error path too — no socket leak (M2)", async () => {
      let disconnects = 0;
      const probe = makeProbe({ connectError: new Error("Login failed: bad"), onDisconnect: () => (disconnects += 1) });
      const { host } = makeHost({ probe });
      const router = new MessageRouter(host, 20);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 30));
      expect(disconnects).toBe(1);
    });

    it("returns 2FA hint on Verification required error", async () => {
      const probe = makeProbe({ connectError: new Error("Verification required by Govee") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("two-factor confirmation");
    });

    it("returns invalid-code hint on Verification code invalid", async () => {
      const probe = makeProbe({ connectError: new Error("Verification code invalid or expired") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("code invalid");
    });

    it("returns email-not-registered on matching error", async () => {
      const probe = makeProbe({ connectError: new Error("Login failed: email not registered") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("not registered");
    });

    it("returns rate-limit hint", async () => {
      const probe = makeProbe({ connectError: new Error("Rate limited by Govee") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("rate limit");
    });

    it("returns account-locked hint", async () => {
      const probe = makeProbe({ connectError: new Error("Account temporarily locked by Govee") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("temporarily locked");
    });

    it("rejects when email or password missing", async () => {
      const { host, responses } = makeHost({ email: "", password: "" });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("Email + password");
    });

    it("throttles a rapid second test within the 30s window (SEC-I1)", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      expect(responses).toHaveLength(2);
      const second = responses[1].data as { result: string };
      expect(second.result).toContain("Please wait");
    });
  });

  describe("mqttAuth — requestCode action", () => {
    it("succeeds and returns confirmation message", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "requestCode" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("Code sent");
    });

    it("throttles double-click within 30s window", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "requestCode" }));
      await new Promise(r => setTimeout(r, 10));
      router.onMessage(makeMessage("mqttAuth", { action: "requestCode" }));
      await new Promise(r => setTimeout(r, 10));
      expect(responses).toHaveLength(2);
      const second = responses[1].data as { result: string };
      expect(second.result).toContain("Please wait");
    });

    it("surfaces Govee rejection on requestVerificationCode error", async () => {
      const probe = makeProbe({ requestError: new Error("Govee rejected") });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "requestCode" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("rejected sending the code");
    });
  });

  describe("unknown commands", () => {
    it("ignores commands with no command field", () => {
      const { host, responses } = makeHost({});
      const router = new MessageRouter(host);
      router.onMessage({ command: "" } as ioBroker.Message);
      expect(responses).toHaveLength(0);
    });

    it("returns 'Unknown action' for unknown mqttAuth action", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "weirdAction" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("Unknown action");
    });
  });
});
