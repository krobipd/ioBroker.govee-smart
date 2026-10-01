/**
 * Validates devices.json against devices.schema.json.
 *
 * Runs as `npm run validate-devices` — exits 1 on any violation, 0 when clean. Used in CI
 * before tag/release. The rules live in devices-validation.ts (unit-tested); this file is the CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateCatalog } from "./devices-validation";

const devicesJson = path.resolve(process.cwd(), "devices.json");
const schemaJson = path.resolve(process.cwd(), "devices.schema.json");

for (const file of [devicesJson, schemaJson]) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.basename(file)} not found at ${file}`);
  }
}

const data = JSON.parse(fs.readFileSync(devicesJson, "utf-8")) as { devices?: Record<string, unknown> };
const issues = validateCatalog(data, JSON.parse(fs.readFileSync(schemaJson, "utf-8")));
if (issues.length === 0) {
  console.log(`devices.json valid — ${Object.keys(data.devices ?? {}).length} entries`);
} else {
  console.error(`devices.json has ${issues.length} issue(s):`);
  for (const i of issues) {
    console.error(`  [${i.sku}] ${i.msg}`);
  }
  throw new Error("validation failed");
}
