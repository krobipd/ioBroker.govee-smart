import { describe, expect, it, vi } from "vitest";
import { CallGate } from "./call-gate";
import type { Counterpart } from "./api-limits";
import type * as httpClient from "./http-client";
import { HttpError, httpsRequest } from "./http-client";

vi.mock("./http-client", async importOriginal => ({
  ...(await importOriginal<typeof httpClient>()),
  httpsRequest: vi.fn(),
}));

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

/** A gate whose delay moves the clock, recording every wait. */
function waitingGate(): { gate: CallGate; c: ReturnType<typeof clock>; waited: number[] } {
  const c = clock();
  const waited: number[] = [];
  const gate = new CallGate(ms => {
    waited.push(ms);
    c.advance(ms);
    return Promise.resolve();
  }, c.now);
  return { gate, c, waited };
}

/** Let the request chains settle. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe("CallGate — sent-and-done calls (a datagram, a publish): counted from their send", () => {
  it("lets max calls through per window and tells how long the next one waits", () => {
    const c = clock();
    const gate = new CallGate(() => Promise.resolve(), c.now);
    gate.tryAdmit(perAccount, "h")!();
    c.advance(1000);
    gate.tryAdmit(perAccount, "h")!();
    expect(gate.tryAdmit(perAccount, "h")).toBeUndefined();
    // the first call leaves the 10 s window 9 s from now
    expect(gate.waitMs(perAccount, "h")).toBe(9000);
    c.advance(8999);
    expect(gate.tryAdmit(perAccount, "h")).toBeUndefined();
    c.advance(1);
    expect(gate.tryAdmit(perAccount, "h")).toBeDefined();
  });

  it("the slot counts from the stamp the caller takes right after the send, not from the admission", () => {
    const c = clock();
    const gate = new CallGate(() => Promise.resolve(), c.now);
    const sent = gate.tryAdmit(perHost, "10.0.0.1")!;
    c.advance(5); // the transport call took a moment
    sent();
    c.advance(996);
    expect(gate.waitMs(perHost, "10.0.0.1")).toBe(4);
    c.advance(4);
    expect(gate.waitMs(perHost, "10.0.0.1")).toBe(0);
  });

  it("keeps a per-host limit for each host on its own", () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    gate.tryAdmit(perHost, "10.0.0.1")!();
    gate.tryAdmit(perHost, "10.0.0.2")!();
    expect(gate.tryAdmit(perHost, "10.0.0.1")).toBeUndefined();
  });

  it("leaves a daily window to the rate limiter — the gate does not keep a day of calls", () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    gate.tryAdmit(daily, "d")!();
    expect(gate.tryAdmit(daily, "d")).toBeDefined();
  });
});

describe("CallGate — requests: every counterpart they belong to, held until they have answered", () => {
  it("refuses an HTTPS request to a host api-limits.json does not declare, before anything goes out", async () => {
    const gate = new CallGate(() => Promise.resolve(), clock().now);
    await expect(gate.https()({ method: "GET", url: "https://example.com/x", headers: {} })).rejects.toThrow(
      /declares no limit for example\.com/,
    );
  });

  it("a request holds its slot until it answered, and the window counts from the answer", async () => {
    const { gate, c, waited } = waitingGate();
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    let answer!: () => void;
    request.mockImplementationOnce(
      () => new Promise(resolve => (answer = () => resolve({ value: null, statusCode: 200 }))),
    );
    request.mockResolvedValue({ value: null, statusCode: 200 });
    const lookup = (): Promise<unknown> =>
      gate.https()({ method: "GET", url: "https://itunes.apple.com/lookup?id=1", headers: {} });
    const first = lookup(); // the App Store lookup: 2 per 60 s
    await flush();
    c.advance(120_000); // two minutes open — its slot is still held
    await lookup();
    await lookup(); // the open first and the answered second fill the window
    expect(waited).toEqual([60_000]); // 60 s after the second's answer, not after the first's start
    answer();
    await first;
  });

  it("a request waiting only for open requests goes when one of them answers, plus its window", async () => {
    const { gate, waited } = waitingGate();
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    const answers: Array<() => void> = [];
    request.mockImplementation(
      () => new Promise(resolve => answers.push(() => resolve({ value: null, statusCode: 200 }))),
    );
    const lookup = (): Promise<unknown> =>
      gate.https()({ method: "GET", url: "https://itunes.apple.com/lookup", headers: {} });
    const a = lookup();
    const b = lookup();
    const third = lookup();
    await flush();
    expect(answers).toHaveLength(2);
    expect(waited).toEqual([]); // nothing to count down while both are open
    answers[0]();
    await a;
    await flush();
    expect(waited).toEqual([60_000]);
    expect(answers).toHaveLength(3);
    answers[1]();
    answers[2]();
    await b;
    await third;
  });

  it("an endpoint's device window: a seventh command to one light waits 3 s, another light goes at once", async () => {
    const { gate, waited } = waitingGate();
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    request.mockResolvedValue({ value: null, statusCode: 200 });
    const control = (device: string): Promise<unknown> =>
      gate.https()({
        method: "POST",
        url: "https://openapi.api.govee.com/router/api/v1/device/control",
        headers: {},
        body: { requestId: "ctrl-1", payload: { sku: "H6199", device, capability: { instance: "powerSwitch" } } },
      });
    for (let i = 0; i < 6; i++) {
      await control("AA:BB:CC:DD:EE:FF:00:01");
    }
    await control("AA:BB:CC:DD:EE:FF:00:02");
    expect(waited).toEqual([]);
    await control("AA:BB:CC:DD:EE:FF:00:01");
    expect(waited).toEqual([3000]);
  });

  it("the host's window and the endpoint's both count: an App API library call fills the libraries lane only", async () => {
    const { gate, waited } = waitingGate();
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    request.mockResolvedValue({ value: null, statusCode: 200 });
    const get = (pathAndQuery: string): Promise<unknown> =>
      gate.https()({ method: "GET", url: `https://app2.govee.com${pathAndQuery}`, headers: {} });
    for (let i = 0; i < 8; i++) {
      await get(`/appsku/v1/light-effect-libraries?sku=H60${i}`);
    }
    await get("/device/rest/devices/v1/list"); // the sensor poll: only the host's 60 per minute
    expect(waited).toEqual([]);
    await get("/appsku/v1/sku-supported-feature?sku=H6199"); // the ninth library call in 60 s
    expect(waited).toEqual([60_000]);
  });

  it("a restart within a window: a gate that remembers holds the calls the previous process made", async () => {
    const before = waitingGate();
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    request.mockResolvedValue({ value: null, statusCode: 200 });
    const lookup = (gate: CallGate): Promise<unknown> =>
      gate.https()({ method: "GET", url: "https://itunes.apple.com/lookup", headers: {} });
    await lookup(before.gate);
    await lookup(before.gate); // the App Store lookup: 2 per 60 s
    const memory = before.gate.memory();
    expect(memory["Apple App Store lookup|0|account"]).toEqual({ seconds: 60, ends: [1_000_000, 1_000_000] });
    const after = waitingGate();
    after.c.advance(10_000); // the new process is up ten seconds later
    after.gate.remember(memory);
    await lookup(after.gate);
    expect(after.waited).toEqual([50_000]);
  });

  it("after a 429 lets no call reach that host before its Retry-After ran out — answered 429 here", async () => {
    // fleet suite D21 (CI 39408072351): the device list waited Govee's 60 s, but the reachability refresh and the app
    // read called the same hosts 5 s after the 429
    const c = clock();
    const gate = new CallGate(() => Promise.resolve(), c.now);
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    request.mockRejectedValueOnce(new HttpError("HTTP 429", 429, { "retry-after": "60" }));
    request.mockResolvedValue({ ok: true } as never);
    const call = (host: string): Promise<unknown> =>
      gate.https()({ method: "GET", url: `https://${host}/x`, headers: {} });

    await expect(call("openapi.api.govee.com")).rejects.toMatchObject({ statusCode: 429 });
    c.advance(5_000);
    await expect(call("openapi.api.govee.com")).rejects.toMatchObject({
      statusCode: 429,
      headers: { "retry-after": "55" },
    });
    await expect(call("app2.govee.com")).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);

    c.advance(55_000);
    await expect(call("openapi.api.govee.com")).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("holds the host for the seconds its Retry-After names — the fleet's counterpart names 97", async () => {
    const c = clock();
    const gate = new CallGate(() => Promise.resolve(), c.now);
    const request = vi.mocked(httpsRequest);
    request.mockReset();
    request.mockRejectedValueOnce(new HttpError("HTTP 429", 429, { "retry-after": "97" }));
    request.mockResolvedValue({ ok: true } as never);
    const call = (): Promise<unknown> =>
      gate.https()({ method: "GET", url: "https://openapi.api.govee.com/x", headers: {} });

    await expect(call()).rejects.toMatchObject({ statusCode: 429 });
    c.advance(96_999);
    await expect(call()).rejects.toMatchObject({ statusCode: 429, headers: { "retry-after": "1" } });
    expect(request).toHaveBeenCalledTimes(1);

    c.advance(1);
    await expect(call()).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
