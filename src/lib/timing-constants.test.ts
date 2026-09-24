import { MAX_TIMER_MS, clampTimerMs, tokenTtlSeconds } from "./timing-constants";

describe("clampTimerMs", () => {
  it("keeps a delay a timer accepts, and bounds the rest", () => {
    expect(clampTimerMs(30_000, 1)).toBe(30_000);
    // js-controller's setTimeout throws above 2^31−1 ms instead of clamping.
    expect(clampTimerMs(1e13, 1)).toBe(MAX_TIMER_MS);
    expect(clampTimerMs(1e13, 1, 60_000)).toBe(60_000);
    expect(clampTimerMs(-5, 1)).toBe(0);
    expect(clampTimerMs(NaN, 1234)).toBe(1234);
    expect(clampTimerMs(Infinity, 1234)).toBe(1234);
  });
});

describe("tokenTtlSeconds", () => {
  it("takes Govee's lifetime inside [10 min, 7 days] and defaults what is not a number", () => {
    expect(tokenTtlSeconds(57_600)).toBe(57_600); // the lifetime measured 2026-09
    expect(tokenTtlSeconds("57600")).toBe(57_600);
    expect(tokenTtlSeconds(30)).toBe(600);
    expect(tokenTtlSeconds(1e10)).toBe(7 * 24 * 60 * 60);
    for (const unusable of [undefined, null, "soon", -5, 0, NaN, {}]) {
      expect(tokenTtlSeconds(unusable)).toBe(3600);
    }
  });
});
