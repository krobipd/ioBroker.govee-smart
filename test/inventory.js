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
const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "govee-cloud.json"), "utf8"),
);
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
 * Encrypt a config value the way js-controller does, so the adapter's automatic
 * decryption gives the plain value back.
 *
 * The instance object declares `encryptedNative: ["apiKey", ...]`, so writing the
 * key in plain text does not produce a plain key at the other end — it produces
 * the XOR of the key with the system secret, which then fails as a header value
 * ("Invalid character in header content") long before it fails as a credential.
 *
 * @param {string} secret system.config native.secret
 * @param {string} value The plain value
 */
function encryptValue(secret, value) {
    if (!/^[0-9a-f]{64}$/.test(secret)) {
        // Legacy XOR — what js-controller uses while the secret is not a 32-byte key.
        let result = "";
        for (let i = 0; i < value.length; ++i) {
            result += String.fromCharCode(secret.charCodeAt(i % secret.length) ^ value.charCodeAt(i));
        }
        return result;
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-192-cbc", Buffer.from(secret, "hex").subarray(0, 24), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `$/aes-192-cbc:${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * The fixture config with every `encryptedNative` field encrypted for THIS
 * throwaway controller's secret.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 */
async function fixtureNative(harness) {
    const sysConfig = await harness.objects.getObjectAsync("system.config");
    const secret = sysConfig?.native?.secret || "";
    return { ...FIXTURE_NATIVE, apiKey: encryptValue(secret, FIXTURE_NATIVE.apiKey) };
}

/** Cloud REST envelope Govee puts around every payload. */
function ok(payload) {
    return JSON.stringify({ code: 200, message: "success", data: payload });
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

/** Scenes + snapshots for a light, from the separate scenes endpoint. */
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
                reply(ok({ sku: parsed.payload?.sku, device: parsed.payload?.device, capabilities: stateFor(parsed.payload?.device) }));
            } else if (url.includes("/router/api/v1/device/scenes") || url.includes("/router/api/v1/device/diy-scenes")) {
                reply(ok(scenesFor()));
            } else if (url.includes("/router/api/v1/device/control")) {
                reply(ok({ capability: {} }));
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
                            data: { ip: "127.0.0.1", device: LAN_DEVICE.device, sku: LAN_DEVICE.sku, bleVersionHard: "1.00.01", wifiVersionSoft: "1.02.14" },
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
    void harness;
    // The LAN scan runs every 30 s; announcing repeatedly makes the first one
    // land whenever the adapter's listen socket came up.
    for (let i = 0; i < 12; i++) {
        lan.announce();
        await new Promise(r => setTimeout(r, 1000));
    }
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
                cloud = await startFakeCloud();
                lan = await startFakeLanDevice();
                await harness.changeAdapterConfig(ADAPTER, { native: await fixtureNative(harness) });
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
                assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
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
                    await harness.changeAdapterConfig(ADAPTER, { native: await fixtureNative(harness) });
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
