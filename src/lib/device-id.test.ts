import { describe, expect, it } from "vitest";
import { DeviceIdRegistry, deviceFolder, deviceIdFor, idPiece, modelPart } from "./device-id";

describe("modelPart", () => {
  it("is the SKU in lower case, anything else one hyphen, nothing at the ends", () => {
    expect(modelPart("H61BE")).toBe("h61be");
    expect(modelPart("BaseGroup")).toBe("basegroup");
    expect(modelPart("H6-XY Z")).toBe("h6-xy-z");
    expect(modelPart("  H6160 ")).toBe("h6160");
  });

  it("falls back to `device` when nothing usable is left", () => {
    expect(modelPart("")).toBe("device");
    expect(modelPart("!!!")).toBe("device");
    expect(modelPart(undefined)).toBe("device");
    expect(modelPart(42)).toBe("device");
  });
});

describe("idPiece", () => {
  it("is Govee's device id without separators, lower case", () => {
    expect(idPiece("AB:CD:EF:12:34:56:78:90")).toBe("abcdef1234567890");
    expect(idPiece("9900001")).toBe("9900001");
  });

  it("is empty for anything that is not a usable id", () => {
    expect(idPiece("")).toBe("");
    expect(idPiece(undefined)).toBe("");
    expect(idPiece(":::")).toBe("");
  });
});

describe("deviceIdFor", () => {
  it("is the SKU and the last four characters of the device id", () => {
    expect(deviceIdFor("H61BE", "AB:CD:EF:12:34:56:52:5F", new Set())).toBe("h61be-525f");
    expect(deviceIdFor("BaseGroup", "9900001", new Set())).toBe("basegroup-0001");
  });

  it("takes a short device id whole", () => {
    expect(deviceIdFor("BaseGroup", "g1", new Set())).toBe("basegroup-g1");
  });

  it("gives the second device of a model with the same four characters its whole id", () => {
    const taken = new Set(["h61be-525f"]);
    expect(deviceIdFor("H61BE", "11:22:33:44:55:66:52:5F", taken)).toBe("h61be-112233445566525f");
  });

  it("counts on when even the whole id is taken", () => {
    const taken = new Set(["h61be-525f", "h61be-112233445566525f"]);
    expect(deviceIdFor("H61BE", "11:22:33:44:55:66:52:5F", taken)).toBe("h61be-112233445566525f-2");
  });

  it("never hands out the id the instance keeps for itself", () => {
    // `groups.info` holds the group rollup — a model whose short form is `info` counts on.
    expect(deviceIdFor("info", "", new Set())).toBe("info-2");
  });

  it("names a device without a usable id by its model, counted", () => {
    expect(deviceIdFor("H6160", "", new Set())).toBe("h6160");
    expect(deviceIdFor("H6160", "", new Set(["h6160"]))).toBe("h6160-2");
  });
});

describe("deviceFolder", () => {
  it("puts app groups under groups., everything else under devices.", () => {
    expect(deviceFolder("BaseGroup")).toBe("groups");
    expect(deviceFolder("H61BE")).toBe("devices");
  });
});

describe("DeviceIdRegistry", () => {
  it("assigns a device its tree once and keeps it", () => {
    const ids = new DeviceIdRegistry();
    expect(ids.prefixFor("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBe("devices.h61be-525f");
    expect(ids.prefixFor("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBe("devices.h61be-525f");
    expect(ids.idFor("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBe("h61be-525f");
  });

  it("gives two devices that end in the same four characters two trees", () => {
    const ids = new DeviceIdRegistry();
    const first = ids.prefixFor("H61BE", "AB:CD:EF:12:34:56:52:5F");
    const second = ids.prefixFor("H61BE", "11:22:33:44:55:66:52:5F");
    expect(first).toBe("devices.h61be-525f");
    expect(second).toBe("devices.h61be-112233445566525f");
  });

  it("keeps a seeded tree for its device, whatever the rule would say today", () => {
    const ids = new DeviceIdRegistry();
    expect(ids.seed("H61BE", "11:22:33:44:55:66:52:5F", "devices.h61be-525f")).toBe(true);
    // The device the short form was seeded for keeps it; the other one takes the long form.
    expect(ids.prefixFor("H61BE", "AB:CD:EF:12:34:56:52:5F")).toBe("devices.h61be-abcdef123456525f");
    expect(ids.prefixFor("H61BE", "11:22:33:44:55:66:52:5F")).toBe("devices.h61be-525f");
  });

  it("refuses a second tree for a device and a second device for a tree", () => {
    const ids = new DeviceIdRegistry();
    ids.seed("H61BE", "AB:CD:EF:12:34:56:52:5F", "devices.h61be-525f");
    expect(ids.seed("H61BE", "AB:CD:EF:12:34:56:52:5F", "devices.h61be-525f")).toBe(true);
    expect(ids.seed("H61BE", "AB:CD:EF:12:34:56:52:5F", "devices.other")).toBe(false);
    expect(ids.seed("H6160", "00:00:00:00:00:00:00:01", "devices.h61be-525f")).toBe(false);
  });

  it("frees the id of a removed tree", () => {
    const ids = new DeviceIdRegistry();
    ids.prefixFor("H61BE", "AB:CD:EF:12:34:56:52:5F");
    ids.release("devices.h61be-525f");
    expect(ids.prefixFor("H61BE", "11:22:33:44:55:66:52:5F")).toBe("devices.h61be-525f");
  });

  it("keeps the folders apart — a group and a device may carry the same id", () => {
    const ids = new DeviceIdRegistry();
    expect(ids.prefixFor("BaseGroup", "1311")).toBe("groups.basegroup-1311");
    // A group tree under the very id the device wants: a different folder, so it takes nothing away.
    ids.seed("BaseGroup", "9901311", "groups.h6160-1311");
    expect(ids.prefixFor("H6160", "AA:BB:CC:DD:EE:FF:13:11")).toBe("devices.h6160-1311");
  });
});
