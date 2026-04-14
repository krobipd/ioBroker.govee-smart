import { expect } from "chai";
import { buildScenePackets, buildGradientPacket, buildMusicModePacket, buildDiyPackets, buildSegmentBitmask, buildSegmentColorPacket, buildSegmentBrightnessPacket, applySceneSpeed } from "../src/lib/govee-lan-client";

describe("buildScenePackets", () => {
    it("should build a single activation packet for scene code only", () => {
        const packets = buildScenePackets(42, "");
        expect(packets).to.have.lengthOf(1);
        // Decode the activation packet
        const buf = Buffer.from(packets[0], "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33); // cmd
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x04);
        expect(buf[3]).to.equal(42); // lo byte
        expect(buf[4]).to.equal(0);  // hi byte
        // Bytes 5-18 should be zero padding
        for (let i = 5; i < 19; i++) {
            expect(buf[i]).to.equal(0);
        }
        // Last byte is XOR checksum
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });

    it("should encode scene code as little-endian 16-bit", () => {
        const packets = buildScenePackets(0x1234, "");
        const buf = Buffer.from(packets[0], "base64");
        expect(buf[3]).to.equal(0x34); // lo
        expect(buf[4]).to.equal(0x12); // hi
    });

    it("should include A3 data packets for scenceParam", () => {
        // Small param: 5 bytes → fits in one A3 packet + activation
        const param = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64");
        const packets = buildScenePackets(100, param);
        expect(packets.length).to.be.greaterThan(1);
        // Last packet is always the activation packet
        const lastBuf = Buffer.from(packets[packets.length - 1], "base64");
        expect(lastBuf[0]).to.equal(0x33);
        expect(lastBuf[1]).to.equal(0x05);
        expect(lastBuf[2]).to.equal(0x04);
        expect(lastBuf[3]).to.equal(100); // lo
        expect(lastBuf[4]).to.equal(0);   // hi
        // First packet should start with A3 header
        const firstBuf = Buffer.from(packets[0], "base64");
        expect(firstBuf[0]).to.equal(0xa3);
    });

    it("should produce 20-byte packets with valid XOR checksums", () => {
        // Larger param data to produce multiple A3 packets
        const bigParam = Buffer.alloc(40, 0xab).toString("base64");
        const packets = buildScenePackets(500, bigParam);
        for (const p of packets) {
            const buf = Buffer.from(p, "base64");
            expect(buf).to.have.lengthOf(20);
            // Verify XOR checksum
            let xor = 0;
            for (let i = 0; i < 19; i++) {
                xor ^= buf[i];
            }
            expect(buf[19]).to.equal(xor);
        }
    });

    it("should handle empty scenceParam (scene code only)", () => {
        const packets = buildScenePackets(1, "");
        expect(packets).to.have.lengthOf(1);
    });
});

describe("buildGradientPacket", () => {
    it("should build gradient ON packet", () => {
        const buf = Buffer.from(buildGradientPacket(true), "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x14);
        expect(buf[2]).to.equal(0x01);
        for (let i = 3; i < 19; i++) {
            expect(buf[i]).to.equal(0);
        }
    });

    it("should build gradient OFF packet", () => {
        const buf = Buffer.from(buildGradientPacket(false), "base64");
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x14);
        expect(buf[2]).to.equal(0x00);
    });

    it("should have valid XOR checksum", () => {
        const buf = Buffer.from(buildGradientPacket(true), "base64");
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });
});

