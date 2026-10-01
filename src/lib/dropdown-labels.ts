// Dropdown maps: unique labels for a list of names, and the reverse lookup of a written value.

/**
 * Disambiguate a list of names by appending " (2)", " (3)" to repeats,
 * preserving the order. The first occurrence keeps the original name.
 *
 * Used both when building common.states maps and when reverse-resolving
 * a label back to an index — the SAME function on both sides guarantees
 * the user-visible label and the lookup target stay in sync, even when
 * the source list (cloud scenes etc.) contains duplicates.
 *
 * @param names Raw name list, possibly containing duplicates
 */
export function disambiguateLabels(names: string[]): string[] {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  return names.map(name => {
    let n = counts.get(name) ?? 0;
    let label = n === 0 ? name : `${name} (${n + 1})`;
    // Guard against colliding with a name the input already carried in
    // "(N)"-suffixed form (e.g. ["Aurora","Aurora","Aurora (2)"]) — keep bumping
    // the counter until the label is actually unique so the reverse-lookup stays
    // deterministic (I4).
    while (used.has(label)) {
      n += 1;
      label = `${name} (${n + 1})`;
    }
    counts.set(name, n + 1);
    used.add(label);
    return label;
  });
}

/**
 * Build a `common.states` map from a list of named items, with index 0
 * reserved for a sentinel entry (default "---" = no selection).
 *
 * Duplicate names are disambiguated via `disambiguateLabels`, so each
 * value in the resulting map is unique and the reverse-lookup is
 * deterministic.
 *
 * @param items Source list — each item must have a `name` field
 * @param zeroLabel Label for index 0 (default "---" = no selection)
 */
export function buildUniqueLabelMap<T extends { name: string }>(items: T[], zeroLabel = "---"): Record<string, string> {
  const labels = disambiguateLabels(items.map(item => item.name));
  const result: Record<string, string> = { 0: zeroLabel };
  labels.forEach((label, i) => {
    result[String(i + 1)] = label;
  });
  return result;
}

/**
 * Result of resolving a state value against a `common.states` map.
 * `key` is the matching map key (string form, as stored in the map),
 * `canonical` is the matching label (the canonical, disambiguated form
 * — what the dropdown displays).
 */
export interface ResolvedStatesValue {
  /** The matching key from the states map, in string form */
  key: string;
  /** Canonical label as stored in the states map */
  canonical: string;
}

/**
 * Reverse-resolve a state value against a `common.states` map, accepting
 * three input forms:
 * - number `1`            → direct key lookup
 * - string matching a key → direct key match (case-sensitive — keys
 * are identifiers like "1" or "spectrum")
 * - string matching a label → case-insensitive trim match against
 * the map values
 *
 * Returns null when no match is found. The caller decides whether to
 * warn, ack=false, or fall back to a default — this helper is pure.
 *
 * @param input User-supplied state value (number, string, or other)
 * @param statesMap The state's `common.states` map (key → label)
 */
export function resolveStatesValue(input: unknown, statesMap: Record<string, string>): ResolvedStatesValue | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    const key = String(input);
    // Own-property guard so a value/key can never resolve against an inherited
    // Object.prototype member (SEC-GC2). String(number) can't be "__proto__" etc.,
    // but keep it symmetric with the string branch below.
    if (Object.prototype.hasOwnProperty.call(statesMap, key)) {
      return { key, canonical: statesMap[key] };
    }
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      return null;
    }
    // Direct key match — handles numeric-string keys ("1") and
    // identifier-string keys ("spectrum") in one pass. Own-property guard so a
    // dropdown input of "__proto__" / "toString" / "constructor" can't match an
    // inherited prototype member and falsely resolve ok=true (SEC-GC2).
    if (Object.prototype.hasOwnProperty.call(statesMap, trimmed)) {
      return { key: trimmed, canonical: statesMap[trimmed] };
    }
    // Label match — case-insensitive, trim. Lets users write the
    // human-readable name (e.g. "Aurora") regardless of casing.
    const needle = trimmed.toLowerCase();
    for (const [key, label] of Object.entries(statesMap)) {
      if (typeof label === "string" && label.trim().toLowerCase() === needle) {
        return { key, canonical: label };
      }
    }
  }
  return null;
}
