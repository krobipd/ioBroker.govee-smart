// The error taxonomy: which kind of failure an error is, and the one dedup rule for logging it.
import { errMessage } from "./err-message";

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
  const msg = errMessage(err);
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
 * Dedup-aware error logger.
 *
 * Compares the new error category against the caller's last category. On
 * change → warn (so the user sees fresh failures). On repeat → debug (so the
 * log doesn't spam). Returns the new category so the caller can update its
 * `lastErrorCategory` member.
 *
 * Caller pattern:
 * ```ts
 * this.lastErrorCategory = logDedup(this.log, this.lastErrorCategory, "Cloud", err);
 * ```
 *
 * @param log Adapter logger
 * @param last Previous category (null on first call)
 * @param context Short prefix (e.g. "Cloud", "MQTT", "App-API")
 * @param err Caught error
 * @returns New category (assign to caller's tracker)
 */
export function logDedup(
  log: ioBroker.Logger,
  last: ErrorCategory | null,
  context: string,
  err: unknown,
): ErrorCategory {
  const category = classifyError(err);
  const msg = errMessage(err);
  if (category !== last) {
    log.warn(`${context}: ${msg}`);
  } else {
    log.debug(`${context}: ${msg} (repeated)`);
  }
  return category;
}
