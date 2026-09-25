import { CloudOutage, cloudReachable } from "./cloud-outage";

describe("CloudOutage — two failures a minute apart, no answer between (issue #51)", () => {
  it("the first failure only notes itself", () => {
    const o = new CloudOutage();
    expect(o.noteUnreachable(1_000, "HTTP 503")).toBe(false);
    expect(o.confirmed).toBe(false);
    expect(o.since).toBe(1_000);
    expect(o.reason).toBe("HTTP 503");
  });

  it("a second failure less than a minute later confirms nothing", () => {
    const o = new CloudOutage();
    o.noteUnreachable(1_000, "HTTP 503");
    expect(o.noteUnreachable(60_999, "HTTP 503")).toBe(false);
    expect(o.confirmed).toBe(false);
  });

  it("a second failure a minute later confirms — exactly once", () => {
    const o = new CloudOutage();
    o.noteUnreachable(1_000, "first");
    expect(o.noteUnreachable(61_000, "second")).toBe(true);
    expect(o.noteUnreachable(121_000, "third")).toBe(false);
    expect(o.confirmed).toBe(true);
    expect(o.reason).toBe("first");
  });

  it("an accepted answer ends it and says whether an outage was confirmed", () => {
    const o = new CloudOutage();
    o.noteUnreachable(1_000, "x");
    expect(o.noteAnswer()).toBe(false);
    expect(o.since).toBeNull();
    o.noteUnreachable(2_000, "x");
    o.noteUnreachable(62_000, "x");
    expect(o.noteAnswer()).toBe(true);
    expect(o.confirmed).toBe(false);
    expect(o.reason).toBe("");
  });

  it("the shown reachability needs the key accepted AND no confirmed outage", () => {
    expect(cloudReachable({ cloudWasConnected: true, cloudOutage: { confirmed: false } })).toBe(true);
    expect(cloudReachable({ cloudWasConnected: true, cloudOutage: { confirmed: true } })).toBe(false);
    expect(cloudReachable({ cloudWasConnected: false, cloudOutage: { confirmed: false } })).toBe(false);
  });
});
