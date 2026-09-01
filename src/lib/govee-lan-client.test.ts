import {
  GoveeLanClient,
  buildScenePackets,
  buildGradientPacket,
  buildMusicModePacket,
  buildDiyPackets,
  buildSegmentBitmask,
  buildSegmentColorPacket,
  buildSegmentBrightnessPacket,
  applySceneSpeed,
} from "./govee-lan-client";
import type { LanDevice, LanStatus, TimerAdapter } from "./types";

// dgram is mocked so the interface-pinning behaviour in start() (setMulticastInterface
// on the scan socket + bind on the command socket) is unit-testable. The rest of the
// suite never calls start(), so these mocks stay inert for those tests.
const dgramMock = vi.hoisted(() => {
  interface SentDatagram {
    buf: Buffer;
    port: number;
    address: string;
  }
  const sockets: Array<{
    binds: Array<[unknown, unknown]>;
    mcastIf: unknown[];
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sends: SentDatagram[];
    /** When set, every send() reports this error to its callback instead of success. */
    sendError: Error | null;
  }> = [];
  const make = (): unknown => {
    const s = {
      binds: [] as Array<[unknown, unknown]>,
      mcastIf: [] as unknown[],
      handlers: {} as Record<string, Array<(...a: unknown[]) => void>>,
      sends: [] as SentDatagram[],
      sendError: null as Error | null,
      on: (ev: unknown, cb: unknown) => {
        const key = String(ev);
        (s.handlers[key] ??= []).push(cb as (...a: unknown[]) => void);
      },
      bind: (a: unknown, b: unknown, c: unknown) => {
        s.binds.push([a, b]);
        if (typeof b === "function") (b as () => void)();
        else if (typeof c === "function") (c as () => void)();
      },
      setBroadcast: () => {},
      addMembership: () => {},
      dropMembership: () => {},
      setMulticastInterface: (iface: unknown) => s.mcastIf.push(iface),
      // Records the datagram the way node:dgram would put it on the wire and
      // completes the callback, so the send-hook / last-sent bookkeeping runs.
      send: (buf: Buffer, _off: number, _len: number, port: number, address: string, cb?: (e: Error | null) => void) => {
        s.sends.push({ buf, port, address });
        cb?.(s.sendError);
      },
      close: () => {},
    };
    sockets.push(s);
    return s;
  };
  return { sockets, make };
});
vi.mock("node:dgram", () => ({ createSocket: () => dgramMock.make() }));

const lanLog = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  level: "debug",
} as unknown as ioBroker.Logger;

const lanTimers = {
  setInterval: () => undefined,
  clearInterval: () => {},
  setTimeout: () => undefined,
  clearTimeout: () => {},
  delay: () => Promise.resolve(),
} as unknown as TimerAdapter;

describe("buildScenePackets", () => {
  it("should build a single activation packet for scene code only", () => {
    const packets = buildScenePackets(42, "");
    expect(packets).toHaveLength(1);
    // Decode the activation packet
    const buf = Buffer.from(packets[0], "base64");
    expect(buf).toHaveLength(20);
    expect(buf[0]).toBe(0x33); // cmd
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x04);
    expect(buf[3]).toBe(42); // lo byte
    expect(buf[4]).toBe(0); // hi byte
    // Bytes 5-18 should be zero padding
    for (let i = 5; i < 19; i++) {
      expect(buf[i]).toBe(0);
    }
    // Last byte is XOR checksum
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= buf[i];
    }
    expect(buf[19]).toBe(xor);
  });

  it("should encode scene code as little-endian 16-bit", () => {
    const packets = buildScenePackets(0x1234, "");
    const buf = Buffer.from(packets[0], "base64");
    expect(buf[3]).toBe(0x34); // lo
    expect(buf[4]).toBe(0x12); // hi
  });

  it("should include A3 data packets for scenceParam", () => {
    // Small param: 5 bytes → fits in one A3 packet + activation
    const param = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64");
    const packets = buildScenePackets(100, param);
    expect(packets.length).toBeGreaterThan(1);
    // Last packet is always the activation packet
    const lastBuf = Buffer.from(packets[packets.length - 1], "base64");
    expect(lastBuf[0]).toBe(0x33);
    expect(lastBuf[1]).toBe(0x05);
    expect(lastBuf[2]).toBe(0x04);
    expect(lastBuf[3]).toBe(100); // lo
    expect(lastBuf[4]).toBe(0); // hi
    // First packet should start with A3 header
    const firstBuf = Buffer.from(packets[0], "base64");
    expect(firstBuf[0]).toBe(0xa3);
  });

  it("should produce 20-byte packets with valid XOR checksums", () => {
    // Larger param data to produce multiple A3 packets
    const bigParam = Buffer.alloc(40, 0xab).toString("base64");
    const packets = buildScenePackets(500, bigParam);
    for (const p of packets) {
      const buf = Buffer.from(p, "base64");
      expect(buf).toHaveLength(20);
      // Verify XOR checksum
      let xor = 0;
      for (let i = 0; i < 19; i++) {
        xor ^= buf[i];
      }
      expect(buf[19]).toBe(xor);
    }
  });

  it("should handle empty scenceParam (scene code only)", () => {
    const packets = buildScenePackets(1, "");
    expect(packets).toHaveLength(1);
  });
});

