import { vi } from "vitest";

// The fan-out resolves music modes through the capability mapper, which reads
// its names from adapter-core's I18n — no js-controller in a unit test.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { buildGroupFanoutHost, updateGroupReachability, type GroupFanoutHandlerAdapter } from "./group-fanout-handler";
import type { GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../../../test/test-helpers";

function makeGroup(members: Array<{ sku: string; deviceId: string }>): GoveeDevice {
  return createTestDevice({
    sku: "BaseGroup",
    deviceId: "1311",
    lanIp: undefined,
    groupMembers: members,
  });
}

function makeAdapter(devices: GoveeDevice[]): {
  adapter: GroupFanoutHandlerAdapter;
  unreachableCalls: Array<{ group: string; members: string[] }>;
} {
  const unreachableCalls: Array<{ group: string; members: string[] }> = [];
  const adapter: GroupFanoutHandlerAdapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    deviceManager: { getDevices: () => devices } as never,
    stateManager: {
      devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}`,
      updateGroupMembersUnreachable: (group: GoveeDevice, members: GoveeDevice[]) => {
        unreachableCalls.push({ group: group.deviceId, members: members.map(m => m.deviceId) });
        return Promise.resolve();
      },
    } as never,
    getObjectAsync: () => Promise.resolve(null),
    lanClient: null,
    getStateAsync: () => Promise.resolve(null),
  };
  return { adapter, unreachableCalls };
}

describe("updateGroupReachability", () => {
  it("recalculates membersUnreachable for every group, resolving members against the live list", () => {
    const m1 = createTestDevice({ deviceId: "AA:01" });
    const m2 = createTestDevice({ deviceId: "AA:02" });
    const group = makeGroup([
      { sku: m1.sku, deviceId: m1.deviceId },
      { sku: m2.sku, deviceId: m2.deviceId },
      { sku: "Phantom", deviceId: "FF:FF" }, // not in the live list → dropped by the resolver
    ]);
    const { adapter, unreachableCalls } = makeAdapter([m1, m2, group]);
    updateGroupReachability(adapter);
    expect(unreachableCalls).toEqual([{ group: "1311", members: ["AA:01", "AA:02"] }]);
  });

  it("skips regular devices and groups without resolved members", () => {
    const plain = createTestDevice({ deviceId: "AA:01" });
    const emptyGroup = createTestDevice({ sku: "BaseGroup", deviceId: "9999", groupMembers: undefined });
    const { adapter, unreachableCalls } = makeAdapter([plain, emptyGroup]);
    updateGroupReachability(adapter);
    expect(unreachableCalls).toHaveLength(0);
  });

  it("is a safe no-op while managers are not wired yet (boot race)", () => {
    const { adapter } = makeAdapter([]);
    (adapter as { deviceManager: unknown }).deviceManager = null;
    expect(() => updateGroupReachability(adapter)).not.toThrow();
  });
});

describe("buildGroupFanoutHost", () => {
  it("stateToCommand maps the adapter's null to undefined (GroupFanoutHost contract)", () => {
    const { adapter } = makeAdapter([]);
    const host = buildGroupFanoutHost(adapter);
    expect(host.stateToCommand("control.unknown")).toBeUndefined();
  });

  it("getDevices falls back to [] when the device manager is gone (teardown race)", () => {
    const { adapter } = makeAdapter([]);
    (adapter as { deviceManager: unknown }).deviceManager = null;
    const host = buildGroupFanoutHost(adapter);
    expect(host.getDevices()).toEqual([]);
  });
});

describe("buildGroupFanoutHost — passthrough closures", () => {
  it("sendCommand routes through the device manager and devicePrefix through the state manager", async () => {
    const sent: Array<{ id: string; command: string }> = [];
    const { adapter } = makeAdapter([]);
    (adapter as { deviceManager: unknown }).deviceManager = {
      getDevices: () => [],
      sendCommand: (d: GoveeDevice, command: string) => {
        sent.push({ id: d.deviceId, command });
        return Promise.resolve();
      },
    };
    const host = buildGroupFanoutHost(adapter);
    const dev = createTestDevice({ deviceId: "AA:09" });
    await host.sendCommand(dev, "power", true);
    expect(sent).toEqual([{ id: "AA:09", command: "power" }]);
    expect(host.devicePrefix(dev)).toBe("devices.h6160");
  });

  it("sendMusicCommand builds the member's own music command — mode from the write, the rest from its datapoints", async () => {
    const sent: unknown[] = [];
    const { adapter } = makeAdapter([]);
    (adapter as { deviceManager: unknown }).deviceManager = {
      getDevices: () => [],
      sendCapabilityCommand: (_d: GoveeDevice, type: string, instance: string, value: unknown) => {
        sent.push({ type, instance, value });
        return Promise.resolve();
      },
    };
    const member = createTestDevice({
      lanIp: undefined,
      capabilities: [
        {
          type: "devices.capabilities.music_setting",
          instance: "musicMode",
          parameters: {
            dataType: "STRUCT",
            fields: [
              {
                fieldName: "musicMode",
                dataType: "ENUM",
                options: [
                  { name: "Energic", value: 5 },
                  { name: "Rhythm", value: 3 },
                ],
              },
            ],
          },
        },
      ],
    });
    const host = buildGroupFanoutHost(adapter);
    expect(await host.sendMusicCommand(member, "devices.x", "music.music_mode", 2)).toBe(true);
    expect(sent).toEqual([
      {
        type: "devices.capabilities.music_setting",
        instance: "musicMode",
        value: { musicMode: 3, sensitivity: 100, autoColor: 0 },
      },
    ]);
  });

  it("stateToCommand answers from the one state-to-command table", () => {
    const { adapter } = makeAdapter([]);
    const host = buildGroupFanoutHost(adapter);
    expect(host.stateToCommand("control.power")).toBe("power");
    expect(host.stateToCommand("control.nonsense")).toBeUndefined();
  });

  it("devicePrefix falls back to '' when the state manager is gone (teardown race)", () => {
    const { adapter } = makeAdapter([]);
    (adapter as { stateManager: unknown }).stateManager = null;
    const host = buildGroupFanoutHost(adapter);
    expect(host.devicePrefix(createTestDevice())).toBe("");
  });
});
