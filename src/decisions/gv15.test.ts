// GV-15 — A command is repeated only when that is quick (at most 10–15 seconds) and Govee never received it. The API is not
// hammered. A call that never reached Govee costs no budget.
// krobi 2026-10-01 09:54: "repeating the command is only ok if we do it quickly, anything beyond 10-15 seconds is too slow
// and should not be repeated"; 09:57: "in full consequence! we cannot hammer the api with pointless requests. LIMITS!!!!";
// 10:00: "so the adapter counter has a bug"; 2026-10-07 20:27: "only ok when it costs no extra api call and when quick,
// otherwise rubbish"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// command-router pulls i18n → @iobroker/adapter-core, whose import-time controller lookup exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { currentBooking } from "../lib/call-booking";
import { CommandRouter } from "../lib/command-router";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceManager } from "../lib/device-manager";
import { DeviceRegistry } from "../lib/device-registry";
import { CloudControlRejected } from "../lib/govee-cloud-client";
import { RateLimiter } from "../lib/rate-limiter";
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
  // A pause lets the clock run, so the 10-second window is real.
  delay: (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    return Promise.resolve();
  },
} as never;

function cloudLight(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:15",
    name: "Strip",
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

/**
 * Govee's refusal "Device is offline" — Govee received the call. Built with the offline flag the 3.1.x client set, so the
 * guard also catches the held-command path of that version.
 */
function offlineRefusal(): Error {
  return Reflect.construct(CloudControlRejected, [
    "Cloud control rejected for H6199/x/powerSwitch: code=400 — Device is offline.",
    true,
  ]) as Error;
}

/** A name lookup that failed before any socket connected — what the HTTP client reports for a call Govee never saw. */
function neverSent(): Error {
  currentBooking()?.attempt(false);
  return Object.assign(new Error("getaddrinfo ENOTFOUND openapi.api.govee.com"), {
    code: "ENOTFOUND",
    neverSent: true,
  });
}

function router(controlDevice: () => Promise<unknown>): { router: CommandRouter; limiter: RateLimiter } {
  const r = new CommandRouter(log, timers, new DeviceRegistry({ data: { devices: {} } }));
  r.setCloudClient({ controlDevice } as never);
  const limiter = new RateLimiter(log, timers);
  r.setRateLimiter(limiter);
  return { router: r, limiter };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GV-15 repeat only quickly, only what Govee never got, never at the budget's cost", () => {
  it("a command that never reached Govee is sent again quickly and goes out (positive control)", async () => {
    let calls = 0;
    const { router: r } = router(() => {
      calls++;
      return calls < 3 ? Promise.reject(neverSent()) : Promise.resolve({ code: 200 });
    });
    await r.sendCommand(cloudLight(), "power", true);
    expect(calls).toBe(3);
  });

  it("no further attempt once 10 seconds have passed since the first", async () => {
    let calls = 0;
    const { router: r } = router(() => {
      calls++;
      vi.setSystemTime(Date.now() + 9_500); // the failing name lookup itself took 9.5 s
      return Promise.reject(neverSent());
    });
    await expect(r.sendCommand(cloudLight(), "power", true)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("a command Govee received is never sent again — a 'device offline' refusal included", async () => {
    let calls = 0;
    const { router: r } = router(() => {
      calls++;
      return Promise.reject(offlineRefusal());
    });
    await expect(r.sendCommand(cloudLight(), "power", true)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("after a 'device offline' refusal the device's next sign of life sends nothing — no extra call minutes later", async () => {
    let calls = 0;
    const dm = new DeviceManager(log, timers, new DeviceRegistry({ data: { devices: {} } }), new DeviceIdRegistry());
    dm.setCloudClient({
      controlDevice: () => {
        calls++;
        return Promise.reject(offlineRefusal());
      },
    } as never);
    const light = cloudLight();
    (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("H6199_15", light);
    await expect(dm.sendCommand(light, "power", true)).rejects.toThrow();
    // The device's own status push, then Govee's state read saying "online" — both signs of life.
    dm.handleMqttStatus({
      sku: "H6199",
      device: light.deviceId,
      cmd: "status",
      transaction: `x_${Date.now()}008`,
      state: { onOff: 0 },
    });
    dm.applyCloudStateOnline(light, [
      { type: "devices.capabilities.online", instance: "online", state: { value: true } },
    ]);
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(calls).toBe(1);
  });

  it("a connection reset may have reached Govee — it is not sent again either", async () => {
    let calls = 0;
    const { router: r } = router(() => {
      calls++;
      return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    });
    await expect(r.sendCommand(cloudLight(), "power", true)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("calls that never reached Govee are given back to the budget; one that did is counted", async () => {
    const { router: r, limiter } = router(() => Promise.reject(neverSent()));
    await expect(r.sendCommand(cloudLight(), "power", true)).rejects.toThrow();
    expect(limiter.getUsageSnapshot().usedToday).toBe(0);
    expect(limiter.getUsageSnapshot().notDeliveredToday).toBeGreaterThan(0);

    const { router: r2, limiter: l2 } = router(() => {
      currentBooking()?.attempt(true);
      return Promise.resolve({ code: 200 });
    });
    await r2.sendCommand(cloudLight(), "power", true);
    expect(l2.getUsageSnapshot().usedToday).toBe(1);
  });
});
