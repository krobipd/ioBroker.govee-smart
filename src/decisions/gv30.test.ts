// GV-30 (govee part) — Names the user gives stand in the diagnostics report only as placeholders. For govee: the own
// snapshot and DIY names. Govee's own scene names stay readable.
// krobi 2026-10-06 17:21 (yamaha, the newer decision counts): "the times change, my decisions change"; 2026-10-08 09:39:
// "gv30 ok"
import { describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "../lib/diagnostics";
import { DeviceRegistry } from "../lib/device-registry";
import type { GoveeDevice } from "../lib/types";

const OWN = { cloudSnapshot: "Abend mit Oma", diyScene: "Lenas Geburtstag", localSnapshot: "Kinoabend Huber" };

function light(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:30",
    name: "Strip",
    type: "devices.types.light",
    capabilities: [],
    scenes: [{ name: "Aurora", value: 1 }],
    diyScenes: [{ name: OWN.diyScene, value: 4711 }],
    snapshots: [{ name: OWN.cloudSnapshot, value: 815 }],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: false, cloud: true },
  };
}

async function report(): Promise<string> {
  const c = new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } }));
  c.setLocalSnapshotsProvider(() => [{ name: OWN.localSnapshot, power: true }]);
  return JSON.stringify(await c.generate(light(), "3.2.0"));
}

describe("GV-30 own snapshot and DIY names stand in the report only as placeholders", () => {
  for (const [what, name] of Object.entries(OWN)) {
    it(`the ${what} name "${name}" is not in the report`, async () => {
      expect((await report()).toLowerCase()).not.toContain(name.toLowerCase());
    });
  }

  it("a name only Govee's live answer carries is not in the report either", async () => {
    const c = new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } }));
    const live = {
      libraries: {
        cloudScenes: { lightScenes: [], snapshots: [{ name: "Omas Sonntag", value: 816 }], diyScenes: [] },
        cloudDiyScenes: [{ name: "Lenas Party", value: 4713 }],
        snapshotPackets: [{ name: "Fernsehabend Huber", bleCmds: [["MwUB"]] }],
      },
    };
    const text = JSON.stringify((await c.generateReport(light(), "3.2.0", undefined, { live })).content);
    for (const name of ["Omas Sonntag", "Lenas Party", "Fernsehabend Huber"]) {
      expect(text.toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  it("Govee's own scene name stays readable (positive control)", async () => {
    expect(await report()).toContain("Aurora");
  });
});
