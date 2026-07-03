import * as https from "node:https";

/**
 * Module-level keep-alive agent — avoids the TLS handshake (~200ms) per
 * request. maxSockets limits parallel connections per host so we don't
 * accidentally hit Govee with 100 simultaneous calls.
 */
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

/** Options for an HTTPS request */
export interface HttpRequestOptions {
  /** HTTP method */
  method: "GET" | "POST";
  /** Full URL */
  url: string;
  /** HTTP headers */
  headers: Record<string, string>;
  /** Request body (POST only, will be JSON-serialized) */
  body?: unknown;
  /** Timeout in milliseconds (default 15000) */
  timeout?: number;
  /** Optional AbortSignal — the request is aborted as soon as abort() fires. */
  signal?: AbortSignal;
}

/**
 * Result envelope returned by every successful httpsRequest. `value` is the
 * parsed JSON; it is `null` when Govee returned an empty body or a plain-text
 * HTTP-status-line body (see `fallback`). The status code + body snippet are
 * always present so callers can debug-log without enabling silly level — this
 * closes the gap from Issue #13 where `App API .../sku-supported-feature: null`
 * gave no hint *why* it was null.
 */
export interface HttpResult<T> {
  /** Parsed JSON. `null` when fallback is `"empty"` or `"plain-text-status"`. */
  value: T | null;
  /** HTTP status code (200-399 — 4xx/5xx reject as HttpError). */
  statusCode: number;
  /**
   * Set when the response wasn't JSON. `"empty"` = empty/whitespace body
   * (some Govee endpoints return bare 200 for SKUs they don't recognise).
   * `"plain-text-status"` = body like `"403 Forbbiden"` (Govee's typo) — a
   * server-side bug observed for some SKU/bearer combinations.
   */
  fallback?: "empty" | "plain-text-status";
  /**
   * First ~100 chars of the body when `fallback` is set, so callers can
   * log "why is this null" without enabling silly-level wire logging.
   */
  bodySnippet?: string;
}

/**
 * Signature of the httpsRequest function. Cloud/MQTT clients take it as an
 * optional DI parameter — the default is the real httpsRequest, and tests can
 * inject a mock without module replacement.
 */
export type HttpsRequestFn = <T>(options: HttpRequestOptions) => Promise<HttpResult<T>>;

/**
 * Interpret an already-2xx response body into the {@link HttpResult} envelope.
 * Empty/whitespace → fallback `"empty"`; a short `NNN <text>` HTTP-status-line
 * body (Govee returns these for some SKU/bearer combos, e.g. the literal
 * `"403 Forbbiden"` — their typo) → fallback `"plain-text-status"`; otherwise
 * the parsed JSON. Throws on invalid JSON with a body-prefixed message (the
 * caller rejects the promise with it). Extracted as a pure function so the
 * Issue-#13 fallback logic is unit-testable without a live socket.
 *
 * @param raw The raw response body string
 * @param statusCode The (already-validated 2xx) HTTP status code
 */
