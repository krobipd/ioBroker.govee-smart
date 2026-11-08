// The limits of every counterpart the adapter calls, defined once in api-limits.json (GV-08, krobi 2026-10-07 10:14:
// "API limits must be clearly defined in the adapter and checked"). No imports besides the file: timing-constants reads
// the windows of the rate limiter from here, call-gate.ts keeps the short windows of every request.
// The path goes through src/ so it names the same file from src/lib and from the built build/lib, and the package
// carries it there (package.json `files`). It is loaded with require at runtime — the adapter reads its pace only from
// this declaration.
import limitsFile from "../../src/lib/api-limits.json";

/** One limit: at most `max` calls in any `seconds` window, per account, per host or per device. */
export interface ApiLimit {
  /** Calls allowed in the window. */
  max: number;
  /** Window length in seconds. */
  seconds: number;
  /**
   * `account`: every matching call counts together; `host`: each host on its own; `device`: each value of the named
   * group `device` of the counterpart's `pathPattern` or `bodyPattern`.
   */
  per: "account" | "host" | "device";
  /** Where the number comes from. */
  source: string;
}

/** Which calls belong to a counterpart — every given field must fit. */
export interface CounterpartMatch {
  /** The host called. */
  host?: string;
  /** An anchored regular expression over the host. */
  hostPattern?: string;
  /** `private`: an address that never leaves the user's network. */
  network?: "private";
  /** Port called. */
  port?: number;
  /** `http`, `udp`, `tcp` or `tcp-write`. */
  kind?: string;
  /** HTTP method. */
  method?: string;
  /** An anchored regular expression over the request path (without the query). */
  pathPattern?: string;
  /** A regular expression over the request body. */
  bodyPattern?: string;
}

/** A counterpart and how its calls are recognised. */
export interface Counterpart {
  /** Human name. */
  name: string;
  /** Which calls belong to it. */
  match: CounterpartMatch;
  /** Its limits. */
  limits: ApiLimit[];
}

/** One call as the limits see it. */
export interface LimitedCall {
  /** `http`, `udp`, `tcp` or `tcp-write`. */
  kind: string;
  /** Host or address called. */
  host: string;
  /** Port called (undefined for http). */
  port?: number;
  /** HTTP method. */
  method?: string;
  /** Request path without the query. */
  path?: string;
  /** Request body as sent. */
  body?: string;
}

/** Every declared counterpart. */
export const COUNTERPARTS: readonly Counterpart[] = (limitsFile as { counterparts: Counterpart[] }).counterparts;

/**
 * Whether an address never leaves the user's network: RFC 1918, loopback, link-local, multicast, the limited broadcast,
 * IPv6 unique-local and link-local, `.local` names (RFC 6762) — the reading of the fleet's limit judgement.
 *
 * @param host Host or address
 */
export function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name.endsWith(".local")) {
    return true;
  }
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 239 ||
      (a === 224 && b === 0 && c === 0) ||
      name.endsWith("255.255.255.255")
    );
  }
  return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
}

/**
 * Whether a call belongs to a counterpart: every field of its `match` fits — the rule the fleet judges the run by.
 *
 * @param call The call
 * @param match The counterpart's `match`
 */
export function fits(call: LimitedCall, match: CounterpartMatch): boolean {
  return (
    (match.host === undefined || match.host === call.host) &&
    (match.hostPattern === undefined || new RegExp(match.hostPattern).test(call.host)) &&
    (match.network === undefined || isPrivateHost(call.host)) &&
    (match.port === undefined || match.port === call.port) &&
    (match.kind === undefined || match.kind === call.kind) &&
    (match.method === undefined || match.method === call.method) &&
    (match.pathPattern === undefined || (call.path !== undefined && new RegExp(match.pathPattern).test(call.path))) &&
    (match.bodyPattern === undefined || (call.body !== undefined && new RegExp(match.bodyPattern).test(call.body)))
  );
}

/**
 * Every counterpart a call belongs to — a call to a limited endpoint counts for the endpoint and for its host.
 *
 * @param call The call
 */
export function counterpartsFor(call: LimitedCall): Counterpart[] {
  return COUNTERPARTS.filter(c => fits(call, c.match));
}

/**
 * The first counterpart a call of this kind to this host and port belongs to — whether the address is declared at all.
 *
 * @param kind `http`, `udp`, `tcp` or `tcp-write`
 * @param host Host or address called
 * @param port Port called (undefined for http)
 */
export function counterpartFor(kind: string, host: string, port?: number): Counterpart | undefined {
  return counterpartsFor({ kind, host, port })[0];
}

/**
 * The device a call is for under a limit `per: "device"`: the named group `device` of the counterpart's path or body
 * pattern, the way the fleet judges it — undefined when neither names one.
 *
 * @param call The call
 * @param match The counterpart's `match`
 */
export function deviceOf(call: LimitedCall, match: CounterpartMatch): string | undefined {
  for (const [pattern, text] of [
    [match.pathPattern, call.path],
    [match.bodyPattern, call.body],
  ] as const) {
    const device = pattern && text !== undefined ? new RegExp(pattern).exec(text)?.groups?.device : undefined;
    if (device !== undefined) {
      return device;
    }
  }
  return undefined;
}

/**
 * A declared counterpart by name — the code that keeps a limit names its counterpart; a renamed or removed entry
 * fails at load, not silently.
 *
 * @param name The counterpart's `name`
 */
export function counterpartNamed(name: string): Counterpart {
  const found = COUNTERPARTS.find(c => c.name === name);
  if (!found) {
    throw new Error(`api-limits.json declares no counterpart "${name}"`);
  }
  return found;
}

/**
 * The one limit of a counterpart with this window length.
 *
 * @param name The counterpart's `name`
 * @param seconds The window length
 */
export function limitOf(name: string, seconds: number): ApiLimit {
  const found = counterpartNamed(name).limits.find(l => l.seconds === seconds);
  if (!found) {
    throw new Error(`api-limits.json gives "${name}" no ${seconds} s limit`);
  }
  return found;
}
