import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUNTERPARTS,
  counterpartFor,
  counterpartNamed,
  counterpartsFor,
  deviceOf,
  fits,
  isPrivateHost,
  limitOf,
  type LimitedCall,
} from "./api-limits";
import { GoveeCloudClient } from "./govee-cloud-client";
import { CLOUD_LIMITS } from "./timing-constants";
import { mockLog } from "../../test/test-helpers";

const src = (file: string): string => fs.readFileSync(path.join(__dirname, file), "utf8");

describe("api-limits.json — every counterpart the adapter calls, once (GV-08)", () => {
  it("every entry has a name, a match and limits in the audited form", () => {
    for (const c of COUNTERPARTS) {
      expect(c.name.trim(), JSON.stringify(c)).not.toBe("");
      expect(Object.keys(c.match).length, c.name).toBeGreaterThan(0);
      // exactly one address: a host, a host pattern or the private network (round 171)
      expect(
        [c.match.host, c.match.hostPattern, c.match.network].filter(a => a !== undefined),
        c.name,
      ).toHaveLength(1);
      for (const l of c.limits) {
        expect(Object.keys(l).sort(), c.name).toEqual(["max", "per", "seconds", "source"]);
        expect(Number.isInteger(l.max) && l.max > 0, c.name).toBe(true);
        expect(l.seconds, c.name).toBeGreaterThan(0);
        expect(["account", "host", "device"], c.name).toContain(l.per);
        if (l.per === "device") {
          expect(`${c.match.pathPattern ?? ""}${c.match.bodyPattern ?? ""}`, c.name).toContain("(?<device>");
        }
        expect(l.source.trim().length, c.name).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("declares every host the code calls — read from the clients, not from memory", () => {
    const hosts = [
      ...src("govee-cloud-client.ts").matchAll(/https:\/\/([a-z0-9.-]+)/g),
      ...src("govee-constants.ts").matchAll(/"https:\/\/([a-z0-9.-]+)"/g),
      ...src("handlers/app-version.ts").matchAll(/https:\/\/([a-z0-9.-]+)/g),
    ].map(m => m[1]);
    expect(hosts.length).toBeGreaterThanOrEqual(3);
    for (const host of hosts) {
      expect(counterpartFor("http", host)?.name, host).toBeDefined();
    }
    const events = /const BROKER_HOST = "([a-z0-9.-]+)"/.exec(src("govee-openapi-mqtt-client.ts"));
    expect(counterpartFor("tcp-write", events![1], 8883)?.name).toBe("Govee OpenAPI events (MQTT)");
    expect(counterpartFor("tcp", events![1], 8883)?.name).toBe("Govee OpenAPI events connection (MQTT)");
  });

  it("the account broker's pattern takes an account endpoint, not the events broker or another port", () => {
    expect(counterpartFor("tcp-write", "a1b2c3d4e5f6g7-ats.iot.eu-central-1.amazonaws.com", 8883)?.name).toBe(
      "Govee account broker (AWS IoT MQTT)",
    );
    expect(counterpartFor("tcp", "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com", 8883)?.name).toBe(
      "Govee account broker connection (AWS IoT MQTT)",
    );
    expect(counterpartFor("tcp-write", "a1b2c3-ats.iot.eu-central-1.amazonaws.com", 443)).toBeUndefined();
    expect(counterpartFor("tcp-write", "evil.example.com", 8883)).toBeUndefined();
  });

  it("LAN discovery and control are declared per host on their ports, in the private network only", () => {
    expect(counterpartFor("udp", "239.255.255.250", 4001)?.name).toBe("Govee LAN discovery");
    expect(counterpartFor("udp", "192.168.1.255", 4001)?.name).toBe("Govee LAN discovery");
    expect(counterpartFor("udp", "192.168.1.20", 4003)?.name).toBe("Govee LAN control");
    expect(counterpartFor("udp", "127.0.0.1", 4003)?.name).toBe("Govee LAN control");
    expect(counterpartFor("udp", "8.8.8.8", 4003)).toBeUndefined();
    expect(counterpartNamed("Govee LAN control").limits.every(l => l.per === "host")).toBe(true);
  });

  it("the private network is the fleet's: RFC 1918, loopback, link-local, multicast, broadcast, .local, IPv6 ULA", () => {
    for (const host of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "127.0.0.1", "169.254.1.1"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of [
      "239.255.255.250",
      "224.0.0.251",
      "255.255.255.255",
      "lamp.local",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "openapi.api.govee.com", "2001:db8::1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("an OpenAPI call counts for its endpoint and for the host — Govee's documented windows per actor", () => {
    const body = (device: string): string =>
      JSON.stringify({ requestId: "state-1", payload: { sku: "H6199", device } });
    const names = (call: Parameters<typeof counterpartsFor>[0]): string[] => counterpartsFor(call).map(c => c.name);
    const host = "openapi.api.govee.com";
    expect(names({ kind: "http", host, method: "GET", path: "/router/api/v1/user/devices" })).toEqual([
      "Govee OpenAPI (REST)",
      "Govee OpenAPI device list",
    ]);
    for (const endpoint of ["state", "scenes", "diy-scenes"]) {
      expect(
        names({ kind: "http", host, method: "POST", path: `/router/api/v1/device/${endpoint}`, body: body("A") }),
      ).toEqual(["Govee OpenAPI (REST)", "Govee OpenAPI device reads"]);
    }
    expect(
      names({ kind: "http", host, method: "POST", path: "/router/api/v1/device/control", body: body("A") }),
    ).toEqual(["Govee OpenAPI (REST)", "Govee OpenAPI device control"]);
    // the path alone does not fit: the method and the device in the body are part of the endpoint
    expect(names({ kind: "http", host, method: "POST", path: "/router/api/v1/device/state" })).toEqual([
      "Govee OpenAPI (REST)",
    ]);
    expect(
      names({ kind: "http", host, method: "GET", path: "/router/api/v1/device/control", body: body("A") }),
    ).toEqual(["Govee OpenAPI (REST)"]);
    expect(
      names({ kind: "http", host, method: "POST", path: "/router/api/v1/device/statex", body: body("A") }),
    ).toEqual(["Govee OpenAPI (REST)"]);
  });

  it("the device of a per-device window is the one the body names — as the fleet reads it", () => {
    const reads = counterpartNamed("Govee OpenAPI device reads");
    const call = {
      kind: "http",
      host: "openapi.api.govee.com",
      method: "POST",
      path: "/router/api/v1/device/state",
      body: JSON.stringify({ requestId: "state-7", payload: { sku: "H6199", device: "AA:BB:CC:DD:EE:FF:00:11" } }),
    };
    expect(fits(call, reads.match)).toBe(true);
    expect(deviceOf(call, reads.match)).toBe("AA:BB:CC:DD:EE:FF:00:11");
    expect(deviceOf({ ...call, body: "{}" }, reads.match)).toBeUndefined();
  });

  it("every OpenAPI call the cloud client makes falls in its endpoint's window under its own device", async () => {
    // the fleet's network hook keeps the first 1024 characters of a body; a device behind them would pool every
    // call in one lane "device unknown"
    const sent: LimitedCall[] = [];
    const client = new GoveeCloudClient("key", mockLog, options => {
      const url = new URL(options.url);
      sent.push({
        kind: "http",
        host: url.hostname,
        method: options.method,
        path: url.pathname,
        body: options.body ? JSON.stringify(options.body).slice(0, 1024) : undefined,
      });
      return Promise.resolve({
        value: { code: 200, data: [], payload: { capabilities: [] } },
        statusCode: 200,
      } as never);
    });
    const device = "AA:BB:CC:DD:EE:FF:00:11";
    await client.getDevices();
    await client.getDeviceState("H6199", device);
    await client.getScenes("H6199", device);
    await client.getDiyScenes("H6199", device);
    await client.controlDevice("H6199", device, "devices.capabilities.segment_color_setting", "segmentedColorRgb", {
      segment: Array.from({ length: 56 }, (_, i) => i),
      rgb: 0xffffff,
    });
    const endpoint = (call: LimitedCall): string | undefined =>
      counterpartsFor(call).find(c => c.name !== "Govee OpenAPI (REST)")?.name;
    expect(sent.map(endpoint)).toEqual([
      "Govee OpenAPI device list",
      "Govee OpenAPI device reads",
      "Govee OpenAPI device reads",
      "Govee OpenAPI device reads",
      "Govee OpenAPI device control",
    ]);
    for (const call of sent.slice(1)) {
      const c = counterpartsFor(call).find(d => d.name !== "Govee OpenAPI (REST)")!;
      expect(deviceOf(call, c.match), call.path).toBe(device);
    }
  });

  it("the rate limiter's windows are the declared counterparts themselves — its pace comes only from the file", () => {
    expect(CLOUD_LIMITS["account-list"]).toEqual([
      counterpartNamed("Govee OpenAPI device list"),
      counterpartNamed("Govee OpenAPI (REST)"),
    ]);
    expect(CLOUD_LIMITS["device-read"][0]).toBe(counterpartNamed("Govee OpenAPI device reads"));
    expect(CLOUD_LIMITS["device-control"][0]).toBe(counterpartNamed("Govee OpenAPI device control"));
    expect(CLOUD_LIMITS.appapi).toEqual([counterpartNamed("Govee App API libraries")]);
    for (const kind of ["account-list", "device-read", "device-control"] as const) {
      expect(CLOUD_LIMITS[kind].at(-1)).toBe(counterpartNamed("Govee OpenAPI (REST)"));
    }
    expect(limitOf("Govee OpenAPI (REST)", 86_400).max).toBe(9000);
  });

  it("a counterpart or limit the code names but the file lacks fails loudly", () => {
    expect(() => counterpartNamed("nope")).toThrow(/declares no counterpart/);
    expect(() => limitOf("Govee LAN control", 7)).toThrow(/no 7 s limit/);
  });
});
