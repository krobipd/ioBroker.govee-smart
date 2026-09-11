"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller
//   against a fake Govee cloud (test/fixtures/inventory/govee-cloud.json — an
//   account holding EVERY device kind the adapter supports, not just the
//   maintainer's own) plus a fake LAN light answering real UDP on loopback, then
//   dump every govee-smart.0.* object to test/objects.inventory.json in the
//   ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current name/desc/role/type/unit and that removed objects are gone.
const assert = require("node:assert");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const HOOK = path.join(__dirname, "inventory-https-hook.cjs");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "govee-cloud.json"), "utf8"));
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];

const FIXTURE_PORT = 18099;
const LAN_LISTEN_PORT = 4002; // where the adapter listens for device replies
const LAN_COMMAND_PORT = 4003; // where devices listen for adapter commands
const LAN_DEVICE = { sku: "H6172", device: "AA:BB:CC:DD:EE:FF:00:01" };

/** Adapter-specific config the fixtures need. The hosts are rewritten by the hook. */
const FIXTURE_NATIVE = {
  // A real Govee key is a strict UUID — the adapter refuses anything else
  // outright (the v2.11.0 encryption-migration detector), so a made-up string
  // never reaches the cloud client.
  apiKey: "12345678-1234-4321-8765-123456789abc",
  goveeEmail: "",
  goveePassword: "",
  networkInterface: "",
};

/**
 * The instance config the fixtures run on.
 *
 * The values go in as PLAIN TEXT: the instance object declares
 * `encryptedNative: ["apiKey", …]`, and @iobroker/testing 6 encrypts those
 * fields itself when the config is written. Encrypting them here as well —
 * which v5 required, because it wrote the value through unchanged — hands the
 * adapter the double-encrypted key, and it fails as a header value ("Invalid
 * character in header content") long before it fails as a credential: the
 * cloud never answers, and the inventory comes out with 26 objects instead of
 * 262 while every gate above it stays green.
 */
function fixtureNative() {
  return { ...FIXTURE_NATIVE };
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
                        ? { temperature: 22 }
                        : c.instance === "workMode"
                          ? { workMode: 1, modeValue: 1 }
                          : 50;
    caps.push({ type: c.type, instance: c.instance, state: { value } });
  }
  return caps;
}

/**
 * The captured per-device answers of the two verbatim lights (audit 2026-09-11):
 * scenes, DIY scenes and the state read, keyed by the fixture's device id. A
 * device without an entry here gets the hand-built answers below.
 */
const CAPTURED = {};
for (const sku of ["h61a8", "h6199"]) {
  const scenes = require(`./fixtures/inventory/govee-${sku}-scenes.json`);
  CAPTURED[scenes.device] = {
    scenes,
    diyScenes: require(`./fixtures/inventory/govee-${sku}-diy-scenes.json`),
    state: require(`./fixtures/inventory/govee-${sku}-state.json`),
  };
}

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
        reply(okPayload(captured ? captured.diyScenes : scenesFor()));
      } else if (url.includes("/router/api/v1/device/scenes")) {
        const captured = CAPTURED[parsed.payload?.device];
        reply(okPayload(captured ? captured.scenes : scenesFor()));
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

/**
 * Drive the adapter with the fixtures until its object tree is complete.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 * @param {{ announce: () => void }} lan The fake LAN light
 */
async function feedFixtures(harness, lan) {
  // The LAN scan runs every 30 s; announcing repeatedly makes the first one
  // land whenever the adapter's listen socket came up.
  for (let i = 0; i < 12; i++) {
    lan.announce();
    await new Promise(r => setTimeout(r, 1000));
  }
  // Then WAIT FOR THE TREE, never for a duration. Group objects are created
  // only after the account's group list has been resolved, which is one more
  // round trip than the device list — on a slower run that landed after the
  // fixed 12 s and the inventory came out four objects short. A fixed sleep
  // makes the machine decide what the inventory contains; the settle check
  // makes the adapter decide.
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 120 && stable < 5; i++) {
    const count = (await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}\u9999` })).rows.length;
    stable = count === previous ? stable + 1 : 0;
    previous = count;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (stable < 5) {
    throw new Error(`object tree never settled — still changing after 120 s (last count ${previous})`);
  }
}

/**
 * Remove every object below the adapter namespace, so a dump measures this run
 * alone and not what a previous one left in the reused temp controller.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 */
async function wipeNamespace(harness) {
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}\u9999` });
  for (const row of list.rows) {
    await harness.objects.delObjectAsync(row.id);
  }
}

/**
 * The tree key the adapter builds for a device: lower-case SKU plus the last
 * four hex pairs of the Govee device id, colons dropped.
 *
 * @param {{sku: string, device: string}} entry Fixture device
 */
function treeKeyFor(entry) {
  const tail = entry.device.replace(/:/g, "").slice(-4).toLowerCase();
  return `${entry.sku.toLowerCase()}_${tail}`;
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

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let cloud;
      let lan;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        // Start from an EMPTY namespace. The inventory is supposed to say what
        // THIS adapter run creates; anything an earlier run left in the reused
        // temp controller would be dumped as if the adapter had just made it.
        // That is not hypothetical: a run once produced four group objects the
        // fixture cannot create at all (it carries no account, so group members
        // are never resolved), and the file went into the release that way.
        await wipeNamespace(harness);
        cloud = await startFakeCloud();
        lan = await startFakeLanDevice();
        await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative() });
        await harness.startAdapterAndWait(false, {
          NODE_OPTIONS: `--require ${HOOK}`,
          GOVEE_FIXTURE_PORT: String(FIXTURE_PORT),
        });
        await feedFixtures(harness, lan);
      });
      after(() => {
        cloud?.close();
        lan?.socket.close();
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        // "not empty" is not an assertion — it passed on a run that produced 26
        // objects instead of 262, because the cloud never answered and only the
        // manifest's own info tree existed. Every gate above it stayed green:
        // the dependency guard runs lint/test/build and never this file, and the
        // inventory gate prints the removed objects but does not fail on them.
        // So the fixture list itself is the yardstick: every device in it must
        // have reached the tree.
        const missing = FIXTURE.devices
          // The two pseudo-devices Govee returns in the account list get no
          // tree here: SameModeGroup is never merged at all, and a BaseGroup
          // only becomes a tree once its members are resolved — which needs
          // account credentials this fixture deliberately does not carry.
          .filter(d => d.sku !== "SameModeGroup" && d.sku !== "BaseGroup")
          .map(d => treeKeyFor(d))
          .filter(prefix => !objects[`${NS}devices.${prefix}`]);
        assert.deepStrictEqual(missing, [], `fixture devices missing from the object tree: ${missing.join(", ")}`);
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let cloud;
        let lan;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          cloud = await startFakeCloud();
          lan = await startFakeLanDevice();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative() });
          await harness.startAdapterAndWait(false, {
            NODE_OPTIONS: `--require ${HOOK}`,
            GOVEE_FIXTURE_PORT: String(FIXTURE_PORT),
          });
          await feedFixtures(harness, lan);
        });
        after(() => {
          cloud?.close();
          lan?.socket.close();
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The object's KIND (state/channel/device/folder/meta) sits one level
            // ABOVE `common`; the `type` in COMPARED is the VALUE type and something
            // entirely different — they only share a name. Without this comparison a
            // failed type migration stays green on an existing installation.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
