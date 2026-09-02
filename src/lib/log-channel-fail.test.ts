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
    const err = new Error("Timeout after 15000ms for POST openapi.api.govee.com/router/api/v1/user/devices");
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

  it("AUTH: includes HTTP status when err is HttpError + no auto-retry hint", () => {
    const err = new HttpError("Unauthorized", 401, {}, "");
    const out = formatChannelFail("Cloud REST", "AUTH", err);
    expect(out).toBe("Cloud REST: authentication failed (HTTP 401) — check adapter config, no auto-retry");
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

  it("VERIFICATION_PENDING: directs user to Settings, no retry hint inserted", () => {
    const out = formatChannelFail("Cloud REST", "VERIFICATION_PENDING", new Error("status 454"));
    expect(out).toBe("Cloud REST: verification code required — open adapter Settings and request a code");
  });
});

describe("logChannelFail (dedup wrapper)", () => {
  it("first failure in a category goes to warn, stack goes to debug", () => {
    const { log, entries } = makeLog();
    const dedup: ChannelDedupState = { lastCategory: null };
    const err = new Error("Timeout after 15000ms for POST host/path");
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
    logChannelFail(log, { channel: "Cloud REST", err: new Error("Timeout x"), dedup });
    logChannelFail(log, { channel: "Cloud REST", err: new Error("Timeout y"), dedup });

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
    logChannelFail(log, { channel: "Cloud REST", err: new Error("Timeout x"), dedup });
    const authErr = new HttpError("Unauthorized", 401, {}, "");
    logChannelFail(log, { channel: "Cloud REST", err: authErr, dedup });

    const warns = entries.filter(e => e.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[1].msg).toContain("authentication failed (HTTP 401)");
  });
});