export function interpretOkBody<T>(raw: string, statusCode: number): HttpResult<T> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: null, statusCode, fallback: "empty" };
  }
  // Conservative `^<3-digit-status> <non-whitespace>` plus a 100-char length
  // cap catches the plain-text status line without swallowing JSON literals
  // that happen to start with a number (`123.45` lacks the trailing space+text).
  if (trimmed.length < 100 && /^\d{3}\s+\S/.test(trimmed)) {
    return { value: null, statusCode, fallback: "plain-text-status", bodySnippet: trimmed };
  }
  try {
    return { value: JSON.parse(raw) as T, statusCode };
  } catch (parseErr) {
    // 100-char body prefix so "returned HTML / non-JSON 200" is diagnosable
    // without debug log; the cap keeps echoed request data out of warn logs.
    const snippet = raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Invalid JSON in HTTP ${statusCode} response: ${detail} — body starts with: ${snippet}`);
  }
}

/**
 * Perform an HTTPS request and parse the JSON response. Resolves with an
 * {@link HttpResult} envelope (`value` + `statusCode` + optional `fallback`/
 * `bodySnippet`) for 2xx/3xx, rejects with {@link HttpError} for 4xx/5xx.
 *
 * @param options Request options
 */
export function httpsRequest<T>(options: HttpRequestOptions): Promise<HttpResult<T>> {
  return new Promise((resolve, reject) => {
    const u = new URL(options.url);
    const postData = options.body ? JSON.stringify(options.body) : undefined;

    const reqOptions: https.RequestOptions = {
      method: options.method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        ...options.headers,
        ...(postData
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(postData),
            }
          : {}),
      },
      timeout: options.timeout ?? 15_000,
      agent: keepAliveAgent,
    };

    // Track the abort listener so we can detach it when the request resolves
    // or rejects normally — without this the AbortSignal accumulates one
    // dead listener per completed request, leaking memory if the same signal
    // is re-used for many requests.
    let onAbort: (() => void) | null = null;
    const cleanupAbort = (): void => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };

    const req = https.request(reqOptions, res => {
      const chunks: Buffer[] = [];
      // res.on("error") catches mid-stream failures (TCP RST after headers,
      // socket-close before "end" fires). Without this, such errors propagate
      // to the global "uncaughtException" handler instead of rejecting the
      // promise — and the caller sees the request hang until the 15 s timeout.
      res.on("error", err => {
        cleanupAbort();
        reject(err);
      });
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        cleanupAbort();
        const raw = Buffer.concat(chunks).toString();
        const statusCode = res.statusCode ?? 0;

        if (statusCode < 200 || statusCode >= 400) {
          // M4 — keep the body snippet out of the error message so tokens /
          // API keys don't show up in the warn log if the server reflects
          // them. responseBody stays separately available for debug.
          reject(new HttpError(`HTTP ${statusCode}`, statusCode, res.headers, raw));
          return;
        }

        // Empty / plain-text-status / JSON interpretation lives in the pure,
        // unit-tested interpretOkBody() (the Issue #13 fallbacks). It throws on
        // invalid JSON, which we surface as a rejected promise.
        try {
          resolve(interpretOkBody<T>(raw, statusCode));
        } catch (parseErr) {
          reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
        }
      });
    });

    req.on("error", err => {
      cleanupAbort();
      reject(err);
    });
    // M5 — the timeout error carries the endpoint + wait duration in its text
    // so the warn log tells the user WHERE and HOW LONG it waited. Previously
    // just "Timeout" without context → the stack trace was the only source of
    // info, and that is dev-speak.
    req.on("timeout", () => {
      const ms = reqOptions.timeout ?? 15_000;
      const method = options.method ?? "GET";
      req.destroy(new Error(`Timeout after ${ms}ms for ${method} ${reqOptions.hostname}${reqOptions.path}`));
    });

    // M3 — AbortSignal support. Whoever makes the request can abort it
    // (e.g. adapter onUnload via AbortController) so the stop doesn't have to
    // wait 15s for the timeout.
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error("Aborted"));
        reject(new Error("Aborted"));
        return;
      }
      onAbort = (): void => {
        req.destroy(new Error("Aborted"));
        reject(new Error("Aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/** HTTP error with status code, response headers, and response body (debug-only) */
export class HttpError extends Error {
  /** HTTP status code */
  readonly statusCode: number;
  /** Response headers */
  readonly headers: Record<string, string | string[] | undefined>;
  /**
   * Raw response body — NOT in `message` so tokens / API keys aren't leaked
   * via the warn log. Available only for targeted debug logging at the caller.
   */
  readonly responseBody: string;

  /**
   * @param message Error message (Body-frei)
   * @param statusCode HTTP status code
   * @param headers Response headers
   * @param responseBody Raw response body (kann sensitive Echo-Daten enthalten)
   */
  constructor(
    message: string,
    statusCode: number,
    headers: Record<string, string | string[] | undefined> = {},
    responseBody: string = "",
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}

/**
 * Format the tail of a fallback log line for a non-JSON (empty / plain-text
 * status) 2xx response. Shared by the App-API and Cloud clients so the
 * "why is this null?" trace reads identically; the caller prefixes the endpoint.
 *
 * @param result HttpResult whose `fallback` is set
 */
export function formatFallback(result: HttpResult<unknown>): string {
  return `${result.fallback} (status=${result.statusCode}${
    result.bodySnippet ? `, body=${JSON.stringify(result.bodySnippet)}` : ""
  }) — treated as no data`;
}
