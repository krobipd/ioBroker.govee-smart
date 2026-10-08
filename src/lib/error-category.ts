// The error taxonomy: which kind of failure an error is, and the one dedup rule for logging it.
import { errText } from "./err-text";
import { HttpError } from "./http-client";
import type { LogOnce } from "./log-once";

/** Error categories for dedup logging */
export type ErrorCategory =
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "RATE_LIMIT"
  /** Govee returned 454 with no code in the request body — user must request a verification code via Settings. */
  | "VERIFICATION_PENDING"
  /** Govee returned 454 with code already sent, or 455 — code is wrong or expired, user must request a fresh one. */
  | "VERIFICATION_FAILED"
  | "UNKNOWN";

/** Every {@link ErrorCategory} — the check for a category carried as a field. */
const ERROR_CATEGORIES = [
  "NETWORK",
  "TIMEOUT",
  "AUTH",
  "RATE_LIMIT",
  "VERIFICATION_PENDING",
  "VERIFICATION_FAILED",
  "UNKNOWN",
] as const satisfies readonly ErrorCategory[];

/**
 * Classify an error into a category for dedup logging.
 * Only the category is used as key — not context or full message.
 *
 * @param err Error to classify
 */
export function classifyError(err: unknown): ErrorCategory {
  // A rejection that was classified where Govee's numeric answer was still at
  // hand (the account login) carries its category — nothing is read back out
  // of a sentence built from it.
  const carried: unknown = (err as { category?: unknown } | null)?.category;
  if (typeof carried === "string" && (ERROR_CATEGORIES as readonly string[]).includes(carried)) {
    return carried as ErrorCategory;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" ||
      code === "ENOTFOUND" ||
      code === "ENETUNREACH" ||
      code === "ECONNRESET" ||
      code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
      return "TIMEOUT";
    }
    // mqtt.js CONNACK reason codes: 4 = bad user name or password, 5 = not
    // authorized — the broker rejected the credentials (API key / account).
    const reasonCode: unknown = (err as { code?: unknown }).code;
    if (reasonCode === 4 || reasonCode === 5) {
      return "AUTH";
    }
    // An HTTP error carries its status as a field — that is the authoritative
    // signal, not a number that happens to occur in the message text.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      if (status === 429) {
        return "RATE_LIMIT";
      }
      if (status === 401 || status === 403) {
        return "AUTH";
      }
    }
  }
  // Through the same renderer the log uses: a rejected plain object carries its
  // fields here instead of `[object Object]`, so a thrown `{ code: "ECONNRESET" }`
  // reaches the marker test below rather than falling through to UNKNOWN.
  const msg = errText(err);
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ENETUNREACH") ||
    msg.includes("EHOSTUNREACH") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("ECONNRESET")
  ) {
    return "NETWORK";
  }
  // Text markers are matched as WORDS, never as bare substrings: an "Invalid
  // JSON" error quotes the first 100 characters of a foreign body, and a Govee
  // maintenance page containing "author" or "401" in that snippet used to be
  // classified AUTH — which stops the Cloud retry loop for good and tells the
  // user to check a perfectly valid API key. The account login and the HTTP
  // timeout carry their category / code as fields (checked above), so no
  // sentence of ours is parsed back here.
  if (/\b(rate limit(ed)?|too many requests)\b/i.test(msg)) {
    return "RATE_LIMIT";
  }
  if (/\b(unauthori[sz]ed|not authori[sz]ed|forbidden|authentication failed|bad username or password)\b/i.test(msg)) {
    return "AUTH";
  }
  return "UNKNOWN";
}

/**
 * Whether a failure category means the counterpart could not be reached (no answer at all).
 *
 * @param category The classified failure, if any
 * @returns true for TIMEOUT and NETWORK
 */
export function isOutage(category: ErrorCategory | null | undefined): boolean {
  return category === "TIMEOUT" || category === "NETWORK";
}

