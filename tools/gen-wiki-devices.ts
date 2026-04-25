/**
 * Renders devices.json into bilingual Wiki pages (DE + EN).
 *
 * - Input:   <repo>/devices.json
 * - Output:  <repo>/../ioBroker.govee-smart.wiki/Geraete.md
 *            <repo>/../ioBroker.govee-smart.wiki/Devices.md
 *
 * Override the output dir with the second CLI arg if needed:
 *   npm run gen-wiki -- /custom/wiki/path
 *
 * Replaces the older Device-Quirks.md / Geraete-Korrekturen.md pages —
 * the new pages combine device list + status + quirks under one heading.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface DeviceEntry {
  name: string;
  type: string;
  status: "verified" | "reported" | "seed";
  since?: string;
  tested?: string;
  notes?: string;
  quirks?: Record<string, unknown>;
}

interface DevicesFile {
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
];

interface Texts {
  /** Sibling-language link line at top of page */
  langSwitch: string;
  /** Page title */
  title: string;
  /** Intro paragraph above the tables */
  intro: string;
  /** Heading for status-meaning section */
  statusHeading: string;
  /** Three status-meaning blocks (verified / reported / seed) */
  statusVerified: string;
  statusReported: string;
  statusSeed: string;
  /** Heading for the per-type tables */
  tablesHeading: string;
  /** Type → user-friendly section title (DE+EN) */
  typeTitles: Record<string, string>;
  /** Table column headers */
  colSku: string;
  colName: string;
  colStatus: string;
  colSince: string;
  colNotes: string;
  /** „Mein Gerät steht auf ⚪" section */
  experimentalHeading: string;
  experimentalBody: string;
  /** Footer with timestamp */
  footer: string;
}

const TEXTS_DE: Texts = {
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
  },
  colSku: "SKU",
  colName: "Govee-Name",
  colStatus: "Status",
  colSince: "Seit",
  colNotes: "Hinweis",
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

1. Im Object-Browser auf \`info.diagnostics_export\` deines Geräts klicken
2. Inhalt von \`info.diagnostics_result\` kopieren (JSON-Datei)
3. Auf GitHub ein Issue eröffnen:
   [Issue erstellen](https://github.com/krobipd/ioBroker.govee-smart/issues/new)
4. Beschreib kurz: was hast du probiert, was hat geklappt, was nicht.
   JSON anhängen oder reinkopieren.

Wenn du dich mit GitHub auskennst und gleich eine Code-Korrektur vorschlagen
willst: gerne ein Pull-Request gegen \`devices.json\`. Details in
[CONTRIBUTING.md](https://github.com/krobipd/ioBroker.govee-smart/blob/main/CONTRIBUTING.md).

### Was passiert mit deinem Bericht

Sobald wir Diagnostics von deinem Gerät haben, wandert es im nächsten Release
auf 🟢 **User-bestätigt** — dann ist es für alle ohne Sonder-Aktivierung
direkt nutzbar.`,
  footer: "Diese Seite ist automatisch generiert.",
};

const TEXTS_EN: Texts = {
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
  },
  colSku: "SKU",
  colName: "Govee name",
  colStatus: "Status",
  colSince: "Since",
  colNotes: "Notes",
  experimentalHeading: "## Your device shows ⚪? Here's how to help",
  experimentalBody: `We haven't tested your device ourselves yet. If you try it, you have
real data — and the adapter improves with every report.

### Enable

1. Open the adapter configuration (govee-smart in the ioBroker instance list)
2. Tick **"Experimentelle Geräte-Unterstützung aktivieren"**
   (label is German — "Enable experimental device support")
3. Save → adapter restarts
4. After 1–2 minutes: your device appears in the object browser under
   \`govee-smart.0.devices.<sku>_<id>\`
5. Try the functions (power, brightness, color, modes — whatever your
   device supports)

### Export data and share

Whether it works or not, please share a report.

1. Click \`info.diagnostics_export\` of your device in the object browser
2. Copy the contents of \`info.diagnostics_result\` (JSON)
3. Open a GitHub issue:
   [New issue](https://github.com/krobipd/ioBroker.govee-smart/issues/new)
4. Describe briefly what you tried, what worked, what didn't. Attach
   or paste the JSON.

If you're comfortable with GitHub and want to propose a fix directly,
a pull request against \`devices.json\` is welcome — see
[CONTRIBUTING.md](https://github.com/krobipd/ioBroker.govee-smart/blob/main/CONTRIBUTING.md).

### What happens with your report

Once we have diagnostics from your device, it moves to 🟢 **User-confirmed**
in the next release — then it's directly usable for everyone without the
experimental toggle.`,
  footer: "This page is auto-generated.",
};

