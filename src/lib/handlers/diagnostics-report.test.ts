import { describe, expect, it } from "vitest";
import { makeReportSource, type DiagnosticsReportAdapter } from "./diagnostics-report";
import { ReportJobs } from "../diagnostics/report-jobs";
import { DiagnosticsCollector } from "../diagnostics";
import { DeviceRegistry } from "../device-registry";
import type { GoveeDevice } from "../types";
import { mockLog } from "../../../test/test-helpers";

function light(extra: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:B2:4D",
    name: "Jennys Leselampe",
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: false },
    channels: { lan: false, mqtt: true, cloud: true },
    iotTopic: "GD/feedfacefeedfacefeedfacefeedface",
    ...extra,
  };
}

/** A device the resolver calls reachable: Govee reported it online a moment ago. */
const connected = (): GoveeDevice =>
  light({ state: { online: true, cloudReportedOnline: true, cloudReportedOnlineAt: Date.now() } });

function rig(
  devices: GoveeDevice[],
  opts: { answers?: boolean; cloudState?: unknown; cloudFails?: boolean } = {},
): { adapter: DiagnosticsReportAdapter; collector: DiagnosticsCollector; asked: string[]; cloudReads: string[] } {
  const collector = new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } }));
  collector.setDeviceNamesProvider(() => devices.map(d => d.name));
  const asked: string[] = [];
  const cloudReads: string[] = [];
  const adapter: DiagnosticsReportAdapter = {
    log: mockLog,
    version: "3.2.0",
    deviceManager: {
      getDevices: () => devices,
      getDiagnostics: () => collector,
      askStatus: (d: GoveeDevice, waitMs: number) => {
        asked.push(d.deviceId);
        // the device's answer lands in the rings while the report waits — it must not reach the frozen history
        collector.addLog(d.deviceId, "debug", "status packet during the live read");
        return Promise.resolve(
          opts.answers
            ? { sent: true, cmdVersion: 2, answeredAfterMs: Math.min(waitMs, 903) }
            : { sent: true, cmdVersion: 2 },
        );
      },
    } as never,
    stateManager: { devicePrefix: (d: GoveeDevice) => `devices.${d.sku.toLowerCase()}-b24d` } as never,
    cloudClient: {
      getDeviceState: (sku: string) => {
        cloudReads.push(sku);
        return opts.cloudFails ? Promise.reject(new Error("HTTP 503")) : Promise.resolve(opts.cloudState ?? []);
      },
    } as never,
    rateLimiter: null,
  };
  return { adapter, collector, asked, cloudReads };
}

async function fetch(jobs: ReportJobs<unknown>, device: string): Promise<{ fileName: string; content: string }> {
  const started = jobs.start(device) as { job: string };
  for (let n = 0; n < 100; n++) {
    const answer = jobs.result(started.job) as Record<string, unknown>;
    if (!answer.pending) {
      return answer as { fileName: string; content: string };
    }
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error("never ready");
}

describe("the govee report source behind the fleet's report jobs", () => {
  it("lists every real device with its reachability — app groups have no report", () => {
    const group = light({ sku: "BaseGroup", deviceId: "7654321", name: "Wohnzimmer" });
    const { adapter } = rig([light(), group]);
    expect(makeReportSource(adapter).devices()).toEqual([
      { id: "H6199:AA:BB:CC:DD:EE:FF:B2:4D", label: expect.stringContaining("H6199") as string, connected: false },
    ]);
  });

  it("an unconnected device is never read live — the report says so (DB-03)", async () => {
    const { adapter, asked, cloudReads } = rig([light()]);
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "H6199:AA:BB:CC:DD:EE:FF:B2:4D");
    const content = JSON.parse(report.content) as Record<string, unknown>;
    expect(asked).toEqual([]);
    expect(cloudReads).toEqual([]);
    expect(content.liveRead).toBe("not connected");
    expect(content.live).toBeUndefined();
  });

  it("a connected device is asked over the broker and the Cloud; the answers go into their own section (E1, E2)", async () => {
    const { adapter, collector } = rig([connected()], { answers: true, cloudState: [{ instance: "powerSwitch" }] });
    collector.addLog("AA:BB:CC:DD:EE:FF:B2:4D", "info", "before the report");
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "H6199:AA:BB:CC:DD:EE:FF:B2:4D");
    const content = JSON.parse(report.content) as {
      liveRead: string;
      live: { statusRequest: { answeredAfterMs: number }; cloudState: { capabilities: unknown } };
      recentLogs: Array<{ msg: string }>;
    };
    expect(content.liveRead).toBe("read");
    expect(content.live.statusRequest.answeredAfterMs).toBe(903);
    expect(content.live.cloudState.capabilities).toEqual([{ instance: "powerSwitch" }]);
    // the history as it stood before the read
    expect(content.recentLogs.map(l => l.msg)).toEqual(["before the report"]);
  });

  it("a connected device that answers nothing gives a failed read, never `read` (DB-02)", async () => {
    const { adapter } = rig([connected()], { answers: false, cloudFails: true });
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "H6199:AA:BB:CC:DD:EE:FF:B2:4D");
    const content = JSON.parse(report.content) as { liveRead: string; live: { error: string } };
    expect(content.liveRead).toBe("failed");
    expect(content.live.error).toContain("no answer");
  });

  it("the file is named by the tree id through the same placeholders, and the content keeps no personal value", async () => {
    const { adapter } = rig([light()]);
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "H6199:AA:BB:CC:DD:EE:FF:B2:4D");
    expect(report.fileName).toMatch(/^govee-smart_h6199-b24d_v3\.2\.0_\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
    expect(report.content).not.toContain("Jennys Leselampe");
    expect(report.content).not.toContain("AA:BB:CC:DD:EE:FF:B2:4D");
    expect(report.content).not.toContain("feedfacefeedface");
  });
});
