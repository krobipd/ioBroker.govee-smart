import { MessageRouter, type MessageRouterHost } from "./message-router";
import type { GoveeMqttClient } from "./govee-mqtt-client";

// MessageRouter routes mqttAuth result strings through adapter-core I18n; resolve
// them against the real en.json with positional %s substitution (mirrors
// I18n.translate) so the content assertions below hold without booting
// js-controller.
vi.mock("@iobroker/adapter-core", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const enJson = JSON.parse(readFileSync(join(__dirname, "../../admin/i18n/en.json"), "utf8")) as Record<
    string,
    string
  >;
  return {
    I18n: {
      getTranslatedObject: vi.fn((key: string) => ({ en: key })),
      translate: vi.fn((key: string, ...args: (string | number)[]) => {
        let i = 0;
        return (enJson[key] ?? key).replace(/%s/g, () => String(args[i++] ?? "%s"));
      }),
    },
  };
});

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
  /**
   * Failure the client would classify from a failed login/connect. Models the
   * REAL contract: connect() resolves on every failure path — the outcome is
   * only readable via getLastError() (H2). A fake that throws from connect()
   * would test dead code.
   */
  lastError?: { category: string; message: string };
  /** When set, lastError surfaces only on the SECOND getLastError() read — models a broker-stage failure that lands during the edge-wait. */
  lateError?: boolean;
  /** Throw this from probe.requestVerificationCode. */
  requestError?: Error;
  /** Called whenever probe.disconnect() runs — lets a test assert disposal. */
  onDisconnect?: () => void;
}

