import { buildSnapshotHost, type SnapshotHandlerGlueAdapter } from "./snapshot-handler-glue";
import type { GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../test-helpers";

function makeAdapter(devices: GoveeDevice[]): {
  adapter: SnapshotHandlerGlueAdapter;
  fired: Array<{ device: GoveeDevice; all: GoveeDevice[] }>;
  commands: Array<{ device: string; command: string; value: unknown }>;
} {
  const fired: Array<{ device: GoveeDevice; all: GoveeDevice[] }> = [];
  const commands: Array<{ device: string; command: string; value: unknown }> = [];
  const adapter: SnapshotHandlerGlueAdapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    localSnapshots: {} as never,
    deviceManager: {
      getDevices: () => devices,
      syncSegmentCount: () => 12,
      sendCommand: (device: GoveeDevice, command: string, value: unknown) => {
        commands.push({ device: device.deviceId, command, value });
        return Promise.resolve();
      },
    } as never,
    stateManager: { devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}` } as never,
    getStateAsync: () => Promise.resolve(null),
    fireCloudDataReady: (device, all) => fired.push({ device, all }),
  };
  return { adapter, fired, commands };
}

describe("buildSnapshotHost", () => {
  it("refreshDeviceStates fires a Cloud-phase rebuild with the FULL device list (group defs need all members)", () => {
    const d1 = createTestDevice({ deviceId: "AA:01" });
    const d2 = createTestDevice({ deviceId: "AA:02" });
    const { adapter, fired } = makeAdapter([d1, d2]);
    const host = buildSnapshotHost(adapter);
    host.refreshDeviceStates(d1);
    expect(fired).toHaveLength(1);
    expect(fired[0].device).toBe(d1);
    expect(fired[0].all).toEqual([d1, d2]);
  });

  it("sendCommand routes through the device manager (LAN→Cloud routing, not a direct client)", async () => {
    const d1 = createTestDevice({ deviceId: "AA:01" });
    const { adapter, commands } = makeAdapter([d1]);
    const host = buildSnapshotHost(adapter);
    await host.sendCommand(d1, "power", true);
    expect(commands).toEqual([{ device: "AA:01", command: "power", value: true }]);
  });

  it("segmentCount is the tree size the device manager builds for, not the learned value (audit 2026-09-24 H4)", () => {
    const d1 = createTestDevice({ segmentCount: undefined });
    const { adapter } = makeAdapter([d1]);
    expect(buildSnapshotHost(adapter).segmentCount(d1)).toBe(12);
    (adapter as { deviceManager: unknown }).deviceManager = null;
    expect(buildSnapshotHost(adapter).segmentCount(d1)).toBe(0);
  });

  it("devicePrefix falls back to '' when the state manager is gone (teardown race)", () => {
    const d1 = createTestDevice();
    const { adapter } = makeAdapter([d1]);
    (adapter as { stateManager: unknown }).stateManager = null;
    const host = buildSnapshotHost(adapter);
    expect(host.devicePrefix(d1)).toBe("");
  });
});
