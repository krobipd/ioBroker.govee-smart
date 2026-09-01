import * as http from "node:http";
import { extractHttpStatus, formatFallback, HttpError, httpsRequest, interpretOkBody } from "./http-client";
import type { HttpResult } from "./http-client";

/**
 * Local HTTP stub server — `http`, not `https`, so the tests don't need a
 * pre-generated TLS cert. `httpsRequest` takes an injectable transport, so
 * these tests run the production function itself against the stub.
 */

interface StubResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  /** Optional delay in ms before responding — used for timeout/abort tests. */
  delayMs?: number;
  /** If true, write headers and partial body, then destroy mid-stream. */
  destroyMidBody?: boolean;
}

interface StubServer {
  port: number;
  queue: StubResponse[];
  requests: Array<{ method: string; path: string; body: string; headers: http.IncomingHttpHeaders }>;
  stop(): Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const queue: StubResponse[] = [];
  const requests: Array<{ method: string; path: string; body: string; headers: http.IncomingHttpHeaders }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c as Buffer));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString(),
        headers: req.headers,
      });
      const stub = queue.shift();
      if (!stub) {
        res.statusCode = 500;
        res.end("no stub queued");
        return;
      }
      const respond = (): void => {
        res.statusCode = stub.statusCode;
        for (const [k, v] of Object.entries(stub.headers ?? {})) {
          res.setHeader(k, v);
        }
        if (stub.destroyMidBody) {
          // Announce a long body, send a fragment, kill the socket: Node then
          // raises 'error' (aborted) on the response instead of 'end'. Without
          // the declared length a chunked close still ends the stream and the
          // JSON parse rejects — which would let a missing error handler pass.
          res.setHeader("content-length", "100000");
          res.write("partial-");
          setTimeout(() => res.socket?.destroy(), 10);
          return;
        }
        res.end(stub.body ?? "");
      };
      if (stub.delayMs) {
        setTimeout(respond, stub.delayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind stub server");
  }
  return {
    port: address.port,
    queue,
    requests,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/**
 * `httpsRequest` clone using `http` instead of `https` — same logic, no TLS.
 * The point of the tests is the request/response handling, not the TLS layer.
 */
/**
 * The tests drive the REAL httpsRequest with a node:http transport (the
 * `transport` seam added in v2.26.0). Before that this file carried a copy of
 * the implementation, so a bug in production code failed nothing here.
 */
function httpRequestPlain<T>(options: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<HttpResult<T>> {
  return httpsRequest<T>(options, { request: http.request });
}

describe("HttpError", () => {
  it("stores statusCode + headers + responseBody separately from message", () => {
    const e = new HttpError("HTTP 404", 404, { "x-foo": "bar" }, "not found body");
    expect(e.statusCode).toBe(404);
    expect(e.headers["x-foo"]).toBe("bar");
    expect(e.responseBody).toBe("not found body");
    // Body MUST NOT leak into message — token-safety guarantee.
    expect(e.message).toBe("HTTP 404");
    expect(e.message).not.toContain("not found body");
  });

  it("defaults headers and responseBody when omitted", () => {
    const e = new HttpError("oops", 500);
    expect(e.headers).toEqual({});
    expect(e.responseBody).toBe("");
  });

  it("name is HttpError so `e instanceof Error` works alongside name-based checks", () => {
    const e = new HttpError("x", 400);
    expect(e.name).toBe("HttpError");
    expect(e instanceof Error).toBe(true);
  });
});

describe("interpretOkBody (pure envelope parser — the real production fn)", () => {
  it("resolves parsed JSON for a normal body", () => {
    expect(interpretOkBody<{ a: number }>('{"a":1}', 200)).toEqual({ value: { a: 1 }, statusCode: 200 });
  });

  it("flags empty / whitespace-only bodies as fallback 'empty'", () => {
    expect(interpretOkBody("", 200)).toEqual({ value: null, statusCode: 200, fallback: "empty" });
    expect(interpretOkBody("  \n\t ", 204)).toEqual({ value: null, statusCode: 204, fallback: "empty" });
  });

  it("flags short 'NNN <text>' status-line bodies as plain-text-status with the snippet", () => {
    expect(interpretOkBody("403 Forbbiden", 200)).toEqual({
      value: null,
      statusCode: 200,
      fallback: "plain-text-status",
      bodySnippet: "403 Forbbiden",
    });
  });

  it("does NOT treat a bare number literal as a status line", () => {
    expect(interpretOkBody<number>("123.45", 200)).toEqual({ value: 123.45, statusCode: 200 });
  });

  it("does NOT treat a long digit-leading body as a status line (length cap)", () => {
    expect(() => interpretOkBody(`500 Server Error ${"x".repeat(120)}`, 200)).toThrow(/Invalid JSON/);
  });

  it("throws an Invalid-JSON error with a body prefix, capping the snippet at 100 chars", () => {
    expect(() => interpretOkBody("<html>oops</html>", 200)).toThrow(/body starts with: <html>oops<\/html>/);
    try {
      interpretOkBody("@".repeat(250), 200);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(`${"@".repeat(100)}…`); // snippet capped at 100 chars + ellipsis
      expect(msg).not.toContain("@".repeat(101)); // the full 250-char body is NOT echoed into the log
    }
  });
});

describe("httpsRequest (HTTPS impl unit-tested via plain HTTP shim)", () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.stop();
  });

  it("parses 200 JSON response into HttpResult envelope", async () => {
    stub.queue.push({ statusCode: 200, body: JSON.stringify({ hello: "world" }) });
    const result = await httpRequestPlain<{ hello: string }>({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/foo`,
      headers: { Accept: "application/json" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.fallback).toBeUndefined();
    expect(result.value?.hello).toBe("world");
    expect(stub.requests[0].method).toBe("GET");
    expect(stub.requests[0].path).toBe("/foo");
  });

  it("sends POST body with content-type + content-length headers", async () => {
    stub.queue.push({ statusCode: 200, body: "{}" });
    await httpRequestPlain({
      method: "POST",
      url: `http://127.0.0.1:${stub.port}/x`,
      headers: { Authorization: "Bearer t" },
      body: { a: 1, b: "two" },
    });
    const req = stub.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["content-length"]).toBe(String(JSON.stringify({ a: 1, b: "two" }).length));
    expect(JSON.parse(req.body)).toEqual({ a: 1, b: "two" });
  });

  it("rejects with HttpError on 4xx/5xx, body in responseBody not message", async () => {
    stub.queue.push({ statusCode: 401, body: "your-secret-token-leaked" });
    try {
      await httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/auth`,
        headers: {},
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      if (e instanceof HttpError) {
        expect(e.statusCode).toBe(401);
        // Body MUST stay out of the message — caller can opt into the body
        // explicitly via e.responseBody when needed for debug.
        expect(e.message).not.toContain("your-secret-token-leaked");
        expect(e.responseBody).toContain("your-secret-token-leaked");
      }
    }
  });

  it("rejects with body-snippet hint when JSON parse fails", async () => {
    stub.queue.push({ statusCode: 200, body: "<html>oops</html>" });
    try {
      await httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/notjson`,
        headers: {},
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      // Snippet prefix gives the user a starting point without enabling debug
      expect((e as Error).message).toContain("body starts with: <html>oops</html>");
    }
  });

  it("resolves null+fallback='empty' on empty body (Pattern #56, Issue #13 v2.7.0)", async () => {
    // Some Govee undocumented endpoints return HTTP 200 with no body
    // for SKUs they don't recognise. Should resolve null instead of throwing.
    stub.queue.push({ statusCode: 200, body: "" });
    const result = await httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/empty`,
      headers: {},
    });
    expect(result.value).toBeNull();
    expect(result.fallback).toBe("empty");
    expect(result.statusCode).toBe(200);
  });

  it("resolves null+fallback='empty' on whitespace-only body (Pattern #56)", async () => {
    stub.queue.push({ statusCode: 200, body: "   \n\t  " });
    const result = await httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/whitespace`,
      headers: {},
    });
    expect(result.value).toBeNull();
    expect(result.fallback).toBe("empty");
  });

  it("resolves null+fallback='plain-text-status' with body snippet on '403 Forbbiden' (Issue #13 v2.8.2/v2.8.3)", async () => {
    // Govee returns HTTP 200 with a plain-text status-line body
    // ("403 Forbbiden" — their typo) for SKU/Bearer combos without
    // permission. v2.8.3 carries the snippet through HttpResult so
    // callers can debug-log it without enabling silly-level wire logs.
    stub.queue.push({ statusCode: 200, body: "403 Forbbiden" });
    const result = await httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/forbidden`,
      headers: {},
    });
    expect(result.value).toBeNull();
    expect(result.fallback).toBe("plain-text-status");
    expect(result.bodySnippet).toBe("403 Forbbiden");
    expect(result.statusCode).toBe(200);
  });

  it("resolves null+fallback='plain-text-status' on '401 Unauthorized' plain-text body", async () => {
    stub.queue.push({ statusCode: 200, body: "401 Unauthorized" });
    const result = await httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/unauth`,
      headers: {},
    });
    expect(result.value).toBeNull();
    expect(result.fallback).toBe("plain-text-status");
    expect(result.bodySnippet).toBe("401 Unauthorized");
  });

  it("does NOT swallow JSON literals that start with a number (e.g. `123.45`)", async () => {
    // The regex requires `<digits><whitespace><non-whitespace>` — `123.45`
    // has no trailing whitespace+text, so it goes through JSON.parse and
    // resolves as the number 123.45.
    stub.queue.push({ statusCode: 200, body: "123.45" });
    const result = await httpRequestPlain<number>({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/jsonnumber`,
      headers: {},
    });
    expect(result.value).toBe(123.45);
    expect(result.fallback).toBeUndefined();
  });

  it("does NOT swallow HTML-like error pages even if short", async () => {
    // <html>error</html> is short but doesn't match the status-line shape
    // (no leading 3-digit-status). Falls through to JSON.parse → rejects.
    stub.queue.push({ statusCode: 200, body: "<html>err</html>" });
    try {
      await httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/htmlerror`,
        headers: {},
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("body starts with:");
    }
  });

  it("does NOT swallow long plain-text bodies that happen to start with digits", async () => {
    // Length cap: only short status-line bodies (<100 chars) are treated
    // as null. A long plain-text payload like a server-error page should
    // still raise the diagnostic JSON-parse error.
    const longBody = `500 Server Error — ${"x".repeat(120)}`;
    stub.queue.push({ statusCode: 200, body: longBody });
    try {
      await httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/longerror`,
        headers: {},
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("Invalid JSON");
    }
  });

  it("rejects promptly with the stream error when the server drops the socket mid-body (H5 fix)", async () => {
    // Server writes a partial body and kills the socket. Without the
    // res.on("error") wiring the request would sit there until the timeout —
    // so the timeout here is long, and the rejection must arrive well before it
    // and must NOT be the timeout error.
    stub.queue.push({ statusCode: 200, destroyMidBody: true });
    const started = Date.now();
    await expect(
      httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/mid-fail`,
        headers: {},
        timeout: 30_000,
      }),
    ).rejects.toThrow(/^(?!Timeout)/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects with the endpoint + wait time in the message when the server never answers (timeout)", async () => {
    // The user reads the warn line, not a stack trace — it has to say WHERE
    // and HOW LONG the adapter waited.
    stub.queue.push({ statusCode: 200, body: "{}", delayMs: 400 });
    await expect(
      httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/slow-endpoint`,
        headers: {},
        timeout: 50,
      }),
    ).rejects.toThrow(/^Timeout after 50ms for GET 127\.0\.0\.1\/slow-endpoint$/);
  });

  it("rejects on AbortSignal aborted before request", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await httpRequestPlain({
        method: "GET",
        url: `http://127.0.0.1:${stub.port}/x`,
        headers: {},
        signal: ctrl.signal,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toBe("Aborted");
    }
  });

  it("rejects on AbortSignal mid-flight and detaches its abort listener", async () => {
    stub.queue.push({ statusCode: 200, body: "{}", delayMs: 500 });
    const ctrl = new AbortController();
    const removed = vi.spyOn(ctrl.signal, "removeEventListener");
    const reqPromise = httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/slow`,
      headers: {},
      signal: ctrl.signal,
      timeout: 5_000,
    });
    setTimeout(() => ctrl.abort(), 50);
    await expect(reqPromise).rejects.toThrow("Aborted");
    // The request's own abort handler is detached again once it fired —
    // a signal that is re-used for many requests must not collect one dead
    // listener per completed request.
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("detaches the abort listener after a normal completion (no listener leak on a re-used signal)", async () => {
    stub.queue.push({ statusCode: 200, body: "{}" });
    const ctrl = new AbortController();
    const removed = vi.spyOn(ctrl.signal, "removeEventListener");
    await httpRequestPlain({
      method: "GET",
      url: `http://127.0.0.1:${stub.port}/ok`,
      headers: {},
      signal: ctrl.signal,
    });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("formatFallback", () => {
  it("names the fallback kind, the status and (when present) the body snippet", () => {
    expect(formatFallback({ value: null, statusCode: 200, fallback: "empty" })).toBe(
      "empty (status=200) — treated as no data",
    );
    expect(
      formatFallback({ value: null, statusCode: 200, fallback: "plain-text-status", bodySnippet: "403 Forbbiden" }),
    ).toBe('plain-text-status (status=200, body="403 Forbbiden") — treated as no data');
  });
});

describe("extractHttpStatus", () => {
  it("pulls the HTTP status from known error shapes, else undefined", () => {
    expect(extractHttpStatus(new HttpError("rate", 429))).toBe(429);
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503);
    expect(extractHttpStatus({ status: 401 })).toBe(401);
    expect(extractHttpStatus(new Error("network"))).toBeUndefined();
    expect(extractHttpStatus("string error")).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
  });
});
