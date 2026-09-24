/**
 * Stable pseudonymisation for the diagnostics report.
 *
 * The report is written to be handed to a stranger — attached to a public
 * GitHub issue — so it must not carry the reporter's addresses, account mail
 * or device names. Blanking them out (`***`) would make it useless at the same
 * time: half of every diagnosis is "did these two lines talk about the SAME
 * device", and a report where every address reads `***` cannot answer that.
 *
 * So each distinct value gets a stable marker instead: the same address is
 * `address-1` everywhere in the report, a second one is `address-2`. Structure
 * that carries meaning survives — a private address stays recognisably private,
 * so "these two devices sit in different subnets" is still visible.
 *
 * Markers are stable within one adapter run, not across runs: two reports the
 * same user exports minutes apart share them, two exports across a restart do
 * not. The report header says so, otherwise a reader comparing two files would
 * assume `address-1` is the same device in both.
 *
 * Ordering matters and is the caller's job: redact, then pseudonymise, THEN
 * cap. The size cap turns an oversized body into a plain truncated string, and
 * neither key-based redaction nor marker replacement can reach inside one —
 * a real address would ship in the truncated remainder.
 */

/** IPv4 in dotted form. Bounded to 1-3 digits per group so it can't run away in a long string. */
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/**
 * IPv6, in the only two shapes that are actually addresses: eight full groups,
 * or a `::`-compressed form. Deliberately NOT "two or more hex groups" — that
 * earlier version matched `AA:BB:CC` and turned a short device id into an
 * address marker. A run of colon-separated hex is not an address unless it has
 * all eight groups or the `::` compression; anything shorter is left alone,
 * because a false positive here silently corrupts the report while a miss only
 * leaves an already-rare string in place.
 */
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi;

/** Anything shaped like a mail address — the Govee account mail can surface in login error bodies. */
const EMAIL_RE = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/gi;

/**
 * Govee device ids: colon-separated hex in 6 or 8 groups (`AA:BB:…:11`). Kept
 * partly readable rather than replaced — see {@link Anonymiser.deviceId}.
 */
const DEVICE_ID_RE = /\b(?:[0-9a-f]{2}:){5,7}[0-9a-f]{2}\b/gi;

/**
 * Keys whose value is personal although it has no detectable shape, mapped to
 * the marker kind that replaces it. Matched case-insensitively.
 *
 * `wifiName` is the SSID the device is joined to — Govee's account list
 * carries it in every device's settings, and home networks are routinely named
 * after the people or the place (measured in the exports of #46, #47 and #50:
 * a village name and two first names, all three published). `matterId` is the
 * device's Matter identity, unique like a serial number. A marker instead of
 * `***` keeps the one fact that helps a diagnosis: whether two devices share
 * one network.
 */
const SHAPELESS_KEYS: ReadonlyMap<string, string> = new Map([
  ["wifiname", "wifi"],
  ["ssid", "wifi"],
  ["matterid", "matter"],
]);

/**
 * Keys that hold a Govee device or group id. A hex id is found by its shape
 * anyway; these catch the ids that are only digits — a group's id, and the
 * app-internal device number of the account list, which a pattern cannot tell
 * from any other number.
 */
const ID_KEYS: ReadonlySet<string> = new Set(["deviceid", "groupid"]);

/** Only digits — the shape of a group id and of the app's internal device number. */
const DIGITS_RE = /^\d+$/;

/**
 * The same shapeless keys inside TEXT that is JSON — an MQTT envelope kept as
 * `rawJson`, a foreign error body that did not parse. The key rules of
 * {@link Anonymiser.walk} only see parsed objects; these catch the plain form
 * (`"wifiName":"…"`) and the one-level escaped form of JSON inside JSON
 * (`\"wifiName\":\"…\"`).
 */
const KEYED_TEXT_RE = /"(wifiName|ssid|matterId)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/gi;
const KEYED_TEXT_ESCAPED_RE = /\\"(wifiName|ssid|matterId)\\"(\s*:\s*)\\"((?:(?!\\").)*)\\"/gi;

/** A digit id as a bare JSON number inside text, plain or escaped (`"deviceId":49595162`). */
const DIGIT_ID_TEXT_RE = /(\\?)"(deviceId|groupId)\1"(\s*:\s*)(\d+)(?![\d.])/gi;

/**
 * A Govee account or device topic (`GA/<32 hex>`, `GD/<32 hex>`) — the account
 * push topic every MQTT envelope carries, and the gateway topic of the account
 * list. Measured in every export under `github-exports/` (all lower-case hex);
 * the prefix stays, it tells account from device topic.
 */
const TOPIC_RE = /\bG([AD])\/([0-9a-f]{12,})\b/g;

