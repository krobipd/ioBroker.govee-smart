#!/usr/bin/env node
// Release gate: keep the bundled Govee app version current. Wired into the
// release flow via .releaseconfig.json:before_commit.
//
// WHY this exists: Govee's undocumented app endpoints reject a request that
// announces a stale app version — HTTP 400, no useful message. The adapter
// therefore refreshes the version at runtime from Apple's app directory and
// only falls back to the bundled constant when that lookup fails (no internet
// to Apple, a firewall that allows Govee but not Apple, an outage).
//
// That fallback is the whole point of this gate: it is the value a user runs on
// when the live lookup cannot happen, and nothing else in the toolchain moves
// it. Measured 2026-09-03: bundled 7.5.20 while the live one was already 7.6.20
// — one minor version of unnoticed drift, and no step anywhere would have
// closed it. So the release closes it, once per release, deliberately.
//
// NOT blocking on a failed lookup: Apple being unreachable must never stop an
// unrelated hotfix. It warns and leaves the constant alone.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONST_PATH = fileURLToPath(new URL("../src/lib/govee-constants.ts", import.meta.url));
const BUNDLE_ID = "com.ihoment.GoVeeSensor";
const PIN_RE = /(export const GOVEE_APP_VERSION = ")([^"]+)(";)/;

const src = readFileSync(CONST_PATH, "utf8");
const bundled = src.match(PIN_RE)?.[2];
if (!bundled) {
  console.error("✖ GOVEE_APP_VERSION not found in src/lib/govee-constants.ts — gate cannot run.");
  process.exit(1);
}

let live = null;
try {
  const raw = execSync(
    `curl -sS --max-time 15 -A "ioBroker.govee-smart" "https://itunes.apple.com/lookup?bundleId=${BUNDLE_ID}"`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const v = JSON.parse(raw)?.results?.[0]?.version;
  if (typeof v === "string" && /^\d+(\.\d+)+$/.test(v)) {
    live = v;
  }
} catch (e) {
  console.warn(`⚠️  Could not ask Apple for the current Govee app version (${e.message}).`);
}

if (!live) {
  console.warn(`⚠️  App-version sync skipped — keeping the bundled ${bundled}. Not blocking the release.`);
  process.exit(0);
}
if (live === bundled) {
  console.log(`✓ Bundled Govee app version is current (${bundled}).`);
  process.exit(0);
}

writeFileSync(CONST_PATH, src.replace(PIN_RE, `$1${live}$3`), "utf8");
console.log(`✓ Bundled Govee app version ${bundled} → ${live} (Apple app directory).`);