describe("buildGradientPacket", () => {
  it("should build gradient ON packet", () => {
    const buf = Buffer.from(buildGradientPacket(true), "base64");
    expect(buf).toHaveLength(20);
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x14);
    expect(buf[2]).toBe(0x01);
    for (let i = 3; i < 19; i++) {
      expect(buf[i]).toBe(0);
    }
  });

  it("should build gradient OFF packet", () => {
    const buf = Buffer.from(buildGradientPacket(false), "base64");
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x14);
    expect(buf[2]).toBe(0x00);
  });

  it("should have valid XOR checksum", () => {
    const buf = Buffer.from(buildGradientPacket(true), "base64");
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= buf[i];
    }
    expect(buf[19]).toBe(xor);
  });
});

describe("buildMusicModePacket", () => {
  // Standard layout stays byte-identical: Spectrum/Rolling append RGB
  // (includeRgb=true), Energic/Rhythm don't (includeRgb=false). This is the
  // A2 no-regression proof — the caller passes includeRgb via the mode NAME.
  it("should build Energic mode (0) without RGB", () => {
    const buf = Buffer.from(buildMusicModePacket(0, false), "base64");
    expect(buf).toHaveLength(20);
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x01);
    expect(buf[3]).toBe(0x00);
    for (let i = 4; i < 19; i++) {
      expect(buf[i]).toBe(0);
    }
  });

  it("should build Spectrum mode (1) with RGB", () => {
    const buf = Buffer.from(buildMusicModePacket(1, true, 0xff, 0x80, 0x00), "base64");
    expect(buf[3]).toBe(0x01);
    expect(buf[4]).toBe(0xff);
    expect(buf[5]).toBe(0x80);
    expect(buf[6]).toBe(0x00);
  });

  it("should build Rolling mode (2) with RGB", () => {
    const buf = Buffer.from(buildMusicModePacket(2, true, 0x10, 0x20, 0x30), "base64");
    expect(buf[3]).toBe(0x02);
    expect(buf[4]).toBe(0x10);
    expect(buf[5]).toBe(0x20);
    expect(buf[6]).toBe(0x30);
  });

  it("should build Rhythm mode (3) without RGB", () => {
    const buf = Buffer.from(buildMusicModePacket(3, false, 0xff, 0xff, 0xff), "base64");
    expect(buf[3]).toBe(0x03);
    expect(buf[4]).toBe(0x00);
  });

  it("gates RGB on includeRgb, not the sub-mode value (A2): a non-standard mode value still gets RGB", () => {
    // A SKU whose Spectrum is at value 6 must still receive its colour.
    const buf = Buffer.from(buildMusicModePacket(6, true, 0x11, 0x22, 0x33), "base64");
    expect(buf[3]).toBe(0x06);
    expect(buf[4]).toBe(0x11);
    expect(buf[5]).toBe(0x22);
    expect(buf[6]).toBe(0x33);
  });

  it("withholds RGB when includeRgb is false even for value 1 (no value-based leak)", () => {
    const buf = Buffer.from(buildMusicModePacket(1, false, 0xff, 0xff, 0xff), "base64");
    expect(buf[3]).toBe(0x01);
    expect(buf[4]).toBe(0x00); // no RGB appended
  });

  it("should have valid XOR checksum", () => {
    const buf = Buffer.from(buildMusicModePacket(1, true, 255, 0, 128), "base64");
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= buf[i];
    }
    expect(buf[19]).toBe(xor);
  });
});

describe("buildDiyPackets", () => {
  it("should build activation-only packet when no param data", () => {
    const packets = buildDiyPackets("");
    expect(packets).toHaveLength(1);
    const buf = Buffer.from(packets[0], "base64");
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x0a);
  });

  it("should include A1 data packets for scenceParam", () => {
    const param = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64");
    const packets = buildDiyPackets(param);
    expect(packets.length).toBeGreaterThan(1);
    const firstBuf = Buffer.from(packets[0], "base64");
    expect(firstBuf[0]).toBe(0xa1);
    const lastBuf = Buffer.from(packets[packets.length - 1], "base64");
    expect(lastBuf[0]).toBe(0x33);
    expect(lastBuf[1]).toBe(0x05);
    expect(lastBuf[2]).toBe(0x0a);
  });

  it("should produce 20-byte packets with valid checksums", () => {
    const bigParam = Buffer.alloc(30, 0xcd).toString("base64");
    const packets = buildDiyPackets(bigParam);
    for (const p of packets) {
      const buf = Buffer.from(p, "base64");
      expect(buf).toHaveLength(20);
      let xor = 0;
      for (let i = 0; i < 19; i++) {
        xor ^= buf[i];
      }
      expect(buf[19]).toBe(xor);
    }
  });

  it("preserves the A1-02 prefix on the continuation line (M1: no off-by-one)", () => {
    const bigParam = Buffer.alloc(30, 0xcd).toString("base64"); // >15 bytes → forces a continuation line
    const packets = buildDiyPackets(bigParam);
    // packets = [data0, data1(continuation), activation]. The continuation line
    // must start A1 02 FF — the off-by-one clobbered the mandatory 0x02.
    const cont = Buffer.from(packets[1], "base64");
    expect([cont[0], cont[1], cont[2]]).toEqual([0xa1, 0x02, 0xff]);
  });
});

