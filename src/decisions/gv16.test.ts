// GV-16 — Without a connection to the cloud, a device that runs only over the cloud does not show green.
// krobi 2026-10-01 11:55: "that would be falsification if the adapter showed green although it has no connection, because
// — as you listed — his devices run exclusively over the cloud"; 2026-10-07 20:27: "sure, a cloud-only device without cloud
// is offline"
import { describe, expect, it, vi } from "vitest";

// connection-state pulls device-manager → i18n → @iobroker/adapter-core, whose import-time controller lookup exits
// outside a js-controller.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

import { runOnlineSyncRound } from "../lib/handlers/online-sync";
import { StateManager } from "../lib/state-manager";
import { DeviceManager } from "../lib/device-manager";
import { DeviceIdRegistry } from "../lib/device-id";
import { DeviceRegistry } from "../lib/device-registry";
import type { GoveeDevice } from "../lib/types";

const log: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

/** A light with no local API. It pushed over the account broker once; Govee said "online" a minute ago. */
function cloudOnlyLight(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:16",
    name: "Strip",
    type: "devices.types.light",
    capabilities: [{ type: "devices.capabilities.on_off", instance: "powerSwitch" }],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true, cloudReportedOnline: true, cloudReportedOnlineAt: Date.now() - 60_000 },
    channels: { lan: false, mqtt: true, cloud: true },
  };
}

/**
 * One 20-second round of the adapter — the device's own `info.online` and the adapter's `info.connection`, as written.
 *
 * @param outageConfirmed whether real calls say the Cloud is down
 * @param brokerConnected whether the account broker is connected
 * @param appApiAnswers whether the App API's account list answers
 */
async function round(
  outageConfirmed: boolean,
  brokerConnected = false,
  appApiAnswers = false,
): Promise<Map<string, unknown>> {
  const written = new Map<string, unknown>();
  const record = (id: string, state: { val: unknown }): Promise<void> => {
    written.set(id.replace("govee-smart.0.", ""), state.val);
    return Promise.resolve();
  };
  const timers = {
    setInterval: () => undefined,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    setTimeout: () => undefined,
    delay: () => Promise.resolve(),
  } as never;
  const registry = new DeviceRegistry({ data: { devices: {} } });
  const dm = new DeviceManager(log, timers, registry, new DeviceIdRegistry());
  (dm as unknown as { devices: Map<string, GoveeDevice> }).devices.set("k", cloudOnlyLight());
  if (appApiAnswers) {
    dm.setApiClient({ hasBearerToken: () => true, fetchDeviceList: () => Promise.resolve([]) } as never);
    await dm.pollAppApi();
  }
  const adapter = {
    log,
    namespace: "govee-smart.0",
    config: {},
    unloading: false,
    groupReachabilityPrimed: true,
    deviceManager: dm,
    cloudClient: {},
    cloudWasConnected: true,
    cloudOutage: { confirmed: outageConfirmed },
    mqttClient: { connected: brokerConnected },
    openapiMqttClient: null,
    lanClient: { isListening: () => true },
    lanScanDone: true,
    statesReady: true,
    cloudInitDone: true,
    appApiInitialPollDone: true,
    readyLogged: true,
    lastConnectionState: null,
    getObjectViewAsync: () => Promise.resolve({ rows: [] }),
    setState: record,
    setStateChangedAsync: record,
  };
  (adapter as { stateManager?: StateManager }).stateManager = new StateManager(adapter as never, registry);
  await runOnlineSyncRound(adapter as never);
  return written;
}

const ONLINE = "devices.h6199-0016.info.online";

describe("GV-16 a cloud-only device without cloud is not green", () => {
  it("with the cloud confirmed unreachable and the broker down, the device shows offline — even though Govee's last word was 'online' and it once pushed — and so does the adapter", async () => {
    const written = await round(true);
    expect(written.get(ONLINE)).toBe(false);
    expect(written.get("info.connection")).toBe(false);
  });

  it("with the cloud answering, the same device shows online and keeps the adapter green (positive control)", async () => {
    const written = await round(false);
    expect(written.get(ONLINE)).toBe(true);
    expect(written.get("info.connection")).toBe(true);
  });

  it("with the account broker connected right now, a cloud path works — its fresh evidence keeps it green", async () => {
    const written = await round(true, true);
    expect(written.get(ONLINE)).toBe(true);
    expect(written.get("info.connection")).toBe(true);
  });

  it("with the Cloud REST down and the broker disconnected, an App API that answers is a cloud path too — the device stays green", async () => {
    const written = await round(true, false, true);
    expect(written.get(ONLINE)).toBe(true);
    expect(written.get("info.connection")).toBe(true);
  });
});
