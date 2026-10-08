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

import { updateConnectionState, type ConnectionStateAdapter } from "../lib/handlers/connection-state";
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

function connectionWith(outageConfirmed: boolean, brokerConnected = false): unknown {
  const written: unknown[] = [];
  const devices = [cloudOnlyLight()];
  const adapter = {
    log,
    config: {},
    deviceManager: { getDevices: () => devices },
    cloudClient: {},
    cloudWasConnected: true,
    cloudOutage: { confirmed: outageConfirmed },
    diagnosticsLastRun: new Map(),
    mqttClient: { connected: brokerConnected },
    openapiMqttClient: null,
    lanClient: { isListening: () => true },
    stateManager: null,
    lanScanDone: true,
    statesReady: true,
    cloudInitDone: true,
    appApiInitialPollDone: true,
    readyLogged: true,
    lastConnectionState: null,
    setState: (id: string, state: { val: unknown }) => {
      if (id === "info.connection") {
        written.push(state.val);
      }
      return Promise.resolve();
    },
  } as unknown as ConnectionStateAdapter;
  updateConnectionState(adapter);
  return written.at(-1);
}

describe("GV-16 a cloud-only device without cloud is not green", () => {
  it("with the cloud confirmed unreachable and the broker down, info.connection is false — even though Govee's last word was 'online' and the device once pushed", () => {
    expect(connectionWith(true)).toBe(false);
  });

  it("with the cloud answering, the same device keeps the adapter green (positive control)", () => {
    expect(connectionWith(false)).toBe(true);
  });

  it("with the account broker connected right now, a cloud path works — its fresh evidence keeps it green", () => {
    expect(connectionWith(true, true)).toBe(true);
  });
});
