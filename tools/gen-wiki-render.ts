/**
 * Pure rendering of devices.json into the bilingual Wiki device pages (DE + EN).
 *
 * No I/O here — `gen-wiki-devices.ts` is the CLI that reads the catalog and
 * writes the pages; keeping the rendering apart makes it unit-testable
 * (`gen-wiki-render.test.ts`).
 */

/** One catalog entry of `devices.json`, keyed by SKU. */
export interface DeviceEntry {
  /** Govee model name as shown in the wiki table. */
  name: string;
  /** Device kind (`light`, `thermometer`, … — the `type` enum of `devices.schema.json`). */
  type: string;
  /** Trust tier: multiple reports / one report with diagnostics / imported and untested. */
  status: "verified" | "reported" | "seed";
  /** Adapter version that first carried the entry (semver, without `v`). */
  since?: string;
  /** Per-SKU corrections; rendered nowhere on the wiki, kept for type parity with the catalog. */
  quirks?: Record<string, unknown>;
}

/** The shape of `devices.json`. */
export interface DevicesFile {
  /** SKU → entry. */
  devices: Record<string, DeviceEntry>;
}

const STATUS_ICON: Record<DeviceEntry["status"], string> = {
  verified: "✅",
  reported: "🟢",
  seed: "⚪",
};

const TYPE_ORDER = [
  "light",
  "thermometer",
  "sensor",
  "heater",
  "humidifier",
  "dehumidifier",
  "fan",
  "air_purifier",
  "socket",
  "kettle",
  "ice_maker",
  "aroma_diffuser",
  "button",
];

/** Every language-dependent string of the page — one object per language. */
export interface Texts {
  /** Sibling-language link line at top of page */
  langSwitch: string;
  /** Page title */
  title: string;
  /** Intro paragraph above the tables */
  intro: string;
  /** Heading for status-meaning section */
  statusHeading: string;
  /** Status-meaning block for ✅ verified */
  statusVerified: string;
  /** Status-meaning block for 🟢 reported */
  statusReported: string;
  /** Status-meaning block for ⚪ seed */
  statusSeed: string;
  /** Heading for the per-type tables */
  tablesHeading: string;
  /** One line under the device-list heading: the types unfold on click. */
  tablesHint: string;
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
  /** Type → user-friendly section title (DE+EN) */
  typeTitles: Record<string, string>;
  /** Table column header: SKU */
  colSku: string;
  /** Table column header: Govee model name */
  colName: string;
  /** Table column header: status icon */
  colStatus: string;
  /** Table column header: first adapter version */
  colSince: string;
  /** "Your device shows ⚪?" help section heading */
  experimentalHeading: string;
  /** "Your device shows ⚪?" help section body */
  experimentalBody: string;
  /** Footer with timestamp */
  footer: string;
  /** Word after the entry count in the footer ("entries" / "Einträge") */
  entriesWord: string;
}

