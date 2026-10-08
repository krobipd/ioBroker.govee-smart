// The limits of every counterpart the adapter calls, defined once in api-limits.json (GV-08, krobi 2026-10-07 10:14:
// "API limits must be clearly defined in the adapter and checked"). No imports besides the file: timing-constants reads
// the daily OpenAPI budget from here. The gate that keeps the short windows is call-gate.ts.
// The path goes through src/ so it names the same file from src/lib and from the built build/lib, and the package
// carries it there (package.json `files`).
import limitsFile from "../../src/lib/api-limits.json";

/** One limit: at most `max` calls in any `seconds` window, per account or per host. */
export interface ApiLimit {
  /** Calls allowed in the window. */
  max: number;
  /** Window length in seconds. */
  seconds: number;
  /** `account`: every matching call counts together; `host`: each host on its own. */
  per: "account" | "host";
  /** Where the number comes from. */
  source: string;
}

/** A counterpart and how its calls are recognised. */
export interface Counterpart {
  /** Human name. */
  name: string;
  /** Which calls belong to it — every given field must fit. */
  match: { host?: string; hostPattern?: string; port?: number; kind?: string };
  /** Its limits. */
  limits: ApiLimit[];
}

/** Every declared counterpart. */
export const COUNTERPARTS: readonly Counterpart[] = (limitsFile as { counterparts: Counterpart[] }).counterparts;

/**
 * The counterpart a call belongs to.
 *
 * @param kind `http`, `udp`, `tcp` or `tcp-write`
 * @param host Host or address called
 * @param port Port called (undefined for http)
 */
export function counterpartFor(kind: string, host: string, port?: number): Counterpart | undefined {
  return COUNTERPARTS.find(
    c =>
      (c.match.kind === undefined || c.match.kind === kind) &&
      (c.match.host === undefined || c.match.host === host) &&
      (c.match.hostPattern === undefined || new RegExp(c.match.hostPattern).test(host)) &&
      (c.match.port === undefined || c.match.port === port),
  );
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
