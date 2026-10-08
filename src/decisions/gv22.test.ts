// GV-22 — The Wiki lists the devices by device type in blocks that fold open and shut.
// krobi 2026-09-08 18:35: "with so many devices I would suggest building the wiki by device types that can be folded open
// and shut so the page stays clear"; 2026-10-07 20:27: "gv22 yes"
import { describe, expect, it } from "vitest";
import { renderDeviceSections, type DeviceSectionTexts } from "../lib/wiki-device-sections";
import { DEVICE_TYPES } from "../lib/device-catalog";

const texts: DeviceSectionTexts = {
  typeSummary: "{title} — {n} {models}",
  modelOne: "model",
  modelMany: "models",
  typeTitles: Object.fromEntries(DEVICE_TYPES.map(t => [t, `Type ${t}`])) as DeviceSectionTexts["typeTitles"],
  colSku: "SKU",
  colName: "Name",
  colStatus: "Status",
  colSince: "Since",
};

const catalog = {
  H6199: { name: "Strip", type: "light", status: "seed" },
  H6172: { name: "Desk", type: "light", status: "reported" },
  H5179: { name: "Thermometer", type: "thermometer", status: "verified" },
} as const;

describe("GV-22 the Wiki's devices by type in folding blocks", () => {
  const { lines, total } = renderDeviceSections(catalog, texts);
  const page = lines.join("\n");

  it("renders one folded <details> block per device type, each with its type as the summary", () => {
    expect(lines.filter(l => l === "<details>")).toHaveLength(2);
    expect(lines.filter(l => l === "</details>")).toHaveLength(2);
    expect(page).toContain("<summary>Type light — 2 models</summary>");
    expect(page).toContain("<summary>Type thermometer — 1 model</summary>");
  });

  it("lists each model inside the block of its own type", () => {
    const lightBlock = page.slice(page.indexOf("Type light"), page.indexOf("</details>"));
    expect(lightBlock).toContain("`H6199`");
    expect(lightBlock).toContain("`H6172`");
    expect(lightBlock).not.toContain("`H5179`");
    expect(total).toBe(3);
  });
});
