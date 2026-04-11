import * as https from "node:https";

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
}

/**
 * Perform an HTTPS request and parse the JSON response.
 *
 * @param options Request options
 */
export function httpsRequest<T>(options: HttpRequestOptions): Promise<T> {
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
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const statusCode = res.statusCode ?? 0;

        if (statusCode < 200 || statusCode >= 400) {
          reject(
            new HttpError(
              `HTTP ${statusCode}: ${raw.slice(0, 200)}`,
              statusCode,
              res.headers,
            ),
          );
          return;
        }

        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/** HTTP error with status code and response headers */
export class HttpError extends Error {
  /** HTTP status code */
  readonly statusCode: number;
  /** Response headers */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * @param message Error message
   * @param statusCode HTTP status code
   * @param headers Response headers
   */
  constructor(
    message: string,
    statusCode: number,
    headers: Record<string, string | string[] | undefined> = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.headers = headers;
  }
}
