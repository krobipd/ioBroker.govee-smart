import { describe, expect, it } from "vitest";
import { Placeholders, leaked } from "./diagnostics/placeholders";
import { littleEndianIpv4, pseudonymiseReport } from "./report-placeholders";

const run = (report: unknown, names: string[] = [], digitIds: string[] = []): string =>
  JSON.stringify(pseudonymiseReport(report, { names, digitIds }, new Placeholders()));

describe("pseudonymiseReport — the Govee values no form pattern finds", () => {
  it("an account or device topic keeps its prefix, its hex becomes a placeholder — also inside text", () => {
    const out = run({ topic: "GA/0badc0de0badc0de0badc0de0badc0de", log: "push on GD/feedfacefeedfacefeedface" });
    expect(out).toMatch(/GA\/topic-1/);
    expect(out).toMatch(/GD\/topic-2/);
    expect(leaked(out, ["0badc0de0badc0de0badc0de0badc0de", "feedfacefeedfacefeedface"])).toEqual([]);
  });

  it("lanInfo.addr is the device's IPv4 as a little-endian number — as an object field and inside JSON text", () => {
    expect(littleEndianIpv4(604045834)).toBe("10.2.1.36");
    const out = run({
      lanInfo: { addr: 604045834 },
      rawJson: JSON.stringify({ lanInfo: { addr: 604045834 } }),
      escaped: JSON.stringify(JSON.stringify({ addr: 604045834 })),
      other: "seen at 10.2.1.36",
    });
    expect(out).not.toContain("604045834");
    expect(out).not.toContain("10.2.1.36");
    // one address, one placeholder — the number and the dotted form are the same device
    expect(out.match(/address-\d+/g)?.every(m => m === "address-1")).toBe(true);
  });

  it("a network name and a Matter id are replaced by key, and wherever else they stand", () => {
    const out = run({
      settings: { wifiName: "Huber Familie 5G", matterId: "CAFEBABE0D15EA5E" },
      raw: '{"wifiName":"Huber Familie 5G"}',
      escaped: '{\\"ssid\\":\\"Huber Familie 5G\\"}',
      log: "joined Huber Familie 5G",
    });
    expect(leaked(out, ["Huber Familie 5G", "CAFEBABE0D15EA5E"])).toEqual([]);
    expect(out).toContain('"wifiName":"wifi-1"');
    expect(out).toContain('"matterId":"matter-1"');
  });

  it("the app's device number and a group id become placeholders; a groupId of 0 stays", () => {
    const out = run({ deviceId: 98765432, groupId: 7654321, none: { groupId: 0 }, text: '{"deviceId":98765432}' });
    expect(out).not.toContain("98765432");
    expect(out).not.toContain("7654321");
    expect(out).toContain('"groupId":0');
    expect(out).toMatch(/app-id-1/);
  });

  it("a known digit id is replaced as a whole number — never inside a longer one like a timestamp", () => {
    const out = run({ log: "group 7654321 at 1790076543210 and 97654321" }, [], ["7654321"]);
    expect(out).toContain("group group-1 at 1790076543210 and 97654321");
  });

  it("a Govee device id next to a colon is still one id", () => {
    const out = run({ seen: ["AA:BB:CC:DD:EE:FF:1D:6F:10.0.0.1"], key: "H6172:AA:BB:CC:DD:EE:FF:00:11" });
    expect(out).not.toMatch(/AA:BB:CC:DD:EE:FF/i);
    expect(out).not.toContain("10.0.0.1");
    expect(out).toMatch(/H6172:mac-\d+/);
  });

  it("names the user gave are replaced as whole words; a name shorter than three characters is no name", () => {
    const out = run({ name: "Jennys Leselampe", note: "Jennys Leselampe and Jennys Leselampen", tiny: "on" }, [
      "Jennys Leselampe",
      "on",
    ]);
    expect(out).toContain('"name":"name-1"');
    expect(out).toContain("name-1 and Jennys Leselampen");
    expect(out).toContain('"tiny":"on"');
  });
});
