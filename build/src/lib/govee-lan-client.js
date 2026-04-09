"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoveeLanClient = void 0;
const dgram = __importStar(require("node:dgram"));
const MULTICAST_ADDR = "239.255.255.250";
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const COMMAND_PORT = 4003;
/**
 * Govee LAN UDP client for device discovery and control.
 * Handles multicast discovery on port 4001, listens on 4002, sends commands to 4003.
 */
class GoveeLanClient {
    scanSocket = null;
    listenSocket = null;
    scanTimer = undefined;
    timers;
    log;
    onDiscovery = null;
    onStatus = null;
    knownDevices = new Map();
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
    start(onDiscovery, onStatus, scanIntervalMs = 30_000, networkInterface = "") {
        this.onDiscovery = onDiscovery;
        this.onStatus = onStatus;
        const bindAddr = networkInterface && networkInterface !== "0.0.0.0"
            ? networkInterface
            : undefined;
        if (bindAddr) {
            this.log.info(`LAN binding to network interface ${bindAddr}`);
        }
        // Listen socket for responses (port 4002) — must be ready before first scan
        this.listenSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        this.listenSocket.on("message", (msg, rinfo) => {
            this.handleMessage(msg, rinfo.address);
        });
        this.listenSocket.on("error", (err) => {
            this.log.debug(`LAN listen socket error: ${err.message}`);
        });
        this.listenSocket.bind(LISTEN_PORT, bindAddr, () => {
            this.log.debug(`LAN listening on port ${LISTEN_PORT}`);
            // Scan socket for multicast discovery (port 4001) — started after listen is ready
            this.scanSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
            this.scanSocket.on("error", (err) => {
                this.log.debug(`LAN scan socket error: ${err.message}`);
            });
            this.scanSocket.bind(() => {
                this.scanSocket?.setBroadcast(true);
                try {
                    this.scanSocket?.addMembership(MULTICAST_ADDR, bindAddr);
                }
                catch {
                    this.log.debug("Could not join multicast group — using broadcast fallback");
                }
                this.sendScan();
            });
            // Periodic scan
            this.scanTimer = this.timers.setInterval(() => {
                this.sendScan();
            }, scanIntervalMs);
        });
    }
    /** Stop all sockets and timers */
    stop() {
        if (this.scanTimer) {
            this.timers.clearInterval(this.scanTimer);
            this.scanTimer = undefined;
        }
        if (this.scanSocket) {
            try {
                this.scanSocket.close();
            }
            catch {
                /* ignore */
            }
            this.scanSocket = null;
        }
        if (this.listenSocket) {
            try {
                this.listenSocket.close();
            }
            catch {
                /* ignore */
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
            msg: { cmd, data },
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
            value: Math.max(0, Math.min(100, brightness)),
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
            colorTemInKelvin: 0,
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
            colorTemInKelvin: kelvin,
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
        const scanMsg = {
            msg: { cmd: "scan", data: { account_topic: "reserve" } },
        };
        const buf = Buffer.from(JSON.stringify(scanMsg));
        this.scanSocket?.send(buf, 0, buf.length, SCAN_PORT, MULTICAST_ADDR, (err) => {
            if (err) {
                this.log.debug(`LAN scan send error: ${err.message}`);
            }
            else {
                this.log.debug("LAN scan sent");
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
        try {
            const data = JSON.parse(msg.toString());
            if (!data.msg?.cmd) {
                return;
            }
            const { cmd } = data.msg;
            const payload = data.msg.data ?? {};
            if (cmd === "scan") {
                this.handleScanResponse(payload);
            }
            else if (cmd === "devStatus") {
                this.handleStatusResponse(payload, sourceIp);
            }
        }
        catch {
            this.log.debug(`LAN: Failed to parse message: ${msg.toString().slice(0, 200)}`);
        }
    }
    /**
     * Handle scan response — new device found
     *
     * @param data Parsed scan response payload
     */
    handleScanResponse(data) {
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
            bleVersionHard: data.bleVersionHard ?? "",
            bleVersionSoft: data.bleVersionSoft ?? "",
            wifiVersionHard: data.wifiVersionHard ?? "",
            wifiVersionSoft: data.wifiVersionSoft ?? "",
        };
        const existing = this.knownDevices.get(device);
        this.knownDevices.set(device, lanDevice);
        if (!existing || existing.ip !== ip) {
            this.log.debug(`LAN: Found ${sku} (${device}) at ${ip}`);
            this.onDiscovery?.(lanDevice);
        }
    }
    /**
     * Handle status response — matched to device by source IP
     *
     * @param data Parsed status response payload
     * @param sourceIp Source IP address from UDP message
     */
    handleStatusResponse(data, sourceIp) {
        const status = {
            onOff: data.onOff ?? 0,
            brightness: data.brightness ?? 0,
            color: data.color ?? {
                r: 0,
                g: 0,
                b: 0,
            },
            colorTemInKelvin: data.colorTemInKelvin ?? 0,
        };
        this.onStatus?.(sourceIp, status);
    }
}
exports.GoveeLanClient = GoveeLanClient;
//# sourceMappingURL=govee-lan-client.js.map