// Byte-golden master for the A3/A1 packet framing — pins the exact base64
// output so a DRY refactor of buildScenePackets/buildDiyPackets is provably
// byte-identical. The structural tests above check headers/checksums; these
// lock every byte, including the multi-packet continuation where numLines
// increments and lastLineMarker moves (the subtle off-by-one spot).
describe("A-frame packet framing (byte-golden)", () => {
  const small = Buffer.from([1, 2, 3, 4, 5]).toString("base64"); // 5B → single data chunk
  const big = Buffer.from(Array.from({ length: 40 }, (_, i) => i)).toString("base64"); // 40B → crosses the 19-byte boundary twice

  it("buildScenePackets: empty / single / multi-packet are byte-exact", () => {
    expect(buildScenePackets(42, "")).toEqual(["MwUEKgAAAAAAAAAAAAAAAAAAABg="]);
    expect(buildScenePackets(100, small)).toEqual([
      "o/8BAQIBAgMEBQAAAAAAAAAAAF8=",
      "MwUEZAAAAAAAAAAAAAAAAAAAAFY=",
    ]);
    expect(buildScenePackets(500, big)).toEqual([
      "owABAwIAAQIDBAUGBwgJCgsMDaI=",
      "owEODxAREhMUFRYXGBkaGxwdHrw=",
      "o/8fICEiIyQlJicAAAAAAAAAAEM=",
      "MwUE9AEAAAAAAAAAAAAAAAAAAMc=",
    ]);
  });

  it("buildDiyPackets: empty / single / multi-packet are byte-exact", () => {
    expect(buildDiyPackets("")).toEqual(["MwUKAAAAAAAAAAAAAAAAAAAAADw="]);
    expect(buildDiyPackets(small)).toEqual([
      "oQL/AQECAwQFAAAAAAAAAAAAAFw=",
      "MwUKAAAAAAAAAAAAAAAAAAAAADw=",
    ]);
    expect(buildDiyPackets(big)).toEqual([
      "oQIAAwABAgMEBQYHCAkKCwwNDq8=",
      "oQIBDxAREhMUFRYXGBkaGxwdHrI=",
      "oQL/HyAhIiMkJSYnAAAAAAAAAEM=",
      "MwUKAAAAAAAAAAAAAAAAAAAAADw=",
    ]);
  });
});

describe("buildSegmentBitmask", () => {
  it("should set bit 0 for segment 0", () => {
    const mask = buildSegmentBitmask([0], 7);
    expect(mask[0]).toBe(0x01);
    for (let i = 1; i < 7; i++) {
      expect(mask[i]).toBe(0);
    }
  });

  it("should set bit 5 for segment 5", () => {
    const mask = buildSegmentBitmask([5], 7);
    expect(mask[0]).toBe(0x20);
  });

  it("should set bits across multiple bytes", () => {
    const mask = buildSegmentBitmask([0, 8, 16], 7);
    expect(mask[0]).toBe(0x01);
    expect(mask[1]).toBe(0x01);
    expect(mask[2]).toBe(0x01);
  });

  it("should handle multi-segment in same byte (3+4+5 = 0x38)", () => {
    const mask = buildSegmentBitmask([3, 4, 5], 7);
    expect(mask[0]).toBe(0x38);
  });

  it("should ignore segments beyond byte count", () => {
    const mask = buildSegmentBitmask([56], 7);
    for (let i = 0; i < 7; i++) {
      expect(mask[i]).toBe(0);
    }
  });
});

describe("buildSegmentColorPacket", () => {
  it("should build 20-byte packet with correct header", () => {
    const buf = Buffer.from(buildSegmentColorPacket(0, 255, 0, [5]), "base64");
    expect(buf).toHaveLength(20);
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x15);
    expect(buf[3]).toBe(0x01);
    expect(buf[4]).toBe(0);
    expect(buf[5]).toBe(255);
    expect(buf[6]).toBe(0);
  });

  it("should match verified test packet for segment 5 green", () => {
    // Research: 33 05 15 01 00 ff 00 00 00 00 00 00 20 00 00 00 00 00 00 fd
    const buf = Buffer.from(buildSegmentColorPacket(0, 0xff, 0, [5]), "base64");
    expect(buf[12]).toBe(0x20);
    expect(buf[19]).toBe(0xfd);
  });

  it("should match verified test packet for segments 3+4+5 blue", () => {
    // Research: 33 05 15 01 00 00 ff 00 00 00 00 00 38 00 00 00 00 00 00 e5
    const buf = Buffer.from(buildSegmentColorPacket(0, 0, 0xff, [3, 4, 5]), "base64");
    expect(buf[12]).toBe(0x38);
    expect(buf[19]).toBe(0xe5);
  });

  it("should handle high segment numbers (10+11+12)", () => {
    // Research: 33 05 15 01 ff 00 00 00 00 00 00 00 00 1c 00 00 00 00 00 c1
    const buf = Buffer.from(buildSegmentColorPacket(0xff, 0, 0, [10, 11, 12]), "base64");
    expect(buf[13]).toBe(0x1c);
    expect(buf[19]).toBe(0xc1);
  });

  it("should have valid XOR checksum", () => {
    const buf = Buffer.from(buildSegmentColorPacket(128, 64, 32, [0, 7]), "base64");
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= buf[i];
    }
    expect(buf[19]).toBe(xor);
  });
});

