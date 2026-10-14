import { X509Certificate, createPublicKey } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pkcs12Kdf, rc2CbcDecrypt, readPkcs12 } from "./pkcs12";

// Bundles of one throwaway identity (fixture-cert.pem and its key), written by the tools that write them, password
// `fixture-pass`: LibreSSL 3.3.6 `pkcs12 -export` — RC2-40 certificate safe, 3DES key, the classic form; OpenSSL 3.6 with
// `-keypbe PBE-SHA1-3DES` and `-certpbe PBE-SHA1-3DES` (SHA-1 and SHA-256 MAC), `-certpbe NONE`, `-nomac`, `-nokeys`,
// `-nocerts`, and its default PBES2/AES-256 — an encryption a Govee bundle never carries (govee2mqtt's p12 0.6.3 decrypts
// only the two above, and it works for Govee's users).
const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "pkcs12");
const PASS = "fixture-pass";
const bundle = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const CERT = new X509Certificate(fs.readFileSync(path.join(FIXTURES, "fixture-cert.pem")));

/**
 * The identity the bundles carry: the certificate byte for byte, and the private key that belongs to it.
 *
 * @param result What readPkcs12 returned
 * @param result.key The key PEM
 * @param result.cert The certificate PEM
 */
function expectFixtureIdentity(result: { key: string; cert: string }): void {
  expect(new X509Certificate(result.cert).raw.equals(CERT.raw)).toBe(true);
  const fromKey = createPublicKey(result.key).export({ type: "spki", format: "der" });
  expect(fromKey.equals(CERT.publicKey.export({ type: "spki", format: "der" }))).toBe(true);
}

/**
 * A DER element with a short length (under 128 content bytes).
 *
 * @param tag The tag byte
 * @param content The content, concatenated
 */
function el(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
}

/**
 * One DER element: where its content starts and ends.
 *
 * @param buf The encoding
 * @param pos Where the element starts
 */
function tlv(buf: Buffer, pos: number): { start: number; end: number } {
  const first = buf[pos + 1];
  const count = first & 0x80 ? first & 0x7f : 0;
  const length = count ? buf.subarray(pos + 2, pos + 2 + count).reduce((n, b) => n * 256 + b, 0) : first;
  const start = pos + 2 + count;
  return { start, end: start + length };
}

/**
 * The same bundle in BER as Java keystores write it: indefinite lengths and the authenticated safe in two chunks.
 *
 * @param der The bundle in DER
 */
function asBer(der: Buffer): Buffer {
  const pfx = tlv(der, 0);
  const version = tlv(der, pfx.start);
  const authSafeInfo = tlv(der, version.end);
  const contentType = tlv(der, authSafeInfo.start);
  const explicit = tlv(der, contentType.end);
  const octetString = tlv(der, explicit.start);
  const content = der.subarray(octetString.start, octetString.end);
  const half = Math.floor(content.length / 2);
  const chunk = (part: Buffer): Buffer => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(part.length);
    return Buffer.concat([Buffer.from([0x04, 0x82]), length, part]);
  };
  const end = Buffer.from([0, 0]);
  return Buffer.concat([
    Buffer.from([0x30, 0x80]),
    der.subarray(pfx.start, version.end),
    Buffer.from([0x30, 0x80]),
    der.subarray(authSafeInfo.start, contentType.end),
    Buffer.from([0xa0, 0x80, 0x24, 0x80]),
    chunk(content.subarray(0, half)),
    chunk(content.subarray(half)),
    end,
    end,
    end,
    der.subarray(authSafeInfo.end, pfx.end),
    end,
  ]);
}

