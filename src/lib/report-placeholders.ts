// The govee part of the report's placeholders (fleet master `diagnostics/placeholders.ts`, DB-04): the values Govee's
// payloads carry that no form pattern can find — a topic of 32 hex characters, an IPv4 address written as one
// little-endian number, a network name, a Matter id, the app's device number and a group id of digits only. They are
// marked here, with exact boundaries; the master's `deep` then replaces names, mail, hardware ids and addresses by
// their form. One Placeholders per report (a new report counts anew).
import type { Placeholders } from "./diagnostics/placeholders";

/** The personal values of one report the adapter knows by lookup: names the user gave, digit ids. */
export interface ReportPersonal {
  /** Device, group, snapshot and DIY scene names (GV-30). */
  names: readonly string[];
  /** Group ids and other device ids made of digits only. */
  digitIds: readonly string[];
}

/** Keys whose value is personal without a detectable shape, and the placeholder word for it. */
const SHAPELESS_KEYS: ReadonlyMap<string, string> = new Map([
  ["wifiname", "wifi"],
  ["ssid", "wifi"],
  ["matterid", "matter"],
]);

/** The same keys inside text that is JSON, plain and one level escaped. */
const KEYED_TEXT_RE = /(\\?)"(wifiName|ssid|matterId)\1"(\s*:\s*)\1"((?:(?!\1").)*?)\1"/gi;

/** A digit id as a bare JSON number inside text, plain or escaped (`"deviceId":49595162`). */
const DIGIT_ID_TEXT_RE = /(\\?)"(deviceId|groupId)\1"(\s*:\s*)(\d+)(?![\d.])/gi;

/** A Govee account or device topic (`GA/<hex>`, `GD/<hex>`); the prefix stays, it tells account from device. */
const TOPIC_RE = /\bG([AD])\/([0-9a-f]{12,})\b/gi;

/** `lanInfo.addr` inside text: the device's IPv4 as one little-endian number (#13, #49, #50). */
const ADDR_TEXT_RE = /(\\?)"addr\1"(\s*:\s*)(\d+)(?![\d.])/g;

/**
 * A Govee device id (eight hex pairs) also where a colon follows it — `<id>:<address>` in the LAN discovery trace,
 * `<model>:<id>` in the limiter's buckets — which the master's hardware pattern does not take.
 */
const GOVEE_ID_RE = /(?<![0-9a-f])(?:[0-9a-f]{2}:){7}[0-9a-f]{2}(?![0-9a-f])/gi;

/** Only digits. */
const DIGITS_RE = /^\d+$/;

/** A name shorter than this is no user name worth a placeholder — it would only hit protocol words. */
const MIN_NAME_LENGTH = 3;

/**
 * Decode a little-endian IPv4 number, or undefined when it is not one.
 *
 * @param value The number as it appeared
 */
export function littleEndianIpv4(value: unknown): string | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" && DIGITS_RE.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) {
    return undefined;
  }
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join(".");
}

/** Govee's capability instances whose option names the user gave (GV-30); `lightScene` is Govee's own. */
const OWN_NAME_INSTANCES: ReadonlySet<string> = new Set(["snapshot", "diyScene"]);

/** Keys whose array lists the user's own snapshots or DIY scenes by `name` (the live read, E5). */
const OWN_NAME_LISTS: ReadonlySet<string> = new Set(["snapshots", "diyScenes", "cloudDiyScenes", "snapshotPackets"]);

/**
 * The own snapshot and DIY names inside the report itself (GV-30): the option names of a `snapshot` or `diyScene`
 * capability in a Govee answer, and the names in the live read's lists — a name the device record does not carry
 * (new, renamed, deleted) is still the user's.
 *
 * @param value The report or a part of it
 * @param out The names found so far
 * @returns The names found
 */
export function ownSceneNamesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      ownSceneNamesIn(item, out);
    }
    return out;
  }
  if (!value || typeof value !== "object") {
    return out;
  }
  const obj = value as Record<string, unknown>;
  const params = obj.parameters as { options?: unknown } | null | undefined;
  if (typeof obj.instance === "string" && OWN_NAME_INSTANCES.has(obj.instance) && Array.isArray(params?.options)) {
    out.push(...namesOf(params.options));
  }
  for (const [key, child] of Object.entries(obj)) {
    if (OWN_NAME_LISTS.has(key) && Array.isArray(child)) {
      out.push(...namesOf(child));
    }
    ownSceneNamesIn(child, out);
  }
  return out;
}

/**
 * The `name` texts of a list's entries.
 *
 * @param list The list
 */
