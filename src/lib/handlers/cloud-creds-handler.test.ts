import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type CloudCredsAdapter,
  loadPersistedCreds,
  markVerificationCodeUsed,
  migrateCredentialsMetaOnce,
  persistCreds,
  usableVerificationCode,
} from "./cloud-creds-handler";
import { deriveGoveeClientId } from "../govee-constants";
import type { PersistedMqttCredentials } from "../types";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ioBroker.Logger;

/**
 * Whether a file holds what the fleet master `writeDataFile` writes — pretty JSON with a trailing newline. Every write
 * into the data folder goes through it (round 173), and this form shows it on every platform, Windows included.
 *
 * @param file The file to read
 */
function writtenByMaster(file: string): boolean {
  const text = fs.readFileSync(file, "utf-8");
  return text === `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
}

describe("MQTT credential persistence (instance-data-dir file)", () => {
  let dataDir: string;
  const credsFile = (): string => path.join(dataDir, "mqtt-credentials.json");

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-creds-test-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function makeCredAdapter(): {
    adapter: CloudCredsAdapter;
    states: Map<string, string>;
    metaFiles: Map<string, string>;
    deletedObjects: string[];
    deletedMetaFiles: string[];
  } {
    const states = new Map<string, string>();
    const metaFiles = new Map<string, string>();
    const deletedObjects: string[] = [];
    const deletedMetaFiles: string[] = [];
    const adapter: CloudCredsAdapter = {
      log: noopLog,
      namespace: "govee-smart.0",
      getStateAsync: id => Promise.resolve(states.has(id) ? ({ val: states.get(id) } as ioBroker.State) : null),
      readFileAsync: (meta, name) => {
        const key = `${meta}/${name}`;
        if (!metaFiles.has(key)) {
          return Promise.reject(new Error("Not exists")); // mirrors ioBroker: rejects when the file is absent
        }
        return Promise.resolve({ file: metaFiles.get(key)! });
      },
      delFileAsync: (meta, name) => {
        const key = `${meta}/${name}`;
        if (!metaFiles.has(key)) {
          return Promise.reject(new Error("Not exists"));
        }
        metaFiles.delete(key);
        deletedMetaFiles.push(key);
        return Promise.resolve();
      },
      delObjectAsync: id => {
        deletedObjects.push(id);
        states.delete(id);
        return Promise.resolve();
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

  it("binds the session to its account: another account's bundle is not reused (audit 2026-09-24 M11)", async () => {
    // Switching the configured Govee account used to reuse the OLD account's
    // bundle until its token expired — its topic, its lists, and after two
    // polls the new account's sensors were reaped as "gone".
    const { adapter } = makeCredAdapter();
    await persistCreds(adapter, dataDir, creds, "first@example.com");
    expect(await loadPersistedCreds(adapter, dataDir, "first@example.com")).toEqual(creds);
    expect(await loadPersistedCreds(adapter, dataDir, "  FIRST@example.com ")).toEqual(creds); // same account, re-typed
    expect(await loadPersistedCreds(adapter, dataDir, "second@example.com")).toBeNull();
    expect(JSON.stringify(JSON.parse(fs.readFileSync(credsFile(), "utf-8")))).not.toContain("first@example.com");
  });

  it("accepts a bundle written before the binding existed — refusing it would mail every upgraded user a code", async () => {
    const { adapter } = makeCredAdapter();
    fs.writeFileSync(credsFile(), encBlob);
    expect(await loadPersistedCreds(adapter, dataDir, "anyone@example.com")).toEqual(creds);
  });

  it("a bound bundle in the compact form 3.2.1 wrote still loads, and still only for its account", async () => {
    // 3.2.1 wrote one line of JSON without a trailing newline; the fleet master writes pretty JSON — the reader takes both
    const { adapter } = makeCredAdapter();
    const bound = { accountKey: deriveGoveeClientId("first@example.com"), ...(JSON.parse(encBlob) as object) };
    fs.writeFileSync(credsFile(), JSON.stringify(bound), { mode: 0o600 });
    expect(await loadPersistedCreds(adapter, dataDir, "first@example.com")).toEqual(creds);
    expect(await loadPersistedCreds(adapter, dataDir, "second@example.com")).toBeNull();
  });

  it("the credentials file is owner-only and written by the fleet master — on every write path", async () => {
    // Encryption and file mode are two independent guards, and only the content one
    // was ever asserted: a mutation run on 2026-09-07 flipped 0o600 to 0o644 on BOTH
    // writers and the whole suite stayed green. The bearer token and the certificate
    // password sit in this file; the adapter secret that decrypts them is on the same
    // machine, so a world-readable blob is not a rest state we want.
    // Since round 173 every writer goes through the fleet master (data-file.ts), which
    // creates the temporary file with mode 0o600 and renames it into place. Windows has
    // no POSIX modes: statSync reports 0o666 there, which turned CI run #705 red on
    // windows-latest (2026-09-07). So the master's form is asserted on every platform
    // and the real mode wherever the concept exists.
    const { adapter, states, metaFiles } = makeCredAdapter();
    const posix = process.platform !== "win32";
    const expectOwnerOnlyFromMaster = (): void => {
      expect(writtenByMaster(credsFile())).toBe(true);
      if (posix) {
        expect(fs.statSync(credsFile()).mode & 0o777).toBe(0o600);
      }
    };

    // the hot path, runs on every login and token refresh
    await persistCreds(adapter, dataDir, creds);
    expectOwnerOnlyFromMaster();

    // the one-shot startup migration from the v2.18.x meta object
    fs.rmSync(credsFile());
    metaFiles.set("govee-smart.0.credentials/mqtt.json", encBlob);
    await migrateCredentialsMetaOnce(adapter, dataDir);
    expectOwnerOnlyFromMaster();

    // the one-shot migration from the info.mqttCredentials state (v2.1.3–v2.17.x)
    fs.rmSync(credsFile());
    states.set("info.mqttCredentials", encBlob);
    await loadPersistedCreds(adapter, dataDir);
    expectOwnerOnlyFromMaster();
  });

  it("persist creates the data directory when it does not exist yet", async () => {
    const { adapter } = makeCredAdapter();
    const nested = path.join(dataDir, "does", "not", "exist");
    await persistCreds(adapter, nested, creds);
    expect(fs.existsSync(path.join(nested, "mqtt-credentials.json"))).toBe(true);
  });

  it("a failed persist rejects instead of throwing — every caller handles it with .catch", async () => {
    // a folder where the master's temporary file belongs makes the write fail on every platform
    const { adapter } = makeCredAdapter();
    fs.mkdirSync(path.join(dataDir, "mqtt-credentials.json.tmp"));
    await expect(persistCreds(adapter, dataDir, creds)).rejects.toThrow();
    expect(fs.existsSync(credsFile())).toBe(false);
  });

  it("load returns null when nothing is stored (no file, no legacy state)", async () => {
    expect(await loadPersistedCreds(makeCredAdapter().adapter, dataDir)).toBeNull();
  });

  it("a file holding JSON null is unusable and falls through to the legacy state", async () => {
    const { adapter, states } = makeCredAdapter();
    fs.writeFileSync(credsFile(), "null");
    expect(await loadPersistedCreds(adapter, dataDir)).toBeNull();
    states.set("info.mqttCredentials", encBlob);
    expect(await loadPersistedCreds(adapter, dataDir)).toEqual(creds);
    expect(JSON.parse(fs.readFileSync(credsFile(), "utf-8"))).toEqual(JSON.parse(encBlob));
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
    expect(JSON.parse(fs.readFileSync(credsFile(), "utf-8"))).toEqual(JSON.parse(encBlob)); // the blob's object, still encrypted
    expect(deletedObjects).toContain("info.mqttCredentials"); // old state removed
    expect(states.has("info.mqttCredentials")).toBe(false);
  });

  it("one-shot migration: a state blob that is no JSON is dropped without a file", async () => {
    // Up to 3.2.1 such a blob was copied as it was, and the next start found an unusable file; the fleet master writes
    // JSON only. Keeping the state would retry the same useless carry-over on every start.
    const { adapter, states, deletedObjects } = makeCredAdapter();
    states.set("info.mqttCredentials", "{ not json");
    expect(await loadPersistedCreds(adapter, dataDir)).toBeNull();
    expect(fs.existsSync(credsFile())).toBe(false);
    expect(deletedObjects).toContain("info.mqttCredentials");
  });

  it("one-shot migration: a failed file write keeps the legacy state and still uses its credentials", async () => {
    const { adapter, states, deletedObjects } = makeCredAdapter();
    states.set("info.mqttCredentials", encBlob);
    fs.mkdirSync(path.join(dataDir, "mqtt-credentials.json.tmp")); // the master's temporary file cannot be created
    expect(await loadPersistedCreds(adapter, dataDir)).toEqual(creds);
    expect(fs.existsSync(credsFile())).toBe(false);
    expect(deletedObjects).not.toContain("info.mqttCredentials");
    expect(states.has("info.mqttCredentials")).toBe(true);
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
      expect(JSON.parse(fs.readFileSync(credsFile(), "utf-8"))).toEqual(JSON.parse(encBlob)); // the blob's object
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

    it("an existing file that cannot be used holds nothing — the meta blob replaces it", async () => {
      const { adapter, metaFiles, deletedObjects } = makeCredAdapter();
      fs.writeFileSync(credsFile(), "{ broken");
      metaFiles.set(META_KEY, encBlob);

      await migrateCredentialsMetaOnce(adapter, dataDir);
      expect(JSON.parse(fs.readFileSync(credsFile(), "utf-8"))).toEqual(JSON.parse(encBlob));
      expect(deletedObjects).toContain("credentials");
      expect(metaFiles.has(META_KEY)).toBe(false);
    });

    it("a data folder that cannot be read keeps the meta file and object — the write fails too", async () => {
      const { adapter, metaFiles, deletedObjects } = makeCredAdapter();
      metaFiles.set(META_KEY, encBlob);
      const blocked = path.join(dataDir, "not-a-folder");
      fs.writeFileSync(blocked, "x"); // a file where the data folder should be

      await migrateCredentialsMetaOnce(adapter, blocked);
      expect(metaFiles.has(META_KEY)).toBe(true);
      expect(deletedObjects).not.toContain("credentials");
    });

    it("a meta blob that is no JSON is dropped without a file", async () => {
      const { adapter, metaFiles, deletedObjects } = makeCredAdapter();
      metaFiles.set(META_KEY, "{ not json");

      await migrateCredentialsMetaOnce(adapter, dataDir);
      expect(fs.existsSync(credsFile())).toBe(false);
      expect(deletedObjects).toContain("credentials");
      expect(metaFiles.has(META_KEY)).toBe(false);
    });

    it("a failed carry-over keeps the meta file and object as the source for the next start", async () => {
      const { adapter, metaFiles, deletedObjects } = makeCredAdapter();
      metaFiles.set(META_KEY, encBlob);
      fs.mkdirSync(path.join(dataDir, "mqtt-credentials.json.tmp")); // the master's temporary file cannot be created

      await migrateCredentialsMetaOnce(adapter, dataDir);
      expect(fs.existsSync(credsFile())).toBe(false);
      expect(metaFiles.has(META_KEY)).toBe(true);
      expect(deletedObjects).not.toContain("credentials");
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

// The settings field keeps the code the user typed (`native` belongs to the settings page, round 170): a code Govee
// consumed or rejected is remembered in the instance data folder and skipped instead of being cleared.
describe("verification code spent outside the settings", () => {
  let dataDir: string;
  const markFile = (): string => path.join(dataDir, "verification-code.json");

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-code-test-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("a code nobody marked goes out trimmed", () => {
    expect(usableVerificationCode(dataDir, " 123456 ")).toBe("123456");
  });

  it("a marked code is skipped, a different one goes out", async () => {
    await markVerificationCodeUsed(dataDir, " 123456 ");
    expect(usableVerificationCode(dataDir, "123456")).toBe("");
    expect(usableVerificationCode(dataDir, " 123456")).toBe("");
    expect(usableVerificationCode(dataDir, "654321")).toBe("654321");
  });

  it("the mark holds the code's hash, never the code, written by the fleet master, readable by the owner only", async () => {
    // Windows has no POSIX modes (statSync reports 0o666): the master's form holds everywhere, the real mode where the
    // concept exists — as for the credentials file above
    await markVerificationCodeUsed(dataDir, "123456");
    expect(fs.readFileSync(markFile(), "utf-8")).not.toContain("123456");
    expect(writtenByMaster(markFile())).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(markFile()).mode & 0o777).toBe(0o600);
    }
  });

  it("a failed mark rejects instead of throwing — every caller handles it with .catch", async () => {
    // a folder where the master's temporary file belongs makes the write fail on every platform
    fs.mkdirSync(path.join(dataDir, "verification-code.json.tmp"));
    await expect(markVerificationCodeUsed(dataDir, "123456")).rejects.toThrow();
    expect(usableVerificationCode(dataDir, "123456")).toBe("123456");
  });

  it("a mark in one compact line, as the file's first writer wrote it before the fleet master, is still read", () => {
    // the sha256 of "123456", in the form the code before data-file.ts wrote it (never released)
    const mark = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";
    fs.writeFileSync(markFile(), JSON.stringify({ used: mark }), { mode: 0o600 });
    expect(usableVerificationCode(dataDir, "123456")).toBe("");
  });

  it("a mark file holding JSON null counts as no mark", () => {
    fs.writeFileSync(markFile(), "null");
    expect(usableVerificationCode(dataDir, "123456")).toBe("123456");
  });

  it("an empty code is neither marked nor sent", async () => {
    await markVerificationCodeUsed(dataDir, "   ");
    expect(fs.existsSync(markFile())).toBe(false);
    expect(usableVerificationCode(dataDir, "  ")).toBe("");
  });

  it("an unreadable mark counts as no mark", () => {
    fs.writeFileSync(markFile(), "{broken");
    expect(usableVerificationCode(dataDir, "123456")).toBe("123456");
  });
});