describe("readPkcs12", () => {
  it.each(["rc2-40-cert-safe.p12", "3des-cert-safe.p12", "3des-sha256-mac.p12", "plain-cert-safe.p12", "no-mac.p12"])(
    "reads the key and the certificate of %s",
    name => {
      expectFixtureIdentity(readPkcs12(bundle(name), PASS));
    },
  );

  it("hands the key over in the PEM form node-forge wrote (PKCS#1 for RSA) and the certificate as PEM", () => {
    const { key, cert } = readPkcs12(bundle("rc2-40-cert-safe.p12"), PASS);
    expect(key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(cert).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
  });

  it("reads the same bundle in BER with indefinite lengths and a chunked authenticated safe", () => {
    expectFixtureIdentity(readPkcs12(asBer(bundle("rc2-40-cert-safe.p12")), PASS));
  });

  it("names a wrong password at the MAC", () => {
    expect(() => readPkcs12(bundle("3des-cert-safe.p12"), "wrong")).toThrow(
      "PKCS#12: MAC could not be verified (wrong password?)",
    );
  });

  it("fails on a wrong password without a MAC instead of returning garbage", () => {
    expect(() => readPkcs12(bundle("no-mac.p12"), "wrong")).toThrow("PKCS#12: decryption failed (wrong password?)");
  });

  it("refuses an encryption a Govee bundle never carries, by its identifier", () => {
    expect(() => readPkcs12(bundle("aes-pbes2.p12"), PASS)).toThrow(
      "PKCS#12: unsupported encryption 1.2.840.113549.1.5.13",
    );
  });

  it("says so when the bundle carries no private key", () => {
    expect(() => readPkcs12(bundle("no-key.p12"), PASS)).toThrow("No private key found in P12");
  });

  it("says so when the bundle carries no certificate", () => {
    expect(() => readPkcs12(bundle("no-cert.p12"), PASS)).toThrow("No certificate found in P12");
  });

  it("reads bags nested in a SafeContents bag", () => {
    // the plain certificate safe's SafeContents wrapped once more as a safeContentsBag
    const der = bundle("plain-cert-safe.p12");
    const pfx = tlv(der, 0);
    const version = tlv(der, pfx.start);
    const authSafeInfo = tlv(der, version.end);
    const contentType = tlv(der, authSafeInfo.start);
    const explicit = tlv(der, contentType.end);
    const octetString = tlv(der, explicit.start);
    const authSafe = der.subarray(octetString.start, octetString.end);
    const infos = tlv(authSafe, 0);
    const first = tlv(authSafe, infos.start);
    const firstType = tlv(authSafe, first.start);
    const firstExplicit = tlv(authSafe, firstType.end);
    const firstOctets = tlv(authSafe, firstExplicit.start);
    const safeContents = authSafe.subarray(firstOctets.start, firstOctets.end);
    const nestedBag = Buffer.concat([
      Buffer.from([0x30, 0x82, 0, 0]),
      el(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x0a, 0x01, 0x06])),
      Buffer.from([0xa0, 0x82, safeContents.length >> 8, safeContents.length & 0xff]),
      safeContents,
    ]);
    nestedBag.writeUInt16BE(nestedBag.length - 4, 2);
    const wrapped = Buffer.concat([
      Buffer.from([0x30, 0x82, nestedBag.length >> 8, nestedBag.length & 0xff]),
      nestedBag,
    ]);
    const long = (tag: number, body: Buffer): Buffer =>
      Buffer.concat([Buffer.from([tag, 0x82, body.length >> 8, body.length & 0xff]), body]);
    const firstInfo = long(
      0x30,
      Buffer.concat([authSafe.subarray(first.start, firstType.end), long(0xa0, long(0x04, wrapped))]),
    );
    const newAuthSafe = long(0x30, Buffer.concat([firstInfo, authSafe.subarray(first.end, infos.end)]));
    const newInfo = long(
      0x30,
      Buffer.concat([der.subarray(authSafeInfo.start, contentType.end), long(0xa0, long(0x04, newAuthSafe))]),
    );
    // without the MAC: it covered the authenticated safe as it was
    const pfxOut = long(0x30, Buffer.concat([der.subarray(pfx.start, version.end), newInfo]));
    expectFixtureIdentity(readPkcs12(pfxOut, PASS));
  });

  describe("Drift", () => {
    it("rejects a truncated bundle", () => {
      const der = bundle("3des-cert-safe.p12");
      expect(() => readPkcs12(der.subarray(0, 100), PASS)).toThrow("PKCS#12: truncated encoding");
      expect(() => readPkcs12(Buffer.from([0x30]), PASS)).toThrow("PKCS#12: truncated encoding");
    });

    it("rejects an empty buffer and plain text", () => {
      expect(() => readPkcs12(Buffer.alloc(0), PASS)).toThrow("PKCS#12: truncated encoding");
      expect(() => readPkcs12(Buffer.from("not a bundle at all"), PASS)).toThrow(/PKCS#12/);
    });

    it("rejects a multi-byte tag, an indefinite primitive and an oversized length", () => {
      expect(() => readPkcs12(Buffer.from([0x1f, 0x01, 0x00]), PASS)).toThrow("multi-byte tags");
      expect(() => readPkcs12(Buffer.from([0x04, 0x80, 0x00, 0x00]), PASS)).toThrow("indefinite length on a primitive");
      expect(() => readPkcs12(Buffer.from([0x30, 0x85, 1, 1, 1, 1, 1]), PASS)).toThrow("PKCS#12: invalid length");
    });

    it("rejects a structure that is no PFX", () => {
      expect(() => readPkcs12(el(0x30, el(0x02, Buffer.from([3]))), PASS)).toThrow("PKCS#12: unexpected structure");
      // a ContentInfo whose type is an integer instead of an identifier
      expect(() =>
        readPkcs12(el(0x30, el(0x02, Buffer.from([3])), el(0x30, el(0x02, Buffer.from([1])))), PASS),
      ).toThrow("PKCS#12: expected an object identifier");
    });

    it("rejects public-key integrity (signedData)", () => {
      const signedData = el(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]));
      expect(() => readPkcs12(el(0x30, el(0x02, Buffer.from([3])), el(0x30, signedData)), PASS)).toThrow(
        "PKCS#12: only password integrity is supported",
      );
    });

    it("rejects a MAC digest it does not know", () => {
      const der = Buffer.from(bundle("3des-cert-safe.p12"));
      // the MAC's digest identifier 1.3.14.3.2.26 (SHA-1) → 1.3.14.3.2.27
      const sha1 = Buffer.from([0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a]);
      const at = der.lastIndexOf(sha1);
      expect(at).toBeGreaterThan(0);
      der[at + sha1.length - 1] = 0x1b;
      expect(() => readPkcs12(der, PASS)).toThrow("PKCS#12: unsupported MAC digest 1.3.14.3.2.27");
    });

    it("rejects an iteration count wider than any bundle uses", () => {
      const data = el(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]));
      const sha1 = el(0x06, Buffer.from([0x2b, 0x0e, 0x03, 0x02, 0x1a]));
      const pfx = el(
        0x30,
        el(0x02, Buffer.from([3])),
        el(0x30, data, el(0xa0, el(0x04, Buffer.from([0x30, 0x00])))),
        el(
          0x30,
          el(0x30, el(0x30, sha1), el(0x04, Buffer.alloc(20))),
          el(0x04, Buffer.alloc(8)),
          el(0x02, Buffer.alloc(7, 1)),
        ),
      );
      expect(() => readPkcs12(pfx, PASS)).toThrow("PKCS#12: expected a small integer");
    });
  });
});

