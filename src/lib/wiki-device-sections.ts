// The Wiki's device list: one folded block per device type (GV-22) — pure rendering, used by tools/gen-wiki-render.ts.
import { DEVICE_TYPES, type DeviceEntry, type DeviceType } from "./device-catalog";

const STATUS_ICON: Record<DeviceEntry["status"], string> = {
  verified: "✅",
  reported: "🟢",
  seed: "⚪",
};

/** The texts the device list needs, in one page language. */
export interface DeviceSectionTexts {
  /**
   * Summary line of a type's folded block. Placeholders: `{title}` type title,
   * `{n}` model count, `{models}` singular/plural word, `{v}`/`{r}`/`{s}` counts
   * per status (verified / reported / seed).
   */
  typeSummary: string;
  /** "model" — used in the summary when the type has exactly one entry. */
  modelOne: string;
  /** "models" — used otherwise. */
  modelMany: string;
  /** Type → user-friendly section title; the compiler asks for every catalog type. */
  typeTitles: Record<DeviceType, string>;
  /** Table column header: SKU */
  colSku: string;
  /** Table column header: Govee model name */
  colName: string;
  /** Table column header: status icon */
  colStatus: string;
  /** Table column header: first adapter version */
  colSince: string;
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderTable(entries: Array<[string, DeviceEntry]>, t: DeviceSectionTexts): string {
  const rows: string[] = [];
  rows.push(`| ${t.colSku} | ${t.colName} | ${t.colStatus} | ${t.colSince} |`);
  rows.push(`| --- | --- | --- | --- |`);
  for (const [sku, e] of entries) {
    const since = e.since ? `v${e.since}` : "—";
    rows.push(`| \`${sku}\` | ${escapePipe(e.name)} | ${STATUS_ICON[e.status]} | ${since} |`);
  }
  return rows.join("\n");
}

/**
 * One device type as a folded block: the summary carries the title and the
 * per-status counts, the table inside lists every model of the type. With 600
 * entries the flat tables stopped being readable (krobi 2026-09-08, variant A).
 *
 * @param title the type's title in the page language
 * @param list the type's entries, already sorted by SKU
 * @param t the language's texts
 * @returns the block's lines
 */
function renderTypeSection(title: string, list: Array<[string, DeviceEntry]>, t: DeviceSectionTexts): string[] {
  const count = (status: DeviceEntry["status"]): number => list.filter(([, e]) => e.status === status).length;
  const summary = t.typeSummary
    .replace("{title}", title)
    .replace("{n}", String(list.length))
    .replace("{models}", list.length === 1 ? t.modelOne : t.modelMany)
    .replace("{v}", String(count("verified")))
    .replace("{r}", String(count("reported")))
    .replace("{s}", String(count("seed")));
  // GitHub renders Markdown inside <details> only after a blank line.
  return ["<details>", `<summary>${summary}</summary>`, "", renderTable(list, t), "", "</details>", ""];
}

/**
 * The device list of a Wiki page: the catalog grouped by device type, in the
 * catalog's type order, each type a folded `<details>` block (GV-22).
 *
 * @param devices the catalog (`devices.json` → `devices`)
 * @param t the language's texts
 * @returns the lines and how many entries they list
 */
export function renderDeviceSections(
  devices: Record<string, DeviceEntry>,
  t: DeviceSectionTexts,
): { lines: string[]; total: number } {
  const byType = new Map<DeviceType, Array<[string, DeviceEntry]>>();
  for (const [sku, entry] of Object.entries(devices)) {
    if (!byType.has(entry.type)) {
      byType.set(entry.type, []);
    }
    byType.get(entry.type)!.push([sku, entry]);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
  }
  const lines: string[] = [];
  let total = 0;
  for (const type of DEVICE_TYPES) {
    const list = byType.get(type);
    if (!list || !list.length) {
      continue;
    }
    lines.push(...renderTypeSection(t.typeTitles[type], list, t));
    total += list.length;
  }
  return { lines, total };
}