describe("buildSegmentBrightnessPacket", () => {
  it("should build 20-byte packet with correct header", () => {
    const buf = Buffer.from(buildSegmentBrightnessPacket(30, [5]), "base64");
    expect(buf).toHaveLength(20);
    expect(buf[0]).toBe(0x33);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x15);
    expect(buf[3]).toBe(0x02);
    expect(buf[4]).toBe(30);
  });

  it("should match verified test packet for segment 5 brightness 30%", () => {
    // Research: 33 05 15 02 1e 20 00 00 00 00 00 00 00 00 00 00 00 00 00 1f
    const buf = Buffer.from(buildSegmentBrightnessPacket(30, [5]), "base64");
    expect(buf[4]).toBe(0x1e);
    expect(buf[5]).toBe(0x20);
    expect(buf[19]).toBe(0x1f);
  });

  it("should clamp brightness to 0-100", () => {
    const buf = Buffer.from(buildSegmentBrightnessPacket(150, [0]), "base64");
    expect(buf[4]).toBe(100);
  });

  it("should have valid XOR checksum", () => {
    const buf = Buffer.from(buildSegmentBrightnessPacket(50, [0, 1, 2]), "base64");
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= buf[i];
    }
    expect(buf[19]).toBe(xor);
  });
});

describe("applySceneSpeed", () => {
  it("should replace speed byte at pageLength - 5", () => {
    // 1 page, 26 bytes data. Speed byte at position 21 (26-5).
    const pageData = new Array(26).fill(0);
    pageData[21] = 255; // default speed
    const param = Buffer.from([1, 26, ...pageData]).toString("base64");
    const config = JSON.stringify([{ page: 0, defaultIndex: 1, moveIn: [242, 249, 254] }]);

    const result = applySceneSpeed(param, 0, config);
    const bytes = Array.from(Buffer.from(result, "base64"));
    expect(bytes[2 + 21]).toBe(242); // moveIn[0]
  });

  it("should handle multiple pages with different configs", () => {
    // 2 pages, each 10 bytes. Speed at position 5 (10-5).
    const page0 = new Array(10).fill(0);
    page0[5] = 200;
    const page1 = new Array(10).fill(0);
    page1[5] = 200;
    const param = Buffer.from([2, 10, ...page0, 10, ...page1]).toString("base64");
    const config = JSON.stringify([
      { page: 0, moveIn: [100, 110] },
      { page: 1, moveIn: [120, 130] },
    ]);

    const result = applySceneSpeed(param, 1, config);
    const bytes = Array.from(Buffer.from(result, "base64"));
    // Page 0: offset=1, data starts at 2, speed at 2+5=7
    expect(bytes[7]).toBe(110); // moveIn[1] for page 0
    // Page 1: offset=1+1+10=12, data starts at 13, speed at 13+5=18
    expect(bytes[18]).toBe(130); // moveIn[1] for page 1
  });

  it("should return original param when no config matches", () => {
    const pageData = new Array(10).fill(0xaa);
    const param = Buffer.from([1, 10, ...pageData]).toString("base64");
    const config = JSON.stringify([{ page: 5, moveIn: [100] }]); // page 5 doesn't exist

    const result = applySceneSpeed(param, 0, config);
    expect(result).toBe(param);
  });

  it("should return original param for empty config", () => {
    const param = Buffer.from([1, 5, 0, 0, 0, 0, 0]).toString("base64");
    expect(applySceneSpeed(param, 0, "")).toBe(param);
    expect(applySceneSpeed(param, 0, "invalid")).toBe(param);
    expect(applySceneSpeed(param, 0, "[]")).toBe(param);
  });

  it("should not modify when speedLevel exceeds moveIn range", () => {
    const pageData = new Array(10).fill(0);
    pageData[5] = 200;
    const param = Buffer.from([1, 10, ...pageData]).toString("base64");
    const config = JSON.stringify([{ page: 0, moveIn: [100, 110] }]);

    const result = applySceneSpeed(param, 5, config); // level 5 > moveIn.length
    const bytes = Array.from(Buffer.from(result, "base64"));
    expect(bytes[7]).toBe(200); // unchanged
  });
});

