/**
 * Validation of devices.json against devices.schema.json.
 *
 * The schema is the one spec: every word list and bound (SKU pattern, fields, types, tiers, quirk
 * fields, override commands and targets, segment limit, semver) is READ from it — until 3.0.2
 * this file carried its own copies and two of them had already drifted (audit S9). Kept
 * dependency-free: it reads the parts of the schema the catalog uses, not JSON Schema in general,
 * and fails loudly when one of them is missing, so a renamed schema path can never turn into
 * "accept everything". What a schema cannot say (colorTempRange min < max) is checked by hand.
 *
 * No I/O here — `validate-devices.ts` is the CLI.
 */

/** One finding: the SKU (or `<root>`) and what is wrong. */
export interface Issue {
  /** The entry's SKU, or `<root>` for the file itself. */
  sku: string;
  /** What is wrong. */
  msg: string;
}

interface SchemaNode {
  type?: string;
  enum?: unknown[];
  required?: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
}

/** The words and bounds the validation takes from the schema. */
interface CatalogRules {
  skuPattern: RegExp;
  entryFields: Set<string>;
  requiredFields: string[];
  types: Set<string>;
  statuses: Set<string>;
  semver: RegExp;
  quirkFields: Set<string>;
  colorTemp: { min: number; max: number };
  segmentCount: { min: number; max: number };
  statusCmdVersions: Set<unknown>;
  platformTempUnits: Set<unknown>;
  overrideTargets: Map<string, Set<unknown>>;
}

/**
 * A schema node at `path`, or a thrown error naming the path.
 *
 * @param root The parsed schema
 * @param path Property names from the root
 */
function node(root: unknown, path: string[]): SchemaNode {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in cur)) {
      throw new Error(`devices.schema.json has no ${path.join(".")}`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (!cur || typeof cur !== "object") {
    throw new Error(`devices.schema.json: ${path.join(".")} is no object`);
  }
  return cur;
}

/**
 * A list the schema must carry at `path` under `field`.
 *
 * @param root The parsed schema
 * @param path Property names from the root
 * @param field `enum`, `required`
 */
function list(root: unknown, path: string[], field: "enum" | "required"): unknown[] {
  const value = node(root, path)[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`devices.schema.json: ${path.join(".")}.${field} is no list`);
  }
  return value;
}

/**
 * A number the schema must carry at `path` under `field`.
 *
 * @param root The parsed schema
 * @param path Property names from the root
 * @param field `minimum`, `maximum`
 */
function bound(root: unknown, path: string[], field: "minimum" | "maximum"): number {
  const value = node(root, path)[field];
  if (typeof value !== "number") {
    throw new Error(`devices.schema.json: ${path.join(".")}.${field} is no number`);
  }
  return value;
}

/**
 * The keys of a node's `properties` (or `patternProperties`).
 *
 * @param root The parsed schema
 * @param path Property names from the root, ending at the map
 */
function keys(root: unknown, path: string[]): string[] {
  const names = Object.keys(node(root, path));
  if (names.length === 0) {
    throw new Error(`devices.schema.json: ${path.join(".")} is empty`);
  }
  return names;
}

/**
 * Read the catalog rules out of the schema.
 *
 * @param schema The parsed devices.schema.json
 */
export function rulesFromSchema(schema: unknown): CatalogRules {
  const entry = ["definitions", "deviceEntry"];
  const quirks = ["definitions", "quirks", "properties"];
  const skuPatterns = keys(schema, ["properties", "devices", "patternProperties"]);
  if (skuPatterns.length !== 1) {
    throw new Error("devices.schema.json: devices needs exactly one SKU pattern");
  }
  const semver = node(schema, [...entry, "properties", "since"]).pattern;
  if (typeof semver !== "string") {
    throw new Error("devices.schema.json: deviceEntry.since has no pattern");
  }
  const overrides = [...quirks, "transportOverrides", "properties"];
  return {
    skuPattern: new RegExp(skuPatterns[0]),
    entryFields: new Set(keys(schema, [...entry, "properties"])),
    requiredFields: list(schema, entry, "required").map(String),
    types: new Set(list(schema, [...entry, "properties", "type"], "enum").map(String)),
    statuses: new Set(list(schema, [...entry, "properties", "status"], "enum").map(String)),
    semver: new RegExp(semver),
    quirkFields: new Set(keys(schema, quirks)),
    colorTemp: {
      min: bound(schema, [...quirks, "colorTempRange", "properties", "min"], "minimum"),
      max: bound(schema, [...quirks, "colorTempRange", "properties", "max"], "maximum"),
    },
    segmentCount: {
      min: bound(schema, [...quirks, "segmentCount"], "minimum"),
      max: bound(schema, [...quirks, "segmentCount"], "maximum"),
    },
    statusCmdVersions: new Set(list(schema, [...quirks, "statusCmdVersion"], "enum")),
    platformTempUnits: new Set(list(schema, [...quirks, "platformTempUnit"], "enum")),
    overrideTargets: new Map(
      keys(schema, overrides).map(cmd => [cmd, new Set(list(schema, [...overrides, cmd], "enum"))]),
    ),
  };
}

/**
 * Validate the catalog's quirks of one entry.
 *
 * @param sku The entry's SKU
 * @param q The quirks object
 * @param rules The schema's rules
 * @param issues Where findings go
 */
