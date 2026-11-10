// What every limiter of the instance carries over a restart: the held slots of each declared window (call-window.ts),
// one file in the instance data folder, written in onUnload and read before the limiters take their first call. A
// restart within a window — the host restarting the instance after a change of its object, the fleet's suite `a restart
// right after the start` — must not hand a counterpart a second window's worth of calls. The file is read and written
// through the fleet master data-file.ts (round 173).
import { readLaneMemory, type LaneMemory } from "./call-window";
import { readDataFile, writeDataFile } from "./data-file";

/** The file in the instance data folder. */
export const LIMIT_MEMORY_FILE = "rate-limits.json";

/** One memory per limiter of the instance. */
export interface LimitMemory {
  /** The cloud rate limiter (rate-limiter.ts). */
  limiter?: LaneMemory;
  /** The gate of every HTTP request (call-gate.ts). */
  gate?: LaneMemory;
  /** The gate of the LAN datagrams (govee-lan-client.ts). */
  lan?: LaneMemory;
  /** The account broker's connection and write windows (govee-mqtt-client.ts). */
  broker?: LaneMemory;
  /** The events broker's connection and write windows (govee-openapi-mqtt-client.ts). */
  events?: LaneMemory;
}

const PARTS = ["limiter", "gate", "lan", "broker", "events"] as const;

/**
 * Read what the previous process of this instance left — an empty memory when there is none or it is unusable.
 *
 * @param dataDir The instance data folder
 * @returns One memory per limiter, or an empty memory
 */
export function loadLimitMemory(dataDir: string): LimitMemory {
  const { value } = readDataFile(dataDir, LIMIT_MEMORY_FILE);
  if (value === undefined) {
    // no file yet, or an unusable one: nothing was counted
    return {};
  }
  const raw = value as Record<string, unknown> | null;
  const memory: LimitMemory = {};
  for (const part of PARTS) {
    memory[part] = readLaneMemory(raw?.[part]);
  }
  return memory;
}

/**
 * Leave the limiters' memory for the next process of this instance. The write itself is synchronous and done when
 * this returns; the promise only hands a write that throws to onUnload's `Promise.allSettled` as a rejection.
 *
 * @param dataDir The instance data folder (created when missing)
 * @param memory One memory per limiter
 * @returns Resolves once the file is written, rejects when the write throws
 */
export function saveLimitMemory(dataDir: string, memory: LimitMemory): Promise<void> {
  return new Promise<void>(resolve => {
    writeDataFile(dataDir, LIMIT_MEMORY_FILE, memory);
    resolve();
  });
}
