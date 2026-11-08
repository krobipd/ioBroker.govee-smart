import { SlotLanes, isStamp } from "./call-window";

describe("SlotLanes — a call holds its slot until the window's length after it ended", () => {
  it("fits while fewer than max slots are held, and names the wait once full", () => {
    const lanes = new SlotLanes();
    expect(lanes.waitMs("a", 2, 10, 0)).toBe(0);
    lanes.take("a").end = 0;
    lanes.take("a").end = 4000;
    expect(lanes.waitMs("a", 2, 10, 5000)).toBe(5000); // the first slot frees at 10 000
    expect(lanes.waitMs("a", 3, 10, 5000)).toBe(0);
  });

  it("is half open: a slot is free again exactly the window's length after its end", () => {
    const lanes = new SlotLanes();
    lanes.take("a").end = 1000;
    expect(lanes.held("a", 10, 10_999)).toHaveLength(1);
    expect(lanes.held("a", 10, 11_000)).toHaveLength(0);
  });

  it("an open slot never frees — the wait is unknown while every slot that must free is open", () => {
    const lanes = new SlotLanes();
    const open = lanes.take("a");
    expect(lanes.held("a", 1, 1e12)).toEqual([open]);
    expect(lanes.waitMs("a", 1, 1, 1e12)).toBeUndefined();
    lanes.take("a").end = 0;
    // two held, max 2: the one settled slot must free and is enough
    expect(lanes.waitMs("a", 2, 1, 500)).toBe(500);
    // max 1: the open one would have to free as well
    expect(lanes.waitMs("a", 1, 1, 500)).toBeUndefined();
  });

  it("the n-th settled slot decides when several must free", () => {
    const lanes = new SlotLanes();
    for (const end of [3000, 1000, 2000]) {
      lanes.take("a").end = end;
    }
    expect(lanes.waitMs("a", 2, 10, 2500)).toBe(9500); // two must free: the ends 1000 and 2000
  });

  it("a slot given back no longer counts; giving back twice or a stranger's slot changes nothing", () => {
    const lanes = new SlotLanes();
    const slot = lanes.take("a");
    const kept = lanes.take("a");
    lanes.give("a", slot);
    lanes.give("a", slot);
    lanes.give("b", kept);
    expect(lanes.held("a", 10, 0)).toEqual([kept]);
    lanes.give("a", kept);
    expect(lanes.keys()).toEqual([]);
  });

  it("forgets what slid out, and lanes are independent", () => {
    const lanes = new SlotLanes();
    lanes.take("a").end = 0;
    lanes.take("b").end = 0;
    expect(lanes.held("a", 1, 1000)).toEqual([]);
    expect(lanes.keys()).toEqual(["b"]);
  });

  it("hands over the ends of its held slots — an open one as now — and lays them in again", () => {
    const lanes = new SlotLanes();
    lanes.take("a").end = 100;
    lanes.take("a");
    lanes.take("a").end = -86_400_000; // slid out
    expect(lanes.ends("a", 86_400, 500)).toEqual([100, 500]);
    const next = new SlotLanes();
    next.restore("a", [100, 500]);
    expect(next.held("a", 86_400, 600)).toHaveLength(2);
    expect(next.waitMs("a", 2, 86_400, 600)).toBe(86_400_000 - 500);
  });

  it("a stamp from the data folder is a finite number, nothing else", () => {
    expect(isStamp(1)).toBe(true);
    for (const v of ["1", null, undefined, Number.NaN, Infinity, {}]) {
      expect(isStamp(v)).toBe(false);
    }
  });
});
