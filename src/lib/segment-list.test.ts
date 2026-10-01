import { parseSegmentList } from "./segment-list";

describe("parseSegmentList", () => {
  it("should parse comma-separated indices", () => {
    const r = parseSegmentList("0,1,2,3", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([0, 1, 2, 3]);
  });

  it("should parse a range", () => {
    const r = parseSegmentList("0-9", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should parse mixed ranges and individuals", () => {
    const r = parseSegmentList("0-2,4-6,10", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([0, 1, 2, 4, 5, 6, 10]);
  });

  it("should tolerate whitespace", () => {
    const r = parseSegmentList("0, 3, 5 - 7, 10-12", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([0, 3, 5, 6, 7, 10, 11, 12]);
  });

  it("should dedupe entries", () => {
    const r = parseSegmentList("0,0,1,1,2", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([0, 1, 2]);
  });

  it("should sort ascending", () => {
    const r = parseSegmentList("5,3,1,4,2", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([1, 2, 3, 4, 5]);
  });

  it("should reject empty string", () => {
    const r = parseSegmentList("", 14);
    expect(r.error).not.toBeNull();
    expect(r.indices).toEqual([]);
  });

  it("should reject whitespace-only", () => {
    const r = parseSegmentList("   ", 14);
    expect(r.error).not.toBeNull();
  });

  it("should reject negative numbers", () => {
    const r = parseSegmentList("-1,0,1", 14);
    expect(r.error).not.toBeNull();
  });

  it("should reject indices above per-device max", () => {
    const r = parseSegmentList("0-15", 14);
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("15");
    expect(r.error).toContain("0-14");
  });

  it("clamps to the hard backstop SEGMENT_HARD_MAX (55): accepts 55, rejects 56 (I3)", () => {
    // A large maxIndex must not let indices past the protocol limit through.
    expect(parseSegmentList("55", 200).error).toBeNull(); // 55 == effectiveMax → accepted
    expect(parseSegmentList("56", 200).error).not.toBeNull(); // 56 > 55 → rejected
  });

  it("should reject non-numeric tokens", () => {
    const r = parseSegmentList("0,abc,2", 14);
    expect(r.error).not.toBeNull();
  });

  it("should reject reversed range", () => {
    const r = parseSegmentList("9-0", 14);
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("start");
  });

  it("should handle single index", () => {
    const r = parseSegmentList("5", 14);
    expect(r.error).toBeNull();
    expect(r.indices).toEqual([5]);
  });

  it("should handle non-string input safely", () => {
    const r = parseSegmentList(null as unknown as string, 14);
    expect(r.error).not.toBeNull();
    expect(r.indices).toEqual([]);
  });

  it("falls back to the hard backstop 55 when maxIndex is invalid (I3)", () => {
    expect(parseSegmentList("55", -1).error).toBeNull(); // effectiveMax = 55
    expect(parseSegmentList("56", -1).error).not.toBeNull(); // 56 > 55 → rejected
  });
});