function makeProbe(opts: FakeProbeOpts): GoveeMqttClient {
  let lastErrorReads = 0;
  const probe = {
    setVerificationCode: (_code: string) => {},
    enableProbeMode: () => {},
    disconnect: () => opts.onDisconnect?.(),
    getLastError: () => {
      if (!opts.lastError) {
        return null;
      }
      lastErrorReads++;
      if (opts.lateError && lastErrorReads === 1) {
        return null;
      }
      return opts.lastError;
    },
    requestVerificationCode: (): Promise<void> => {
      if (opts.requestError) {
        return Promise.reject(opts.requestError);
      }
      return Promise.resolve();
    },
    connect: (_onStatus: unknown, onConnection: (connected: boolean) => void): Promise<void> => {
      // The real client resolves connect() after the login + cert handshake and
      // only issues the MQTT connect — the "connected" edge (onConnection(true))
      // arrives asynchronously AFTER this resolves, via the mqtt "connect" event
      // → subscribe. Model that timing so a probe that reads `connected`
      // synchronously right after connect() sees false (the M2 bug). connect()
      // NEVER throws — failures land in getLastError() (H2).
      if (opts.connected) {
        setTimeout(() => onConnection(true), 0);
      }
      return Promise.resolve();
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
  diagnosticsDevices?: Array<{ value: string; label: string; model: string }>;
  diagnosticsReport?: { fileName: string; content: string } | { error: string };
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
    createMqttProbeClient: (_email: string, _password: string) => opts.probe ?? makeProbe({ connected: false }),
    getDiagnosticsDeviceList: () => opts.diagnosticsDevices ?? [],
    buildDiagnosticsReport: () =>
      Promise.resolve(opts.diagnosticsReport ?? { error: "no report configured in this test" }),
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
  };
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

    it("forwards the apply action with its indices payload to runWizardStep", async () => {
      const calls: Array<{ action: string; device: string; payload?: unknown }> = [];
      const { host, responses } = makeHost({ wizardResponse: { applied: true } });
      host.runWizardStep = (action, device, payload) => {
        calls.push({ action, device, payload });
        return Promise.resolve({ applied: true });
      };
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("segmentWizard", { action: "apply", device: "H6160:AA:01", indices: [0, 1, 2, 4] }));
      await new Promise(r => setTimeout(r, 0));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        action: "apply",
        device: "H6160:AA:01",
        payload: { indices: [0, 1, 2, 4] },
      });
      expect(responses[0].data).toEqual({ applied: true });
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
      const probe = makeProbe({
        lastError: { category: "AUTH", message: "Login failed: bad" },
        onDisconnect: () => (disconnects += 1),
      });
      const { host } = makeHost({ probe });
      const router = new MessageRouter(host, 20);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 30));
      expect(disconnects).toBe(1);
    });

    it("returns 2FA hint on Verification required error", async () => {
      const probe = makeProbe({
        lastError: {
          category: "VERIFICATION_PENDING",
          message: "Verification required by Govee — request a code via Adapter settings (status 454)",
        },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("two-factor confirmation");
    });

    it("returns invalid-code hint on Verification code invalid", async () => {
      const probe = makeProbe({
        lastError: { category: "VERIFICATION_FAILED", message: "Verification code invalid or expired (status 455)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("code invalid");
    });

    it("returns email-not-registered on matching error", async () => {
      const probe = makeProbe({
        lastError: { category: "AUTH", message: "Login failed: email not registered (status 451)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("not registered");
    });

    it("returns rate-limit hint", async () => {
      const probe = makeProbe({
        lastError: { category: "RATE_LIMIT", message: "Rate limited by Govee: too many requests (status 429)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("rate limit");
    });

    it("returns account-locked hint", async () => {
      const probe = makeProbe({
        lastError: { category: "UNKNOWN", message: "Account temporarily locked by Govee: abnormal login (status 400)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("temporarily locked");
    });

    it("H2 regression: wrong password reports 'rejected' immediately — NOT 'login ok, MQTT not up' after the timeout", async () => {
      // The real client never rejects from connect(); before H2 the router
      // classified in a catch that could never fire and answered
      // mqttAuthLoginNoMqtt after burning the full probe timeout.
      const probe = makeProbe({
        lastError: { category: "AUTH", message: "Login failed: wrong password (status 401)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host, 5000);
      const t0 = Date.now();
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("rejected the password");
      // Classified synchronously after connect() — no 5s edge-wait burned.
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it("H2: broker-stage failure during the edge-wait beats the generic 'MQTT not up' answer", async () => {
      const probe = makeProbe({
        lastError: { category: "UNKNOWN", message: "Govee login rejected: policy mismatch" },
        lateError: true,
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host, 20);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 60));
      const r = responses[0].data as { result: string };
      expect(r.result).toContain("policy mismatch");
      expect(r.result).not.toContain("MQTT connection is not up");
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

    it("returns a machine-readable status alongside the result — 'ok' on success", async () => {
      const { host, responses } = makeHost({ probe: makeProbe({ connected: true }) });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { result: string; status: string };
      expect(r.status).toBe("ok");
    });

    it("returns status 'verifyRequired' on a 454 (the card opens the 2FA field)", async () => {
      const probe = makeProbe({
        lastError: { category: "VERIFICATION_PENDING", message: "Verification required by Govee (status 454)" },
      });
      const { host, responses } = makeHost({ probe });
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test" }));
      await new Promise(r => setTimeout(r, 10));
      const r = responses[0].data as { status: string };
      expect(r.status).toBe("verifyRequired");
    });

    it("uses the LIVE credentials from the payload (not the saved config) so a test needs no save first", async () => {
      const seen: Array<{ email: string; password: string }> = [];
      const { host } = makeHost({ email: "saved@x.com", password: "savedpw" });
      host.createMqttProbeClient = (email, password) => {
        seen.push({ email, password });
        return makeProbe({ connected: true });
      };
      const router = new MessageRouter(host);
      router.onMessage(makeMessage("mqttAuth", { action: "test", email: "live@x.com", password: "livepw" }));
      await new Promise(r => setTimeout(r, 10));
      expect(seen).toEqual([{ email: "live@x.com", password: "livepw" }]);
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

describe("onMessage crash boundaries", () => {
  it("a throwing sub-handler is answered with an error and warned about (inner boundary)", async () => {
    const warns: string[] = [];
    const { host, responses } = makeHost({});
    host.log = { ...mockLog, warn: (m: string) => warns.push(m) };
    host.runWizardStep = () => Promise.reject(new Error("wizard exploded"));
    const router = new MessageRouter(host);
    router.onMessage(makeMessage("segmentWizard", { action: "start", device: "H6160:AA:01" }));
    await new Promise(r => setTimeout(r, 0));
    expect(responses).toHaveLength(1);
    expect(responses[0].data).toEqual({ error: "wizard exploded" });
    expect(warns).toEqual(["onMessage failed for segmentWizard: wizard exploded"]);
  });

  it("a crash while answering is caught by the outer boundary — never an unhandled rejection (outer boundary)", async () => {
    const warns: string[] = [];
    const { host, responses } = makeHost({ segmentDevices: [{ value: "H6160:AA:01", label: "Strip" }] });
    host.log = { ...mockLog, warn: (m: string) => warns.push(m) };
    // The first sendResponse (the success answer) blows up — the ioBroker
    // socket is gone; the second (the outer error answer) must still go out.
    const original = host.sendResponse;
    let calls = 0;
    host.sendResponse = (obj, data) => {
      calls += 1;
      // The success answer AND the inner error answer both fail; only the
      // outer boundary's answer gets through.
      if (calls <= 2) {
        throw new Error("socket gone");
      }
      original(obj, data);
    };
    const router = new MessageRouter(host);
    router.onMessage(makeMessage("getSegmentDevices"));
    await new Promise(r => setTimeout(r, 0));
    expect(warns).toEqual([
      "onMessage failed for getSegmentDevices: socket gone",
      "onMessage handler crashed for getSegmentDevices: socket gone",
    ]);
    expect(responses).toEqual([expect.objectContaining({ data: { error: "socket gone" } })]);
  });
});

describe("diagnostics command", () => {
  it("lists every real device, reachable or not", async () => {
    // A report is wanted precisely when a device misbehaves, so filtering the
    // list by reachability would hide the interesting ones.
    const { host, responses } = makeHost({
      diagnosticsDevices: [{ value: "H61BE:AA:BB", label: "Strip (H61BE)", model: "H61BE" }],
    });
    const router = new MessageRouter(host);
    router.onMessage({ command: "diagnostics", message: { action: "list" }, from: "x", callback: {} } as never);
    await new Promise(r => setTimeout(r, 0));
    expect((responses[0].data as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it("hands the report back with its content so the card can offer a download", async () => {
    const { host, responses } = makeHost({
      diagnosticsReport: { fileName: "govee-smart_H61BE_1d6f_v2.29.0_2026-09-03_101500.json", content: "{}" },
    });
    const router = new MessageRouter(host);
    router.onMessage({
      command: "diagnostics",
      message: { action: "export", device: "H61BE:AA:BB" },
      from: "x",
      callback: {},
    } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(responses[0].data).toMatchObject({ fileName: expect.stringContaining("H61BE"), content: "{}" });
  });

  it("answers an unknown action instead of leaving the caller hanging", async () => {
    // An admin sendTo without an answer hangs until it times out.
    const { host, responses } = makeHost({});
    const router = new MessageRouter(host);
    router.onMessage({ command: "diagnostics", message: { action: "nope" }, from: "x", callback: {} } as never);
    await new Promise(r => setTimeout(r, 0));
    expect(responses[0].data).toMatchObject({ error: expect.stringContaining("nope") });
  });
});

