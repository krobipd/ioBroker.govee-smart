"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var local_snapshots_exports = {};
__export(local_snapshots_exports, {
  LocalSnapshotStore: () => LocalSnapshotStore
});
module.exports = __toCommonJS(local_snapshots_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
class LocalSnapshotStore {
  dir;
  log;
  /**
   * @param dataDir Adapter data directory
   * @param log ioBroker logger
   */
  constructor(dataDir, log) {
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
  getSnapshots(sku, deviceId) {
    const file = this.snapshotFile(sku, deviceId);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        return Array.isArray(data == null ? void 0 : data.snapshots) ? data.snapshots : [];
      }
    } catch (e) {
      this.log.debug(
        `Snapshot read failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`
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
  saveSnapshot(sku, deviceId, snapshot) {
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
  deleteSnapshot(sku, deviceId, name) {
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
   * Uses explicit open/write/fsync/close so the data hits disk before the
   * call returns — plain writeFileSync only pushes to the kernel page cache
   * and an adapter SIGKILL within the dirty-writeback window would lose the
   * save silently. Same hardening as sku-cache.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   * @param snapshots Snapshot array to persist
   */
  writeFile(sku, deviceId, snapshots) {
    const file = this.snapshotFile(sku, deviceId);
    try {
      const data = { snapshots };
      const fd = fs.openSync(file, "w");
      try {
        fs.writeSync(fd, JSON.stringify(data, null, 2), 0, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.log.warn(
        `Snapshot write failed for ${sku}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  /**
   * Build file path for a device's snapshots.
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  snapshotFile(sku, deviceId) {
    const safeSku = typeof sku === "string" ? sku : "";
    const safeId = typeof deviceId === "string" ? deviceId : "";
    const shortId = safeId.replace(/:/g, "").toLowerCase().slice(-4);
    return path.join(this.dir, `${safeSku.toLowerCase()}_${shortId}.json`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LocalSnapshotStore
});
//# sourceMappingURL=local-snapshots.js.map