function renderQuirkSummary(q: Record<string, unknown> | undefined): string {
  if (!q) return "";
  const parts: string[] = [];
  if (q.colorTempRange && typeof q.colorTempRange === "object") {
    const r = q.colorTempRange as { min?: number; max?: number };
    parts.push(`Color-Temp ${r.min}–${r.max}K`);
  }
  if (q.brokenPlatformApi) parts.push("Platform-API broken");
  if (q.preferAppApi) parts.push("App-API only");
  if (q.skipLanDiscovery) parts.push("No LAN");
  if (q.expectEvents) parts.push("MQTT events");
  if (q.powerValueWorkaround) parts.push("Power 1/0");
  return parts.join(", ");
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderTable(entries: Array<[string, DeviceEntry]>, t: Texts): string {
  const rows: string[] = [];
  rows.push(`| ${t.colSku} | ${t.colName} | ${t.colStatus} | ${t.colSince} | ${t.colNotes} |`);
  rows.push(`| --- | --- | --- | --- | --- |`);
  for (const [sku, e] of entries) {
    const noteParts: string[] = [];
    const quirkSummary = renderQuirkSummary(e.quirks);
    if (quirkSummary) noteParts.push(quirkSummary);
    if (e.notes) noteParts.push(e.notes);
    const noteCell = noteParts.length ? escapePipe(noteParts.join(". ")) : "—";
    const since = e.since ? `v${e.since}` : "—";
    rows.push(
      `| \`${sku}\` | ${escapePipe(e.name)} | ${STATUS_ICON[e.status]} | ${since} | ${noteCell} |`,
    );
  }
  return rows.join("\n");
}

function renderPage(devices: Record<string, DeviceEntry>, t: Texts): string {
  // Group by type, ordered by TYPE_ORDER
  const byType = new Map<string, Array<[string, DeviceEntry]>>();
  for (const [sku, entry] of Object.entries(devices)) {
    if (!byType.has(entry.type)) byType.set(entry.type, []);
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

  let totalCount = 0;
  for (const type of TYPE_ORDER) {
    const list = byType.get(type);
    if (!list || !list.length) continue;
    const title = t.typeTitles[type] ?? type;
    out.push(`### ${title} (${list.length})`);
    out.push("");
    out.push(renderTable(list, t));
    out.push("");
    totalCount += list.length;
  }

  // Any types not in TYPE_ORDER (forward-compat)
  for (const [type, list] of byType) {
    if (TYPE_ORDER.includes(type)) continue;
    out.push(`### ${t.typeTitles[type] ?? type} (${list.length})`);
    out.push("");
    out.push(renderTable(list, t));
    out.push("");
    totalCount += list.length;
  }

  out.push(t.experimentalHeading);
  out.push("");
  out.push(t.experimentalBody);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(`*${t.footer} ${totalCount} entries · ${new Date().toISOString().slice(0, 10)}*`);
  out.push("");
  return out.join("\n");
}

const repoRoot = process.cwd();
const devicesJson = path.resolve(repoRoot, "devices.json");
const defaultWikiDir = path.resolve(repoRoot, "..", "ioBroker.govee-smart.wiki");
const wikiDir = process.argv[2] || defaultWikiDir;

if (!fs.existsSync(devicesJson)) {
  console.error(`devices.json not found at ${devicesJson}`);
  process.exit(1);
}
if (!fs.existsSync(wikiDir)) {
  console.error(
    `Wiki directory not found at ${wikiDir}. Clone the wiki repo first:\n  git clone https://github.com/krobipd/ioBroker.govee-smart.wiki.git ../ioBroker.govee-smart.wiki`,
  );
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(devicesJson, "utf-8")) as DevicesFile;
const dePath = path.join(wikiDir, "Geraete.md");
const enPath = path.join(wikiDir, "Devices.md");

fs.writeFileSync(dePath, renderPage(data.devices, TEXTS_DE));
fs.writeFileSync(enPath, renderPage(data.devices, TEXTS_EN));

console.log(`Wrote ${dePath}`);
console.log(`Wrote ${enPath}`);
console.log(`${Object.keys(data.devices).length} device entries`);
