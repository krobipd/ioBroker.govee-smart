import {
  type CloudCredsAdapter,
  cleanupLegacyMqttNativeOnce,
  clearVerificationCodeSetting,
  loadPersistedCreds,
  persistCreds,
} from "./cloud-creds-handler";
import type { PersistedMqttCredentials } from "../types";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ioBroker.Logger;

function makeAdapter(native: Record<string, unknown> = {}): CloudCredsAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    log: noopLog,
    namespace: "govee-smart.0",
    getStateAsync: async () => null,
    getForeignObjectAsync: async () => ({ native }),
    extendForeignObjectAsync: async (_id, obj) => {
      calls.push(`extend:${JSON.stringify(obj.native)}`);
    },
    readFileAsync: async () => {
      throw new Error("Not exists");
    },
    writeFileAsync: async () => {},
    delObjectAsync: async () => {},
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

describe("MQTT credential persistence (meta.user file)", () => {
  const CREDS_KEY = "govee-smart.0.credentials/mqtt.json";

  function makeCredAdapter() {
    const states = new Map<string, string>();
    const files = new Map<string, string>();
    const deletedObjects: string[] = [];
    const adapter: CloudCredsAdapter = {
      log: noopLog,
      namespace: "govee-smart.0",
      getStateAsync: async id => (states.has(id) ? ({ val: states.get(id) } as ioBroker.State) : null),
      getForeignObjectAsync: async () => ({ native: {} }),
      extendForeignObjectAsync: async () => undefined,
      readFileAsync: async (meta, name) => {
        const key = `${meta}/${name}`;
        if (!files.has(key)) {
          throw new Error("Not exists"); // mirrors ioBroker: rejects when the file is absent
        }
        return { file: files.get(key)! };
      },
      writeFileAsync: async (meta, name, data) => {
        files.set(`${meta}/${name}`, typeof data === "string" ? data : data.toString("utf-8"));
      },
      delObjectAsync: async id => {
        deletedObjects.push(id);
        states.delete(id);
      },
      // reversible stand-in for the real system-secret crypto
      encrypt: v => `enc:${v}`,
      decrypt: v => v.replace(/^enc:/, ""),
    };
    return { adapter, states, files, deletedObjects };
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

  it("persists sensitive fields encrypted, non-sensitive in clear, into the file, and loads them back", async () => {
    const { adapter, files } = makeCredAdapter();
    await persistCreds(adapter, creds);
    const stored = JSON.parse(files.get(CREDS_KEY)!);
    expect(stored.bearerToken).toBe("enc:bt"); // encrypted at rest
    expect(stored.p12Cert).toBe("enc:cert");
    expect(stored.p12Pass).toBe("enc:pass");
    expect(stored.iotEndpoint).toBe("iot.example"); // not sensitive → clear
    expect(stored.tokenExpiresAt).toBe(1234567890);
    expect(await loadPersistedCreds(adapter)).toEqual(creds); // decrypted back
  });

  it("load returns null when nothing is stored (no file, no legacy state)", async () => {
    expect(await loadPersistedCreds(makeCredAdapter().adapter)).toBeNull();
  });

  it("load returns null when a required field is missing", async () => {
    const { adapter, files } = makeCredAdapter();
    files.set(CREDS_KEY, JSON.stringify({ ...creds, bearerToken: "" }));
    expect(await loadPersistedCreds(adapter)).toBeNull();
  });

  it("load returns null on unparseable JSON", async () => {
    const { adapter, files } = makeCredAdapter();
    files.set(CREDS_KEY, "{ not json");
    expect(await loadPersistedCreds(adapter)).toBeNull();
  });

  it("load coerces a non-string sensitive field (tampered blob) and rejects the bundle", async () => {
    const { adapter, files } = makeCredAdapter();
    files.set(CREDS_KEY, JSON.stringify({ ...creds, bearerToken: 42 }));
    expect(await loadPersistedCreds(adapter)).toBeNull();
  });

  it("one-shot migration: copies a legacy info.mqttCredentials state into the file and deletes the state", async () => {
    const { adapter, states, files, deletedObjects } = makeCredAdapter();
    // The legacy state holds the already-encrypted blob (same shape persistCreds writes).
    const encBlob = JSON.stringify({
      bearerToken: "enc:bt",
      iotEndpoint: "iot.example",
      p12Cert: "enc:cert",
      p12Pass: "enc:pass",
      accountId: "acc",
      accountTopic: "GA/acc",
      tokenExpiresAt: 1234567890,
    });
    states.set("info.mqttCredentials", encBlob);

    const loaded = await loadPersistedCreds(adapter);
    expect(loaded).toEqual(creds); // decrypted from the migrated blob
    expect(files.get(CREDS_KEY)).toBe(encBlob); // copied verbatim (still encrypted)
    expect(deletedObjects).toContain("info.mqttCredentials"); // old state removed
    expect(states.has("info.mqttCredentials")).toBe(false);
  });

  it("prefers the file over the legacy state (no migration when the file already has creds)", async () => {
    const { adapter, states, deletedObjects } = makeCredAdapter();
    await persistCreds(adapter, creds); // file populated
    states.set("info.mqttCredentials", JSON.stringify({ ...creds, accountId: "STALE" }));
    const loaded = await loadPersistedCreds(adapter);
    expect(loaded).toEqual(creds); // from the file, not the stale state
    expect(deletedObjects).toHaveLength(0); // legacy path never touched
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
