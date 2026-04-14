import * as fs from "node:fs";
import * as path from "node:path";

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

/** Per-device snapshot file format */
interface SnapshotFile {
  snapshots: LocalSnapshot[];
}

/**
 * Local snapshot storage — saves/restores device states without Cloud.
 * Each device gets its own JSON file in the snapshots/ directory.
 */
export class LocalSnapshotStore {
  private readonly dir: string;
  private readonly log: ioBroker.Logger;

  /**
   * @param dataDir Adapter data directory
   * @param log ioBroker logger
   */
  constructor(dataDir: string, log: ioBroker.Logger) {
    this.dir = path.join(dataDir, "snapshots");
    this.log = log;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Get all snapshots for a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  getSnapshots(sku: string, deviceId: string): LocalSnapshot[] {
    const file = this.snapshotFile(sku, deviceId);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as SnapshotFile;
        return data.snapshots ?? [];
      }
    } catch (e) {
      this.log.debug(
        `Snapshot read failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return [];
  }

  /**
   * Save a new snapshot (or overwrite existing with same name).
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param snapshot Snapshot data to save
   */
  saveSnapshot(sku: string, deviceId: string, snapshot: LocalSnapshot): void {
    const snapshots = this.getSnapshots(sku, deviceId);
    const existing = snapshots.findIndex((s) => s.name === snapshot.name);
    if (existing >= 0) {
      snapshots[existing] = snapshot;
    } else {
      snapshots.push(snapshot);
    }
    this.writeFile(sku, deviceId, snapshots);
    this.log.debug(`Local snapshot saved: "${snapshot.name}" for ${sku}`);
  }

  /**
   * Delete a snapshot by name.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param name Snapshot name to delete
   */
  deleteSnapshot(sku: string, deviceId: string, name: string): boolean {
    const snapshots = this.getSnapshots(sku, deviceId);
    const idx = snapshots.findIndex((s) => s.name === name);
    if (idx < 0) {
      return false;
    }
    snapshots.splice(idx, 1);
    this.writeFile(sku, deviceId, snapshots);
    this.log.debug(`Local snapshot deleted: "${name}" for ${sku}`);
    return true;
  }

  /**
   * Write snapshot file for a device.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param snapshots Snapshot array to persist
   */
  private writeFile(
    sku: string,
    deviceId: string,
    snapshots: LocalSnapshot[],
  ): void {
    const file = this.snapshotFile(sku, deviceId);
    try {
      const data: SnapshotFile = { snapshots };
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      this.log.warn(
        `Snapshot write failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Build file path for a device's snapshots.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  private snapshotFile(sku: string, deviceId: string): string {
    const shortId = deviceId.replace(/:/g, "").toLowerCase().slice(-4);
    return path.join(this.dir, `${sku.toLowerCase()}_${shortId}.json`);
  }
}
