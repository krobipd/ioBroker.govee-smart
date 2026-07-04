import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type CloudCredsAdapter,
  cleanupLegacyMqttNativeOnce,
  clearVerificationCodeSetting,
  loadPersistedCreds,
  migrateCredentialsMetaOnce,
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
    delFileAsync: async () => {},
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

describe("MQTT credential persistence (instance-data-dir file)", () => {
  let dataDir: string;
  const credsFile = (): string => path.join(dataDir, "mqtt-credentials.json");

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-creds-test-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function makeCredAdapter() {
    const states = new Map<string, string>();
    const metaFiles = new Map<string, string>();
    const deletedObjects: string[] = [];
    const deletedMetaFiles: string[] = [];
    const adapter: CloudCredsAdapter = {
      log: noopLog,
      namespace: "govee-smart.0",
      getStateAsync: async id => (states.has(id) ? ({ val: states.get(id) } as ioBroker.State) : null),
      getForeignObjectAsync: async () => ({ native: {} }),
      extendForeignObjectAsync: async () => undefined,
      readFileAsync: async (meta, name) => {
        const key = `${meta}/${name}`;
        if (!metaFiles.has(key)) {
          throw new Error("Not exists"); // mirrors ioBroker: rejects when the file is absent
        }
        return { file: metaFiles.get(key)! };
      },
      delFileAsync: async (meta, name) => {
        const key = `${meta}/${name}`;
        if (!metaFiles.has(key)) {
          throw new Error("Not exists");
        }
        metaFiles.delete(key);
        deletedMetaFiles.push(key);
      },
      delObjectAsync: async id => {
        deletedObjects.push(id);
        states.delete(id);
      },
      // reversible stand-in for the real system-secret crypto
      encrypt: v => `enc:${v}`,
      decrypt: v => v.replace(/^enc:/, ""),
    };
    return { adapter, states, metaFiles, deletedObjects, deletedMetaFiles };
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

  /** The already-encrypted blob shape persistCreds writes. */
  const encBlob = JSON.stringify({
    bearerToken: "enc:bt",
    iotEndpoint: "iot.example",
    p12Cert: "enc:cert",
    p12Pass: "enc:pass",
    accountId: "acc",
    accountTopic: "GA/acc",
    tokenExpiresAt: 1234567890,
  });

  it("persists sensitive fields encrypted, non-sensitive in clear, into the file, and loads them back", async () => {
    const { adapter } = makeCredAdapter();
    await persistCreds(adapter, dataDir, creds);
    const stored = JSON.parse(fs.readFileSync(credsFile(), "utf-8"));
    expect(stored.bearerToken).toBe("enc:bt"); // encrypted at rest
    expect(stored.p12Cert).toBe("enc:cert");
    expect(stored.p12Pass).toBe("enc:pass");
    expect(stored.iotEndpoint).toBe("iot.example"); // not sensitive → clear
    expect(stored.tokenExpiresAt).toBe(1234567890);
    expect(await loadPersistedCreds(adapter, dataDir)).toEqual(creds); // decrypted back
  });

  it("persist creates the data directory when it does not exist yet", async () => {
    const { adapter } = makeCredAdapter();
    const nested = path.join(dataDir, "does", "not", "exist");
    await persistCreds(adapter, nested, creds);
    expect(fs.existsSync(path.join(nested, "mqtt-credentials.json"))).toBe(true);
  });

  it("load returns null when nothing is stored (no file, no legacy state)", async () => {
    expect(await loadPersistedCreds(makeCredAdapter().adapter, dataDir)).toBeNull();
  });

  it("load returns null when a required field is missing", async () => {
    const { adapter } = makeCredAdapter();
    fs.writeFileSync(credsFile(), JSON.stringify({ ...creds, bearerToken: "" }));
    expect(await loadPersistedCreds(adapter, dataDir)).toBeNull();
  });

  it("load returns null on unparseable JSON", async () => {
    const { adapter } = makeCredAdapter();
    fs.writeFileSync(credsFile(), "{ not json");
    expect(await loadPersistedCreds(adapter, dataDir)).toBeNull();
  });

  it("load coerces a non-string sensitive field (tampered blob) and rejects the bundle", async () => {
    const { adapter } = makeCredAdapter();
    fs.writeFileSync(credsFile(), JSON.stringify({ ...creds, bearerToken: 42 }));
    expect(await loadPersistedCreds(adapter, dataDir)).toBeNull();
  });

  it("one-shot migration: copies a legacy info.mqttCredentials state into the file and deletes the state", async () => {
    const { adapter, states, deletedObjects } = makeCredAdapter();
    states.set("info.mqttCredentials", encBlob);

    const loaded = await loadPersistedCreds(adapter, dataDir);
    expect(loaded).toEqual(creds); // decrypted from the migrated blob
    expect(fs.readFileSync(credsFile(), "utf-8")).toBe(encBlob); // copied verbatim (still encrypted)
    expect(deletedObjects).toContain("info.mqttCredentials"); // old state removed
    expect(states.has("info.mqttCredentials")).toBe(false);
  });

  it("prefers the file over the legacy state (no migration when the file already has creds)", async () => {
    const { adapter, states, deletedObjects } = makeCredAdapter();
    await persistCreds(adapter, dataDir, creds); // file populated
    states.set("info.mqttCredentials", JSON.stringify({ ...creds, accountId: "STALE" }));
    const loaded = await loadPersistedCreds(adapter, dataDir);
    expect(loaded).toEqual(creds); // from the file, not the stale state
    expect(deletedObjects).toHaveLength(0); // legacy path never touched
  });

  describe("migrateCredentialsMetaOnce (v2.18.x meta object → data-dir file)", () => {
    const META_KEY = "govee-smart.0.credentials/mqtt.json";

    it("copies the stored meta blob into the data-dir file, then drops meta file + object", async () => {
      const { adapter, metaFiles, deletedObjects, deletedMetaFiles } = makeCredAdapter();
      metaFiles.set(META_KEY, encBlob);

      await migrateCredentialsMetaOnce(adapter, dataDir);
      expect(fs.readFileSync(credsFile(), "utf-8")).toBe(encBlob); // migrated verbatim
      expect(deletedMetaFiles).toContain(META_KEY); // meta file removed
      expect(deletedObjects).toContain("credentials"); // meta object removed
      // and the migrated blob loads
      expect(await loadPersistedCreds(adapter, dataDir)).toEqual(creds);
    });

    it("does not overwrite an existing data-dir file, but still drops the meta leftovers", async () => {
      const { adapter, metaFiles, deletedObjects } = makeCredAdapter();
      await persistCreds(adapter, dataDir, creds); // fresh file already there
      metaFiles.set(META_KEY, JSON.stringify({ stale: true }));

      await migrateCredentialsMetaOnce(adapter, dataDir);
      expect(await loadPersistedCreds(adapter, dataDir)).toEqual(creds); // untouched
      expect(deletedObjects).toContain("credentials");
      expect(metaFiles.has(META_KEY)).toBe(false);
    });

    it("with nothing stored it only drops the meta object (idempotent, no file created)", async () => {
      const { adapter, deletedObjects } = makeCredAdapter();
      await migrateCredentialsMetaOnce(adapter, dataDir);
      await migrateCredentialsMetaOnce(adapter, dataDir); // second run = same no-op
      expect(fs.existsSync(credsFile())).toBe(false);
      expect(deletedObjects.filter(id => id === "credentials")).toHaveLength(2);
    });
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
