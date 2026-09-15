import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage } from "./types";
import { treeKey } from "./device-key";

/** Per-segment state in a local snapshot */
export interface SnapshotSegment {
  /** Color as "#RRGGBB" */
  color: string;
  /** Brightness 0-100 */
  brightness: number;
}

/** A single locally saved device state snapshot */
export interface LocalSnapshot {
  /** User-given name */
  name: string;
  /** Power state */
  power: boolean;
  /** Brightness 0-100 */
  brightness: number;
  /** Color as "#RRGGBB" */
  colorRgb: string;
  /** Color temperature in Kelvin (0 = RGB mode) */
  colorTemperature: number;
  /** Per-segment color+brightness (index = segment number) */
  segments?: SnapshotSegment[];
  /** Timestamp when saved */
  savedAt: number;
}

/** Per-device snapshot payload — the shape of `native.localSnapshots` (and of the files it replaced) */
interface SnapshotFile {
  snapshots: LocalSnapshot[];
}

/**
 * Minimal adapter surface used by the snapshot store. Lets unit tests inject
 * a fake without pulling the full ioBroker.Adapter type.
 */
export interface LocalSnapshotStoreAdapter {
  /** Adapter namespace, e.g. `govee-smart.0` */
  readonly namespace: string;
  /** Lists the device objects below `<namespace>.devices.` at `init()`. */
  getObjectViewAsync(
    design: "system",
    search: "device",
    params: { startkey: string; endkey: string },
  ): Promise<{ rows: Array<{ id: string; value: { native?: Record<string, unknown> } | null }> } | null | undefined>;
  /** One device object — checked before a write so no values land on a device that is gone. */
  getObjectAsync(id: string): Promise<{ type?: string } | null | undefined>;
  /** Deep-merges into an object; the store only ever sends `native.localSnapshots`. */
  extendObject(id: string, obj: { native: Record<string, unknown> }): Promise<unknown>;
  /** The root file store of 2.11.0–2.36.0 — read once at `init()` to carry its files into the devices. */
  readDirAsync(meta: string, path: string): Promise<{ file: string; isDir: boolean }[]>;
  /** Reads one file of that root store. */
  readFileAsync(meta: string, name: string): Promise<{ file: Buffer | string; mimeType?: string }>;
  /** Removes a carried-over file. */
  delFileAsync(meta: string, name: string): Promise<void>;
  /** Removes the root store's meta object once it is empty. */
  delObjectAsync(id: string): Promise<unknown>;
}

/** Sorts after every id that shares the prefix (see `state-manager.ts`). */
const SORT_KEY_END = "香";

/** The root meta object of 2.11.0–2.36.0, relative to the namespace. */
const LEGACY_ROOT_STORE = "snapshots";

/**
 * Local snapshot storage — saves/restores device states without Cloud.
 *
 * The values of a device's local snapshots live on the device object itself:
 * `devices.<key>` carries `native.localSnapshots`, the JSON text of
 * `{ snapshots: [...] }`. That object is written only with `extendObject`
 * (deep merge, a foreign `native` key survives), it is deleted only together
 * with the device, and it is part of `iob backup` like every object. The
 * `snapshots` channel below it would not do: `cleanupCloudOwnedStates` empties
 * it whenever its datapoints stop being expected — a device that is only
 * reachable over LAN after the API key was removed would lose its values there.
 *
 * Why JSON text and not the array: `extendObject` merges arrays element by
 * element, so a shorter list after a delete would keep the old tail. A string
 * replaces itself as a whole. An empty list is written as `""`.
 *
 * Until 2.36.0 the values sat as `<key>.json` files under a `snapshots` meta
 * object at the root of the instance (and until 2.10 in the instance data
 * directory) — a folder next to the devices that belongs to no device.
 * `init()` carries whatever it finds there into the device objects once and
 * removes the folder.
 *
 * `getSnapshots()` reads from an in-memory cache populated at `init()` — sync
 * access for consumers like the diagnostics provider that can't be made async.
 */
export class LocalSnapshotStore {
  private readonly adapter: LocalSnapshotStoreAdapter;
  private readonly log: ioBroker.Logger;
  /** key = `<sku>_<shortId>`, value = snapshots for that device */
  private readonly cache = new Map<string, LocalSnapshot[]>();
  /** False until init() succeeds — guards save/load while the objects are unreachable */
  private dataAvailable = false;

  /**
   * @param adapter ioBroker adapter (object view + extendObject; file methods only for the carry-over)
   * @param log ioBroker logger
   */
  constructor(adapter: LocalSnapshotStoreAdapter, log: ioBroker.Logger) {
    this.adapter = adapter;
    this.log = log;
  }