function validateQuirks(sku: string, q: Record<string, unknown>, rules: CatalogRules, issues: Issue[]): void {
  for (const key of Object.keys(q)) {
    if (!rules.quirkFields.has(key)) {
      issues.push({ sku, msg: `unknown quirk field '${key}' (allowed: ${[...rules.quirkFields].join(", ")})` });
    }
  }
  if (q.colorTempRange !== undefined) {
    const r = q.colorTempRange as Record<string, unknown> | null;
    if (
      typeof r !== "object" ||
      r === null ||
      Array.isArray(r) ||
      !Number.isInteger(r.min) ||
      !Number.isInteger(r.max) ||
      Object.keys(r).some(k => k !== "min" && k !== "max")
    ) {
      issues.push({ sku, msg: "colorTempRange must be { min: integer, max: integer }" });
    } else {
      const { min, max } = r as { min: number; max: number };
      if (min < rules.colorTemp.min || max > rules.colorTemp.max || min >= max) {
        issues.push({
          sku,
          msg: `colorTempRange must lie in ${rules.colorTemp.min}-${rules.colorTemp.max} with min < max (got ${min}-${max})`,
        });
      }
    }
  }
  if (q.brokenPlatformApi !== undefined && typeof q.brokenPlatformApi !== "boolean") {
    issues.push({ sku, msg: "'brokenPlatformApi' must be boolean" });
  }
  if (q.segmentCount !== undefined) {
    const n = q.segmentCount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < rules.segmentCount.min || n > rules.segmentCount.max) {
      issues.push({
        sku,
        msg: `'segmentCount' must be an integer in ${rules.segmentCount.min}..${rules.segmentCount.max} (got ${JSON.stringify(n)})`,
      });
    }
  }
  if (q.statusCmdVersion !== undefined && !rules.statusCmdVersions.has(q.statusCmdVersion)) {
    issues.push({
      sku,
      msg: `'statusCmdVersion' must be one of ${[...rules.statusCmdVersions].join("/")} (got ${JSON.stringify(q.statusCmdVersion)})`,
    });
  }
  if (q.platformTempUnit !== undefined && !rules.platformTempUnits.has(q.platformTempUnit)) {
    issues.push({
      sku,
      msg: `'platformTempUnit' must be one of ${[...rules.platformTempUnits].join("/")} (got ${JSON.stringify(q.platformTempUnit)})`,
    });
  }
  if (q.ignoredCloudCapabilities !== undefined) {
    const caps = q.ignoredCloudCapabilities;
    if (
      !Array.isArray(caps) ||
      caps.length === 0 ||
      caps.some(i => typeof i !== "string" || i === "") ||
      new Set(caps).size !== caps.length
    ) {
      issues.push({
        sku,
        msg: `'ignoredCloudCapabilities' must be a non-empty list of distinct capability instances (got ${JSON.stringify(caps)})`,
      });
    }
  }
  if (q.transportOverrides !== undefined) {
    const t = q.transportOverrides;
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      issues.push({ sku, msg: "'transportOverrides' must be an object" });
      return;
    }
    for (const [cmd, target] of Object.entries(t as Record<string, unknown>)) {
      const targets = rules.overrideTargets.get(cmd);
      if (!targets) {
        issues.push({
          sku,
          msg: `transportOverrides: unknown command '${cmd}' (allowed: ${[...rules.overrideTargets.keys()].join(", ")})`,
        });
      } else if (!targets.has(target)) {
        issues.push({
          sku,
          msg: `transportOverrides['${cmd}']: invalid target ${JSON.stringify(target)} (allowed: ${[...targets].join(", ")})`,
        });
      }
    }
  }
}

/**
 * Validate a parsed devices.json against the parsed schema.
 *
 * @param data The parsed devices.json
 * @param schema The parsed devices.schema.json
 * @returns Every finding; empty when the catalog is valid
 */
export function validateCatalog(data: unknown, schema: unknown): Issue[] {
  const rules = rulesFromSchema(schema);
  const issues: Issue[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [{ sku: "<root>", msg: "top-level must be an object" }];
  }
  const devices = (data as Record<string, unknown>).devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices)) {
    return [{ sku: "<root>", msg: "missing or invalid 'devices' object" }];
  }

  for (const [sku, entry] of Object.entries(devices)) {
    if (!rules.skuPattern.test(sku)) {
      issues.push({ sku, msg: `SKU does not match ${rules.skuPattern}` });
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ sku, msg: "entry must be an object" });
      continue;
    }
    const e = entry as Record<string, unknown>;
    for (const field of rules.requiredFields) {
      if (e[field] === undefined) {
        issues.push({ sku, msg: `missing '${field}'` });
      }
    }
    for (const key of Object.keys(e)) {
      if (!rules.entryFields.has(key)) {
        issues.push({ sku, msg: `unknown field '${key}'` });
      }
    }
    if (e.name !== undefined && (typeof e.name !== "string" || !e.name)) {
      issues.push({ sku, msg: "'name' must be a non-empty string" });
    }
    if (e.type !== undefined && (typeof e.type !== "string" || !rules.types.has(e.type))) {
      issues.push({
        sku,
        msg: `invalid 'type' (got ${JSON.stringify(e.type)}; expected one of ${[...rules.types].join("/")})`,
      });
    }
    if (e.status !== undefined && (typeof e.status !== "string" || !rules.statuses.has(e.status))) {
      issues.push({
        sku,
        msg: `invalid 'status' (got ${JSON.stringify(e.status)}; expected one of ${[...rules.statuses].join("/")})`,
      });
    }
    if (e.since !== undefined && (typeof e.since !== "string" || !rules.semver.test(e.since))) {
      issues.push({ sku, msg: `'since' must be a semver string (got ${JSON.stringify(e.since)})` });
    }
    if (e.quirks !== undefined) {
      if (typeof e.quirks !== "object" || e.quirks === null || Array.isArray(e.quirks)) {
        issues.push({ sku, msg: "'quirks' must be an object" });
      } else {
        validateQuirks(sku, e.quirks as Record<string, unknown>, rules, issues);
      }
    }
  }
  return issues;
}
