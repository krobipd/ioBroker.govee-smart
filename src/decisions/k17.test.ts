// K17 — A mode change sets the other mode selections to "---" (pick a scene and, for example, the music mode jumps to "---").
// krobi 2026-10-08 09:53: "k17 yes"
import { describe, expect, it } from "vitest";
import { resetAfterWrite, type GroupStateHelpersAdapter } from "../lib/handlers/dropdown-reset-helpers";

const PREFIX = "devices.h6199-0017";
const MODES = [
  "scenes.light_scene",
  "scenes.diy_scene",
  "snapshots.snapshot_cloud",
  "snapshots.snapshot_local",
  "music.music_mode",
];

/** Every mode dropdown currently shows a selection. */
function rig(): { adapter: GroupStateHelpersAdapter; values: Map<string, unknown> } {
  const values = new Map<string, unknown>(MODES.map(m => [`govee-smart.0.${PREFIX}.${m}`, "3"]));
  const adapter: GroupStateHelpersAdapter = {
    namespace: "govee-smart.0",
    getStateAsync: id => Promise.resolve(values.has(id) ? ({ val: values.get(id) } as ioBroker.State) : null),
    setState: (id, state) => {
      values.set(id, (state as { val: unknown }).val);
      return Promise.resolve();
    },
  };
  return { adapter, values };
}

const at = (m: string): string => `govee-smart.0.${PREFIX}.${m}`;

describe("K17 a mode change resets the other mode selections", () => {
  it("choosing a scene sets music mode, DIY scene and both snapshots to '---' and keeps the scene", async () => {
    const { adapter, values } = rig();
    await resetAfterWrite(adapter, PREFIX, "scenes.light_scene", "3");
    expect(values.get(at("scenes.light_scene"))).toBe("3");
    for (const other of MODES.filter(m => m !== "scenes.light_scene")) {
      expect(values.get(at(other)), other).toBe("0");
    }
  });

  it("choosing a music mode sets the scene to '---' and keeps the music mode", async () => {
    const { adapter, values } = rig();
    await resetAfterWrite(adapter, PREFIX, "music.music_mode", "3");
    expect(values.get(at("music.music_mode"))).toBe("3");
    expect(values.get(at("scenes.light_scene"))).toBe("0");
  });

  it("a music sensitivity change is no mode change and resets nothing (positive control)", async () => {
    const { adapter, values } = rig();
    await resetAfterWrite(adapter, PREFIX, "music.music_sensitivity", 50);
    for (const m of MODES) {
      expect(values.get(at(m)), m).toBe("3");
    }
  });
});
