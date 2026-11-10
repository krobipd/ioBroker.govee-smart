import { createHash } from "node:crypto";
import { errText, type PersistedMqttCredentials } from "../types";
import { readDataFile, writeDataFile } from "../data-file";
import { deriveGoveeClientId } from "../govee-constants";

/**
 * Adapter surface required by the cloud-creds handler — only the ioBroker
 * built-ins it actually touches, so the handler is testable without the
 * full GoveeAdapter class. Method signatures are intentionally loose so
 * the structural-typing match against utils.Adapter holds across types
 * versions.
 */
export interface CloudCredsAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** Read one own state. */
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  /** Read a file from a meta.user object — one-shot legacy migration; rejects when the file is absent. */
  readFileAsync(meta: string, name: string): Promise<{ file: Buffer | string; mimeType?: string }>;
  /** Delete a file from a meta.user object — one-shot legacy migration cleanup. */
  delFileAsync(meta: string, name: string): Promise<void>;
  /** Delete an object — used to drop the migrated-away credentials state/meta objects. */
  delObjectAsync(id: string, options?: unknown): Promise<void>;
  /** Encrypt a value with the instance's secret. */
  encrypt(value: string): string;
  /** Decrypt a value encrypted with the instance's secret. */
  decrypt(value: string): string;
}

/**
 * File in the instance data directory that remembers the last verification code Govee consumed or rejected. The
 * settings field keeps what the user typed — `native` belongs to the settings page, which writes back on save what
 * it loaded on opening, and every write to it restarts the instance (CLAUDE_PATTERNS.md) — so the adapter notes
 * outside it that the code is spent.
 */
const USED_CODE_FILE = "verification-code.json";

/**
 * The stored mark of a code: its hash, never the code itself.
 *
 * @param code The trimmed code
 */
