// The govee side of the fleet's diagnostics report (master `diagnostics/report-jobs.ts`): its devices, the live read
// when the report is asked for (krobi 2026-10-06, E1 and E2 — only for a connected device, DB-03; the answers go into
// the report and change nothing else), and the report body with its placeholders.
import type { DeviceManager } from "../device-manager";
import type { FrozenBuffers, LogMentions } from "../diagnostics";
import type { ReportBody, ReportSource, ReportSourceDevice } from "../diagnostics/report-jobs";
import type { GoveeCloudClient } from "../govee-cloud-client";
import { isAppGroup } from "../govee-constants";
import { resolveDeviceReachability } from "../device-manager/lookups";
import { applianceBudget, limiterDeviceKey, type RateLimiter } from "../rate-limiter";
import type { StateManager } from "../state-manager";
import { REPORT_STATUS_WAIT_MS } from "../timing-constants";
import { deviceLabel, errText, type GoveeDevice } from "../types";

/** What the report's live read found. */
export type LiveReading = Record<string, unknown>;

/** Adapter surface of the report source. */
export interface DiagnosticsReportAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The adapter version. */
  readonly version?: string;
  /** The device manager — null until the start built it. */
  readonly deviceManager: DeviceManager | null;
  /** The state manager — null until the start built it. */
  readonly stateManager: StateManager | null;
  /** The Cloud REST client — null without an API key. */
  readonly cloudClient: GoveeCloudClient | null;
  /** The Cloud rate limiter. */
  readonly rateLimiter: RateLimiter | null;
}

/**
 * The key a device is listed and reported under — the same `sku:deviceId` the card always used.
 *
 * @param device The device
 */
function reportKey(device: GoveeDevice): string {
  return `${device.sku}:${device.deviceId}`;
}

/**
 * The strings that name a device in a log line: its id, its key, its name and its address.
 *
 * @param device The device
 */
function mentionsOf(device: GoveeDevice): string[] {
  return [device.deviceId, reportKey(device), device.name, device.lanIp ?? ""].filter(m => m.length > 0);
}

/**
 * The adapter's side of the report jobs.
 *
 * @param adapter The adapter surface
 */
export function makeReportSource(adapter: DiagnosticsReportAdapter): ReportSource<LiveReading> {
  /** Buffers frozen when the live read starts, handed to the build of the same report. */
  const frozen = new Map<string, FrozenBuffers | undefined>();
  const find = (id: string): GoveeDevice | undefined =>
    adapter.deviceManager?.getDevices().find(d => !isAppGroup(d) && reportKey(d) === id);
  const mentions = (device: GoveeDevice): LogMentions => ({
    mine: mentionsOf(device),
    others: (adapter.deviceManager?.getDevices() ?? []).filter(d => d !== device).flatMap(mentionsOf),
  });

  return {
    adapter: "govee-smart",
    get version(): string {
      return adapter.version ?? "unknown";
    },
    log: adapter.log,

    devices(): ReportSourceDevice[] {
      // Every real device, reachable or not — a report is wanted when a device misbehaves. App groups have no report.
      return (adapter.deviceManager?.getDevices() ?? [])
        .filter(d => !isAppGroup(d))
        .map(d => ({ id: reportKey(d), label: deviceLabel(d), connected: resolveDeviceReachability(d).online }));
    },

    async readLive(id: string): Promise<LiveReading> {
      const device = find(id);
      const dm = adapter.deviceManager;
      if (!device || !dm) {
        throw new Error("the device is gone");
      }
      // The history as it stood before the read — the read's own answers never push it out of the rings.
      frozen.set(id, dm.getDiagnostics().freeze(device.deviceId, mentions(device)));
      const [status, cloud, libraries] = await Promise.all([
        askBroker(dm, device),
        readCloud(adapter, device),
        dm.readLibrariesLive(device),
      ]);
      // Govee's answers beside the stored ones — the report shows disk, memory, the last answer and this one (E5)
      const reading: LiveReading = { statusRequest: status, cloudState: cloud, libraries };
      if (status.answeredAfterMs === undefined && cloud.capabilities === undefined) {
        // Nothing answered: a failed read, never `read` (DB-02). The details stay in the error text of the report.
        throw new Error(`no answer — status request: ${JSON.stringify(status)}; cloud state: ${JSON.stringify(cloud)}`);
      }
      return reading;
    },

    async build(id: string, live: LiveReading | undefined, liveError: string | undefined): Promise<ReportBody> {
      const device = find(id);
      const dm = adapter.deviceManager;
      if (!device || !dm || !adapter.stateManager) {
        throw new Error("the device is gone");
      }
      const prefix = adapter.stateManager.devicePrefix(device);
      const kept = frozen.get(id);
      frozen.delete(id);
      const { content, fileId } = await dm
        .getDiagnostics()
        .generateReport(device, adapter.version ?? "unknown", prefix, {
          frozen: kept,
          live: live ?? (liveError !== undefined ? { error: liveError } : undefined),
          treeId: prefix.slice(prefix.lastIndexOf(".") + 1),
          mentions: mentions(device),
        });
      return { fileId, content };
    },
  };
}

/**
 * E1: the status request over the account broker, and how long the device took to answer.
 *
 * @param dm The device manager
 * @param device The device
 */
async function askBroker(dm: DeviceManager, device: GoveeDevice): Promise<Record<string, unknown>> {
  if (!device.iotTopic) {
    return { sent: false, why: "the device has no topic on the account broker (no Govee account, or not in the list)" };
  }
  const result = await dm.askStatus(device, REPORT_STATUS_WAIT_MS);
  return {
    ...result,
    waitedMs: REPORT_STATUS_WAIT_MS,
    ...(result.sent && result.answeredAfterMs === undefined
      ? { note: "no answer — not proof of a power cut: a wrong statusCmdVersion is answered with silence too" }
      : {}),
    ...(!result.sent ? { why: "the account broker is not connected" } : {}),
  };
}

/**
 * E2: Govee's state answer for the device, fresh — through the rate limiter, counted against an appliance's daily
 * budget like every call. It goes into the report only; nothing is applied.
 *
 * @param adapter The adapter surface
 * @param device The device
 */
async function readCloud(adapter: DiagnosticsReportAdapter, device: GoveeDevice): Promise<Record<string, unknown>> {
  const cloud = adapter.cloudClient;
  if (!cloud || !device.channels.cloud) {
    return { asked: false, why: "no Cloud channel for this device (no API key, or the device is not in Govee's list)" };
  }
  try {
    let capabilities: unknown;
    const read = async (): Promise<void> => {
      capabilities = await cloud.getDeviceState(device.sku, device.deviceId);
    };
    if (adapter.rateLimiter) {
      await adapter.rateLimiter.executeTracked(
        read,
        { kind: "device-read", deviceKey: limiterDeviceKey(device) },
        1,
        applianceBudget(device),
      );
    } else {
      await read();
    }
    return {
      asked: true,
      capabilities,
      note: "for a device Govee reports offline, these are the values of its last contact",
    };
  } catch (e) {
    return { asked: true, error: errText(e) };
  }
}
