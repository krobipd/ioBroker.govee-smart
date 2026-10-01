import { Booking, currentBooking, isNeverSent, runBooked } from "./call-booking";

describe("isNeverSent — which failed requests provably never reached Govee (issue #51)", () => {
  const err = (code: unknown): Error => Object.assign(new Error(`failed ${String(code)}`), { code });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"])(
    "a %s before the socket connected never reached Govee",
    code => {
      expect(isNeverSent(err(code), false)).toBe(true);
    },
  );

  it.each(["ETIMEDOUT", "ECONNRESET", "EPROTO", "CERT_HAS_EXPIRED"])("a %s may have been received", code => {
    expect(isNeverSent(err(code), false)).toBe(false);
  });

  it("the same code AFTER the socket connected may have been received — the request could be on its way", () => {
    expect(isNeverSent(err("EHOSTUNREACH"), true)).toBe(false);
  });

  it("an error without a string code proves nothing", () => {
    expect(isNeverSent(new Error("getaddrinfo EAI_AGAIN host"), false)).toBe(false);
    expect(isNeverSent(err(4), false)).toBe(false);
    expect(isNeverSent(null, false)).toBe(false);
  });
});

describe("Booking — the verdict of one booked call", () => {
  it("is given back only when a request failed before reaching Govee and none reached it", () => {
    const b = new Booking();
    b.attempt(false);
    expect(b.seal()).toBe(true);
  });

  it("is kept when one request reached Govee — even after another one failed", () => {
    const b = new Booking();
    b.attempt(false);
    b.attempt(true);
    expect(b.seal()).toBe(false);
  });

  it("is kept when the call made no request at all", () => {
    expect(new Booking().seal()).toBe(false);
  });
});

describe("runBooked / currentBooking", () => {
  it("hands the booking to everything the call awaits, and to nothing outside it", async () => {
    const b = new Booking();
    expect(currentBooking()).toBeUndefined();
    const seen = await runBooked(b, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return currentBooking();
    });
    expect(seen).toBe(b);
    expect(currentBooking()).toBeUndefined();
  });
});
