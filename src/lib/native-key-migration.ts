import { errMessage } from "./types";

/**
 * A renamed `native` key: the old spelling still sits in the instance object of
 * every installation that was upgraded, the new one arrives with the manifest
 * default. The value wins over the default.
 */
export interface NativeKeyRename {
  /** The key an earlier version wrote. */
  readonly from: string;
  /** The key this version reads. */
  readonly to: string;
  /**
   * The old value in the new key's shape — `undefined` when it is not worth
   * carrying (wrong type, empty), in which case only the old key is removed.
   */
  readonly coerce: (old: unknown) => unknown;
}

/** Adapter surface the migration needs — the instance object, nothing else. */
export interface NativeKeyMigrationAdapter {
  /** `<adapter>.<instance>` — names the instance object. */
  readonly namespace: string;
  /** info for the one-time carry-over, debug when the object cannot be read. */
  readonly log: Pick<ioBroker.Logger, "info" | "debug">;
  /** Reads the instance object (`system.adapter.<namespace>`). */
  getForeignObjectAsync(id: string): Promise<{ native?: Record<string, unknown> } | null | undefined>;
  /** Merges into the instance object — `null` deletes a key. */
  extendForeignObjectAsync(id: string, obj: { native: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Renames of this adapter's settings keys, oldest first.
 *
 * 2.37.0: the LAN listen address moves from `networkInterface` to `bind`, the
 * key the admin's port-conflict check reads next to `native.port` (fleet
 * standard "listen-port declaration"). The old key was the same value under a
 * name the admin never looked at.
 */
export const NATIVE_KEY_RENAMES: readonly NativeKeyRename[] = [
  {
    from: "networkInterface",
    to: "bind",
    coerce: old => (typeof old === "string" && old.trim() !== "" ? old.trim() : undefined),
  },
];

/**
 * Carry renamed settings keys over from an earlier version — once, on the
 * first start after the upgrade.
 *
 * js-controller adds a missing `native` key with the manifest default when an
 * adapter is upgraded and never deletes an old one. So after the upgrade the
 * instance object carries BOTH spellings: the old key with the user's value and
 * the new key with the default. Reading `new || old` would not help — the
 * injected default always wins, and the user's choice would be silently gone.
 * Instead the old value is written into the new key and the old key is deleted
 * (`null` deletes in an extend). That write changes the instance object, which
 * makes the host restart the instance — the caller stops `onReady` right there.
 *
 * An old key that carries nothing worth keeping (empty, wrong type) is deleted
 * as well: the default that arrived with the manifest is then the right value,
 * and the instance object stops carrying a setting nobody reads.
 *
 * "Deleted" means: the stored object keeps the key with the value `null` —
 * measured on the dev-server profile 2026-09-15 (the extend does not drop the
 * key, it stores the null). So a null-valued old key is the state AFTER the
 * migration, never a reason to migrate: treating it as "still there" wrote the
 * object on every start, and every write is a restart — an endless loop on
 * each installation that ever had the old key.
 *
 * @param adapter the adapter (instance object access + log)
 * @param renames the renames to apply — the adapter's list by default
 * @returns true when the instance object was changed and the restart is coming
 */
export async function migrateNativeKeys(
  adapter: NativeKeyMigrationAdapter,
  renames: readonly NativeKeyRename[] = NATIVE_KEY_RENAMES,
): Promise<boolean> {
  const id = `system.adapter.${adapter.namespace}`;
  try {
    const obj = await adapter.getForeignObjectAsync(id);
    const native = obj?.native;
    if (!native) {
      return false;
    }
    const patch: Record<string, unknown> = {};
    const carried: string[] = [];
    for (const rename of renames) {
      const old = native[rename.from];
      if (old === undefined || old === null) {
        continue; // never had the key, or already migrated (null is what the delete leaves behind)
      }
      const value = rename.coerce(old);
      if (value !== undefined) {
        patch[rename.to] = value;
        carried.push(`${rename.from} → ${rename.to}`);
      }
      // null DELETES the key in an extend (undefined would be skipped).
      patch[rename.from] = null;
    }
    if (Object.keys(patch).length === 0) {
      return false;
    }
    adapter.log.info(
      carried.length > 0
        ? `Carrying settings over from an earlier version (${carried.join(", ")}) — this instance restarts once`
        : "Removing settings keys of an earlier version — this instance restarts once",
    );
    await adapter.extendForeignObjectAsync(id, { native: patch });
    return true;
  } catch (e) {
    adapter.log.debug(`Could not migrate the settings keys: ${errMessage(e)}`);
    return false;
  }
}
