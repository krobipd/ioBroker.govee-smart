import { installLogPrefix, keepChannelChanges, type ChannelStatusSnapshot } from "./log-prefix";

function makeLog(): { log: ioBroker.Logger; lines: Record<string, string[]> } {
  const lines: Record<string, string[]> = { silly: [], debug: [], info: [], warn: [], error: [] };
  const log = {
    silly: (m: string) => lines.silly.push(m),
    debug: (m: string) => lines.debug.push(m),
    info: (m: string) => lines.info.push(m),
    warn: (m: string) => lines.warn.push(m),
    error: (m: string) => lines.error.push(m),
    level: "debug",
  } as unknown as ioBroker.Logger;
  return { log, lines };
}

describe("installLogPrefix", () => {
  const snap: ChannelStatusSnapshot = { lan: "on", cloud: "off", mqtt: "n/a", openapi: "n/a" };

  it("prefixes debug and silly lines with the channel status", () => {
    const { log, lines } = makeLog();
    installLogPrefix(log, () => snap);
    log.debug("scan sent");
    log.silly("raw bytes");
    expect(lines.debug[0]).toBe("[LAN=on Cloud=off MQTT=n/a OpenAPI=n/a] scan sent");
    expect(lines.silly[0]).toBe("[LAN=on Cloud=off MQTT=n/a OpenAPI=n/a] raw bytes");
  });

  it("leaves info/warn/error untouched — user-facing lines stay clean", () => {
    const { log, lines } = makeLog();
    installLogPrefix(log, () => snap);
    log.info("adapter ready");
    log.warn("cloud failed");
    log.error("boom");
    expect(lines.info[0]).toBe("adapter ready");
    expect(lines.warn[0]).toBe("cloud failed");
    expect(lines.error[0]).toBe("boom");
  });

  it("pulls the snapshot at log-call time, not install time", () => {
    const { log, lines } = makeLog();
    const live: ChannelStatusSnapshot = { lan: "off", cloud: "n/a", mqtt: "n/a", openapi: "n/a" };
    installLogPrefix(log, () => live);
    log.debug("before");
    live.lan = "on";
    log.debug("after");
    expect(lines.debug[0]).toContain("[LAN=off");
    expect(lines.debug[1]).toContain("[LAN=on");
  });

  it("is idempotent — a second install must not double the prefix", () => {
    const { log, lines } = makeLog();
    installLogPrefix(log, () => snap);
    installLogPrefix(log, () => snap);
    log.debug("once");
    expect(lines.debug[0]).toBe("[LAN=on Cloud=off MQTT=n/a OpenAPI=n/a] once");
    expect(lines.debug[0].match(/\[LAN=/g)).toHaveLength(1);
  });
});

describe("keepChannelChanges — the report keeps the channel prefix only where it changed", () => {
  it("drops a prefix that repeats the one above, keeps every change and leaves lines without one alone", () => {
    // Lines as the H6199 report of #57 carried them: the same four channels on every debug line, ~10 KB of the report.
    const lines = [
      "[LAN=off Cloud=off MQTT=off OpenAPI=off] device-registry: 636 entries loaded",
      "[LAN=off Cloud=off MQTT=off OpenAPI=off] Govee app version: using 7.7.02",
      "Starting (LAN, Cloud, MQTT) — please wait",
      "[LAN=off Cloud=off MQTT=off OpenAPI=off] MQTT: trying cached credentials",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] LAN listening on port 4002",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] Cache loaded",
    ].map(msg => ({ ts: "2026-10-18T15:49:48.454Z", level: "debug", msg }));
    expect(keepChannelChanges(lines).map(l => l.msg)).toEqual([
      "[LAN=off Cloud=off MQTT=off OpenAPI=off] device-registry: 636 entries loaded",
      "Govee app version: using 7.7.02",
      "Starting (LAN, Cloud, MQTT) — please wait",
      "MQTT: trying cached credentials",
      "[LAN=on Cloud=off MQTT=off OpenAPI=off] LAN listening on port 4002",
      "Cache loaded",
    ]);
    // the input is not changed — the report must never change the ring
    expect(lines[1].msg).toBe("[LAN=off Cloud=off MQTT=off OpenAPI=off] Govee app version: using 7.7.02");
  });
});