  /**
   * Carry over the stores of earlier versions, then load every device's
   * `native.localSnapshots` into the in-memory cache. Must be awaited before
   * any `getSnapshots()` call. Idempotent — safe to call multiple times.
   *
   * @param legacyDataDir Instance data directory — holds `snapshots/*.json` on installs that saved before 2.11.0
   */
  async init(legacyDataDir?: string): Promise<void> {
    this.cache.clear();
    await this.carryOverRootStore();
    if (legacyDataDir) {
      await this.carryOverDataDir(legacyDataDir);
    }
    const prefix = `${this.adapter.namespace}.devices.`;
    let view;
    try {
      view = await this.adapter.getObjectViewAsync("system", "device", {
        startkey: prefix,
        endkey: `${prefix}${SORT_KEY_END}`,
      });
    } catch (e) {
      // Without the objects the cache would be empty and the next save would
      // write that emptiness over the device's real list — refuse instead.
      this.log.warn(`Local snapshots unavailable — device objects unreadable: ${errMessage(e)}`);
      return;
    }
    for (const row of view?.rows ?? []) {
      const key = row.id.slice(prefix.length);
      const snapshots = parseSnapshots(row.value?.native?.localSnapshots);
      if (snapshots === null) {
        this.log.debug(`Local snapshots of ${key} unreadable — ignored`);
        continue;
      }
      if (snapshots.length > 0) {
        this.cache.set(key, snapshots);
      }
    }
    this.dataAvailable = true;
  }

  /**
   * Get all snapshots for a device. Sync — reads from the in-memory cache
   * populated by `init()`.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  getSnapshots(sku: string, deviceId: string): LocalSnapshot[] {
    if (!this.dataAvailable) {
      return [];
    }
    return this.cache.get(this.deviceKey(sku, deviceId)) ?? [];
  }

  /**
   * Save a new snapshot (or overwrite existing with same name). Updates the
   * in-memory cache synchronously, then persists to the device object.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param snapshot Snapshot data to save
   */
  async saveSnapshot(sku: string, deviceId: string, snapshot: LocalSnapshot): Promise<void> {
    if (!this.dataAvailable) {
      this.log.warn(`Cannot save snapshot "${snapshot.name}" — snapshot storage not initialised`);
      return;
    }
    const key = this.deviceKey(sku, deviceId);
    const snapshots = this.cache.get(key) ?? [];
    const existing = snapshots.findIndex(s => s.name === snapshot.name);
    if (existing >= 0) {
      snapshots[existing] = snapshot;
    } else {
      snapshots.push(snapshot);
    }
    this.cache.set(key, snapshots);
    await this.persist(key, snapshots);
    this.log.debug(`Local snapshot saved: "${snapshot.name}" for ${sku}`);
  }

