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

/**
 * The first value under `key` anywhere in a parsed report.
 *
 * @param node the report or a part of it
 * @param key the key looked for
 */
function find(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, key);
      if (hit !== undefined) {
        return hit;
      }
    }
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (key in obj) {
      return obj[key];
    }
    for (const child of Object.values(obj)) {
      const hit = find(child, key);
      if (hit !== undefined) {
        return hit;
      }
    }
  }
  return undefined;
}

/** Where each own name stands in the report — the place its mark has to take. */
const PLACE: Record<keyof typeof OWN, (r: unknown) => unknown> = {
  cloudSnapshot: r => (find(r, "snapshots") as { names: unknown[] }).names[0],
  diyScene: r => (find(r, "diyScenes") as { names: unknown[] }).names[0],
  localSnapshot: r => (find(r, "localSnapshots") as Array<{ name: unknown }>)[0].name,
};

const MARK = /^name-\d+$/;

describe("GV-30 own snapshot and DIY names stand in the report only as placeholders", () => {
  for (const [what, name] of Object.entries(OWN) as Array<[keyof typeof OWN, string]>) {
    it(`the ${what} name "${name}" is not in the report — its mark stands in its place`, async () => {
      const text = await report();
      expect(text.toLowerCase()).not.toContain(name.toLowerCase());
      expect(PLACE[what](JSON.parse(text))).toMatch(MARK);
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
    const content = (await c.generateReport(light(), "3.2.0", undefined, { live })).content;
    const text = JSON.stringify(content);
    for (const name of ["Omas Sonntag", "Lenas Party", "Fernsehabend Huber"]) {
      expect(text.toLowerCase()).not.toContain(name.toLowerCase());
    }
    // the live section is there, and each name's place holds a mark
    const libraries = (content.live as { libraries: typeof live.libraries }).libraries;
    expect(libraries.cloudScenes.snapshots[0].name).toMatch(MARK);
    expect(libraries.cloudDiyScenes[0].name).toMatch(MARK);
    expect(libraries.snapshotPackets[0].name).toMatch(MARK);
  });

  it("Govee's own scene name stays readable (positive control)", async () => {
    expect(await report()).toContain("Aurora");
  });
});
