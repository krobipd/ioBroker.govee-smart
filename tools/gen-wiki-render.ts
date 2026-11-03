/**
 * Pure rendering of devices.json into the bilingual Wiki device pages (DE + EN).
 *
 * No I/O here — `gen-wiki-devices.ts` is the CLI that reads the catalog and
 * writes the pages; keeping the rendering apart makes it unit-testable
 * (`gen-wiki-render.test.ts`).
 */

import type { DeviceEntry } from "../src/lib/device-catalog";
import { renderDeviceSections, type DeviceSectionTexts } from "../src/lib/wiki-device-sections";

/** Every language-dependent string of the page — one object per language. */
export interface Texts extends DeviceSectionTexts {
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
  /** "Your device shows ⚪?" help section heading */
  untestedHeading: string;
  /** "Your device shows ⚪?" help section body */
  untestedBody: string;
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
  statusSeed: `### ⚪ Ungetestet
Es liegen noch keine Erfahrungsberichte vor. Korrekturen, die der Katalog für
das Modell mitbringt (falls vorhanden), gelten trotzdem immer. Das Log nennt
das Modell beim Start „untested“ und bittet um einen Diagnosebericht.`,
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
    gateway: "Gateways",
    composter: "Komposter",
  },
  colSku: "SKU",
  colName: "Govee-Name",
  colStatus: "Status",
  colSince: "Seit",
  untestedHeading: "## Dein Gerät steht auf ⚪? So hilfst du uns",
  untestedBody: `Wir haben dein Gerät noch nicht selbst getestet. Wenn du es ausprobierst,
hast du echte Daten — und unser Adapter wird mit jedem Bericht besser.

### Ausprobieren

1. Dein Gerät steht schon im Object-Browser unter
   \`govee-smart.0.devices.<sku>-<id>\`
2. Probier die Funktionen durch (Power, Helligkeit, Farbe, Modes — was
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
auf 🟢 **User-bestätigt**.`,
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
  statusSeed: `### ⚪ Untested
No user reports yet. Corrections the catalog carries for the model (if any)
apply anyway. At start the log names the model "untested" and asks for a
diagnostics report.`,
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
    gateway: "Gateways",
    composter: "Composters",
  },
  colSku: "SKU",
  colName: "Govee name",
  colStatus: "Status",
  colSince: "Since",
  untestedHeading: "## Your device shows ⚪? Here's how to help",
  untestedBody: `We haven't tested your device ourselves yet. If you try it, you have
real data — and the adapter improves with every report.

### Try it

1. Your device is already in the object browser under
   \`govee-smart.0.devices.<sku>-<id>\`
2. Try the functions (power, brightness, color, modes — whatever your
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
in the next release.`,
  footer: "This page is auto-generated.",
  entriesWord: "entries",
};

/**
 * Render one language's device page.
 *
 * @param devices the catalog (`devices.json` → `devices`)
 * @param t the language's texts
 * @returns the page as Markdown
 */
export function renderPage(devices: Record<string, DeviceEntry>, t: Texts): string {
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

  // One folded block per type, in the catalog's order (GV-22); validate-devices admits no other type.
  const sections = renderDeviceSections(devices, t);
  out.push(...sections.lines);
  const totalCount = sections.total;

  out.push(t.untestedHeading);
  out.push("");
  out.push(t.untestedBody);
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
