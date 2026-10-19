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
 * The `sku:deviceId` key the adapter's log lines name a device by.
 *
 * @param device The device
 */
function logKey(device: GoveeDevice): string {
  return `${device.sku}:${device.deviceId}`;
}

/**
 * The id a device is listed and reported under — its device id in the tree (`h6199-b24d`), the one the report's file
 * name carries (DB-12, krobi 2026-10-06 19:07: one file name for every adapter, its device part the id the card lists).
 *
 * @param adapter The adapter surface
 * @param device The device
 */
function reportId(adapter: DiagnosticsReportAdapter, device: GoveeDevice): string {
  const prefix = adapter.stateManager?.devicePrefix(device);
  return prefix ? prefix.slice(prefix.lastIndexOf(".") + 1) : logKey(device);
}

/**
 * The strings that name a device in a log line: its id, its key, its tree id, its name and its address.
 *
 * The tree id matters most: the start logs every device by it (`createStates [Cloud H14C0] devices.h14c0-44b0: …`).
 * Without it, 59 of 234 and 82 of 281 lines in two reports (#56/#57, 2026-10-18) belonged to other devices.
 *
 * @param adapter The adapter surface
 * @param device The device
 */
function mentionsOf(adapter: DiagnosticsReportAdapter, device: GoveeDevice): string[] {
  return [device.deviceId, logKey(device), reportId(adapter, device), device.name, device.lanIp ?? ""].filter(
    m => m.length > 0,
  );
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
    adapter.deviceManager?.getDevices().find(d => !isAppGroup(d) && reportId(adapter, d) === id);
  const mentions = (device: GoveeDevice): LogMentions => {
    const others = (adapter.deviceManager?.getDevices() ?? []).filter(d => d !== device);
    return {
      mine: mentionsOf(adapter, device),
      // A line naming only a model (`H6003: brokenPlatformApi quirk active`) is another device's when the model is not
      // this one's; a line naming this device's own model may be about it or its twin and stays.
      others: [
        ...others.flatMap(d => mentionsOf(adapter, d)),
        ...new Set(others.map(d => d.sku).filter(sku => sku !== device.sku)),
      ],
    };
  };

  return {
    adapter: "govee-smart",
    get version(): string {
      return adapter.version ?? "unknown";
    },
    // read when a report is made: the source is built in the adapter's constructor, before js-controller hands over the log
    get log(): ioBroker.Logger {
      return adapter.log;
    },

    devices(): ReportSourceDevice[] {
      // Every real device, reachable or not — a report is wanted when a device misbehaves. App groups have no report.
      return (adapter.deviceManager?.getDevices() ?? [])
        .filter(d => !isAppGroup(d))
        .map(d => ({
          id: reportId(adapter, d),
          label: deviceLabel(d),
          connected: resolveDeviceReachability(d).online,
        }));
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
  // Keys, not sentences: what a reason means stands in the adapter's CLAUDE.md, not in every report.
  if (!device.iotTopic) {
    return { sent: false, reason: "noTopic" };
  }
  const result = await dm.askStatus(device, REPORT_STATUS_WAIT_MS);
  return { ...result, waitedMs: REPORT_STATUS_WAIT_MS, ...(!result.sent ? { reason: "brokerDown" } : {}) };
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
    return { asked: false, reason: "noCloudChannel" };
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
    return { asked: true, capabilities };
  } catch (e) {
    return { asked: true, error: errText(e) };
  }
}
