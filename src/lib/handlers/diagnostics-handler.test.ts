import { handleDiagnosticsExport, type DiagnosticsHandlerAdapter } from "./diagnostics-handler";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS } from "../timing-constants";
import { sessionKey } from "../device-key";
import type { DeviceManager } from "../device-manager";
import { createTestDevice, mockLog } from "../test-helpers";

function makeAdapter(): {
  adapter: DiagnosticsHandlerAdapter;
  writes: Array<{ id: string; val: unknown; ack: boolean }>;
} {
  const writes: Array<{ id: string; val: unknown; ack: boolean }> = [];
  return {
    writes,
    adapter: {
      log: mockLog,
      namespace: "govee-smart.0",
      version: "9.9.9",
      setState: (id, state) => {
        const s = state as { val: unknown; ack: boolean };
        writes.push({ id, val: s.val, ack: s.ack });
        return Promise.resolve();
      },
    },
  };
}

function makeDeviceManager(): { dm: DeviceManager; generateCalls: string[] } {
  const generateCalls: string[] = [];
  const dm = {
    generateDiagnostics: (device: { sku: string }, version: string) => {
      generateCalls.push(version);
      return { adapter: "iobroker.govee-smart", sku: device.sku };
    },
  } as unknown as DeviceManager;
  return { dm, generateCalls };
}

const device = createTestDevice();
const PREFIX = "devices.h6160_0011";
const TRIGGER = `govee-smart.0.${PREFIX}.diag.export`;

describe("handleDiagnosticsExport", () => {
  it("writes the diag JSON to diag.result and resets the trigger button", async () => {
    const { adapter, writes } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX, TRIGGER);

    expect(generateCalls).toEqual(["9.9.9"]);
    const resultWrite = writes.find(w => w.id === `govee-smart.0.${PREFIX}.diag.result`);
    expect(resultWrite).toBeDefined();
    expect(JSON.parse(resultWrite!.val as string).sku).toBe("H6160");
    expect(resultWrite!.ack).toBe(true);
    // Trigger reset so the next click works
    const triggerWrite = writes.find(w => w.id === TRIGGER);
    expect(triggerWrite).toMatchObject({ val: false, ack: true });
  });

  it("throttles a second click inside the window — no diag generated, but the button is still reset", async () => {
    const { adapter, writes } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS / 2);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX, TRIGGER);

    expect(generateCalls).toHaveLength(0);
    expect(writes.find(w => w.id.endsWith(".diag.result"))).toBeUndefined();
    // Button reset is unconditional — otherwise the UI button sticks at true
    expect(writes.find(w => w.id === TRIGGER)).toMatchObject({ val: false, ack: true });
  });

  it("allows a re-export once the throttle window has elapsed", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS - 1);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX, TRIGGER);
    expect(generateCalls).toHaveLength(1);
  });

  it("throttle is keyed per device — a second device exports immediately", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX, TRIGGER);

    const other = createTestDevice({ deviceId: "BB:22" });
    await handleDiagnosticsExport(adapter, dm, lastRun, other, "devices.h6160_bb22", TRIGGER);
    expect(generateCalls).toHaveLength(2);
  });
});
