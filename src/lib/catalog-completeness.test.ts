import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const INVENTORY = join(root, "test", "objects.inventory.json");

/**
 * Datapoints whose NAME already says everything — an invented sentence would be
 * worse than none (krobi's rule: `common.desc` is an explanation, and stays
 * EMPTY where the adapter has nothing to explain). Grouped by the reason, so
 * the next reader can judge the call instead of trusting it.
 *
 * The ids are namespace-free and collapsed: the device folder becomes `<dev>`,
 * a group `<grp>`, a segment index `<n>` — one entry per datapoint KIND, not one
 * per device.
 */
const SELF_EXPLAINING = new Set<string>([
  // Plain identification of the hardware — the label is the whole content.
  "devices.<dev>.info.model",
  "devices.<dev>.info.name",
  "devices.<dev>.info.serial",
  // The basic light and appliance controls. Their name IS the function, and
  // every one of them behaves exactly as an ioBroker user expects from the role.
  "devices.<dev>.control.power",
  "devices.<dev>.control.brightness",
  "devices.<dev>.control.color_rgb",
  "devices.<dev>.control.color_temperature",
  "devices.<dev>.control.humidity",
  "devices.<dev>.control.target_temperature",
  // Per-segment colour and brightness — the same two controls again, once per
  // segment. `segments.count` carries the explanation for the whole subtree.
  "devices.<dev>.segments.<n>.color",
  "devices.<dev>.segments.<n>.brightness",
  // Sensor readings whose unit and role say it all. The two that do NOT
  // (air quality, filter life) carry an explanation.
  "devices.<dev>.sensor.temperature",
  "devices.<dev>.sensor.humidity",
  "devices.<dev>.sensor.battery",
]);

/**
 * Datapoints whose text does not come from this repository: the manifest's
 * `instanceObjects` are rendered from `admin/i18n` by the fleet's release
 * script, whose per-adapter `desc_mapping` decides which of them get one.
 * Listing them here keeps the test honest about WHY they are exempt instead of
 * silently passing them.
 */
const OWNED_BY_THE_RELEASE_SCRIPT = new Set<string>(["info.connection", "info.cloudConnected", "info.mqttConnected"]);

/**
 * Collapse a concrete object id to its datapoint KIND.
 *
 * @param id Full object id from the inventory
 */
function kindOf(id: string): string {
  return id
    .replace(/^govee-smart\.0\./, "")
    .replace(/^devices\.[a-z0-9_]+\./, "devices.<dev>.")
    .replace(/^groups\.[a-z0-9_]+\./, "groups.<grp>.")
    .replace(/segments\.\d+/, "segments.<n>");
}

describe("catalog completeness", () => {
  const inventory = JSON.parse(readFileSync(INVENTORY, "utf8")) as Record<
    string,
    { type?: string; common?: { desc?: unknown; name?: unknown } }
  >;

  it("every datapoint the adapter creates is either explained or declared self-explaining", () => {
    // The inventory is the only place that sees the WHOLE tree — every device
    // kind, both creation paths (cloud capability and synthetic), all of it from
    // fixtures rather than from whatever hardware the maintainer happens to own.
    const undecided = Object.entries(inventory)
      .filter(([, obj]) => obj.type === "state" && !obj.common?.desc)
      .map(([id]) => kindOf(id))
      .filter(k => !SELF_EXPLAINING.has(k) && !OWNED_BY_THE_RELEASE_SCRIPT.has(k))
      .filter((k, i, all) => all.indexOf(k) === i)
      .sort();
    expect(undecided, "datapoints with neither an explanation nor a self-explaining entry").toEqual([]);
  });

  it("declares nothing self-explaining that no longer exists", () => {
    // A stale entry is how a list like this rots into a blanket exemption: a
    // datapoint gets renamed, its old name keeps a permanent free pass, and the
    // new one is never noticed.
    const present = new Set(
      Object.entries(inventory)
        .filter(([, obj]) => obj.type === "state")
        .map(([id]) => kindOf(id)),
    );
    const stale = [...SELF_EXPLAINING, ...OWNED_BY_THE_RELEASE_SCRIPT].filter(k => !present.has(k)).sort();
    expect(stale, "entries naming a datapoint the adapter no longer creates").toEqual([]);
  });

  it("every datapoint carries a translated name", () => {
    const unnamed = Object.entries(inventory)
      .filter(([, obj]) => obj.type === "state")
      .filter(([, obj]) => typeof obj.common?.name !== "object" || obj.common?.name === null)
      .map(([id]) => id)
      .sort();
    expect(unnamed, "datapoints with a plain-string or missing name").toEqual([]);
  });
});
