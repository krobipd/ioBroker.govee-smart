import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COUNTERPARTS, counterpartFor, counterpartNamed, limitOf } from "./api-limits";
import { CLOUD_LIMITS } from "./timing-constants";

const src = (file: string): string => fs.readFileSync(path.join(__dirname, file), "utf8");

describe("api-limits.json — every counterpart the adapter calls, once (GV-08)", () => {
  it("every entry has a name, a match and limits in the audited form", () => {
    for (const c of COUNTERPARTS) {
      expect(c.name.trim(), JSON.stringify(c)).not.toBe("");
      expect(Object.keys(c.match).length, c.name).toBeGreaterThan(0);
      expect(c.match.host !== undefined && c.match.hostPattern !== undefined, c.name).toBe(false);
      for (const l of c.limits) {
        expect(Object.keys(l).sort(), c.name).toEqual(["max", "per", "seconds", "source"]);
        expect(Number.isInteger(l.max) && l.max > 0, c.name).toBe(true);
        expect(l.seconds, c.name).toBeGreaterThan(0);
        expect(["account", "host"], c.name).toContain(l.per);
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
    const events = /mqtts:\/\/([a-z0-9.-]+):(\d+)/.exec(src("govee-openapi-mqtt-client.ts"));
    expect(counterpartFor("tcp-write", events![1], Number(events![2]))?.name).toBe("Govee OpenAPI events (MQTT)");
    expect(counterpartFor("tcp", events![1], Number(events![2]))?.name).toBe("Govee OpenAPI events (MQTT)");
  });

  it("the account broker's pattern takes an account endpoint, not the events broker or another port", () => {
    expect(counterpartFor("tcp-write", "a1b2c3d4e5f6g7-ats.iot.eu-central-1.amazonaws.com", 8883)?.name).toBe(
      "Govee account broker (AWS IoT MQTT)",
    );
    expect(counterpartFor("tcp", "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com", 8883)?.name).toBe(
      "Govee account broker (AWS IoT MQTT)",
    );
    expect(counterpartFor("tcp-write", "a1b2c3-ats.iot.eu-central-1.amazonaws.com", 443)).toBeUndefined();
    expect(counterpartFor("tcp-write", "evil.example.com", 8883)).toBeUndefined();
  });

  it("LAN discovery and control are declared per host on their ports", () => {
    expect(counterpartFor("udp", "239.255.255.250", 4001)?.name).toBe("Govee LAN discovery");
    expect(counterpartFor("udp", "192.168.1.20", 4003)?.name).toBe("Govee LAN control");
    expect(counterpartNamed("Govee LAN control").limits.every(l => l.per === "host")).toBe(true);
  });

  it("the rate limiter's daily OpenAPI budget is the file's number", () => {
    expect(CLOUD_LIMITS.perDay).toBe(limitOf("Govee OpenAPI (REST)", 86_400).max);
  });

  it("a counterpart or limit the code names but the file lacks fails loudly", () => {
    expect(() => counterpartNamed("nope")).toThrow(/declares no counterpart/);
    expect(() => limitOf("Govee LAN control", 7)).toThrow(/no 7 s limit/);
  });
});
