import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage, type PersistedMqttCredentials } from "../types";

/**
 * Adapter surface required by the cloud-creds handler — only the ioBroker
 * built-ins it actually touches, so the handler is testable without the
 * full GoveeAdapter class. Method signatures are intentionally loose so
 * the structural-typing match against utils.Adapter holds across types
 * versions.
 */
export interface CloudCredsAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  getForeignObjectAsync(id: string): Promise<{ native?: unknown } | null | undefined>;
  extendForeignObjectAsync(id: string, obj: { native?: Record<string, unknown> }): Promise<unknown>;
  /** Read a file from a meta.user object — one-shot legacy migration; rejects when the file is absent. */
  readFileAsync(meta: string, name: string): Promise<{ file: Buffer | string; mimeType?: string }>;
  /** Delete a file from a meta.user object — one-shot legacy migration cleanup. */
  delFileAsync(meta: string, name: string): Promise<void>;
  /** Delete an object — used to drop the migrated-away credentials state/meta objects. */
  delObjectAsync(id: string, options?: unknown): Promise<void>;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/**
 * Clear the one-shot `mqttVerificationCode` field in
 * `system.adapter.X.native`. Skipped when the field is already empty —
 * a dirty write would trigger a needless adapter restart.
 *
 * @param adapter ioBroker adapter surface
 */
export async function clearVerificationCodeSetting(adapter: CloudCredsAdapter): Promise<void> {
  try {
    const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
    const native = (obj?.native ?? {}) as Record<string, unknown>;
    if (typeof native.mqttVerificationCode !== "string" || native.mqttVerificationCode === "") {
      return;
    }
    await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, {
      native: { mqttVerificationCode: "" },
    });
  } catch (e) {
    adapter.log.warn(`Could not clear mqttVerificationCode: ${errMessage(e)}`);
  }
}

/** File name the encrypted MQTT credentials live in, inside the instance data directory. */
const CREDENTIALS_FILE = "mqtt-credentials.json";

/** The legacy `<namespace>.credentials` meta.user object id (v2.18.0–v2.18.2). */
function legacyCredentialsMeta(adapter: CloudCredsAdapter): string {
  return `${adapter.namespace}.credentials`;
}

/**
 * Absolute path of the encrypted credentials file inside the adapter's
 * instance data directory (`iobroker-data/<namespace>/`) — invisible in the
 * object tree, host-local like the SKU cache.
 *
 * @param dataDir Adapter instance data directory
 */
function credentialsFilePath(dataDir: string): string {
  return path.join(dataDir, CREDENTIALS_FILE);
}

/**
 * Write the encrypted credentials blob to disk (owner-read/write only — the
 * sensitive fields inside are additionally encrypted with the system secret).
 *
 * @param dataDir Adapter instance data directory
 * @param blob    JSON blob as produced by {@link persistCreds}
 */
