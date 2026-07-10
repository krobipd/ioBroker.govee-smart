import { vi } from "vitest";

// cloud-state-loader pulls capability-mapper → i18n → @iobroker/adapter-core,
// whose import-time controller lookup process.exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { applyCloudCapabilities, loadCloudStates, type CloudStateLoaderAdapter } from "./cloud-state-loader";
import type { CloudStateCapability, GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../test-helpers";

interface TestRig {
  adapter: CloudStateLoaderAdapter;
  writes: Array<{ id: string; val: unknown }>;
  ensured: string[];
  removed: Array<{ prefix: string; stateId: string }>;
  failures: Array<{ deviceId: string; endpoint: string }>;
  setDeviceState(fn: (sku: string, deviceId: string) => Promise<CloudStateCapability[]>): void;
}

function makeRig(devices: GoveeDevice[]): TestRig {
  const writes: Array<{ id: string; val: unknown }> = [];
  const ensured: string[] = [];
  const removed: Array<{ prefix: string; stateId: string }> = [];
  const failures: Array<{ deviceId: string; endpoint: string }> = [];
  let getDeviceState: (sku: string, deviceId: string) => Promise<CloudStateCapability[]> = async () => [];

  const adapter: CloudStateLoaderAdapter = {
    log: mockLog,
    // null = direct execution; the budgeting itself is covered by the
    // rate-limited dispatch test below.
    rateLimiter: null,
    cloudClient: { getDeviceState: (sku: string, id: string) => getDeviceState(sku, id) } as never,
    deviceManager: {
      getDevices: () => devices,
      getDiagnostics: () => ({
        recordApiFailure: (deviceId: string, endpoint: string) => failures.push({ deviceId, endpoint }),
      }),
    } as never,
    stateManager: {
      devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}_${d.deviceId.slice(-2)}`,
      // Mirror the real resolveStatePath shape: control unless known sensor id.
      resolveStatePath: (prefix: string, stateId: string) =>
        `${prefix}.${stateId === "battery" ? "sensor" : "control"}.${stateId}`,
      ensureSyntheticStateObject: async (_prefix: string, stateId: string) => {
        ensured.push(stateId);
      },
      removeSyntheticStateOnce: async (prefix: string, stateId: string) => {
        removed.push({ prefix, stateId });
      },
    } as never,
    setState: async (id, state) => {
      writes.push({ id, val: (state as { val: unknown }).val });
    },
  };
  return {
    adapter,
    writes,
    ensured,
    removed,
    failures,
    setDeviceState: fn => {
      getDeviceState = fn;
    },
  };
}

const powerCap: CloudStateCapability = {
  type: "devices.capabilities.on_off",
  instance: "powerSwitch",
  state: { value: 1 },
};
const batteryCap: CloudStateCapability = {
  type: "devices.capabilities.property",
  instance: "battery",
  state: { value: 75 },
};

describe("loadCloudStates", () => {
  it("writes mapped values for cloud devices, filtering LAN-owned ids on LAN-capable lights (LAN-first invariant)", async () => {
    const lanLight = createTestDevice({ deviceId: "AA:01", lanIp: "10.0.0.1", channels: { lan: true, mqtt: false, cloud: true } });
    const rig = makeRig([lanLight]);
    rig.setDeviceState(async () => [powerCap, batteryCap]);
    await loadCloudStates(rig.adapter);
    // power is LAN territory → must NOT be written from the Cloud
    expect(rig.writes.find(w => w.id.endsWith(".control.power"))).toBeUndefined();
    expect(rig.writes.find(w => w.id.endsWith(".sensor.battery"))).toMatchObject({ val: 75 });
  });

  it("writes the LAN-id values for cloud-only devices (no LAN phase to defer to)", async () => {
    const cloudOnly = createTestDevice({ deviceId: "AA:02", lanIp: undefined, channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([cloudOnly]);
    rig.setDeviceState(async () => [powerCap]);
    await loadCloudStates(rig.adapter);
    expect(rig.writes.find(w => w.id.endsWith(".control.power"))).toMatchObject({ val: true });
  });

  it("skips devices without cloud channel or capabilities (no wasted API calls)", async () => {
    const lanOnly = createTestDevice({
      deviceId: "AA:03",
      capabilities: [],
      channels: { lan: true, mqtt: false, cloud: false },
    });
    const rig = makeRig([lanOnly]);
    let called = 0;
    rig.setDeviceState(async () => {
      called++;
      return [];
    });
    await loadCloudStates(rig.adapter);
    expect(called).toBe(0);
  });

  it("records a per-device API failure in the diag (C2 audit class) and continues with the next device", async () => {
    const d1 = createTestDevice({ deviceId: "AA:04", channels: { lan: true, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:05", channels: { lan: true, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    let call = 0;
    rig.setDeviceState(async () => {
      if (call++ === 0) {
        throw Object.assign(new Error("HTTP 429"), { statusCode: 429 });
      }
      return [batteryCap];
    });
    await loadCloudStates(rig.adapter);
    expect(rig.failures).toEqual([{ deviceId: "AA:04", endpoint: "/router/api/v1/device/state" }]);
    expect(rig.writes.some(w => w.id.includes("aa:05".slice(-2)))).toBe(true);
  });

  it("is a safe no-op while clients/managers are not wired (boot race)", async () => {
    const rig = makeRig([]);
    (rig.adapter as { cloudClient: unknown }).cloudClient = null;
    await expect(loadCloudStates(rig.adapter)).resolves.toBeUndefined();
  });

  it("dispatches every /device/state call through the RateLimiter at background priority (M2)", async () => {
    const d1 = createTestDevice({ deviceId: "AA:06", channels: { lan: false, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:07", channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    rig.setDeviceState(async () => [batteryCap]);
    const dispatched: number[] = [];
    const limited = {
      ...rig.adapter,
      rateLimiter: {
        tryExecute: async (fn: () => Promise<void>, priority: number) => {
          dispatched.push(priority);
          await fn();
          return true;
        },
      } as never,
    };
    await loadCloudStates(limited);
    // one budgeted call per device, background priority (2) like scene loads
    expect(dispatched).toEqual([2, 2]);
    expect(rig.writes.filter(w => w.id.endsWith(".sensor.battery"))).toHaveLength(2);
  });

  it("loads only the given device when scoped (per-device refresh_cloud button, Pattern 55)", async () => {
    const d1 = createTestDevice({ deviceId: "AA:08", channels: { lan: false, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:09", channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    let calls = 0;
    rig.setDeviceState(async () => {
      calls++;
      return [batteryCap];
    });
    await loadCloudStates(rig.adapter, d2);
    expect(calls).toBe(1);
    expect(rig.writes.filter(w => w.id.endsWith(".sensor.battery"))).toHaveLength(1);
  });
});

describe("applyCloudCapabilities (App-API / OpenAPI-MQTT pipe)", () => {
  it("ensures the synthetic state object BEFORE writing and mirrors the value into device.state (diag honesty)", async () => {
    const sensor = createTestDevice({
      deviceId: "AA:06",
      type: "devices.types.thermometer",
      lanIp: undefined,
    });
    const rig = makeRig([sensor]);
    await applyCloudCapabilities(rig.adapter, sensor, [batteryCap]);
    expect(rig.ensured).toEqual(["battery"]);
    expect(rig.writes.find(w => w.id.endsWith(".sensor.battery"))).toMatchObject({ val: 75 });
    // v2.9.1 — diag `state` field must reflect non-Light runtime values
    expect((sensor.state as Record<string, unknown>).battery).toBe(75);
  });

  it("LAN-capable device: LAN-owned ids are shadowed, others still flow", async () => {
    const lanLight = createTestDevice({ deviceId: "AA:07", lanIp: "10.0.0.7" });
    const rig = makeRig([lanLight]);
    await applyCloudCapabilities(rig.adapter, lanLight, [powerCap, batteryCap]);
    expect(rig.writes.find(w => w.id.endsWith(".control.power"))).toBeUndefined();
    expect(rig.writes.find(w => w.id.endsWith(".sensor.battery"))).toBeDefined();
  });

  it("is a safe no-op without a state manager (teardown race)", async () => {
    const sensor = createTestDevice({ deviceId: "AA:08" });
    const rig = makeRig([sensor]);
    (rig.adapter as { stateManager: unknown }).stateManager = null;
    await expect(applyCloudCapabilities(rig.adapter, sensor, [batteryCap])).resolves.toBeUndefined();
  });

  const tempCap: CloudStateCapability = {
    type: "devices.capabilities.property",
    instance: "sensorTemperature",
    state: { value: 21.5 },
  };

  it("removes the phantom sensor_humidity orphan for a temp-only thermometer (temperature but no humidity cap) — #31", async () => {
    const tempOnly = createTestDevice({
      deviceId: "AA:09",
      type: "devices.types.thermometer",
      lanIp: undefined,
      capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature" }],
    });
    const rig = makeRig([tempOnly]);
    await applyCloudCapabilities(rig.adapter, tempOnly, [tempCap]);
    expect(rig.removed).toContainEqual(expect.objectContaining({ stateId: "sensor_humidity" }));
  });

  it("does NOT remove humidity for a real thermo-hygrometer (declares sensorHumidity)", async () => {
    const hygrometer = createTestDevice({
      deviceId: "AA:0A",
      type: "devices.types.thermometer",
      lanIp: undefined,
      capabilities: [
        { type: "devices.capabilities.property", instance: "sensorTemperature" },
        { type: "devices.capabilities.property", instance: "sensorHumidity" },
      ],
    });
    const rig = makeRig([hygrometer]);
    await applyCloudCapabilities(rig.adapter, hygrometer, [tempCap]);
    expect(rig.removed).toHaveLength(0);
  });

  it("does NOT touch humidity for a device without a temperature sensor (e.g. an appliance)", async () => {
    const appliance = createTestDevice({
      deviceId: "AA:0B",
      type: "devices.types.heater",
      lanIp: undefined,
      capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
    });
    const rig = makeRig([appliance]);
    await applyCloudCapabilities(rig.adapter, appliance, [powerCap]);
    expect(rig.removed).toHaveLength(0);
  });
});
