import {
  type CloudCredsAdapter,
  cleanupLegacyMqttNativeOnce,
  clearVerificationCodeSetting,
  loadPersistedCredsFromState,
  persistCredsToState,
} from "./cloud-creds-handler";
import type { PersistedMqttCredentials } from "../types";

function makeAdapter(native: Record<string, unknown> = {}): CloudCredsAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ioBroker.Logger,
    namespace: "govee-smart.0",
    getStateAsync: async () => null,
    setState: async id => {
      calls.push(`setState:${id}`);
    },
    getForeignObjectAsync: async () => ({ native }),
    extendForeignObjectAsync: async (_id, obj) => {
      calls.push(`extend:${JSON.stringify(obj.native)}`);
    },
    encrypt: v => v,
    decrypt: v => v,
  };
}

describe("cleanupLegacyMqttNativeOnce", () => {
  it("returns without side-effects when native is clean", async () => {
    const adapter = makeAdapter({ mqttBearerToken: "", mqttTokenExpiresAt: 0 });
    await cleanupLegacyMqttNativeOnce(adapter);
    expect(adapter.calls).toHaveLength(0);
  });

  it("returns without side-effects when legacy fields are absent", async () => {
    const adapter = makeAdapter({});
    await cleanupLegacyMqttNativeOnce(adapter);
    expect(adapter.calls).toHaveLength(0);
  });

  it("wipes dirty legacy fields via extendForeignObjectAsync", async () => {
    const adapter = makeAdapter({ mqttBearerToken: "secret", mqttP12Cert: "cert-data", mqttTokenExpiresAt: 999 });
    await cleanupLegacyMqttNativeOnce(adapter);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toContain("extend:");
    const wiped = JSON.parse(adapter.calls[0].replace("extend:", ""));
    expect(wiped.mqttBearerToken).toBe("");
    expect(wiped.mqttP12Cert).toBe("");
    expect(wiped.mqttTokenExpiresAt).toBe(0);
  });
});

describe("MQTT credential persistence", () => {
  function makeCredAdapter() {
    const states = new Map<string, string>();
    const adapter: CloudCredsAdapter = {
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ioBroker.Logger,
      namespace: "govee-smart.0",
      getStateAsync: async id => (states.has(id) ? ({ val: states.get(id) } as ioBroker.State) : null),
      setState: async (id, s) => {
        states.set(id, (s as { val: string }).val);
      },
      getForeignObjectAsync: async () => ({ native: {} }),
      extendForeignObjectAsync: async () => undefined,
      // reversible stand-in for the real system-secret crypto
      encrypt: v => `enc:${v}`,
      decrypt: v => v.replace(/^enc:/, ""),
    };
    return { adapter, states };
  }

  const creds: PersistedMqttCredentials = {
    bearerToken: "bt",
    iotEndpoint: "iot.example",
    p12Cert: "cert",
    p12Pass: "pass",
    accountId: "acc",
    accountTopic: "GA/acc",
    tokenExpiresAt: 1234567890,
  };

  it("persists sensitive fields encrypted, non-sensitive in clear, and loads them back (round-trip)", async () => {
    const { adapter, states } = makeCredAdapter();
    await persistCredsToState(adapter, creds);
    const stored = JSON.parse(states.get("info.mqttCredentials")!);
    expect(stored.bearerToken).toBe("enc:bt"); // encrypted at rest
    expect(stored.p12Cert).toBe("enc:cert");
    expect(stored.p12Pass).toBe("enc:pass");
    expect(stored.iotEndpoint).toBe("iot.example"); // not sensitive → clear
    expect(stored.tokenExpiresAt).toBe(1234567890);
    expect(await loadPersistedCredsFromState(adapter)).toEqual(creds); // decrypted back
  });

  it("load returns null when nothing is stored", async () => {
    expect(await loadPersistedCredsFromState(makeCredAdapter().adapter)).toBeNull();
  });

  it("load returns null when a required field is missing", async () => {
    const { adapter, states } = makeCredAdapter();
    states.set("info.mqttCredentials", JSON.stringify({ ...creds, bearerToken: "" }));
    expect(await loadPersistedCredsFromState(adapter)).toBeNull();
  });

  it("load returns null on unparseable JSON", async () => {
    const { adapter, states } = makeCredAdapter();
    states.set("info.mqttCredentials", "{ not json");
    expect(await loadPersistedCredsFromState(adapter)).toBeNull();
  });

  it("load coerces a non-string sensitive field (tampered blob) and rejects the bundle", async () => {
    const { adapter, states } = makeCredAdapter();
    states.set("info.mqttCredentials", JSON.stringify({ ...creds, bearerToken: 42 }));
    expect(await loadPersistedCredsFromState(adapter)).toBeNull();
  });
});

describe("clearVerificationCodeSetting", () => {
  it("clears the field via extendForeignObjectAsync when it holds a code", async () => {
    const adapter = makeAdapter({ mqttVerificationCode: "123456" });
    await clearVerificationCodeSetting(adapter);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toContain('"mqttVerificationCode":""');
  });

  it("is a no-op when the field is empty or absent (no needless restart)", async () => {
    const a1 = makeAdapter({ mqttVerificationCode: "" });
    await clearVerificationCodeSetting(a1);
    const a2 = makeAdapter({});
    await clearVerificationCodeSetting(a2);
    expect(a1.calls).toHaveLength(0);
    expect(a2.calls).toHaveLength(0);
  });
});
