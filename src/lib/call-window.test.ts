import { SlotLanes, isStamp, readLaneMemory } from "./call-window";

describe("SlotLanes — a call holds its slot until the window's length after it ended", () => {
  it("fits while fewer than max slots are held, and names the wait once full", () => {
    const lanes = new SlotLanes();
    expect(lanes.waitMs("a", 2, 10, 0)).toBe(0);
    lanes.take("a", 10).end = 0;
    lanes.take("a", 10).end = 4000;
    expect(lanes.waitMs("a", 2, 10, 5000)).toBe(5000); // the first slot frees at 10 000
    expect(lanes.waitMs("a", 3, 10, 5000)).toBe(0);
  });

  it("is half open: a slot is free again exactly the window's length after its end", () => {
    const lanes = new SlotLanes();
    lanes.take("a", 10).end = 1000;
    expect(lanes.held("a", 10, 10_999)).toHaveLength(1);
    expect(lanes.held("a", 10, 11_000)).toHaveLength(0);
  });

  it("an open slot never frees — the wait is unknown while every slot that must free is open", () => {
    const lanes = new SlotLanes();
    const open = lanes.take("a", 1);
    expect(lanes.held("a", 1, 1e12)).toEqual([open]);
    expect(lanes.waitMs("a", 1, 1, 1e12)).toBeUndefined();
    lanes.take("a", 1).end = 0;
    // two held, max 2: the one settled slot must free and is enough
    expect(lanes.waitMs("a", 2, 1, 500)).toBe(500);
    // max 1: the open one would have to free as well
    expect(lanes.waitMs("a", 1, 1, 500)).toBeUndefined();
  });

  it("the n-th settled slot decides when several must free", () => {
    const lanes = new SlotLanes();
    for (const end of [3000, 1000, 2000]) {
      lanes.take("a", 10).end = end;
    }
    expect(lanes.waitMs("a", 2, 10, 2500)).toBe(9500); // two must free: the ends 1000 and 2000
  });

  it("a slot given back no longer counts; giving back twice or a stranger's slot changes nothing", () => {
    const lanes = new SlotLanes();
    const slot = lanes.take("a", 10);
    const kept = lanes.take("a", 10);
    lanes.give("a", slot);
    lanes.give("a", slot);
    lanes.give("b", kept);
    expect(lanes.held("a", 10, 0)).toEqual([kept]);
    lanes.give("a", kept);
    expect(lanes.keys()).toEqual([]);
    expect(lanes.dump(0)).toEqual({});
  });

  it("forgets what slid out, and lanes are independent", () => {
    const lanes = new SlotLanes();
    lanes.take("a", 1).end = 0;
    lanes.take("b", 1).end = 0;
    expect(lanes.held("a", 1, 1000)).toEqual([]);
    expect(lanes.keys()).toEqual(["b"]);
  });
});

describe("SlotLanes — what a restart carries over", () => {
  it("hands over every held lane with its window and its ends — an open slot as now", () => {
    const lanes = new SlotLanes();
    lanes.take("day", 86_400).end = 100;
    lanes.take("day", 86_400);
    lanes.take("minute", 60).end = 450;
    lanes.take("minute", 60).end = -100_000; // slid out
    expect(lanes.dump(500)).toEqual({
      day: { seconds: 86_400, ends: [100, 500] },
      minute: { seconds: 60, ends: [450] },
    });
  });

  it("a lane that slid out entirely is not handed over", () => {
    const lanes = new SlotLanes();
    lanes.take("minute", 60).end = 0;
    expect(lanes.dump(60_000)).toEqual({});
  });

  it("lays in what lies inside each window — not what slid out, not what lies after now", () => {
    const next = new SlotLanes();
    next.load(
      {
        day: { seconds: 86_400, ends: [100, 500, 900] },
        minute: { seconds: 60, ends: [-60_000, -59_000] },
      },
      600,
    );
    expect(next.held("day", 86_400, 600)).toHaveLength(2);
    expect(next.waitMs("day", 2, 86_400, 600)).toBe(86_400_000 - 500);
    expect(next.held("minute", 60, 600)).toHaveLength(1);
    expect(next.dump(600)).toEqual({
      day: { seconds: 86_400, ends: [100, 500] },
      minute: { seconds: 60, ends: [-59_000] },
    });
  });

  it("reads a memory from the file only where it has the shape: a positive window and stamps", () => {
    expect(readLaneMemory(undefined)).toEqual({});
    expect(readLaneMemory(5)).toEqual({});
    expect(
      readLaneMemory({
        a: { seconds: 60, ends: [1, "2", null, 3] },
        b: { seconds: 0, ends: [1] },
        c: { seconds: "60", ends: [1] },
        d: { seconds: 60, ends: "x" },
        e: null,
      }),
    ).toEqual({ a: { seconds: 60, ends: [1, 3] } });
  });

  it("a stamp from the data folder is a finite number, nothing else", () => {
    expect(isStamp(1)).toBe(true);
    for (const v of ["1", null, undefined, Number.NaN, Infinity, {}]) {
      expect(isStamp(v)).toBe(false);
    }
  });
});
