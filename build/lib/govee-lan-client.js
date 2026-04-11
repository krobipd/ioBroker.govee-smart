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
  buildDiyPackets: () => buildDiyPackets,
  buildGradientPacket: () => buildGradientPacket,
  buildMusicModePacket: () => buildMusicModePacket,
  buildScenePackets: () => buildScenePackets,
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
  knownDevices = /* @__PURE__ */ new Map();
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
   * Set segment color via ptReal BLE-passthrough.
   * Encodes segments as two bitmask bytes (segments 0-7 → left, 8-15 → right).
   *
   * @param ip Device IP address
   * @param segments Array of segment indices to color
   * @param r Red channel 0-255
   * @param g Green channel 0-255
   * @param b Blue channel 0-255
   */
  setSegmentColor(ip, segments, r, g, b) {
    this.sendPtReal(ip, [buildSegmentColorPacket(segments, r, g, b)]);
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
    const ip = data.ip;
    const device = data.device;
    const sku = data.sku;
    if (!ip || !device || !sku) {
      return;
    }
    const lanDevice = {
      ip,
      device,
      sku
    };
    const existing = this.knownDevices.get(device);
    this.knownDevices.set(device, lanDevice);
    if (!existing || existing.ip !== ip) {
      this.log.debug(`LAN: Found ${sku} (${device}) at ${ip}`);
      (_a = this.onDiscovery) == null ? void 0 : _a.call(this, lanDevice);
    }
  }
  /**
   * Handle status response — matched to device by source IP
   *
   * @param data Parsed status response payload
   * @param sourceIp Source IP address from UDP message
   */
  handleStatusResponse(data, sourceIp) {
    var _a, _b, _c, _d, _e;
    const status = {
      onOff: (_a = data.onOff) != null ? _a : 0,
      brightness: (_b = data.brightness) != null ? _b : 0,
      color: (_c = data.color) != null ? _c : {
        r: 0,
        g: 0,
        b: 0
      },
      colorTemInKelvin: (_d = data.colorTemInKelvin) != null ? _d : 0
    };
    (_e = this.onStatus) == null ? void 0 : _e.call(this, sourceIp, status);
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
function buildSegmentColorPacket(segments, r, g, b) {
  let leftMask = 0;
  let rightMask = 0;
  for (const seg of segments) {
    if (seg < 8) {
      leftMask |= 1 << seg;
    } else if (seg < 16) {
      rightMask |= 1 << seg - 8;
    }
  }
  return Buffer.from(
    finishPacket([51, 5, 11, r, g, b, leftMask, rightMask])
  ).toString("base64");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeLanClient,
  buildDiyPackets,
  buildGradientPacket,
  buildMusicModePacket,
  buildScenePackets,
  buildSegmentColorPacket
});
//# sourceMappingURL=govee-lan-client.js.map
