import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { decodeApplianceFrames } from "./appliance-frames";
import { createTestDevice } from "./test-helpers";
import type { CloudCapability, GoveeDevice } from "./types";

/** The H7127's declared capabilities — issue #47, 2.34.0 export (`capabilities`). */
const H7127_CAPS: CloudCapability[] = [
  {
    type: "devices.capabilities.on_off",
    instance: "powerSwitch",
    parameters: {
      dataType: "ENUM",
      options: [
        { name: "on", value: 1 },
        { name: "off", value: 0 },
      ],
    },
  },
  {
    type: "devices.capabilities.work_mode",
    instance: "workMode",
    parameters: {
      dataType: "STRUCT",
      fields: [
        {
          fieldName: "workMode",
          dataType: "ENUM",
          options: [
            { name: "gearMode", value: 1 },
            { name: "Custom", value: 2 },
            { name: "Auto", value: 3 },
          ],
          required: true,
        },
        {
          fieldName: "modeValue",
          dataType: "ENUM",
          options: [
            {
              name: "gearMode",
              options: [
                { name: "Sleep", value: 1 },
                { name: "Low", value: 2 },
                { name: "High", value: 3 },
              ],
            },
            { name: "Custom", defaultValue: 0 },
            { name: "Auto", defaultValue: 0 },
          ],
          required: true,
        },
      ],
    },
  },
  { type: "devices.capabilities.property", instance: "filterLifeTime" },
  { type: "devices.capabilities.property", instance: "airQuality" },
];

const purifier = (): GoveeDevice =>
  createTestDevice({
    sku: "H7127",
    deviceId: "AA:BB:CC:DD:EE:11",
    type: "devices.types.air_purifier",
    lanIp: undefined,
    capabilities: H7127_CAPS,
    channels: { lan: false, mqtt: true, cloud: true },
  });

// status x_1789105586836013, 2026-09-11 05:46:28 Z — Custom mode, last manual
// level 3, air quality 6, filter 72 % (the cloud read of the same export says
// workMode 2 / modeValue 0, airQuality 6, filterLifeTime 72).
const PUSH_2026_09_11 = [
  "qhcAAAAAAAAAAAAAAAAAAAAAAL0=",
  "qhkA//8GAEgAAAAAAAAAAAAAAP0=",
  "qhIAAAAAAAAAAAAAAAAAAAAAALg=",
  "qiYAAAAAAAAAAAAAAAAAAAAAAIw=",
  "qgUAAgAAAAAAAAAAAAAAAAAAAK0=",
  "qgUBAwAAAAAAAAAAAAAAAAAAAK0=",
  "qgUCAAMACgAKAgAKAAoB/////60=",
  "qgUDAAAOAAAAAAAAAAAAAAAAAKI=",
  "qhYA/////wAAAAAAAAAAAAAAALw=",
  "qggAAAAAAAAAAAAAAAAAAAAAAKI=",
];
// status o_1789018372832, 2026-09-10 05:32:53 Z — gear mode, level 1, air
// quality 6, filter 73 % (the app showed 73 % that morning).
const PUSH_2026_09_10 = [
  "qhcAAAAAAAAAAAAAAAAAAAAAAL0=",
  "qhkA//8GAEkAAAAAAAAAAAAAAPw=",
  "qhIAAAAAAAAAAAAAAAAAAAAAALg=",
  "qiYAAAAAAAAAAAAAAAAAAAAAAIw=",
  "qgUAAQAAAAAAAAAAAAAAAAAAAK4=",
  "qgUBAQAAAAAAAAAAAAAAAAAAAK8=",
  "qgUCAAMACgAKAgAKAAoB/////60=",
  "qgUDAAAOAAAAAAAAAAAAAAAAAKI=",
  "qhYA/////wAAAAAAAAAAAAAAALw=",
  "qggAAAAAAAAAAAAAAAAAAAAAAKI=",
];

