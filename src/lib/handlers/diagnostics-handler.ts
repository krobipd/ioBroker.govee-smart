import type { DeviceManager } from "../device-manager";
import { deviceLabel, errMessage, type GoveeDevice } from "../types";
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

/** One generated report: the name the download should carry and the JSON text. */
export interface DiagnosticsReport {
  fileName: string;
  content: string;
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
 * Throttled (≥2 s) diagnostics export. Generates the report for `device`,
 * hands it back as text under the file name the download should carry, and
 * stamps `<prefix>.diag.lastExport` with the time it ran.
 *
 * The report is NOT stored in the instance. It measured 67,917 characters on
 * an H61BE — past GitHub's 65,536-character issue body, so it could not be
 * pasted into the very issue it exists for, and as a state value it sat in the
 * state database and flowed through every history subscription on the device.
 * Until 2.36.0 it was also written as a file into a `diagnostics` meta object
 * at the root of the instance; nobody asked for that copy, it put a folder
 * next to the devices, and the card had the content in its answer all along.
 * Since 2.37.0 the answer is the only copy: the Expert card offers it as a
 * download and the user attaches it.
 *
 * Since 2.31.0 the export is started from the admin card only. The per-device
 * button datapoint is gone: it was a second, clumsier path to the same report —
 * flip a state, then go find the file — and the card does both in one press.
 *
 * @param adapter ioBroker adapter surface
 * @param deviceManager Device manager (caller-validated non-null)
 * @param lastRun Per-device throttle map (keyed by `sku:deviceId`)
 * @param device Target device
 * @param prefix Device state prefix (e.g. `devices.h61be_1d6f`)
 * @returns The report with its file name, or null when the export was throttled or failed
 */
export async function handleDiagnosticsExport(
  adapter: DiagnosticsHandlerAdapter,
  deviceManager: DeviceManager,
  lastRun: Map<string, number>,
  device: GoveeDevice,
  prefix: string,
): Promise<DiagnosticsReport | null> {
  const deviceKey = sessionKey(device.sku, device.deviceId);
  const now = Date.now();
  const last = lastRun.get(deviceKey) ?? 0;
  if (now - last < DIAGNOSTICS_EXPORT_THROTTLE_MS) {
    adapter.log.debug(`Diagnostics export throttled for ${deviceLabel(device)} — last run ${now - last}ms ago`);
    return null;
  }
  lastRun.set(deviceKey, now);
  const version = adapter.version ?? "unknown";
  const fileName = diagnosticsFileName(device, version, new Date(now));
  try {
    const diag = await deviceManager.generateDiagnostics(device, version, prefix);
    const content = JSON.stringify(diag, null, 2);
    // WHEN, not which file: the card hands the report over on the spot, so the
    // name says nothing a moment later — but "was a report taken since the
    // fault?" is a question the object tree can still answer. Seconds are
    // enough; ISO-8601 in UTC so it reads the same in every timezone and sorts.
    await adapter.setState(`${adapter.namespace}.${prefix}.diag.lastExport`, {
      val: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ack: true,
    });
    adapter.log.info(`Diagnostics report for ${deviceLabel(device)} generated as ${fileName}`);
    return { fileName, content };
  } catch (e) {
    // An export that fails silently is the same dead end the old
    // copy-out-of-a-state flow was — say so in the log, and the card shows the
    // caller its own error.
    adapter.log.warn(`Diagnostics export for ${deviceLabel(device)} failed: ${errMessage(e)}`);
    return null;
  }
}
