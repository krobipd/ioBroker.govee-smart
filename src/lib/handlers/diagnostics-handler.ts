import type { DeviceManager } from "../device-manager";
import { deviceLabel, errText, type GoveeDevice } from "../types";
import { DIAGNOSTICS_EXPORT_THROTTLE_MS } from "../timing-constants";
import { sessionKey } from "../device-key";
import { isAppGroup } from "../govee-constants";
import type { ControlPathEntry, ObjectTreeEntry } from "../diagnostics";
import { resolveDeviceReachability } from "../device-manager/lookups";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { GoveeLanClient } from "../govee-lan-client";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import type { LocalSnapshotStore } from "../local-snapshots";
import type { ChannelStatusSnapshot } from "../log-prefix";
import type { RateLimiter } from "../rate-limiter";
import type { SegmentWizard } from "../segment-wizard";
import type { SkuCache } from "../sku-cache";
import { stateToCommand } from "./dropdown-reset-helpers";

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

/** js-controller and admin version of this installation. */
export interface HostVersions {
  /** js-controller version installed on the host. */
  jsController?: string;
  /** admin adapter version. */
  admin?: string;
}

/** What the diagnostics providers read from the running adapter. */
export interface DiagnosticsProvidersHost {
  readonly namespace: string;
  /** The ioBroker host this instance runs on. */
  readonly hostName: string;
  readonly deviceManager: DeviceManager | null;
  readonly skuCache: SkuCache | null;
  readonly localSnapshots: LocalSnapshotStore | null;
  readonly cloudClient: GoveeCloudClient | null;
  readonly mqttClient: GoveeMqttClient | null;
  readonly rateLimiter: RateLimiter | null;
  readonly lanClient: GoveeLanClient | null;
  readonly segmentWizard: SegmentWizard | null;
  readonly channelStatus: ChannelStatusSnapshot;
  readonly hostVersions: HostVersions;
  /** When this run started (ms). */
  readonly startedAt: number;
  /** The instance runs in compact mode. */
  readonly compactMode: boolean;
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  getObjectViewAsync(
    design: "system",
    search: "state",
    params: { startkey: string; endkey: string },
  ): Promise<{ rows: Array<{ id: string; value: ioBroker.Object | null }> } | null | undefined>;
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
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
 * @param prefix Device state prefix (e.g. `devices.h61be-1d6f`)
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
    // An app group has no `diag` channel (its tree carries only the fan-out
    // datapoints), but the card lists it and exports its report: stamping it
    // wrote into a missing object and js-controller warned on every export
    // (krobi's installation, 2.39.2).
    if (!isAppGroup(device)) {
      await adapter.setState(`${adapter.namespace}.${prefix}.diag.lastExport`, {
        val: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
        ack: true,
      });
    }
    adapter.log.info(`Diagnostics report for ${deviceLabel(device)} generated as ${fileName}`);
    return { fileName, content };
  } catch (e) {
    // An export that fails silently is the same dead end the old
    // copy-out-of-a-state flow was — say so in the log, and the card shows the
    // caller its own error.
    adapter.log.warn(`Diagnostics export for ${deviceLabel(device)} failed: ${errText(e)}`);
    return null;
  }
}

/**
 * js-controller and admin versions for the diagnostics report. Read once — a controller or admin update restarts
 * every instance, so these cannot go stale while the process lives; a failed read leaves them empty.
 *
 * @param host Adapter surface
 */
export async function readHostVersions(host: DiagnosticsProvidersHost): Promise<HostVersions> {
  const hostObj = await host.getForeignObjectAsync(`system.host.${host.hostName}`).catch(() => null);
  const admin = await host.getForeignObjectAsync("system.adapter.admin").catch(() => null);
  return {
    jsController: (hostObj?.common as { installedVersion?: string } | undefined)?.installedVersion,
    admin: (admin?.common as { version?: string } | undefined)?.version,
  };
}

/**
 * Wire the providers the report pulls at export time — persisted cache, local snapshots, runtime state, names,
 * environment, object tree, control paths. Pulled when a report is generated, so a wizard running THEN is captured
 * although the collector does not track it live.
 *
 * @param host Adapter surface
 */