/**
 * Log a failed call to a counterpart. An unreachable counterpart (TIMEOUT, NETWORK) is a state the adapter shows —
 * `info.connection`, the device's reachability, `info.cloudConnected` — not a line (krobi 2026-10-03, the cloud
 * included): debug only. Any other failure is said once per key and kind, a repeat goes to debug (fleet master
 * `log-once.ts`).
 *
 * @param once The caller's LogOnce
 * @param log Adapter logger (for the debug line)
 * @param key What the failure belongs to — a channel, an endpoint, a device
 * @param err Caught error
 * @param line The line to log
 * @returns The error's category (for the diagnostics report)
 */
export function logCallFailure(
  once: LogOnce,
  log: Pick<ioBroker.Logger, "debug">,
  key: string,
  err: unknown,
  line: string,
): ErrorCategory {
  const category = classifyError(err);
  if (isOutage(category)) {
    log.debug(line);
  } else {
    once.report(key, line, { kind: category });
  }
  return category;
}

/**
 * The text a warning shows for an error. A connection that could not be made
 * is said in words with its probable cause in the same line (issue #51: the raw
 * `getaddrinfo EAI_AGAIN openapi.api.govee.com` named neither the DNS nor what
 * to look at); every other error keeps its own message. Node's DNS errors carry
 * the name as `hostname`, its connect errors the address as `address`. A
 * command sent again after such a failure carries `attempts` — the line says
 * how often it was tried.
 *
 * @param err The error
 */
export function describeError(err: unknown): string {
  const e = err as { code?: unknown; hostname?: unknown; address?: unknown; attempts?: unknown } | null;
  const host = typeof e?.hostname === "string" ? e.hostname : typeof e?.address === "string" ? e.address : "the server";
  let text: string;
  switch (e?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      text = `${host} could not be resolved — DNS problem on this host?`;
      break;
    case "ECONNREFUSED":
      text = `${host} refused the connection`;
      break;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      text = `no route to ${host} — network down?`;
      break;
    case "ECONNRESET":
      text = `the connection to ${host} was cut off`;
      break;
    default:
      text = errText(err);
  }
  const attempts = e?.attempts;
  return typeof attempts === "number" && attempts > 1 ? `${text} (tried ${attempts} times)` : text;
}

/**
 * Pure formatter — exported for tests. Translates an ErrorCategory into a
 * user-facing line. No I/O, no side-effects. A rejected key never comes here —
 * the actionable-problems registry names it once with what to do — and the
 * verification categories belong to the account login, not to a channel call.
 *
 * @param channel channel name
 * @param category classified error category
 * @param err the original error (used for HttpError statusCode + message)
 * @param retryHint optional retry hint string
 * @param context optional rich-context phrase ("while loading device list")
 */
export function formatChannelFail(
  channel: string,
  category: ErrorCategory,
  err: unknown,
  retryHint?: string,
  context?: string,
): string {
  const contextSuffix = context ? ` (${context})` : "";
  const retrySuffix = retryHint ? ` — ${retryHint}` : "";

  switch (category) {
    case "TIMEOUT": {
      // Timeout-Errors carry their own URL+ms in the message (since v2.10.1
      // http-client.ts:170 enriches the message). Use that directly.
      const detail = err instanceof Error ? errText(err) : "Timeout";
      return `${channel}: ${detail}${retrySuffix}`;
    }
    case "NETWORK":
      // In words with the probable cause (issue #51) — "network error (EAI_AGAIN)" named neither.
      return `${channel}: ${describeError(err)}${contextSuffix}${retrySuffix}`;
    case "RATE_LIMIT": {
      const status = err instanceof HttpError ? err.statusCode : null;
      const statusPart = status ? ` (HTTP ${status})` : "";
      const hint = retryHint ?? "retrying after Retry-After window";
      return `${channel}: rate-limited by Govee${statusPart} — ${hint}`;
    }
    case "UNKNOWN":
    default: {
      const msg = errText(err);
      return `${channel}: request failed${contextSuffix} — ${msg}${retrySuffix}`;
    }
  }
}
