import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const enJson = JSON.parse(readFileSync(join(__dirname, "../../../admin/i18n/en.json"), "utf8")) as Record<
    string,
    string
  >;
  return {
    I18n: {
      getTranslatedObject: vi.fn((key: string) => ({ en: key })),
      translate: vi.fn((key: string) => enJson[key] ?? key),
    },
  };
});

import {
  applyWizardResult,
  buildWizardHost,
  deviceKeyFor,
  findDeviceByKey,
  runWizardStep,
  type WizardHandlerAdapter,
} from "./wizard-handler";
import type { GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../test-helpers";

function makeAdapter(devices: GoveeDevice[]): {
  adapter: WizardHandlerAdapter;
  applied: Array<{ device: GoveeDevice; mode: boolean; indices?: number[] }>;
} {
  const applied: Array<{ device: GoveeDevice; mode: boolean; indices?: number[] }> = [];
  const adapter: WizardHandlerAdapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    lanClient: null,
    deviceManager: { getDevices: () => devices, sendCommand: () => Promise.resolve(undefined) } as never,
    stateManager: { devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}` } as never,
    segmentWizard: null,
    getStateAsync: () => Promise.resolve(null),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    applyManualSegments: (device, mode, indices) => {
      applied.push({ device, mode, indices });
      return Promise.resolve();
    },
  };
  return { adapter, applied };
}

describe("deviceKeyFor / findDeviceByKey", () => {
  it("round-trips: the key handed to the admin UI resolves back to the live device", () => {
    const d1 = createTestDevice({ deviceId: "AA:01" });
    const d2 = createTestDevice({ deviceId: "AA:02" });
    const { adapter } = makeAdapter([d1, d2]);
    expect(findDeviceByKey(adapter, deviceKeyFor(d2))).toBe(d2);
  });

  it("returns undefined for a stale key (device removed mid-session)", () => {
    const { adapter } = makeAdapter([]);
    expect(findDeviceByKey(adapter, "H6160:GO:NE")).toBeUndefined();
  });
});

describe("applyWizardResult", () => {
  it("contiguous result: sets segmentCount and disables manual mode", async () => {
    const device = createTestDevice({ segmentCount: 5 });
    const { adapter, applied } = makeAdapter([device]);
    await applyWizardResult(adapter, device, { segmentCount: 20, manualList: "", hasGaps: false });
    expect(device.segmentCount).toBe(20);
    expect(applied).toEqual([{ device, mode: false, indices: undefined }]);
  });

  it("gapped result: enables manual mode with the parsed physical indices", async () => {
    const device = createTestDevice({ segmentCount: 5 });
    const { adapter, applied } = makeAdapter([device]);
    await applyWizardResult(adapter, device, { segmentCount: 5, manualList: "0-1,3-4", hasGaps: true });
    expect(applied).toEqual([{ device, mode: true, indices: [0, 1, 3, 4] }]);
  });

  it("an implausible count is ignored — it never becomes the device's count", async () => {
    const device = createTestDevice({ segmentCount: 5 });
    const { adapter, applied } = makeAdapter([device]);
    await applyWizardResult(adapter, device, { segmentCount: 1_000_000_000, manualList: "", hasGaps: false });
    expect(device.segmentCount).toBe(5);
    expect(applied).toEqual([]);
  });

  it("unparseable manualList still enables manual mode but without indices (no crash, no stale list)", async () => {
    const device = createTestDevice({ segmentCount: 5 });
    const { adapter, applied } = makeAdapter([device]);
    await applyWizardResult(adapter, device, { segmentCount: 5, manualList: "not-a-list", hasGaps: true });
    expect(applied).toEqual([{ device, mode: true, indices: undefined }]);
  });
});

describe("runWizardStep", () => {
  it("lazily instantiates ONE wizard and returns its response verbatim", async () => {
    const device = createTestDevice();
    const { adapter } = makeAdapter([device]);
    expect(adapter.segmentWizard).toBeNull();
    // Unknown action — routes through the real SegmentWizard error path.
    const response = await runWizardStep(adapter, "bogus", deviceKeyFor(device));
    expect(adapter.segmentWizard).not.toBeNull();
    expect(typeof response.error).toBe("string");

    const first = adapter.segmentWizard;
    await runWizardStep(adapter, "bogus", deviceKeyFor(device));
    expect(adapter.segmentWizard).toBe(first); // no second instance
  });
});

describe("buildWizardHost — atomic LAN closures", () => {
  function makeLanRig(devices: GoveeDevice[]): {
    adapter: WizardHandlerAdapter;
    flashes: Array<{ ip: string; idx: number }>;
    restores: Array<{ ip: string; total: number; r: number; g: number; b: number; brightness: number }>;
  } {
    const { adapter } = makeAdapter(devices);
    const flashes: Array<{ ip: string; idx: number }> = [];
    const restores: Array<{ ip: string; total: number; r: number; g: number; b: number; brightness: number }> = [];
    (adapter as { lanClient: unknown }).lanClient = {
      flashSingleSegment: (ip: string, idx: number) => flashes.push({ ip, idx }),
      restoreAllSegments: (ip: string, total: number, r: number, g: number, b: number, brightness: number) =>
        restores.push({ ip, total, r, g, b, brightness }),
    };
    return { adapter, flashes, restores };
  }

  it("flashSegmentAtomic uses the LAN fast-path when the device has an IP, reports true", async () => {
    const device = createTestDevice({ lanIp: "10.0.0.5" });
    const { adapter, flashes } = makeLanRig([device]);
    const host = buildWizardHost(adapter);
    expect(await host.flashSegmentAtomic(device, 7)).toBe(true);
    expect(flashes).toEqual([{ ip: "10.0.0.5", idx: 7 }]);
  });

  it("flashSegmentAtomic reports false for cloud-only devices so the wizard falls back to segmentBatch", async () => {
    const device = createTestDevice({ lanIp: undefined });
    const { adapter, flashes } = makeLanRig([device]);
    const host = buildWizardHost(adapter);
    expect(await host.flashSegmentAtomic(device, 1)).toBe(false);
    expect(flashes).toHaveLength(0);
  });

  it("restoreStripAtomic decomposes the packed color into RGB channels", async () => {
    const device = createTestDevice({ lanIp: "10.0.0.5" });
    const { adapter, restores } = makeLanRig([device]);
    const host = buildWizardHost(adapter);
    expect(await host.restoreStripAtomic(device, 12, 0xff8040, 75)).toBe(true);
    expect(restores).toEqual([{ ip: "10.0.0.5", total: 12, r: 255, g: 128, b: 64, brightness: 75 }]);
  });

  it("restoreStripAtomic reports false without a LAN client (wizard must not assume success)", async () => {
    const device = createTestDevice({ lanIp: "10.0.0.5" });
    const { adapter } = makeAdapter([device]); // lanClient: null
    const host = buildWizardHost(adapter);
    expect(await host.restoreStripAtomic(device, 12, 0xffffff, 100)).toBe(false);
  });
});

describe("buildWizardHost — passthrough closures (the adapter ↔ wizard wiring)", () => {
  it("every host method reaches the adapter part it stands for", async () => {
    const device = createTestDevice({ deviceId: "AA:07", lanIp: "10.0.0.7" });
    const { adapter, applied } = makeAdapter([device]);
    const sent: Array<{ id: string; command: string; value: unknown }> = [];
    const timers: Array<{ ms: number }> = [];
    const cleared: unknown[] = [];
    (adapter as { deviceManager: unknown }).deviceManager = {
      getDevices: () => [device],
      sendCommand: (d: GoveeDevice, command: string, value: unknown) => {
        sent.push({ id: d.deviceId, command, value });
        return Promise.resolve();
      },
    };
    (adapter as { getStateAsync: unknown }).getStateAsync = (id: string) =>
      Promise.resolve(id.endsWith(".control.power") ? ({ val: true, ack: true } as ioBroker.State) : null);
    (adapter as { setTimeout: unknown }).setTimeout = (_cb: () => void, ms: number) => {
      timers.push({ ms });
      return { handle: timers.length } as never;
    };
    (adapter as { clearTimeout: unknown }).clearTimeout = (h: unknown) => cleared.push(h);
    const host = buildWizardHost(adapter);

    expect(await host.getState("govee-smart.0.devices.h6160.control.power")).toEqual({ val: true, ack: true });
    expect(await host.getState("govee-smart.0.devices.h6160.control.brightness")).toBeNull();
    await host.sendCommand(device, "power", true);
    expect(sent).toEqual([{ id: "AA:07", command: "power", value: true }]);
    expect(host.findDevice(deviceKeyFor(device))).toBe(device);
    expect(host.findDevice("H6160:NO:PE")).toBeUndefined();
    expect(host.devicePrefix(device)).toBe("devices.h6160");
    const handle = host.setTimeout(() => undefined, 5_000);
    expect(timers).toEqual([{ ms: 5_000 }]);
    host.clearTimeout(handle);
    expect(cleared).toEqual([handle]);
    await host.applyWizardResult(device, { segmentCount: 5, manualList: "0-1,3-4", hasGaps: true });
    expect(applied).toEqual([{ device, mode: true, indices: [0, 1, 3, 4] }]);
    expect(host.namespace).toBe("govee-smart.0");
  });

  it("devicePrefix falls back to '' when the state manager is gone (teardown race)", () => {
    const device = createTestDevice();
    const { adapter } = makeAdapter([device]);
    (adapter as { stateManager: unknown }).stateManager = null;
    expect(buildWizardHost(adapter).devicePrefix(device)).toBe("");
  });
});