export function wireDiagnosticsProviders(host: DiagnosticsProvidersHost): void {
  // v2.9.1 — wire diag providers so generate() can render persisted-cache,
  // local-snapshots and adapter-runtime state. Providers are pulled at
  // export time, so a wizard that's running THEN gets captured even
  // though the collector itself doesn't track it live.
  const diag = host.deviceManager!.getDiagnostics();
  diag.setCacheSnapshotProvider((sku, deviceId) => host.skuCache?.loadOne(sku, deviceId) ?? null);
  diag.setLocalSnapshotsProvider((sku, deviceId) => host.localSnapshots?.getSnapshots(sku, deviceId) ?? []);
  diag.setRuntimeStateProvider(() => {
    const errorCats = host.deviceManager?.getErrorCategorySnapshot();
    return {
      deviceManagerLastErrorCategory: errorCats?.deviceManager ?? null,
      appApiLastErrorCategory: errorCats?.appApi ?? null,
      groupMembersLastErrorCategory: errorCats?.groupMembers ?? null,
      cloudFailureReason: host.cloudClient?.getFailureReason() ?? null,
      mqttFailureReason: host.mqttClient?.getFailureReason() ?? null,
      rateLimiter: host.rateLimiter?.getUsageSnapshot() ?? null,
      cloudRateLimit: host.cloudClient?.getLastRateLimit() ?? null,
      wizardSession: host.segmentWizard?.getSessionSnapshot() ?? null,
      lanSeenDeviceIps: host.lanClient?.getDiagSnapshot().seenDeviceIps ?? [],
    };
  });
  // Device names have no detectable shape, so the pseudonymiser can only
  // replace the ones it is told about.
  diag.setDeviceNamesProvider(() => host.deviceManager?.getDevices().map(d => d.name) ?? []);
  // A group's id is digits only — no pattern finds it, so it goes by lookup too.
  diag.setDeviceIdsProvider(() => host.deviceManager?.getDevices().map(d => d.deviceId) ?? []);
  // Which ioBroker this runs on, and how the installation as a whole is
  // doing. Every field here used to be a follow-up question on a report —
  // and the issue forms dropped their Node field because it belongs in here.
  diag.setEnvironmentProvider(() => {
    const devices = host.deviceManager?.getDevices() ?? [];
    return {
      node: process.version,
      jsController: host.hostVersions.jsController,
      admin: host.hostVersions.admin,
      platform: `${process.platform} ${process.arch}`,
      compactMode: host.compactMode,
      credentialTier: host.mqttClient ? "account" : host.cloudClient ? "apiKey" : "lan",
      deviceCount: devices.length,
      reachableCount: devices.filter(d => resolveDeviceReachability(d).online).length,
      channels: { ...host.channelStatus },
      startedAt: new Date(host.startedAt).toISOString(),
    };
  });
  // The datapoints as they really exist — the answer to "this datapoint is
  // missing / has the wrong type / the wrong role", which the in-memory view
  // cannot give. Scoped to ONE device prefix, never a full-instance scan.
  diag.setObjectTreeProvider(prefix => readObjectTree(host, prefix));

  // How each writable datapoint is actually driven. The report carried the
  // capability list and the object tree — the two ends — but never the
  // routing between them, so "this control does nothing on my model" could
  // not be answered from a report. Asks the SAME function a real write asks,
  // so the answer cannot drift from the behaviour it describes; pure
  // decision-making, no I/O.
  diag.setControlPathProvider((device, stateIds) => {
    const router = host.deviceManager;
    if (!router) {
      return [];
    }
    const out: ControlPathEntry[] = [];
    for (const stateId of stateIds) {
      const command = stateToCommand(stateId);
      if (!command) {
        continue;
      }
      const decision = router.resolveTransport(device, command);
      out.push({ stateId, command, transport: decision.kind, reason: decision.reason });
    }
    return out;
  });
}

/**
 * The datapoints below ONE device prefix, with type, role, unit and current
 * value — the view the user actually sees in the object tree.
 *
 * Deliberately scoped to a single prefix: a full-instance scan is exactly
 * what 2.27.1 removed from the periodic round, and this runs behind a button
 * a user can press repeatedly. One export therefore reads one device's
 * subtree, never the whole instance.
 *
 * @param host Adapter surface
 * @param prefix Device prefix, e.g. `devices.h61be-1d6f`
 * @returns One entry per datapoint, or an empty list if the tree cannot be read
 */
export async function readObjectTree(host: DiagnosticsProvidersHost, prefix: string): Promise<ObjectTreeEntry[]> {
  const start = `${host.namespace}.${prefix}.`;
  const view = await host
    .getObjectViewAsync("system", "state", {
      startkey: start,
      endkey: `${start}\u9999`,
    })
    .catch(() => null);
  if (!view?.rows) {
    return [];
  }
  const entries: ObjectTreeEntry[] = [];
  for (const row of view.rows) {
    const localId = row.id.replace(`${host.namespace}.`, "");
    const common = row.value?.common as ioBroker.StateCommon | undefined;
    const state = await host.getStateAsync(localId).catch(() => null);
    entries.push({
      id: localId.replace(`${prefix}.`, ""),
      type: common?.type,
      role: common?.role,
      unit: common?.unit,
      write: common?.write,
      val: state?.val,
      ack: state?.ack,
    });
  }
  return entries;
}
