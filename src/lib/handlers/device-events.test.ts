import { vi } from "vitest";
import { DeviceRegistry } from "../device-registry";

// device-events pulls capability-mapper → i18n → @iobroker/adapter-core,
// whose import-time controller lookup process.exits outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { onCloudDataReady, onDeviceStateUpdate, onGroupMembersReady, onLanDeviceReady } from "./device-events";
import type { StateDefinition } from "../capability-mapper";
import type { DeviceState, GoveeDevice } from "../types";
import { createTestDevice, mockLog } from "../test-helpers";

interface Rig {
  // onDeviceStateUpdate has the widest adapter constraint (all four
  // intersected interfaces) — typing the rig against it keeps every
  // handler call in this suite assignable.
  adapter: Parameters<typeof onDeviceStateUpdate>[0];
  calls: string[];
  cloudDefs: StateDefinition[][];
  updates: Array<Partial<DeviceState>>;
  dropdownResets: string[];
  reapCalls: number[];
  queue: Promise<void>[];
}

function makeRig(opts: { devices?: GoveeDevice[]; statesReady?: boolean } = {}): Rig {
  const calls: string[] = [];
  const cloudDefs: StateDefinition[][] = [];
  const updates: Array<Partial<DeviceState>> = [];
  const dropdownResets: string[] = [];
  const reapCalls: number[] = [];
  const queue: Promise<void>[] = [];
  const devices = opts.devices ?? [];

  const adapter = {
    log: mockLog,
    namespace: "govee-smart.0",
    deviceManager: { getDevices: () => devices, syncSegmentCount: (d: GoveeDevice) => d.segmentCount ?? 0 } as never,
    stateManager: {
      devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}`,
      // The real one chains builds per device; here it only records that the
      // build went through it and runs it.
      runDeviceBuild: (d: GoveeDevice, build: () => Promise<void>) => {
        calls.push(`runDeviceBuild:${d.deviceId}`);
        return build();
      },
      updateDeviceState: (_d: GoveeDevice, s: Partial<DeviceState>) => {
        updates.push(s);
        return Promise.resolve();
      },
      syncInfoOnline: () => {
        calls.push("syncInfoOnline");
        return Promise.resolve(false);
      },
      createInfoStates: () => {
        calls.push("createInfoStates");
        return Promise.resolve();
      },
      createLanStates: () => {
        calls.push("createLanStates");
        return Promise.resolve();
      },
      createCloudStates: (_d: GoveeDevice, defs: StateDefinition[], segmentCount: number) => {
        calls.push(`createCloudStates:${segmentCount}`);
        cloudDefs.push(defs);
        return Promise.resolve();
      },
      migrateLegacyDiagnostics: () => {
        calls.push("migrateLegacyDiagnostics");
        return Promise.resolve();
      },
      updateDeviceTier: () => {
        calls.push("updateDeviceTier");
        return Promise.resolve();
      },
      updateGroupMembersUnreachable: () => Promise.resolve(undefined),
    } as never,
    localSnapshots: { getSnapshots: () => [{ name: "Snap" }] } as never,
    deviceRegistry: new DeviceRegistry({ data: { devices: {} } }),
    statesReady: opts.statesReady ?? false,
    stateCreationQueue: queue,
    setState: () => Promise.resolve(undefined),
    reapStaleDevices: () => {
      reapCalls.push(1);
      return Promise.resolve();
    },
    // ConnectionStateAdapter surface (updateConnectionState path)
    cloudClient: null,
    cloudWasConnected: false,
    diagnosticsLastRun: new Map<string, number>(),
    mqttClient: null,
    openapiMqttClient: null,
    lanClient: null,
    lanScanDone: false,
    cloudInitDone: false,
    appApiInitialPollDone: false,
    readyLogged: true, // checkAllReady untouched by these tests
    lastConnectionState: null,
    // GroupStateHelpersAdapter (dropdown reset reads/writes)
    getStateAsync: (id: string) => {
      // Pretend a scene dropdown is active so a reset write becomes observable.
      if (id.endsWith("scenes.light_scene")) {
        return Promise.resolve({ val: "2", ack: true } as ioBroker.State);
      }
      return Promise.resolve(null);
    },
    // GroupFanoutHandlerAdapter
    getObjectAsync: () => Promise.resolve(null),
    stateToCommand: () => null,
    sendMusicCommand: () => Promise.resolve(undefined),
  } as unknown as Parameters<typeof onDeviceStateUpdate>[0];

  // Observe dropdown resets through the shared setState.
  (adapter as { setState: unknown }).setState = (id: string, state: unknown) => {
    if ((state as { val: unknown }).val === "0") {
      dropdownResets.push(id);
    }
    return Promise.resolve();
  };

  return { adapter, calls, cloudDefs, updates, dropdownResets, reapCalls, queue };
}

describe("onDeviceStateUpdate", () => {
  it("mirrors the patch into the state manager", () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: true });
    onDeviceStateUpdate(rig.adapter, device, { brightness: 50 });
    expect(rig.updates).toEqual([{ brightness: 50 }]);
  });

  it("an online flip on a Light triggers the fast syncInfoOnline path (<1s recovery, not the 20s timer)", () => {
    const device = createTestDevice(); // type light
    const rig = makeRig({ devices: [device], statesReady: true });
    onDeviceStateUpdate(rig.adapter, device, { online: true });
    expect(rig.calls).toContain("syncInfoOnline");
  });

  it("non-Light online updates do NOT call syncInfoOnline (applyOnlineCap → updateDeviceState owns it)", () => {
    const sensor = createTestDevice({ type: "devices.types.thermometer" });
    const rig = makeRig({ devices: [sensor], statesReady: true });
    onDeviceStateUpdate(rig.adapter, sensor, { online: true });
    expect(rig.calls).not.toContain("syncInfoOnline");
  });

  it("power-off resets the mode dropdowns — a device that is off cannot be 'playing Aurora'", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: true });
    onDeviceStateUpdate(rig.adapter, device, { power: false });
    await new Promise(r => setImmediate(r));
    expect(rig.dropdownResets.some(id => id.endsWith("scenes.light_scene"))).toBe(true);
  });

  it("L11: a numeric 0 from the MQTT boundary counts as power-off too", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: true });
    onDeviceStateUpdate(rig.adapter, device, { power: 0 as unknown as boolean });
    await new Promise(r => setImmediate(r));
    expect(rig.dropdownResets.length).toBeGreaterThan(0);
  });

  it("power-on does NOT reset dropdowns", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: true });
    onDeviceStateUpdate(rig.adapter, device, { power: true });
    await new Promise(r => setImmediate(r));
    expect(rig.dropdownResets).toHaveLength(0);
  });

  it("ignores value updates before statesReady — avoids the color_rgb start-race", () => {
    // A fast LAN devStatus arriving before createLanStates has drained the queue
    // must not write control.color_rgb onto a not-yet-created object. The next
    // poll/push re-delivers the value.
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onDeviceStateUpdate(rig.adapter, device, { brightness: 50 });
    expect(rig.updates).toEqual([]);
  });
});

describe("onLanDeviceReady (phase 1)", () => {
  it("creates info + LAN states and queues the promise until statesReady (onReady drain-loop contract)", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onLanDeviceReady(rig.adapter, device, [device]);
    expect(rig.queue).toHaveLength(1);
    await Promise.all(rig.queue);
    expect(rig.calls).toEqual(expect.arrayContaining(["createInfoStates", "createLanStates"]));
    expect(rig.calls).not.toContain("createCloudStates");
  });

  it("after statesReady the promise is fire-and-forget (no unbounded queue growth)", () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: true });
    onLanDeviceReady(rig.adapter, device, [device]);
    expect(rig.queue).toHaveLength(0);
  });

  it("runs its build through the state manager's per-device chain — a LAN build must not overtake a cloud build on the info channel", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onLanDeviceReady(rig.adapter, device, [device]);
    await Promise.all(rig.queue);
    expect(rig.calls[0]).toBe(`runDeviceBuild:${device.deviceId}`);
  });
});

describe("onCloudDataReady (phase 2)", () => {
  it("runs the full per-device pipeline: info → LAN → Cloud defs → legacy migration → tier", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onCloudDataReady(rig.adapter, device, [device]);
    await Promise.all(rig.queue);
    expect(rig.calls).toEqual(
      expect.arrayContaining([
        "createInfoStates",
        "createLanStates",
        "createCloudStates:15",
        "migrateLegacyDiagnostics",
        "updateDeviceTier",
      ]),
    );
  });

  it("runs its build through the state manager's per-device chain (the cache build and the cloud-list build must not interleave)", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onCloudDataReady(rig.adapter, device, [device]);
    await Promise.all(rig.queue);
    expect(rig.calls[0]).toBe(`runDeviceBuild:${device.deviceId}`);
  });

  it("gives a group with unresolved members no object tree at all", async () => {
    // An account without email + password never resolves group members
    // (loadGroupMembers bails without a bearer token). The cache path fires
    // this callback for the group on every restart, and it used to create the
    // device object, the info channel, the name and an empty members list —
    // objects a fresh install never creates, so the tree grew a shell that
    // nothing could ever fill. Measured on the object inventory: 262 objects
    // from a cold start, 266 from the same fixtures with a cache.
    const group = createTestDevice({ sku: "BaseGroup", groupMembers: undefined });
    const rig = makeRig({ devices: [group], statesReady: false });
    onCloudDataReady(rig.adapter, group, [group]);
    await Promise.all(rig.queue);
    expect(rig.calls).toEqual([]);
  });

  it("builds the tree for a group as soon as its members are there", async () => {
    const member = createTestDevice();
    const group = createTestDevice({
      sku: "BaseGroup",
      groupMembers: [{ sku: member.sku, deviceId: member.deviceId }],
    });
    const rig = makeRig({ devices: [group, member], statesReady: false });
    onCloudDataReady(rig.adapter, group, [group, member]);
    await Promise.all(rig.queue);
    expect(rig.calls).toEqual(expect.arrayContaining(["createInfoStates"]));
  });

  it("hands the tree builder the count the device manager settled — not 0, not its own guess", async () => {
    // The device manager owns device.segmentCount (syncSegmentCount); the
    // state manager only builds the tree for the number it is given. A wiring
    // slip here (0 / undefined) silently deletes every segment channel.
    const device = createTestDevice({ segmentCount: 7 });
    const rig = makeRig({ devices: [device], statesReady: false });
    onCloudDataReady(rig.adapter, device, [device]);
    await Promise.all(rig.queue);
    expect(rig.calls).toContain("createCloudStates:7");
  });

  it("feeds local snapshots into the cloud defs (snapshot_local dropdown carries the saved entries)", async () => {
    const device = createTestDevice();
    const rig = makeRig({ devices: [device], statesReady: false });
    onCloudDataReady(rig.adapter, device, [device]);
    await Promise.all(rig.queue);
    const localDef = rig.cloudDefs[0].find(d => d.id === "snapshot_local");
    expect(localDef).toBeDefined();
    expect(Object.values(localDef!.states!)).toContain("Snap");
  });

  it("re-reaps stale devices only after the initial tree is ready (no churn during boot)", () => {
    const device = createTestDevice();
    const before = makeRig({ devices: [device], statesReady: false });
    onCloudDataReady(before.adapter, device, [device]);
    expect(before.reapCalls).toHaveLength(0);

    const after = makeRig({ devices: [device], statesReady: true });
    onCloudDataReady(after.adapter, device, [device]);
    expect(after.reapCalls).toHaveLength(1);
  });
});

describe("onGroupMembersReady (phase 3)", () => {
  it("builds the group tree from the INTERSECTION of resolved member capabilities", async () => {
    const m1 = createTestDevice({ deviceId: "AA:01", lanIp: "10.0.0.1" });
    const m2 = createTestDevice({ deviceId: "AA:02", lanIp: "10.0.0.2" });
    const group = createTestDevice({
      sku: "BaseGroup",
      deviceId: "1311",
      lanIp: undefined,
      groupMembers: [
        { sku: m1.sku, deviceId: m1.deviceId },
        { sku: m2.sku, deviceId: m2.deviceId },
      ],
    });
    const rig = makeRig({ devices: [m1, m2, group], statesReady: false });
    onGroupMembersReady(rig.adapter, group, [m1, m2, group]);
    await Promise.all(rig.queue);
    // Both members are LAN-capable → the group gets the LAN-default control set.
    const ids = rig.cloudDefs[0].map(d => d.id);
    expect(ids).toEqual(expect.arrayContaining(["power", "brightness", "color_rgb", "color_temperature"]));
  });
});
