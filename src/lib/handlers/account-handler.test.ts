import { vi } from "vitest";

vi.mock("./connection-state", () => ({
  checkAllReady: vi.fn(),
  updateConnectionState: vi.fn(),
}));

import * as connectionState from "./connection-state";
import { onAccountConnection, wireAccountClient, type AccountHandlerAdapter } from "./account-handler";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import { mockLog } from "../../../test/test-helpers";

type Hooks = Record<string, (...args: never[]) => unknown>;

function rig(code = "123456"): {
  adapter: AccountHandlerAdapter & connectionState.ConnectionStateAdapter;
  client: GoveeMqttClient;
  hooks: Hooks;
  flags: Array<[string, unknown]>;
  reported: string[];
  resolved: string[];
  cleared: unknown[];
  diag: { packets: unknown[]; calls: unknown[] };
  staleRequests: number[];
} {
  const hooks: Hooks = {};
  const flags: Array<[string, unknown]> = [];
  const reported: string[] = [];
  const resolved: string[] = [];
  const cleared: unknown[] = [];
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
    getForeignObjectAsync: () => Promise.resolve(structuredClone({ native: { mqttVerificationCode: code } })),
    extendForeignObjectAsync: (_id: string, obj: unknown) => {
      cleared.push(obj);
      return Promise.resolve();
    },
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
  wireAccountClient(adapter, client, code);
  expect(verificationCode).toBe(code);
  return { adapter, client, hooks, flags, reported, resolved, cleared, diag, staleRequests };
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("wireAccountClient", () => {
  it("a rejected code shows the code state, clears the setting and asks for a fresh code", async () => {
    const r = rig();
    (r.hooks.setOnVerificationFailed as (reason: string) => void)("failed");
    await settle();
    expect(r.flags).toEqual([["info.verificationPending", true]]);
    expect(r.cleared).toEqual([{ native: { mqttVerificationCode: "" } }]);
    expect(r.reported).toEqual(["mqtt-verification: Govee rejected the verification code for real-time status"]);
  });

  it("a code Govee wants for the first time keeps the setting and asks for one", async () => {
    const r = rig();
    (r.hooks.setOnVerificationFailed as (reason: string) => void)("pending");
    await settle();
    expect(r.cleared).toEqual([]);
    expect(r.reported[0]).toMatch(/^mqtt-verification: Govee requires a verification code/);
  });

  it("a consumed code is cleared from the settings", async () => {
    const r = rig();
    r.hooks.setOnVerificationConsumed();
    await settle();
    expect(r.cleared).toEqual([{ native: { mqttVerificationCode: "" } }]);
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