function namesOf(list: readonly unknown[]): string[] {
  return list
    .map(e => (e && typeof e === "object" ? (e as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

/**
 * Pseudonymise one report: register the names (those known by lookup and the own scene names the report carries),
 * mark the shapeless values with exact boundaries, then the master's `deep` over everything, keys included.
 *
 * @param report The report as the collector built it (secrets already redacted)
 * @param personal Names and digit ids known by lookup
 * @param places The report's placeholders — new per report
 * @returns The report with placeholders
 */
export function pseudonymiseReport(report: unknown, personal: ReportPersonal, places: Placeholders): unknown {
  for (const name of new Set([...personal.names, ...ownSceneNamesIn(report)])) {
    if (typeof name === "string" && name.trim().length >= MIN_NAME_LENGTH) {
      places.name(name);
    }
  }
  const digitIds = [...new Set(personal.digitIds)].filter(id => DIGITS_RE.test(id) && id.length >= 5);
  return places.deep(prepass(report, places, digitIds));
}

/**
 * The marker for a digit id: a number under `deviceId` is the app's internal device number, anything else a group id;
 * a `groupId` of 0 is Govee's "in no group" and stays.
 *
 * @param places The report's placeholders
 * @param key The key, lower case
 * @param value The value
 */
function digitIdMarker(places: Placeholders, key: string, value: unknown): string | undefined {
  const digits =
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string" && DIGITS_RE.test(value)
        ? value
        : undefined;
  if (digits === undefined || /^0+$/.test(digits)) {
    return undefined;
  }
  return places.mark(key === "deviceid" && typeof value === "number" ? "app-id" : "group", digits);
}

/**
 * Mark the shapeless values of one text.
 *
 * @param text The text
 * @param places The report's placeholders
 * @param digitIds Digit ids to replace as whole numbers
 */
function prepassText(text: string, places: Placeholders, digitIds: readonly string[]): string {
  let out = text
    .replace(KEYED_TEXT_RE, (m: string, esc: string, key: string, sep: string, value: string) => {
      if (!value) {
        return m;
      }
      // registered, so the same network or Matter id is replaced wherever else it stands
      const marked = places.name(value, SHAPELESS_KEYS.get(key.toLowerCase()) ?? "wifi");
      return `${esc}"${key}${esc}"${sep}${esc}"${marked}${esc}"`;
    })
    .replace(DIGIT_ID_TEXT_RE, (m: string, esc: string, key: string, sep: string, digits: string) => {
      const lower = key.toLowerCase();
      const marked = digitIdMarker(places, lower, lower === "deviceid" ? Number(digits) : digits);
      return marked === undefined ? m : `${esc}"${key}${esc}"${sep}${esc}"${marked}${esc}"`;
    })
    .replace(ADDR_TEXT_RE, (m: string, esc: string, sep: string, digits: string) => {
      const ip = littleEndianIpv4(digits);
      return ip === undefined ? m : `${esc}"addr${esc}"${sep}${esc}"${places.mark("address", ip)}${esc}"`;
    })
    .replace(TOPIC_RE, (m: string, kind: string) => `G${kind.toUpperCase()}/${places.mark("topic", m.toLowerCase())}`)
    .replace(GOVEE_ID_RE, m => places.mark("mac", m));
  for (const id of digitIds) {
    if (out.includes(id)) {
      out = out.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, "g"), places.mark("group", id));
    }
  }
  return out;
}

/**
 * Walk a report and mark the shapeless values — by key where the key says what a value is, by pattern in text.
 *
 * @param value Any JSON-like value
 * @param places The report's placeholders
 * @param digitIds Digit ids to replace as whole numbers
 */
function prepass(value: unknown, places: Placeholders, digitIds: readonly string[]): unknown {
  if (typeof value === "string") {
    return prepassText(value, places, digitIds);
  }
  if (Array.isArray(value)) {
    return value.map(item => prepass(item, places, digitIds));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      const kind = SHAPELESS_KEYS.get(key);
      const addr = key === "addr" ? littleEndianIpv4(v) : undefined;
      const byKey =
        kind !== undefined && (typeof v === "string" || typeof v === "number") && v !== ""
          ? places.name(String(v), kind)
          : key === "deviceid" || key === "groupid"
            ? digitIdMarker(places, key, v)
            : addr !== undefined
              ? places.mark("address", addr)
              : undefined;
      out[prepassText(k, places, digitIds)] = byKey ?? prepass(v, places, digitIds);
    }
    return out;
  }
  return value;
}
