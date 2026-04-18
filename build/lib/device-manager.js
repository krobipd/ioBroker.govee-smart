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
var device_manager_exports = {};
__export(device_manager_exports, {
  DeviceManager: () => DeviceManager,
  getEffectiveSegmentIndices: () => getEffectiveSegmentIndices,
  parseMqttSegmentData: () => parseMqttSegmentData
});
module.exports = __toCommonJS(device_manager_exports);
var import_command_router = require("./command-router.js");
var import_device_quirks = require("./device-quirks.js");
var import_types = require("./types.js");
var import_http_client = require("./http-client.js");
const APPLIANCE_TYPES = /* @__PURE__ */ new Set([
  "devices.types.heater",
  "devices.types.humidifier",
  "devices.types.air_purifier",
  "devices.types.fan",
  "devices.types.dehumidifier",
  "devices.types.thermometer",
  "devices.types.sensor",
  "devices.types.socket",
  "devices.types.ice_maker",
  "devices.types.aroma_diffuser",
  "devices.types.kettle"
]);
function parseMqttSegmentData(commands) {
  if (!Array.isArray(commands)) {
    return [];
  }
  const segments = [];
  let highestPacket = 0;
  for (const cmd of commands) {
    if (typeof cmd !== "string") {
      continue;
    }
    const bytes = Buffer.from(cmd, "base64");
    if (bytes.length < 20 || bytes[0] !== 170 || bytes[1] !== 165) {
      continue;
    }
    const packetNum = bytes[2];
    if (packetNum < 1 || packetNum > 5) {
      continue;
    }
    if (packetNum > highestPacket) {
      highestPacket = packetNum;
    }
    const baseIndex = (packetNum - 1) * 4;
    for (let slot = 0; slot < 4; slot++) {
      const segIdx = baseIndex + slot;
      const offset = 3 + slot * 4;
      segments.push({
        index: segIdx,
        brightness: bytes[offset],
        r: bytes[offset + 1],
        g: bytes[offset + 2],
        b: bytes[offset + 3]
      });
    }
  }
  while (segments.length > 0) {
    const tail = segments[segments.length - 1];
    if (tail.brightness === 0 && tail.r === 0 && tail.g === 0 && tail.b === 0) {
      segments.pop();
    } else {
      break;
    }
  }
  return segments;
}
function getEffectiveSegmentIndices(device) {
  var _a;
  if (device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0) {
    return device.manualSegments.slice();
  }
  const count = (_a = device.segmentCount) != null ? _a : 0;
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, (_, i) => i);
}
class DeviceManager {
  log;
  devices = /* @__PURE__ */ new Map();
  commandRouter;
  cloudClient = null;
  apiClient = null;
  skuCache = null;
  onDeviceUpdate = null;
  onDeviceListChanged = null;
  lastErrorCategory = null;
  /** @param log ioBroker logger */
  constructor(log) {
    this.log = log;
    this.commandRouter = new import_command_router.CommandRouter(log);
  }
  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client) {
    this.commandRouter.setLanClient(client);
  }
  /**
   * Register the undocumented API client for scene/music/DIY libraries
   *
   * @param client API client instance
   */
  setApiClient(client) {
    this.apiClient = client;
  }
  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client) {
    this.cloudClient = client;
    this.commandRouter.setCloudClient(client);
  }
  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter) {
    this.commandRouter.setRateLimiter(limiter);
  }
  /**
   * Register the SKU cache for persistent device data
   *
   * @param cache SKU cache instance
   */
  setSkuCache(cache) {
    this.skuCache = cache;
  }
  /**
   * Set callbacks for device state changes and list changes.
   *
   * @param onUpdate Called when a device state changes (from any channel)
   * @param onListChanged Called when the device list changes (new/removed devices)
   */
  setCallbacks(onUpdate, onListChanged) {
    this.onDeviceUpdate = onUpdate;
    this.onDeviceListChanged = onListChanged;
  }
  /** Get all known devices */
  getDevices() {
    return Array.from(this.devices.values());
  }
  /**
   * Load devices from local SKU cache.
   * Returns true if any devices were loaded (= Cloud not needed).
   */
  loadFromCache() {
    var _a;
    if (!this.skuCache) {
      return false;
    }
    const cached = this.skuCache.loadAll();
    if (cached.length === 0) {
      return false;
    }
    let changed = false;
    for (const entry of cached) {
      const key = this.deviceKey(entry.sku, entry.deviceId);
      const existing = this.devices.get(key);
      if (existing) {
        existing.name = entry.name || existing.name;
        existing.type = entry.type || existing.type;
        existing.capabilities = entry.capabilities;
        existing.scenes = entry.scenes;
        existing.diyScenes = entry.diyScenes;
        existing.snapshots = entry.snapshots;
        existing.sceneLibrary = entry.sceneLibrary;
        existing.musicLibrary = entry.musicLibrary;
        existing.diyLibrary = entry.diyLibrary;
        existing.skuFeatures = entry.skuFeatures;
        existing.snapshotBleCmds = entry.snapshotBleCmds;
        existing.scenesChecked = entry.scenesChecked;
        existing.lastSeenOnNetwork = entry.lastSeenOnNetwork;
        existing.channels.cloud = entry.capabilities.length > 0;
        changed = true;
      } else {
        this.devices.set(key, this.cachedToGoveeDevice(entry));
        changed = true;
      }
    }
    if (changed) {
      this.log.info(`Loaded ${cached.length} device(s) from cache`);
    }
    const needsRefetch = Array.from(this.devices.values()).some(
      (d) => d.type === "devices.types.light" && !d.scenesChecked
    );
    if (needsRefetch) {
      this.log.info(
        "Cache has unchecked scene data \u2014 will confirm once via Cloud"
      );
      return false;
    }
    for (const device of this.devices.values()) {
      this.populateScenesFromLibrary(device);
    }
    if (changed) {
      (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
    }
    return cached.length > 0;
  }
  /**
   * Load devices from Cloud API and save to cache.
   * Only called when cache is empty (first start) or manual refresh.
   */
  async loadFromCloud() {
    var _a;
    if (!this.cloudClient) {
      return { ok: false, reason: "transient" };
    }
    try {
      const rawCloudDevices = await this.cloudClient.getDevices();
      const cloudDevices = Array.isArray(rawCloudDevices) ? rawCloudDevices.filter(
        (cd) => cd && typeof cd.sku === "string" && typeof cd.device === "string" && Array.isArray(cd.capabilities) && cd.capabilities.length > 0
      ) : [];
      if (Array.isArray(rawCloudDevices) && rawCloudDevices.length !== cloudDevices.length) {
        this.log.info(
          `Cloud: received ${rawCloudDevices.length} devices raw, ${cloudDevices.length} after filter (skipped stale entries without capabilities)`
        );
      }
      let changed = this.mergeCloudDevices(cloudDevices);
      for (const cd of cloudDevices) {
        const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
        const isLight = cd.type === "devices.types.light" || caps.some(
          (c) => c && typeof c.type === "string" && c.type.includes("dynamic_scene")
        );
        if (isLight) {
          const device = this.devices.get(this.deviceKey(cd.sku, cd.device));
          if (device) {
            if (await this.loadDeviceScenes(device, cd)) {
              changed = true;
            }
            if (await this.loadDeviceLibraries(device, cd.sku)) {
              changed = true;
            }
            device.scenesChecked = true;
          }
        }
      }
      if (this.skuCache && cloudDevices.length > 0) {
        this.skuCache.pruneStale(14);
      }
      this.saveDevicesToCache();
      for (const device of this.devices.values()) {
        this.populateScenesFromLibrary(device);
      }
      if (changed) {
        (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
      }
      this.lastErrorCategory = null;
      return { ok: true };
    } catch (err) {
      this.logDedup("Cloud device list failed", err);
      if (err instanceof import_http_client.HttpError && err.statusCode === 429) {
        const retryAfterRaw = err.headers["retry-after"];
        const retryAfterSec = typeof retryAfterRaw === "string" && /^\d+$/.test(retryAfterRaw) ? parseInt(retryAfterRaw, 10) : 60;
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterMs: retryAfterSec * 1e3
        };
      }
      const category = (0, import_types.classifyError)(err);
      if (category === "AUTH") {
        return {
          ok: false,
          reason: "auth-failed",
          message: err instanceof Error ? err.message : String(err)
        };
      }
      return { ok: false, reason: "transient" };
    }
  }
  /**
   * Merge Cloud device list into local device map.
   * Updates existing devices, adds new ones.
   *
   * @param cloudDevices Devices from Cloud API
   * @returns true if any new devices were added
   */
  mergeCloudDevices(cloudDevices) {
    let changed = false;
    if (!Array.isArray(cloudDevices)) {
      return false;
    }
    for (const cd of cloudDevices) {
      if (!cd || typeof cd.sku !== "string" || typeof cd.device !== "string") {
        continue;
      }
      if (APPLIANCE_TYPES.has(cd.type)) {
        continue;
      }
      const existing = this.devices.get(this.deviceKey(cd.sku, cd.device));
      if (existing) {
        existing.name = cd.deviceName || existing.name;
        existing.capabilities = Array.isArray(cd.capabilities) ? cd.capabilities : [];
        existing.type = cd.type;
        existing.channels.cloud = true;
      } else {
        const device = this.cloudDeviceToGoveeDevice(cd);
        this.devices.set(this.deviceKey(cd.sku, cd.device), device);
        changed = true;
        this.log.debug(`Cloud: New device ${cd.deviceName} (${cd.sku})`);
      }
      const quirks = (0, import_device_quirks.getDeviceQuirks)(cd.sku);
      if (quirks == null ? void 0 : quirks.brokenPlatformApi) {
        this.log.debug(
          `${cd.sku} has known broken platform API metadata \u2014 capabilities may be incomplete`
        );
      }
    }
    return changed;
  }
  /**
   * Load scenes, DIY scenes, and snapshots for a device from Cloud API.
   *
   * @param device Target device to populate
   * @param cd Cloud device data with capabilities
   * @returns true if any scene data changed
   */
  async loadDeviceScenes(device, cd) {
    var _a;
    let changed = false;
    const loadScenes = async () => {
      try {
        const { lightScenes, diyScenes, snapshots } = await this.cloudClient.getScenes(cd.sku, cd.device);
        if (lightScenes.length > 0 || diyScenes.length > 0 || snapshots.length > 0) {
          const scenesChanged = lightScenes.length !== device.scenes.length || diyScenes.length !== device.diyScenes.length || snapshots.length !== device.snapshots.length;
          device.scenes = lightScenes;
          device.diyScenes = diyScenes;
          device.snapshots = snapshots;
          if (scenesChanged) {
            changed = true;
          }
        }
      } catch {
        this.log.debug(`Could not load scenes for ${cd.sku}`);
      }
    };
    await this.commandRouter.executeRateLimited(loadScenes, 2);
    if (device.diyScenes.length === 0) {
      const loadDiy = async () => {
        try {
          const diy = await this.cloudClient.getDiyScenes(cd.sku, cd.device);
          if (diy.length > 0) {
            device.diyScenes = diy;
            changed = true;
          }
        } catch {
          this.log.debug(`Could not load DIY scenes for ${cd.sku}`);
        }
      };
      await this.commandRouter.executeRateLimited(loadDiy, 2);
    }
    if (device.snapshots.length === 0) {
      const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
      const snapCap = caps.find(
        (c) => {
          var _a2;
          return c && c.type === "devices.capabilities.dynamic_scene" && c.instance === "snapshot" && Array.isArray((_a2 = c.parameters) == null ? void 0 : _a2.options);
        }
      );
      if ((_a = snapCap == null ? void 0 : snapCap.parameters) == null ? void 0 : _a.options) {
        device.snapshots = snapCap.parameters.options.filter(
          (o) => o && typeof o.name === "string" && o.value !== void 0 && o.value !== null
        ).map((o) => ({
          name: o.name,
          value: typeof o.value === "number" ? o.value : o.value
        }));
        this.log.debug(
          `Snapshots from capabilities for ${cd.sku}: ${device.snapshots.length}`
        );
      }
    }
    if (device.scenes.length > 0 || device.diyScenes.length > 0 || device.snapshots.length > 0) {
      changed = true;
    }
    return changed;
  }
  /**
   * Load scene/music/DIY libraries and SKU features from undocumented API.
   *
   * @param device Target device to populate
   * @param sku Product model
   * @returns true if any library data changed
   */
  async loadDeviceLibraries(device, sku) {
    if (!this.apiClient) {
      return false;
    }
    let changed = false;
    if (device.sceneLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchSceneLibrary(sku);
        if (lib.length > 0) {
          device.sceneLibrary = lib;
          changed = true;
          this.log.debug(`Scene library for ${sku}: ${lib.length} scenes`);
        }
      } catch {
        this.log.debug(`Could not load scene library for ${sku}`);
      }
    }
    if (device.musicLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchMusicLibrary(sku);
        if (lib.length > 0) {
          device.musicLibrary = lib;
          changed = true;
          this.log.debug(`Music library for ${sku}: ${lib.length} modes`);
        }
      } catch (e) {
        this.log.debug(
          `Could not load music library for ${sku}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    if (device.diyLibrary.length === 0) {
      try {
        const lib = await this.apiClient.fetchDiyLibrary(sku);
        if (lib.length > 0) {
          device.diyLibrary = lib;
          changed = true;
          this.log.debug(`DIY library for ${sku}: ${lib.length} effects`);
        }
      } catch (e) {
        this.log.debug(
          `Could not load DIY library for ${sku}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    if (!device.skuFeatures) {
      try {
        const features = await this.apiClient.fetchSkuFeatures(sku);
        if (features) {
          device.skuFeatures = features;
          changed = true;
          this.log.debug(
            `SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`
          );
        }
      } catch (e) {
        this.log.debug(
          `Could not load SKU features for ${sku}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    if (!device.snapshotBleCmds && device.snapshots.length > 0) {
      try {
        const snaps = await this.apiClient.fetchSnapshots(sku, device.deviceId);
        if (snaps.length > 0) {
          device.snapshotBleCmds = device.snapshots.map((ds) => {
            var _a;
            const match = snaps.find((s) => s.name === ds.name);
            return (_a = match == null ? void 0 : match.bleCmds) != null ? _a : [];
          });
          changed = true;
          this.log.debug(
            `Snapshot BLE for ${sku}: ${snaps.length} snapshots with local data`
          );
        }
      } catch (e) {
        this.log.debug(
          `Could not load snapshot BLE for ${sku}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return changed;
  }
  /**
   * Load group membership from undocumented API and attach to BaseGroup devices.
   * Resolves member device references against the current device map.
   *
   * @returns true if any group memberships were resolved
   */
  async loadGroupMembers() {
    var _a;
    if (!this.apiClient) {
      return false;
    }
    if (!this.apiClient.hasBearerToken()) {
      this.log.debug(
        "Group membership requires Email+Password \u2014 skipping member resolution"
      );
      return false;
    }
    try {
      const apiGroups = await this.apiClient.fetchGroupMembers();
      if (apiGroups.length === 0) {
        this.log.debug("No group membership data from API");
        return false;
      }
      let changed = false;
      for (const group of this.devices.values()) {
        if (group.sku !== "BaseGroup") {
          continue;
        }
        const apiGroup = apiGroups.find(
          (g) => String(g.groupId) === group.deviceId
        );
        if (!apiGroup) {
          continue;
        }
        const members = [];
        for (const m of apiGroup.devices) {
          const resolved = this.findDeviceBySkuAndId(m.sku, m.deviceId);
          if (resolved) {
            members.push({ sku: resolved.sku, deviceId: resolved.deviceId });
          } else {
            this.log.debug(
              `Group "${group.name}": member ${m.sku}/${m.deviceId} not in device map`
            );
          }
        }
        group.groupMembers = members;
        if (members.length > 0) {
          changed = true;
        }
        this.log.debug(
          `Group "${group.name}": ${members.length}/${apiGroup.devices.length} members resolved`
        );
      }
      if (changed) {
        (_a = this.onDeviceListChanged) == null ? void 0 : _a.call(this, this.getDevices());
      }
      return changed;
    } catch (e) {
      this.log.debug(
        `Could not load group members: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
  }
  /** Save all devices to SKU cache, skipping only those never confirmed via Cloud yet. */
  saveDevicesToCache() {
    if (!this.skuCache) {
      return;
    }
    let cachedCount = 0;
    let skippedCount = 0;
    for (const device of this.devices.values()) {
      const isLight = device.type === "devices.types.light";
      if (isLight && !device.scenesChecked) {
        skippedCount++;
        this.log.debug(
          `Not caching ${device.name} (${device.sku}) \u2014 scenes not yet checked`
        );
      } else {
        this.skuCache.save(this.goveeDeviceToCached(device));
        cachedCount++;
      }
    }
    if (skippedCount > 0) {
      this.log.info(
        `Cached ${cachedCount} device(s), skipped ${skippedCount} not yet checked \u2014 will confirm next start`
      );
    } else {
      this.log.info(
        `Cached ${cachedCount} device(s) \u2014 next start uses cache, no Cloud needed`
      );
    }
  }
  /**
   * Handle LAN device discovery — match against known devices or create new.
   *
   * @param lanDevice Discovered LAN device
   */
  handleLanDiscovery(lanDevice) {
    var _a, _b;
    let matched;
    for (const dev of this.devices.values()) {
      if ((0, import_types.normalizeDeviceId)(dev.deviceId) === (0, import_types.normalizeDeviceId)(lanDevice.device)) {
        matched = dev;
        break;
      }
      if (dev.sku === lanDevice.sku && !dev.lanIp) {
        matched = dev;
        break;
      }
    }
    if (matched) {
      const ipChanged = matched.lanIp !== lanDevice.ip;
      matched.lanIp = lanDevice.ip;
      matched.channels.lan = true;
      matched.lastSeenOnNetwork = Date.now();
      if (ipChanged) {
        this.log.debug(
          `LAN: ${matched.name} (${matched.sku}) at ${lanDevice.ip}`
        );
        (_a = this.onLanIpChanged) == null ? void 0 : _a.call(this, matched, lanDevice.ip);
      }
    } else {
      const shortId = (0, import_types.normalizeDeviceId)(lanDevice.device).slice(-4);
      const device = {
        sku: lanDevice.sku,
        deviceId: lanDevice.device,
        name: `${lanDevice.sku}_${shortId}`,
        type: "devices.types.light",
        lanIp: lanDevice.ip,
        capabilities: [],
        scenes: [],
        diyScenes: [],
        snapshots: [],
        sceneLibrary: [],
        musicLibrary: [],
        diyLibrary: [],
        skuFeatures: null,
        lastSeenOnNetwork: Date.now(),
        state: { online: true },
        channels: { lan: true, mqtt: false, cloud: false }
      };
      this.devices.set(this.deviceKey(lanDevice.sku, lanDevice.device), device);
      this.log.debug(`LAN: New device ${lanDevice.sku} at ${lanDevice.ip}`);
      (_b = this.onDeviceListChanged) == null ? void 0 : _b.call(this, this.getDevices());
    }
  }
  /**
   * Handle MQTT status update — update device state.
   *
   * @param update MQTT status message
   */
  handleMqttStatus(update) {
    var _a, _b, _c, _d, _e;
    const device = this.findDeviceBySkuAndId(update.sku, update.device);
    if (!device) {
      this.log.debug(`MQTT: Unknown device ${update.sku} ${update.device}`);
      return;
    }
    device.channels.mqtt = true;
    device.lastSeenOnNetwork = Date.now();
    const state = { online: true };
    if (update.state) {
      if (update.state.onOff !== void 0) {
        state.power = update.state.onOff === 1;
      }
      if (update.state.brightness !== void 0) {
        state.brightness = update.state.brightness;
      }
      if (update.state.color) {
        const { r, g, b } = update.state.color;
        state.colorRgb = (0, import_types.rgbToHex)(r, g, b);
      }
      if (update.state.colorTemInKelvin) {
        state.colorTemperature = update.state.colorTemInKelvin;
      }
    }
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
    if (((_b = update.op) == null ? void 0 : _b.command) && device.segmentCount) {
      const segData = parseMqttSegmentData(update.op.command);
      if (segData.length > 0) {
        const maxSeen = Math.max(...segData.map((s) => s.index)) + 1;
        if (maxSeen > ((_c = device.segmentCount) != null ? _c : 0)) {
          this.log.info(
            `${device.name}: MQTT shows ${maxSeen} segments (Cloud reported ${device.segmentCount}) \u2014 updating state tree`
          );
          device.segmentCount = maxSeen;
          (_d = this.onSegmentCountGrown) == null ? void 0 : _d.call(this, device);
          return;
        }
      }
      const filtered = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? segData.filter((s) => device.manualSegments.includes(s.index)) : segData;
      if (filtered.length > 0) {
        (_e = this.onMqttSegmentUpdate) == null ? void 0 : _e.call(this, device, filtered);
      }
    }
  }
  /**
   * Handle LAN status response.
   *
   * @param ip Source IP address
   * @param status LAN status data
   * @param status.onOff Power state (1=on, 0=off)
   * @param status.brightness Brightness 0-100
   * @param status.color RGB color values
   * @param status.color.r Red channel 0-255
   * @param status.color.g Green channel 0-255
   * @param status.color.b Blue channel 0-255
   * @param status.colorTemInKelvin Color temperature in Kelvin
   */
  handleLanStatus(ip, status) {
    var _a;
    let device;
    for (const dev of this.devices.values()) {
      if (dev.lanIp === ip) {
        device = dev;
        break;
      }
    }
    if (!device) {
      return;
    }
    device.lastSeenOnNetwork = Date.now();
    const { r, g, b } = status.color;
    const state = {
      online: true,
      power: status.onOff === 1,
      brightness: status.brightness,
      colorRgb: (0, import_types.rgbToHex)(r, g, b),
      colorTemperature: status.colorTemInKelvin || void 0
    };
    Object.assign(device.state, state);
    (_a = this.onDeviceUpdate) == null ? void 0 : _a.call(this, device, state);
  }
  /**
   * Set the callback for batch segment state sync.
   * Forwards to the internal CommandRouter.
   *
   * @param callback Called when a segment batch command updates segment states
   */
  set onSegmentBatchUpdate(callback) {
    this.commandRouter.onSegmentBatchUpdate = callback;
  }
  /**
   * Send a command to a device — routes through LAN → MQTT → Cloud.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCommand(device, command, value) {
    return this.commandRouter.sendCommand(device, command, value);
  }
  /**
   * Send a generic capability command via Cloud API.
   * Used for capability types not explicitly handled (toggle, dynamic_scene, etc.)
   *
   * @param device Target device
   * @param capabilityType Full capability type (e.g. "devices.capabilities.toggle")
   * @param capabilityInstance Capability instance name (e.g. "gradientToggle")
   * @param value Command value
   */
  async sendCapabilityCommand(device, capabilityType, capabilityInstance, value) {
    return this.commandRouter.sendCapabilityCommand(
      device,
      capabilityType,
      capabilityInstance,
      value
    );
  }
  /** Callback when device LAN IP changes */
  onLanIpChanged;
  /** Callback when MQTT delivers per-segment state data (AA A5 BLE packets) */
  onMqttSegmentUpdate;
  /**
   * Callback when the device's physical segment count turns out to be
   * larger than the Cloud-reported value (observed via MQTT AA A5 stream).
   * The adapter rebuilds the state tree in response so the extra indices
   * appear as datapoints.
   */
  onSegmentCountGrown;
  /**
   * Convert Cloud device to internal device model
   *
   * @param cd Cloud API device data
   */
  cloudDeviceToGoveeDevice(cd) {
    return {
      sku: cd.sku,
      deviceId: cd.device,
      name: cd.deviceName || cd.sku,
      type: cd.type || "unknown",
      capabilities: Array.isArray(cd.capabilities) ? cd.capabilities : [],
      scenes: [],
      diyScenes: [],
      snapshots: [],
      sceneLibrary: [],
      musicLibrary: [],
      diyLibrary: [],
      skuFeatures: null,
      state: { online: true },
      channels: { lan: false, mqtt: false, cloud: true }
    };
  }
  /**
   * Find device by SKU and device ID (handles format differences)
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  findDeviceBySkuAndId(sku, deviceId) {
    const direct = this.devices.get(this.deviceKey(sku, deviceId));
    if (direct) {
      return direct;
    }
    const normalizedId = (0, import_types.normalizeDeviceId)(deviceId);
    for (const dev of this.devices.values()) {
      if (dev.sku === sku && (0, import_types.normalizeDeviceId)(dev.deviceId) === normalizedId) {
        return dev;
      }
    }
    return void 0;
  }
  /**
   * Generate unique key for a device
   *
   * @param sku Product model
   * @param deviceId Device identifier
   */
  deviceKey(sku, deviceId) {
    return `${sku}_${(0, import_types.normalizeDeviceId)(deviceId)}`;
  }
  /**
   * Log error with dedup — only warn on category change, debug on repeat.
   *
   * @param context Error context description
   * @param err Error to log
   */
  logDedup(context, err) {
    const category = (0, import_types.classifyError)(err);
    const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
    if (category !== this.lastErrorCategory) {
      this.lastErrorCategory = category;
      this.log.warn(msg);
    } else {
      this.log.debug(`${msg} (repeated)`);
    }
  }
  /**
   * Fill device.scenes from sceneLibrary when Cloud scenes are missing.
   * ptReal activation matches by name, so sceneLibrary names are sufficient.
   *
   * @param device Device to populate scenes for
   */
  populateScenesFromLibrary(device) {
    if (device.scenes.length === 0 && device.sceneLibrary.length > 0) {
      device.scenes = device.sceneLibrary.map((entry) => ({
        name: entry.name,
        value: {}
        // ptReal uses sceneLibrary directly, Cloud payload not needed
      }));
      this.log.debug(
        `${device.sku}: ${device.scenes.length} scenes from library (Cloud scenes missing)`
      );
    }
  }
  /**
   * Convert cached data to a GoveeDevice (runtime fields set to defaults)
   *
   * @param cached Cached device data
   */
  cachedToGoveeDevice(cached) {
    return {
      sku: cached.sku,
      deviceId: cached.deviceId,
      name: cached.name,
      type: cached.type,
      capabilities: cached.capabilities,
      scenes: cached.scenes,
      diyScenes: cached.diyScenes,
      snapshots: cached.snapshots,
      sceneLibrary: cached.sceneLibrary,
      musicLibrary: cached.musicLibrary,
      diyLibrary: cached.diyLibrary,
      skuFeatures: cached.skuFeatures,
      snapshotBleCmds: cached.snapshotBleCmds,
      scenesChecked: cached.scenesChecked,
      lastSeenOnNetwork: cached.lastSeenOnNetwork,
      state: { online: false },
      channels: { lan: false, mqtt: false, cloud: false }
    };
  }
  /**
   * Extract cacheable data from a GoveeDevice
   *
   * @param device Runtime device
   */
  goveeDeviceToCached(device) {
    return {
      sku: device.sku,
      deviceId: device.deviceId,
      name: device.name,
      type: device.type,
      capabilities: device.capabilities,
      scenes: device.scenes,
      diyScenes: device.diyScenes,
      snapshots: device.snapshots,
      sceneLibrary: device.sceneLibrary,
      musicLibrary: device.musicLibrary,
      diyLibrary: device.diyLibrary,
      skuFeatures: device.skuFeatures,
      snapshotBleCmds: device.snapshotBleCmds,
      scenesChecked: device.scenesChecked,
      lastSeenOnNetwork: device.lastSeenOnNetwork,
      cachedAt: Date.now()
    };
  }
  /**
   * Generate diagnostics data for a device — structured JSON for GitHub issue submission.
   *
   * @param device Target device
   * @param adapterVersion Adapter version string
   */
  generateDiagnostics(device, adapterVersion) {
    var _a, _b;
    const quirks = (0, import_device_quirks.getDeviceQuirks)(device.sku);
    return {
      adapter: "iobroker.govee-smart",
      version: adapterVersion,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      device: {
        sku: device.sku,
        deviceId: device.deviceId,
        name: device.name,
        type: device.type,
        segmentCount: (_a = device.segmentCount) != null ? _a : null,
        channels: { ...device.channels },
        lanIp: (_b = device.lanIp) != null ? _b : null
      },
      capabilities: device.capabilities,
      scenes: {
        count: device.scenes.length,
        names: device.scenes.map((s) => s.name)
      },
      diyScenes: {
        count: device.diyScenes.length,
        names: device.diyScenes.map((s) => s.name)
      },
      snapshots: {
        count: device.snapshots.length,
        names: device.snapshots.map((s) => s.name)
      },
      sceneLibrary: {
        count: device.sceneLibrary.length,
        entries: device.sceneLibrary.map((s) => {
          var _a2, _b2;
          return {
            name: s.name,
            sceneCode: s.sceneCode,
            hasParam: !!s.scenceParam,
            speedSupported: (_b2 = (_a2 = s.speedInfo) == null ? void 0 : _a2.supSpeed) != null ? _b2 : false
          };
        })
      },
      musicLibrary: {
        count: device.musicLibrary.length,
        entries: device.musicLibrary.map((m) => {
          var _a2;
          return {
            name: m.name,
            musicCode: m.musicCode,
            mode: (_a2 = m.mode) != null ? _a2 : null
          };
        })
      },
      diyLibrary: {
        count: device.diyLibrary.length,
        entries: device.diyLibrary.map((d) => ({
          name: d.name,
          diyCode: d.diyCode
        }))
      },
      quirks: quirks != null ? quirks : null,
      skuFeatures: device.skuFeatures,
      state: { ...device.state }
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceManager,
  getEffectiveSegmentIndices,
  parseMqttSegmentData
});
//# sourceMappingURL=device-manager.js.map
