import { vi } from "vitest";
import { mockLog } from "../../../test/test-helpers";
import { ORPHANED_INFO_OBJECTS, removeLegacyObjects, type LegacyCleanupAdapter } from "./legacy-cleanup";

function makeAdapter(opts: { store?: boolean; files?: Array<{ file: string; isDir: boolean }> } = {}): {
  adapter: LegacyCleanupAdapter;
  deletedObjects: string[];
  deletedFiles: string[];
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const deletedObjects: string[] = [];
  const deletedFiles: string[] = [];
  const info = vi.fn();
  const debug = vi.fn();
  const adapter: LegacyCleanupAdapter = {
    log: { ...mockLog, info, debug },
    namespace: "govee-smart.0",
    getObjectAsync: (id: string) =>
      Promise.resolve(id === "diagnostics" && opts.store ? ({ type: "meta" } as ioBroker.Object) : null),
    delObjectAsync: (id: string) => {
      deletedObjects.push(id);
      return Promise.resolve();
    },
    readDirAsync: () => Promise.resolve(opts.files ?? []),
    delFileAsync: (_meta: string, name: string) => {
      deletedFiles.push(name);
      return Promise.resolve();
    },
  };
  return { adapter, deletedObjects, deletedFiles, info, debug };
}

describe("removeLegacyObjects", () => {
  it("drops every orphaned info object of an earlier version", async () => {
    const { adapter, deletedObjects } = makeAdapter();
    await removeLegacyObjects(adapter);
    expect(deletedObjects).toEqual([...ORPHANED_INFO_OBJECTS]);
    expect(ORPHANED_INFO_OBJECTS).toEqual([
      "info.refresh_cloud_data",
      "info.manual_sync_devices",
      "info.legacyMqttCleaned",
      "info.appVersionDrift",
      "info.wizardStatus",
    ]);
  });

  it("a failed delete of one orphan does not stop the others", async () => {
    const { adapter, deletedObjects } = makeAdapter();
    const del = adapter.delObjectAsync;
    adapter.delObjectAsync = (id: string) =>
      id === "info.manual_sync_devices" ? Promise.reject(new Error("gone")) : del(id);
    await removeLegacyObjects(adapter);
    expect(deletedObjects).toContain("info.wizardStatus");
  });

  it("removes the report files of 2.29.0–2.36.0 and their folder, silently — the count on debug", async () => {
    const { adapter, deletedObjects, deletedFiles, info, debug } = makeAdapter({
      store: true,
      files: [
        { file: "a.json", isDir: false },
        { file: "sub", isDir: true },
        { file: "b.json", isDir: false },
      ],
    });
    await removeLegacyObjects(adapter);
    expect(deletedFiles).toEqual(["a.json", "b.json"]);
    expect(deletedObjects).toContain("diagnostics");
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Removed 2 stored diagnostics report(s)"));
    expect(info, "an automatic correction is carried out silently").not.toHaveBeenCalled();
  });

  it("a fresh install has no report store — nothing is touched and nothing is logged", async () => {
    const { adapter, deletedObjects, info } = makeAdapter();
    await removeLegacyObjects(adapter);
    expect(deletedObjects).not.toContain("diagnostics");
    expect(info).not.toHaveBeenCalled();
  });
});
