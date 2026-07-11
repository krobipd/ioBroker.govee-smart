import type { DeviceManager } from "../device-manager";
import { deviceLabel, type GoveeDevice } from "../types";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS } from "../timing-constants";
import { sessionKey } from "../device-key";

/**
 * Adapter surface required for diagnostics export. Loose `setState`
 * shape so structural typing matches utils.Adapter.
 */
export interface DiagnosticsHandlerAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly version?: string;
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
}

/**
 * Throttled (≥2 s) diagnostics export. Generates a structured JSON
 * snapshot for `device` via `deviceManager.generateDiagnostics()` and
 * writes it to `<prefix>.diag.result`. The trigger button state is
 * always reset to `false` so the next click works.
 *
 * @param adapter ioBroker adapter surface
 * @param deviceManager Device manager (caller-validated non-null)
 * @param lastRun Per-device throttle map (keyed by `sku:deviceId`)
 * @param device Target device
 * @param prefix Device state prefix (e.g. `devices.h61be_1d6f`)
 * @param triggerStateId Full state id of the button that triggered the export
 */
export async function handleDiagnosticsExport(
  adapter: DiagnosticsHandlerAdapter,
  deviceManager: DeviceManager,
  lastRun: Map<string, number>,
  device: GoveeDevice,
  prefix: string,
  triggerStateId: string,
): Promise<void> {
  const deviceKey = sessionKey(device.sku, device.deviceId);
  const now = Date.now();
  const last = lastRun.get(deviceKey) ?? 0;
  if (now - last < DIAGNOSTICS_EXPORT_THROTTLE_MS) {
    adapter.log.debug(`Diagnostics export throttled for ${deviceLabel(device)} — last run ${now - last}ms ago`);
    await adapter.setState(triggerStateId, { val: false, ack: true });
    return;
  }
  lastRun.set(deviceKey, now);
  const diag = deviceManager.generateDiagnostics(device, adapter.version ?? "unknown");
  const resultId = `${adapter.namespace}.${prefix}.diag.result`;
  await adapter.setState(resultId, {
    val: JSON.stringify(diag, null, 2),
    ack: true,
  });
  await adapter.setState(triggerStateId, { val: false, ack: true });
  adapter.log.info(`Diagnostics exported for ${deviceLabel(device)}`);
}
