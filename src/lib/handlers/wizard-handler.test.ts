import { vi } from "vitest";

const { enJson } = vi.hoisted(() => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  return {
    enJson: JSON.parse(readFileSync(join(__dirname, "../../../admin/i18n/en.json"), "utf8")) as Record<string, string>,
  };
});

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => enJson[key] ?? key),
  },
}));

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
  statusWrites: Array<{ id: string; val: unknown }>;
} {
  const applied: Array<{ device: GoveeDevice; mode: boolean; indices?: number[] }> = [];
  const statusWrites: Array<{ id: string; val: unknown }> = [];
  const adapter: WizardHandlerAdapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    lanClient: null,
    deviceManager: { getDevices: () => devices, sendCommand: async () => undefined } as never,
    stateManager: { devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}` } as never,
    segmentWizard: null,
    getStateAsync: async () => null,
    setState: async (id, state) => {
      statusWrites.push({ id, val: (state as { val: unknown }).val });
    },
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    applyManualSegments: async (device, mode, indices) => {
      applied.push({ device, mode, indices });
    },
  };
  return { adapter, applied, statusWrites };
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

  it("unparseable manualList still enables manual mode but without indices (no crash, no stale list)", async () => {
    const device = createTestDevice({ segmentCount: 5 });
    const { adapter, applied } = makeAdapter([device]);
    await applyWizardResult(adapter, device, { segmentCount: 5, manualList: "not-a-list", hasGaps: true });
    expect(applied).toEqual([{ device, mode: true, indices: undefined }]);
  });
});

describe("runWizardStep", () => {
  it("lazily instantiates ONE wizard and mirrors its status into info.wizardStatus", async () => {
    const device = createTestDevice();
    const { adapter, statusWrites } = makeAdapter([device]);
    expect(adapter.segmentWizard).toBeNull();
    // Unknown action — routes through the real SegmentWizard error path.
    const response = await runWizardStep(adapter, "bogus", deviceKeyFor(device));
    expect(adapter.segmentWizard).not.toBeNull();
    expect(typeof response.error).toBe("string");
    expect(statusWrites.some(w => w.id === "info.wizardStatus")).toBe(true);

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
