import { HttpError } from "./http-client";
import { classifyError, errMessage, type ErrorCategory } from "./types";

/**
 * Per-channel/per-category dedup tracker — fires the warn message once per
 * category, subsequent failures in the same category drop to debug. Same
 * warn-on-change / debug-on-repeat policy as `logDedup` (types.ts), but each
 * channel carries its own tracker so channels dedup independently and the
 * warn line is the user-translated message from {@link formatChannelFail}.
 */
export interface ChannelDedupState {
  /** Last category seen for this channel. null = next failure is a fresh warn. */
  lastCategory: ErrorCategory | null;
}

/**
 * Options for `logChannelFail`. Most callers only fill `channel` and `err`.
 */
export interface LogChannelFailOptions {
  /** Human-readable channel name shown in the log message ("Cloud REST", "Lights Push", "Sensor Push"). */
  channel: string;
  /** The error to translate + log. */
  err: unknown;
  /** Optional retry hint shown to user, e.g. "retrying every 5 min" or "retrying after 60 s". */
  retryHint?: string;
  /** Optional rich-context phrase appended for TIMEOUT/NETWORK, e.g. "while loading device list". */
  context?: string;
  /** Dedup tracker — pass the same object across calls for one channel. */
  dedup: ChannelDedupState;
}

/**
 * User-zentriert formatting for a channel failure. Translates the classified
 * category into a human-readable line. First occurrence in a category goes to
 * warn, subsequent ones drop to debug to prevent log spam.
 *
 * The full err.message + stack go to debug only — the warn line stays clean
 * so admins can see at a glance WHAT failed without scrolling through Node
 * internals.
 *
 * @param log ioBroker logger
 * @param opts options
 */
export function logChannelFail(log: ioBroker.Logger, opts: LogChannelFailOptions): void {
  const { channel, err, retryHint, context, dedup } = opts;
  const category = classifyError(err);
  const userMessage = formatChannelFail(channel, category, err, retryHint, context);
  const rawMessage = errMessage(err);

  if (dedup.lastCategory === category) {
    // Same failure category as last time — drop to debug to avoid spam.
    log.debug(`${userMessage} (repeated; raw: ${rawMessage})`);
    return;
  }

  dedup.lastCategory = category;
  log.warn(userMessage);
  // Stack trace + raw message go to debug, not warn — the user gets a clear
  // statement and the dev has the details once debug logging is enabled.
  if (err instanceof Error && err.stack) {
    log.debug(`${channel} fail detail: ${err.stack}`);
  } else {
    log.debug(`${channel} fail detail: ${rawMessage}`);
  }
}

/**
 * Pure formatter — exported for tests. Translates an ErrorCategory into a
 * user-facing line. No I/O, no side-effects.
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
      const detail = err instanceof Error ? err.message : "Timeout";
      return `${channel}: ${detail}${retrySuffix}`;
    }
    case "NETWORK": {
      const code = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? "") : "";
      const codePart = code ? ` (${code})` : "";
      return `${channel}: network error${codePart}${contextSuffix}${retrySuffix}`;
    }
    case "AUTH": {
      const status = err instanceof HttpError ? err.statusCode : null;
      const statusPart = status ? ` (HTTP ${status})` : "";
      return `${channel}: authentication failed${statusPart} — check adapter config, no auto-retry`;
    }
    case "RATE_LIMIT": {
      const status = err instanceof HttpError ? err.statusCode : null;
      const statusPart = status ? ` (HTTP ${status})` : "";
      const hint = retryHint ?? "retrying after Retry-After window";
      return `${channel}: rate-limited by Govee${statusPart} — ${hint}`;
    }
    case "VERIFICATION_PENDING":
      return `${channel}: verification code required — open adapter Settings and request a code`;
    case "VERIFICATION_FAILED":
      return `${channel}: verification code rejected — request a fresh code in Settings`;
    case "UNKNOWN":
    default: {
      const msg = errMessage(err);
      return `${channel}: request failed${contextSuffix} — ${msg}${retrySuffix}`;
    }
  }
}
