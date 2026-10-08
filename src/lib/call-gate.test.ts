import { describe, expect, it } from "vitest";
import { CallGate } from "./call-gate";
import type { Counterpart } from "./api-limits";

const perAccount: Counterpart = {
  name: "test account",
  match: { host: "h" },
  limits: [{ max: 2, seconds: 10, per: "account", source: "test cap" }],
};
const perHost: Counterpart = {
  name: "test host",
  match: { kind: "udp" },
  limits: [{ max: 1, seconds: 1, per: "host", source: "test cap" }],
};
const daily: Counterpart = {
  name: "test daily",
  match: { host: "d" },
  limits: [{ max: 1, seconds: 86_400, per: "account", source: "test cap" }],
};

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: ms => (t += ms) };
}

describe("CallGate — the short windows of api-limits.json", () => {
  it("lets max calls through per window and tells how long the next one waits", () => {
    const c = clock();
    const gate = new CallGate(() => Promise.resolve(), c.now);
    expect(gate.tryAdmit(perAccount, "h")).toBe(true);
    c.advance(1000);
    expect(gate.tryAdmit(perAccount, "h")).toBe(true);
    expect(gate.tryAdmit(perAccount, "h")).toBe(false);
    // the first call leaves the 10 s window 9 s from now
    expect(gate.waitMs(perAccount, "h")).toBe(9001);
    c.advance(9001);
    expect(gate.tryAdmit(perAccount, "h")).toBe(true);
  });

  it("keeps a per-host limit for each host on its own", () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    expect(gate.tryAdmit(perHost, "10.0.0.1")).toBe(true);
    expect(gate.tryAdmit(perHost, "10.0.0.2")).toBe(true);
    expect(gate.tryAdmit(perHost, "10.0.0.1")).toBe(false);
  });

  it("admit waits through the adapter's delay until the call fits", async () => {
    const c = clock();
    const waited: number[] = [];
    const gate = new CallGate(ms => {
      waited.push(ms);
      c.advance(ms);
      return Promise.resolve();
    }, c.now);
    await gate.admit(perAccount, "h");
    await gate.admit(perAccount, "h");
    await gate.admit(perAccount, "h");
    expect(waited).toEqual([10_001]);
  });

  it("leaves a daily window to the rate limiter — the gate does not keep a day of calls", () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    expect(gate.tryAdmit(daily, "d")).toBe(true);
    expect(gate.tryAdmit(daily, "d")).toBe(true);
  });

  it("refuses an HTTPS request to a host api-limits.json does not declare, before anything goes out", async () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    await expect(gate.https()({ method: "GET", url: "https://example.com/x", headers: {} })).rejects.toThrow(
      /declares no limit for example\.com/,
    );
  });
});
