import type { DeviceManager } from "../device-manager";
import { deviceLabel, type GoveeDevice } from "../types";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS, DIAGNOSTICS_KEEP_PER_DEVICE } from "../timing-constants";
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
  /** Writes into the `<namespace>.diagnostics` meta.user object. */
  writeFileAsync(meta: string, name: string, data: Buffer | string): Promise<void>;
  /** Lists what the meta object already holds, for pruning older reports. */
  readDirAsync(meta: string, path: string): Promise<{ file: string; isDir: boolean }[]>;
  /** Removes a superseded report. */
  delFileAsync(meta: string, name: string): Promise<void>;
}

/**
 * File name for one report. It has to explain itself to a stranger: the person
 * who receives it has none of our context, and a reporter with two Govee
 * devices will attach two of these. Model and the device's last four
 * characters (the same four the object tree uses as a folder name) make them
 * tellable apart at a glance; adapter version and date say what was measured
 * when.
 *
 * @param device The device being reported on
 * @param adapterVersion Adapter version producing the report
 * @param now Timestamp of the export
 */
export function diagnosticsFileName(device: GoveeDevice, adapterVersion: string, now: Date): string {
  const shortId = device.deviceId.replace(/:/g, "").slice(-4).toLowerCase();
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `govee-smart_${device.sku}_${shortId}_v${adapterVersion}_${day}_${time}.json`;
}

/**
 * Drop all but the newest {@link DIAGNOSTICS_KEEP_PER_DEVICE} reports for one
 * device. Without this the folder grows with every button press — the export
 * is throttled against spam, not against accumulation.
 *
 * The file name starts with model + short id, so a plain prefix match selects
 * exactly this device's reports, and the timestamp inside the name sorts them.
 *
 * @param adapter ioBroker adapter surface
 * @param meta Meta object id holding the reports
 * @param device The device whose older reports should go
 */
async function pruneOlderReports(adapter: DiagnosticsHandlerAdapter, meta: string, device: GoveeDevice): Promise<void> {
  const shortId = device.deviceId.replace(/:/g, "").slice(-4).toLowerCase();
  const prefix = `govee-smart_${device.sku}_${shortId}_`;
  // readDirAsync throws while the meta object holds nothing yet — first export.
  const entries = await adapter.readDirAsync(meta, "").catch(() => []);
  const mine = entries
    .filter(e => !e.isDir && e.file.startsWith(prefix))
    .map(e => e.file)
    .sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - DIAGNOSTICS_KEEP_PER_DEVICE))) {
    await adapter.delFileAsync(meta, stale).catch(() => undefined);
  }
}

/**
 * Throttled (≥2 s) diagnostics export. Writes the report for `device` as a
 * FILE into the `<namespace>.diagnostics` meta object and points
 * `<prefix>.diag.lastExport` at it. The trigger state is always reset to
 * `false` so the next click works.
 *
 * Why a file and not a state: the report measured 67,917 characters on an
 * H61BE. That is past GitHub's 65,536-character issue body, so it could not be
 * pasted into the very issue it exists for — and as a state value it sat in the
 * state database and flowed through every history subscription on the device.
 * As a file the user downloads it from the adapter's Diagnostics tab (or the
 * admin file browser) and attaches it.
 *
 * @param adapter ioBroker adapter surface
 * @param deviceManager Device manager (caller-validated non-null)
 * @param lastRun Per-device throttle map (keyed by `sku:deviceId`)
 * @param device Target device
 * @param prefix Device state prefix (e.g. `devices.h61be_1d6f`)
 * @param triggerStateId Full state id of the button that triggered the export
 * @returns The file name written, or null when the export was throttled or failed
 */
export async function handleDiagnosticsExport(
  adapter: DiagnosticsHandlerAdapter,
  deviceManager: DeviceManager,
  lastRun: Map<string, number>,
  device: GoveeDevice,
  prefix: string,
  triggerStateId: string,
): Promise<string | null> {
  const deviceKey = sessionKey(device.sku, device.deviceId);
  const now = Date.now();
  const last = lastRun.get(deviceKey) ?? 0;
  if (now - last < DIAGNOSTICS_EXPORT_THROTTLE_MS) {
    adapter.log.debug(`Diagnostics export throttled for ${deviceLabel(device)} — last run ${now - last}ms ago`);
    await adapter.setState(triggerStateId, { val: false, ack: true });
    return null;
  }
  lastRun.set(deviceKey, now);
  const version = adapter.version ?? "unknown";
  const meta = `${adapter.namespace}.diagnostics`;
  const fileName = diagnosticsFileName(device, version, new Date(now));
  try {
    const diag = await deviceManager.generateDiagnostics(device, version, prefix);
    await adapter.writeFileAsync(meta, fileName, JSON.stringify(diag, null, 2));
    await pruneOlderReports(adapter, meta, device);
    await adapter.setState(`${adapter.namespace}.${prefix}.diag.lastExport`, { val: fileName, ack: true });
    adapter.log.info(`Diagnostics report for ${deviceLabel(device)} written to ${fileName}`);
    return fileName;
  } catch (e) {
    // The button must never leave the user with a stuck `true` and no word on
    // why — an export that fails silently is the same dead end the old
    // copy-out-of-a-state flow was.
    adapter.log.warn(
      `Diagnostics export for ${deviceLabel(device)} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  } finally {
    await adapter.setState(triggerStateId, { val: false, ack: true });
  }
}
