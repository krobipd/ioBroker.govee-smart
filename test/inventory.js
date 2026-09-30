/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY device type the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current common (every field) and object type, and that removed objects are gone.
//
// govee-smart: the fixtures are a fake Govee cloud (OpenAPI REST + the internal app API,
// test/fixtures/inventory/govee-cloud.json — an account holding EVERY device kind the adapter
// supports, not just the maintainer's own) and a fake LAN light answering real UDP on loopback.
// The adapter reaches the fake cloud through test/inventory-https-hook.cjs (every Govee host is a
// constant in the clients; the hook, loaded into the adapter process, routes them to loopback).
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const dgram = require("node:dgram");
const http = require("node:http");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
// An object is written at most three times in one start: created, its name refreshed, enriched once after
// discovery. More is churn — every write goes to the database and to every subscriber (round 60, measured
// 2026-09-28 over the fleet: 1-3 everywhere, 251 for an object whose stored key flipped on every resync).
const MAX_OBJECT_WRITES = 3;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`, gate D08 + CI job): the states
// after the fixture run, and the objects once more from a run in a second system language. Generated, not
// committed (.gitignore) — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const VOLATILE = ["ts", "from", "user", "acl"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = (v) =>
    JSON.stringify(v, (_k, x) =>
        x && typeof x === "object" && !Array.isArray(x)
            ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
            : x);
// How long the upgrade suite keeps watching after its verdict: a write in that window means the wait ended before
// the adapter did (round 61, measured 2026-09-29 over the fleet: none in 10 s at HEAD; parcelapp's old wait judged
// 5 ms before the first of 187 writes).
const SETTLE_MS = 10000;
const INSTANCE_OBJECTS = new Set(
    (require(path.join(ADAPTER_DIR, "io-package.json")).instanceObjects ?? []).map((o) => `${NS}${o._id}`),
);
// govee-smart: the https hook routes every Govee host to the fake cloud on this port. The harness hands the
// mocha process's environment to the adapter process (`env: { ...process.env, ...env }`, @iobroker/testing 6.2.2).
const HOOK = path.join(__dirname, "inventory-https-hook.cjs");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "govee-cloud.json"), "utf8"));
const FIXTURE_PORT = 18099;
process.env.GOVEE_FIXTURE_PORT = String(FIXTURE_PORT);
const LAN_LISTEN_PORT = 4002; // where the adapter listens for device replies
const LAN_COMMAND_PORT = 4003; // where devices listen for adapter commands
const LAN_DEVICE = { sku: "H6172", device: "AA:BB:CC:DD:EE:FF:00:01" };

// Round 62: every adapter start loads test/resource-probe.js (fleet master) FIRST; at its exit it records what the
// adapter or one of its libraries left open after onUnload, and the run fails on any of it (the after() at the end).
const RESOURCE_PROBE = path.join(__dirname, "resource-probe.js");
const RESOURCE_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `${ADAPTER}-resources-`));
// Round 62: the adapter's read-only states (`common.write: false`) — only the adapter writes them, so it compares them
// in memory; a database read of one in the quiet window after the verdict is a finding.
const READ_ONLY = new Set();
// The environment of every adapter start: the resource probe first, then the test hooks of this adapter.
function adapterEnv(...hooks) {
    return {
        NODE_OPTIONS: [RESOURCE_PROBE, ...hooks].map((file) => `--require ${file}`).join(" "),
        RESOURCE_PROBE_DIR: RESOURCE_DIR,
        RESOURCE_PROBE_NS: NS,
    };
}

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function watchObjectWrites(harness) {
    const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedIndicators: [] };
    const known = new Map();
    const roles = new Map();
    const states = new Map();
    const content = (obj) => {
        const { ts, from, user, ...rest } = obj;
        return canonical(rest);
    };
    harness.on("objectChange", (id, obj) => {
        if (!id.startsWith(NS)) {
            return;
        }
        if (!obj) {
            watch.deleted.push(id);
            known.delete(id);
            roles.delete(id);
            return;
        }
        roles.set(id, obj.common?.role);
        if (obj.type === "state" && obj.common?.write === false) {
            READ_ONLY.add(id);
        } else {
            READ_ONLY.delete(id);
        }
        const now = content(obj);
        if (obj.from === `system.adapter.${ADAPTER}.0`) {
            const n = (watch.writes.get(id) ?? 0) + 1;
            watch.writes.set(id, n);
            watch.peak.set(id, Math.max(watch.peak.get(id) ?? 0, n));
            watch.times.push([id, Date.now()]);
            if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
                watch.unchanged.push(id);
            }
        }
        known.set(id, now);
    });
    // Round 62: an indicator state (`indicator.*`) is written only on a change (read-only: compared in memory,
    // writable: setStateChangedAsync) — a write that changes nothing is a finding. Compared is what js-controller
    // 7.2.2 compares in setStateChangedAsync: val strictly, ack, q, c; an object value always counts as changed.
    harness.on("stateChange", (id, state) => {
        if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
            return;
        }
        const now = state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
        if (now !== null && states.get(id) === now && String(roles.get(id)).startsWith("indicator")) {
            watch.unchangedIndicators.push(id);
        }
        states.set(id, now);
    });
    // Round 64: a restart the harness plays (playControllerRestarts) is a new start — the per-start counts begin again,
    // the known object content stays (it is the database's).
    watch.newStart = () => {
        watch.writes.clear();
        states.clear();
    };
    const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
    for (const row of list.rows) {
        if (row.value) {
            known.set(row.id, content(row.value));
            roles.set(row.id, row.value.common?.role);
            if (row.value.type === "state" && row.value.common?.write === false) {
                READ_ONLY.add(row.id);
            }
        }
    }
    return watch;
}

/** Envelope of the OpenAPI device LIST (`/user/devices`): `data`. */
function ok(payload) {
  return JSON.stringify({ code: 200, message: "success", data: payload });
}

/**
 * Envelope of the per-device OpenAPI answers (`/device/state`, `/device/scenes`,
 * `/device/diy-scenes`): `payload`, with `msg` instead of `message` — measured
 * on three captures (issue #47). The adapter parsed `data` for the state read
 * until 2.35.0 and never received a value; this fixture had copied the mistake.
 */
function okPayload(payload) {
  return JSON.stringify({ requestId: "fixture", msg: "success", code: 200, payload });
}

/**
 * A temperature inside the range the capability declares for it — a kettle starts at 40 °C, and a
 * reading below that is refused by js-controller with a warning.
 *
 * @param {{ parameters?: { fields?: Array<{ fieldName?: string, range?: { min: number, max: number } }> } }} cap the declared capability
 * @param {number} preferred the reading wanted
 */
function withinDeclared(cap, preferred) {
  const range = cap.parameters?.fields?.find(f => f && f.fieldName === "temperature")?.range;
  return range ? Math.min(range.max, Math.max(range.min, preferred)) : preferred;
}

/**
 * A value the capability declares — its first option. A value outside the list is something Govee never
 * sends; the adapter drops it, and the inventory would show no value where a real account has one.
 *
 * @param {{ parameters?: { options?: Array<{ value: unknown }> } }} cap the declared capability
 * @param {unknown} fallback the reading for a capability without an option list
 */
function firstDeclared(cap, fallback) {
  const options = cap.parameters?.options;
  return Array.isArray(options) && options.length > 0 ? options[0].value : fallback;
}

/**
 * The device state read. Returns the reachability Govee reports plus a reading
 * per capability kind, so the synthetic sensor/appliance datapoints are created
 * the same way a real account creates them.
 *
 * @param {string} device Govee device id from the query
 */
function stateFor(device) {
  const entry = FIXTURE.devices.find(d => d.device === device);
  const caps = [{ type: "devices.capabilities.online", instance: "online", state: { value: true } }];
  for (const c of entry ? entry.capabilities : []) {
    if (c.type === "devices.capabilities.online") continue;
    const value =
      c.instance === "colorRgb"
        ? 16711680
        : c.instance === "colorTemperatureK"
          ? 4000
          : c.instance === "powerSwitch"
            ? 1
            : c.instance === "sensorTemperature"
              ? 21.5
              : c.instance === "sensorHumidity"
                ? 45
                : c.instance === "battery"
                  ? 88
                  : c.instance === "airQuality"
                    ? 12
                    : c.instance === "filterLifeTime"
                      ? 76
                      : c.instance === "targetTemperature"
                        ? { temperature: withinDeclared(c, 22) }
                        : c.instance === "workMode"
                          ? { workMode: 1, modeValue: 1 }
                          : firstDeclared(c, 50);
    caps.push({ type: c.type, instance: c.instance, state: { value } });
  }
  return caps;
}

const CAPTURED = {};
for (const sku of ["h61a8", "h6199"]) {
  const scenes = require(`./fixtures/inventory/govee-${sku}-scenes.json`);
  CAPTURED[scenes.device] = {
    scenes,
    diyScenes: require(`./fixtures/inventory/govee-${sku}-diy-scenes.json`),
    state: require(`./fixtures/inventory/govee-${sku}-state.json`),
  };
}

// H5140 (audit N15): Govee's own example state answer, so `sensor.co2` is built
// from a documented reading.
CAPTURED["AA:BB:CC:DD:EE:FF:00:16"] = { state: require("./fixtures/inventory/govee-h5140-state.json") };

/** The H6199's own scene library in wire form — the scenes with speedInfo build `scenes.scene_speed`. */
const SCENE_LIBRARIES = { H6199: require("./fixtures/inventory/govee-h6199-scene-library.json") };

/**
 * The account-list entry of the gateway-backed H5109, in Govee's wire form
 * (settings and last data as JSON strings, as every raw capture since 2.39.1
 * shows them). Values from issue #31 (the export's list entry of 2026-07-05),
 * every identifying value replaced by a canary: the fixture's device id, the
 * gateway's secret, topic, BLE name and addresses.
 */
const APP_LIST = [
  {
    sku: "H5109",
    device: "AA:BB:CC:DD:EE:FF:00:05",
    deviceName: "Battery Sensor Cellar",
    deviceId: 98765001,
    groupId: 0,
    spec: "",
    versionHard: "1.4",
    versionSoft: "1.9",
    deviceExt: {
      deviceSettings: JSON.stringify({
        temMin: 1500,
        temMax: 3500,
        temWarning: true,
        fahOpen: false,
        temCali: 0,
        humMin: 0,
        humMax: 10000,
        humWarning: true,
        humCali: 0,
        netWaring: true,
        uploadRate: 10,
        battery: 100,
        wifiLevel: 0,
        sno: 0,
        powerSaveModeState: false,
        emailWarningOnOff: false,
        criticalOnOff: false,
        normalPushOnOff: true,
        gatewayId: 1000004,
        gatewayInfo: {
          device: "AA:BB:CC:DD:EE:FF:00:04",
          sku: "H5042",
          topic: "GD/c0dec0dec0dec0dec0dec0dec0dec0",
          bleName: "ihoment_H5042_C0DE",
          address: "AA:BB:CC:DD:EE:04",
          secretCode: "CANARYsecret0=",
        },
        wifiFuncList: "",
        sku: "H5109",
        device: "AA:BB:CC:DD:EE:FF:00:05",
        deviceName: "Battery Sensor Cellar",
        versionHard: "1.4",
        versionSoft: "1.9",
      }),
      lastDeviceData: JSON.stringify({ online: false, tem: 2343, hum: 0, lastTime: 1783279200000 }),
    },
  },
];

/** Scenes + snapshots for a light, from the separate scenes endpoint (hand-built lights only). */
function scenesFor() {
  return {
    capabilities: [
      {
        type: "devices.capabilities.dynamic_scene",
        instance: "lightScene",
        parameters: {
          options: [
            { name: "Sunrise", value: { id: 1, paramId: 11 } },
            { name: "Aurora", value: { id: 2, paramId: 12 } },
          ],
        },
      },
      {
        type: "devices.capabilities.dynamic_scene",
        instance: "snapshot",
        parameters: { options: [{ name: "Movie night", value: { id: 7, paramId: 71 } }] },
      },
    ],
  };
}

/**
 * A fake Govee cloud (OpenAPI REST + the internal app API) on loopback. Every
 * object the adapter can create for a cloud device comes from these responses.
 */
function startFakeCloud() {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const reply = (payload, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      };
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        /* the adapter only ever sends JSON; a parse failure is a fixture bug */
      }
      if (url.includes("/router/api/v1/user/devices")) {
        reply(ok(FIXTURE.devices));
      } else if (url.includes("/router/api/v1/device/state")) {
        const device = parsed.payload?.device;
        const captured = CAPTURED[device];
        reply(
          okPayload(captured ? captured.state : { sku: parsed.payload?.sku, device, capabilities: stateFor(device) }),
        );
      } else if (url.includes("/router/api/v1/device/diy-scenes")) {
        const captured = CAPTURED[parsed.payload?.device];
        reply(okPayload(captured?.diyScenes ?? scenesFor()));
      } else if (url.includes("/router/api/v1/device/scenes")) {
        const captured = CAPTURED[parsed.payload?.device];
        reply(okPayload(captured?.scenes ?? scenesFor()));
      } else if (url.includes("/router/api/v1/device/control")) {
        // The control answer is NOT wrapped in `data` — measured on 12 captures (issue #47).
        reply(
          JSON.stringify({
            requestId: "fixture",
            msg: "success",
            code: 200,
            capability: { ...(parsed.payload?.capability ?? {}), state: { status: "success" } },
          }),
        );
      } else if (url.includes("/lookup")) {
        // The App-Store lookup the adapter uses to learn the current Govee
        // app version. Pinned here so the inventory does not change with
        // whatever Apple happens to answer.
        reply(JSON.stringify({ resultCount: 1, results: [{ version: "7.6.20" }] }));
      } else if (url.includes("/account/rest/account/v2/login")) {
        // The account login. `client` present = success; accountId and topic are
        // validated by the client (H11), the token is what the group read needs.
        reply(
          JSON.stringify({
            status: 200,
            message: "success",
            client: {
              token: "fixture-bearer-token",
              accountId: "1000001",
              topic: "GA/fixture-account",
              token_expire_cycle: 3600,
            },
          }),
        );
      } else if (url.includes("/app/v1/account/iot/key")) {
        // Deliberately WITHOUT endpoint/certificate: the client throws right
        // here ("IoT key response missing endpoint/certificate data") and never
        // reaches mqtt.connect — no socket leaves the machine, and the bearer
        // token from the step before is already handed on.
        reply(JSON.stringify({ status: 200, message: "success", data: {} }));
      } else if (url.includes("/bff-app/v1/exec-plat/home")) {
        // The account's home view: which devices belong to which app group.
        // Only the group the device list carries (BaseGroup 9900001) and the
        // two members it has there.
        reply(
          JSON.stringify({
            status: 200,
            message: "success",
            data: {
              components: [
                {
                  groups: [
                    {
                      gId: 9900001,
                      name: "Group Ground Floor",
                      devices: [
                        { sku: "H6172", device: "AA:BB:CC:DD:EE:FF:00:01" },
                        { sku: "H6199", device: "AA:BB:CC:DD:EE:FF:00:02" },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      } else if (url.includes("/device/rest/devices/v1/list")) {
        // The App-API device list: the gateway-backed H5109 — its battery and
        // gateway reach the tree only through this list (audit N15).
        reply(JSON.stringify({ status: 200, message: "ok", devices: APP_LIST }));
      } else if (url.includes("/appsku/v1/light-effect-libraries")) {
        const sku = new URL(url, "http://fixture").searchParams.get("sku") ?? "";
        reply(JSON.stringify(SCENE_LIBRARIES[sku] ?? { status: 200, message: "ok", data: {} }));
      } else if (url.includes("/appsku/v1/") || url.includes("/bff-app/v1/")) {
        // Scene / music / DIY libraries and snapshots are public app-API
        // reads. Empty but well-formed: the adapter must build its tree
        // without them, and an installation with no account gets nothing
        // else either.
        reply(JSON.stringify({ status: 200, message: "ok", data: {} }));
      } else {
        reply(JSON.stringify({ status: 404, message: `no fixture route for ${url}` }), 404);
      }
    });
  });
  return new Promise(resolve => server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server)));
}

/**
 * A fake Govee light on the local network. Answers the adapter's `devStatus`
 * on 4003 and announces itself to the adapter's listen port, so the LAN-driven
 * half of the object tree (info.ip, the LAN default control states) is built by
 * the same code path a real strip drives.
 */
function startFakeLanDevice() {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const send = payload => {
    const buf = Buffer.from(JSON.stringify(payload));
    sock.send(buf, 0, buf.length, LAN_LISTEN_PORT, "127.0.0.1");
  };
  sock.on("message", msg => {
    let cmd;
    try {
      cmd = JSON.parse(msg.toString()).msg?.cmd;
    } catch {
      return;
    }
    if (cmd === "devStatus") {
      send({
        msg: {
          cmd: "devStatus",
          data: { onOff: 1, brightness: 80, color: { r: 255, g: 120, b: 0 }, colorTemInKelvin: 4000 },
        },
      });
    }
  });
  return new Promise(resolve => {
    sock.bind(LAN_COMMAND_PORT, "127.0.0.1", () => {
      resolve({
        socket: sock,
        announce: () =>
          send({
            msg: {
              cmd: "scan",
              data: {
                ip: "127.0.0.1",
                device: LAN_DEVICE.device,
                sku: LAN_DEVICE.sku,
                bleVersionHard: "1.00.01",
                wifiVersionSoft: "1.02.14",
              },
            },
          }),
      });
    });
  });
}


/** The fake cloud and the fake LAN light — up before the first start, for every suite of the run. */
const FIXTURE_SERVERS = Promise.all([startFakeCloud(), startFakeLanDevice()]);

/**
 * Adapter-specific: make the adapter create every object it can create.
 * A catalog-driven adapter needs nothing here (its objects appear at start).
 * A device/API-driven adapter feeds fixtures for EVERY device type here — a fake
 * device/cloud endpoint on localhost, MQTT messages, or a message via sendTo —
 * never only the maintainer's own devices.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedFixtures(harness) {
    void harness;
    const [, lan] = await FIXTURE_SERVERS;
    // The LAN scan runs every 30 s; announcing repeatedly makes the first one land whenever the adapter's listen
    // socket came up.
    for (let i = 0; i < 12; i++) {
        lan.announce();
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * Adapter-specific: wait until the adapter has really DONE its work on top of the SEEDED tree.
 * Suite 2 only — suite 1 needs nothing beyond feedFixtures. Name it after the adapter's own cycle
 * (parcelapp: `waitForCompletedPoll`); what matters is the criterion, not the name.
 *
 * Suite 2 seeds the previous release's OBJECTS before the start, so a wait that looks for objects
 * — which is exactly what feedFixtures does in suite 1 — is satisfied on its first look, and the
 * assertions run before the adapter has written anything. Suite 1 has the same blind spot wherever
 * ALL objects come from `instanceObjects`: js-controller creates them before `ready` fires, so an
 * object wait proves nothing about the adapter; there suite 1 also waits for a value the adapter
 * itself writes (for example `info.connection`, acknowledged). Measured public-holidays 2026-09-25:
 * with the ready handler never registered, suite 1 stayed green on the object wait alone. Measured parcelapp
 * 2026-09-07 (its first upgrade run): the assertion fired 13 ms after `onReady`, and the adapter's
 * only poll attempt hit the fixture server AFTER `after()` had already closed it. The suite then
 * reported "desc still undefined" for the three datapoints whose description was new — which reads
 * exactly like an adapter that fails to reach existing objects, while in truth nothing had run yet.
 * A catalog adapter, whose feedFixtures is `void harness`, has NO wait here at all.
 *
 * The seed uses `setObjectAsync` — objects only, never a VALUE. State values are therefore the one
 * signal it cannot fake.
 *
 * ⚠️ Cover EVERY object area the suites check, and wait there for the value the cycle writes LAST.
 * The wait ends as soon as every id below has a state; whatever the cycle writes after the last waited
 * id is checked unwaited. Measured on parcelapp 2026-09-25 (CI run 36123917452): the wait watched
 * `.carrier` (written early, per package), `updateSummary` wrote the three `summary.*` values a few
 * milliseconds after the check, and the suite reported "desc still …" only there — green locally,
 * red in CI. A value counts as written once its state exists (`""` included where the adapter really
 * writes it — the seed never writes values).
 *
 * ⚠️ Pick ids the adapter writes UNCONDITIONALLY on every cycle. A value behind a condition hangs
 * the wait until the deadline: parcelapp's `lastUpdated` writes only when the tracking data really
 * changed, and `info.connection` is no substitute either — it flips right after the API call and
 * before the per-device states are written.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForAdapterWork(harness) {
    // govee-smart, one signal per area — each written only after that area's cycle ran on THIS start (the seed
    // writes objects, never values): the device rollup (`info.devicesTotal`, first written by the 20-second
    // round after every device's marker was re-evaluated — its value is the number of device trees), the
    // app group's member list (the account's group list, one round trip after the device list) and the
    // gateway-backed sensor's battery (the App API list, the last source to answer).
    const committed = fs.existsSync(INVENTORY) ? JSON.parse(fs.readFileSync(INVENTORY, "utf8")) : {};
    const trees = Object.entries(committed).filter(
        ([id, obj]) => id.startsWith(`${NS}devices.`) && obj.type === "device",
    ).length;
    const wanted = Object.keys(committed).filter(
        (id) => /\.groups\.[^.]+\.info\.members$/.test(id) || /\.devices\.[^.]+\.sensor\.battery$/.test(id),
    );
    const deadline = Date.now() + 120000;
    for (;;) {
        const missing = [];
        for (const id of wanted) {
            const state = await harness.states.getState(id);
            if (!state || state.val === undefined || state.val === null) missing.push(id);
        }
        const total = await harness.states.getState(`${NS}info.devicesTotal`);
        if (!total || total.val !== trees) missing.push(`${NS}info.devicesTotal = ${trees}`);
        if (missing.length === 0) break;
        if (Date.now() > deadline) {
            throw new Error(`no completed cycle — ${missing.length} signal(s) missing, e.g. ${missing.slice(0, 5).join(", ")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Then the tree must be at REST: a scene answer that lands late fills `common.states` of an object that
    // already exists, so the check reads content, not a count.
    let previous = "";
    let stable = 0;
    for (let i = 0; i < 120 && stable < 5; i++) {
        const rows = (await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` })).rows;
        const signature = rows
            .map((r) => `${r.id}:${Object.keys(r.value?.common?.states ?? {}).length}`)
            .sort()
            .join("|");
        stable = signature === previous ? stable + 1 : 0;
        previous = signature;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (stable < 5) {
        throw new Error(`object tree never settled — still changing after 120 s (${previous.split("|").length} objects)`);
    }
}

/**
 * Adapter-specific config the fixtures need. The values go in as PLAIN TEXT: the instance object declares
 * `encryptedNative: ["apiKey", …]`, and @iobroker/testing 6 encrypts those fields itself when the config is written
 * (encrypting them here as well hands the adapter a double-encrypted key — the cloud never answers).
 */
const FIXTURE_NATIVE = {
  // A real Govee key is a strict UUID — the adapter refuses anything else
  // outright (the v2.11.0 encryption-migration detector), so a made-up string
  // never reaches the cloud client.
  apiKey: "12345678-1234-4321-8765-123456789abc",
  // Account credentials since 2026-09-12: the group SUBTREE needs them. Group
  // members are resolved through the App API, which runs on the bearer token of
  // the account login — without it `loadGroupMembers` returns before the first
  // request and `groups.*.info.members`, `membersUnreachable` and the
  // intersection controls existed in no inventory, so no gate ever judged them.
  // The fixture logs in against the fake cloud below; the IoT-key answer that
  // follows carries no certificate, so the login stops BEFORE any socket is
  // opened — the token is set by then, which is all the group read needs.
  goveeEmail: "fixture@example.com",
  goveePassword: "fixture-password",
  port: 4002,
  bind: "0.0.0.0",
};
/**
 * Round 66 (reported by dl-manager): every datapoint of the previous release this release moves under a new id —
 * previous full id → current full id (adapter-specific like FIXTURE_NATIVE, may be computed). The recording is the
 * user's and goes on with the moved datapoint (krobi 2026-09-02); the upgrade suite checks that it arrived there.
 */
const MOVES = {};

/**
 * Whether a device object below `devices.` names this fixture device in its `native` — by what the
 * device IS, not by a copy of the id rule: since 3.0.0 an id depends on which ids are taken (two
 * devices of one SKU ending alike), so a rule copied here would drift from the adapter.
 *
 * @param {Record<string, any>} objects Dumped objects
 * @param {{sku: string, device: string}} entry Fixture device
 */
function hasTree(objects, entry) {
  return Object.entries(objects).some(
    ([id, obj]) =>
      id.startsWith(`${NS}devices.`) &&
      obj.type === "device" &&
      obj.native?.sku === entry.sku &&
      obj.native?.deviceId === entry.device,
  );
}

async function dumpObjects(harness) {
    // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
    const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
    const out = {};
    for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
        const obj = { ...row.value };
        for (const key of VOLATILE) delete obj[key];
        out[row.id] = obj;
    }
    return out;
}

/**
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
    const config = await harness.objects.getObject("system.config");
    config.common.language = language;
    await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted. The states client has no
 * `getKeysAsync` — `getKeys`/`getStates` (like `getObject`/`setObject`) return a promise without a callback.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function dumpStates(harness) {
    const keys = (await harness.states.getKeys(`${NS}*`)).sort();
    const values = await harness.states.getStates(keys);
    const out = {};
    keys.forEach((key, i) => {
        if (values[i]) out[key] = { val: values[i].val, ack: values[i].ack };
    });
    return out;
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration and with it a host restart (played since round 64) in every suite. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 * changeAdapterConfig encrypts the `encryptedNative` keys, but merges with alcalzone-shared `extend` (round 66, reported
 * by dl-manager): a list goes element-wise into the one already there (the old tail stays, an empty list resets
 * nothing), and under a new key it becomes an object with numeric keys. Every key but an encrypted one goes in again
 * as a whole.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, unknown>} native the instance's native for this start (FIXTURE_NATIVE, or one computed per run)
 */
async function resetInstanceNative(harness, native = FIXTURE_NATIVE) {
    const id = `system.adapter.${ADAPTER}.0`;
    const instance = await harness.objects.getObjectAsync(id);
    const stale = {};
    for (const key of Object.keys(instance?.native ?? {})) {
        if (!Object.hasOwn(native, key)) stale[key] = null;
    }
    await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...native } });
    const written = await harness.objects.getObjectAsync(id);
    for (const [key, value] of Object.entries(native)) {
        if (!written.encryptedNative?.includes(key)) written.native[key] = value;
    }
    await harness.objects.setObjectAsync(id, written);
}

/**
 * Round 71 (reported by dl-manager): @iobroker/testing clears only the database and the log directory before a suite;
 * the instance's data folder (`utils.getAbsoluteInstanceDataDir`, `iobroker-data/<adapter>.0` under the test directory)
 * survives every suite and every run. A file the fresh-install suite wrote was still there when the upgrade suite
 * started, and hid the move of the seeded previous objects into that file — the suite stayed green without the move
 * ever running. A fresh installation has no data folder, so each suite starts without one; the second start of
 * `playControllerRestarts` keeps it, as a real host does.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
function clearInstanceData(harness) {
    if (typeof harness.testDir !== "string") {
        throw new Error("the harness no longer carries testDir — clearInstanceData cannot find the instance data folder");
    }
    fs.rmSync(path.join(harness.testDir, "iobroker-data", `${ADAPTER}.0`), { recursive: true, force: true });
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * adapter's first own write while it runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. An own write after that restart is a
 * finding: on a host the instance would restart again, for good. Only the adapter's own writes count (round 66): the
 * suite's resetInstanceNative writes before the start, but on a slow runner its event arrived after the start and
 * stopped a start midway. Each step has a deadline: a harness call that never settles is logged the moment it misses it,
 * and fails the suite in its own words where `await restarts.done` is the open wait (the upgrade suite's order).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 */
function playControllerRestarts(harness, watch, ...hooks) {
    const restarts = { count: 0, again: [], done: Promise.resolve() };
    harness.on("objectChange", (id, obj) => {
        if (id !== `system.adapter.${ADAPTER}.0` || obj?.from !== `system.adapter.${ADAPTER}.0` || !harness.isAdapterRunning()) {
            return;
        }
        if (restarts.count > 0) {
            restarts.again.push(Date.now());
            return;
        }
        restarts.count++;
        restarts.done = (async () => {
            await withinDeadline(harness.stopAdapter(), STOP_DEADLINE_MS, "the adapter did not stop after it changed its instance object");
            watch?.newStart();
            // What the host does when the process exits: `alive` false (a start that still sees it true ends with
            // ADAPTER_ALREADY_RUNNING, exit code 7), then the start after stopTimeout + 2.5 s.
            await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, { val: false, ack: true, from: "system.host.testing" });
            await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
            // @iobroker/testing refuses a second start of one harness ("already been used"); the host starts the same
            // instance again — reset the exit marker, and fail loudly should the harness no longer keep it there.
            harness._adapterExit = undefined;
            assert.ok(!harness.didAdapterStop(), "@iobroker/testing changed its exit marker — the restart play needs a new form");
            await withinDeadline(harness.startAdapterAndWait(false, adapterEnv(...hooks)), START_DEADLINE_MS, "the adapter did not come back after the restart");
        })();
        // Awaited by the suite later — a wait before that (feedFixtures) fails first on an adapter that hangs in its stop,
        // so a missed deadline is logged the moment it happens (and never counts as an unhandled rejection).
        restarts.done.catch((err) => console.error(`restart play failed: ${err.message}`));
    });
    return restarts;
}

/**
 * Round 66: the promise's value, or an error naming what hung once the deadline has passed.
 *
 * @param {Promise<unknown> | undefined} promise the harness call
 * @param {number} ms the deadline
 * @param {string} what what did not happen, in the failure message
 */
async function withinDeadline(promise, ms, what) {
    let timer;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} (deadline ${ms} ms)`)), ms);
    });
    try {
        return await Promise.race([promise, expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/**
 * Round 66: the restart's deadlines — stopTimeout, the 500 ms the adapter gives pending writes, and the exit; then a start
 * as the harness waits for it (`alive` true). Both together stay far below the suites' before() timeout.
 */
const STOP_DEADLINE_MS = RESTART_DELAY_MS + 2500;
const START_DEADLINE_MS = 30000;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 */
async function seedPrevious(harness, previous) {
    for (const [id, obj] of Object.entries(previous)) {
        const common =
            obj.type === "state" ? { ...obj.common, custom: { ...obj.common?.custom, [RECORDING]: { enabled: true, origin: id } } } : obj.common;
        await harness.objects.setObjectAsync(id, { ...obj, common });
    }
}

/** Round 67: the text a dump puts where the adapter stored a secret encrypted with its installation's secret. */
const ENCRYPTED_MARKER = "<encrypted with the installation secret>";

/**
 * Round 67 (reported by dl-manager): adapter-specific like feedFixtures. The previous release's dump carries
 * ENCRYPTED_MARKER wherever the adapter stored a secret encrypted with its installation's secret — no other controller
 * can read that cipher. Put a working secret back into every such seeded object, the fixture's value in the form the
 * adapter stores it (encrypted like the adapter does, e.g. with encryptPassword), so the upgrade starts on objects the
 * adapter can use. Empty where the dump masks nothing.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function restoreMaskedSecrets(harness) {}

/**
 * Round 67: the objects of the namespace that still carry ENCRYPTED_MARKER — read raw from the database, never through
 * dumpObjects (an adapter's dump masks again). Checked right after the restore, before the start: later the adapter may
 * have rewritten or deleted the object, and a clean result would prove nothing about the seeded one.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function maskedSecretsLeft(harness) {
    const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
    return list.rows.filter((row) => JSON.stringify(row.value).includes(ENCRYPTED_MARKER)).map((row) => row.id);
}

tests.integration(ADAPTER_DIR, {
    controllerVersion: "stable",
    defineAdditionalTests({ suite }) {
        suite("object inventory", getHarness => {
            let harness;
            let watch;
            let restarts;
            before(async function () {
                this.timeout(120000);
                harness = getHarness();
                clearInstanceData(harness);
                watch = await watchObjectWrites(harness);
                await resetInstanceNative(harness);
                await setSystemLanguage(harness, FIRST_LANGUAGE);
                restarts = playControllerRestarts(harness, watch, HOOK);
                await harness.startAdapterAndWait(false, adapterEnv(HOOK));
                await feedFixtures(harness);
                await restarts.done;
                await waitForAdapterWork(harness);
            });

            it("writes test/objects.inventory.json", async function () {
                this.timeout(30000);
                const objects = await dumpObjects(harness);
                assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
                // govee-smart: "not empty" passed on a run with 26 objects instead of 262 (the cloud never answered) —
                // every fixture device must have reached the tree. The pseudo-devices Govee lists get none.
                const missing = FIXTURE.devices
                    .filter((d) => d.sku !== "SameModeGroup" && d.sku !== "BaseGroup")
                    .filter((d) => !hasTree(objects, d))
                    .map((d) => `${d.sku} ${d.device}`);
                assert.deepStrictEqual(missing, [], `fixture devices missing from the object tree: ${missing.join(", ")}`);
                fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
            });

            it("writes test/states.inventory.json", async function () {
                this.timeout(30000);
                const states = await dumpStates(harness);
                assert.ok(Object.keys(states).length > 0, "no states written — fixtures did not reach the adapter");
                fs.writeFileSync(STATES_INVENTORY, `${JSON.stringify(states, null, 2)}\n`);
            });

            it("writes no object more than MAX_OBJECT_WRITES times", function () {
                const churn = [...watch.peak].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
                assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
            });

            it("rewrites no object unchanged", function () {
                const idle = [...new Set(watch.unchanged)];
                assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
            });

            it("rewrites no indicator state unchanged", function () {
                const idle = [...new Set(watch.unchangedIndicators)];
                assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
            });

            it("restarts at most once for its own instance object", function () {
                assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
            });
        });

        // The same run once more in a second system language: a label that stays the same in both was never
        // translated. A suite of its own — the harness starts an adapter only once per suite (a second
        // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
        suite("second system language", getHarness => {
            let harness;
            let restarts;
            before(async function () {
                this.timeout(120000);
                harness = getHarness();
                clearInstanceData(harness);
                await resetInstanceNative(harness);
                await setSystemLanguage(harness, SECOND_LANGUAGE);
                restarts = playControllerRestarts(harness, null, HOOK);
                await harness.startAdapterAndWait(false, adapterEnv(HOOK));
                await feedFixtures(harness);
                await restarts.done;
                await waitForAdapterWork(harness);
            });

            it("restarts at most once for its own instance object", function () {
                assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
            });

            it("writes test/objects.inventory.de.json", async function () {
                this.timeout(30000);
                const objects = await dumpObjects(harness);
                assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
                fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
            });
        });

        const previousFile = process.env.INVENTORY_PREVIOUS;
        if (previousFile && fs.existsSync(previousFile)) {
            suite("upgrade from the previous release", getHarness => {
                let harness;
                let watch;
                let restarts;
                let verdictAt;
                let maskedLeft;
                const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
                before(async function () {
                    this.timeout(120000);
                    harness = getHarness();
                    clearInstanceData(harness);
                    watch = await watchObjectWrites(harness);
                    // The harness registers its own before() (fresh DB) ahead of this one,
                    // so the seed survives and the adapter starts on top of the OLD objects.
                    await seedPrevious(harness, previous);
                    await restoreMaskedSecrets(harness);
                    maskedLeft = await maskedSecretsLeft(harness);
                    await resetInstanceNative(harness);
                    // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
                    // only compare in the same language.
                    await setSystemLanguage(harness, FIRST_LANGUAGE);
                    restarts = playControllerRestarts(harness, watch, HOOK);
                    await harness.startAdapterAndWait(false, adapterEnv(HOOK));
                    await feedFixtures(harness);
                    // On the seeded set feedFixtures may return at once, or wait for a state this run writes
                    // itself; waitForAdapterWork adds the adapter's last start step either way.
                    await waitForAdapterWork(harness);
                    // A migration that wrote the instance object restarts the instance (round 64) — the verdict
                    // comes after the second start has done its work.
                    await restarts.done;
                    await waitForAdapterWork(harness);
                    verdictAt = Date.now();
                    fs.writeFileSync(path.join(RESOURCE_DIR, "window.json"), JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }));
                });

                it("every current object carries the current texts and roles", async function () {
                    this.timeout(30000);
                    const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
                    const live = await dumpObjects(harness);
                    const stale = [];
                    for (const [id, obj] of Object.entries(current)) {
                        const got = live[id];
                        if (!got) { stale.push(`${id}: missing after upgrade`); continue; }
                        // Every field of `common`, not a chosen few: an adapter writes only what differs (round 61),
                        // so every changed field must reach an existing installation.
                        for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
                            if (f === "custom") {
                                continue; // the user's recording — judged on its own below (round 64)
                            }
                            if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
                            }
                        }
                        // The KIND of the object (state/channel/device/folder/meta) lives one level
                        // ABOVE `common`; `common.type` is the VALUE type (string/number/
                        // boolean) — something entirely different that merely shares the name. Without
                        // this comparison a type migration that never reaches an existing installation
                        // stays green: every text matches while every datapoint under the wrongly
                        // declared container is a repochecker E2001 (hueemu v1.17.0, `clients` from
                        // `meta` to `folder` — found on the live tree, by no gate).
                        if (got.type !== obj.type) {
                            stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
                        }
                    }
                    assert.deepStrictEqual(stale, [], "objects an update did not reach:\n" + stale.join("\n"));
                });

                it("objects the release removed are gone (no leftovers)", async function () {
                    this.timeout(30000);
                    const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
                    const live = await dumpObjects(harness);
                    const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
                    assert.deepStrictEqual(leftovers, [], "leftover objects:\n" + leftovers.join("\n"));
                });

                it("rewrites no object unchanged", function () {
                    const idle = [...new Set(watch.unchanged)];
                    assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
                });

                it("rewrites no indicator state unchanged", function () {
                    const idle = [...new Set(watch.unchangedIndicators)];
                    assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
                });

                // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
                // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
                it("deletes no object the release keeps", function () {
                    const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
                    const lost = [...new Set(watch.deleted)].filter((id) => id in previous && id in current);
                    assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
                });

                it("starts on no masked secret from the previous dump", function () {
                    assert.deepStrictEqual(maskedLeft, [], `seeded objects still carry ${ENCRYPTED_MARKER}:\n${maskedLeft.join("\n")}`);
                });

                it("a recording goes on only with its own datapoint", async function () {
                    this.timeout(30000);
                    const live = await dumpObjects(harness);
                    const carriers = new Map();
                    for (const [id, obj] of Object.entries(live)) {
                        const origin = obj.common?.custom?.[RECORDING]?.origin;
                        if (origin) {
                            carriers.set(origin, [...(carriers.get(origin) ?? []), id]);
                        }
                    }
                    const wrong = [];
                    for (const [origin, ids] of carriers) {
                        if (ids.length > 1) {
                            wrong.push(`${origin} → ${ids.join(", ")}: one recording on several datapoints`);
                        } else if (ids[0] !== origin && origin in live) {
                            wrong.push(`${origin} → ${ids[0]}: copied while ${origin} lives on`);
                        } else if (ids[0] !== origin && live[ids[0]].common?.type !== previous[origin]?.common?.type) {
                            wrong.push(`${origin} → ${ids[0]}: another value type — a new datapoint, not the same one moved`);
                        }
                    }
                    // A state that lives on keeps what hangs on it — the recording is the user's, never destroyed.
                    for (const [id, obj] of Object.entries(previous)) {
                        if (obj.type === "state" && live[id]?.type === "state" && !carriers.get(id)?.includes(id)) {
                            wrong.push(`${id}: its recording is gone although the datapoint lives on`);
                        }
                    }
                    // A state the release moves under a new id (MOVES) takes its recording along (krobi 2026-09-02).
                    for (const [from, to] of Object.entries(MOVES)) {
                        if (previous[from]?.type === "state" && !carriers.get(from)?.includes(to)) {
                            wrong.push(`${from} → ${to}: its recording did not move with the datapoint`);
                        }
                    }
                    assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
                });

                // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
                // a datapoint created because the old one was recorded is exactly that).
                it("creates nothing a fresh installation lacks", async function () {
                    this.timeout(30000);
                    const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
                    const live = await dumpObjects(harness);
                    const extra = Object.keys(live).filter((id) => !(id in current));
                    assert.deepStrictEqual(extra, [], `objects a fresh installation does not have:\n${extra.join("\n")}`);
                });

                it("restarts at most once for its own instance object", function () {
                    assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
                });

                // Last in the suite: a write after the verdict means waitForAdapterWork ended before the adapter did.
                it("writes nothing after the verdict", async function () {
                    this.timeout(SETTLE_MS + 5000);
                    await new Promise((resolve) => setTimeout(resolve, Math.max(0, verdictAt + SETTLE_MS - Date.now())));
                    const late = [...new Set(watch.times.filter(([, t]) => t > verdictAt).map(([id]) => id))];
                    assert.deepStrictEqual(late, [], `objects written after the verdict:\n${late.join("\n")}`);
                });
            });
        }
    },
});

// govee-smart: the fake cloud and LAN light end with the run.
after(async function () {
    const [cloud, lan] = await FIXTURE_SERVERS;
    cloud.close();
    lan.socket.close();
});

// Round 62: after every suite, every adapter process of this run has exited — what it left open after onUnload fails
// the run. Every start leaves a marker: no marker means a start without adapterEnv(), a marker without a report a
// process that never reached its exit (killed after a hanging onUnload, or crashed).
after(function () {
    const files = fs.readdirSync(RESOURCE_DIR);
    const starts = files.filter((f) => f.endsWith(".start")).map((f) => f.slice(0, -".start".length));
    const silent = starts.filter((pid) => !files.includes(`${pid}.json`));
    const reports = starts
        .filter((pid) => !silent.includes(pid))
        .map((pid) => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.json`), "utf8")));
    const left = reports.flatMap((r) => r.left);
    const reread = reports.flatMap((r) => Object.entries(r.quiet).filter(([id]) => READ_ONLY.has(id)).map(([id, n]) => `${id} ×${n}`));
    fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
    assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
    assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
    assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
    assert.deepStrictEqual(reread, [], `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`);
});
