import { vi } from "vitest";
import { handleDiagnosticsExport, type DiagnosticsHandlerAdapter } from "./diagnostics-handler";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS, DIAGNOSTICS_KEEP_PER_DEVICE } from "../timing-constants";
import { sessionKey } from "../device-key";
import type { DeviceManager } from "../device-manager";
import { createTestDevice, mockLog } from "../test-helpers";

function makeAdapter(): {
  adapter: DiagnosticsHandlerAdapter;
  writes: Array<{ id: string; val: unknown; ack: boolean }>;
  files: Map<string, string>;
} {
  const writes: Array<{ id: string; val: unknown; ack: boolean }> = [];
  // The meta.user file store the report is written into — the same shape
  // LocalSnapshotStore already uses.
  const files = new Map<string, string>();
  return {
    writes,
    files,
    adapter: {
      log: mockLog,
      namespace: "govee-smart.0",
      version: "9.9.9",
      setState: (id, state) => {
        const s = state as { val: unknown; ack: boolean };
        writes.push({ id, val: s.val, ack: s.ack });
        return Promise.resolve();
      },
      writeFileAsync: (meta, name, data) => {
        files.set(`${meta}/${name}`, String(data));
        return Promise.resolve();
      },
      readDirAsync: meta =>
        Promise.resolve(
          [...files.keys()]
            .filter(k => k.startsWith(`${meta}/`))
            .map(k => ({ file: k.slice(meta.length + 1), isDir: false })),
        ),
      delFileAsync: (meta, name) => {
        files.delete(`${meta}/${name}`);
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
      return Promise.resolve({ adapter: "iobroker.govee-smart", sku: device.sku });
    },
  } as unknown as DeviceManager;
  return { dm, generateCalls };
}

const device = createTestDevice();
const PREFIX = "devices.h6160_0011";
describe("handleDiagnosticsExport", () => {
  it("writes the report as a FILE and points the datapoint at it", async () => {
    // The whole point of the change: the report measured 67,917 characters on
    // an H61BE — past GitHub's issue limit, so it could not be pasted into the
    // issue it exists for, and as a state value it sat in the state database
    // and flowed through every history subscription on the device.
    const { adapter, writes, files } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const name = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);

    expect(generateCalls).toEqual(["9.9.9"]);
    expect(name).toBeTruthy();
    const stored = files.get(`govee-smart.0.diagnostics/${name!}`);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).sku).toBe("H6160");

    // The datapoint carries WHEN the report was taken. The name would say
    // nothing a moment later — the card hands the file over on the spot — while
    // "was a report taken since the fault?" stays answerable in the object tree.
    const pointer = writes.find(w => w.id === `govee-smart.0.${PREFIX}.diag.lastExport`);
    expect(pointer?.ack).toBe(true);
    expect(pointer?.val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Neither predecessor is written any more: the fat report datapoint (≤2.28.0)
    // nor the file name (≤2.30.0).
    expect(writes.find(w => w.id.endsWith(".diag.result"))).toBeUndefined();
    expect(pointer?.val).not.toBe(name);
    // And nothing writes to the button datapoint, which no longer exists.
    expect(writes.find(w => w.id.endsWith(".diag.export"))).toBeUndefined();
  });

  it("the file name tells a stranger which device it is about", async () => {
    // The recipient has none of our context, and a reporter with two Govee
    // devices attaches two of these.
    const { adapter, files } = makeAdapter();
    const { dm } = makeDeviceManager();
    const name = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(name).toMatch(/^govee-smart_H6160_0011_v9\.9\.9_\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
    expect([...files.keys()][0]).toContain("H6160_0011");
  });

  it("the report itself says it is pseudonymised", async () => {
    // Without that line a reader takes `address-1` for a bug.
    const { adapter, files } = makeAdapter();
    const dm = {
      generateDiagnostics: () => Promise.resolve({ readMe: { privacy: "Pseudonymised: …" }, sku: "H6160" }),
    } as unknown as DeviceManager;
    await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    const stored = [...files.values()][0];
    expect(JSON.parse(stored).readMe.privacy).toContain("Pseudonymised");
  });

  it("keeps only the newest reports per device", async () => {
    // The throttle guards against button spam, not against accumulation.
    // Real time has to advance between exports: the export is throttled to one
    // every 2 s and the file name carries a to-the-second stamp, so two runs
    // can never collide in practice — clearing the throttle without moving the
    // clock would just have each export overwrite the last one and prove
    // nothing about pruning.
    const { adapter, files } = makeAdapter();
    const { dm } = makeDeviceManager();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(new Date(Date.now() + DIAGNOSTICS_EXPORT_THROTTLE_MS + 1_000));
        await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(files.size).toBe(DIAGNOSTICS_KEEP_PER_DEVICE);
  });

  it("a failing export answers null and leaves the timestamp alone", async () => {
    // The card turns the null into its own error message; the datapoint must not
    // claim a report was taken when none was.
    const { adapter, writes } = makeAdapter();
    const dm = {
      generateDiagnostics: () => Promise.reject(new Error("object db down")),
    } as unknown as DeviceManager;
    const name = await handleDiagnosticsExport(adapter, dm, new Map(), device, PREFIX);
    expect(name).toBeNull();
    expect(writes.find(w => w.id.endsWith(".diag.lastExport"))).toBeUndefined();
  });

  it("throttles a second click inside the window — nothing generated, nothing stamped", async () => {
    const { adapter, writes } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS / 2);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);

    expect(generateCalls).toHaveLength(0);
    expect(writes.find(w => w.id.endsWith(".diag.lastExport"))).toBeUndefined();
  });

  it("allows a re-export once the throttle window has elapsed", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    lastRun.set(sessionKey(device.sku, device.deviceId), Date.now() - DIAGNOSTICS_EXPORT_THROTTLE_MS - 1);

    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);
    expect(generateCalls).toHaveLength(1);
  });

  it("throttle is keyed per device — a second device exports immediately", async () => {
    const { adapter } = makeAdapter();
    const { dm, generateCalls } = makeDeviceManager();
    const lastRun = new Map<string, number>();
    await handleDiagnosticsExport(adapter, dm, lastRun, device, PREFIX);

    const other = createTestDevice({ deviceId: "BB:22" });
    await handleDiagnosticsExport(adapter, dm, lastRun, other, "devices.h6160_bb22");
    expect(generateCalls).toHaveLength(2);
  });
});
