// The segment-list syntax of `segments.manual_list` / `segments.command`, and the protocol's segment limit.

/**
 * Highest addressable segment index — the Govee bitmask protocol limit (56 slots, 0..55). The ONE value: the
 * segment list, the batch parser, the wizard and the device manager all read it (until 3.1.0 the list parser kept
 * its own copy, and the adapter docs named a third value).
 */
export const SEGMENT_HARD_MAX = 55;

/**
 * Result of parsing a manual-segments string like "0-9", "0-2,4-9", "0,3,5".
 *
 * indices  Deduplicated, sorted list of segment indices
 *
 * error    Human-readable error (null on success)
 */
export interface SegmentListParseResult {
  /** Deduplicated, sorted list of segment indices */
  indices: number[];
  /** Human-readable error (null on success) */
  error: string | null;
}

/**
 * Parse a user-provided segment-list string.
 * Accepts comma-separated singles ("0,1,2"), ranges ("0-9"), mixed
 * ("0-8,10-14"); whitespace-tolerant. Deduplicates automatically and
 * returns the result sorted ascending.
 *
 * @param input User-input string
 * @param maxIndex Per-device upper bound (e.g. device.segmentCount - 1). Indices > maxIndex are rejected.
 * @returns SegmentListParseResult with indices + optional error
 */
export function parseSegmentList(input: string, maxIndex: number): SegmentListParseResult {
  if (typeof input !== "string") {
    return { indices: [], error: "input must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { indices: [], error: "list is empty" };
  }
  const effectiveMax = Math.min(
    Number.isFinite(maxIndex) && maxIndex >= 0 ? Math.floor(maxIndex) : SEGMENT_HARD_MAX,
    SEGMENT_HARD_MAX,
  );
  const set = new Set<number>();
  const parts = trimmed.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") {
      continue;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) {
        return {
          indices: [],
          error: `invalid range "${part}" (start > end)`,
        };
      }
      for (let i = start; i <= end; i++) {
        if (i < 0 || i > effectiveMax) {
          return {
            indices: [],
            error: `segment ${i} is outside 0-${effectiveMax} for this device`,
          };
        }
        set.add(i);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return {
        indices: [],
        error: `invalid entry "${part}" (only digits and ranges allowed)`,
      };
    }
    const idx = parseInt(part, 10);
    if (idx < 0 || idx > effectiveMax) {
      return {
        indices: [],
        error: `segment ${idx} is outside 0-${effectiveMax} for this device`,
      };
    }
    set.add(idx);
  }
  if (set.size === 0) {
    return { indices: [], error: "no valid indices in list" };
  }
  return {
    indices: Array.from(set).sort((a, b) => a - b),
    error: null,
  };
}
