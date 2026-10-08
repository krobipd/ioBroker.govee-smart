// GV-08 (govee part) — Rate limiting follows Govee's v2 documentation per actor: own pots for the device list, per device for
// reads and commands, the App interface separate. A command to device B never waits for device A.
// krobi 2026-09-22 10:13 chose "actor buckets after the v2 docs"; 2026-10-07 10:12: "one device must never block another"
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../lib/rate-limiter";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};
const timers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  clearTimeout: () => undefined,
  setTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

const call = (): Promise<void> => Promise.resolve();

/**
 * Spend calls on one lane until the limiter stops running them at once; the number it ran.
 *
 * @param limiter the limiter under test
 * @param lane the lane to spend calls on
 */
async function drain(limiter: RateLimiter, lane: Parameters<RateLimiter["tryExecute"]>[1]): Promise<number> {
  let ran = 0;
  for (let i = 0; i < 200; i++) {
    if (!(await limiter.tryExecute(call, lane))) {
      return ran;
    }
    ran++;
  }
  return ran;
}

describe("GV-08 one pot per actor", () => {
  it("device A's spent command pot holds A — and device B's command still goes out at once", async () => {
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    const ranForA = await drain(limiter, { kind: "device-control", deviceKey: "A" });
    expect(ranForA).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, { kind: "device-control", deviceKey: "A" })).toBe(false);
    expect(await limiter.tryExecute(call, { kind: "device-control", deviceKey: "B" })).toBe(true);
  });

  it("device A's spent read pot holds A — and device B's state read still goes out at once", async () => {
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    const ranForA = await drain(limiter, { kind: "device-read", deviceKey: "A" });
    expect(ranForA).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, { kind: "device-read", deviceKey: "B" })).toBe(true);
  });

  it("a spent device list and App interface hold neither device's command", async () => {
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    expect(await drain(limiter, { kind: "account-list" })).toBeGreaterThan(0);
    expect(await drain(limiter, { kind: "appapi" })).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, { kind: "device-control", deviceKey: "A" })).toBe(true);
    expect(await limiter.tryExecute(call, { kind: "device-read", deviceKey: "B" })).toBe(true);
  });
});
