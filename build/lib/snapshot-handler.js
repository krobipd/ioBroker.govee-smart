"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var snapshot_handler_exports = {};
__export(snapshot_handler_exports, {
  SnapshotHandler: () => SnapshotHandler
});
module.exports = __toCommonJS(snapshot_handler_exports);
var import_types = require("./types");
var import_device_baseline = require("./device-baseline");
class SnapshotHandler {
  /**
   * @param host Adapter dependencies via the host interface (testable with mocks)
   */
  constructor(host) {
    this.host = host;
  }
  host;
  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  async save(device, name) {
    var _a, _b, _c;
    const base = await (0, import_device_baseline.readDeviceBaseline)(this.host, device, { color: "#000000", brightness: 100 });
    const snapshot = {
      name,
      power: base.power === true,
      brightness: (_a = base.brightness) != null ? _a : 0,
      colorRgb: (_b = base.colorRgb) != null ? _b : "#000000",
      colorTemperature: (_c = base.colorTemperature) != null ? _c : 0,
      segments: base.segments.length > 0 ? base.segments : void 0,
      savedAt: Date.now()
    };
    await this.host.store.saveSnapshot(device.sku, device.deviceId, snapshot);
    this.host.log.info(`Local snapshot saved: "${name}" for ${(0, import_types.deviceLabel)(device)}`);
    this.host.refreshDeviceStates(device);
  }
  /**
   * Restore a local snapshot by index.
   *
   * @param device Target device
   * @param val Dropdown index value
   */
  async restore(device, val) {
    const idx = parseInt(String(val), 10);
    if (idx < 1) {
      return;
    }
    const snaps = this.host.store.getSnapshots(device.sku, device.deviceId);
    const snap = snaps[idx - 1];
    if (!snap) {
      this.host.log.warn(`Local snapshot index ${idx} not found for ${(0, import_types.deviceLabel)(device)}`);
      return;
    }
    this.host.log.info(`Restoring local snapshot "${snap.name}" for ${(0, import_types.deviceLabel)(device)}`);
    await this.host.sendCommand(device, "power", snap.power);
    if (snap.power) {
      await this.host.sendCommand(device, "brightness", snap.brightness);
      if (snap.colorTemperature > 0) {
        await this.host.sendCommand(device, "colorTemperature", snap.colorTemperature);
      } else {
        await this.host.sendCommand(device, "colorRgb", snap.colorRgb);
      }
      if (snap.segments && snap.segments.length > 0) {
        await this.restoreSegments(device, snap.segments);
      }
    }
  }
  /**
   * Restore per-segment color + brightness via segmentBatch commands.
   * Groups segments by identical (color, brightness) so a uniform-coloured
   * strip restores in 1 batch, a 3-zone snapshot in 3 batches — instead of
   * the old N×2 sequential pattern that paid the forceColorMode 150 ms
   * settle delay per segment.
   *
   * @param device Target device
   * @param segments Per-segment color + brightness data
   */
  async restoreSegments(device, segments) {
    const groups = /* @__PURE__ */ new Map();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const hex = typeof seg.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(seg.color) ? seg.color : "#000000";
      const color = parseInt(hex.replace("#", ""), 16);
      const brightness = typeof seg.brightness === "number" ? seg.brightness : 100;
      const key = `${color}:${brightness}`;
      const existing = groups.get(key);
      if (existing) {
        existing.segments.push(i);
      } else {
        groups.set(key, { segments: [i], color, brightness });
      }
    }
    for (const group of groups.values()) {
      await this.host.sendCommand(device, "segmentBatch", group);
    }
  }
  /**
   * Delete a local snapshot by name.
   *
   * @param device Target device
   * @param name Snapshot name to delete
   */
  async delete(device, name) {
    if (await this.host.store.deleteSnapshot(device.sku, device.deviceId, name)) {
      this.host.log.info(`Local snapshot deleted: "${name}" for ${(0, import_types.deviceLabel)(device)}`);
      this.host.refreshDeviceStates(device);
    } else {
      this.host.log.warn(`Local snapshot "${name}" not found for ${(0, import_types.deviceLabel)(device)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SnapshotHandler
});
//# sourceMappingURL=snapshot-handler.js.map
