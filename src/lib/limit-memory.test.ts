import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMIT_MEMORY_FILE, loadLimitMemory, saveLimitMemory } from "./limit-memory";

describe("limit-memory — every limiter's windows in the instance data folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "govee-limits-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips one memory per limiter, creating the folder, written through the fleet master", async () => {
    const memory = {
      limiter: { "x|0|account": { seconds: 86_400, ends: [1, 2] } },
      gate: { "y|0|account": { seconds: 60, ends: [3] } },
      lan: { "z|0|10.0.0.1": { seconds: 30, ends: [4] } },
      broker: {},
      events: { "w|0|account": { seconds: 15, ends: [5] } },
    };
    await saveLimitMemory(path.join(dir, "sub"), memory);
    expect(fs.readFileSync(path.join(dir, "sub", LIMIT_MEMORY_FILE), "utf8")).toBe(
      `${JSON.stringify(memory, null, 2)}\n`,
    );
    expect(loadLimitMemory(path.join(dir, "sub"))).toEqual(memory);
  });

  it("a write that throws rejects the promise instead of throwing — onUnload's allSettled sees it", async () => {
    // the data folder lies beneath a regular file: creating it fails
    fs.writeFileSync(path.join(dir, "plain"), "");
    const pending = saveLimitMemory(path.join(dir, "plain", "data"), { limiter: {} });
    await expect(pending).rejects.toThrow();
  });

  it("no file, a broken or unreadable file or a foreign shape is an empty memory — nothing was counted", () => {
    expect(loadLimitMemory(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, LIMIT_MEMORY_FILE), "{not json");
    expect(loadLimitMemory(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, LIMIT_MEMORY_FILE), "null");
    expect(loadLimitMemory(dir)).toEqual({ limiter: {}, gate: {}, lan: {}, broker: {}, events: {} });
    // compact JSON, as the file's first writer wrote it before the fleet master (never released)
    fs.writeFileSync(
      path.join(dir, LIMIT_MEMORY_FILE),
      JSON.stringify({ limiter: { a: { seconds: 60, ends: [1, "x"] } }, gate: 5, other: { b: {} } }),
    );
    expect(loadLimitMemory(dir)).toEqual({
      limiter: { a: { seconds: 60, ends: [1] } },
      gate: {},
      lan: {},
      broker: {},
      events: {},
    });
    // a folder where the file belongs cannot be read
    fs.rmSync(path.join(dir, LIMIT_MEMORY_FILE));
    fs.mkdirSync(path.join(dir, LIMIT_MEMORY_FILE));
    expect(loadLimitMemory(dir)).toEqual({});
  });
});
