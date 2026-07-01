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
var command_router_exports = {};
__export(command_router_exports, {
  CommandRouter: () => CommandRouter
});
module.exports = __toCommonJS(command_router_exports);
var import_types = require("./types");
var import_govee_lan_client = require("./govee-lan-client");
var import_device_registry = require("./device-registry");
var import_govee_constants = require("./govee-constants");
var import_lookups = require("./device-manager/lookups");
var import_timing_constants = require("./timing-constants");
class CommandRouter {
  log;
  timers;
  lanClient = null;
  cloudClient = null;
  rateLimiter = null;
  /**
   * Per-category dedup tracker. Replaces the older split between
   * `lastCloudFallbackError` and `lastNoChannelCategory` — one map, one
   * lookup, keyed by a short category string (`cloud-fallback`,
   * `no-channel`, `override-missing-cloud`).
   */
  lastErrorByCategory = /* @__PURE__ */ new Map();
  /** Callback for batch segment state sync */
  onSegmentBatchUpdate;
  /**
   * Optional diag-log hook fired once per `sendCommand` call so the per-device
   * diag ring buffer carries the channel-routing decision ("LAN took it",
   * "Cloud fallback", "no channel available"). Without this, the diag JSON
   * couldn't show why a user's state-write didn't reach the device.
   */
  onDiagLog;
  /**
   * @param log ioBroker logger
   * @param timers Adapter timer wrapper — routed through `this.setTimeout` so
   *   pending color-mode delays get cleared on onUnload.
   */
  constructor(log, timers) {
    this.log = log;
    this.timers = timers;
  }
  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client) {
    this.lanClient = client;
  }
  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client) {
    this.cloudClient = client;
  }
  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter) {
    this.rateLimiter = limiter;
  }
  /**
   * Execute a function through the rate limiter if available, or directly.
   *
   * @param fn Async function to execute
   * @param priority Queue priority (0 = highest)
   */
  async executeRateLimited(fn, priority = 0) {
    if (this.rateLimiter) {
      await this.rateLimiter.tryExecute(fn, priority);
    } else {
      await fn();
    }
  }
  /**
   * Force the device into static-color mode before sending segment_color_setting
   * ptReal packets. Without this, the device silently ignores segment-level
   * overrides while it's in Scene/Gradient/Music mode — the classic "I set
   * segment 5 red and nothing happened" symptom. Sends a `colorwc` command with
   * the device's last-known colorRgb (so the strip doesn't visibly change if it
   * was already in color mode), then waits 150 ms so the firmware can switch.
   *
   * As a bonus: once the device is in color mode, subsequent segment commands
   * trigger AA A5 MQTT pushes — so the adapter learns the real segmentCount
   * automatically the first time the user touches segment controls.
   *
   * @param device Target device
   */
  async forceColorMode(device) {
    if (!device.lanIp || !this.lanClient) {
      return;
    }
    const current = typeof device.state.colorRgb === "string" ? device.state.colorRgb : null;
    const { r, g, b } = current ? (0, import_types.hexToRgb)(current) : { r: 255, g: 255, b: 255 };
    this.lanClient.setColor(device.lanIp, r, g, b);
    await this.timers.delay(import_timing_constants.FORCE_COLOR_MODE_SETTLE_MS);
  }
  /**
   * Look up the quirk-driven transport override for a (device, command) pair.
   * Segment-suffix commands (segmentColor:N / segmentBrightness:N) inherit
   * the segmentBatch override — devices.json carries one key for all segment
   * ops, not one per index.
   *
   * @param device Target device
   * @param command Command type
   */
  lookupOverride(device, command) {
    var _a;
    const overrides = (_a = (0, import_device_registry.getDeviceQuirks)(device.sku)) == null ? void 0 : _a.transportOverrides;
    if (!overrides) {
      return void 0;
    }
    if (command in overrides) {
      return overrides[command];
    }
    if (command.startsWith("segmentColor:") || command.startsWith("segmentBrightness:")) {
      return overrides.segmentBatch;
    }
    return void 0;
  }
  /**
   * Catch for unkatalogisierte no-segment SKUs: when a lightScene activation
   * with scenceParam data hits a device that doesn't have any segments, the
   * A3-framed multi-packet ptReal protocol gets silently dropped by the
   * firmware. Cloud activation is the safer default. SKUs known to need
   * this go into devices.json `transportOverrides.lightScene = "cloud"` —
   * the heuristic only fires for SKUs not (yet) in the catalog.
   *
   * @param device Target device
   * @param command Command type
   */
  shouldHeuristicallyUseCloud(device, command) {
    if (command !== "lightScene") {
      return false;
    }
    const hasSegments = typeof device.segmentCount === "number" && device.segmentCount > 0;
    return !hasSegments;
  }
  /**
   * Single point of truth for channel routing. Quirk-driven `transportOverrides`
   * take precedence over the LAN-first default. Returns a `TransportDecision`
   * carrying both the chosen kind and a reason — caller emits the reason
   * into the diag log so a cloud-override and a cloud-fallback aren't
   * confused in user-submitted JSON.
   *
   * @param device Target device
   * @param command Command type
   */
  resolveTransport(device, command) {
    const overrideTarget = this.lookupOverride(device, command);
    if (overrideTarget === "cloud") {
      if (device.channels.cloud && this.cloudClient) {
        return { kind: "cloud", reason: "override" };
      }
      return { kind: "skip", reason: "override-cloud-missing" };
    }
    if (device.lanIp && this.lanClient) {
      if (this.shouldHeuristicallyUseCloud(device, command)) {
        return device.channels.cloud && this.cloudClient ? { kind: "cloud", reason: "no-segments-heuristic" } : { kind: "skip", reason: "no-channel" };
      }
      return { kind: "lan", reason: "default" };
    }
    if (device.channels.cloud && this.cloudClient) {
      if (device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && !device.lanIp) {
        return { kind: "cloud", reason: "light-no-lan-fallback" };
      }
      return { kind: "cloud", reason: "no-lan" };
    }
    return { kind: "skip", reason: "no-channel" };
  }
  /**
   * Format a decision into a human-readable channel marker for the diag
   * log. One line per `sendCommand` so user-submitted JSON shows what the
   * router decided, not what it was nominally configured for.
   *
   * @param decision Output of resolveTransport
   */
  decisionToChannelMarker(decision) {
    switch (decision.kind) {
      case "lan":
        return "LAN";
      case "cloud":
        if (decision.reason === "light-no-lan-fallback") {
          return "Cloud (no LAN, fallback)";
        }
        return decision.reason === "override" ? "Cloud (override)" : decision.reason === "no-segments-heuristic" ? "Cloud (no-segments)" : "Cloud";
      case "skip":
        return decision.reason === "override-cloud-missing" ? "skip (cloud-override, no cloud)" : "skip (no-channel)";
    }
  }
  /**
   * Skip-handler — emits the right log level depending on why we couldn't
   * route. Override+no-cloud is a configurable mismatch (user's fault, but
   * we tell them once); regular no-channel during init-race is debug.
   *
   * @param device Target device
   * @param command Command type
   * @param reason Skip reason from resolveTransport
   */
  handleSkip(device, command, reason) {
    var _a;
    if (reason === "override-cloud-missing") {
      const prev = (_a = this.lastErrorByCategory.get("override-missing-cloud")) != null ? _a : null;
      this.lastErrorByCategory.set(
        "override-missing-cloud",
        (0, import_types.logDedup)(
          this.log,
          prev,
          `Cloud transport override for ${device.name}/${command} but no Cloud channel available`,
          new Error("override-cloud-missing")
        )
      );
      return;
    }
    if (device.channels.cloud && !this.cloudClient) {
      this.log.debug(`Command for ${device.name} dropped: Cloud client not ready yet`);
      return;
    }
    this.log.warn(`No channel available for ${device.name} (${device.sku})`);
  }
  /**
   * Send a command to a device. Routing is decided up-front by
   * `resolveTransport`; segment-special-cases (segmentColor:N / segmentBatch /
   * segmentBrightness:N) have their own Cloud-side handlers because cloud
   * routing for batch segment ops goes through `sendSegmentBatchParsed`,
   * not `sendCloudCommand`.
   *
   * MQTT is status-push only and never used for commands.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCommand(device, command, value) {
    var _a;
    const decision = this.resolveTransport(device, command);
    const summary = `${command}=${JSON.stringify(value)}`;
    (_a = this.onDiagLog) == null ? void 0 : _a.call(this, device.deviceId, "debug", `sendCommand ${summary} \u2192 ${this.decisionToChannelMarker(decision)}`);
    if (decision.kind === "skip") {
      this.handleSkip(device, command, decision.reason);
      return;
    }
    if (command.startsWith("segmentColor:")) {
      await this.dispatchSegmentColor(device, command, value, decision);
      return;
    }
    if (command === "segmentBatch") {
      await this.dispatchSegmentBatch(device, value, decision);
      return;
    }
    if (command.startsWith("segmentBrightness:")) {
      await this.dispatchSegmentBrightness(device, command, value, decision);
      return;
    }
    if (decision.kind === "lan") {
      this.sendLanCommand(device, command, value);
      return;
    }
    await this.sendCloudCommand(device, command, value);
  }
  /**
   * Segment-color dispatcher honouring the resolved transport decision.
   *
   * @param device Target device
   * @param command Command type (segmentColor:N form)
   * @param value Color value (hex string)
   * @param decision Routing decision from resolveTransport
   */
  async dispatchSegmentColor(device, command, value, decision) {
    const segIdx = parseInt(command.split(":")[1], 10);
    if (isNaN(segIdx) || segIdx < 0) {
      return;
    }
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      const { r, g, b } = (0, import_types.hexToRgb)(value);
      this.lanClient.setSegmentColor(device.lanIp, r, g, b, [segIdx]);
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendCloudCommand(device, command, value);
    }
  }
  /**
   * Segment-batch dispatcher. LAN path issues one multi-segment ptReal
   * burst; Cloud path goes through `sendSegmentBatchParsed` which resolves
   * segment_color_setting + segment-brightness capabilities separately.
   *
   * @param device Target device
   * @param value Either a batch-syntax string or a pre-parsed object
   * @param decision Routing decision from resolveTransport
   */
  async dispatchSegmentBatch(device, value, decision) {
    var _a;
    const parsed = typeof value === "string" ? this.parseSegmentBatch(device, value) : this.coerceParsedBatch(value);
    if (!parsed) {
      if (typeof value === "string") {
        this.log.warn(
          `${device.name} (${device.sku}): could not parse segment command "${value}" \u2014 expected e.g. "1-5:#ff0000:80", "all:#00ff00" or "0,3,7::50"`
        );
      }
      return;
    }
    (_a = this.onSegmentBatchUpdate) == null ? void 0 : _a.call(this, device, parsed);
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      if (parsed.color !== void 0) {
        const r = parsed.color >> 16 & 255;
        const g = parsed.color >> 8 & 255;
        const b = parsed.color & 255;
        this.lanClient.setSegmentColor(device.lanIp, r, g, b, parsed.segments);
      }
      if (parsed.brightness !== void 0) {
        this.lanClient.setSegmentBrightness(device.lanIp, parsed.brightness, parsed.segments);
      }
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendSegmentBatchParsed(device, typeof value === "string" ? value : "", parsed);
    }
  }
  /**
   * Segment-brightness dispatcher honouring the resolved transport decision.
   *
   * @param device Target device
   * @param command Command type (segmentBrightness:N form)
   * @param value Brightness value (0-100)
   * @param decision Routing decision from resolveTransport
   */
  async dispatchSegmentBrightness(device, command, value, decision) {
    const segIdx = parseInt(command.split(":")[1], 10);
    if (isNaN(segIdx) || segIdx < 0) {
      return;
    }
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      this.lanClient.setSegmentBrightness(device.lanIp, value, [segIdx]);
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendCloudCommand(device, command, value);
    }
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
    if (!this.cloudClient || !device.channels.cloud) {
      this.log.debug(`Cloud not available for generic command on ${device.name}`);
      return;
    }
    const shortType = capabilityType.replace("devices.capabilities.", "");
    let cloudValue = value;
    if (shortType === "toggle") {
      cloudValue = value ? 1 : 0;
    }
    const execute = async () => {
      await this.cloudClient.controlDevice(
        device.sku,
        device.deviceId,
        capabilityType,
        capabilityInstance,
        cloudValue
      );
    };
    await this.executeRateLimited(execute);
  }
  /**
   * Send a batch segment command with pre-parsed data.
   *
   * @param device Target device
   * @param commandStr Original command string (for error messages)
   * @param parsed Pre-parsed batch data (null = invalid command)
   */
  async sendSegmentBatchParsed(device, commandStr, parsed) {
    if (!this.cloudClient) {
      return;
    }
    if (!parsed) {
      this.log.warn(`Invalid segment command "${commandStr}" for ${device.name}`);
      return;
    }
    const cap = this.findCapabilityForCommand(device, "segmentColor:0");
    if (!cap) {
      this.log.debug(`No segment capability for ${device.name}`);
      return;
    }
    if (parsed.color !== void 0) {
      const execute = async () => {
        await this.cloudClient.controlDevice(device.sku, device.deviceId, cap.type, cap.instance, {
          segment: parsed.segments,
          rgb: parsed.color
        });
      };
      await this.executeRateLimited(execute);
    }
    if (parsed.brightness !== void 0) {
      const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
      const brightCap = caps.find(
        (c) => c && typeof c.type === "string" && typeof c.instance === "string" && c.type.includes("segment_color_setting") && c.instance.toLowerCase().includes("brightness")
      );
      const execute = async () => {
        await this.cloudClient.controlDevice(
          device.sku,
          device.deviceId,
          (brightCap != null ? brightCap : cap).type,
          (brightCap != null ? brightCap : cap).instance,
          { segment: parsed.segments, brightness: parsed.brightness }
        );
      };
      await this.executeRateLimited(execute);
    }
  }
  /**
   * Parse batch segment command string.
   *
   * @param device Target device (for segment count)
   * @param cmd Command string (e.g. "1-5:#ff0000:20")
   */
  parseSegmentBatch(device, cmd) {
    var _a;
    if (typeof cmd !== "string") {
      return null;
    }
    const parts = cmd.split(":");
    if (parts.length < 1 || !parts[0]) {
      return null;
    }
    const validIndices = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? new Set(device.manualSegments) : null;
    const segCount = (_a = device.segmentCount) != null ? _a : 0;
    const isValid = (i) => validIndices ? validIndices.has(i) : i >= 0 && i < segCount;
    const segStr = parts[0].trim();
    let segments;
    if (segStr === "all") {
      segments = validIndices ? Array.from(validIndices).sort((a, b) => a - b) : Array.from({ length: segCount }, (_, i) => i);
    } else {
      segments = [];
      for (const part of segStr.split(",")) {
        const rangeMatch = /^(\d+)-(\d+)$/.exec(part.trim());
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = Math.min(parseInt(rangeMatch[2], 10), import_lookups.SEGMENT_HARD_MAX);
          for (let i = start; i <= end; i++) {
            if (isValid(i)) {
              segments.push(i);
            }
          }
        } else {
          const idx = parseInt(part.trim(), 10);
          if (!isNaN(idx) && isValid(idx)) {
            segments.push(idx);
          }
        }
      }
    }
    if (segments.length === 0) {
      return null;
    }
    let color;
    if (parts.length >= 2 && parts[1]) {
      const colorStr = parts[1].trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(colorStr)) {
        color = parseInt(colorStr.replace("#", ""), 16);
      }
    }
    let brightness;
    if (parts.length >= 3 && parts[2]) {
      const bri = parseInt(parts[2].trim(), 10);
      if (!isNaN(bri) && bri >= 0 && bri <= 100) {
        brightness = bri;
      }
    }
    if (color === void 0 && brightness === void 0) {
      return null;
    }
    return { segments, color, brightness };
  }
  /**
   * Coerce a pre-parsed batch object (from internal callers) to the canonical
   * shape. Returns null if the input is not a valid {segments, ...} object.
   *
   * @param value Candidate object
   */
  coerceParsedBatch(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const v = value;
    if (!Array.isArray(v.segments) || v.segments.length === 0) {
      return null;
    }
    const segments = v.segments.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (segments.length === 0) {
      return null;
    }
    const color = typeof v.color === "number" && Number.isFinite(v.color) ? v.color & 16777215 : void 0;
    const brightness = typeof v.brightness === "number" && Number.isFinite(v.brightness) ? Math.max(0, Math.min(100, Math.round(v.brightness))) : void 0;
    if (color === void 0 && brightness === void 0) {
      return null;
    }
    return { segments, color, brightness };
  }
  /**
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  toCloudValue(device, command, value) {
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = (0, import_types.hexToRgb)(value);
        return r << 16 | g << 8 | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      case "gradientToggle":
        return value ? 1 : 0;
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return value;
        }
        return device.scenes[idx - 1].value;
      }
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.diyScenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return value;
        }
        return device.diyScenes[idx - 1].value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(`${device.sku}: invalid snapshot index ${String(value)}`);
          return value;
        }
        return device.snapshots[idx - 1].value;
      }
      default:
        if (command.startsWith("segmentColor:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          const { r, g, b } = (0, import_types.hexToRgb)(value);
          return { segment: [segIdx], rgb: r << 16 | g << 8 | b };
        }
        if (command.startsWith("segmentBrightness:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          return { segment: [segIdx], brightness: value };
        }
        return value;
    }
  }
  /**
   * Find capability matching a command name
   *
   * @param device Target device
   * @param command Command type to find capability for
   */
  findCapabilityForCommand(device, command) {
    const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
    for (const cap of caps) {
      if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
        continue;
      }
      const shortType = cap.type.replace("devices.capabilities.", "");
      if (command === "power" && shortType === "on_off") {
        return cap;
      }
      if (command === "brightness" && shortType === "range" && cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
      if (command === "colorRgb" && shortType === "color_setting" && cap.instance === "colorRgb") {
        return cap;
      }
      if (command === "colorTemperature" && shortType === "color_setting" && cap.instance.includes("colorTem")) {
        return cap;
      }
      if (command === "scene" && shortType === "mode" && cap.instance === "presetScene") {
        return cap;
      }
      if (command === "lightScene" && shortType === "dynamic_scene" && cap.instance === "lightScene") {
        return cap;
      }
      if (command === "diyScene" && shortType === "dynamic_scene" && cap.instance === "diyScene") {
        return cap;
      }
      if (command === "snapshot" && shortType === "dynamic_scene" && cap.instance === "snapshot") {
        return cap;
      }
      if (command === "gradientToggle" && shortType === "toggle" && cap.instance === "gradientToggle") {
        return cap;
      }
      if (command.startsWith("segmentColor:") && shortType === "segment_color_setting" && !cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
      if (command.startsWith("segmentBrightness:") && shortType === "segment_color_setting" && cap.instance.toLowerCase().includes("brightness")) {
        return cap;
      }
    }
    return void 0;
  }
  /**
   * Send command via LAN UDP
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  sendLanCommand(device, command, value) {
    var _a, _b, _c, _d, _e;
    if (!device.lanIp || !this.lanClient) {
      return;
    }
    switch (command) {
      case "power":
        this.lanClient.setPower(device.lanIp, value);
        break;
      case "brightness":
        this.lanClient.setBrightness(device.lanIp, value);
        break;
      case "colorRgb": {
        const { r, g, b } = (0, import_types.hexToRgb)(value);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value);
        break;
      case "gradientToggle":
        this.lanClient.setGradient(device.lanIp, value);
        break;
      case "diyScene": {
        const diyIdx = parseInt(String(value), 10);
        if (isNaN(diyIdx) || diyIdx < 1 || diyIdx > device.diyScenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return;
        }
        const diyScene = device.diyScenes[diyIdx - 1];
        if (diyScene) {
          const diyLib = device.diyLibrary.find((d) => d.name === diyScene.name);
          if (diyLib) {
            this.log.debug(`ptReal DIY: ${diyScene.name} \u2192 code=${diyLib.diyCode}`);
            this.lanClient.setDiyScene(device.lanIp, (_a = diyLib.scenceParam) != null ? _a : "");
            return;
          }
        }
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      case "lightScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return;
        }
        const scene = device.scenes[idx - 1];
        if (scene) {
          const baseName = scene.name.replace(/-[A-Z]$/, "");
          const libEntry = (_b = device.sceneLibrary.find((s) => s.name === scene.name)) != null ? _b : device.sceneLibrary.find((s) => s.name === baseName);
          if (libEntry) {
            const baseParam = (_c = libEntry.scenceParam) != null ? _c : "";
            let param = baseParam;
            if (device.sceneSpeed !== void 0 && device.sceneSpeed > 0 && ((_d = libEntry.speedInfo) == null ? void 0 : _d.supSpeed) && libEntry.speedInfo.config) {
              param = (0, import_govee_lan_client.applySceneSpeed)(param, device.sceneSpeed, libEntry.speedInfo.config);
            }
            this.log.debug(`ptReal: ${scene.name} \u2192 code=${libEntry.sceneCode}`);
            this.lanClient.setScene(device.lanIp, libEntry.sceneCode, param);
            return;
          }
        }
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(`${device.sku}: invalid snapshot index ${String(value)}`);
          return;
        }
        const cmdGroups = (_e = device.snapshotBleCmds) == null ? void 0 : _e[idx - 1];
        if (cmdGroups && cmdGroups.length > 0) {
          const allPackets = cmdGroups.flat();
          if (allPackets.length > 0) {
            this.log.debug(`ptReal Snapshot: ${device.snapshots[idx - 1].name} \u2192 ${allPackets.length} packets`);
            this.lanClient.sendPtReal(device.lanIp, allPackets);
            return;
          }
        }
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      default:
        this.cloudFallbackForCase(device, command, value);
    }
  }
  /**
   * Fire-and-forget Cloud fallback when a LAN-case can't service the
   * command locally (library miss, no BLE data, unsupported). Dedup
   * through the shared category map so log spam is bounded.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  cloudFallbackForCase(device, command, value) {
    this.sendCloudCommand(device, command, value).catch((e) => {
      var _a;
      const prev = (_a = this.lastErrorByCategory.get("cloud-fallback")) != null ? _a : null;
      this.lastErrorByCategory.set(
        "cloud-fallback",
        (0, import_types.logDedup)(this.log, prev, `Cloud fallback for ${device.name}/${command}`, e)
      );
    });
  }
  /**
   * Send command via Cloud API (rate-limited)
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCloudCommand(device, command, value) {
    var _a;
    const cloudClient = this.cloudClient;
    if (!cloudClient) {
      return;
    }
    const cap = this.findCapabilityForCommand(device, command);
    if (!cap) {
      const prev = (_a = this.lastErrorByCategory.get("no-capability")) != null ? _a : null;
      this.lastErrorByCategory.set(
        "no-capability",
        (0, import_types.logDedup)(this.log, prev, `No channel for ${device.name}/${command}`, new Error("no matching capability"))
      );
      return;
    }
    const cloudValue = this.toCloudValue(device, command, value);
    const execute = async () => {
      await cloudClient.controlDevice(device.sku, device.deviceId, cap.type, cap.instance, cloudValue);
    };
    await this.executeRateLimited(execute);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandRouter
});
//# sourceMappingURL=command-router.js.map
