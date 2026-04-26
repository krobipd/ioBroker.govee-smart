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
var device_registry_exports = {};
__export(device_registry_exports, {
  DeviceRegistry: () => DeviceRegistry,
  _resetDeviceRegistry: () => _resetDeviceRegistry,
  applyColorTempQuirk: () => applyColorTempQuirk,
  getDeviceQuirks: () => getDeviceQuirks,
  initDeviceRegistry: () => initDeviceRegistry,
  isSeedAndDormant: () => isSeedAndDormant
});
module.exports = __toCommonJS(device_registry_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
class DeviceRegistry {
  entries;
  activeQuirks;
  experimental;
  log;
  /**
   * Build a registry from `config.data` (preferred for tests) or from a
   * file at `config.filePath` (default: `<adapter root>/devices.json`).
   *
   * @param config Loader options
   */
  constructor(config = {}) {
    var _a, _b;
    this.experimental = (_a = config.experimental) != null ? _a : false;
    this.log = config.log;
    this.entries = /* @__PURE__ */ new Map();
    this.activeQuirks = /* @__PURE__ */ new Map();
    if (config.data) {
      this.ingest(config.data);
    } else {
      const filePath = (_b = config.filePath) != null ? _b : this.defaultPath();
      this.loadFromFile(filePath);
    }
  }
  /** Resolve the canonical devices.json path next to the package root. */
  defaultPath() {
    return path.resolve(__dirname, "..", "..", "devices.json");
  }
  /**
   * Read devices.json from disk. Logs but does not throw on errors —
   * an empty registry is a safer fallback than a crashed adapter.
   *
   * @param filePath Absolute path to devices.json
   */
  loadFromFile(filePath) {
    var _a, _b;
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      (_a = this.log) == null ? void 0 : _a.warn(
        `device-registry: cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      (_b = this.log) == null ? void 0 : _b.warn(
        `device-registry: invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    this.ingest(parsed);
  }
  /**
   * Populate the in-memory maps from a parsed devices object. Shared
   * between file-loading and direct-data path (tests).
   *
   * @param parsed Pre-parsed devices.json content
   */
  ingest(parsed) {
    var _a, _b;
    if (!(parsed == null ? void 0 : parsed.devices) || typeof parsed.devices !== "object") {
      (_a = this.log) == null ? void 0 : _a.warn(`device-registry: 'devices' object missing or invalid`);
      return;
    }
    let active = 0;
    let skipped = 0;
    for (const [sku, entry] of Object.entries(parsed.devices)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const upper = sku.toUpperCase();
      this.entries.set(upper, entry);
      const eligible = entry.status === "verified" || entry.status === "reported" || entry.status === "seed" && this.experimental;
      if (eligible && entry.quirks) {
        this.activeQuirks.set(upper, entry.quirks);
        active++;
      } else if (!eligible) {
        skipped++;
      }
    }
    (_b = this.log) == null ? void 0 : _b.debug(
      `device-registry: ${this.entries.size} entries loaded, ${active} active quirks, ${skipped} seed entries skipped`
    );
  }
  /**
   * Whether the given SKU exists as a `seed` entry in the catalog and
   * the experimental toggle is OFF — i.e. the adapter recognises this
   * device but the per-SKU quirk corrections aren't active. The device
   * manager calls this when a real device shows up so the user gets a
   * targeted* nudge ("you have an H7160, enable the toggle"), not a
   * blanket dump of every seed entry in the catalog.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  isSeedAndDormant(sku) {
    var _a;
    if (this.experimental) {
      return false;
    }
    if (!sku || typeof sku !== "string") {
      return false;
    }
    return ((_a = this.entries.get(sku.toUpperCase())) == null ? void 0 : _a.status) === "seed";
  }
  /**
   * Quirks for a SKU. Returns undefined if SKU is unknown OR if it's a
   * seed-status entry and `experimental` is off.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getQuirks(sku) {
    if (typeof sku !== "string") {
      return void 0;
    }
    return this.activeQuirks.get(sku.toUpperCase());
  }
  /**
   * The full registry entry for a SKU (status, name, since, quirks).
   * Returns undefined for unknown SKUs.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getEntry(sku) {
    if (typeof sku !== "string") {
      return void 0;
    }
    return this.entries.get(sku.toUpperCase());
  }
  /**
   * Trust tier of a SKU, or undefined if unknown.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getStatus(sku) {
    var _a;
    return (_a = this.getEntry(sku)) == null ? void 0 : _a.status;
  }
  /**
   * Govee-app display name for a SKU, or undefined if unknown.
   *
   * @param sku Govee SKU (case-insensitive)
   */
  getName(sku) {
    var _a;
    return (_a = this.getEntry(sku)) == null ? void 0 : _a.name;
  }
  /** All SKUs known to the registry (regardless of status). */
  getKnownSkus() {
    return [...this.entries.keys()];
  }
  /**
   * Convenience helper preserving the old `applyColorTempQuirk` shape so
   * call-sites in capability-mapper don't have to change.
   *
   * @param sku Govee SKU
   * @param min API-reported minimum
   * @param max API-reported maximum
   */
  applyColorTempQuirk(sku, min, max) {
    const q = this.getQuirks(sku);
    if (q == null ? void 0 : q.colorTempRange) {
      return q.colorTempRange;
    }
    return { min, max };
  }
}
let singleton;
function initDeviceRegistry(config = {}) {
  singleton = new DeviceRegistry(config);
  return singleton;
}
function _resetDeviceRegistry() {
  singleton = void 0;
}
function getDeviceQuirks(sku) {
  return singleton == null ? void 0 : singleton.getQuirks(sku);
}
function applyColorTempQuirk(sku, min, max) {
  var _a;
  return (_a = singleton == null ? void 0 : singleton.applyColorTempQuirk(sku, min, max)) != null ? _a : { min, max };
}
function isSeedAndDormant(sku) {
  var _a;
  return (_a = singleton == null ? void 0 : singleton.isSeedAndDormant(sku)) != null ? _a : false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceRegistry,
  _resetDeviceRegistry,
  applyColorTempQuirk,
  getDeviceQuirks,
  initDeviceRegistry,
  isSeedAndDormant
});
//# sourceMappingURL=device-registry.js.map