describe("rc2CbcDecrypt", () => {
  // RFC 2268 section 5: key, effective key bits, ciphertext → plaintext (one block, zero IV = ECB)
  it.each([
    ["0000000000000000", 63, "ebb773f993278eff", "0000000000000000"],
    ["ffffffffffffffff", 64, "278b27e42e2f0d49", "ffffffffffffffff"],
    ["3000000000000000", 64, "30649edf9be7d2c2", "1000000000000001"],
    ["88", 64, "61a8a244adacccf0", "0000000000000000"],
    ["88bca90e90875a", 64, "6ccf4308974c267f", "0000000000000000"],
    ["88bca90e90875a7f0f79c384627bafb2", 64, "1a807d272bbe5db1", "0000000000000000"],
    ["88bca90e90875a7f0f79c384627bafb2", 128, "2269552ab0f85ca6", "0000000000000000"],
  ])("decrypts the RFC 2268 vector key %s / %d bits", (key, bits, cipher, plain) => {
    const out = rc2CbcDecrypt(Buffer.from(cipher, "hex"), Buffer.from(key, "hex"), Buffer.alloc(8), bits);
    expect(out.toString("hex")).toBe(plain);
  });

  it("chains the blocks (CBC): each block is XORed with the ciphertext before it", () => {
    const key = Buffer.from("88", "hex");
    const block = Buffer.from("61a8a244adacccf0", "hex");
    const out = rc2CbcDecrypt(Buffer.concat([block, block]), key, Buffer.alloc(8), 64);
    expect(out.subarray(0, 8).toString("hex")).toBe("0000000000000000");
    expect(out.subarray(8).equals(block)).toBe(true);
  });

  it("refuses data that is not a whole number of blocks, or an IV of the wrong size", () => {
    expect(() => rc2CbcDecrypt(Buffer.alloc(7), Buffer.alloc(5), Buffer.alloc(8), 40)).toThrow(
      "whole number of blocks",
    );
    expect(() => rc2CbcDecrypt(Buffer.alloc(8), Buffer.alloc(5), Buffer.alloc(7), 40)).toThrow(
      "whole number of blocks",
    );
  });
});

describe("pkcs12Kdf", () => {
  it("derives as many bytes as asked for, beyond one hash block", () => {
    const sha1 = { hash: "sha1", blockBytes: 64 };
    const password = Buffer.from([0, 0x61, 0, 0]);
    const long = pkcs12Kdf(sha1, password, Buffer.from("salt"), 3, 1, 48);
    expect(long).toHaveLength(48);
    // the first block is the same however much is asked for
    expect(pkcs12Kdf(sha1, password, Buffer.from("salt"), 3, 1, 20).equals(long.subarray(0, 20))).toBe(true);
    // the purpose (key, IV, MAC) changes the material
    expect(pkcs12Kdf(sha1, password, Buffer.from("salt"), 3, 2, 20).equals(long.subarray(0, 20))).toBe(false);
  });
});