function codeMark(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * The fields of a parsed data file. A file that holds `null` (or nothing was read) has none; a number or a text has
 * none of the names read here either, so only null and undefined need the empty stand-in.
 *
 * @param value The parsed content
 */
function fieldsOf(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/**
 * The verification code a login sends: the one from the settings (or the card), or "" once Govee consumed or
 * rejected exactly this code — a spent code is skipped instead of being replayed on every login.
 *
 * @param dataDir Adapter instance data directory
 * @param code The code from the settings or the card
 */
export function usableVerificationCode(dataDir: string, code: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return "";
  }
  // no mark yet, or an unusable one, carries no hash: the code was never spent
  return fieldsOf(readDataFile(dataDir, USED_CODE_FILE).value).used === codeMark(trimmed) ? "" : trimmed;
}

/**
 * Remember that Govee consumed or rejected this code, so no later login sends it again. The write itself is
 * synchronous; the promise only carries a failed write to the callers' `.catch` instead of throwing into the MQTT
 * callback that reports the code.
 *
 * @param dataDir Adapter instance data directory
 * @param code The code that went out
 */
export function markVerificationCodeUsed(dataDir: string, code: string): Promise<void> {
  return new Promise<void>(resolve => {
    const trimmed = code.trim();
    if (trimmed) {
      writeDataFile(dataDir, USED_CODE_FILE, { used: codeMark(trimmed) });
    }
    resolve();
  });
}

/** File name the encrypted MQTT credentials live in, inside the instance data directory. */
const CREDENTIALS_FILE = "mqtt-credentials.json";

/**
 * The legacy `<namespace>.credentials` meta.user object id (v2.18.0–v2.18.2).
 *
 * @param adapter The adapter surface
 */
function legacyCredentialsMeta(adapter: CloudCredsAdapter): string {
  return `${adapter.namespace}.credentials`;
}

/**
 * Whether a usable credentials file is there — then a legacy blob has nothing to add. A file that cannot be used holds
 * nothing either, so the blob replaces it; a data folder that cannot be read fails the write as well and keeps the
 * legacy source for the next start.
 *
 * @param dataDir Adapter instance data directory
 */
function usableCredentialsFile(dataDir: string): boolean {
  return readDataFile(dataDir, CREDENTIALS_FILE).value !== undefined;
}

/**
 * The parsed content of a legacy credentials blob (the JSON text the `info.mqttCredentials` state of v2.1.3–v2.17.x
 * and the meta file of v2.18.x held), or undefined when the text is no JSON — such a blob holds nothing to carry over.
 * JSON never parses to undefined, so the two cannot be mixed up.
 *
 * @param raw The stored text
 */
function legacyBlobValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Decrypt a stored credentials blob (the shape written by
 * {@link persistCreds}). The sensitive fields (bearer + cert + pass) were
 * encrypted with the system secret on save. Returns null when the blob is
 * missing, no object or incomplete.
 *
 * @param adapter ioBroker adapter surface (for decrypt)
 * @param value The parsed blob, undefined when there is none
 */
function parsePersistedBlob(adapter: CloudCredsAdapter, value: unknown): PersistedMqttCredentials | null {
  try {
    const obj = fieldsOf(value);
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
 * The account key a stored blob was bound to, or "" for a blob written before
 * the binding existed.
 *
 * @param value The parsed blob
 */
function readAccountKey(value: unknown): string {
  const { accountKey } = fieldsOf(value);
  return typeof accountKey === "string" ? accountKey : "";
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
 * @param accountEmail The account email the credentials belong to
 */
export async function loadPersistedCreds(
  adapter: CloudCredsAdapter,
  dataDir: string,
  accountEmail?: string,
): Promise<PersistedMqttCredentials | null> {
  // 1. Preferred: the encrypted file in the instance data directory. No file,
  // an unusable one (unreadable, no JSON, empty) and an incomplete one all
  // fall through to the one-shot state migration.
  const stored = readDataFile(dataDir, CREDENTIALS_FILE).value;
  const fileCreds = parsePersistedBlob(adapter, stored);
  if (fileCreds) {
    // The session belongs to the account it was issued for. After the user
    // switched to another Govee account the stored bundle would subscribe the
    // OLD account's topic and read the OLD account's lists until its token
    // expires — and the new account's sensors, missing from that list, would
    // be reaped after two polls. A blob written before 2.40.0 carries no
    // account key: it is accepted once and bound on the next save (refusing
    // it would send every upgraded installation a verification mail).
    const storedKey = readAccountKey(stored);
    if (storedKey && accountEmail !== undefined && storedKey !== deriveGoveeClientId(accountEmail)) {
      adapter.log.debug("Stored MQTT session belongs to another Govee account — fresh login");
      return null;
    }
    return fileCreds;
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
    const blob = legacyBlobValue(raw);
    const creds = parsePersistedBlob(adapter, blob);
    try {
      // The state blob is already encrypted — its parsed object goes into the
      // file as it is, then the old state object is dropped so the credentials
      // stop being a datapoint. Only remove the legacy state once the file
      // carry-over actually succeeded; otherwise keep it as the migration
      // source for the next start. A blob that is no JSON holds nothing to
      // carry over (up to 3.2.1 it was copied as it was and the next start
      // found an unusable file): it is dropped without a file.
      if (blob !== undefined) {
        writeDataFile(dataDir, CREDENTIALS_FILE, blob);
      }
      await adapter.delObjectAsync("info.mqttCredentials").catch(() => undefined);
      adapter.log.debug("Migrated persisted MQTT credentials from state to the credentials store");
    } catch (e) {
      adapter.log.debug(`Credentials file write failed — keeping legacy state for next start: ${errText(e)}`);
    }
    return creds;
  } catch (e) {
    adapter.log.debug(`Legacy credentials migration failed: ${errText(e)}`);
    return null;
  }
}

/**
 * Persist freshly-issued MQTT credentials into the encrypted file in the
 * instance data directory. Sensitive fields go through `adapter.encrypt()` so
 * the blob is useless without the system secret. Writing a file does NOT
 * trigger an adapter restart (unlike a native write).
 *
 * The fleet master writes synchronously through a temporary file renamed over
 * the old one, readable for the owner only: a torn file would cost a fresh
 * login (and possibly a verification mail) on the next start, and a login and
 * a token refresh can no longer interleave inside one write. The promise only
 * carries a failed write (or encryption) to the caller's `.catch`.
 *
 * @param adapter ioBroker adapter surface
 * @param dataDir Adapter instance data directory
 * @param creds   The freshly-issued MQTT bundle from a successful login
 * @param accountEmail The account email the credentials belong to
 */
export function persistCreds(
  adapter: CloudCredsAdapter,
  dataDir: string,
  creds: PersistedMqttCredentials,
  accountEmail?: string,
): Promise<void> {
  return new Promise<void>(resolve => {
    writeDataFile(dataDir, CREDENTIALS_FILE, {
      // Binds the session to its account (see loadPersistedCreds) — the derived
      // client id, not the address itself.
      ...(accountEmail !== undefined ? { accountKey: deriveGoveeClientId(accountEmail) } : {}),
      bearerToken: adapter.encrypt(creds.bearerToken),
      iotEndpoint: creds.iotEndpoint,
      p12Cert: adapter.encrypt(creds.p12Cert),
      p12Pass: adapter.encrypt(creds.p12Pass),
      accountId: creds.accountId,
      accountTopic: creds.accountTopic,
      tokenExpiresAt: creds.tokenExpiresAt,
    });
    resolve();
  });
}

/**
 * One-shot migration + cleanup of the legacy `<namespace>.credentials`
 * meta.user object (v2.18.0–v2.18.2). The credentials cache now lives as a
 * file in the instance data directory: it is re-derivable from the configured
 * account (which IS part of every backup), so it does not need the meta
 * object's backup inclusion — and the visible `credentials` node disappears
 * from the object tree. Copies a stored blob — its parsed object, still
 * encrypted — into the new file (unless a usable one already exists),
 * then drops the meta file and the meta object; a blob that is no JSON holds
 * nothing to carry over and is dropped without a file. Idempotent,
 * best-effort — runs on every start and no-ops once everything is gone.
 *
 * @param adapter ioBroker adapter surface
 * @param dataDir Adapter instance data directory
 */
export async function migrateCredentialsMetaOnce(adapter: CloudCredsAdapter, dataDir: string): Promise<void> {
  let carryOverOk = true;
  try {
    const { file } = await adapter.readFileAsync(legacyCredentialsMeta(adapter), "mqtt.json");
    const blob = legacyBlobValue(typeof file === "string" ? file : file.toString("utf-8"));
    if (blob !== undefined && !usableCredentialsFile(dataDir)) {
      try {
        writeDataFile(dataDir, CREDENTIALS_FILE, blob);
        adapter.log.debug("Migrated persisted MQTT credentials into the instance data directory");
      } catch (e) {
        // Write failure (read-only FS, full disk) is NOT "no blob": keep the
        // legacy meta file as the migration source for the next start —
        // deleting it here would throw away a valid token cache and trigger
        // the fresh-login/2FA path this cache exists to avoid.
        carryOverOk = false;
        adapter.log.debug(`Credentials carry-over failed — keeping legacy meta for next start: ${errText(e)}`);
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
