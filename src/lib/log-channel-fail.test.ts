import { HttpError } from "./http-client";
import { formatChannelFail, logChannelFail, type ChannelDedupState } from "./log-channel-fail";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
}

function makeLog(): { log: ioBroker.Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const log = {
    debug: (msg: string) => entries.push({ level: "debug", msg }),
    info: (msg: string) => entries.push({ level: "info", msg }),
    warn: (msg: string) => entries.push({ level: "warn", msg }),
    error: (msg: string) => entries.push({ level: "error", msg }),
    silly: () => {},
    level: "debug",
  } as ioBroker.Logger;
  return { log, entries };
}

describe("formatChannelFail (pure formatter)", () => {
  it("TIMEOUT: uses the enriched http-client message verbatim plus retryHint", () => {
    const err = Object.assign(
      new Error("Timeout after 15000ms for POST openapi.api.govee.com/router/api/v1/user/devices"),
      { code: "ETIMEDOUT" },
    );
    const out = formatChannelFail("Cloud REST", "TIMEOUT", err, "retrying every 5 min");
    expect(out).toBe(
      "Cloud REST: Timeout after 15000ms for POST openapi.api.govee.com/router/api/v1/user/devices — retrying every 5 min",
    );
  });

  it("NETWORK: surfaces the err.code in parentheses when available", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" });
    const out = formatChannelFail("Cloud REST", "NETWORK", err, "retrying every 5 min", "loading device list");
    expect(out).toBe("Cloud REST: network error (ENOTFOUND) (loading device list) — retrying every 5 min");
  });

  it("RATE_LIMIT: includes HTTP 429 + retry-after hint", () => {
    const err = new HttpError("Too Many Requests", 429, {}, "");
    const out = formatChannelFail("Cloud REST", "RATE_LIMIT", err, "retrying in 60 s");
    expect(out).toBe("Cloud REST: rate-limited by Govee (HTTP 429) — retrying in 60 s");
  });

  it("UNKNOWN: includes err.message + retryHint", () => {
    const err = new Error("Govee returned weird payload");
    const out = formatChannelFail("Cloud REST", "UNKNOWN", err, "retrying every 5 min", "loading device list");
    expect(out).toBe(
      "Cloud REST: request failed (loading device list) — Govee returned weird payload — retrying every 5 min",
    );
  });
});

describe("logChannelFail (dedup wrapper)", () => {
  it("first failure in a category goes to warn, stack goes to debug", () => {
    const { log, entries } = makeLog();
    const dedup: ChannelDedupState = { lastCategory: null };
    const err = Object.assign(new Error("Timeout after 15000ms for POST host/path"), { code: "ETIMEDOUT" });
    logChannelFail(log, { channel: "Cloud REST", err, retryHint: "retrying every 5 min", dedup });

    const warns = entries.filter(e => e.level === "warn");
    const debugs = entries.filter(e => e.level === "debug");
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain("Cloud REST: Timeout after 15000ms");
    // stack lives on debug
    expect(debugs).toHaveLength(1);
    expect(debugs[0].msg).toContain("Cloud REST fail detail:");
  });

  it("second failure in same category goes to debug only", () => {
    const { log, entries } = makeLog();
    const dedup: ChannelDedupState = { lastCategory: null };
    logChannelFail(log, {
      channel: "Cloud REST",
      err: Object.assign(new Error("Timeout x"), { code: "ETIMEDOUT" }),
      dedup,
    });
    logChannelFail(log, {
      channel: "Cloud REST",
      err: Object.assign(new Error("Timeout y"), { code: "ETIMEDOUT" }),
      dedup,
    });

    const warns = entries.filter(e => e.level === "warn");
    expect(warns).toHaveLength(1);
    // first call: 1 warn + 1 debug (stack). second: 1 debug (repeated). total: 2 debugs.
    const debugs = entries.filter(e => e.level === "debug");
    expect(debugs).toHaveLength(2);
    expect(debugs[1].msg).toContain("(repeated; raw:");
  });

  it("different category after first → warn again", () => {
    const { log, entries } = makeLog();
    const dedup: ChannelDedupState = { lastCategory: null };
    logChannelFail(log, {
      channel: "Cloud REST",
      err: Object.assign(new Error("Timeout x"), { code: "ETIMEDOUT" }),
      dedup,
    });
    // The channel's real second category: Govee's rate limit.
    const limited = new HttpError("Too Many Requests", 429, {}, "");
    logChannelFail(log, { channel: "Cloud REST", err: limited, dedup });

    const warns = entries.filter(e => e.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[1].msg).toContain("rate-limited by Govee (HTTP 429)");
  });
});
