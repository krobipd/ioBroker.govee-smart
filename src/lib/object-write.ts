// Writing an object only when it changes — fleet rule (round 61): every object write goes to the database and to
// every subscriber, and the inventory run fails on a write that changes nothing.

/**
 * Whether merging `patch` into `existing` (as `extendObject` does) changes nothing: every key the patch sets already
 * holds that value. Plain objects are compared key by key (the merge keeps keys the patch does not name); an array or
 * a value compares whole. A key the patch leaves `undefined` sets nothing.
 *
 * @param patch What would be merged
 * @param existing The object as stored
 */
export function patchChangesNothing(patch: unknown, existing: unknown): boolean {
  if (patch === undefined) {
    return true;
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return canonical(patch) === canonical(existing ?? null);
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return false;
  }
  const stored = existing as Record<string, unknown>;
  return Object.entries(patch as Record<string, unknown>).every(([key, value]) =>
    patchChangesNothing(value, stored[key]),
  );
}

/**
 * JSON with sorted object keys — key order carries no meaning in an ioBroker object.
 *
 * @param value Any JSON value
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

/** The two object calls {@link extendIfChanged} needs. */
export interface ObjectWriter {
  /** Reads one object (namespace-less id). */
  getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Merges into one object (namespace-less id). */
  extendObject(id: string, patch: ioBroker.PartialObject): Promise<unknown>;
}

/**
 * `extendObject` only when the patch changes something — one read instead of a write that reaches every subscriber.
 *
 * @param adapter The adapter's object calls
 * @param id Namespace-less object id
 * @param patch What `extendObject` would merge
 * @returns true when the object was written
 */
export async function extendIfChanged(
  adapter: ObjectWriter,
  id: string,
  patch: ioBroker.PartialObject,
): Promise<boolean> {
  const existing = await adapter.getObjectAsync(id);
  if (existing && patchChangesNothing(patch, existing)) {
    return false;
  }
  await adapter.extendObject(id, patch);
  return true;
}
