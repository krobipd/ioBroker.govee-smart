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
import { DeviceRegistry } from "../device-registry";
import { buildCapabilitiesFromAppEntry } from "../device-manager/mapping";

interface TestRig {
  adapter: CloudStateLoaderAdapter;
  writes: Array<{ id: string; val: unknown }>;
  ensured: string[];
  removed: Array<{ prefix: string; stateId: string }>;
  failures: Array<{ deviceId: string; endpoint: string }>;
  onlineApplied: Array<{ device: string; caps: unknown[] }>;
  setDeviceState(fn: (sku: string, deviceId: string) => Promise<CloudStateCapability[]>): void;
}

function makeRig(devices: GoveeDevice[], deviceRegistry = new DeviceRegistry({ data: { devices: {} } })): TestRig {
  const writes: Array<{ id: string; val: unknown }> = [];
  const ensured: string[] = [];
  const removed: Array<{ prefix: string; stateId: string }> = [];
  const failures: Array<{ deviceId: string; endpoint: string }> = [];
  const onlineApplied: Array<{ device: string; caps: unknown[] }> = [];
  const lastWritten = new Map<string, unknown>();
  let getDeviceState: (sku: string, deviceId: string) => Promise<CloudStateCapability[]> = () => Promise.resolve([]);

  const adapter: CloudStateLoaderAdapter = {
    log: mockLog,
    // null = direct execution; the budgeting itself is covered by the
    // rate-limited dispatch test below.
    rateLimiter: null,
    deviceRegistry,
    cloudClient: { getDeviceState: (sku: string, id: string) => getDeviceState(sku, id) } as never,
    deviceManager: {
      getDevices: () => devices,
      // The state read carries Govee's own reachability for the device — the
      // loader hands it straight on, so the stub has to accept it or the whole
      // load throws before any value is written.
      applyCloudStateOnline: (d: GoveeDevice, caps: unknown[]) => onlineApplied.push({ device: d.deviceId, caps }),
      getDiagnostics: () => ({
        recordApiFailure: (deviceId: string, endpoint: string) => failures.push({ deviceId, endpoint }),
      }),
    } as never,
    stateManager: {
      devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}_${d.deviceId.slice(-2)}`,
      // Mirror the real resolveStatePath shape: control unless known sensor id.
      resolveStatePath: (prefix: string, stateId: string) =>
        `${prefix}.${stateId === "battery" ? "sensor" : "control"}.${stateId}`,
      ensureSyntheticStateObject: (_prefix: string, stateId: string) => {
        ensured.push(stateId);
        return Promise.resolve();
      },
      removeSyntheticStateOnce: (prefix: string, stateId: string) => {
        removed.push({ prefix, stateId });
        return Promise.resolve();
      },
    } as never,
    setState: (id, state) => {
      writes.push({ id, val: (state as { val: unknown }).val });
      return Promise.resolve();
    },
    // Models setStateChangedAsync: an unchanged value is not written at all.
    // Without that the rig would hide exactly what this method is chosen for.
    setStateChanged: (id, state) => {
      const val = (state as { val: unknown }).val;
      if (lastWritten.has(id) && Object.is(lastWritten.get(id), val)) {
        return Promise.resolve();
      }
      lastWritten.set(id, val);
      writes.push({ id, val });
      return Promise.resolve();
    },
  };
  return {
    adapter,
    writes,
    ensured,
    removed,
    failures,
    onlineApplied,
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
    const lanLight = createTestDevice({
      deviceId: "AA:01",
      lanIp: "10.0.0.1",
      channels: { lan: true, mqtt: false, cloud: true },
    });
    const rig = makeRig([lanLight]);
    rig.setDeviceState(() => Promise.resolve([powerCap, batteryCap]));
    await loadCloudStates(rig.adapter);
    // power is LAN territory → must NOT be written from the Cloud
    expect(rig.writes.find(w => w.id.endsWith(".control.power"))).toBeUndefined();
    expect(rig.writes.find(w => w.id.endsWith(".sensor.battery"))).toMatchObject({ val: 75 });
  });

  it("writes the LAN-id values for cloud-only devices (no LAN phase to defer to)", async () => {
    const cloudOnly = createTestDevice({
      deviceId: "AA:02",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
    });
    const rig = makeRig([cloudOnly]);
    rig.setDeviceState(() => Promise.resolve([powerCap]));
    await loadCloudStates(rig.adapter);
    expect(rig.writes.find(w => w.id.endsWith(".control.power"))).toMatchObject({ val: true });
  });

  it("does not write Govee's remembered values for a device Govee itself reports offline — only the online evidence", async () => {
    // Measured on krobi's server 2026-09-11 (H70C5 unplugged since 09-03):
    // Govee's state answer carried `online: false` AND `powerSwitch: 1`,
    // `brightness: 100` — its memory of the last contact, not the device's
    // state. The 2.35.0 start wrote them, and an unplugged light showed "on".
    const unplugged = createTestDevice({
      deviceId: "AA:0F",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
    });
    const rig = makeRig([unplugged]);
    const offlineCap: CloudStateCapability = {
      type: "devices.capabilities.online",
      instance: "online",
      state: { value: false },
    };
    rig.setDeviceState(() => Promise.resolve([offlineCap, powerCap, batteryCap]));
    await loadCloudStates(rig.adapter);
    expect(rig.writes).toEqual([]);
    expect(rig.onlineApplied.map(o => o.device)).toEqual(["AA:0F"]);
  });

  it("writes the values when Govee reports the device online in the same answer", async () => {
    const reachable = createTestDevice({
      deviceId: "AA:10",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
    });
    const rig = makeRig([reachable]);
    const onlineCap: CloudStateCapability = {
      type: "devices.capabilities.online",
      instance: "online",
      state: { value: true },
    };
    rig.setDeviceState(() => Promise.resolve([onlineCap, powerCap]));
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
    rig.setDeviceState(() => {
      called++;
      return Promise.resolve([]);
    });
    await loadCloudStates(rig.adapter);
    expect(called).toBe(0);
  });

  it("skips app groups — Govee keeps no state for them and answered every read with `400 devices not exist`", async () => {
    const group = createTestDevice({
      sku: "BaseGroup",
      deviceId: "6781280",
      capabilities: [
        { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
      ],
      channels: { lan: false, mqtt: false, cloud: true },
    });
    const light = createTestDevice({ deviceId: "AA:04", channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([group, light]);
    const asked: string[] = [];
    rig.setDeviceState((sku, id) => {
      asked.push(`${sku}:${id}`);
      return Promise.resolve([]);
    });
    await loadCloudStates(rig.adapter);
    expect(asked).toEqual([`${light.sku}:AA:04`]);
    // Scoped to the group itself (a refresh on it) — still no call.
    await loadCloudStates(rig.adapter, group);
    expect(asked).toEqual([`${light.sku}:AA:04`]);
  });

  it("records a per-device API failure in the diag (C2 audit class) and continues with the next device", async () => {
    const d1 = createTestDevice({ deviceId: "AA:04", channels: { lan: true, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:05", channels: { lan: true, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    let call = 0;
    rig.setDeviceState(() => {
      if (call++ === 0) {
        return Promise.reject(Object.assign(new Error("HTTP 429"), { statusCode: 429 }));
      }
      return Promise.resolve([batteryCap]);
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

  it("dispatches every /device/state call through the RateLimiter at status priority — ahead of the queued scene libraries", async () => {
    const d1 = createTestDevice({ deviceId: "AA:06", channels: { lan: false, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:07", channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    rig.setDeviceState(() => Promise.resolve([batteryCap]));
    const dispatched: number[] = [];
    const lanes: string[] = [];
    const limited = {
      ...rig.adapter,
      rateLimiter: {
        tryExecute: async (fn: () => Promise<void>, lane: { kind: string }, priority: number) => {
          dispatched.push(priority);
          lanes.push(lane.kind);
          await fn();
          return true;
        },
      } as never,
    };
    await loadCloudStates(limited);
    // One budgeted call per device at the limiter's status tier (1). At tier 2
    // — the scene-library tier this used to share — the start-up read sat
    // behind five queued library calls per light and arrived seven minutes
    // after the start on a 12-device installation (measured 2026-09-11).
    expect(dispatched).toEqual([1, 1]);
    expect(lanes).toEqual(["device-read", "device-read"]); // each device's own read bucket (2.39.0)
    expect(rig.writes.filter(w => w.id.endsWith(".sensor.battery"))).toHaveLength(2);
  });

  it("loads only the given device when scoped (per-device refresh_cloud button, Pattern 55)", async () => {
    const d1 = createTestDevice({ deviceId: "AA:08", channels: { lan: false, mqtt: false, cloud: true } });
    const d2 = createTestDevice({ deviceId: "AA:09", channels: { lan: false, mqtt: false, cloud: true } });
    const rig = makeRig([d1, d2]);
    let calls = 0;
    rig.setDeviceState(() => {
      calls++;
      return Promise.resolve([batteryCap]);
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

  // Audit 2026-09-12 (F6): this path runs on every App-API poll (every 2 min)
  // and every cloud event, and it re-sent the same reading each time — 720
  // writes a day per value, each bumping `ts`, firing every subscription and
  // landing in a history adapter set to "all values".
  it("writes a repeated reading only once — unchanged values are suppressed", async () => {
    const sensor = createTestDevice({
      deviceId: "AA:07",
      type: "devices.types.thermometer",
      lanIp: undefined,
    });
    const rig = makeRig([sensor]);
    await applyCloudCapabilities(rig.adapter, sensor, [batteryCap]);
    await applyCloudCapabilities(rig.adapter, sensor, [batteryCap]);
    await applyCloudCapabilities(rig.adapter, sensor, [batteryCap]);
    expect(rig.writes.filter(w => w.id.endsWith(".sensor.battery"))).toHaveLength(1);

    // …and a real change still gets through.
    await applyCloudCapabilities(rig.adapter, sensor, [
      { type: "devices.capabilities.property", instance: "battery", state: { value: 60 } },
    ]);
    expect(rig.writes.filter(w => w.id.endsWith(".sensor.battery")).map(w => w.val)).toEqual([75, 60]);
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

  it("removes the phantom humidity orphan for a temp-only thermometer (temperature but no humidity cap) — #31", async () => {
    const tempOnly = createTestDevice({
      deviceId: "AA:09",
      type: "devices.types.thermometer",
      lanIp: undefined,
      capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature" }],
    });
    const rig = makeRig([tempOnly]);
    await applyCloudCapabilities(rig.adapter, tempOnly, [tempCap]);
    expect(rig.removed).toContainEqual(expect.objectContaining({ stateId: "humidity" }));
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

describe("a model whose platform API reports °F (catalog quirk platformTempUnit, audit M18)", () => {
  // Govee's own example answer carries `sensorTemperature: 79.52` (get-devices-status,
  // H5140); homebridge-govee: "in whatever unit the Govee app is set to". The model
  // list is govee2mqtt's (quirks.rs, with_platform_temperature_sensor_units).
  const heater = (): GoveeDevice =>
    createTestDevice({
      sku: "H7131",
      deviceId: "AA:BB:CC:DD:EE:FF:71:31",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
      capabilities: [{ type: "devices.capabilities.property", instance: "sensorTemperature", parameters: {} }] as never,
    });
  const catalog = (experimental: boolean): DeviceRegistry =>
    new DeviceRegistry({
      data: {
        devices: { H7131: { name: "Heater", type: "heater", status: "seed", quirks: { platformTempUnit: "F" } } },
      },
      experimental,
    });
  const reading: CloudStateCapability = {
    type: "devices.capabilities.property",
    instance: "sensorTemperature",
    state: { value: 79.52 },
  };

  it("converts the /device/state reading to °C with one decimal — only the temperature", async () => {
    const rig = makeRig([heater()], catalog(true));
    rig.setDeviceState(() =>
      Promise.resolve([
        reading,
        { type: "devices.capabilities.property", instance: "sensorHumidity", state: { value: 40 } },
      ]),
    );
    await loadCloudStates(rig.adapter);
    expect(rig.writes.find(w => w.id.endsWith(".temperature"))?.val).toBe(26.4);
    expect(rig.writes.find(w => w.id.endsWith(".humidity"))?.val).toBe(40);
  });

  it("an empty reading stays empty — nothing is converted into a number", async () => {
    const rig = makeRig([heater()], catalog(true));
    rig.setDeviceState(() => Promise.resolve([{ ...reading, state: { value: "" } }]));
    await loadCloudStates(rig.adapter);
    expect(rig.writes.find(w => w.id.endsWith(".temperature"))).toBeUndefined();
  });

  it("a seed entry stays dormant without the experimental switch — the reading passes unchanged", async () => {
    const rig = makeRig([heater()], catalog(false));
    rig.setDeviceState(() => Promise.resolve([reading]));
    await loadCloudStates(rig.adapter);
    expect(rig.writes.find(w => w.id.endsWith(".temperature"))?.val).toBe(79.52);
  });

  it("the account-list path is never converted — its reading is hundredths of °C whatever the app shows (#18)", async () => {
    const rig = makeRig([heater()], catalog(true));
    await applyCloudCapabilities(rig.adapter, heater(), [{ ...reading, state: { value: 21.5 } }]);
    expect(rig.writes.find(w => w.id.endsWith(".temperature"))?.val).toBe(21.5);
  });
});

describe("an account-list reading carries its own measurement time (audit D9)", () => {
  // Issue #18 (v2.15.0 export, 2026-06-08): the H5074's list entry reported
  // tem 2120 / hum 4860 with lastTime 1770838320000 — four months old, written
  // as if measured right now.
  const h5074 = (): GoveeDevice =>
    createTestDevice({
      sku: "H5074",
      deviceId: "AA:BB:CC:DD:EE:FF:17:E5",
      type: "devices.types.thermometer",
      lanIp: undefined,
      channels: { lan: false, mqtt: false, cloud: true },
      capabilities: [],
    });
  const entry = {
    sku: "H5074",
    device: "AA:BB:CC:DD:EE:FF:17:E5",
    deviceName: "Thermo-Hygrometer",
    lastData: { online: false, tem: 2120, hum: 4860, lastTime: 1770838320000 },
  };

  function tsRig(): { rig: TestRig; stamps: Array<{ id: string; ts?: number }> } {
    const rig = makeRig([h5074()]);
    const stamps: Array<{ id: string; ts?: number }> = [];
    const plain = rig.adapter.setState.bind(rig.adapter);
    (rig.adapter as { setState: unknown }).setState = (id: string, state: ioBroker.SettableState) => {
      stamps.push({ id, ts: state.ts });
      return plain(id, state);
    };
    return { rig, stamps };
  }

  it("writes temperature and humidity with ts = lastTime", async () => {
    const { rig, stamps } = tsRig();
    const caps = buildCapabilitiesFromAppEntry(entry, 1780950000000);
    await applyCloudCapabilities(rig.adapter, h5074(), caps);
    expect(stamps.filter(s => /\.(temperature|humidity)$/.test(s.id)).map(s => s.ts)).toEqual([
      1770838320000, 1770838320000,
    ]);
  });

  it("the same measurement polled again is not written again; a newer one is, even with the same value", async () => {
    const { rig, stamps } = tsRig();
    const dev = h5074();
    await applyCloudCapabilities(rig.adapter, dev, buildCapabilitiesFromAppEntry(entry, 1780950000000));
    const first = stamps.length;
    await applyCloudCapabilities(rig.adapter, dev, buildCapabilitiesFromAppEntry(entry, 1780950120000));
    expect(stamps.length).toBe(first);
    const newer = { ...entry, lastData: { ...entry.lastData, lastTime: 1780950100000 } };
    await applyCloudCapabilities(rig.adapter, dev, buildCapabilitiesFromAppEntry(newer, 1780950120000));
    expect(
      stamps
        .slice(first)
        .filter(s => s.id.endsWith(".temperature"))
        .map(s => s.ts),
    ).toEqual([1780950100000]);
  });

  it("a measurement time in the future is no measurement time — written without one", () => {
    const future = { ...entry, lastData: { ...entry.lastData, lastTime: 1780950000000 + 3_600_000 } };
    const caps = buildCapabilitiesFromAppEntry(future, 1780950000000);
    expect(caps.filter(c => c.ts !== undefined)).toEqual([]);
  });
});