describe("GoveeLanClient — handleMessage (LAN reply parsing)", () => {
  function makeClient() {
    const client = new GoveeLanClient(lanLog, lanTimers);
    const discovered: LanDevice[] = [];
    const statuses: Array<{ ip: string; status: LanStatus }> = [];
    (client as any).onDiscovery = (d: LanDevice) => discovered.push(d);
    (client as any).onStatus = (ip: string, s: LanStatus) => statuses.push({ ip, status: s });
    const feed = (obj: unknown, ip = "192.168.1.5"): void =>
      (client as any).handleMessage(Buffer.from(JSON.stringify(obj)), ip);
    return { client, discovered, statuses, feed };
  }

  it("parses a scan response into a discovered LanDevice (ip taken from the UDP source)", () => {
    const { discovered, feed } = makeClient();
    feed({ msg: { cmd: "scan", data: { ip: "192.168.1.50", device: "AA:BB", sku: "H61BE" } } }, "192.168.1.50");
    expect(discovered).toEqual([{ ip: "192.168.1.50", device: "AA:BB", sku: "H61BE" }]);
  });

  it("uses the UDP source IP for a scan reply, ignoring an attacker-claimed payload ip (SEC-M1)", () => {
    const { discovered, feed } = makeClient();
    // data.ip is attacker-controllable; the real device IP is where the packet came from.
    feed({ msg: { cmd: "scan", data: { ip: "10.6.6.6", device: "AA:BB", sku: "H61BE" } } }, "192.168.1.77");
    expect(discovered).toEqual([{ ip: "192.168.1.77", device: "AA:BB", sku: "H61BE" }]);
  });

  it("rejects a scan reply with an absurdly long device or sku (flood padding) (SEC-H2)", () => {
    const { discovered, feed } = makeClient();
    feed({ msg: { cmd: "scan", data: { ip: "x", device: "A".repeat(100), sku: "H61BE" } } }, "10.0.0.1");
    feed({ msg: { cmd: "scan", data: { ip: "x", device: "AA:BB", sku: "H".repeat(50) } } }, "10.0.0.1");
    expect(discovered).toHaveLength(0);
  });

  it("caps distinct LAN identities so a spoofed-discovery flood can't grow unbounded (SEC-H2)", () => {
    const { client, discovered, feed } = makeClient();
    for (let i = 0; i < 600; i++) {
      feed({ msg: { cmd: "scan", data: { ip: "x", device: `AA:BB:${i}`, sku: "H61BE" } } }, "10.0.0.1");
    }
    const seen = (client as any).seenDeviceIps as Set<string>;
    expect(seen.size).toBeLessThanOrEqual(512);
    expect(discovered.length).toBeLessThanOrEqual(512);
  });

  it("ignores a scan response missing a required field (untrusted wire data)", () => {
    const { discovered, feed } = makeClient();
    feed({ msg: { cmd: "scan", data: { ip: "192.168.1.50", device: "AA:BB" } } }); // no sku
    expect(discovered).toHaveLength(0);
  });

  it("parses a devStatus response, coercing fields to safe numbers", () => {
    const { statuses, feed } = makeClient();
    feed(
      { msg: { cmd: "devStatus", data: { onOff: 1, brightness: 80, color: { r: 255, g: 0, b: 128 }, colorTemInKelvin: 4000 } } },
      "10.0.0.1",
    );
    expect(statuses).toEqual([
      { ip: "10.0.0.1", status: { onOff: 1, brightness: 80, color: { r: 255, g: 0, b: 128 }, colorTemInKelvin: 4000 } },
    ]);
  });

  it("coerces malformed status fields to defaults instead of throwing", () => {
    const { statuses, feed } = makeClient();
    feed({ msg: { cmd: "devStatus", data: { onOff: "on", brightness: null, color: "nope" } } });
    expect(statuses[0].status).toEqual({ onOff: 0, brightness: 0, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 0 });
  });

  it("drops oversize messages (>8192 bytes) without parsing", () => {
    const { discovered, statuses, feed } = makeClient();
    feed({ msg: { cmd: "scan", data: { ip: "1", device: "x", sku: "y", pad: "A".repeat(9000) } } });
    expect(discovered).toHaveLength(0);
    expect(statuses).toHaveLength(0);
  });

  it("ignores invalid JSON and messages without a cmd", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    let fired = 0;
    (client as any).onDiscovery = () => fired++;
    (client as any).onStatus = () => fired++;
    (client as any).handleMessage(Buffer.from("{ not json"), "1.2.3.4");
    (client as any).handleMessage(Buffer.from(JSON.stringify({ msg: { data: {} } })), "1.2.3.4");
    expect(fired).toBe(0);
  });

  it("evicts the stale IP entry when the same device reappears at a new (source) IP", () => {
    const { client, feed } = makeClient();
    // The binding IP is the UDP source (SEC-M1), so a device "moving" is a new sourceIp.
    feed({ msg: { cmd: "scan", data: { ip: "unused", device: "AA:BB", sku: "H61BE" } } }, "192.168.1.50");
    feed({ msg: { cmd: "scan", data: { ip: "unused", device: "AA:BB", sku: "H61BE" } } }, "192.168.1.99");
    const seen = (client as any).seenDeviceIps as Set<string>;
    expect(seen.has("AA:BB:192.168.1.99")).toBe(true);
    expect(seen.has("AA:BB:192.168.1.50")).toBe(false); // stale entry evicted
  });
});

