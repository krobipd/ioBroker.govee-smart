import { describe, it, expect } from "vitest";
import { Anonymiser } from "./anonymiser";

describe("Anonymiser", () => {
  describe("stability — the property the whole thing exists for", () => {
    it("gives the same real value the same marker every time", () => {
      const a = new Anonymiser();
      const first = a.ip("10.0.0.5");
      expect(a.ip("10.0.0.5")).toBe(first);
      expect(a.text("sent to 10.0.0.5")).toBe(`sent to ${first}`);
    });

    it("gives different values different markers", () => {
      const a = new Anonymiser();
      expect(a.ip("10.0.0.5")).not.toBe(a.ip("10.0.0.6"));
    });

    it("keeps two mentions of one device linkable across separate fields", () => {
      // Blanking everything to *** would satisfy privacy and destroy the
      // report: half of a diagnosis is "are these two lines about the same
      // device". This is that guarantee.
      const a = new Anonymiser();
      const walked = a.walk({
        send: { ip: "192.168.1.36", cmd: "ptReal" },
        log: "no reply from 192.168.1.36 after 3 tries",
        other: "192.168.1.99 answered",
      }) as { send: { ip: string }; log: string; other: string };
      const marker = walked.send.ip;
      expect(walked.log).toContain(marker);
      expect(walked.other).not.toContain(marker);
    });
  });

  describe("scope survives, the address does not", () => {
    it("marks private, link-local and public ranges apart", () => {
      const a = new Anonymiser();
      expect(a.ip("10.0.0.5")).toMatch(/^address-local-/);
      expect(a.ip("192.168.1.36")).toMatch(/^address-local-/);
      expect(a.ip("172.16.4.2")).toMatch(/^address-local-/);
      // DHCP failed — itself a diagnosis, so it must stay distinguishable.
      expect(a.ip("169.254.1.7")).toMatch(/^address-local-/);
      expect(a.ip("52.28.14.9")).toMatch(/^address-public-/);
    });

    it("does not leak the original anywhere in the result", () => {
      const a = new Anonymiser();
      const out = JSON.stringify(a.walk({ a: "10.47.88.2", b: ["10.47.88.2"], c: { d: "x 10.47.88.2 y" } }));
      expect(out).not.toContain("10.47.88.2");
    });
  });

  describe("what must NOT be treated as an address", () => {
    it("leaves a short colon-separated hex run alone", () => {
      // Regression: the first IPv6 pattern matched "two or more hex groups" and
      // turned a shortened device id into an address marker, silently corrupting
      // the report. Only eight full groups or a `::` form is an address.
      const a = new Anonymiser();
      expect(a.text('{"device":"AA:BB:CC"}')).toBe('{"device":"AA:BB:CC"}');
    });

    it("still catches a real IPv6", () => {
      const a = new Anonymiser();
      expect(a.text("endpoint 2001:0db8:85a3:0000:0000:8a2e:0370:7334 up")).toMatch(/endpoint address-local-1 up/);
      expect(a.text("bound to fe80::1")).not.toContain("fe80::1");
    });

    it("leaves ordinary numbers and versions alone", () => {
      const a = new Anonymiser();
      expect(a.text("adapter 2.29.0 on node 22.22.2")).toBe("adapter 2.29.0 on node 22.22.2");
    });
  });

  describe("identifiers", () => {
    it("keeps a device id's last four characters — the object-tree folder name", () => {
      const a = new Anonymiser();
      expect(a.deviceId("AA:BB:CC:DD:EE:FF:1D:6F")).toBe("id-…1d6f");
      expect(a.text("device AA:BB:CC:DD:EE:FF:1D:6F offline")).toBe("device id-…1d6f offline");
    });

    it("replaces mail addresses", () => {
      const a = new Anonymiser();
      const out = a.text("login failed for someone@example.com");
      expect(out).not.toContain("someone@example.com");
      expect(out).toMatch(/^login failed for mail-1$/);
    });

    it("replaces device names it is told about, and only real ones", () => {
      const a = new Anonymiser();
      const out = a.text("Lisa Bedroom went offline", ["Lisa Bedroom"]);
      expect(out).not.toContain("Lisa Bedroom");
      expect(out).toMatch(/^device-1 went offline$/);
      // A one- or two-character name would match half the report — ignored.
      expect(a.text("on and off", ["on"])).toBe("on and off");
    });
  });

  describe("values that have no shape — found by their key (issue #50)", () => {
    it("replaces the network name with a marker, the same network with the same marker", () => {
      // Govee's account list carries the SSID in every device's settings. Three
      // published exports (#46, #47, #50) showed it in clear: a village name and
      // two first names.
      const a = new Anonymiser();
      const out = a.walk({
        one: { settings: { wifiName: "Jenny & Mirko" } },
        two: { settings: { wifiName: "Jenny & Mirko" } },
        three: { settings: { WIFINAME: "Barmdorf2" }, ssid: "Barmdorf2" },
      }) as Record<string, { settings: { wifiName?: string; WIFINAME?: string }; ssid?: string }>;
      const text = JSON.stringify(out);
      expect(text).not.toContain("Jenny");
      expect(text).not.toContain("Barmdorf2");
      expect(out.one.settings.wifiName).toBe("wifi-1");
      expect(out.two.settings.wifiName).toBe("wifi-1");
      expect(out.three.settings.WIFINAME).toBe("wifi-2");
      expect(out.three.ssid).toBe("wifi-2");
    });

    it("replaces the Matter id", () => {
      const a = new Anonymiser();
      expect(a.walk({ matterId: "E7A62E99C277DF59" })).toEqual({ matterId: "matter-1" });
    });

    it("leaves an empty network name empty — nothing to hide, and a marker would claim a network", () => {
      const a = new Anonymiser();
      expect(a.walk({ wifiName: "" })).toEqual({ wifiName: "" });
    });

    it("gives the app's internal device number a marker", () => {
      const a = new Anonymiser();
      const out = a.walk({ deviceId: 49595162, again: { deviceId: 49595162 } }) as {
        deviceId: string;
        again: { deviceId: string };
      };
      expect(out.deviceId).toBe("app-id-1");
      expect(out.again.deviceId).toBe("app-id-1");
    });

    it("shortens a group id like a device id, under either key and in either type", () => {
      const a = new Anonymiser();
      expect(a.walk({ deviceId: "12345678", groupId: 12345678, g: { groupId: "12345678" } })).toEqual({
        deviceId: "id-…5678",
        groupId: "id-…5678",
        g: { groupId: "id-…5678" },
      });
    });

    it("keeps Govee's `groupId: 0` (in no group) and leaves a hex id to its own rule", () => {
      const a = new Anonymiser();
      expect(a.walk({ groupId: 0, deviceId: "AA:BB:CC:DD:EE:FF:1D:6F" })).toEqual({
        groupId: 0,
        deviceId: "id-…1d6f",
      });
    });

    it("is idempotent — a second pass leaves every key-based marker as it is", () => {
      const a = new Anonymiser();
      const once = a.walk({ wifiName: "Home", matterId: "M1", deviceId: 42, groupId: 12345678 });
      expect(a.walk(once)).toEqual(once);
    });
  });

  describe("group ids inside text — found by lookup, like names", () => {
    it("replaces a known digit id wherever it stands on its own", () => {
      const a = new Anonymiser();
      const out = a.text("group 12345678 fan-out; key BaseGroup:12345678; prefix groups.12345678", [], ["12345678"]);
      expect(out).not.toContain("12345678");
      expect(out).toBe("group id-…5678 fan-out; key BaseGroup:id-…5678; prefix groups.id-…5678");
    });

    it("does not touch the same digits inside a longer number", () => {
      const a = new Anonymiser();
      expect(a.text("at 1790098123456789 ms", [], ["123456"])).toBe("at 1790098123456789 ms");
    });

    it("ignores ids shorter than six digits — they would hit byte counts and times", () => {
      const a = new Anonymiser();
      expect(a.text("sent 12345 bytes", [], ["12345"])).toBe("sent 12345 bytes");
    });
  });

  describe("walk", () => {
    it("pseudonymises keys as well as values", () => {
      // A Govee response can key a map by device id.
      const a = new Anonymiser();
      const out = a.walk({ "AA:BB:CC:DD:EE:FF:1D:6F": { ip: "10.0.0.5" } }) as Record<string, { ip: string }>;
      expect(Object.keys(out)).toEqual(["id-…1d6f"]);
    });

    it("leaves non-strings untouched", () => {
      const a = new Anonymiser();
      expect(a.walk({ n: 5, b: true, z: null, u: undefined })).toEqual({ n: 5, b: true, z: null, u: undefined });
    });

    it("is idempotent — running twice does not re-mark a marker", () => {
      // The collector pseudonymises on intake and once more over the whole
      // report, so this has to hold or markers would drift.
      const a = new Anonymiser();
      const once = a.walk({ ip: "10.0.0.5" });
      expect(a.walk(once)).toEqual(once);
    });
  });
});