export const TEXTS_DE: Texts = {
  langSwitch: "**Deutsch** | [English](Devices)",
  title: "Unterstützte Geräte",
  intro:
    "Diese Liste wird aus `devices.json` im Repo generiert. Jeder Eintrag steht für ein Govee-Modell (SKU). Ob ein Gerät bei dir funktioniert, hängt vom Status ab — siehe Status-Bedeutung weiter unten.",
  statusHeading: "## Status-Bedeutung",
  statusVerified: `### ✅ Voll getestet
Mehrere verifizierte Erfahrungsberichte liegen vor.`,
  statusReported: `### 🟢 User-bestätigt
Erfahrungsbericht eines Anwenders liegt vor. Weitere Tests erwünscht.`,
  statusSeed: `### ⚪ Experimentell
Ungetestet, es liegen noch keine Erfahrungsberichte vor.
Standardmäßig deaktiviert — wenn du es ausprobieren willst, in der
Adapter-Konfiguration aktivieren. Dabei können Probleme auftreten oder
einzelne Funktionen fehlen.`,
  tablesHeading: "## Geräte-Liste",
  tablesHint: "Klick auf einen Gerätetyp öffnet seine Modelle.",
  typeSummary: "<b>{title}</b> · {n} {models} (✅ {v} · 🟢 {r} · ⚪ {s})",
  modelOne: "Modell",
  modelMany: "Modelle",
  typeTitles: {
    light: "Lights",
    thermometer: "Thermometer / Hygrometer",
    sensor: "Sensoren",
    heater: "Heizgeräte",
    humidifier: "Luftbefeuchter",
    dehumidifier: "Luftentfeuchter",
    fan: "Lüfter",
    air_purifier: "Luftreiniger",
    socket: "Steckdosen",
    kettle: "Wasserkocher",
    ice_maker: "Eiswürfelbereiter",
    aroma_diffuser: "Aromadiffusoren",
    button: "Taster und Fernbedienungen",
  },
  colSku: "SKU",
  colName: "Govee-Name",
  colStatus: "Status",
  colSince: "Seit",
  experimentalHeading: "## Dein Gerät steht auf ⚪? So hilfst du uns",
  experimentalBody: `Wir haben dein Gerät noch nicht selbst getestet. Wenn du es ausprobierst,
hast du echte Daten — und unser Adapter wird mit jedem Bericht besser.

### Aktivieren

1. Adapter-Konfiguration öffnen (govee-smart in der ioBroker Instanzen-Liste)
2. Häkchen setzen: **„Experimentelle Geräte-Unterstützung aktivieren"**
3. Speichern → Adapter startet neu
4. Nach 1-2 Minuten: dein Gerät erscheint im Object-Browser unter
   \`govee-smart.0.devices.<sku>_<id>\`
5. Probier die Funktionen durch (Power, Helligkeit, Farbe, Modes — was
   dein Gerät eben kann)

### Daten exportieren und teilen

Egal ob es funktioniert oder nicht — bitte einen Bericht.

1. Im Adapter den Reiter **Experte** öffnen und auf **Diagnose** drücken
2. Gerät wählen und den Knopf drücken — der Browser legt eine Berichtsdatei ab
3. Auf GitHub ein Issue eröffnen:
   [Issue erstellen](https://github.com/krobipd/ioBroker.govee-smart/issues/new)
4. Beschreib kurz: was hast du probiert, was hat geklappt, was nicht.
   Die Datei anhängen.

Wenn du dich mit GitHub auskennst und gleich eine Code-Korrektur vorschlagen
willst: gerne ein Pull-Request gegen \`devices.json\`. Details in
[CONTRIBUTING.md](https://github.com/krobipd/ioBroker.govee-smart/blob/main/CONTRIBUTING.md).

### Was passiert mit deinem Bericht

Sobald wir Diagnostics von deinem Gerät haben, wandert es im nächsten Release
auf 🟢 **User-bestätigt** — dann ist es für alle ohne Sonder-Aktivierung
direkt nutzbar.`,
  footer: "Diese Seite ist automatisch generiert.",
  entriesWord: "Einträge",
};

