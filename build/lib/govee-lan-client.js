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
const MULTICAST_ADDR = "239.255.255.250";
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const COMMAND_PORT = 4003;
class GoveeLanClient {
  scanSocket = null;
  listenSocket = null;
  scanTimer = void 0;
  timers;
  log;
  onDiscovery = null;
  onStatus = null;
  seenDeviceIps = /* @__PURE__ */ new Set();
  /**
   * @param log ioBroker logger
   * @param timers Timer adapter for setInterval/setTimeout
   */
  constructor(log, timers) {
    this.log = log;
    this.timers = timers;
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
    this.listenSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.listenSocket.on("message", (msg, rinfo) => {
      this.handleMessage(msg, rinfo.address);
    });
    this.listenSocket.on("error", (err) => {
      this.log.debug(`LAN listen socket error: ${err.message}`);
    });
    this.listenSocket.bind(LISTEN_PORT, bindAddr, () => {
      this.log.debug(`LAN listening on port ${LISTEN_PORT}`);
      this.scanSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.scanSocket.on("error", (err) => {
        this.log.debug(`LAN scan socket error: ${err.message}`);
      });
      this.scanSocket.bind(() => {
        var _a, _b;
        (_a = this.scanSocket) == null ? void 0 : _a.setBroadcast(true);
        try {
          (_b = this.scanSocket) == null ? void 0 : _b.addMembership(MULTICAST_ADDR, bindAddr);
        } catch {
          this.log.debug(
            "Could not join multicast group \u2014 using broadcast fallback"
          );
        }
        this.sendScan();
      });
      this.scanTimer = this.timers.setInterval(() => {
        this.sendScan();
      }, scanIntervalMs);
    });
  }
  /** Stop all sockets and timers */
  stop() {
    if (this.scanTimer) {
      this.timers.clearInterval(this.scanTimer);
      this.scanTimer = void 0;
    }
    if (this.scanSocket) {
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
  }
  /**
   * Send a control command to a device via LAN.
   *
   * @param ip Device IP address
   * @param cmd Command name (turn, brightness, colorwc, devStatus)
   * @param data Command data
   */
  sendCommand(ip, cmd, data) {
    const message = {
      msg: { cmd, data }
    };
    const buf = Buffer.from(JSON.stringify(message));
    const socket = dgram.createSocket("udp4");
    socket.send(buf, 0, buf.length, COMMAND_PORT, ip, (err) => {
      if (err) {
        this.log.debug(`LAN send error to ${ip}: ${err.message}`);
      }
      socket.close();
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
      value: Math.max(0, Math.min(100, brightness))
    });
  }
  /**
   * Send color command
   *
   * @param ip Device IP address
   * @param r Red channel 0-255
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setColor(ip, r, g, b) {
    this.sendCommand(ip, "colorwc", {
      color: { r, g, b },
      colorTemInKelvin: 0
    });
  }
  /**
   * Send color temperature command
   *
   * @param ip Device IP address
   * @param kelvin Color temperature in Kelvin
   */
  setColorTemperature(ip, kelvin) {
    this.sendCommand(ip, "colorwc", {
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: kelvin
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
    const message = {
      msg: { cmd: "ptReal", data: { command: base64Packets } }
    };
    const buf = Buffer.from(JSON.stringify(message));
    const socket = dgram.createSocket("udp4");
    socket.send(buf, 0, buf.length, COMMAND_PORT, ip, (err) => {
      if (err) {
        this.log.debug(`LAN ptReal error to ${ip}: ${err.message}`);
      }
      socket.close();
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
   * Set music mode via ptReal BLE-passthrough.
   * Sub-modes 1 (Spectrum) and 2 (Rolling) use RGB color.
   *
   * @param ip Device IP address
   * @param subMode Music sub-mode (0-3)
   * @param r Red channel 0-255 (used by modes 1, 2)
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setMusicMode(ip, subMode, r = 0, g = 0, b = 0) {
    this.sendPtReal(ip, [buildMusicModePacket(subMode, r, g, b)]);
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
   * Packet order:
   *   1. All other segments → brightness 0 (turn them off visually)
   *   2. Target segment → color 0xFFFFFF (full white)
   *   3. Target segment → brightness 100 (make it bright)
   *
   * @param ip Device IP address
   * @param total Total number of segments on the device
   * @param idx Target segment index (0-based) to flash white
   */
  flashSingleSegment(ip, total, idx) {
    if (total <= 0 || idx < 0 || idx >= total) {
      return;
    }
    const others = Array.from({ length: total }, (_, i) => i).filter(
      (i) => i !== idx
    );
    const packets = [];
    if (others.length > 0) {
      packets.push(buildSegmentBrightnessPacket(0, others));
    }
    packets.push(buildSegmentColorPacket(255, 255, 255, [idx]));
    packets.push(buildSegmentBrightnessPacket(100, [idx]));
    this.sendPtReal(ip, packets);
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
    this.sendPtReal(ip, [
      buildSegmentColorPacket(r, g, b, all),
      buildSegmentBrightnessPacket(brightness, all)
    ]);
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
    (_a = this.scanSocket) == null ? void 0 : _a.send(
      buf,
      0,
      buf.length,
      SCAN_PORT,
      MULTICAST_ADDR,
      (err) => {
        if (err) {
          this.log.debug(`LAN scan send error: ${err.message}`);
        }
      }
    );
  }
  /**
   * Parse incoming UDP message
   *
   * @param msg Raw UDP message buffer
   * @param sourceIp Source IP address from UDP rinfo
   */
  handleMessage(msg, sourceIp) {
    var _a, _b;
    try {
      const data = JSON.parse(msg.toString());
      if (!((_a = data.msg) == null ? void 0 : _a.cmd)) {
        return;
      }
      const { cmd } = data.msg;
      const payload = (_b = data.msg.data) != null ? _b : {};
      if (cmd === "scan") {
        this.handleScanResponse(payload);
      } else if (cmd === "devStatus") {
        this.handleStatusResponse(payload, sourceIp);
      }
    } catch {
      this.log.debug(
        `LAN: Failed to parse message: ${msg.toString().slice(0, 200)}`
      );
    }
  }
  /**
   * Handle scan response — new device found
   *
   * @param data Parsed scan response payload
   */
  handleScanResponse(data) {
    var _a;
    if (typeof data.ip !== "string" || typeof data.device !== "string" || typeof data.sku !== "string" || !data.ip || !data.device || !data.sku) {
      return;
    }
    const lanDevice = {
      ip: data.ip,
      device: data.device,
      sku: data.sku
    };
    const key = `${lanDevice.device}:${lanDevice.ip}`;
    if (!this.seenDeviceIps.has(key)) {
      this.seenDeviceIps.add(key);
      this.log.debug(
        `LAN: Found ${lanDevice.sku} (${lanDevice.device}) at ${lanDevice.ip}`
      );
    }
    (_a = this.onDiscovery) == null ? void 0 : _a.call(this, lanDevice);
  }
  /**
   * Handle status response — matched to device by source IP.
   * Defensive against malformed/partial payloads — all fields coerced to safe defaults.
   *
   * @param data Parsed status response payload
   * @param sourceIp Source IP address from UDP message
   */
  handleStatusResponse(data, sourceIp) {
    var _a;
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
    (_a = this.onStatus) == null ? void 0 : _a.call(this, sourceIp, status);
  }
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
        lastLineMarker = rawData.length - 1;
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
  packets.push(
    Buffer.from(finishPacket([51, 5, 10])).toString("base64")
  );
  return packets;
}
function buildGradientPacket(on) {
  return Buffer.from(finishPacket([51, 20, on ? 1 : 0])).toString(
    "base64"
  );
}
function buildMusicModePacket(subMode, r = 0, g = 0, b = 0) {
  const data = [51, 5, 1, subMode & 255];
  if (subMode === 1 || subMode === 2) {
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
    ...buildSegmentBitmask(segments, 7)
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
    ...buildSegmentBitmask(segments, 14)
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
