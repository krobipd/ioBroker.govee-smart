import type { DeviceManager } from "../device-manager";
import type { GoveeLanClient } from "../govee-lan-client";
import type { SegmentWizard, WizardHost, WizardResult } from "../segment-wizard";
import { SegmentWizard as SegmentWizardClass } from "../segment-wizard";
import type { StateManager } from "../state-manager";
import { type GoveeDevice } from "../types";
import { parseSegmentList } from "../segment-list";
import { sessionKey } from "../device-key";
import { plausibleSegmentCount } from "../device-manager/lookups";
import { applyManualSegments } from "./state-change-router";

/**
 * Adapter surface required by the segment-wizard glue.
 */
export interface WizardHandlerAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** The LAN client. */
  readonly lanClient: GoveeLanClient | null;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** The running segment wizard — null while none runs. */
  segmentWizard: SegmentWizard | null;
  /** Read one own state. */
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  /** The adapter's setTimeout — cleared on unload. */
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** The adapter's clearTimeout. */
  clearTimeout: (h: ioBroker.Timeout) => void;
}

/**
 * Stable device key for wizard session tracking.
 *
 * @param device The device
 */
export function deviceKeyFor(device: GoveeDevice): string {
  return sessionKey(device.sku, device.deviceId);
}

/**
 * Resolve a wizard session-key back to the live device.
 *
 * @param adapter The adapter surface
 * @param key The device key (`sku:deviceId`)
 */
export function findDeviceByKey(adapter: WizardHandlerAdapter, key: string): GoveeDevice | undefined {
  const devices = adapter.deviceManager?.getDevices() ?? [];
  return devices.find(d => deviceKeyFor(d) === key);
}

/**
 * Build the host object passed into {@link SegmentWizardClass}. All adapter
 * dependencies are captured here as closures so the wizard itself stays
 * decoupled from the adapter shape.
 *
 * @param adapter The adapter surface
 */
export function buildWizardHost(adapter: WizardHandlerAdapter): WizardHost {
  return {
    log: adapter.log,
    getState: id => adapter.getStateAsync(id),
    sendCommand: async (device, command, value) => {
      await adapter.deviceManager?.sendCommand(device, command, value);
    },
    flashSegmentAtomic: (device, idx) => {
      if (!device.lanIp || !adapter.lanClient) {
        return Promise.resolve(false);
      }
      adapter.lanClient.flashSingleSegment(device.lanIp, idx);
      return Promise.resolve(true);
    },
    restoreStripAtomic: (device, total, color, brightness) => {
      if (!device.lanIp || !adapter.lanClient) {
        return Promise.resolve(false);
      }
      const r = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const b = color & 0xff;
      adapter.lanClient.restoreAllSegments(device.lanIp, total, r, g, b, brightness);
      return Promise.resolve(true);
    },
    findDevice: key => findDeviceByKey(adapter, key),
    namespace: adapter.namespace,
    devicePrefix: device => adapter.stateManager?.devicePrefix(device) ?? "",
    segmentCount: device => adapter.deviceManager?.syncSegmentCount(device) ?? 0,
    setTimeout: (cb, ms) => adapter.setTimeout(cb, ms),
    clearTimeout: h => adapter.clearTimeout(h as ioBroker.Timeout),
    applyWizardResult: (device, result) => applyWizardResult(adapter, device, result),
  };
}

/**
 * Apply a finished wizard's measurement: set the real segment count, then
 * route through {@link applyManualSegments} so the same
 * state-tree rebuild and cache-persist path runs for both wizard results
 * and user edits.
 *
 * @param adapter The adapter surface
 * @param device The device
 * @param result The finished measurement
 */
export async function applyWizardResult(
  adapter: WizardHandlerAdapter,
  device: GoveeDevice,
  result: WizardResult,
): Promise<void> {
  const segmentCount = plausibleSegmentCount(result.segmentCount);
  if (segmentCount === undefined) {
    // The wizard already filters indices to the protocol range, so this only
    // fires on a corrupt result — never let it become the device's count.
    adapter.log.warn(`applyWizardResult: ignoring implausible segment count ${String(result.segmentCount)}`);
    return;
  }
  device.segmentCount = segmentCount;
  if (result.hasGaps) {
    const parsed = parseSegmentList(result.manualList, result.segmentCount - 1);
    await applyManualSegments(adapter, device, true, parsed.error ? undefined : parsed.indices);
  } else {
    await applyManualSegments(adapter, device, false);
  }
  adapter.log.debug(
    `applyWizardResult: ${device.sku} → segmentCount=${result.segmentCount}, ` +
      `manualMode=${device.manualMode}, list="${result.manualList}"`,
  );
}

/**
 * Execute one wizard step (start/yes/no/done/abort/apply). Lazy-instantiates
 * the underlying {@link SegmentWizardClass} on first use and returns its
 * response verbatim — the React admin component renders the wizard from the
 * response's grid snapshot, so no status is mirrored into a state.
 *
 * @param adapter The adapter surface
 * @param action The wizard action
 * @param deviceKey The device key (`sku:deviceId`)
 * @param payload The action's data
 * @param payload.indices The segment indices to apply
 */
export async function runWizardStep(
  adapter: WizardHandlerAdapter,
  action: string,
  deviceKey: string,
  payload?: { indices?: number[] },
): Promise<Record<string, unknown>> {
  if (!adapter.segmentWizard) {
    adapter.segmentWizard = new SegmentWizardClass(buildWizardHost(adapter));
  }
  return adapter.segmentWizard.runStep(action, deviceKey, payload);
}
