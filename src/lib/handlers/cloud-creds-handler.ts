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
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
  getForeignObjectAsync(id: string): Promise<{ native?: unknown } | null | undefined>;
  extendForeignObjectAsync(id: string, obj: { native?: Record<string, unknown> }): Promise<unknown>;
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

/**
 * Read persisted MQTT credentials from `info.mqttCredentials`. The
 * sensitive fields (bearer + cert + pass) are encrypted with the
 * system secret on save and decrypted here. Returns null if no
 * credentials are stored or the JSON is unparseable.
 *
 * State-based persistence (since v2.1.3) — writes to a state instead
 * of `system.adapter.X.native` so saving doesn't trigger an adapter
 * restart. The earlier native-based design caused an endless
 * login → save → restart → login loop.
 *
 * @param adapter ioBroker adapter surface
 */
export async function loadPersistedCredsFromState(
  adapter: CloudCredsAdapter,
): Promise<PersistedMqttCredentials | null> {
  try {
    const s = await adapter.getStateAsync("info.mqttCredentials");
    const raw = typeof s?.val === "string" ? s.val : "";
    if (!raw) {
      return null;
    }
    const obj = JSON.parse(raw) as {
      bearerToken?: unknown;
      iotEndpoint?: unknown;
      p12Cert?: unknown;
      p12Pass?: unknown;
      accountId?: unknown;
      accountTopic?: unknown;
      tokenExpiresAt?: unknown;
    };
    // typeof guards — JSON.parse returns raw, this.decrypt() throws on
    // non-string input. Defensive: if the state blob was edited by a tool and
    // holds wrong types, we coerce them to empty strings.
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
 * Persist freshly-issued MQTT credentials into `info.mqttCredentials`.
 * Sensitive fields go through `adapter.encrypt()` so the JSON blob is
 * useless without the system secret. State writes do NOT trigger an
 * adapter restart.
 *
 * @param adapter ioBroker adapter surface
 * @param creds   The freshly-issued MQTT bundle from a successful login
 */
export async function persistCredsToState(adapter: CloudCredsAdapter, creds: PersistedMqttCredentials): Promise<void> {
  const blob = JSON.stringify({
    bearerToken: adapter.encrypt(creds.bearerToken),
    iotEndpoint: creds.iotEndpoint,
    p12Cert: adapter.encrypt(creds.p12Cert),
    p12Pass: adapter.encrypt(creds.p12Pass),
    accountId: creds.accountId,
    accountTopic: creds.accountTopic,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
  await adapter.setState("info.mqttCredentials", { val: blob, ack: true });
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
