import { describe, expect, it } from "vitest";
import { makeReportSource, type DiagnosticsReportAdapter } from "./diagnostics-report";
import { ReportJobs } from "../diagnostics/report-jobs";
import { DiagnosticsCollector } from "../diagnostics";
import { DeviceRegistry } from "../device-registry";
import type { GoveeDevice } from "../types";
import { mockLog } from "../../../test/test-helpers";
import { LogRing } from "../diagnostics/log-ring";

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
      readLibrariesLive: () => Promise.resolve({ sceneLibrary: [{ name: "Aurora", sceneCode: 2981 }] }),
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
    stateManager: {
      devicePrefix: (d: GoveeDevice) =>
        `devices.${d.sku.toLowerCase()}-${d.deviceId.replace(/:/g, "").slice(-4).toLowerCase()}`,
    } as never,
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
      { id: "h6199-b24d", label: expect.stringContaining("H6199") as string, connected: false },
    ]);
  });

  it("is built before the adapter has its log — and logs through the log it gets later", async () => {
    const { adapter } = rig([light()]);
    const host = { ...adapter, log: undefined as unknown as ioBroker.Logger };
    const source = makeReportSource(host);
    const infos: string[] = [];
    host.log = { ...adapter.log, info: (m: string) => infos.push(m) };
    await fetch(new ReportJobs(source), "h6199-b24d");
    expect(infos.some(m => m.includes("diagnostics report ready"))).toBe(true);
  });

  it("an unconnected device is never read live — the report says so (DB-03)", async () => {
    const { adapter, asked, cloudReads } = rig([light()]);
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "h6199-b24d");
    const content = JSON.parse(report.content) as Record<string, unknown>;
    expect(asked).toEqual([]);
    expect(cloudReads).toEqual([]);
    expect(content.liveRead).toBe("not connected");
    expect(content.live).toBeUndefined();
  });

  it("a connected device is asked over the broker and the Cloud; the answers go into their own section (E1, E2)", async () => {
    const { adapter, collector } = rig([connected()], { answers: true, cloudState: [{ instance: "powerSwitch" }] });
    collector.addLog("AA:BB:CC:DD:EE:FF:B2:4D", "info", "before the report");
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "h6199-b24d");
    const content = JSON.parse(report.content) as {
      liveRead: string;
      live: { statusRequest: { answeredAfterMs: number }; cloudState: { capabilities: unknown } };
      recentLogs: Array<{ msg: string }>;
    };
    expect(content.liveRead).toBe("read");
    expect(content.live.statusRequest.answeredAfterMs).toBe(903);
    expect(content.live.cloudState.capabilities).toEqual([{ instance: "powerSwitch" }]);
    // Govee's libraries fresh beside the stored ones (E5)
    expect((content.live as unknown as { libraries: unknown }).libraries).toEqual({
      sceneLibrary: [{ name: "Aurora", sceneCode: 2981 }],
    });
    // the history as it stood before the read
    expect(content.recentLogs.map(l => l.msg)).toEqual(["before the report"]);
  });

  it("a connected device that answers nothing gives a failed read, never `read` (DB-02)", async () => {
    const { adapter } = rig([connected()], { answers: false, cloudFails: true });
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "h6199-b24d");
    const content = JSON.parse(report.content) as { liveRead: string; live: { error: string } };
    expect(content.liveRead).toBe("failed");
    expect(content.live.error).toContain("no answer");
  });

  it("the file is named by the tree id through the same placeholders, and the content keeps no personal value", async () => {
    const { adapter } = rig([light()]);
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "h6199-b24d");
    expect(report.fileName).toMatch(/^govee-smart_h6199-b24d_v3\.2\.0_\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
    expect(report.content).not.toContain("Jennys Leselampe");
    expect(report.content).not.toContain("AA:BB:CC:DD:EE:FF:B2:4D");
    expect(report.content).not.toContain("feedfacefeedface");
  });

  it("the log lines of other devices stay out — told apart by their tree id and model (#56/#57)", async () => {
    // Lines as the H6199 report of #57 carried them (3.2.1, 2026-10-18): 82 of its 281 log lines named another
    // device by its tree id or its model only. A twin of the same model is told apart by the tree id alone.
    const me = connected();
    const other = light({ sku: "H14C0", deviceId: "AA:BB:CC:DD:EE:FF:44:B0", name: "Stehlampe" });
    const twin = light({ deviceId: "AA:BB:CC:DD:EE:FF:23:5C", name: "Zweite Lampe" });
    const { adapter, collector } = rig([me, other, twin], { answers: true });
    const ring = new LogRing();
    for (const line of [
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] createStates [Cloud H14C0] devices.h14c0-44b0: 12 states in 4 channel(s)",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] H14C0: brokenPlatformApi quirk active — skipping capability-derived states",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] createStates [Cloud H6199] devices.h6199-235c: 18 states in 5 channel(s)",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] createStates [Cloud H6199] devices.h6199-b24d: 18 states in 5 channel(s)",
      "[LAN=on Cloud=on MQTT=on OpenAPI=on] H6199 has known broken platform API metadata — capabilities may be incomplete",
      "[LAN=on Cloud=on MQTT=on OpenAPI=on] Cloud API: POST /router/api/v1/device/state auth=apiKey",
    ]) {
      ring.add("debug", line);
    }
    collector.setLogRing(ring);
    const report = await fetch(new ReportJobs(makeReportSource(adapter)), "h6199-b24d");
    const logs = (JSON.parse(report.content) as { adapterLog: Array<{ msg: string }> }).adapterLog.map(l => l.msg);
    // its own line, a line naming only its own model (it or its twin) and the adapter-wide one stay; the channel
    // prefix stands only where it changed
    expect(logs).toEqual([
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] createStates [Cloud H6199] devices.h6199-b24d: 18 states in 5 channel(s)",
      "[LAN=on Cloud=on MQTT=on OpenAPI=on] H6199 has known broken platform API metadata — capabilities may be incomplete",
      "Cloud API: POST /router/api/v1/device/state auth=apiKey",
    ]);
  });

  it("a live read that cannot run names its reason as a key, never a sentence", async () => {
    // Until 3.2.1 every such report carried the same explaining sentence (krobi 2026-10-20: "keinen dummy text").
    const noTopic = connected();
    delete noTopic.iotTopic;
    const one = rig([noTopic], { cloudFails: true });
    const a = JSON.parse((await fetch(new ReportJobs(makeReportSource(one.adapter)), "h6199-b24d")).content) as {
      live: { error: string };
    };
    expect(a.live.error).toContain('"reason":"noTopic"');

    const down = rig([connected()], { cloudState: [{ instance: "powerSwitch" }] });
    (down.adapter.deviceManager as unknown as { askStatus: () => Promise<unknown> }).askStatus = () =>
      Promise.resolve({ sent: false });
    const b = JSON.parse((await fetch(new ReportJobs(makeReportSource(down.adapter)), "h6199-b24d")).content) as {
      live: { statusRequest: Record<string, unknown>; cloudState: Record<string, unknown> };
    };
    expect(b.live.statusRequest).toEqual({ sent: false, waitedMs: expect.any(Number) as number, reason: "brokerDown" });
    expect(b.live.cloudState).toEqual({ asked: true, capabilities: [{ instance: "powerSwitch" }] });

    const noCloud = rig([connected()], { answers: true });
    const withoutCloud: DiagnosticsReportAdapter = { ...noCloud.adapter, cloudClient: null };
    const c = JSON.parse((await fetch(new ReportJobs(makeReportSource(withoutCloud)), "h6199-b24d")).content) as {
      live: { cloudState: Record<string, unknown> };
    };
    expect(c.live.cloudState).toEqual({ asked: false, reason: "noCloudChannel" });
  });
});
