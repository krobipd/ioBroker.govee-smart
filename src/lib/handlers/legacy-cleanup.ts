// One-shot cleanups: what earlier versions left in the object tree that nothing reads any more. Each runs on every
// start and does nothing where the leftover is gone — nothing removes what the adapter no longer knows about except
// the adapter.

/** The adapter surface the cleanups need. */
export interface LegacyCleanupAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  delObjectAsync(id: string): Promise<unknown>;
  readDirAsync(meta: string, path: string): Promise<Array<{ file: string; isDir: boolean }>>;
  delFileAsync(meta: string, name: string): Promise<unknown>;
}

/**
 * Objects below `info` an earlier version created and no version reads any more — dropped on upgraded installs.
 */
export const ORPHANED_INFO_OBJECTS: readonly string[] = [
  // The global refresh button, removed in 2.7.0 — replaced by info.manualSyncDevices (BUG-1).
  "info.refresh_cloud_data",
  // The manual-sync button's spelling of 2.17.0–2.27.1, never subscribed, so no script depends on it.
  "info.manual_sync_devices",
  // A migration marker of an early 2.x release; found in the live tree on 2026-09-03, not by any gate.
  "info.legacyMqttCleaned",
  // Removed in 2.18.0 — the Govee-app version heals itself in the background.
  "info.appVersionDrift",
  // Removed in 2.21.0 — the segment wizard is a React card that owns its status.
  "info.wizardStatus",
];

/**
 * Drop every orphan of an earlier version: the dead `info` objects and the report store of 2.29.0–2.36.0.
 *
 * @param adapter Adapter surface
 */
export async function removeLegacyObjects(adapter: LegacyCleanupAdapter): Promise<void> {
  for (const id of ORPHANED_INFO_OBJECTS) {
    await adapter.delObjectAsync(id).catch(() => undefined);
  }
  // 2.29.0–2.36.0 kept a copy of every diagnostics report as a file under a `diagnostics` meta object at the root
  // of the instance; since 2.37.0 the report travels only in the answer to the Expert card.
  await removeLegacyReportStore(adapter);
}

/**
 * Delete the `<namespace>.diagnostics` meta object and every report file it
 * holds (2.29.0–2.36.0 stored up to three reports per device there). The
 * object is an `instanceObjects` entry of those versions, so js-controller
 * recreated it on every update — only the adapter can take it away. Without
 * the object it does nothing.
 *
 * @param adapter Adapter surface
 */
async function removeLegacyReportStore(adapter: LegacyCleanupAdapter): Promise<void> {
  const meta = `${adapter.namespace}.diagnostics`;
  const store = await adapter.getObjectAsync("diagnostics").catch(() => null);
  if (!store) {
    return;
  }
  // readDirAsync throws while the meta object holds nothing — treat it as empty.
  const entries = await adapter.readDirAsync(meta, "").catch(() => []);
  for (const entry of entries) {
    if (!entry.isDir) {
      await adapter.delFileAsync(meta, entry.file).catch(() => undefined);
    }
  }
  await adapter.delObjectAsync("diagnostics").catch(() => undefined);
  const removed = entries.filter(e => !e.isDir).length;
  // An automatic correction is carried out silently (CLAUDE_CODING "Logging-Philosophie").
  adapter.log.debug(`Removed ${removed} stored diagnostics report(s) and their folder — reports are download-only now`);
}
