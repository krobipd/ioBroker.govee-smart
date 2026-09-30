import { vi } from "vitest";
import en from "../../admin/i18n/en.json";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string, ...args: (string | number)[]) =>
      args.length > 0 ? `${key}:${args.join(",")}` : key,
    ),
  },
}));

import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import { infoTypeStates, infoTypeValue, optionLabel, optionLabelsFor, UNKNOWN_DEVICE_TYPE } from "./value-labels";

describe("optionLabel — Govee's setting words in the system language", () => {
  it("translates a known word, whatever its case and padding", () => {
    expect(optionLabel("Low")).toBe("optLow");
    expect(optionLabel(" auto stop ")).toBe("optAutoStop");
  });

  it("gearMode is the manual level mode", () => {
    expect(optionLabel("gearMode")).toBe("optManual");
  });

  it("a heater's gearMode is its heating mode — elsewhere it is the manual level mode", () => {
    expect(optionLabel("gearMode", "devices.types.heater")).toBe("optHeat");
    expect(optionLabel("gearMode", "devices.types.air_purifier")).toBe("optManual");
    expect(optionLabel("Auto", "devices.types.heater")).toBe("optAuto");
  });

  it("every label a Govee word can carry — for input written with Govee's name", () => {
    expect(optionLabelsFor("gearMode")).toEqual(["optManual", "optHeat"]);
    expect(optionLabelsFor("Tea")).toEqual(["optTea"]);
  });

  it("a numbered fan speed keeps its number", () => {
    expect(optionLabel("Speed 3")).toBe("optSpeedN:3");
  });

  it("a word it does not know stays as Govee wrote it — never empty", () => {
    expect(optionLabel("Turbo")).toBe("Turbo");
  });
});

describe("info.type — value and list", () => {
  it("the value is Govee's type without its prefix", () => {
    expect(infoTypeValue("devices.types.light")).toBe("light");
    expect(infoTypeValue("devices.types.air_purifier")).toBe("air_purifier");
  });

  it("a type outside the list and a missing type become unknown — a value the list explains", () => {
    expect(infoTypeValue("devices.types.robot_vacuum")).toBe(UNKNOWN_DEVICE_TYPE);
    expect(infoTypeValue(undefined)).toBe(UNKNOWN_DEVICE_TYPE);
  });

  it("the list carries every Govee type and the unknown one, each with its own translation key", () => {
    const states = infoTypeStates();
    const shortTypes = Object.values(GOVEE_DEVICE_TYPE).map(t => t.replace("devices.types.", ""));
    expect(Object.keys(states).sort()).toEqual([...shortTypes, UNKNOWN_DEVICE_TYPE].sort());
    const keys = Object.values(states);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(en).toHaveProperty(key);
    }
  });
});
