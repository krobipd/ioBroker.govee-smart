import { expect } from "chai";
import { buildScenePackets, buildGradientPacket, buildSegmentColorPacket } from "../src/lib/govee-lan-client";

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

describe("buildSegmentColorPacket", () => {
    it("should encode RGB and single segment in left bitmask", () => {
        const buf = Buffer.from(buildSegmentColorPacket([3], 0xff, 0x00, 0x80), "base64");
        expect(buf).to.have.lengthOf(20);
        expect(buf[0]).to.equal(0x33);
        expect(buf[1]).to.equal(0x05);
        expect(buf[2]).to.equal(0x0b);
        expect(buf[3]).to.equal(0xff); // R
        expect(buf[4]).to.equal(0x00); // G
        expect(buf[5]).to.equal(0x80); // B
        expect(buf[6]).to.equal(1 << 3); // left mask: segment 3
        expect(buf[7]).to.equal(0x00); // right mask: empty
    });

    it("should encode multiple segments across both bitmasks", () => {
        const buf = Buffer.from(buildSegmentColorPacket([0, 7, 8, 14], 0x10, 0x20, 0x30), "base64");
        expect(buf[6]).to.equal((1 << 0) | (1 << 7)); // left: segments 0 + 7
        expect(buf[7]).to.equal((1 << 0) | (1 << 6)); // right: segments 8 + 14
    });

    it("should encode all segments 0-15", () => {
        const allSegs = Array.from({ length: 16 }, (_, i) => i);
        const buf = Buffer.from(buildSegmentColorPacket(allSegs, 0, 0, 0), "base64");
        expect(buf[6]).to.equal(0xff); // left: all 8 bits
        expect(buf[7]).to.equal(0xff); // right: all 8 bits
    });

    it("should ignore segments >= 16", () => {
        const buf = Buffer.from(buildSegmentColorPacket([16, 20], 0, 0, 0), "base64");
        expect(buf[6]).to.equal(0x00);
        expect(buf[7]).to.equal(0x00);
    });

    it("should have valid XOR checksum", () => {
        const buf = Buffer.from(buildSegmentColorPacket([1, 5, 10], 0xaa, 0xbb, 0xcc), "base64");
        let xor = 0;
        for (let i = 0; i < 19; i++) {
            xor ^= buf[i];
        }
        expect(buf[19]).to.equal(xor);
    });
});