describe("GoveeLanClient — network interface pinning (multi-homed)", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
  });

  // createSocket order in start(): [0]=sendSocket, [1]=listenSocket, [2]=scanSocket
  it("pins multicast egress and binds the command socket when a concrete interface is selected", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    client.start(
      () => {},
      () => {},
      30_000,
      "10.0.0.5",
    );
    const sendSock = dgramMock.sockets[0];
    const scanSock = dgramMock.sockets[2];
    expect(sendSock.binds).toContainEqual([0, "10.0.0.5"]); // command socket source-bound to the interface
    expect(scanSock.mcastIf).toContain("10.0.0.5"); // outgoing multicast pinned to the interface
    client.stop();
  });

  it("surfaces a socket error on a pinned interface as warn + onInterfaceError (M11)", () => {
    const warns: string[] = [];
    const debugs: string[] = [];
    const log = { ...lanLog, warn: (m: string) => warns.push(m), debug: (m: string) => debugs.push(m) };
    const client = new GoveeLanClient(log as never, lanTimers);
    const problems: string[] = [];
    client.onInterfaceError = m => problems.push(m);
    client.start(
      () => {},
      () => {},
      30_000,
      "10.0.0.5",
    );
    const listenSock = dgramMock.sockets[1];
    const err = Object.assign(new Error("bind EADDRNOTAVAIL 10.0.0.5"), { code: "EADDRNOTAVAIL" });
    listenSock.handlers["error"]?.forEach(h => h(err));
    // warn-once + actionable message pointing at the Network Interface setting
    expect(warns.some(m => m.includes("LAN listen socket error"))).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("10.0.0.5");
    expect(problems[0]).toContain("Network Interface setting");
    // repeat errors stay on debug (no warn spam)
    listenSock.handlers["error"]?.forEach(h => h(err));
    expect(warns.filter(m => m.includes("socket error"))).toHaveLength(1);
    client.stop();
  });

  it("does NOT raise onInterfaceError without a pinned interface — warn only", () => {
    const warns: string[] = [];
    const log = { ...lanLog, warn: (m: string) => warns.push(m) };
    const client = new GoveeLanClient(log as never, lanTimers);
    const problems: string[] = [];
    client.onInterfaceError = m => problems.push(m);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const listenSock = dgramMock.sockets[1];
    const err = Object.assign(new Error("something"), { code: "EINVAL" });
    listenSock.handlers["error"]?.forEach(h => h(err));
    expect(warns.some(m => m.includes("LAN listen socket error"))).toBe(true);
    expect(problems).toHaveLength(0);
    client.stop();
  });

  it("leaves egress at the OS default for the all-interfaces setting (0.0.0.0)", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const sendSock = dgramMock.sockets[0];
    const scanSock = dgramMock.sockets[2];
    expect(sendSock.binds).toHaveLength(0); // command socket not explicitly bound
    expect(scanSock.mcastIf).toHaveLength(0); // no multicast pinning
    client.stop();
  });
});

describe("setColorTemperature — range clamping", () => {
  /** Captures the outgoing command data via the diagnostics send-hook. */
  function makeCapturingClient(): { client: GoveeLanClient; sent: Array<Record<string, unknown>> } {
    const client = new GoveeLanClient(lanLog, lanTimers);
    const sent: Array<Record<string, unknown>> = [];
    client.setSendHook((_ip, _cmd, payload) => {
      sent.push(payload as Record<string, unknown>);
    });
    return { client, sent };
  }

  it("clamps out-of-band kelvin into Govee's published 2000-9000 K range", () => {
    const { client, sent } = makeCapturingClient();
    client.setColorTemperature("10.0.0.1", 1000);
    client.setColorTemperature("10.0.0.1", 12000);
    client.setColorTemperature("10.0.0.1", 4321.6);
    // A device fed a value outside its firmware range answers with a dropped
    // packet or an unpredictable colour — clamping keeps the command valid.
    expect(sent.map(d => d.colorTemInKelvin)).toEqual([2000, 9000, 4322]);
  });

  it("falls back to the lower bound for a non-numeric value", () => {
    const { client, sent } = makeCapturingClient();
    client.setColorTemperature("10.0.0.1", NaN);
    client.setColorTemperature("10.0.0.1", Infinity);
    expect(sent.map(d => d.colorTemInKelvin)).toEqual([2000, 2000]);
  });
});

