import { describe, expect, it } from "vitest";
import { renderPage, TEXTS_DE, TEXTS_EN, type DeviceEntry } from "./gen-wiki-render";

const devices: Record<string, DeviceEntry> = {
  H6160: { name: "Strip", type: "light", status: "verified", since: "2.0.0" },
  H600D: { name: "GU10 Smart Bulb", type: "light", status: "reported", since: "2.33.0" },
  H6001: { name: "Smart Light", type: "light", status: "seed", since: "2.33.0" },
  H7100: { name: "Smart Fan", type: "fan", status: "seed", since: "2.33.0" },
};

describe("renderPage — one folded block per device type", () => {
  it("wraps each type in a details block whose summary carries the title and the per-status counts", () => {
    const page = renderPage(devices, TEXTS_EN);
    expect(page).toContain("<summary><b>Lights</b> · 3 models (✅ 1 · 🟢 1 · ⚪ 1)</summary>");
    expect(page).toContain("<summary><b>Fans</b> · 1 model (✅ 0 · 🟢 0 · ⚪ 1)</summary>");
    expect(page.match(/<details>/g)).toHaveLength(2);
    expect(page.match(/<\/details>/g)).toHaveLength(2);
    expect(page, "the type heading lives in the summary now").not.toContain("### Lights");
  });

  it("lists every model of the type inside its block, alphabetically", () => {
    const page = renderPage(devices, TEXTS_EN);
    const lights = page.slice(page.indexOf("<b>Lights</b>"), page.indexOf("<b>Fans</b>"));
    const positions = ["| `H6001` |", "| `H600D` |", "| `H6160` |"].map(row => lights.indexOf(row));
    expect(
      positions.every(i => i >= 0),
      "every row of the type sits inside its block",
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("a blank line separates the summary from the table — GitHub needs it to render Markdown inside details", () => {
    expect(renderPage(devices, TEXTS_EN)).toMatch(/<\/summary>\n\n\| SKU \|/);
  });

  it("tells the reader that the types unfold on click", () => {
    expect(renderPage(devices, TEXTS_EN)).toContain("Click a device type to unfold its models.");
  });

  it("renders the German page with the same structure", () => {
    const page = renderPage(devices, TEXTS_DE);
    expect(page).toContain("<summary><b>Lights</b> · 3 Modelle (✅ 1 · 🟢 1 · ⚪ 1)</summary>");
    expect(page).toContain("<summary><b>Lüfter</b> · 1 Modell (✅ 0 · 🟢 0 · ⚪ 1)</summary>");
    expect(page).toContain("Klick auf einen Gerätetyp öffnet seine Modelle.");
  });

  it("the footer still counts every entry, folded or not", () => {
    expect(renderPage(devices, TEXTS_EN)).toContain("4 entries");
  });
});