describe("decodeApplianceFrames — H7127 status push (issue #47, spec §11)", () => {
  it("reads mode, level and filter life from the 2026-09-11 packet (Custom mode → level 0, as the cloud reports it)", () => {
    expect(decodeApplianceFrames(purifier(), PUSH_2026_09_11)).toEqual([
      { type: "devices.capabilities.work_mode", instance: "workMode", state: { value: { workMode: 2, modeValue: 0 } } },
      { type: "devices.capabilities.property", instance: "filterLifeTime", state: { value: 72 } },
    ]);
  });

  it("reads the 2026-09-10 packet — gear mode with its level, filter 73 %", () => {
    expect(decodeApplianceFrames(purifier(), PUSH_2026_09_10)).toEqual([
      { type: "devices.capabilities.work_mode", instance: "workMode", state: { value: { workMode: 1, modeValue: 1 } } },
      { type: "devices.capabilities.property", instance: "filterLifeTime", state: { value: 73 } },
    ]);
  });

  it("does not write air quality — byte 5 is measured once and never seen changing", () => {
    expect(decodeApplianceFrames(purifier(), PUSH_2026_09_11).map(c => c.instance)).not.toContain("airQuality");
  });

  it("drops a frame whose checksum does not match, and everything it would have carried", () => {
    const corrupted = PUSH_2026_09_10.map(f =>
      f === "qhkA//8GAEkAAAAAAAAAAAAAAPw=" ? "qhkA//8GAEkAAAAAAAAAAAAAAP0=" : f,
    );
    const out = decodeApplianceFrames(purifier(), corrupted);
    expect(out.map(c => c.instance)).toEqual(["workMode"]);
  });

  it("drops a mode or level the device did not declare — a differently laid-out frame writes nothing", () => {
    const device = purifier();
    // Declared modes 1..3; frame says mode 7 (aa 05 00 07 … xor).
    const mode7 = Buffer.from("aa050007000000000000000000000000000000", "hex");
    const xor = mode7.reduce((a, b) => a ^ b, 0);
    const frames = [Buffer.concat([mode7, Buffer.from([xor])]).toString("base64")];
    expect(decodeApplianceFrames(device, frames)).toEqual([]);
  });

  // Audit 2026-09-12 (T2): raising the plausibility bound from 100 to 255
  // survived the whole suite — a frame claiming 200 % filter life reached the
  // datapoint. Byte 7 is a percentage; anything above 100 is a differently
  // laid-out frame, not a reading.
  it("drops a filter value above 100 % instead of writing it", () => {
    const sensors = Buffer.from("aa1900ffff0600c8000000000000000000000000", "hex").subarray(0, 19);
    const xor = sensors.reduce((a, b) => a ^ b, 0);
    const frame = Buffer.concat([sensors, Buffer.from([xor])]).toString("base64");
    const out = decodeApplianceFrames(purifier(), [frame]);
    expect(out).toEqual([]);
    // …while the same frame with a plausible value is written.
    const ok = Buffer.from("aa1900ffff0600480000000000000000000000", "hex").subarray(0, 19);
    const okFrame = Buffer.concat([ok, Buffer.from([ok.reduce((a, b) => a ^ b, 0)])]).toString("base64");
    expect(decodeApplianceFrames(purifier(), [okFrame])).toEqual([
      { type: "devices.capabilities.property", instance: "filterLifeTime", state: { value: 72 } },
    ]);
  });

  // Audit 2026-09-12 (T3): applying the H7127 decoder to EVERY sku survived —
  // the existing "sku without a decoder" case below uses a device that has no
  // declared capabilities either, so it proves nothing about the sku gate. This
  // one carries the H7127's own capabilities under a foreign sku: only the gate
  // can keep it empty. The rule is explicit in CLAUDE.md — a decoder is valid
  // for the sku whose frames were measured, and for no other.
  it("decodes nothing for a foreign sku that declares the SAME capabilities", () => {
    const foreign = createTestDevice({
      sku: "H7126",
      deviceId: "AA:BB:CC:DD:EE:22",
      type: "devices.types.air_purifier",
      lanIp: undefined,
      capabilities: H7127_CAPS,
      channels: { lan: false, mqtt: true, cloud: true },
    });
    expect(decodeApplianceFrames(foreign, PUSH_2026_09_11)).toEqual([]);
    // the very same packet on the measured sku does decode
    expect(decodeApplianceFrames(purifier(), PUSH_2026_09_11)).toHaveLength(2);
  });

  it("returns [] for a SKU without a decoder, for a light, and for junk", () => {
    expect(
      decodeApplianceFrames(createTestDevice({ sku: "H7131", type: "devices.types.heater" }), PUSH_2026_09_11),
    ).toEqual([]);
    expect(decodeApplianceFrames(createTestDevice(), PUSH_2026_09_11)).toEqual([]);
    expect(decodeApplianceFrames(purifier(), ["not base64!!", 42, null])).toEqual([]);
    expect(decodeApplianceFrames(purifier(), undefined)).toEqual([]);
  });
});