export const TEXTS_EN: Texts = {
  langSwitch: "**English** | [Deutsch](Geraete)",
  title: "Supported Devices",
  intro:
    "This list is generated from `devices.json` in the repository. Each entry represents a Govee model (SKU). Whether a device works for you depends on its status — see status meanings below.",
  statusHeading: "## Status meanings",
  statusVerified: `### ✅ Fully tested
Multiple verified user reports on file.`,
  statusReported: `### 🟢 User-confirmed
One user has reported success with diagnostics. More tests welcome.`,
  statusSeed: `### ⚪ Experimental
Untested, no user reports yet.
Disabled by default — to try it, enable it in the adapter configuration.
Problems or missing functions are possible.`,
  tablesHeading: "## Device list",
  tablesHint: "Click a device type to unfold its models.",
  typeSummary: "<b>{title}</b> · {n} {models} (✅ {v} · 🟢 {r} · ⚪ {s})",
  modelOne: "model",
  modelMany: "models",
  typeTitles: {
    light: "Lights",
    thermometer: "Thermometers / Hygrometers",
    sensor: "Sensors",
    heater: "Heaters",
    humidifier: "Humidifiers",
    dehumidifier: "Dehumidifiers",
    fan: "Fans",
    air_purifier: "Air purifiers",
    socket: "Smart plugs",
    kettle: "Kettles",
    ice_maker: "Ice makers",
    aroma_diffuser: "Aroma diffusers",
    button: "Buttons and remotes",
  },
  colSku: "SKU",
  colName: "Govee name",
  colStatus: "Status",
  colSince: "Since",
  experimentalHeading: "## Your device shows ⚪? Here's how to help",
  experimentalBody: `We haven't tested your device ourselves yet. If you try it, you have
real data — and the adapter improves with every report.

### Enable

1. Open the adapter configuration (govee-smart in the ioBroker instance list)
2. Tick **"Enable experimental device support"**
3. Save → adapter restarts
4. After 1–2 minutes: your device appears in the object browser under
   \`govee-smart.0.devices.<sku>_<id>\`
5. Try the functions (power, brightness, color, modes — whatever your
   device supports)

### Export data and share

Whether it works or not, please share a report.

1. Open the adapter's **Expert** tab and press **Diagnostics**
2. Pick the device and press the button — your browser saves a report file
3. Open a GitHub issue:
   [New issue](https://github.com/krobipd/ioBroker.govee-smart/issues/new)
4. Describe briefly what you tried, what worked, what didn't. Attach
   the file.

If you're comfortable with GitHub and want to propose a fix directly,
a pull request against \`devices.json\` is welcome — see
[CONTRIBUTING.md](https://github.com/krobipd/ioBroker.govee-smart/blob/main/CONTRIBUTING.md).

### What happens with your report

Once we have diagnostics from your device, it moves to 🟢 **User-confirmed**
in the next release — then it's directly usable for everyone without the
experimental toggle.`,
  footer: "This page is auto-generated.",
  entriesWord: "entries",
};

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderTable(entries: Array<[string, DeviceEntry]>, t: Texts): string {
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
function renderTypeSection(title: string, list: Array<[string, DeviceEntry]>, t: Texts): string[] {
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
 * Render one language's device page.
 *
 * @param devices the catalog (`devices.json` → `devices`)
 * @param t the language's texts
 * @returns the page as Markdown
 */
export function renderPage(devices: Record<string, DeviceEntry>, t: Texts): string {
  // Group by type, ordered by TYPE_ORDER
  const byType = new Map<string, Array<[string, DeviceEntry]>>();
  for (const [sku, entry] of Object.entries(devices)) {
    if (!byType.has(entry.type)) {
      byType.set(entry.type, []);
    }
    byType.get(entry.type)!.push([sku, entry]);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
  }

  const out: string[] = [];
  out.push(t.langSwitch);
  out.push("");
  out.push(`# ${t.title}`);
  out.push("");
  out.push(t.intro);
  out.push("");
  out.push(t.statusHeading);
  out.push("");
  out.push(t.statusVerified);
  out.push("");
  out.push(t.statusReported);
  out.push("");
  out.push(t.statusSeed);
  out.push("");
  out.push(t.tablesHeading);
  out.push("");
  out.push(t.tablesHint);
  out.push("");

  let totalCount = 0;
  for (const type of TYPE_ORDER) {
    const list = byType.get(type);
    if (!list || !list.length) {
      continue;
    }
    out.push(...renderTypeSection(t.typeTitles[type] ?? type, list, t));
    totalCount += list.length;
  }

  // Any types not in TYPE_ORDER (forward-compat)
  for (const [type, list] of byType) {
    if (TYPE_ORDER.includes(type)) {
      continue;
    }
    out.push(...renderTypeSection(t.typeTitles[type] ?? type, list, t));
    totalCount += list.length;
  }

  out.push(t.experimentalHeading);
  out.push("");
  out.push(t.experimentalBody);
  out.push("");
  out.push(`---`);
  out.push("");
  // No date in the footer: gate A13 compares a fresh render against the committed page, and a
  // day stamp would make that diff red every day while the content is identical (measured
  // 2026-09-12: 602/602 entries, only the stamp differed). The entry count IS the state the
  // page describes; when it was written is in the wiki's git history.
  out.push(`*${t.footer} ${totalCount} ${t.entriesWord}*`);
  out.push("");
  return out.join("\n");
}
