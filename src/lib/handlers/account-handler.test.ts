import { vi } from "vitest";

vi.mock("./connection-state", () => ({
  checkAllReady: vi.fn(),
  updateConnectionState: vi.fn(),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionState from "./connection-state";
import { onAccountConnection, wireAccountClient, type AccountHandlerAdapter } from "./account-handler";
import { usableVerificationCode } from "./cloud-creds-handler";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import { mockLog } from "../../../test/test-helpers";

type Hooks = Record<string, (...args: never[]) => unknown>;

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function rig(code = "123456"): {
  adapter: AccountHandlerAdapter & connectionState.ConnectionStateAdapter;
  client: GoveeMqttClient;
  hooks: Hooks;
  flags: Array<[string, unknown]>;
  reported: string[];
  resolved: string[];
  dataDir: string;
  diag: { packets: unknown[]; calls: unknown[] };
  staleRequests: number[];
} {
  const hooks: Hooks = {};
  const flags: Array<[string, unknown]> = [];
  const reported: string[] = [];
  const resolved: string[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-account-test-"));
  dataDirs.push(dataDir);
  const diag = { packets: [] as unknown[], calls: [] as unknown[] };
  const staleRequests: number[] = [];
  let verificationCode: string | undefined;
  const client = new Proxy(
    {},
    {
      get: (_t, name: string) => (value: unknown) => {
        if (name === "setVerificationCode") {
          verificationCode = value as string;
          return;
        }
        hooks[name] = value as (...args: never[]) => unknown;
      },
    },
  ) as unknown as GoveeMqttClient;
  const adapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    deviceManager: {
      getDiagnostics: () => ({
        addMqttPacket: (...a: unknown[]) => diag.packets.push(a),
        recordAccountCall: (...a: unknown[]) => diag.calls.push(a),
      }),
      requestStaleStatuses: () => staleRequests.push(1),
    },
    stateManager: {
      writeReadOnly: (id: string, val: unknown) => {
        flags.push([id, val]);
        return Promise.resolve();
      },
    },
    actionableProblems: {
      report: (p: { key: string; title: string }) => reported.push(`${p.key}: ${p.title}`),
      resolve: (key: string) => resolved.push(key),
    },
  } as unknown as AccountHandlerAdapter & connectionState.ConnectionStateAdapter;
  wireAccountClient(adapter, client, code, dataDir);
  expect(verificationCode).toBe(code);
  return { adapter, client, hooks, flags, reported, resolved, dataDir, diag, staleRequests };
}

describe("wireAccountClient", () => {
  it("a rejected code shows the code state, is remembered as spent and asks for a fresh code", async () => {
    const r = rig();
    (r.hooks.setOnVerificationFailed as (reason: string) => void)("failed");
    await vi.waitFor(() => expect(usableVerificationCode(r.dataDir, "123456")).toBe(""));
    expect(r.flags).toEqual([["info.verificationPending", true]]);
    expect(r.reported).toEqual(["mqtt-verification: Govee rejected the verification code for real-time status"]);
  });

  it("a code Govee wants for the first time is not marked and asks for one", async () => {
    const r = rig();
    (r.hooks.setOnVerificationFailed as (reason: string) => void)("pending");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(usableVerificationCode(r.dataDir, "123456")).toBe("123456");
    expect(r.reported[0]).toMatch(/^mqtt-verification: Govee requires a verification code/);
  });

  it("a consumed code is remembered as spent, so no later login sends it", async () => {
    const r = rig();
    r.hooks.setOnVerificationConsumed();
    await vi.waitFor(() => expect(usableVerificationCode(r.dataDir, "123456")).toBe(""));
    expect(usableVerificationCode(r.dataDir, "654321")).toBe("654321");
  });

  it("rejected credentials and a blocked login each surface once for the user", () => {
    const r = rig();
    r.hooks.setOnAuthFailed();
    r.hooks.setOnLoginBlocked();
    expect(r.reported.map(p => p.split(":")[0])).toEqual(["mqtt-auth", "mqtt-login-blocked"]);
  });

  it("packets and the two account calls reach the report", () => {
    const r = rig();
    (r.hooks.setPacketHook as (d: string, t: string, p: unknown) => void)("AA", "GA/x", { a: 1 });
    (r.hooks.setOnAccountCall as (e: string, ok: boolean, s?: number, m?: string) => void)("login", false, 400, "no");
    expect(r.diag.packets).toEqual([["AA", "GA/x", { a: 1 }]]);
    expect(r.diag.calls).toEqual([["login", false, 400, "no"]]);
  });
});

describe("onAccountConnection", () => {
  it("a connection settles the account problems, clears the code state and asks what went quiet", () => {
    const r = rig();
    onAccountConnection(r.adapter, true);
    expect(r.flags).toEqual([
      ["info.mqttConnected", true],
      ["info.verificationPending", false],
    ]);
    expect(r.resolved).toEqual(["mqtt-verification", "mqtt-auth", "mqtt-login-blocked"]);
    expect(r.staleRequests).toEqual([1]);
    expect(connectionState.checkAllReady).toHaveBeenCalled();
    expect(connectionState.updateConnectionState).toHaveBeenCalled();
  });

  it("a drop only lowers the indicator", () => {
    const r = rig();
    onAccountConnection(r.adapter, false);
    expect(r.flags).toEqual([["info.mqttConnected", false]]);
    expect(r.resolved).toEqual([]);
    expect(r.staleRequests).toEqual([]);
  });
});