describe("buildMusicModePacket", () => {
    it("should build Energic mode (0) without RGB", () => {
        const buf = Buffer.from(buildMusicModePacket(0), "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x01);
        expect(buf[3]).to.equal(0x00);
        for (let i = 4; i < 19; i++) {
            expect(buf[i]).to.equal(0);
        }
    });

    it("should build Spectrum mode (1) with RGB", () => {
        const buf = Buffer.from(buildMusicModePacket(1, 0xff, 0x80, 0x00), "base64");
        expect(buf[3]).to.equal(0x01);
        expect(buf[4]).to.equal(0xff);
        expect(buf[5]).to.equal(0x80);
        expect(buf[6]).to.equal(0x00);
    });

    it("should build Rolling mode (2) with RGB", () => {
        const buf = Buffer.from(buildMusicModePacket(2, 0x10, 0x20, 0x30), "base64");
        expect(buf[3]).to.equal(0x02);
        expect(buf[4]).to.equal(0x10);
        expect(buf[5]).to.equal(0x20);
        expect(buf[6]).to.equal(0x30);
    });

    it("should build Rhythm mode (3) without RGB", () => {
        const buf = Buffer.from(buildMusicModePacket(3, 0xff, 0xff, 0xff), "base64");
        expect(buf[3]).to.equal(0x03);
        expect(buf[4]).to.equal(0x00);
    });

    it("should have valid XOR checksum", () => {
        const buf = Buffer.from(buildMusicModePacket(1, 255, 0, 128), "base64");
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });
});

describe("buildDiyPackets", () => {
    it("should build activation-only packet when no param data", () => {
        const packets = buildDiyPackets("");
        expect(packets).to.have.lengthOf(1);
        const buf = Buffer.from(packets[0], "base64");
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x0a);
    });

    it("should include A1 data packets for scenceParam", () => {
        const param = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64");
        const packets = buildDiyPackets(param);
        expect(packets.length).to.be.greaterThan(1);
        const firstBuf = Buffer.from(packets[0], "base64");
        expect(firstBuf[0]).to.equal(0xa1);
        const lastBuf = Buffer.from(packets[packets.length - 1], "base64");
        expect(lastBuf[0]).to.equal(0x33);
        expect(lastBuf[1]).to.equal(0x05);
        expect(lastBuf[2]).to.equal(0x0a);
    });

    it("should produce 20-byte packets with valid checksums", () => {
        const bigParam = Buffer.alloc(30, 0xcd).toString("base64");
        const packets = buildDiyPackets(bigParam);
        for (const p of packets) {
            const buf = Buffer.from(p, "base64");
            expect(buf).to.have.lengthOf(20);
            let xor = 0;
            for (let i = 0; i < 19; i++) {
                xor ^= buf[i];
            }
            expect(buf[19]).to.equal(xor);
        }
    });
});

describe("buildSegmentBitmask", () => {
    it("should set bit 0 for segment 0", () => {
        const mask = buildSegmentBitmask([0], 7);
        expect(mask[0]).to.equal(0x01);
        for (let i = 1; i < 7; i++) {
            expect(mask[i]).to.equal(0);
        }
    });

    it("should set bit 5 for segment 5", () => {
        const mask = buildSegmentBitmask([5], 7);
        expect(mask[0]).to.equal(0x20);
    });

    it("should set bits across multiple bytes", () => {
        const mask = buildSegmentBitmask([0, 8, 16], 7);
        expect(mask[0]).to.equal(0x01);
        expect(mask[1]).to.equal(0x01);
        expect(mask[2]).to.equal(0x01);
    });

    it("should handle multi-segment in same byte (3+4+5 = 0x38)", () => {
        const mask = buildSegmentBitmask([3, 4, 5], 7);
        expect(mask[0]).to.equal(0x38);
    });

    it("should ignore segments beyond byte count", () => {
        const mask = buildSegmentBitmask([56], 7);
        for (let i = 0; i < 7; i++) {
            expect(mask[i]).to.equal(0);
        }
    });
});