/**
 * `lanInfo.addr` of a Govee push: the device's IPv4 as one little-endian
 * number (`604045834` = 10.2.1.36, measured in seven exports) — an address no
 * dotted-quad pattern can see. Plain or escaped JSON inside text.
 */
const ADDR_TEXT_RE = /(\\?)"addr\1"(\s*:\s*)(\d+)(?![\d.])/g;

/**
 * Decode a little-endian IPv4 number, or undefined when it is not one.
 *
 * @param value The number as it appeared
 */
function littleEndianIpv4(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) {
    return undefined;
  }
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join(".");
}

/**
 * Escape a device name for use inside a regular expression.
 *
 * @param text The literal text
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether an IPv4 address is in a private range — worth preserving as a fact.
 *
 * @param ip The address to classify
 */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(n => parseInt(n, 10));
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  if (p[0] === 10 || p[0] === 127) {
    return true;
  }
  if (p[0] === 192 && p[1] === 168) {
    return true;
  }
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) {
    return true;
  }
  // Link-local (169.254/16) — what a device shows when DHCP failed, which is
  // itself a diagnosis, so it must stay distinguishable from a routed address.
  return p[0] === 169 && p[1] === 254;
}

/**
 * Whether an IPv6 address is local: loopback `::1`, link-local `fe80::/10`,
 * unique-local `fc00::/7`. Everything else is routed — until 2.39.x every IPv6
 * address was marked local (audit E5).
 *
 * @param ip The address to classify
 */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") {
    return true;
  }
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if (!Number.isInteger(first)) {
    return false;
  }
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

/**
 * Assigns and remembers markers. One instance per adapter run (the diagnostics
 * collector owns it), so every buffer and every report share the same mapping.
 */
export class Anonymiser {
  private readonly markers = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  /** Every marker handed out, so a second pass over a report leaves them as they are. */
  private readonly minted = new Set<string>();

  /**
   * The marker for one value in one category, minted on first sight.
   *
   * @param kind Marker prefix, e.g. `address` or `device`
   * @param value The real value to stand in for
   */
  private marker(kind: string, value: string): string {
    if (this.minted.has(value)) {
      return value;
    }
    const key = `${kind}\u0000${value}`;
    const existing = this.markers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const assigned = `${kind}-${next}`;
    this.markers.set(key, assigned);
    this.minted.add(assigned);
    return assigned;
  }

  /**
   * Marker for an IP address. Private and link-local addresses are marked as
   * such, so "both devices are local" and "this one answered from the internet"
   * stay readable.
   *
   * @param ip The address as it appeared
   */
  ip(ip: string): string {
    // An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) follows the IPv4 rule.
    const v4 = ip.replace(/^::ffff:/i, "");
    const local = v4.includes(".") ? isPrivateIpv4(v4) : isPrivateIpv6(ip);
    return this.marker(`address-${local ? "local" : "public"}`, ip);
  }

  /**
   * A device id keeps its last four hex characters and loses the rest. Those
   * four are already the folder name in the object tree (`h61be_1d6f`), so the
   * report stays matchable against a user's screenshot without carrying the
   * full hardware id.
   *
   * @param id The device id as it appeared
   */
  deviceId(id: string): string {
    const compact = id.replace(/:/g, "");
    const tail = compact.slice(-4).toLowerCase();
    return `id-…${tail}`;
  }

  /**
   * Marker for a user-chosen device name. Names routinely carry a room or a
   * person ("Lisa's bedroom"), so they never travel — but the same name must
   * map to the same marker everywhere, or the report stops being followable.
   *
   * @param name The device name as the user set it
   */
  deviceName(name: string): string {
    return this.marker("device", name);
  }

  /**
   * The value under an id key ({@link ID_KEYS}) when it is only digits. A
   * group id — a digit string under `deviceId`, a number or digit string under
   * `groupId` — is shortened like any device id, so a group's report still
   * matches its object-tree folder. A number under `deviceId` is the app's
   * internal device number, which nothing in ioBroker shows: a marker. A
   * `groupId` of 0 is Govee's "in no group" and stays.
   *
   * @param key The key, lower-cased
   * @param value The value as it appeared
   * @returns The replacement, or undefined when the value is not a digit id
   */
  private digitId(key: string, value: unknown): string | undefined {
    const digits =
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? String(value)
        : typeof value === "string" && DIGITS_RE.test(value)
          ? value
          : undefined;
    if (digits === undefined || /^0+$/.test(digits)) {
      return undefined;
    }
    if (key === "deviceid" && typeof value === "number") {
      return this.marker("app-id", digits);
    }
    return this.deviceId(digits);
  }

