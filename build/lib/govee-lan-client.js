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
  GoveeLanClient: () => GoveeLanClient
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
    const bindAddr = networkInterface || void 0;
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
   * Request device status
   *
   * @param ip Device IP address
   */
  requestStatus(ip) {
    this.sendCommand(ip, "devStatus", {});
  }
  /** Get known LAN devices */
  getDevices() {
    return this.knownDevices;
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
        } else {
          this.log.debug("LAN scan sent");
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
    var _a, _b, _c, _d, _e;
    const ip = data.ip;
    const device = data.device;
    const sku = data.sku;
    if (!ip || !device || !sku) {
      return;
    }
    const lanDevice = {
      ip,
      device,
      sku,
      bleVersionHard: (_a = data.bleVersionHard) != null ? _a : "",
      bleVersionSoft: (_b = data.bleVersionSoft) != null ? _b : "",
      wifiVersionHard: (_c = data.wifiVersionHard) != null ? _c : "",
      wifiVersionSoft: (_d = data.wifiVersionSoft) != null ? _d : ""
    };
    const existing = this.knownDevices.get(device);
    this.knownDevices.set(device, lanDevice);
    if (!existing || existing.ip !== ip) {
      this.log.debug(`LAN: Found ${sku} (${device}) at ${ip}`);
      (_e = this.onDiscovery) == null ? void 0 : _e.call(this, lanDevice);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GoveeLanClient
});
//# sourceMappingURL=govee-lan-client.js.map