describe("buildSegmentColorPacket", () => {
    it("should build 20-byte packet with correct header", () => {
        const buf = Buffer.from(buildSegmentColorPacket(0, 255, 0, [5]), "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x15);
        expect(buf[3]).to.equal(0x01);
        expect(buf[4]).to.equal(0);
        expect(buf[5]).to.equal(255);
        expect(buf[6]).to.equal(0);
    });

    it("should match verified test packet for segment 5 green", () => {
        // Research: 33 05 15 01 00 ff 00 00 00 00 00 00 20 00 00 00 00 00 00 fd
        const buf = Buffer.from(buildSegmentColorPacket(0, 0xff, 0, [5]), "base64");
        expect(buf[12]).to.equal(0x20);
        expect(buf[19]).to.equal(0xfd);
    });

    it("should match verified test packet for segments 3+4+5 blue", () => {
        // Research: 33 05 15 01 00 00 ff 00 00 00 00 00 38 00 00 00 00 00 00 e5
        const buf = Buffer.from(buildSegmentColorPacket(0, 0, 0xff, [3, 4, 5]), "base64");
        expect(buf[12]).to.equal(0x38);
        expect(buf[19]).to.equal(0xe5);
    });

    it("should handle high segment numbers (10+11+12)", () => {
        // Research: 33 05 15 01 ff 00 00 00 00 00 00 00 00 1c 00 00 00 00 00 c1
        const buf = Buffer.from(buildSegmentColorPacket(0xff, 0, 0, [10, 11, 12]), "base64");
        expect(buf[13]).to.equal(0x1c);
        expect(buf[19]).to.equal(0xc1);
    });

    it("should have valid XOR checksum", () => {
        const buf = Buffer.from(buildSegmentColorPacket(128, 64, 32, [0, 7]), "base64");
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });
});

describe("buildSegmentBrightnessPacket", () => {
    it("should build 20-byte packet with correct header", () => {
        const buf = Buffer.from(buildSegmentBrightnessPacket(30, [5]), "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x15);
        expect(buf[3]).to.equal(0x02);
        expect(buf[4]).to.equal(30);
    });

    it("should match verified test packet for segment 5 brightness 30%", () => {
        // Research: 33 05 15 02 1e 20 00 00 00 00 00 00 00 00 00 00 00 00 00 1f
        const buf = Buffer.from(buildSegmentBrightnessPacket(30, [5]), "base64");
        expect(buf[4]).to.equal(0x1e);
        expect(buf[5]).to.equal(0x20);
        expect(buf[19]).to.equal(0x1f);
    });

    it("should clamp brightness to 0-100", () => {
        const buf = Buffer.from(buildSegmentBrightnessPacket(150, [0]), "base64");
        expect(buf[4]).to.equal(100);
    });

    it("should have valid XOR checksum", () => {
        const buf = Buffer.from(buildSegmentBrightnessPacket(50, [0, 1, 2]), "base64");
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });
});

describe("applySceneSpeed", () => {
    it("should replace speed byte at pageLength - 5", () => {
        // 1 page, 26 bytes data. Speed byte at position 21 (26-5).
        const pageData = new Array(26).fill(0);
        pageData[21] = 255; // default speed
        const param = Buffer.from([1, 26, ...pageData]).toString("base64");
        const config = JSON.stringify([{ page: 0, defaultIndex: 1, moveIn: [242, 249, 254] }]);

        const result = applySceneSpeed(param, 0, config);
        const bytes = Array.from(Buffer.from(result, "base64"));
        expect(bytes[2 + 21]).to.equal(242); // moveIn[0]
    });

    it("should handle multiple pages with different configs", () => {
        // 2 pages, each 10 bytes. Speed at position 5 (10-5).
        const page0 = new Array(10).fill(0);
        page0[5] = 200;
        const page1 = new Array(10).fill(0);
        page1[5] = 200;
        const param = Buffer.from([2, 10, ...page0, 10, ...page1]).toString("base64");
        const config = JSON.stringify([
            { page: 0, moveIn: [100, 110] },
            { page: 1, moveIn: [120, 130] },
        ]);

        const result = applySceneSpeed(param, 1, config);
        const bytes = Array.from(Buffer.from(result, "base64"));
        // Page 0: offset=1, data starts at 2, speed at 2+5=7
        expect(bytes[7]).to.equal(110); // moveIn[1] for page 0
        // Page 1: offset=1+1+10=12, data starts at 13, speed at 13+5=18
        expect(bytes[18]).to.equal(130); // moveIn[1] for page 1
    });

    it("should return original param when no config matches", () => {
        const pageData = new Array(10).fill(0xAA);
        const param = Buffer.from([1, 10, ...pageData]).toString("base64");
        const config = JSON.stringify([{ page: 5, moveIn: [100] }]); // page 5 doesn't exist

        const result = applySceneSpeed(param, 0, config);
        expect(result).to.equal(param);
    });

    it("should return original param for empty config", () => {
        const param = Buffer.from([1, 5, 0, 0, 0, 0, 0]).toString("base64");
        expect(applySceneSpeed(param, 0, "")).to.equal(param);
        expect(applySceneSpeed(param, 0, "invalid")).to.equal(param);
        expect(applySceneSpeed(param, 0, "[]")).to.equal(param);
    });

    it("should not modify when speedLevel exceeds moveIn range", () => {
        const pageData = new Array(10).fill(0);
        pageData[5] = 200;
        const param = Buffer.from([1, 10, ...pageData]).toString("base64");
        const config = JSON.stringify([{ page: 0, moveIn: [100, 110] }]);

        const result = applySceneSpeed(param, 5, config); // level 5 > moveIn.length
        const bytes = Array.from(Buffer.from(result, "base64"));
        expect(bytes[7]).to.equal(200); // unchanged
    });
});