function writeCredentialsFile(dataDir: string, blob: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(credentialsFilePath(dataDir), blob, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Parse + decrypt a stored credentials blob (the shape written by
 * {@link persistCreds}). The sensitive fields (bearer + cert + pass) were
 * encrypted with the system secret on save. Returns null when the blob is
 * unparseable or incomplete.
 *
 * @param adapter ioBroker adapter surface (for decrypt)
 * @param raw The stored JSON blob
 */
function parsePersistedBlob(adapter: CloudCredsAdapter, raw: string): PersistedMqttCredentials | null {
  try {
    const obj = JSON.parse(raw) as {
      bearerToken?: unknown;
      iotEndpoint?: unknown;
      p12Cert?: unknown;
      p12Pass?: unknown;
      accountId?: unknown;
      accountTopic?: unknown;
      tokenExpiresAt?: unknown;
    };
    // typeof guards — decrypt() throws on non-string input. Defensive: if the
    // blob was tampered and holds wrong types, coerce them to empty strings.
    const safeStr = (v: unknown): string => (typeof v === "string" ? v : "");
    const bearerToken = adapter.decrypt(safeStr(obj.bearerToken));
    const p12Cert = adapter.decrypt(safeStr(obj.p12Cert));
    const p12Pass = adapter.decrypt(safeStr(obj.p12Pass));
    const iotEndpoint = safeStr(obj.iotEndpoint);
    const accountId = safeStr(obj.accountId);
    const accountTopic = safeStr(obj.accountTopic);
    const tokenExpiresAt = typeof obj.tokenExpiresAt === "number" ? obj.tokenExpiresAt : 0;
    if (!bearerToken || !iotEndpoint || !p12Cert || !accountId || !accountTopic || !tokenExpiresAt) {
      return null;
    }
    return { bearerToken, iotEndpoint, p12Cert, p12Pass, accountId, accountTopic, tokenExpiresAt };
  } catch {
    return null;
  }
}

/**
 * Load persisted MQTT credentials from the encrypted file in the instance data
 * directory. The sensitive fields are encrypted (see {@link persistCreds}).
 * Returns null when nothing is stored.
 *
 * Stored as a plain FILE (not a state, not a meta object) so the encrypted
 * credentials are neither a visible datapoint nor a visible object-tree node,
 * and saving does NOT trigger an adapter restart (a native write would loop
 * login → save → restart → login). This is a re-derivable cache — the source
 * of truth (account e-mail/password) lives in the encrypted adapter config.
 * One-shot migration: an earlier `info.mqttCredentials` state (v2.1.3–v2.17.x)
 * is copied into the file and the state object removed on first load; the
 * v2.18.x meta-object file is handled by {@link migrateCredentialsMetaOnce}.
 *
 * @param adapter ioBroker adapter surface
 * @param dataDir Adapter instance data directory
 */
export async function loadPersistedCreds(
  adapter: CloudCredsAdapter,
  dataDir: string,
): Promise<PersistedMqttCredentials | null> {
  // 1. Preferred: the encrypted file in the instance data directory.
  try {
    const raw = fs.readFileSync(credentialsFilePath(dataDir), "utf-8");
    const creds = raw ? parsePersistedBlob(adapter, raw) : null;
    if (creds) {
      return creds;
    }
  } catch {
    // file absent → fall through to the one-shot state migration
  }
  // 2. One-shot migration from the legacy info.mqttCredentials state.
  try {
    const s = await adapter.getStateAsync("info.mqttCredentials");
    const raw = typeof s?.val === "string" ? s.val : "";
    if (!raw) {
      return null;
    }
    // Parse FIRST: the blob in hand is valid credentials for this session
    // even if the file write below fails (read-only FS, full disk). The old
    // order threw them away on a write error → fresh login + potential 2FA
    // mail on every start — the exact storm this persistence exists to
    // prevent.
    const creds = parsePersistedBlob(adapter, raw);
    try {
      // The state blob is already encrypted — copy it verbatim into the file,
      // then drop the old state object so the credentials stop being a
      // datapoint. Only remove the legacy state once the file carry-over
      // actually succeeded; otherwise keep it as the migration source for
      // the next start.
      writeCredentialsFile(dataDir, raw);
      await adapter.delObjectAsync("info.mqttCredentials").catch(() => undefined);
      adapter.log.info("Migrated persisted MQTT credentials from state to the credentials store");
    } catch (e) {
      adapter.log.debug(`Credentials file write failed — keeping legacy state for next start: ${errMessage(e)}`);
    }
    return creds;
  } catch (e) {
    adapter.log.debug(`Legacy credentials migration failed: ${errMessage(e)}`);
    return null;
  }
}

/**
 * Persist freshly-issued MQTT credentials into the encrypted file in the
 * instance data directory. Sensitive fields go through `adapter.encrypt()` so
 * the blob is useless without the system secret. Writing a file does NOT
 * trigger an adapter restart (unlike a native write).
 *
 * @param adapter ioBroker adapter surface
 * @param dataDir Adapter instance data directory
 * @param creds   The freshly-issued MQTT bundle from a successful login
 */
export async function persistCreds(
  adapter: CloudCredsAdapter,
  dataDir: string,
  creds: PersistedMqttCredentials,
): Promise<void> {
  const blob = JSON.stringify({
    bearerToken: adapter.encrypt(creds.bearerToken),
    iotEndpoint: creds.iotEndpoint,
    p12Cert: adapter.encrypt(creds.p12Cert),
    p12Pass: adapter.encrypt(creds.p12Pass),
    accountId: creds.accountId,
    accountTopic: creds.accountTopic,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
  // async fs on the hot path (runs on every login/token refresh); the sync
  // writeCredentialsFile stays for the two one-shot startup migrations.
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(credentialsFilePath(dataDir), blob, { encoding: "utf-8", mode: 0o600 });
}

/**
 * One-shot migration + cleanup of the legacy `<namespace>.credentials`
 * meta.user object (v2.18.0–v2.18.2). The credentials cache now lives as a
 * file in the instance data directory: it is re-derivable from the configured
 * account (which IS part of every backup), so it does not need the meta
 * object's backup inclusion — and the visible `credentials` node disappears
 * from the object tree. Copies a stored blob into the new file (unless one
 * already exists), then drops the meta file and the meta object. Idempotent,
 * best-effort — runs on every start and no-ops once everything is gone.
 *
 * @param adapter ioBroker adapter surface
 * @param dataDir Adapter instance data directory
 */
export async function migrateCredentialsMetaOnce(adapter: CloudCredsAdapter, dataDir: string): Promise<void> {
  let carryOverOk = true;
  try {
    const { file } = await adapter.readFileAsync(legacyCredentialsMeta(adapter), "mqtt.json");
    const raw = typeof file === "string" ? file : file.toString("utf-8");
    if (raw && !fs.existsSync(credentialsFilePath(dataDir))) {
      try {
        writeCredentialsFile(dataDir, raw);
        adapter.log.info("Migrated persisted MQTT credentials into the instance data directory");
      } catch (e) {
        // Write failure (read-only FS, full disk) is NOT "no blob": keep the
        // legacy meta file as the migration source for the next start —
        // deleting it here would throw away a valid token cache and trigger
        // the fresh-login/2FA path this cache exists to avoid.
        carryOverOk = false;
        adapter.log.debug(`Credentials carry-over failed — keeping legacy meta for next start: ${errMessage(e)}`);
      }
    }
  } catch {
    // no stored blob (fresh install or already migrated) — still drop the meta object below
  }
  if (carryOverOk) {
    try {
      await adapter.delFileAsync(legacyCredentialsMeta(adapter), "mqtt.json");
    } catch {
      // file already gone
    }
    await adapter.delObjectAsync("credentials").catch(() => undefined);
  }
}

/**
 * One-shot cleanup of legacy v2.1.0/v2.1.1/v2.1.2 plaintext credentials
 * sitting in `system.adapter.X.native`.
 *
 * Idempotent via dirty-check: if all legacy fields are already empty/zero,
 * returns immediately without side-effects.
 */
export async function cleanupLegacyMqttNativeOnce(adapter: CloudCredsAdapter): Promise<void> {
  try {
    const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
    const native = (obj?.native ?? {}) as Record<string, unknown>;
    const legacy = [
      "mqttBearerToken",
      "mqttIotEndpoint",
      "mqttP12Cert",
      "mqttP12Pass",
      "mqttAccountId",
      "mqttAccountTopic",
      "mqttTokenExpiresAt",
    ];
    const dirty = legacy.some(k => k in native && native[k] !== "" && native[k] !== 0);
    if (!dirty) {
      return;
    }
    adapter.log.info(`Removing legacy plaintext MQTT credentials from native (one-time migration)`);
    const wipe: Record<string, unknown> = {};
    for (const k of legacy) {
      wipe[k] = k === "mqttTokenExpiresAt" ? 0 : "";
    }
    await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: wipe });
  } catch (e) {
    adapter.log.debug(`legacy MQTT cleanup skipped: ${errMessage(e)}`);
  }
}
