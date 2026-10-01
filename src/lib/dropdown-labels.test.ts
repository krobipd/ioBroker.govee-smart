import { disambiguateLabels, buildUniqueLabelMap, resolveStatesValue } from "./dropdown-labels";

describe("disambiguateLabels", () => {
  it("should pass through unique names unchanged", () => {
    expect(disambiguateLabels(["Aurora", "Movie", "Sunset"])).toEqual(["Aurora", "Movie", "Sunset"]);
  });

  it("should suffix duplicates with (2), (3), …", () => {
    expect(disambiguateLabels(["Movie", "Aurora", "Movie", "Movie"])).toEqual([
      "Movie",
      "Aurora",
      "Movie (2)",
      "Movie (3)",
    ]);
  });

  it("should keep first occurrence of each name unchanged", () => {
    expect(disambiguateLabels(["A", "B", "A", "B", "A"])).toEqual(["A", "B", "A (2)", "B (2)", "A (3)"]);
  });

  it("should handle empty list", () => {
    expect(disambiguateLabels([])).toEqual([]);
  });

  it("does not collide with an input that already carries a (N) suffix (I4)", () => {
    // Old code produced two "Aurora (2)" entries here; the reverse-lookup then
    // maps two dropdown keys to the same label. Each output must be unique.
    const out = disambiguateLabels(["Aurora", "Aurora", "Aurora (2)"]);
    expect(out).toEqual(["Aurora", "Aurora (2)", "Aurora (2) (2)"]);
    expect(new Set(out).size).toBe(out.length); // all unique
  });

  it("should treat empty strings as duplicates after first", () => {
    expect(disambiguateLabels(["", "x", ""])).toEqual(["", "x", " (2)"]);
  });
});

describe("buildUniqueLabelMap", () => {
  it("should build a 0-based sentinel map for unique names", () => {
    const result = buildUniqueLabelMap([{ name: "Aurora" }, { name: "Movie" }, { name: "Sunset" }]);
    expect(result).toEqual({ 0: "---", 1: "Aurora", 2: "Movie", 3: "Sunset" });
  });

  it("should disambiguate duplicates in the map values", () => {
    const result = buildUniqueLabelMap([{ name: "Movie" }, { name: "Aurora" }, { name: "Movie" }]);
    expect(result).toEqual({ 0: "---", 1: "Movie", 2: "Aurora", 3: "Movie (2)" });
  });

  it("should accept a custom sentinel label", () => {
    const result = buildUniqueLabelMap([{ name: "X" }], "off");
    expect(result).toEqual({ 0: "off", 1: "X" });
  });

  it("should produce just the sentinel for empty input", () => {
    expect(buildUniqueLabelMap([])).toEqual({ 0: "---" });
  });

  it("should accept any T extends {name: string}", () => {
    const result = buildUniqueLabelMap([{ name: "Z", id: 42, extra: { foo: "bar" } }]);
    expect(result[1]).toBe("Z");
  });
});

describe("resolveStatesValue", () => {
  const sceneMap = { 0: "---", 1: "Aurora", 2: "Movie", 3: "Movie (2)" };
  const modeMap = { 0: "---", spectrum: "Spectrum", rolling: "Rolling Tides" };

  it("should resolve numeric input to its key", () => {
    const r = resolveStatesValue(1, sceneMap);
    expect(r).toEqual({ key: "1", canonical: "Aurora" });
  });

  it("should resolve numeric-string input to its key", () => {
    const r = resolveStatesValue("2", sceneMap);
    expect(r).toEqual({ key: "2", canonical: "Movie" });
  });

  it("should resolve label input case-insensitively", () => {
    const r = resolveStatesValue("aurora", sceneMap);
    expect(r).toEqual({ key: "1", canonical: "Aurora" });
  });

  it("should resolve label input with surrounding whitespace", () => {
    const r = resolveStatesValue("  AURORA  ", sceneMap);
    expect(r).toEqual({ key: "1", canonical: "Aurora" });
  });

  it("should match disambiguated label exactly", () => {
    const r = resolveStatesValue("Movie (2)", sceneMap);
    expect(r).toEqual({ key: "3", canonical: "Movie (2)" });
  });

  it("should match the first occurrence when label is the original (non-suffixed) form", () => {
    const r = resolveStatesValue("Movie", sceneMap);
    expect(r).toEqual({ key: "2", canonical: "Movie" });
  });

  it("should resolve string-keyed maps via direct key match", () => {
    const r = resolveStatesValue("spectrum", modeMap);
    expect(r).toEqual({ key: "spectrum", canonical: "Spectrum" });
  });

  it("should resolve string-keyed maps via label match", () => {
    const r = resolveStatesValue("rolling tides", modeMap);
    expect(r).toEqual({ key: "rolling", canonical: "Rolling Tides" });
  });

  it("does not resolve inherited prototype members (__proto__ / toString / constructor) (SEC-GC2)", () => {
    // Direct key lookup used to hit Object.prototype members, falsely returning
    // a non-null result (canonical = a function) for a non-existent state.
    for (const evil of ["__proto__", "toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(resolveStatesValue(evil, sceneMap)).toBeNull();
    }
  });

  it("should return null on unknown numeric index", () => {
    expect(resolveStatesValue(99, sceneMap)).toBeNull();
  });

  it("should return null on unknown label", () => {
    expect(resolveStatesValue("nonexistent", sceneMap)).toBeNull();
  });

  it("should return null on empty string", () => {
    expect(resolveStatesValue("", sceneMap)).toBeNull();
  });

  it("should return null on non-finite number", () => {
    expect(resolveStatesValue(NaN, sceneMap)).toBeNull();
    expect(resolveStatesValue(Infinity, sceneMap)).toBeNull();
  });

  it("should return null on non-string/non-number input", () => {
    expect(resolveStatesValue(null, sceneMap)).toBeNull();
    expect(resolveStatesValue(undefined, sceneMap)).toBeNull();
    expect(resolveStatesValue(true, sceneMap)).toBeNull();
    expect(resolveStatesValue({}, sceneMap)).toBeNull();
    expect(resolveStatesValue([], sceneMap)).toBeNull();
  });

  it("should resolve the sentinel '0' from numeric or string input", () => {
    expect(resolveStatesValue(0, sceneMap)).toEqual({ key: "0", canonical: "---" });
    expect(resolveStatesValue("0", sceneMap)).toEqual({ key: "0", canonical: "---" });
  });

  it("should ignore non-string label entries (drift safety)", () => {
    // Drifted map where one value isn't a string — should not crash, just skip
    const drifted = { 0: "---", 1: 42 as unknown as string };
    expect(resolveStatesValue("42", drifted)).toBeNull();
    expect(resolveStatesValue(1, drifted)).toEqual({ key: "1", canonical: 42 as unknown as string });
  });
});