  /**
   * Replace every address, mail address and device id inside a free-text
   * string. Log lines and foreign error bodies are the places these hide.
   *
   * @param text Arbitrary text
   * @param names Device names to replace as well (they have no detectable shape)
   * @param digitIds Device ids made of digits only (groups) — a pattern cannot
   *   tell them from any other number, so they are replaced by lookup like names
   */
  text(text: string, names: readonly string[] = [], digitIds: readonly string[] = []): string {
    let out = text
      .replace(KEYED_TEXT_RE, (m: string, key: string, sep: string, value: string) =>
        value ? `"${key}"${sep}"${this.marker(SHAPELESS_KEYS.get(key.toLowerCase()) ?? "wifi", value)}"` : m,
      )
      .replace(KEYED_TEXT_ESCAPED_RE, (m: string, key: string, sep: string, value: string) =>
        value ? `\\"${key}\\"${sep}\\"${this.marker(SHAPELESS_KEYS.get(key.toLowerCase()) ?? "wifi", value)}\\"` : m,
      )
      .replace(DIGIT_ID_TEXT_RE, (m: string, esc: string, key: string, sep: string, digits: string) => {
        const lower = key.toLowerCase();
        const replaced = this.digitId(lower, lower === "deviceid" ? Number(digits) : digits);
        return replaced === undefined ? m : `${esc}"${key}${esc}"${sep}${esc}"${replaced}${esc}"`;
      })
      .replace(ADDR_TEXT_RE, (m: string, esc: string, sep: string, digits: string) => {
        const ip = littleEndianIpv4(digits);
        return ip === undefined ? m : `${esc}"addr${esc}"${sep}${esc}"${this.ip(ip)}${esc}"`;
      })
      .replace(TOPIC_RE, (m: string, kind: string) => `G${kind}/${this.marker("topic", m)}`)
      .replace(EMAIL_RE, m => this.marker("mail", m))
      .replace(IPV4_RE, m => this.ip(m))
      .replace(DEVICE_ID_RE, m => this.deviceId(m));
    // IPv6 last: its pattern also matches a run of hex groups, so device ids
    // must already be gone or they would be swallowed as addresses.
    out = out.replace(IPV6_RE, m => this.ip(m));
    // Longest name first — "Floor Lamp Hall" before "Floor Lamp", or the
    // shorter one would eat the start of the longer and leave "Hall" behind;
    // and only as a whole word, so "Lamp" does not rename "Lamps" (audit E6/N8).
    const byLength = [...new Set(names)].filter(n => n && n.length >= 3).sort((a, b) => b.length - a.length);
    for (const name of byLength) {
      if (out.includes(name)) {
        out = out.replace(
          new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "gu"),
          this.deviceName(name),
        );
      }
    }
    // Whole numbers only (a group id sits among timestamps and byte counts).
    // Four digits or fewer are skipped: the shortened form keeps four digits,
    // so it would be the id itself — and only hit unrelated numbers. Measured
    // group ids are seven digits (krobi's installation, 2026-09-22).
    for (const id of digitIds) {
      if (DIGITS_RE.test(id) && id.length >= 5 && out.includes(id)) {
        out = out.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, "g"), this.deviceId(id));
      }
    }
    return out;
  }

  /**
   * Walk a already-cloned structure and pseudonymise every string in it, keys
   * included — a Govee response can key a map by device id.
   *
   * Values under {@link SHAPELESS_KEYS} and digit ids under {@link ID_KEYS}
   * are replaced by key, because no pattern can find them.
   *
   * @param value Freshly cloned value, safe to mutate
   * @param names Device names to replace inside strings
   * @param digitIds Device ids made of digits only, replaced inside strings
   * @returns The value with every string pseudonymised
   */
  walk(value: unknown, names: readonly string[] = [], digitIds: readonly string[] = []): unknown {
    if (typeof value === "string") {
      return this.text(value, names, digitIds);
    }
    if (Array.isArray(value)) {
      return value.map(v => this.walk(v, names, digitIds));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const key = k.toLowerCase();
        const kind = SHAPELESS_KEYS.get(key);
        const addr = key === "addr" ? littleEndianIpv4(v) : undefined;
        const byKey =
          kind !== undefined && (typeof v === "string" || typeof v === "number") && v !== ""
            ? this.marker(kind, String(v))
            : ID_KEYS.has(key)
              ? this.digitId(key, v)
              : addr !== undefined
                ? this.ip(addr)
                : undefined;
        // A key is renamed by shape (a device id as a map key), never by a
        // device NAME — a device called "state" would rename every `state`
        // key of the report (audit N9).
        out[this.text(k, [], digitIds)] = byKey ?? this.walk(v, names, digitIds);
      }
      return out;
    }
    return value;
  }
}
