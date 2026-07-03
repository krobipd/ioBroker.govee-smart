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
  /** Read a file from a meta.user object; rejects when the file is absent. */
  readFileAsync(meta: string, name: string): Promise<{ file: Buffer | string; mimeType?: string }>;
  /** Write a file into a meta.user object. */
  writeFileAsync(meta: string, name: string, data: Buffer | string): Promise<void>;
  /** Delete an object — used to drop the migrated-away credentials state. */
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

/** File name the encrypted MQTT credentials live in, inside the meta object. */
const CREDENTIALS_FILE = "mqtt.json";

/** The `<namespace>.credentials` meta.user object id. */
function credentialsMeta(adapter: CloudCredsAdapter): string {
  return `${adapter.namespace}.credentials`;
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
 * Load persisted MQTT credentials from the `<namespace>.credentials` meta.user
 * file. The sensitive fields are encrypted (see {@link persistCreds}). Returns
 * null when nothing is stored.
 *
 * Stored in a meta.user FILE (not a state) so the encrypted credentials are not
 * a visible / history-loggable datapoint, and saving does NOT trigger an adapter
 * restart (a native write would loop login → save → restart → login). One-shot
 * migration: an earlier `info.mqttCredentials` state (v2.1.3–v2.17.x) is copied
 * into the file and the state object removed on first load.
 *
 * @param adapter ioBroker adapter surface
 */
export async function loadPersistedCreds(adapter: CloudCredsAdapter): Promise<PersistedMqttCredentials | null> {
  // 1. Preferred: the meta.user file.
  try {
    const { file } = await adapter.readFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE);
    const raw = typeof file === "string" ? file : file.toString("utf-8");
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
    // The state blob is already encrypted — copy it verbatim into the file, then
    // drop the old state object so the credentials stop being a datapoint.
    await adapter.writeFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE, raw);
    await adapter.delObjectAsync("info.mqttCredentials").catch(() => undefined);
    adapter.log.info("Migrated persisted MQTT credentials from state to the credentials store");
    return parsePersistedBlob(adapter, raw);
  } catch {
    return null;
  }
}

/**
 * Persist freshly-issued MQTT credentials into the `<namespace>.credentials`
 * meta.user file. Sensitive fields go through `adapter.encrypt()` so the blob
 * is useless without the system secret. Writing a file does NOT trigger an
 * adapter restart (unlike a native write).
 *
 * @param adapter ioBroker adapter surface
 * @param creds   The freshly-issued MQTT bundle from a successful login
 */
export async function persistCreds(adapter: CloudCredsAdapter, creds: PersistedMqttCredentials): Promise<void> {
  const blob = JSON.stringify({
    bearerToken: adapter.encrypt(creds.bearerToken),
    iotEndpoint: creds.iotEndpoint,
    p12Cert: adapter.encrypt(creds.p12Cert),
    p12Pass: adapter.encrypt(creds.p12Pass),
    accountId: creds.accountId,
    accountTopic: creds.accountTopic,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
  await adapter.writeFileAsync(credentialsMeta(adapter), CREDENTIALS_FILE, blob);
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
