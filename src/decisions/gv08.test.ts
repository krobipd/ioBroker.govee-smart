// GV-08 (govee part) — Rate limiting follows Govee's v2 documentation per actor: own pots for the device list, per device for
// reads and commands, the App interface separate. A command to device B never waits for device A.
// krobi 2026-09-22 10:13 chose "actor buckets after the v2 docs"; 2026-10-07 10:12: "one device must never block another"
import { describe, expect, it, vi } from "vitest";

// device-manager pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { CommandRouter } from "../lib/command-router";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import { RateLimiter, type CallLane } from "../lib/rate-limiter";
import type { GoveeDevice } from "../lib/types";

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

function light(deviceId: string): GoveeDevice {
  return {
    sku: "H6199",
    deviceId,
    name: deviceId,
    type: "devices.types.light",
    capabilities: [
      {
        type: "devices.capabilities.on_off",
        instance: "powerSwitch",
        parameters: {
          dataType: "ENUM",
          options: [
            { name: "on", value: 1 },
            { name: "off", value: 0 },
          ],
        },
      },
    ],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: true },
  };
}

const A = light("AA:BB:CC:DD:EE:FF:00:0A");
const B = light("AA:BB:CC:DD:EE:FF:00:0B");

/** A limiter that records the lane of every call the adapter books. */
function recording(): { limiter: RateLimiter; lanes: CallLane[] } {
  const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
  const lanes: CallLane[] = [];
  const tracked = limiter.executeTracked.bind(limiter);
  limiter.executeTracked = (fn, lane, ...rest) => {
    if (lane) {
      lanes.push(lane);
    }
    return tracked(fn, lane, ...rest);
  };
  const tried = limiter.tryExecute.bind(limiter);
  limiter.tryExecute = (fn, lane, ...rest) => {
    if (lane) {
      lanes.push(lane);
    }
    return tried(fn, lane, ...rest);
  };
  return { limiter, lanes };
}

/** The lanes the real callers book: a command to A and to B (the router), a state read of A (the device manager). */
async function realLanes(): Promise<{ commandA: CallLane; commandB: CallLane; readA: CallLane }> {
  const router = new CommandRouter(log, timers, new DeviceRegistry({ data: { devices: {} } }));
  router.setCloudClient({ controlDevice: () => Promise.resolve({ code: 200 }) } as never);
  const commands = recording();
  router.setRateLimiter(commands.limiter);
  await router.sendCommand(A, "power", true);
  await router.sendCommand(B, "power", true);

  const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
  dm.setCloudClient({ getDeviceState: () => Promise.resolve([]) } as never);
  const reads = recording();
  dm.setRateLimiter(reads.limiter);
  (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("A", { ...A, state: { online: true } });
  await dm.refreshExpiringReachability();
  const readA = reads.lanes.find(l => l.kind === "device-read");
  expect(commands.lanes).toHaveLength(2);
  expect(readA).toBeDefined();
  const [commandA, commandB] = commands.lanes as [CallLane, CallLane];
  return { commandA, commandB, readA: readA! };
}

/**
 * Spend calls on one lane until the limiter stops running them at once; the number it ran.
 *
 * @param limiter the limiter under test
 * @param lane the lane to spend calls on
 */
async function drain(limiter: RateLimiter, lane: CallLane): Promise<number> {
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
  it("device A's spent command pot holds A — and a command to device B, booked by the router, still goes out at once", async () => {
    const { commandA, commandB } = await realLanes();
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    expect(await drain(limiter, commandA)).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, commandA)).toBe(false);
    expect(await limiter.tryExecute(call, commandB)).toBe(true);
  });

  it("device A's state read has a pot of its own — a spent command pot of A holds no query of A", async () => {
    const { commandA, readA } = await realLanes();
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    expect(await drain(limiter, commandA)).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, readA)).toBe(true);
  });

  it("device A's spent read pot holds A — and device B's state read still goes out at once", async () => {
    const { readA } = await realLanes();
    const readB: CallLane = { ...readA, deviceKey: `${B.sku}:${B.deviceId}` } as CallLane;
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    expect(await drain(limiter, readA)).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, readA)).toBe(false);
    expect(await limiter.tryExecute(call, readB)).toBe(true);
  });

  it("a spent device list and App interface hold neither device's command nor its query", async () => {
    const { commandA, readA } = await realLanes();
    const limiter = new RateLimiter(log, timers, undefined, () => 1_000_000);
    expect(await drain(limiter, { kind: "account-list" })).toBeGreaterThan(0);
    expect(await drain(limiter, { kind: "appapi" })).toBeGreaterThan(0);
    expect(await limiter.tryExecute(call, commandA)).toBe(true);
    expect(await limiter.tryExecute(call, readA)).toBe(true);
  });
});