// ---------------------------------------------------------------------------
// The whole UDP command path was untested until 2.28.0: every setX() built a
// packet, but no test ever looked at what left the socket. These drive the
// real client against the dgram mock and read the datagram back.
// ---------------------------------------------------------------------------
describe("GoveeLanClient — command send path (what really leaves the socket)", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
  });

  interface SendRecord {
    ip: string;
    cmd: string;
    payload: unknown;
    bytes: number;
    error?: string;
  }

  /** Started client + the send socket the commands go out on + the diag send-hook log. */
  function startedClient(): {
    client: GoveeLanClient;
    sendSock: (typeof dgramMock.sockets)[number];
    hook: SendRecord[];
  } {
    const client = new GoveeLanClient(lanLog, lanTimers);
    const hook: SendRecord[] = [];
    client.setSendHook((ip, cmd, payload, bytes, error) => hook.push({ ip, cmd, payload, bytes, error }));
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    return { client, sendSock: dgramMock.sockets[0], hook };
  }

  const decode = (d: { buf: Buffer }): unknown => JSON.parse(d.buf.toString());

  it("setPower sends the Govee `turn` envelope to port 4003 of the device and reports it to the diag hook", () => {
    const { client, sendSock, hook } = startedClient();
    client.setPower("10.0.0.5", true);
    client.setPower("10.0.0.5", false);
    expect(sendSock.sends.map(d => [d.address, d.port])).toEqual([
      ["10.0.0.5", 4003],
      ["10.0.0.5", 4003],
    ]);
    expect(decode(sendSock.sends[0])).toEqual({ msg: { cmd: "turn", data: { value: 1 } } });
    expect(decode(sendSock.sends[1])).toEqual({ msg: { cmd: "turn", data: { value: 0 } } });
    expect(hook).toEqual([
      { ip: "10.0.0.5", cmd: "turn", payload: { value: 1 }, bytes: sendSock.sends[0].buf.length, error: undefined },
      { ip: "10.0.0.5", cmd: "turn", payload: { value: 0 }, bytes: sendSock.sends[1].buf.length, error: undefined },
    ]);
    // A successful send stamps the per-IP last-command time (rate/diag bookkeeping).
    expect(client.getDiagSnapshot().lastCommandSentMs["10.0.0.5"]).toBeGreaterThan(0);
    client.stop();
  });

  it("setBrightness clamps into 0..100 before it goes on the wire", () => {
    const { client, sendSock } = startedClient();
    client.setBrightness("10.0.0.5", 150);
    client.setBrightness("10.0.0.5", -5);
    client.setBrightness("10.0.0.5", 42.6);
    expect(sendSock.sends.map(d => (decode(d) as { msg: { cmd: string; data: { value: number } } }).msg)).toEqual([
      { cmd: "brightness", data: { value: 100 } },
      { cmd: "brightness", data: { value: 0 } },
      { cmd: "brightness", data: { value: 43 } },
    ]);
    client.stop();
  });

  it("setColor sends colorwc with the RGB triple and colour temperature 0 (RGB mode)", () => {
    const { client, sendSock } = startedClient();
    client.setColor("10.0.0.5", 255, 128, 0);
    expect(decode(sendSock.sends[0])).toEqual({
      msg: { cmd: "colorwc", data: { color: { r: 255, g: 128, b: 0 }, colorTemInKelvin: 0 } },
    });
    client.stop();
  });

  it("requestStatus sends an empty devStatus query", () => {
    const { client, sendSock } = startedClient();
    client.requestStatus("10.0.0.7");
    expect(decode(sendSock.sends[0])).toEqual({ msg: { cmd: "devStatus", data: {} } });
    expect(sendSock.sends[0].address).toBe("10.0.0.7");
    client.stop();
  });

  it("setScene wraps the scene packets in a ptReal envelope and sends nothing for a non-positive code", () => {
    const { client, sendSock } = startedClient();
    client.setScene("10.0.0.5", 0, "");
    client.setScene("10.0.0.5", -3, "");
    expect(sendSock.sends).toHaveLength(0);
    client.setScene("10.0.0.5", 42, "");
    expect(decode(sendSock.sends[0])).toEqual({
      msg: { cmd: "ptReal", data: { command: buildScenePackets(42, "") } },
    });
    client.stop();
  });

  it("sendPtReal reports a failed datagram to the hook with the error and does NOT stamp the last-sent time", () => {
    const warns: string[] = [];
    const client = new GoveeLanClient({ ...lanLog, warn: (m: string) => warns.push(m) } as never, lanTimers);
    const hook: SendRecord[] = [];
    client.setSendHook((ip, cmd, payload, bytes, error) => hook.push({ ip, cmd, payload, bytes, error }));
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    dgramMock.sockets[0].sendError = new Error("EHOSTUNREACH");
    client.sendPtReal("10.0.0.9", ["AAAA"]);
    expect(hook[0]).toMatchObject({ ip: "10.0.0.9", cmd: "ptReal", error: "EHOSTUNREACH" });
    expect(warns.some(m => m.includes("ptReal error to 10.0.0.9"))).toBe(true);
    expect(client.getDiagSnapshot().lastCommandSentMs["10.0.0.9"]).toBeUndefined();
    client.stop();
  });

  it("before start() a command is dropped, but the diag hook still learns about it", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    const hook: SendRecord[] = [];
    client.setSendHook((ip, cmd, payload, bytes, error) => hook.push({ ip, cmd, payload, bytes, error }));
    client.setPower("10.0.0.5", true);
    client.sendPtReal("10.0.0.5", ["AAAA"]);
    expect(dgramMock.sockets).toHaveLength(0);
    expect(hook.map(h => h.error)).toEqual(["socket not ready", "socket not ready"]);
  });

  it("restoreAllSegments sends one ptReal with colour + brightness for every segment, nothing for total 0", () => {
    const { client, sendSock } = startedClient();
    client.restoreAllSegments("10.0.0.5", 0, 1, 2, 3, 50);
    expect(sendSock.sends).toHaveLength(0);
    client.restoreAllSegments("10.0.0.5", 3, 255, 0, 0, 60);
    const all = [0, 1, 2];
    expect(decode(sendSock.sends[0])).toEqual({
      msg: {
        cmd: "ptReal",
        data: { command: [buildSegmentColorPacket(255, 0, 0, all), buildSegmentBrightnessPacket(60, all)] },
      },
    });
    client.stop();
  });

  it("flashSingleSegment forces colour mode first and fires the three-packet burst after the settle delay", () => {
    const timeouts: Array<() => void> = [];
    const timers = {
      ...lanTimers,
      setTimeout: (cb: () => void) => {
        timeouts.push(cb);
        return timeouts.length;
      },
    } as never;
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const sendSock = dgramMock.sockets[0];
    client.flashSingleSegment("10.0.0.5", 4);
    // Step 0 — colorwc white — is on the wire immediately; the burst waits.
    expect(sendSock.sends).toHaveLength(1);
    expect((decode(sendSock.sends[0]) as { msg: { cmd: string } }).msg.cmd).toBe("colorwc");
    expect(timeouts).toHaveLength(1);
    timeouts[0]();
    expect(sendSock.sends).toHaveLength(2);
    const burst = (decode(sendSock.sends[1]) as { msg: { data: { command: string[] } } }).msg.data.command;
    const others = Array.from({ length: 56 }, (_, i) => i).filter(i => i !== 4);
    expect(burst).toEqual([
      buildSegmentBrightnessPacket(0, others),
      buildSegmentColorPacket(0xff, 0xff, 0xff, [4]),
      buildSegmentBrightnessPacket(100, [4]),
    ]);
    // An index the protocol cannot address sends nothing at all.
    client.flashSingleSegment("10.0.0.5", 56);
    client.flashSingleSegment("10.0.0.5", -1);
    expect(sendSock.sends).toHaveLength(2);
    expect(timeouts).toHaveLength(1);
    client.stop();
  });

  it("a flash burst scheduled before stop() never reaches the socket", () => {
    const timeouts: Array<() => void> = [];
    const timers = {
      ...lanTimers,
      setTimeout: (cb: () => void) => {
        timeouts.push(cb);
        return timeouts.length;
      },
    } as never;
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const sendSock = dgramMock.sockets[0];
    client.flashSingleSegment("10.0.0.5", 1);
    client.stop();
    timeouts[0](); // the stale burst fires into a torn-down client
    expect(sendSock.sends).toHaveLength(1); // only the colorwc from before stop()
  });
});

