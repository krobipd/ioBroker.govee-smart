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

  it("returns [] for a SKU without a decoder, for a light, and for junk", () => {
    expect(
      decodeApplianceFrames(createTestDevice({ sku: "H7131", type: "devices.types.heater" }), PUSH_2026_09_11),
    ).toEqual([]);
    expect(decodeApplianceFrames(createTestDevice(), PUSH_2026_09_11)).toEqual([]);
    expect(decodeApplianceFrames(purifier(), ["not base64!!", 42, null])).toEqual([]);
    expect(decodeApplianceFrames(purifier(), undefined)).toEqual([]);
  });
});