/**
 * The H1741's status packet frames, verbatim from the issue #50 reports — only the `aa 42` frame differs.
 *
 * @param level the base64 `aa 42` frame of the report
 */
function h1741Push(level: string): string[] {
  return [
    "qgUVAAqMAAAAAAAAAAAAAAAAADw=",
    "qqUBZP+NC2T/jQtk/40LZP+NCw4=",
    "qqUCZP+NC2T/jQtk/40LZP+NCw0=",
    "qhEAHg8PAP8yAAAAAAAAAAAAAGg=",
    "qhL/ZAAAgAoA/65UAAAAAAAAAKw=",
    "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    "qkECAAAAAAAAAAAAAAAAAAAAAOk=",
    level,
    "qvEAAAAAAAAAAAAAAAAAAAAAAFs=",
  ];
}

describe("decodeApplianceFrames — H1741 battery (issue #50)", () => {
  const lamp = (): GoveeDevice => createTestDevice({ sku: "H1741", type: "devices.types.light" });
  const battery = (value: number): unknown[] => [
    { type: "devices.capabilities.property", instance: "battery", state: { value } },
  ];

  it("reads the level against the app's battery icon: two of three bars, full, one bar", () => {
    // 2026-09-23 05:13 — the app showed two of three bars.
    expect(decodeApplianceFrames(lamp(), h1741Push("qkIwAAAAAAAAAAAAAAAAAAAAANg="))).toEqual(battery(48));
    // 2026-09-25 13:14 — right after a full charge.
    expect(decodeApplianceFrames(lamp(), h1741Push("qkJQAAAAAAAAAAAAAAAAAAAAALg="))).toEqual(battery(80));
    // 2026-09-26 11:24 — one bar, shortly before the battery saver.
    expect(decodeApplianceFrames(lamp(), h1741Push("qkIgAAAAAAAAAAAAAAAAAAAAAMg="))).toEqual(battery(32));
  });

  it("masks bit 7 — seen only before the lamp was unplugged, its meaning is not measured", () => {
    // 2026-09-25 13:12 — 0xd4.
    expect(decodeApplianceFrames(lamp(), h1741Push("qkLUAAAAAAAAAAAAAAAAAAAAADw="))).toEqual(battery(84));
  });

  it("drops a level above 100 and a frame with a wrong checksum", () => {
    // 0x65 = 101, checksum fixed up.
    const over = Buffer.from("aa4265000000000000000000000000000000008d", "hex").toString("base64");
    expect(decodeApplianceFrames(lamp(), h1741Push(over))).toEqual([]);
    const broken = Buffer.from("aa423000000000000000000000000000000000d9", "hex").toString("base64");
    expect(decodeApplianceFrames(lamp(), h1741Push(broken))).toEqual([]);
  });

  it("reads nothing from another device's `aa 42` — mains devices send it too", () => {
    const h1310 = createTestDevice({ sku: "H1310", type: "devices.types.fan" });
    expect(decodeApplianceFrames(h1310, h1741Push("qkIwAAAAAAAAAAAAAAAAAAAAANg="))).toEqual([]);
  });
});
