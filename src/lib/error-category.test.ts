import { classifyError, describeError, logDedup, type ErrorCategory } from "./error-category";

describe("classifyError", () => {
  it("should classify ECONNREFUSED as NETWORK", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe("NETWORK");
  });

  it("should classify ENOTFOUND as NETWORK", () => {
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.govee.com"))).toBe("NETWORK");
  });

  it("should classify ENETUNREACH as NETWORK", () => {
    expect(classifyError(new Error("ENETUNREACH"))).toBe("NETWORK");
  });

  it("classifies a temporary DNS failure by its text as NETWORK (issue #51)", () => {
    expect(classifyError(new Error("getaddrinfo EAI_AGAIN openapi.api.govee.com"))).toBe("NETWORK");
    expect(classifyError({ message: "getaddrinfo EAI_AGAIN openapi.api.govee.com" })).toBe("NETWORK");
  });

  it("classifies an unreachable host by its text as NETWORK", () => {
    expect(classifyError(new Error("connect EHOSTUNREACH 1.2.3.4:443"))).toBe("NETWORK");
    expect(classifyError("connect EHOSTUNREACH 1.2.3.4:443")).toBe("NETWORK");
  });

  it("should classify ECONNRESET as NETWORK", () => {
    expect(classifyError(new Error("read ECONNRESET"))).toBe("NETWORK");
  });

  it("should classify errors with .code property as NETWORK", () => {
    const err = new Error("connect failed") as NodeJS.ErrnoException;
    err.code = "EHOSTUNREACH";
    expect(classifyError(err)).toBe("NETWORK");

    const err2 = new Error("DNS lookup failed") as NodeJS.ErrnoException;
    err2.code = "EAI_AGAIN";
    expect(classifyError(err2)).toBe("NETWORK");
  });

  it("should classify ETIMEDOUT via .code as TIMEOUT", () => {
    const err = new Error("connect failed") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    expect(classifyError(err)).toBe("TIMEOUT");
  });

  it("should classify timeout errors as TIMEOUT", () => {
    expect(classifyError(new Error("Request timed out"))).toBe("TIMEOUT");
    // The http-client timeout carries its code — the shape it really throws.
    expect(
      classifyError(Object.assign(new Error("Timeout after 15000ms for GET host/path"), { code: "ETIMEDOUT" })),
    ).toBe("TIMEOUT");
  });

  it("reads a bare 'Timeout' in a text as nothing — no sentence is parsed back", () => {
    expect(classifyError(new Error("Timeout waiting for response"))).toBe("UNKNOWN");
  });

  it("a carried category field wins over every text marker", () => {
    expect(classifyError(Object.assign(new Error("forbidden rate limit"), { category: "VERIFICATION_PENDING" }))).toBe(
      "VERIFICATION_PENDING",
    );
    // an unknown value in the field is no category
    expect(classifyError(Object.assign(new Error("HTTP 403 Forbidden"), { category: "BOGUS" }))).toBe("AUTH");
  });

  it("should classify 401/403 as AUTH", () => {
    expect(classifyError(new Error("HTTP 401 Unauthorized"))).toBe("AUTH");
    expect(classifyError(new Error("HTTP 403 Forbidden"))).toBe("AUTH");
  });

  it("reads a login sentence as nothing — the login verdict travels as a field", () => {
    expect(classifyError(new Error("Login failed: invalid credentials"))).toBe("UNKNOWN");
    expect(classifyError(new Error("Verification required by Govee (status 454)"))).toBe("UNKNOWN");
  });

  it("should classify 429 as RATE_LIMIT", () => {
    expect(classifyError(new Error("HTTP 429 Too Many Requests"))).toBe("RATE_LIMIT");
  });

  it("should classify Rate limit as RATE_LIMIT", () => {
    expect(classifyError(new Error("Rate limit exceeded"))).toBe("RATE_LIMIT");
  });

  it("should classify Rate limited by Govee as RATE_LIMIT", () => {
    expect(classifyError(new Error("Rate limited by Govee: too many requests (status 429)"))).toBe("RATE_LIMIT");
  });

  it("should classify unknown errors as UNKNOWN", () => {
    expect(classifyError(new Error("Something unexpected happened"))).toBe("UNKNOWN");
  });

  it("classifies an HTTP error by its status field even when the message carries no marker", () => {
    // http-client rejects with `HttpError("HTTP 401", 401)` — the number is
    // a field, the message is just a label.
    const auth = Object.assign(new Error("HTTP 401"), { statusCode: 401 });
    const forbidden = Object.assign(new Error("HTTP 403"), { statusCode: 403 });
    const limited = Object.assign(new Error("HTTP 429"), { statusCode: 429 });
    const server = Object.assign(new Error("HTTP 503"), { statusCode: 503 });
    expect(classifyError(auth)).toBe("AUTH");
    expect(classifyError(forbidden)).toBe("AUTH");
    expect(classifyError(limited)).toBe("RATE_LIMIT");
    expect(classifyError(server)).toBe("UNKNOWN");
  });

  it("does NOT classify a quoted foreign body as AUTH just because it contains 'auth' or '401'", () => {
    // An "Invalid JSON" error quotes the first 100 chars of a Govee maintenance
    // page — treating that as AUTH stopped the Cloud retry loop for good and
    // told the user to check a valid API key.
    const html = new Error(
      'Invalid JSON in HTTP 200 response: Unexpected token < — body starts with: <html><meta name="author" content="ops 401">',
    );
    expect(classifyError(html)).toBe("UNKNOWN");
    expect(classifyError(new Error("device H1401 rejected the command"))).toBe("UNKNOWN");
  });

  it("classifies the mqtt.js credential-refused reason codes as AUTH", () => {
    const notAuthorized = Object.assign(new Error("Connection refused: Not authorized"), { code: 5 });
    const badCreds = Object.assign(new Error("Connection refused: Bad username or password"), { code: 4 });
    expect(classifyError(notAuthorized)).toBe("AUTH");
    expect(classifyError(badCreds)).toBe("AUTH");
    // The same texts without a code still classify by their words.
    expect(classifyError(new Error("Connection refused: Not authorized"))).toBe("AUTH");
  });

  it("should handle string errors", () => {
    expect(classifyError("ECONNREFUSED")).toBe("NETWORK");
  });

  it("should handle non-Error objects", () => {
    expect(classifyError({ code: "ERR" })).toBe("UNKNOWN");
  });
});

