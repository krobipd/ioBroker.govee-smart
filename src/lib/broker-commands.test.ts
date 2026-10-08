import { describe, expect, it } from "vitest";
import { brokerCarries, brokerCommandOf, brokerMessage } from "./broker-commands";
import type { GoveeDevice } from "./types";

function light(extra: Partial<GoveeDevice> = {}): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: "AA:BB:CC:DD:EE:FF:00:18",
    name: "Strip",
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [],
    snapshots: [],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: false, mqtt: true, cloud: true },
    iotTopic: "GD/0123456789abcdef0123456789abcdef",
    ...extra,
  };
}

const open = { lanPath: false, brokerConnected: true, brokerExcluded: false };

describe("brokerCarries — which command goes over the account broker (K18)", () => {
  it("carries the four light commands of a light with its topic while the broker is up", () => {
    for (const command of ["power", "brightness", "colorRgb", "colorTemperature"]) {
      expect(brokerCarries(light(), command, open), command).toBe(true);
    }
  });

  it("never carries scenes, segments or music — govee2mqtt sends only the four light commands over it first", () => {
    for (const command of ["lightScene", "segmentColor:1", "segmentBatch", "music", "gradientToggle", "toString"]) {
      expect(brokerCarries(light(), command, open), command).toBe(false);
    }
  });

  it("LAN goes first, a dropped broker, an excluded model, a missing topic and a non-light each keep it off", () => {
    expect(brokerCarries(light(), "power", { ...open, lanPath: true })).toBe(false);
    expect(brokerCarries(light(), "power", { ...open, brokerConnected: false })).toBe(false);
    expect(brokerCarries(light(), "power", { ...open, brokerExcluded: true })).toBe(false);
    expect(brokerCarries(light({ iotTopic: undefined }), "power", open)).toBe(false);
    expect(brokerCarries(light({ iotTopic: "" }), "power", open)).toBe(false);
    expect(brokerCarries(light({ type: "devices.types.socket" }), "power", open)).toBe(false);
  });
});

describe("brokerMessage — govee2mqtt's command words and data (src/service/iot.rs)", () => {
  it("power is turn 1/0", () => {
    expect(brokerMessage("power", true)).toEqual({ cmd: "turn", data: { val: 1 }, sent: true });
    expect(brokerMessage("power", false)).toEqual({ cmd: "turn", data: { val: 0 }, sent: false });
  });

  it("brightness is a whole percent, clamped to 0–100", () => {
    expect(brokerMessage("brightness", 42.6)).toEqual({ cmd: "brightness", data: { val: 43 }, sent: 43 });
    expect(brokerMessage("brightness", 150).data).toEqual({ val: 100 });
    expect(brokerMessage("brightness", -5).data).toEqual({ val: 0 });
    expect(() => brokerMessage("brightness", "dim")).toThrow(/no number/);
  });

  it("a colour is colorwc with the colour and 0 K; a colour temperature is colorwc with black and the Kelvin value", () => {
    expect(brokerMessage("colorRgb", "#ff8000")).toEqual({
      cmd: "colorwc",
      data: { color: { r: 255, g: 128, b: 0 }, colorTemInKelvin: 0 },
      sent: "#ff8000",
    });
    expect(brokerMessage("colorTemperature", 4000)).toEqual({
      cmd: "colorwc",
      data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 4000 },
      sent: 4000,
    });
    expect(() => brokerMessage("colorTemperature", 0)).toThrow(/no Kelvin/);
  });

  it("refuses a command the broker does not carry", () => {
    expect(() => brokerMessage("lightScene", 3)).toThrow(/carries no lightScene/);
  });
});

describe("brokerCommandOf — the command behind a datapoint", () => {
  it("maps the four light datapoints and nothing else", () => {
    expect(brokerCommandOf("control.power")).toBe("power");
    expect(brokerCommandOf("control.brightness")).toBe("brightness");
    expect(brokerCommandOf("control.color_rgb")).toBe("colorRgb");
    expect(brokerCommandOf("control.color_temperature")).toBe("colorTemperature");
    expect(brokerCommandOf("scenes.light_scene")).toBeUndefined();
  });
});
