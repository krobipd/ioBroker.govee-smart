// What every limiter of the instance carries over a restart: the held slots of each declared window (call-window.ts),
// one file in the instance data folder, written in onUnload and read before the limiters take their first call. A
// restart within a window — the host restarting the instance after a change of its object, the fleet's suite `a restart
// right after the start` — must not hand a counterpart a second window's worth of calls.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { readLaneMemory, type LaneMemory } from "./call-window";

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
  /** The gate of the account broker's publishes (govee-mqtt-client.ts). */
  broker?: LaneMemory;
}

const PARTS = ["limiter", "gate", "lan", "broker"] as const;

/**
 * Read what the previous process of this instance left — an empty memory when there is none or it is unreadable.
 *
 * @param dataDir The instance data folder
 */
export function loadLimitMemory(dataDir: string): LimitMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, LIMIT_MEMORY_FILE), "utf-8")) as Record<string, unknown>;
    const memory: LimitMemory = {};
    for (const part of PARTS) {
      memory[part] = readLaneMemory(raw?.[part]);
    }
    return memory;
  } catch {
    // no file yet, or an unreadable one: nothing was counted
    return {};
  }
}

/**
 * Leave the limiters' memory for the next process of this instance.
 *
 * @param dataDir The instance data folder
 * @param memory One memory per limiter
 */
export async function saveLimitMemory(dataDir: string, memory: LimitMemory): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  await writeFileAtomic(path.join(dataDir, LIMIT_MEMORY_FILE), JSON.stringify(memory));
}
