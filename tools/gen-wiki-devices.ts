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
 * Rendering lives in gen-wiki-render.ts (unit-tested); this file is the CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { renderPage, TEXTS_DE, TEXTS_EN, type DevicesFile } from "./gen-wiki-render";

const repoRoot = process.cwd();
const devicesJson = path.resolve(repoRoot, "devices.json");
const defaultWikiDir = path.resolve(repoRoot, "..", "ioBroker.govee-smart.wiki");
const wikiDir = process.argv[2] || defaultWikiDir;

if (!fs.existsSync(devicesJson)) {
  throw new Error(`devices.json not found at ${devicesJson}`);
}
if (!fs.existsSync(wikiDir)) {
  throw new Error(
    `Wiki directory not found at ${wikiDir}. Clone the wiki repo first:\n  git clone https://github.com/krobipd/ioBroker.govee-smart.wiki.git ../ioBroker.govee-smart.wiki`,
  );
}

const data = JSON.parse(fs.readFileSync(devicesJson, "utf-8")) as DevicesFile;
const dePath = path.join(wikiDir, "Geraete.md");
const enPath = path.join(wikiDir, "Devices.md");

fs.writeFileSync(dePath, renderPage(data.devices, TEXTS_DE));
fs.writeFileSync(enPath, renderPage(data.devices, TEXTS_EN));

console.log(`Wrote ${dePath}`);
console.log(`Wrote ${enPath}`);
console.log(`${Object.keys(data.devices).length} device entries`);