describe("GoveeLanClient — discovery loop + socket wiring", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
  });

  it("the scan interval really sends the multicast scan every tick (the callback was untested)", () => {
    const intervals: Array<() => void> = [];
    const timers = {
      ...lanTimers,
      setInterval: (cb: () => void) => {
        intervals.push(cb);
        return intervals.length;
      },
    } as never;
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const scanSock = dgramMock.sockets[2];
    const before = scanSock.sends.length;
    expect(intervals, "the periodic scan must be armed").toHaveLength(1);
    intervals[0]();
    intervals[0]();
    expect(scanSock.sends).toHaveLength(before + 2);
    const last = scanSock.sends[scanSock.sends.length - 1];
    expect([last.address, last.port]).toEqual(["239.255.255.250", 4001]);
    expect(JSON.parse(last.buf.toString())).toEqual({ msg: { cmd: "scan", data: { account_topic: "reserve" } } });
    client.stop();
  });

  it("a datagram on the listen socket reaches the discovery + status callbacks and the diag record hooks", () => {
    const discovered: LanDevice[] = [];
    const statuses: Array<{ ip: string; status: LanStatus }> = [];
    const scanHook: LanDevice[] = [];
    const statusHook: Array<{ ip: string; status: LanStatus }> = [];
    const client = new GoveeLanClient(lanLog, lanTimers);
    client.setScanRecordHook(d => scanHook.push(d));
    client.setStatusRecordHook((ip, status) => statusHook.push({ ip, status }));
    client.start(
      d => discovered.push(d),
      (ip, status) => statuses.push({ ip, status }),
      30_000,
      "0.0.0.0",
    );
    const listenSock = dgramMock.sockets[1];
    const deliver = (obj: unknown, address: string): void =>
      listenSock.handlers["message"]?.forEach(h => h(Buffer.from(JSON.stringify(obj)), { address }));

    deliver({ msg: { cmd: "scan", data: { ip: "ignored", device: "AA:BB", sku: "H61BE" } } }, "10.0.0.5");
    deliver({ msg: { cmd: "devStatus", data: { onOff: 1, brightness: 20, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } } }, "10.0.0.5");

    expect(discovered).toEqual([{ ip: "10.0.0.5", device: "AA:BB", sku: "H61BE" }]);
    expect(scanHook).toEqual(discovered);
    expect(statuses).toEqual([{ ip: "10.0.0.5", status: { onOff: 1, brightness: 20, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } }]);
    expect(statusHook).toEqual(statuses);
    expect(client.getDiagSnapshot().seenDeviceIps).toEqual(["AA:BB:10.0.0.5"]);
    client.stop();
  });

  it("stop() clears the scan interval and forgets the last-sent stamps", () => {
    let cleared = 0;
    const timers = {
      ...lanTimers,
      setInterval: () => 1,
      clearInterval: () => {
        cleared++;
      },
    } as never;
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    client.setPower("10.0.0.5", true);
    expect(client.getDiagSnapshot().lastCommandSentMs["10.0.0.5"]).toBeGreaterThan(0);
    client.stop();
    expect(cleared).toBe(1);
    expect(client.getDiagSnapshot().lastCommandSentMs).toEqual({});
  });
});
