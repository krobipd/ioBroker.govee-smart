/**
 * Validates devices.json against devices.schema.json.
 *
 * Runs as `npm run validate-devices` — exits 1 on any schema violation,
 * 0 when clean. Used in CI before tag/release.
 *
 * Kept dependency-free (no ajv) so it stays cheap to run and doesn't
 * bloat the production install. The schema file itself is the canonical
 * spec — this script enforces a subset of its rules pragmatically.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWED_TYPES = new Set([
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
]);

const ALLOWED_STATUS = new Set(["verified", "reported", "seed"]);

const KNOWN_QUIRK_FIELDS = new Set(["colorTempRange", "brokenPlatformApi", "transportOverrides"]);

const ALLOWED_OVERRIDE_COMMANDS = new Set([
  "power",
  "brightness",
  "colorRgb",
  "colorTemperature",
  "lightScene",
  "diyScene",
  "snapshot",
  "gradientToggle",
  "segmentBatch",
]);

const ALLOWED_TRANSPORT_TARGETS = new Set(["cloud", "lan"]);

// Govee SKUs are a leading letter followed by four alphanumerics. Almost all are
// H-prefixed, but the R-series (e.g. R16D0, rebranded lamp/fan variants) uses R —
// so the gate keys off "any uppercase leading letter", not a hard-coded H.
const SKU_RE = /^[A-Z][0-9A-Z]{4}$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

interface Issue {
  sku: string;
  msg: string;
}

function validate(devicesJsonPath: string): Issue[] {
  const issues: Issue[] = [];
  const raw = fs.readFileSync(devicesJsonPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({ sku: "<root>", msg: "top-level must be an object" });
    return issues;
  }

  const root = parsed as Record<string, unknown>;
  const devices = root.devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices)) {
    issues.push({ sku: "<root>", msg: "missing or invalid 'devices' object" });
    return issues;
  }

  for (const [sku, entry] of Object.entries(devices)) {
    if (!SKU_RE.test(sku)) {
      issues.push({ sku, msg: `SKU does not match ${SKU_RE}` });
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ sku, msg: "entry must be an object" });
      continue;
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.name !== "string" || !e.name) {
      issues.push({ sku, msg: "missing or empty 'name'" });
    }
    if (typeof e.type !== "string" || !ALLOWED_TYPES.has(e.type)) {
      issues.push({
        sku,
        msg: `invalid 'type' (got ${JSON.stringify(e.type)}; expected one of ${[...ALLOWED_TYPES].join("/")})`,
      });
    }
    if (typeof e.status !== "string" || !ALLOWED_STATUS.has(e.status)) {
      issues.push({
        sku,
        msg: `invalid 'status' (got ${JSON.stringify(e.status)}; expected verified/reported/seed)`,
      });
    }
    if (e.since !== undefined) {
      if (typeof e.since !== "string" || !SEMVER_RE.test(e.since)) {
        issues.push({
          sku,
          msg: `'since' must be semver string (got ${JSON.stringify(e.since)})`,
        });
      }
    }
    if (e.quirks !== undefined) {
      if (typeof e.quirks !== "object" || e.quirks === null || Array.isArray(e.quirks)) {
        issues.push({ sku, msg: "'quirks' must be an object" });
      } else {
        const q = e.quirks as Record<string, unknown>;
        for (const key of Object.keys(q)) {
          if (!KNOWN_QUIRK_FIELDS.has(key)) {
            issues.push({
              sku,
              msg: `unknown quirk field '${key}' (allowed: ${[...KNOWN_QUIRK_FIELDS].join(", ")})`,
            });
          }
        }
        if (q.colorTempRange !== undefined) {
          const r = q.colorTempRange;
          if (
            typeof r !== "object" ||
            r === null ||
            Array.isArray(r) ||
            typeof (r as Record<string, unknown>).min !== "number" ||
            typeof (r as Record<string, unknown>).max !== "number"
          ) {
            issues.push({ sku, msg: "colorTempRange must be { min: number, max: number }" });
          } else {
            const range = r as { min: number; max: number };
            if (range.min < 1000 || range.max > 12000 || range.min >= range.max) {
              issues.push({
                sku,
                msg: `colorTempRange values out of plausible range or min >= max (got ${range.min}-${range.max})`,
              });
            }
          }
        }
        if (q.brokenPlatformApi !== undefined && typeof q.brokenPlatformApi !== "boolean") {
          issues.push({ sku, msg: "'brokenPlatformApi' must be boolean" });
        }
        if (q.transportOverrides !== undefined) {
          const t = q.transportOverrides;
          if (typeof t !== "object" || t === null || Array.isArray(t)) {
            issues.push({ sku, msg: "'transportOverrides' must be an object" });
          } else {
            for (const [cmd, target] of Object.entries(t as Record<string, unknown>)) {
              if (!ALLOWED_OVERRIDE_COMMANDS.has(cmd)) {
                issues.push({
                  sku,
                  msg: `transportOverrides: unknown command '${cmd}' (allowed: ${[...ALLOWED_OVERRIDE_COMMANDS].join(", ")})`,
                });
              }
              if (typeof target !== "string" || !ALLOWED_TRANSPORT_TARGETS.has(target)) {
                issues.push({
                  sku,
                  msg: `transportOverrides['${cmd}']: invalid target '${String(target)}' (allowed: cloud, lan)`,
                });
              }
            }
          }
        }
      }
    }

    const allowed = new Set(["name", "type", "status", "since", "quirks"]);
    for (const key of Object.keys(e)) {
      if (!allowed.has(key)) {
        issues.push({ sku, msg: `unknown field '${key}'` });
      }
    }
  }

  return issues;
}

const devicesJson = path.resolve(process.cwd(), "devices.json");

if (!fs.existsSync(devicesJson)) {
  throw new Error(`devices.json not found at ${devicesJson}`);
}

const issues = validate(devicesJson);
if (issues.length === 0) {
  const data = JSON.parse(fs.readFileSync(devicesJson, "utf-8")) as {
    devices: Record<string, unknown>;
  };
  const count = Object.keys(data.devices).length;
  console.log(`devices.json valid — ${count} entries`);
} else {
  console.error(`devices.json has ${issues.length} issue(s):`);
  for (const i of issues) {
    console.error(`  [${i.sku}] ${i.msg}`);
  }
  throw new Error("validation failed");
}
