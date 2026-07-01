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
var govee_lan_client_exports = {};
__export(govee_lan_client_exports, {
  GoveeLanClient: () => GoveeLanClient,
  applySceneSpeed: () => applySceneSpeed,
  buildDiyPackets: () => buildDiyPackets,
  buildGradientPacket: () => buildGradientPacket,
  buildMusicModePacket: () => buildMusicModePacket,
  buildScenePackets: () => buildScenePackets,
  buildSegmentBitmask: () => buildSegmentBitmask,
  buildSegmentBrightnessPacket: () => buildSegmentBrightnessPacket,
  buildSegmentColorPacket: () => buildSegmentColorPacket
});
module.exports = __toCommonJS(govee_lan_client_exports);
var dgram = __toESM(require("node:dgram"));
var import_types = require("./types");
var import_timing_constants = require("./timing-constants");
var import_lookups = require("./device-manager/lookups");
const MULTICAST_ADDR = "239.255.255.250";
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const COMMAND_PORT = 4003;
const MAX_DISTINCT_LAN_DEVICES = 512;
class GoveeLanClient {
  scanSocket = null;
  listenSocket = null;
  /**
   * Persistent send-socket — previously a new dgram socket was created, used to
   * send, and closed per command. On adapter stop mid-send the callback could
   * fire into a half-torn-down adapter.
   */
  sendSocket = null;
  scanTimer = void 0;
  /**
   * True after `stop()` was called — bind-callbacks check this flag before
   * starting timers/scans, so a `stop()` during the async listen+scan bind
   * sequence cannot leave a runaway scanTimer behind.
   */
  stopped = false;
  /**
   * Pending one-shot timeouts created by {@link flashSingleSegment} — kept
   * so {@link stop} can cancel them before the deferred ptReal burst fires
   * into a torn-down LAN client.
   */
  pendingFlashTimers = /* @__PURE__ */ new Set();
  timers;
  log;
  onDiscovery = null;
  onStatus = null;
  onSend = null;
  onStatusRecord = null;
  onScanRecord = null;
  seenDeviceIps = /* @__PURE__ */ new Set();
  /** Warn-once latch when the LAN discovery cap is hit (SEC-H2). */
  lanFloodWarned = false;
  /**
   * Per-IP timestamp of the last command we sent (ptReal/setScene/etc).
   * Used to annotate incoming LAN-status responses with the Δt — gives an
   * approximate "did this status follow a command of ours?" signal in the
   * debug log. Proximity, not proof: Govee's UDP protocol doesn't carry
   * command IDs, so a small Δ is *probably* a response but could be
   * unrelated polling.
   */
  lastCommandSentMs = /* @__PURE__ */ new Map();
  /** Multicast membership address — remembered for dropMembership in stop(). */
  multicastBind;
  /**
   * @param log ioBroker logger
   * @param timers Timer adapter for setInterval/setTimeout
   */
  constructor(log, timers) {
    this.log = log;
    this.timers = timers;
  }
  /**
   * Register a send hook called for every outgoing UDP datagram. main.ts
   * resolves the destination IP to a deviceId and forwards into the
   * DiagnosticsCollector — closes the v2.9.0 diag blind spot where ptReal
   * sends were only visible in the adapter log, not in per-device diag.
   *
   * @param cb Callback receiving (ip, cmd, payload, bytes, error?)
   */
  setSendHook(cb) {
    this.onSend = cb;
  }
  /**
   * Register a hook called for every parsed devStatus reply. Used for diag
   * capture — adapter looks up the device by IP and records the payload as
   * a pseudo-endpoint (`lan://devStatus`).
   *
   * @param cb Callback receiving (sourceIp, status)
   */
  setStatusRecordHook(cb) {
    this.onStatusRecord = cb;
  }
  /**
   * Register a hook called for every parsed scan reply. Diag-only.
   *
   * @param cb Callback receiving (lanDevice)
   */
  setScanRecordHook(cb) {
    this.onScanRecord = cb;
  }
  /**
   * Start LAN discovery and listening for responses.
   *
   * @param onDiscovery Called when a new device is found
   * @param onStatus Called when a status response arrives
   * @param scanIntervalMs How often to send multicast scan (default 30s)
   * @param networkInterface IP of network interface to bind to (empty = all)
   */
  start(onDiscovery, onStatus, scanIntervalMs = 3e4, networkInterface = "") {
    this.onDiscovery = onDiscovery;
    this.onStatus = onStatus;
    const bindAddr = networkInterface && networkInterface !== "0.0.0.0" ? networkInterface : void 0;
    if (bindAddr) {
      this.log.info(`LAN binding to network interface ${bindAddr}`);
    }
    this.multicastBind = bindAddr;
    this.sendSocket = dgram.createSocket("udp4");
    this.sendSocket.on("error", (err) => {
      this.log.debug(`LAN send socket error: ${err.message}`);
    });
    if (bindAddr) {
      this.sendSocket.bind(0, bindAddr);
    }
    this.listenSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.listenSocket.on("message", (msg, rinfo) => {
      this.handleMessage(msg, rinfo.address);
    });
    this.listenSocket.on("error", (err) => {
      const code = err.code;
      if (code === "EADDRINUSE") {
        this.log.warn(`LAN listen port ${LISTEN_PORT} already in use \u2014 second instance? Status updates will be lost.`);
      } else {
        this.log.debug(`LAN listen socket error: ${err.message}`);
      }
    });
    this.listenSocket.bind(LISTEN_PORT, bindAddr, () => {
      if (this.stopped) {
        return;
      }
      this.log.debug(`LAN listening on port ${LISTEN_PORT}`);
      this.scanSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.scanSocket.on("error", (err) => {
        this.log.debug(`LAN scan socket error: ${err.message}`);
      });
      this.scanSocket.bind(0, bindAddr, () => {
        var _a, _b, _c;
        if (this.stopped) {
          return;
        }
        (_a = this.scanSocket) == null ? void 0 : _a.setBroadcast(true);
        try {
          (_b = this.scanSocket) == null ? void 0 : _b.addMembership(MULTICAST_ADDR, bindAddr);
        } catch {
          this.log.info(
            `LAN: could not join multicast group on ${bindAddr != null ? bindAddr : "default interface"} \u2014 discovery may be incomplete`
          );
        }
        if (bindAddr) {
          try {
            (_c = this.scanSocket) == null ? void 0 : _c.setMulticastInterface(bindAddr);
          } catch {
            this.log.info(
              `LAN: could not pin multicast egress to ${bindAddr} \u2014 outgoing discovery may use the default interface`
            );
          }
        }
        this.sendScan();
      });
      if (!this.stopped) {
        this.scanTimer = this.timers.setInterval(() => {
          this.sendScan();
        }, scanIntervalMs);
      }
    });
  }
  /**
   * Snapshot of the discovery cache + last-command-sent timestamps for
   * the runtime-state diag export. Returns plain serialisable shapes so
   * the DiagnosticsCollector can clone-and-cap them safely.
   */
  getDiagSnapshot() {
    return {
      seenDeviceIps: Array.from(this.seenDeviceIps),
      lastCommandSentMs: Object.fromEntries(this.lastCommandSentMs)
    };
  }
  /** Stop all sockets and timers */
  stop() {
    this.stopped = true;
    if (this.scanTimer) {
      this.timers.clearInterval(this.scanTimer);
      this.scanTimer = void 0;
    }
    for (const handle of this.pendingFlashTimers) {
      this.timers.clearTimeout(handle);
    }
    this.pendingFlashTimers.clear();
    if (this.scanSocket) {
      try {
        if (this.multicastBind) {
          this.scanSocket.dropMembership(MULTICAST_ADDR, this.multicastBind);
        }
      } catch {
      }
      try {
        this.scanSocket.close();
      } catch {
      }
      this.scanSocket = null;
    }
    if (this.listenSocket) {
      try {
        this.listenSocket.close();
      } catch {
      }
      this.listenSocket = null;
    }
    if (this.sendSocket) {
      try {
        this.sendSocket.close();
      } catch {
      }
      this.sendSocket = null;
    }
    this.seenDeviceIps.clear();
    this.multicastBind = void 0;
  }
  /**
   * Send a control command to a device via LAN.
   *
   * @param ip Device IP address
   * @param cmd Command name (turn, brightness, colorwc, devStatus)
   * @param data Command data
   */
  sendCommand(ip, cmd, data) {
    var _a;
    if (!this.sendSocket) {
      this.log.debug(`LAN send dropped (socket not ready): ${cmd} \u2192 ${ip}`);
      (_a = this.onSend) == null ? void 0 : _a.call(this, ip, cmd, data, 0, "socket not ready");
      return;
    }
    const message = {
      msg: { cmd, data }
    };
    const buf = Buffer.from(JSON.stringify(message));
    if (buf.length > 1400) {
      this.log.debug(`LAN payload large (${buf.length} bytes) \u2014 may be PMTU-fragmented for ${ip}`);
    }
    this.sendSocket.send(buf, 0, buf.length, COMMAND_PORT, ip, (err) => {
      var _a2, _b;
      if (err) {
        this.log.debug(`LAN send error to ${ip}: ${err.message}`);
        (_a2 = this.onSend) == null ? void 0 : _a2.call(this, ip, cmd, data, buf.length, err.message);
      } else {
        this.lastCommandSentMs.set(ip, Date.now());
        (_b = this.onSend) == null ? void 0 : _b.call(this, ip, cmd, data, buf.length);
      }
    });
  }
  /**
   * Send power command
   *
   * @param ip Device IP address
   * @param on Power state
   */
  setPower(ip, on) {
    this.sendCommand(ip, "turn", { value: on ? 1 : 0 });
  }
  /**
   * Send brightness command
   *
   * @param ip Device IP address
   * @param brightness Brightness 0-100
   */
  setBrightness(ip, brightness) {
    this.sendCommand(ip, "brightness", {
      value: clampByte0_100(brightness)
    });
  }
  /**
   * Send color command. Inputs are clamped to 0-255 — out-of-range values
   * from upstream coercion paths (capability-mapper, command-router) would
   * otherwise be sent verbatim and produce undefined-behaviour at the device.
   *
   * @param ip Device IP address
   * @param r Red channel 0-255
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setColor(ip, r, g, b) {
    this.sendCommand(ip, "colorwc", {
      color: { r: (0, import_types.clampByte)(r), g: (0, import_types.clampByte)(g), b: (0, import_types.clampByte)(b) },
      colorTemInKelvin: 0
    });
  }
  /**
   * Send color temperature command. Out-of-band kelvin values are clamped
   * to Govee's published 2000-9000 K range (per-device range may be tighter,
   * those are corrected via {@link applyColorTempQuirk} upstream).
   *
   * @param ip Device IP address
   * @param kelvin Color temperature in Kelvin
   */
  setColorTemperature(ip, kelvin) {
    const clamped = Number.isFinite(kelvin) ? Math.max(2e3, Math.min(9e3, Math.round(kelvin))) : 2e3;
    this.sendCommand(ip, "colorwc", {
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: clamped
    });
  }
  /**
   * Send a scene via ptReal BLE-passthrough.
   * Builds multi-packet BLE data from scenceParam + final scene-code packet.
   *
   * @param ip Device IP address
   * @param sceneCode Scene code from scene library (must be > 0)
   * @param scenceParam Base64-encoded scene parameter data (may be empty for simple presets)
   */
  setScene(ip, sceneCode, scenceParam) {
    if (sceneCode <= 0) {
      return;
    }
    const packets = buildScenePackets(sceneCode, scenceParam);
    this.sendPtReal(ip, packets);
  }
  /**
   * Send raw ptReal BLE-passthrough packets to a device.
   *
   * @param ip Device IP address
   * @param base64Packets Array of Base64-encoded 20-byte BLE packets
   */
  sendPtReal(ip, base64Packets) {
    var _a;
    if (!this.sendSocket) {
      this.log.debug(`LAN ptReal dropped (socket not ready): ${ip}`);
      (_a = this.onSend) == null ? void 0 : _a.call(this, ip, "ptReal", { command: base64Packets }, 0, "socket not ready");
      return;
    }
    const message = {
      msg: { cmd: "ptReal", data: { command: base64Packets } }
    };
    const buf = Buffer.from(JSON.stringify(message));
    if (buf.length > 1400) {
      this.log.debug(`ptReal payload large (${buf.length} bytes) \u2014 may be PMTU-fragmented for ${ip}`);
    }
    this.sendSocket.send(buf, 0, buf.length, COMMAND_PORT, ip, (err) => {
      var _a2, _b;
      if (err) {
        this.log.warn(`LAN ptReal error to ${ip}: ${err.message}`);
        (_a2 = this.onSend) == null ? void 0 : _a2.call(this, ip, "ptReal", { command: base64Packets }, buf.length, err.message);
      } else {
        this.log.debug(`LAN ptReal sent to ${ip}: ${base64Packets.length} packet(s), ${buf.length} bytes`);
        this.lastCommandSentMs.set(ip, Date.now());
        (_b = this.onSend) == null ? void 0 : _b.call(this, ip, "ptReal", { command: base64Packets }, buf.length);
      }
    });
  }
  /**
   * Set gradient toggle via ptReal BLE-passthrough.
   *
   * @param ip Device IP address
   * @param on Gradient on/off
   */
  setGradient(ip, on) {
    this.sendPtReal(ip, [buildGradientPacket(on)]);
  }
  /**
   * Activate a DIY scene via ptReal BLE-passthrough.
   * Sends A1 multi-packet data (if provided) + activation command.
   *
   * @param ip Device IP address
   * @param scenceParam Base64-encoded DIY parameter data (may be empty to activate last DIY)
   */
  setDiyScene(ip, scenceParam) {
    const packets = buildDiyPackets(scenceParam);
    this.sendPtReal(ip, packets);
  }
  /**
   * Set music mode via ptReal BLE-passthrough. Whether RGB is sent is decided
   * by the caller via the mode NAME (Spectrum/Rolling), not the value.
   *
   * @param ip Device IP address
   * @param subMode Music sub-mode value (raw capability value)
   * @param includeRgb Whether this mode carries a custom RGB colour (Spectrum/Rolling)
   * @param r Red channel 0-255 (used when includeRgb)
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setMusicMode(ip, subMode, includeRgb, r = 0, g = 0, b = 0) {
    this.sendPtReal(ip, [buildMusicModePacket(subMode, includeRgb, r, g, b)]);
  }
  /**
   * Set segment color via ptReal BLE-passthrough (command 33 05 15 01).
   *
   * @param ip Device IP address
   * @param r Red 0-255
   * @param g Green 0-255
   * @param b Blue 0-255
   * @param segments Array of 0-based segment indices
   */
  setSegmentColor(ip, r, g, b, segments) {
    this.sendPtReal(ip, [buildSegmentColorPacket(r, g, b, segments)]);
  }
  /**
   * Set segment brightness via ptReal BLE-passthrough (command 33 05 15 02).
   *
   * @param ip Device IP address
   * @param brightness Brightness 0-100
   * @param segments Array of 0-based segment indices
   */
  setSegmentBrightness(ip, brightness, segments) {
    this.sendPtReal(ip, [buildSegmentBrightnessPacket(brightness, segments)]);
  }
  /**
   * Flash a single segment bright white and dim all other segments, in ONE
   * atomic ptReal transmission. All three required BLE packets are bundled
   * into a single UDP datagram so the device cannot drop intermediate steps.
   *
   * The "dim everything else" packet targets the full bitmask width (56
   * segments — the Govee protocol's upper bound: 7 bytes × 8 bits). This
   * covers under-report cases where the Cloud says "15 segments" but the
   * strip physically has more. Without this the unreported segments keep
   * shining at whatever brightness they had before the wizard started.
   *
   * Packet order:
   *   0. `colorwc` — force static-color mode (segment_color_setting packets
   *      are ignored while the device is in Scene/Gradient/Music mode)
   *   1. All segments except idx (up to idx 55) → brightness 0
   *   2. Target segment → color 0xFFFFFF (full white)
   *   3. Target segment → brightness 100 (make it bright)
   *
   * @param ip Device IP address
   * @param idx Target segment index (0-based) to flash white
   */
  flashSingleSegment(ip, idx) {
    if (idx < 0 || idx >= import_lookups.SEGMENT_COUNT_MAX) {
      return;
    }
    const MAX_SEGMENTS = import_lookups.SEGMENT_COUNT_MAX;
    const others = Array.from({ length: MAX_SEGMENTS }, (_, i) => i).filter((i) => i !== idx);
    this.setColor(ip, 255, 255, 255);
    const delayMs = import_timing_constants.FORCE_COLOR_MODE_SETTLE_MS;
    const handle = this.timers.setTimeout(() => {
      if (handle !== void 0) {
        this.pendingFlashTimers.delete(handle);
      }
      if (this.stopped || !this.sendSocket) {
        return;
      }
      this.sendPtReal(ip, [
        buildSegmentBrightnessPacket(0, others),
        buildSegmentColorPacket(255, 255, 255, [idx]),
        buildSegmentBrightnessPacket(100, [idx])
      ]);
    }, delayMs);
    if (handle !== void 0) {
      this.pendingFlashTimers.add(handle);
    }
  }
  /**
   * Restore a segment strip to a uniform color + brightness in one atomic
   * ptReal transmission. Used at wizard end/abort to put the strip back to
   * the captured baseline.
   *
   * @param ip Device IP address
   * @param total Total number of segments
   * @param r Red 0-255
   * @param g Green 0-255
   * @param b Blue 0-255
   * @param brightness Brightness 0-100
   */
  restoreAllSegments(ip, total, r, g, b, brightness) {
    if (total <= 0) {
      return;
    }
    const all = Array.from({ length: total }, (_, i) => i);
    this.sendPtReal(ip, [buildSegmentColorPacket(r, g, b, all), buildSegmentBrightnessPacket(brightness, all)]);
  }
  /**
   * Request device status
   *
   * @param ip Device IP address
   */
  requestStatus(ip) {
    this.sendCommand(ip, "devStatus", {});
  }
  /** Send multicast scan */
  sendScan() {
    var _a;
    const scanMsg = {
      msg: { cmd: "scan", data: { account_topic: "reserve" } }
    };
    const buf = Buffer.from(JSON.stringify(scanMsg));
    (_a = this.scanSocket) == null ? void 0 : _a.send(buf, 0, buf.length, SCAN_PORT, MULTICAST_ADDR, (err) => {
      if (err) {
        this.log.debug(`LAN scan send error: ${err.message}`);
      }
    });
  }
  /**
   * Parse incoming UDP message
   *
   * @param msg Raw UDP message buffer
   * @param sourceIp Source IP address from UDP rinfo
   */
  handleMessage(msg, sourceIp) {
    var _a;
    if (msg.length > 8192) {
      this.log.debug(`LAN message dropped from ${sourceIp}: oversize ${msg.length} bytes`);
      return;
    }
    try {
      const data = JSON.parse(msg.toString());
      if (!((_a = data.msg) == null ? void 0 : _a.cmd) || typeof data.msg.cmd !== "string") {
        return;
      }
      const cmd = data.msg.cmd;
      const rawPayload = data.msg.data;
      const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload : {};
      if (cmd === "scan") {
        this.handleScanResponse(payload, sourceIp);
      } else if (cmd === "devStatus") {
        this.handleStatusResponse(payload, sourceIp);
      }
    } catch {
      this.log.debug(`LAN: Failed to parse message: ${msg.toString().slice(0, 200)}`);
    }
  }
  /**
   * Handle scan response — new device found. The device's IP is taken from the
   * UDP source address, NOT the attacker-controllable `data.ip` payload field
   * (SEC-M1) — otherwise a spoofed scan reply could redirect a device's
   * outbound commands to an attacker-chosen IP.
   *
   * @param data Parsed scan response payload
   * @param sourceIp Source IP from the UDP rinfo — the authentic device address
   */
  handleScanResponse(data, sourceIp) {
    var _a, _b;
    if (typeof data.ip !== "string" || typeof data.device !== "string" || typeof data.sku !== "string" || !data.ip || !data.device || !data.sku) {
      return;
    }
    if (data.device.length > 64 || data.sku.length > 24) {
      return;
    }
    const lanDevice = {
      // data.ip is validated above as part of a well-formed reply but is NOT
      // trusted for the binding — the authentic address is the UDP source.
      ip: sourceIp,
      device: data.device,
      sku: data.sku
    };
    const key = `${lanDevice.device}:${lanDevice.ip}`;
    if (!this.seenDeviceIps.has(key)) {
      if (this.seenDeviceIps.size >= MAX_DISTINCT_LAN_DEVICES) {
        if (!this.lanFloodWarned) {
          this.lanFloodWarned = true;
          this.log.warn(
            `LAN discovery cap reached (${MAX_DISTINCT_LAN_DEVICES}) \u2014 ignoring further new devices; check for a misbehaving or hostile device on your network`
          );
        }
        return;
      }
      const staleSuffix = `${lanDevice.device}:`;
      for (const existing of this.seenDeviceIps) {
        if (existing.startsWith(staleSuffix) && existing !== key) {
          this.seenDeviceIps.delete(existing);
        }
      }
      this.seenDeviceIps.add(key);
      this.log.debug(`LAN: Found ${lanDevice.sku} (${lanDevice.device}) at ${lanDevice.ip}`);
    }
    (_a = this.onScanRecord) == null ? void 0 : _a.call(this, lanDevice);
    (_b = this.onDiscovery) == null ? void 0 : _b.call(this, lanDevice);
  }
  /**
   * Handle status response — matched to device by source IP.
   * Defensive against malformed/partial payloads — all fields coerced to safe defaults.
   *
   * @param data Parsed status response payload
   * @param sourceIp Source IP address from UDP message
   */
  handleStatusResponse(data, sourceIp) {
    var _a, _b;
    const toNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    const colorRaw = data.color;
    const color = colorRaw && typeof colorRaw === "object" ? {
      r: toNum(colorRaw.r),
      g: toNum(colorRaw.g),
      b: toNum(colorRaw.b)
    } : { r: 0, g: 0, b: 0 };
    const status = {
      onOff: toNum(data.onOff),
      brightness: toNum(data.brightness),
      color,
      colorTemInKelvin: toNum(data.colorTemInKelvin)
    };
    const lastSend = this.lastCommandSentMs.get(sourceIp);
    if (lastSend !== void 0) {
      const dt = Date.now() - lastSend;
      this.log.debug(`LAN status from ${sourceIp}: \u0394 ${dt}ms since last command (proximity, not ack)`);
    }
    (_a = this.onStatusRecord) == null ? void 0 : _a.call(this, sourceIp, status);
    (_b = this.onStatus) == null ? void 0 : _b.call(this, sourceIp, status);
  }
}
function clampByte0_100(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(v)));
}
function xorChecksum(data) {
  let checksum = 0;
  for (const b of data) {
    checksum ^= b;
  }
  return checksum;
}
function finishPacket(data) {
  while (data.length < 19) {
    data.push(0);
  }
  data.push(xorChecksum(data));
  return data;
}
function buildScenePackets(sceneCode, scenceParam) {
  const packets = [];
  if (scenceParam) {
    const paramBytes = Array.from(Buffer.from(scenceParam, "base64"));
    const rawData = [163, 0, 1, 0, 2];
    let numLines = 0;
    let lastLineMarker = 1;
    for (const b of paramBytes) {
      if (rawData.length % 19 === 0) {
        numLines++;
        rawData.push(163);
        lastLineMarker = rawData.length;
        rawData.push(numLines);
      }
      rawData.push(b);
    }
    rawData[lastLineMarker] = 255;
    rawData[3] = numLines + 1;
    for (let i = 0; i < rawData.length; i += 19) {
      const chunk = rawData.slice(i, i + 19);
      const pkt = finishPacket([...chunk]);
      packets.push(Buffer.from(pkt).toString("base64"));
    }
  }
  const lo = sceneCode & 255;
  const hi = sceneCode >> 8 & 255;
  const activatePacket = finishPacket([51, 5, 4, lo, hi]);
  packets.push(Buffer.from(activatePacket).toString("base64"));
  return packets;
}
function buildDiyPackets(scenceParam) {
  const packets = [];
  if (scenceParam) {
    const paramBytes = Array.from(Buffer.from(scenceParam, "base64"));
    const rawData = [161, 2, 0, 0];
    let numLines = 0;
    let lastLineMarker = 2;
    for (const b of paramBytes) {
      if (rawData.length % 19 === 0) {
        numLines++;
        rawData.push(161, 2);
        lastLineMarker = rawData.length;
        rawData.push(numLines);
      }
      rawData.push(b);
    }
    rawData[lastLineMarker] = 255;
    rawData[3] = numLines + 1;
    for (let i = 0; i < rawData.length; i += 19) {
      const chunk = rawData.slice(i, i + 19);
      packets.push(Buffer.from(finishPacket([...chunk])).toString("base64"));
    }
  }
  packets.push(Buffer.from(finishPacket([51, 5, 10])).toString("base64"));
  return packets;
}
function buildGradientPacket(on) {
  return Buffer.from(finishPacket([51, 20, on ? 1 : 0])).toString("base64");
}
function buildMusicModePacket(subMode, includeRgb, r = 0, g = 0, b = 0) {
  const data = [51, 5, 1, subMode & 255];
  if (includeRgb) {
    data.push(r & 255, g & 255, b & 255);
  }
  return Buffer.from(finishPacket(data)).toString("base64");
}
function buildSegmentBitmask(segments, byteCount) {
  const mask = new Array(byteCount).fill(0);
  for (const seg of segments) {
    const byteIdx = Math.floor(seg / 8);
    const bitIdx = seg % 8;
    if (byteIdx < byteCount) {
      mask[byteIdx] |= 1 << bitIdx;
    }
  }
  return mask;
}
function buildSegmentColorPacket(r, g, b, segments) {
  const data = [
    51,
    5,
    21,
    1,
    r & 255,
    g & 255,
    b & 255,
    0,
    0,
    0,
    0,
    0,
    ...buildSegmentBitmask(segments, import_lookups.SEGMENT_COLOR_BITMASK_BYTES)
  ];
  return Buffer.from(finishPacket(data)).toString("base64");
}
function buildSegmentBrightnessPacket(brightness, segments) {
  const data = [
    51,
    5,
    21,
    2,
    Math.max(0, Math.min(100, brightness)),
    ...buildSegmentBitmask(segments, import_lookups.SEGMENT_BRIGHTNESS_BITMASK_BYTES)
  ];
  return Buffer.from(finishPacket(data)).toString("base64");
}
function applySceneSpeed(scenceParam, speedLevel, speedConfig) {
  if (!scenceParam || !speedConfig) {
    return scenceParam;
  }
  let configEntries;
  try {
    configEntries = JSON.parse(speedConfig);
  } catch {
    return scenceParam;
  }
  if (!Array.isArray(configEntries) || configEntries.length === 0) {
    return scenceParam;
  }
  const bytes = Array.from(Buffer.from(scenceParam, "base64"));
  if (bytes.length === 0) {
    return scenceParam;
  }
  const pageCount = bytes[0];
  let offset = 1;
  for (let pageIdx = 0; pageIdx < pageCount && offset < bytes.length; pageIdx++) {
    const pageLen = bytes[offset];
    if (offset + 1 + pageLen > bytes.length) {
      break;
    }
    const cfg = configEntries.find((c) => c.page === pageIdx);
    if ((cfg == null ? void 0 : cfg.moveIn) && speedLevel >= 0 && speedLevel < cfg.moveIn.length) {
      const speedBytePos = offset + 1 + (pageLen - 5);
      if (speedBytePos > offset && speedBytePos < offset + 1 + pageLen) {
        bytes[speedBytePos] = cfg.moveIn[speedLevel];
      }
    }
    offset += 1 + pageLen;
  }
  return Buffer.from(bytes).toString("base64");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeLanClient,
  applySceneSpeed,
  buildDiyPackets,
  buildGradientPacket,
  buildMusicModePacket,
  buildScenePackets,
  buildSegmentBitmask,
  buildSegmentBrightnessPacket,
  buildSegmentColorPacket
});
//# sourceMappingURL=govee-lan-client.js.map