  /**
   * Delete a snapshot by name. Updates the in-memory cache synchronously,
   * then persists to the device object.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param name Snapshot name to delete
   */
  async deleteSnapshot(sku: string, deviceId: string, name: string): Promise<boolean> {
    if (!this.dataAvailable) {
      return false;
    }
    const key = this.deviceKey(sku, deviceId);
    const snapshots = this.cache.get(key) ?? [];
    const idx = snapshots.findIndex(s => s.name === name);
    if (idx < 0) {
      return false;
    }
    snapshots.splice(idx, 1);
    if (snapshots.length === 0) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, snapshots);
    }
    await this.persist(key, snapshots);
    this.log.debug(`Local snapshot deleted: "${name}" for ${sku}`);
    return true;
  }

  /**
   * Write a device's snapshot list into its device object.
   *
   * @param key device key
   * @param snapshots Snapshot array to persist
   */
  private async persist(key: string, snapshots: LocalSnapshot[]): Promise<void> {
    try {
      if (!(await this.writeToDevice(key, snapshots))) {
        this.log.warn(`Snapshot write failed for ${key}: device object devices.${key} does not exist`);
      }
    } catch (e) {
      this.log.warn(`Snapshot write failed for ${key}: ${errMessage(e)}`);
    }
  }

  /**
   * `extendObject` with nothing but `native.localSnapshots` — the device name
   * and every other field stay untouched. Answers false when the device
   * object is not there (the device left the account): values are not written
   * onto a bare object that nothing would ever delete.
   *
   * @param key device key (`devices.<key>` is the object)
   * @param snapshots Snapshot list; empty clears the field
   */
  private async writeToDevice(key: string, snapshots: LocalSnapshot[]): Promise<boolean> {
    const id = `devices.${key}`;
    const device = await this.adapter.getObjectAsync(id);
    if (!device || device.type !== "device") {
      return false;
    }
    const data: SnapshotFile = { snapshots };
    const localSnapshots = snapshots.length === 0 ? "" : JSON.stringify(data);
    await this.adapter.extendObject(id, { native: { localSnapshots } });
    return true;
  }

  /**
   * 2.11.0–2.36.0 kept `<key>.json` per device in the `snapshots` meta object
   * at the root of the instance. Carry every file into its device object,
   * then remove the folder — the meta object was an `instanceObjects` entry,
   * so js-controller recreated it on every update and only the adapter can
   * take it away. Runs once; without the object it does nothing.
   */
  private async carryOverRootStore(): Promise<void> {
    const root = await this.adapter.getObjectAsync(LEGACY_ROOT_STORE).catch(() => null);
    if (!root) {
      return;
    }
    const meta = `${this.adapter.namespace}.${LEGACY_ROOT_STORE}`;
    // readDirAsync throws while the meta object holds nothing — treat it as empty.
    const entries = await this.adapter.readDirAsync(meta, "").catch(() => []);
    let moved = 0;
    let dropped = 0;
    for (const entry of entries) {
      if (entry.isDir) {
        continue;
      }
      if (entry.file.endsWith(".json")) {
        const key = entry.file.slice(0, -".json".length);
        let snapshots: LocalSnapshot[] | null = null;
        try {
          const { file } = await this.adapter.readFileAsync(meta, entry.file);
          snapshots = parseSnapshots(typeof file === "string" ? file : file.toString("utf-8"));
        } catch (e) {
          this.log.debug(`Snapshot read failed for ${entry.file}: ${errMessage(e)}`);
        }
        if (await this.carryOver(key, snapshots, entry.file)) {
          moved++;
        } else {
          dropped++;
        }
      }
      await this.adapter.delFileAsync(meta, entry.file).catch(e => {
        this.log.debug(`Could not remove ${entry.file} from the old snapshot store: ${errMessage(e)}`);
      });
    }
    await this.adapter.delObjectAsync(LEGACY_ROOT_STORE).catch(e => {
      this.log.debug(`Could not remove the old snapshot store: ${errMessage(e)}`);
    });
    if (moved > 0 || dropped > 0) {
      this.log.info(`Local snapshots moved into their device objects: ${moved} device(s), ${dropped} file(s) dropped`);
    }
  }

  /**
   * Before 2.11.0 the files sat in `<dataDir>/snapshots/` — outside every
   * backup. Same carry-over as the root store; the directory goes when it is
   * empty. A file that cannot be moved stays for the next start.
   *
   * @param dataDir Instance data directory
   */
  private async carryOverDataDir(dataDir: string): Promise<void> {
    const oldDir = path.join(dataDir, "snapshots");
    if (!fs.existsSync(oldDir)) {
      return;
    }
    let files: string[];
    try {
      files = fs.readdirSync(oldDir).filter(f => f.endsWith(".json"));
    } catch (e) {
      this.log.warn(`Snapshot carry-over: cannot read ${oldDir}: ${errMessage(e)}`);
      return;
    }
    let moved = 0;
    for (const file of files) {
      const key = file.slice(0, -".json".length);
      let snapshots: LocalSnapshot[] | null = null;
      try {
        snapshots = parseSnapshots(fs.readFileSync(path.join(oldDir, file), "utf-8"));
      } catch (e) {
        this.log.debug(`Snapshot read failed for ${file}: ${errMessage(e)}`);
      }
      try {
        if (await this.carryOver(key, snapshots, file)) {
          moved++;
        }
        fs.unlinkSync(path.join(oldDir, file));
      } catch (e) {
        this.log.warn(`Snapshot carry-over of ${file} failed: ${errMessage(e)}`);
      }
    }
    try {
      fs.rmdirSync(oldDir);
    } catch {
      /* dir still has files we failed to move — leave for retry on next start */
    }
    if (files.length > 0) {
      this.log.info(`Local snapshots moved from ${oldDir} into their device objects: ${moved}/${files.length} file(s)`);
    }
  }

  /**
   * Put one carried-over list onto its device. Says in the log why a file is
   * dropped instead: unreadable, or its device is no longer in the account.
   *
   * @param key device key
   * @param snapshots Parsed list, or null when the file was unreadable
   * @param file File name for the log line
   */
  private async carryOver(key: string, snapshots: LocalSnapshot[] | null, file: string): Promise<boolean> {
    if (snapshots === null) {
      this.log.warn(`Local snapshot file ${file} is unreadable and was dropped`);
      return false;
    }
    if (snapshots.length === 0) {
      return false;
    }
    if (await this.writeToDevice(key, snapshots)) {
      return true;
    }
    this.log.info(`Local snapshot file ${file} belongs to a device that is no longer in the account — dropped`);
    return false;
  }

  /**
   * Build device key for cache + object id.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private deviceKey(sku: string, deviceId: string): string {
    return treeKey(sku, deviceId);
  }
}

/**
 * API boundary for the stored text: anything but `{ snapshots: [...] }` in
 * valid JSON answers null; an empty field answers the empty list.
 *
 * @param raw The stored value — text on a healthy object, anything on a damaged one
 */
function parseSnapshots(raw: unknown): LocalSnapshot[] | null {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<SnapshotFile> | null;
    return Array.isArray(data?.snapshots) ? data.snapshots : null;
  } catch {
    return null;
  }
}
