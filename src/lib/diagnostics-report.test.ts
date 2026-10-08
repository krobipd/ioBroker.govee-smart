// DB-04 (fleet diagnostics standard) and GV-30: the finished report, held against every personal value an account
// can put into it — with the fleet's canary check `leaked`, which reads in any case and spelling.
import { describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "./diagnostics";
import { DeviceRegistry } from "./device-registry";
import { leaked } from "./diagnostics/placeholders";
import { rawAppEntry } from "./govee-api-client";
import type { GoveeDevice } from "./types";

/** The personal values of this fixture — each one distinct, none a protocol word. */
const PERSONAL = {
  deviceName: "Jennys Leselampe",
  otherDeviceName: "Wohnzimmer Mirko",
  wifiName: "Huber Familie 5G",
  matterId: "CAFEBABE0D15EA5E",
  accountTopic: "GA/0badc0de0badc0de0badc0de0badc0de",
  deviceTopic: "GD/feedfacefeedfacefeedfacefeedface",
  appDeviceNumber: "98765432",
  groupId: "7654321",
  lanAddress: "10.2.1.36",
  publicAddress: "203.0.113.77",
  mail: "jenny.huber@example.com",
  cloudSnapshot: "Abend mit Oma",
  diyScene: "Lenas Geburtstag",
  localSnapshot: "Kinoabend Huber",
  deviceId: "20:15:EB:E7:54:95:B2:4D",
};

function device(): GoveeDevice {
  return {
    sku: "H6199",
    deviceId: PERSONAL.deviceId,
    name: PERSONAL.deviceName,
    type: "devices.types.light",
    capabilities: [],
    scenes: [],
    diyScenes: [{ name: PERSONAL.diyScene, value: 4711 }],
    snapshots: [{ name: PERSONAL.cloudSnapshot, value: 815 }],
    sceneLibrary: [],
    musicLibrary: [],
    diyLibrary: [],
    skuFeatures: null,
    state: { online: true },
    channels: { lan: true, mqtt: true, cloud: true },
    lanIp: PERSONAL.lanAddress,
    iotTopic: PERSONAL.deviceTopic,
  };
}

async function report(): Promise<string> {
  const c = new DiagnosticsCollector(new DeviceRegistry({ data: { devices: {} } }));
  c.setDeviceNamesProvider(() => [PERSONAL.deviceName, PERSONAL.otherDeviceName]);
  c.setDeviceIdsProvider(() => [PERSONAL.groupId, PERSONAL.deviceId]);
  c.setLocalSnapshotsProvider(() => [{ name: PERSONAL.localSnapshot, power: true }]);
  // the account list entry as Govee answers it (shape of #50), settings as JSON inside JSON
  c.recordApiSuccess(
    PERSONAL.deviceId,
    "/device/rest/devices/v1/list",
    rawAppEntry({
      deviceId: Number(PERSONAL.appDeviceNumber),
      groupId: Number(PERSONAL.groupId),
      sku: "H6199",
      device: PERSONAL.deviceId,
      deviceName: PERSONAL.deviceName,
      deviceExt: {
        deviceSettings: JSON.stringify({
          wifiName: PERSONAL.wifiName,
          matterId: PERSONAL.matterId,
          topic: PERSONAL.deviceTopic,
          deviceName: PERSONAL.deviceName,
        }),
        lastDeviceData: JSON.stringify({ online: true }),
      },
    }),
  );
  // a push envelope as the account broker sends it: lanInfo.addr is the device's IPv4 as a little-endian number
  const [a, b, cc, d] = PERSONAL.lanAddress.split(".").map(Number);
  c.addMqttPacket(PERSONAL.deviceId, PERSONAL.accountTopic, {
    rawJson: JSON.stringify({
      topic: PERSONAL.accountTopic,
      state: { onOff: 1, wifiName: PERSONAL.wifiName, ip: PERSONAL.publicAddress },
      lanInfo: { addr: (a | (b << 8) | (cc << 16) | (d << 24)) >>> 0 },
    }),
  });
  c.addLog(PERSONAL.deviceId, "info", `${PERSONAL.otherDeviceName} joined group ${PERSONAL.groupId}`);
  c.recordAccountCall("/account/rest/account/v2/login", false, 401, `user ${PERSONAL.mail} rejected`);
  c.addLanSend(PERSONAL.deviceId, PERSONAL.lanAddress, "turn", { value: 1 });
  return JSON.stringify(await c.generate(device(), "3.2.0", "devices.h6199-b24d"));
}

describe("the finished report leaks no personal value (DB-04, GV-30)", () => {
  it("names, network, topics, ids, addresses, mail, snapshot and DIY names all stand as placeholders", async () => {
    const text = await report();
    const secrets = Object.values(PERSONAL);
    expect(leaked(text, secrets)).toEqual([]);
  });

  it("the canary check itself finds a value that slipped through (positive control)", async () => {
    const text = await report();
    expect(leaked(`${text} ${PERSONAL.diyScene.toLowerCase()}`, [PERSONAL.diyScene])).toEqual([PERSONAL.diyScene]);
  });
});
