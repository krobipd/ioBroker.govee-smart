import { GoveeLanClient, interfaceBroadcasts } from "./govee-lan-client";
import {
  buildDiyPackets,
  buildGradientPacket,
  buildMusicModePacket,
  buildScenePackets,
  buildSegmentBrightnessPacket,
  buildSegmentColorPacket,
} from "./ble-frame";
import type { LanDevice, LanStatus, TimerAdapter } from "./types";
import type * as NodeOs from "node:os";

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
    /** The options createSocket() was called with (A5: reuseAddr on the listen socket). */
    opts: unknown;
  }> = [];
  const make = (opts?: unknown): unknown => {
    const s = {
      opts,
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
        if (typeof b === "function") {
          (b as () => void)();
        } else if (typeof c === "function") {
          (c as () => void)();
        }
      },
      setBroadcast: () => {},
      addMembership: () => {},
      dropMembership: () => {},
      setMulticastInterface: (iface: unknown) => s.mcastIf.push(iface),
      // Records the datagram the way node:dgram would put it on the wire and
      // completes the callback, so the send-hook / last-sent bookkeeping runs.
      send: (
        buf: Buffer,
        _off: number,
        _len: number,
        port: number,
        address: string,
        cb?: (e: Error | null) => void,
      ) => {
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
vi.mock("node:dgram", () => ({ createSocket: (opts: unknown) => dgramMock.make(opts) }));

// The host's network cards as os.networkInterfaces() reports them — the scan's
// broadcast targets come from here. One /24 card unless a test sets its own.
const osMock = vi.hoisted(() => {
  const nic = (address: string, netmask: string, internal = false): Record<string, unknown> => ({
    address,
    netmask,
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  });
  const standard = (): Record<string, Array<Record<string, unknown>>> => ({
    lo0: [nic("127.0.0.1", "255.0.0.0", true)],
    en0: [nic("192.168.1.5", "255.255.255.0")],
  });
  return { nic, standard, interfaces: standard() };
});
vi.mock("node:os", async orig => ({
  ...(await orig<typeof NodeOs>()),
  networkInterfaces: () => osMock.interfaces,
}));

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

describe("GoveeLanClient — handleMessage (LAN reply parsing)", () => {
  function makeClient(): {
    client: GoveeLanClient;
    discovered: LanDevice[];
    statuses: Array<{ ip: string; status: LanStatus }>;
    feed: (obj: unknown, ip?: string) => void;
  } {
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
      {
        msg: {
          cmd: "devStatus",
          data: { onOff: 1, brightness: 80, color: { r: 255, g: 0, b: 128 }, colorTemInKelvin: 4000 },
        },
      },
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

  it("a devStatus without a data object is no report — never 'off, brightness 0'", () => {
    // Handed on as `{}` (2.40.0 development), such a packet read as a light that
    // had switched itself off.
    const { statuses, discovered, feed } = makeClient();
    feed({ msg: { cmd: "devStatus", data: null } }, "10.0.0.1");
    feed({ msg: { cmd: "devStatus", data: [1, 80] } }, "10.0.0.1");
    feed({ msg: { cmd: "devStatus" } }, "10.0.0.1");
    feed({ msg: { cmd: "scan", data: "AA:BB" } }, "10.0.0.1");
    expect(statuses).toEqual([]);
    expect(discovered).toEqual([]);
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
    const client = new GoveeLanClient(log, lanTimers);
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
    listenSock.handlers.error?.forEach(h => h(err));
    // warn-once + actionable message pointing at the Network Interface setting
    expect(warns.some(m => m.includes("LAN listen socket error"))).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("10.0.0.5");
    expect(problems[0]).toContain("Network Interface setting");
    // repeat errors stay on debug (no warn spam)
    listenSock.handlers.error?.forEach(h => h(err));
    expect(warns.filter(m => m.includes("socket error"))).toHaveLength(1);
    client.stop();
  });

  it("does NOT raise onInterfaceError without a pinned interface — warn only", () => {
    const warns: string[] = [];
    const log = { ...lanLog, warn: (m: string) => warns.push(m) };
    const client = new GoveeLanClient(log, lanTimers);
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
    listenSock.handlers.error?.forEach(h => h(err));
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

  // Audit 2026-09-12 (T6): these five senders had ZERO calls in the whole
  // suite. Their packet builders are tested one by one, the wiring was not:
  // which socket, which port, which IP, and which builder each one reaches.
  // That is the class of defect the dead sync button was (a path nothing ever
  // drove), and CLAUDE.md claimed the send path as covered.
  it("the five ptReal senders each put their builder's packet on port 4003 of the device", () => {
    const { client, sendSock, hook } = startedClient();
    client.setGradient("10.0.0.5", true);
    client.setDiyScene("10.0.0.5", "");
    client.setMusicMode("10.0.0.5", 3, true, 255, 0, 0);
    client.setSegmentColor("10.0.0.5", 255, 0, 0, [0, 1]);
    client.setSegmentBrightness("10.0.0.5", 50, [0, 1]);

    // every one of them is a ptReal datagram to the device's command port
    expect(sendSock.sends.map(d => [d.address, d.port])).toEqual([
      ["10.0.0.5", 4003],
      ["10.0.0.5", 4003],
      ["10.0.0.5", 4003],
      ["10.0.0.5", 4003],
      ["10.0.0.5", 4003],
    ]);
    expect(hook.map(h => h.cmd)).toEqual(["ptReal", "ptReal", "ptReal", "ptReal", "ptReal"]);

    // …and each carries exactly what its own builder produces
    const command = (i: number): string[] =>
      (decode(sendSock.sends[i]) as { msg: { cmd: string; data: { command: string[] } } }).msg.data.command;
    expect(command(0)).toEqual([buildGradientPacket(true)]);
    expect(command(1)).toEqual(buildDiyPackets(""));
    expect(command(2)).toEqual([buildMusicModePacket(3, true, 255, 0, 0)]);
    expect(command(3)).toEqual([buildSegmentColorPacket(255, 0, 0, [0, 1])]);
    expect(command(4)).toEqual([buildSegmentBrightnessPacket(50, [0, 1])]);
    client.stop();
  });

  it("a ptReal sender reports the failed send to the diag hook instead of swallowing it", () => {
    const { client, sendSock, hook } = startedClient();
    sendSock.sendError = new Error("network unreachable");
    client.setGradient("10.0.0.5", true);
    expect(hook).toEqual([expect.objectContaining({ ip: "10.0.0.5", cmd: "ptReal", error: "network unreachable" })]);
    client.stop();
  });

  it("an eleventh datagram to a light within a second waits for its control limit — delayed in order, never dropped (GV-08)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pending: Array<() => void> = [];
    const timers = { ...lanTimers, setTimeout: (fn: () => void) => pending.push(fn) } as unknown as TimerAdapter;
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const sendSock = dgramMock.sockets[0];
    const levels = Array.from({ length: 12 }, (_, i) => i + 1);
    for (const level of levels) {
      client.setBrightness("10.0.0.7", level);
    }
    const sent = (): number[] =>
      sendSock.sends
        .filter(d => d.address === "10.0.0.7")
        .map(d => (decode(d) as { msg: { data: { value: number } } }).msg.data.value);
    expect(sent()).toEqual(levels.slice(0, 10));
    // a second light is not held up by the first one's limit
    client.setPower("10.0.0.8", true);
    expect(sendSock.sends.at(-1)?.address).toBe("10.0.0.8");
    vi.setSystemTime(Date.now() + 1001);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(sent()).toEqual(levels);
    client.stop();
    vi.useRealTimers();
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
    const client = new GoveeLanClient({ ...lanLog, warn: (m: string) => warns.push(m) }, lanTimers);
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
    // An unreachable lamp is a state, not a line.
    expect(warns).toEqual([]);
    expect(client.getDiagSnapshot().lastCommandSentMs["10.0.0.9"]).toBeUndefined();
    client.stop();
  });

  it("an address that keeps failing warns once — a repeat stays on debug until a send succeeds (audit DRY-9)", () => {
    const warns: string[] = [];
    const client = new GoveeLanClient({ ...lanLog, warn: (m: string) => warns.push(m) }, lanTimers);
    client.start(
      () => {},
      () => {},
      30_000,
      "0.0.0.0",
    );
    const sock = dgramMock.sockets[0];
    sock.sendError = Object.assign(new Error("send EMSGSIZE 10.0.0.9:4003"), { code: "EMSGSIZE" });
    client.sendPtReal("10.0.0.9", ["AAAA"]);
    client.setPower("10.0.0.9", true);
    client.sendPtReal("10.0.0.9", ["AAAA"]);
    expect(warns).toHaveLength(1);
    sock.sendError = null;
    client.setPower("10.0.0.9", true);
    sock.sendError = Object.assign(new Error("send EMSGSIZE 10.0.0.9:4003"), { code: "EMSGSIZE" });
    client.setPower("10.0.0.9", false);
    expect(warns).toHaveLength(2);
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
    // Each tick: the multicast group and the broadcast of the host's one card.
    expect(scanSock.sends).toHaveLength(before + 4);
    const tick = scanSock.sends.slice(-2);
    expect(tick.map(t => [t.address, t.port])).toEqual([
      ["239.255.255.250", 4001],
      ["192.168.1.255", 4001],
    ]);
    expect(JSON.parse(tick[0].buf.toString())).toEqual({ msg: { cmd: "scan", data: { account_topic: "reserve" } } });
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
      listenSock.handlers.message?.forEach(h => h(Buffer.from(JSON.stringify(obj)), { address }));

    deliver({ msg: { cmd: "scan", data: { ip: "ignored", device: "AA:BB", sku: "H61BE" } } }, "10.0.0.5");
    deliver(
      {
        msg: { cmd: "devStatus", data: { onOff: 1, brightness: 20, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } },
      },
      "10.0.0.5",
    );

    expect(discovered).toEqual([{ ip: "10.0.0.5", device: "AA:BB", sku: "H61BE" }]);
    expect(scanHook).toEqual(discovered);
    expect(statuses).toEqual([
      { ip: "10.0.0.5", status: { onOff: 1, brightness: 20, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } },
    ]);
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

describe("GoveeLanClient — audit 2026-09-24 (A5, N1, M2, A9, A-O1)", () => {
  const start = (client: GoveeLanClient, onDiscovery: (d: unknown) => void = () => {}): void =>
    client.start(onDiscovery, () => {}, 30_000, "0.0.0.0");
  const listen = (): (typeof dgramMock.sockets)[number] => dgramMock.sockets[dgramMock.sockets.length - 2];
  const scan = (): (typeof dgramMock.sockets)[number] => dgramMock.sockets[dgramMock.sockets.length - 1];

  it("the listen socket on 4002 is NOT shared (no reuseAddr) — a second process fails loudly (A5)", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    start(client);
    expect(listen().opts).toBe("udp4");
    client.stop();
  });

  it("a busy port 4002 reports itself and the channel counts as not listening (A5, N1)", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    const busy: string[] = [];
    client.onListenPortBusy = m => busy.push(m);
    start(client);
    expect(client.isListening()).toBe(true);
    const err = Object.assign(new Error("bind EADDRINUSE"), { code: "EADDRINUSE" });
    for (const h of listen().handlers.error ?? []) {
      h(err);
    }
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContain("already in use by another process");
    expect(client.isListening()).toBe(false);
    client.stop();
  });

  it("a stopped client no longer counts as listening (N1)", () => {
    const client = new GoveeLanClient(lanLog, lanTimers);
    start(client);
    expect(client.isListening()).toBe(true);
    client.stop();
    expect(client.isListening()).toBe(false);
  });

  it("a scan reply without `ip` is a device all the same — the address is the UDP source (M2)", () => {
    const found: Array<{ ip: string; sku: string }> = [];
    const client = new GoveeLanClient(lanLog, lanTimers);
    start(client, d => found.push(d as { ip: string; sku: string }));
    const reply = Buffer.from(
      JSON.stringify({ msg: { cmd: "scan", data: { device: "AA:BB:CC:DD:EE:FF:00:11", sku: "H6076" } } }),
    );
    for (const h of listen().handlers.message ?? []) {
      h(reply, { address: "192.168.1.77" });
    }
    expect(found).toEqual([{ ip: "192.168.1.77", device: "AA:BB:CC:DD:EE:FF:00:11", sku: "H6076" }]);
    client.stop();
  });

  it("a throwing discovery handler is a handler failure, not a parse failure (A9)", () => {
    const debugs: string[] = [];
    const client = new GoveeLanClient({ ...lanLog, debug: (m: string) => debugs.push(m) }, lanTimers);
    start(client, () => {
      throw new Error("consumer broke");
    });
    const reply = Buffer.from(JSON.stringify({ msg: { cmd: "scan", data: { device: "AA:BB", sku: "H6076" } } }));
    for (const h of listen().handlers.message ?? []) {
      h(reply, { address: "192.168.1.78" });
    }
    expect(debugs.some(d => d.includes("scan handler failed") && d.includes("consumer broke"))).toBe(true);
    expect(debugs.some(d => d.includes("Failed to parse"))).toBe(false);
    client.stop();
  });

  it("the scan also asks every device address seen, and nothing outside the selected interface", () => {
    const intervals: Array<() => void> = [];
    const timers = { ...lanTimers, setInterval: (cb: () => void) => (intervals.push(cb), intervals.length) } as never;
    osMock.interfaces = {
      en0: [osMock.nic("192.168.1.5", "255.255.255.0")],
      en1: [osMock.nic("10.20.0.3", "255.255.0.0")],
    };
    const client = new GoveeLanClient(lanLog, timers);
    client.start(
      () => {},
      () => {},
      30_000,
      "192.168.1.5",
    );
    const reply = Buffer.from(JSON.stringify({ msg: { cmd: "scan", data: { device: "AA:BB:CC:DD", sku: "H6076" } } }));
    for (const h of listen().handlers.message ?? []) {
      h(reply, { address: "192.168.1.79" });
    }
    const before = scan().sends.length;
    intervals[0]();
    expect(
      scan()
        .sends.slice(before)
        .map(t => t.address),
    ).toEqual(["239.255.255.250", "192.168.1.255", "192.168.1.79"]);
    client.stop();
    osMock.interfaces = osMock.standard();
  });

  it("all interfaces broadcast into every card's own network, never the limited broadcast", () => {
    osMock.interfaces = {
      lo0: [osMock.nic("127.0.0.1", "255.0.0.0", true)],
      en0: [osMock.nic("192.168.1.5", "255.255.255.0")],
      en1: [osMock.nic("10.20.0.3", "255.255.0.0")],
    };
    const client = new GoveeLanClient(lanLog, lanTimers);
    start(client);
    const addresses = scan().sends.map(t => t.address);
    expect(addresses).toEqual(["239.255.255.250", "192.168.1.255", "10.20.255.255"]);
    expect(addresses).not.toContain("255.255.255.255");
    client.stop();
    osMock.interfaces = osMock.standard();
  });
});

describe("interfaceBroadcasts — the scan's broadcast targets come from the selected interface", () => {
  const nic = osMock.nic as (a: string, m: string, i?: boolean) => never;

  it("a selected address yields only its own network's broadcast", () => {
    const ifaces = { en0: [nic("192.168.1.5", "255.255.255.0")], en1: [nic("10.20.0.3", "255.255.0.0")] };
    expect(interfaceBroadcasts("10.20.0.3", ifaces)).toEqual(["10.20.255.255"]);
  });

  it("a /23 gets its real broadcast, not the /24 one", () => {
    expect(interfaceBroadcasts("192.168.2.10", { en0: [nic("192.168.2.10", "255.255.254.0")] })).toEqual([
      "192.168.3.255",
    ]);
  });

  it("all interfaces: every non-internal IPv4 card, each network once", () => {
    const ifaces = {
      lo0: [nic("127.0.0.1", "255.0.0.0", true)],
      en0: [nic("192.168.1.5", "255.255.255.0"), nic("192.168.1.6", "255.255.255.0")],
      en1: [nic("10.20.0.3", "255.255.0.0")],
      en2: [{ ...(nic("fe80::1", "ffff:ffff:ffff:ffff::") as object), family: "IPv6" } as never],
    };
    expect(interfaceBroadcasts(undefined, ifaces)).toEqual(["192.168.1.255", "10.20.255.255"]);
  });

  it("a selected address the host no longer has yields none", () => {
    expect(interfaceBroadcasts("192.168.9.9", { en0: [nic("192.168.1.5", "255.255.255.0")] })).toEqual([]);
  });

  it("a /31 or /32 has no broadcast", () => {
    const ifaces = { tun0: [nic("10.8.0.2", "255.255.255.255")], p2p: [nic("10.9.0.0", "255.255.255.254")] };
    expect(interfaceBroadcasts(undefined, ifaces)).toEqual([]);
  });
});
