import type { DeviceManager } from "../device-manager";
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

/** js-controller and admin version of this installation. */
export interface HostVersions {
  /** js-controller version installed on the host. */
  jsController?: string;
  /** admin adapter version. */
  admin?: string;
}

/** What the diagnostics providers read from the running adapter. */
export interface DiagnosticsProvidersHost {
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** The ioBroker host this instance runs on. */
  readonly hostName: string;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The SKU cache of the instance. */
  readonly skuCache: SkuCache | null;
  /** The store of local snapshots. */
  readonly localSnapshots: LocalSnapshotStore | null;
  /** The Cloud REST client — null without an API key. */
  readonly cloudClient: GoveeCloudClient | null;
  /** The account broker client — null without a Govee account. */
  readonly mqttClient: GoveeMqttClient | null;
  /** The Cloud rate limiter. */
  readonly rateLimiter: RateLimiter | null;
  /** The LAN client. */
  readonly lanClient: GoveeLanClient | null;
  /** The running segment wizard — null while none runs. */
  readonly segmentWizard: SegmentWizard | null;
  /** The channel status the log prefix shows. */
  readonly channelStatus: ChannelStatusSnapshot;
  /** The js-controller and admin versions of the host. */
  readonly hostVersions: HostVersions;
  /** When this run started (ms). */
  readonly startedAt: number;
  /** The instance runs in compact mode. */
  readonly compactMode: boolean;
  /** Read one object by its full id. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Read objects through a view. */
  getObjectViewAsync(
    design: "system",
    search: "state",
    params: { startkey: string; endkey: string },
  ): Promise<{ rows: Array<{ id: string; value: ioBroker.Object | null }> } | null | undefined>;
  /** Read one own state. */
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  /** Read the states matching a pattern of full ids in one call. */
  getForeignStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
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
  // One read for every value of the subtree (plan G8) — one call per datapoint was a hundred round trips on a strip.
  const states: Record<string, ioBroker.State | null | undefined> =
    (await host.getForeignStatesAsync(`${start}*`).catch(() => null)) ?? {};
  const entries: ObjectTreeEntry[] = [];
  for (const row of view.rows) {
    const localId = row.id.replace(`${host.namespace}.`, "");
    const common = row.value?.common as ioBroker.StateCommon | undefined;
    const state = states[row.id];
    entries.push({
      id: localId.replace(`${prefix}.`, ""),
      type: common?.type,
      role: common?.role,
      unit: common?.unit,
      read: common?.read,
      write: common?.write,
      ...(common?.min !== undefined ? { min: common.min } : {}),
      ...(common?.max !== undefined ? { max: common.max } : {}),
      ...(common?.step !== undefined ? { step: common.step } : {}),
      ...(common?.states !== undefined ? { states: common.states } : {}),
      val: state?.val,
      ack: state?.ack,
    });
  }
  return entries;
}
