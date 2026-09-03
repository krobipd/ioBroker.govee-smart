/**
 * Shared test mocks and factories for all test files.
 *
 * `mockLog`, `mockTimers`, `createTestDevice` etc. were previously inline in
 * `device-manager.test.ts` — duplicated across other tests. Centralised here.
 */

import type { CloudCapability, GoveeDevice } from "./types";

/** No-op logger with all ioBroker.Logger methods. */
export const mockLog: ioBroker.Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  silly: () => {},
  level: "info",
};

/**
 * Timer adapter for tests.
 *
 * `setTimeout` fires IMMEDIATELY — async-await paths based on
 * `await new Promise(r => setTimeout(r, ...))` would otherwise stall.
 * `setInterval` does NOT fire — tests that observe polling need a different
 * mock strategy explicitly.
 */
export const mockTimers = {
  setInterval: () => undefined,
  clearInterval: () => undefined,
  setTimeout: (cb: () => void) => {
    cb();
    return undefined;
  },
  clearTimeout: () => undefined,
  delay: () => Promise.resolve(),
} as never;

/**
 * Standard capability set for a regular light device (H6160-like). Enough for
 * most tests that expect capabilities without caring about the details.
 */
export function lightCapabilities(): CloudCapability[] {
  return [
    { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
    {
      type: "devices.capabilities.range",
      instance: "brightness",
      parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } },
    },
    { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
    {
      type: "devices.capabilities.color_setting",
      instance: "colorTemperatureK",
      parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
    },
    { type: "devices.capabilities.dynamic_scene", instance: "lightScene" },
    { type: "devices.capabilities.dynamic_scene", instance: "diyScene" },
    { type: "devices.capabilities.dynamic_scene", instance: "snapshot" },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedColorRgb",
      parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", range: { min: 0, max: 14 } }] },
    },
    {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedBrightness",
      parameters: { dataType: "STRUCT", fields: [{ fieldName: "segment", range: { min: 0, max: 14 } }] },
    },
  ] as CloudCapability[];
}

/**
 * Create a test GoveeDevice with sensible defaults. Override pattern via
 * spread: `createTestDevice({ sku: "H1234" })`.
 *
 * @param overrides Override individual fields
 */
export function createTestDevice(overrides: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6160",
    deviceId: "AA:BB:CC:DD:EE:FF:00:11",
    name: "Test Device",
    type: "devices.types.light",
    lanIp: "192.168.1.100",
    capabilities: lightCapabilities(),
    scenes: [
      { name: "Sunrise", value: { id: 1, paramId: "sunrise" } },
      { name: "Sunset", value: { id: 2, paramId: "sunset" } },
    ],
    diyScenes: [
      { name: "DIY1", value: { id: 100, paramId: "diy1" } },
      { name: "DIY2", value: { id: 101, paramId: "diy2" } },
    ],
    snapshots: [
      { name: "Snap1", value: 1 },
      { name: "Snap2", value: 2 },
    ],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    lastSeenOnNetwork: Date.now(),
    // A LAN light that counts as reachable has answered — the production paths
    // always set both together (LAN discovery and devStatus). Without the reply
    // stamp this factory produced a device that no real code path can create,
    // and `resolveDeviceReachability` would rightly call it unreachable.
    lastLanReplyAt: Date.now(),
    state: { online: true },
    channels: { lan: true, mqtt: false, cloud: false },
    segmentCount: 15,
    ...overrides,
  };
}

/**
 * Recorder for mock method calls in tests.
 *
 * Usage:
 * ```ts
 * const tracker = createCallTracker();
 * mockObj.someMethod = tracker.track("someMethod");
 * // ... call code ...
 * expect(tracker.calls).to.deep.equal([{method: "someMethod", args: [...]}]);
 * ```
 */
export function createCallTracker(): {
  calls: Array<{ method: string; args: unknown[] }>;
  track: (method: string) => (...args: unknown[]) => void;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    track:
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
      },
  };
}