describe("logDedup", () => {
  function makeMockLog(): {
    log: ioBroker.Logger;
    warns: string[];
    debugs: string[];
  } {
    const warns: string[] = [];
    const debugs: string[] = [];
    const log: ioBroker.Logger = {
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
      debug: (m: string) => debugs.push(m),
      silly: () => {},
      level: "debug",
    };
    return { log, warns, debugs };
  }

  it("should warn on first error of a category", () => {
    const { log, warns, debugs } = makeMockLog();
    const cat = logDedup(log, null, "Cloud", new Error("ECONNREFUSED something"));
    expect(cat).toBe("NETWORK");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("Cloud:");
    expect(debugs).toHaveLength(0);
  });

  it("should debug on repeated same category", () => {
    const { log, warns, debugs } = makeMockLog();
    const e1 = new Error("ECONNREFUSED first");
    const e2 = new Error("ECONNREFUSED second");
    const cat1 = logDedup(log, null, "Cloud", e1);
    const cat2 = logDedup(log, cat1, "Cloud", e2);
    expect(cat2).toBe("NETWORK");
    expect(warns).toHaveLength(1);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain("repeated");
  });

  it("should warn again on category change", () => {
    const { log, warns } = makeMockLog();
    const lastCat: ErrorCategory | null = logDedup(log, null, "Cloud", new Error("ECONNREFUSED"));
    logDedup(log, lastCat, "Cloud", new Error("status 401 unauthorized"));
    expect(warns).toHaveLength(2);
  });
});

describe("describeError — the text a warning shows (issue #51)", () => {
  const err = (code: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error(`${code} raw`), { code, ...extra });

  it("a name that does not resolve: the name and the DNS as probable cause", () => {
    expect(describeError(err("EAI_AGAIN", { hostname: "openapi.api.govee.com" }))).toBe(
      "openapi.api.govee.com could not be resolved — DNS problem on this host?",
    );
    expect(describeError(err("ENOTFOUND", { hostname: "app2.govee.com" }))).toBe(
      "app2.govee.com could not be resolved — DNS problem on this host?",
    );
  });

  it("a refused connection names the address", () => {
    expect(describeError(err("ECONNREFUSED", { address: "1.2.3.4" }))).toBe("1.2.3.4 refused the connection");
  });

  it("no route: the network as probable cause", () => {
    expect(describeError(err("EHOSTUNREACH", { address: "1.2.3.4" }))).toBe("no route to 1.2.3.4 — network down?");
    expect(describeError(err("ENETUNREACH"))).toBe("no route to the server — network down?");
  });

  it("a cut connection", () => {
    expect(describeError(err("ECONNRESET"))).toBe("the connection to the server was cut off");
  });

  it("every other error keeps its own message", () => {
    expect(describeError(new Error("Cloud control rejected: code=400 — Invalid parameter"))).toBe(
      "Cloud control rejected: code=400 — Invalid parameter",
    );
    expect(describeError(err("ETIMEDOUT"))).toBe("ETIMEDOUT raw");
  });

  it("says how often a command was tried — once is not worth a word", () => {
    expect(describeError(err("EAI_AGAIN", { hostname: "h", attempts: 3 }))).toBe(
      "h could not be resolved — DNS problem on this host? (tried 3 times)",
    );
    expect(describeError(err("EAI_AGAIN", { hostname: "h", attempts: 1 }))).toBe(
      "h could not be resolved — DNS problem on this host?",
    );
  });
});
