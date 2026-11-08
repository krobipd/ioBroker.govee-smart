// The sliding windows of the declared limits (api-limits.json, GV-08), the way the fleet judges a run (Werkbank rounds
// 170/171): a call holds its slot from the moment it is let through until `seconds · 1000` after it settled — the server
// counts it at the latest when it answers, and a call without an answer from its send. A window is half open: a slot is
// free again exactly `seconds · 1000` after its call settled. No calendar resets: every window slides.

/** One call's slot in one lane. */
export interface Slot {
  /** When the call settled (answered or failed); undefined while it is open. */
  end?: number;
}

/**
 * The slots of every lane. A lane is one declared window of one counterpart for the account, one host or one device —
 * its key names it, and one key always has the same window length.
 */
export class SlotLanes {
  private readonly lanes = new Map<string, Slot[]>();

  /**
   * The slots of a lane still held at `now`: open, or settled less than `seconds · 1000` ago. Forgets the others.
   *
   * @param key The lane
   * @param seconds The lane's window length
   * @param now Current time (ms)
   */
  held(key: string, seconds: number, now: number): Slot[] {
    const all = this.lanes.get(key);
    if (!all) {
      return [];
    }
    const kept = all.filter(s => s.end === undefined || now - s.end < seconds * 1000);
    if (kept.length === 0) {
      this.lanes.delete(key);
    } else if (kept.length !== all.length) {
      this.lanes.set(key, kept);
    }
    return kept;
  }

  /**
   * How long until one more call fits a window of `max` calls in `seconds` — 0 when it fits now; undefined while the
   * slots that would have to free are still open (a slot frees only after its call settled).
   *
   * @param key The lane
   * @param max Calls the window allows
   * @param seconds The window length
   * @param now Current time (ms)
   */
  waitMs(key: string, max: number, seconds: number, now: number): number | undefined {
    const held = this.held(key, seconds, now);
    if (held.length < max) {
      return 0;
    }
    const ends = held
      .map(s => s.end)
      .filter((end): end is number => end !== undefined)
      .sort((a, b) => a - b);
    const mustFree = held.length - max + 1;
    return ends.length < mustFree ? undefined : ends[mustFree - 1] + seconds * 1000 - now;
  }

  /**
   * Take a slot in a lane — open until the call settles.
   *
   * @param key The lane
   */
  take(key: string): Slot {
    const slot: Slot = {};
    const lane = this.lanes.get(key);
    if (lane) {
      lane.push(slot);
    } else {
      this.lanes.set(key, [slot]);
    }
    return slot;
  }

  /**
   * Give a slot back — its call never reached the counterpart, so the counterpart counted nothing.
   *
   * @param key The lane
   * @param slot The slot
   */
  give(key: string, slot: Slot): void {
    const lane = this.lanes.get(key);
    const at = lane?.indexOf(slot) ?? -1;
    if (lane && at >= 0) {
      lane.splice(at, 1);
      if (lane.length === 0) {
        this.lanes.delete(key);
      }
    }
  }

  /**
   * The settle times of a lane's held slots, an open one as `now` — what a restart must carry over.
   *
   * @param key The lane
   * @param seconds The lane's window length
   * @param now Current time (ms)
   */
  ends(key: string, seconds: number, now: number): number[] {
    return this.held(key, seconds, now).map(s => s.end ?? now);
  }

  /**
   * Lay settled slots into a lane — the calls an earlier process of this instance made within the window.
   *
   * @param key The lane
   * @param ends Their settle times (ms)
   */
  restore(key: string, ends: readonly number[]): void {
    for (const end of ends) {
      this.take(key).end = end;
    }
  }

  /** Every lane that holds a slot right now, by key. */
  keys(): string[] {
    return [...this.lanes.keys()];
  }
}

/**
 * One settle time as it comes back from the data folder: a finite number, nothing else.
 *
 * @param value What the file holds
 */
export function isStamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
