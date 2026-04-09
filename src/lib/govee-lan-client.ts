import * as dgram from "node:dgram";
import type {
  LanDevice,
  LanMessage,
  LanStatus,
  TimerAdapter,
} from "./types.js";

const MULTICAST_ADDR = "239.255.255.250";
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const COMMAND_PORT = 4003;

/** Callback for discovered LAN devices */
export type LanDiscoveryCallback = (device: LanDevice) => void;

/** Callback for status updates (matched by source IP, not device ID) */
export type LanStatusCallback = (sourceIp: string, status: LanStatus) => void;

/**
 * Govee LAN UDP client for device discovery and control.
 * Handles multicast discovery on port 4001, listens on 4002, sends commands to 4003.
 */
export class GoveeLanClient {
  private scanSocket: dgram.Socket | null = null;
  private listenSocket: dgram.Socket | null = null;
  private scanTimer: ioBroker.Interval | undefined = undefined;
  private readonly timers: TimerAdapter;
  private readonly log: ioBroker.Logger;
  private onDiscovery: LanDiscoveryCallback | null = null;
  private onStatus: LanStatusCallback | null = null;
  private readonly knownDevices = new Map<string, LanDevice>();

  /**
   * @param log ioBroker logger
   * @param timers Timer adapter for setInterval/setTimeout
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
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
  start(
    onDiscovery: LanDiscoveryCallback,
    onStatus: LanStatusCallback,
    scanIntervalMs = 30_000,
    networkInterface = "",
  ): void {
    this.onDiscovery = onDiscovery;
    this.onStatus = onStatus;

    const bindAddr =
      networkInterface && networkInterface !== "0.0.0.0"
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
        } catch {
          this.log.debug(
            "Could not join multicast group — using broadcast fallback",
          );
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
  stop(): void {
    if (this.scanTimer) {
      this.timers.clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    if (this.scanSocket) {
      try {
        this.scanSocket.close();
      } catch {
        /* ignore */
      }
      this.scanSocket = null;
    }
    if (this.listenSocket) {
      try {
        this.listenSocket.close();
      } catch {
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
  sendCommand(ip: string, cmd: string, data: Record<string, unknown>): void {
    const message: LanMessage = {
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
  setPower(ip: string, on: boolean): void {
    this.sendCommand(ip, "turn", { value: on ? 1 : 0 });
  }

  /**
   * Send brightness command
   *
   * @param ip Device IP address
   * @param brightness Brightness 0-100
   */
  setBrightness(ip: string, brightness: number): void {
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
  setColor(ip: string, r: number, g: number, b: number): void {
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
  setColorTemperature(ip: string, kelvin: number): void {
    this.sendCommand(ip, "colorwc", {
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: kelvin,
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
  setScene(ip: string, sceneCode: number, scenceParam: string): void {
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
  sendPtReal(ip: string, base64Packets: string[]): void {
    const message = {
      msg: { cmd: "ptReal", data: { command: base64Packets } },
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
   * Request device status
   *
   * @param ip Device IP address
   */
  requestStatus(ip: string): void {
    this.sendCommand(ip, "devStatus", {});
  }

  /** Get known LAN devices */
  getDevices(): Map<string, LanDevice> {
    return this.knownDevices;
  }

  /** Send multicast scan */
  private sendScan(): void {
    const scanMsg: LanMessage = {
      msg: { cmd: "scan", data: { account_topic: "reserve" } },
    };
    const buf = Buffer.from(JSON.stringify(scanMsg));
    this.scanSocket?.send(
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
      },
    );
  }

  /**
   * Parse incoming UDP message
   *
   * @param msg Raw UDP message buffer
   * @param sourceIp Source IP address from UDP rinfo
   */
  private handleMessage(msg: Buffer, sourceIp: string): void {
    try {
      const data = JSON.parse(msg.toString()) as {
        msg?: { cmd?: string; data?: Record<string, unknown> };
      };
      if (!data.msg?.cmd) {
        return;
      }

      const { cmd } = data.msg;
      const payload = data.msg.data ?? {};

      if (cmd === "scan") {
        this.handleScanResponse(payload);
      } else if (cmd === "devStatus") {
        this.handleStatusResponse(payload, sourceIp);
      }
    } catch {
      this.log.debug(
        `LAN: Failed to parse message: ${msg.toString().slice(0, 200)}`,
      );
    }
  }

  /**
   * Handle scan response — new device found
   *
   * @param data Parsed scan response payload
   */
  private handleScanResponse(data: Record<string, unknown>): void {
    const ip = data.ip as string;
    const device = data.device as string;
    const sku = data.sku as string;

    if (!ip || !device || !sku) {
      return;
    }

    const lanDevice: LanDevice = {
      ip,
      device,
      sku,
      bleVersionHard: (data.bleVersionHard as string) ?? "",
      bleVersionSoft: (data.bleVersionSoft as string) ?? "",
      wifiVersionHard: (data.wifiVersionHard as string) ?? "",
      wifiVersionSoft: (data.wifiVersionSoft as string) ?? "",
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
  private handleStatusResponse(
    data: Record<string, unknown>,
    sourceIp: string,
  ): void {
    const status: LanStatus = {
      onOff: (data.onOff as number) ?? 0,
      brightness: (data.brightness as number) ?? 0,
      color: (data.color as { r: number; g: number; b: number }) ?? {
        r: 0,
        g: 0,
        b: 0,
      },
      colorTemInKelvin: (data.colorTemInKelvin as number) ?? 0,
    };

    this.onStatus?.(sourceIp, status);
  }
}

// --- BLE Packet Builder for ptReal ---

/**
 * XOR checksum over all bytes
 *
 * @param data Array of byte values
 */
function xorChecksum(data: number[]): number {
  let checksum = 0;
  for (const b of data) {
    checksum ^= b;
  }
  return checksum;
}

/**
 * Pad data to 19 bytes + append XOR checksum = 20-byte BLE packet
 *
 * @param data Array of byte values to pad and checksum
 */
function finishPacket(data: number[]): number[] {
  while (data.length < 19) {
    data.push(0);
  }
  data.push(xorChecksum(data));
  return data;
}

/**
 * Build Base64-encoded BLE packets for scene activation via ptReal.
 *
 * @param sceneCode Scene code from library (> 0)
 * @param scenceParam Base64-encoded scene parameter data (may be empty)
 */
export function buildScenePackets(
  sceneCode: number,
  scenceParam: string,
): string[] {
  const packets: string[] = [];

  // Multi-packet scene data from scenceParam (A3 header protocol)
  if (scenceParam) {
    const paramBytes = Array.from(Buffer.from(scenceParam, "base64"));
    // Build A3-framed packets: first chunk starts with A3 00 01 00 02
    const rawData: number[] = [0xa3, 0x00, 0x01, 0x00, 0x02];
    let numLines = 0;
    let lastLineMarker = 1;

    for (const b of paramBytes) {
      if (rawData.length % 19 === 0) {
        numLines++;
        rawData.push(0xa3);
        lastLineMarker = rawData.length;
        rawData.push(numLines);
      }
      rawData.push(b);
    }
    rawData[lastLineMarker] = 0xff;
    rawData[3] = numLines + 1;

    // Split into 19-byte chunks, pad + checksum each
    for (let i = 0; i < rawData.length; i += 19) {
      const chunk = rawData.slice(i, i + 19);
      const pkt = finishPacket([...chunk]);
      packets.push(Buffer.from(pkt).toString("base64"));
    }
  }

  // Final scene-code activation packet: 33 05 04 lo hi
  const lo = sceneCode & 0xff;
  const hi = (sceneCode >> 8) & 0xff;
  const activatePacket = finishPacket([0x33, 0x05, 0x04, lo, hi]);
  packets.push(Buffer.from(activatePacket).toString("base64"));

  return packets;
}
