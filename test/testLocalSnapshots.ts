import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSnapshotStore, type LocalSnapshot } from "../src/lib/local-snapshots";

const mockLog: ioBroker.Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
    level: "debug",
};

describe("LocalSnapshotStore", () => {
    let tmpDir: string;
    let store: LocalSnapshotStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
        store = new LocalSnapshotStore(tmpDir, mockLog);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should create snapshots directory on construction", () => {
        expect(fs.existsSync(path.join(tmpDir, "snapshots"))).to.be.true;
    });

    it("should return empty array for device with no snapshots", () => {
        const snaps = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(snaps).to.deep.equal([]);
    });

    it("should save and retrieve a snapshot", () => {
        const snap: LocalSnapshot = {
            name: "Abendstimmung",
            power: true,
            brightness: 80,
            colorRgb: "#ff6600",
            colorTemperature: 0,
            savedAt: 1712700000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(1);
        expect(result[0].name).to.equal("Abendstimmung");
        expect(result[0].power).to.be.true;
        expect(result[0].brightness).to.equal(80);
        expect(result[0].colorRgb).to.equal("#ff6600");
        expect(result[0].colorTemperature).to.equal(0);
    });

    it("should overwrite snapshot with same name", () => {
        const snap1: LocalSnapshot = {
            name: "Test",
            power: true,
            brightness: 50,
            colorRgb: "#ff0000",
            colorTemperature: 0,
            savedAt: 1000,
        };
        const snap2: LocalSnapshot = {
            name: "Test",
            power: false,
            brightness: 0,
            colorRgb: "#000000",
            colorTemperature: 0,
            savedAt: 2000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(1);
        expect(result[0].power).to.be.false;
        expect(result[0].savedAt).to.equal(2000);
    });

    it("should store multiple snapshots", () => {
        const snap1: LocalSnapshot = {
            name: "Morning",
            power: true,
            brightness: 100,
            colorRgb: "#ffffff",
            colorTemperature: 6500,
            savedAt: 1000,
        };
        const snap2: LocalSnapshot = {
            name: "Night",
            power: true,
            brightness: 10,
            colorRgb: "#ff3300",
            colorTemperature: 0,
            savedAt: 2000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(2);
        expect(result[0].name).to.equal("Morning");
        expect(result[1].name).to.equal("Night");
    });

    it("should delete a snapshot by name", () => {
        const snap: LocalSnapshot = {
            name: "ToDelete",
            power: true,
            brightness: 50,
            colorRgb: "#aabbcc",
            colorTemperature: 0,
            savedAt: 1000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
        const deleted = store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "ToDelete");
        expect(deleted).to.be.true;

        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(0);
    });

    it("should return false when deleting non-existent snapshot", () => {
        const deleted = store.deleteSnapshot("H6160", "AABBCCDDEEFF0011", "Nope");
        expect(deleted).to.be.false;
    });

    it("should keep separate files per device", () => {
        const snap1: LocalSnapshot = {
            name: "Device1Snap",
            power: true,
            brightness: 50,
            colorRgb: "#ff0000",
            colorTemperature: 0,
            savedAt: 1000,
        };
        const snap2: LocalSnapshot = {
            name: "Device2Snap",
            power: false,
            brightness: 0,
            colorRgb: "#00ff00",
            colorTemperature: 4000,
            savedAt: 2000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
        store.saveSnapshot("H6160", "AABBCCDDEEFF2222", snap2);

        const result1 = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        const result2 = store.getSnapshots("H6160", "AABBCCDDEEFF2222");
        expect(result1).to.have.lengthOf(1);
        expect(result1[0].name).to.equal("Device1Snap");
        expect(result2).to.have.lengthOf(1);
        expect(result2[0].name).to.equal("Device2Snap");
    });

    it("should handle corrupt JSON gracefully", () => {
        const snapDir = path.join(tmpDir, "snapshots");
        fs.writeFileSync(path.join(snapDir, "h6160_0011.json"), "NOT JSON!", "utf-8");

        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.deep.equal([]);
    });

    it("should save and retrieve snapshot with segment data", () => {
        const snap: LocalSnapshot = {
            name: "Segments",
            power: true,
            brightness: 80,
            colorRgb: "#ff6600",
            colorTemperature: 0,
            segments: [
                { color: "#ff0000", brightness: 100 },
                { color: "#00ff00", brightness: 50 },
                { color: "#0000ff", brightness: 75 },
            ],
            savedAt: 3000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(1);
        expect(result[0].segments).to.have.lengthOf(3);
        expect(result[0].segments![0]).to.deep.equal({ color: "#ff0000", brightness: 100 });
        expect(result[0].segments![1]).to.deep.equal({ color: "#00ff00", brightness: 50 });
        expect(result[0].segments![2]).to.deep.equal({ color: "#0000ff", brightness: 75 });
    });

    it("should handle snapshot without segments (backwards compatible)", () => {
        const snap: LocalSnapshot = {
            name: "NoSegments",
            power: true,
            brightness: 50,
            colorRgb: "#ffffff",
            colorTemperature: 4000,
            savedAt: 4000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result[0].segments).to.be.undefined;
    });

    it("should overwrite segment data when updating snapshot", () => {
        const snap1: LocalSnapshot = {
            name: "SegUpdate",
            power: true,
            brightness: 80,
            colorRgb: "#ff0000",
            colorTemperature: 0,
            segments: [{ color: "#ff0000", brightness: 100 }],
            savedAt: 1000,
        };
        const snap2: LocalSnapshot = {
            name: "SegUpdate",
            power: true,
            brightness: 80,
            colorRgb: "#00ff00",
            colorTemperature: 0,
            segments: [
                { color: "#00ff00", brightness: 50 },
                { color: "#0000ff", brightness: 25 },
            ],
            savedAt: 2000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap1);
        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap2);

        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result).to.have.lengthOf(1);
        expect(result[0].segments).to.have.lengthOf(2);
        expect(result[0].segments![0].color).to.equal("#00ff00");
    });

    it("should preserve color temperature in snapshot", () => {
        const snap: LocalSnapshot = {
            name: "Warm",
            power: true,
            brightness: 60,
            colorRgb: "#000000",
            colorTemperature: 3200,
            savedAt: 1000,
        };

        store.saveSnapshot("H6160", "AABBCCDDEEFF0011", snap);
        const result = store.getSnapshots("H6160", "AABBCCDDEEFF0011");
        expect(result[0].colorTemperature).to.equal(3200);
    });
});
