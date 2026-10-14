// The account broker's client certificate comes from Govee as a PKCS#12 bundle (`/app/v1/account/iot/key`, `p12` +
// `p12Pass`). This reads exactly the two encryptions a Govee bundle can carry — govee2mqtt reads it with the Rust crate
// p12 0.6.3, which decrypts nothing else: pbeWithSHAAnd3-KeyTripleDES-CBC and pbeWithSHAAnd40BitRC2-CBC (RFC 7292). Node's
// OpenSSL 3 has 3DES; RC2 lives in its legacy provider, which an adapter process cannot load, so RC2 is decrypted here
// (RFC 2268). Replaces node-forge, whose open advisory (GHSA-86w9-cpqp-85rv) has no corrected release.
import {
  X509Certificate,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  timingSafeEqual,
} from "node:crypto";

const OID = {
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  pbeSha1TripleDes: "1.2.840.113549.1.12.1.3",
  pbeSha1Rc2With40Bits: "1.2.840.113549.1.12.1.6",
  shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  safeContentsBag: "1.2.840.113549.1.12.10.1.6",
  x509Certificate: "1.2.840.113549.1.9.22.1",
};

/** The MAC digests a PKCS#12 bundle may name, with the block size of each (RFC 7292 appendix B.2, `v`). */
const MAC_DIGESTS: Record<string, { hash: string; blockBytes: number }> = {
  "1.3.14.3.2.26": { hash: "sha1", blockBytes: 64 },
  "2.16.840.1.101.3.4.2.1": { hash: "sha256", blockBytes: 64 },
  "2.16.840.1.101.3.4.2.2": { hash: "sha384", blockBytes: 128 },
  "2.16.840.1.101.3.4.2.3": { hash: "sha512", blockBytes: 128 },
};

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const CONSTRUCTED = 0x20;

/** One BER element: its first tag byte and either its bytes (primitive) or its children (constructed). */
interface Asn1 {
  tag: number;
  content: Buffer;
  children: Asn1[];
}

/**
 * Reads one BER element at `pos` — definite and indefinite lengths, since bundles written by Java keystores use both.
 *
 * @param buf The encoding
 * @param pos Where the element starts
 */
function readElement(buf: Buffer, pos: number): { node: Asn1; end: number } {
  if (pos + 2 > buf.length) {
    throw new Error("PKCS#12: truncated encoding");
  }
  const tag = buf[pos];
  if ((tag & 0x1f) === 0x1f) {
    throw new Error("PKCS#12: multi-byte tags are not used by PKCS#12");
  }
  const constructed = (tag & CONSTRUCTED) !== 0;
  const lengthByte = buf[pos + 1];
  let at = pos + 2;
  if (lengthByte === 0x80) {
    if (!constructed) {
      throw new Error("PKCS#12: indefinite length on a primitive element");
    }
    const children: Asn1[] = [];
    while (!(buf[at] === 0 && buf[at + 1] === 0)) {
      const child = readElement(buf, at);
      children.push(child.node);
      at = child.end;
    }
    return { node: { tag, content: Buffer.alloc(0), children }, end: at + 2 };
  }
  let length = lengthByte;
  if (lengthByte > 0x80) {
    const count = lengthByte & 0x7f;
    if (count > 4 || at + count > buf.length) {
      throw new Error("PKCS#12: invalid length");
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + buf[at + i];
    }
    at += count;
  }
  const end = at + length;
  if (end > buf.length) {
    throw new Error("PKCS#12: truncated encoding");
  }
  const content = buf.subarray(at, end);
  const children: Asn1[] = [];
  if (constructed) {
    for (let p = 0; p < content.length;) {
      const child = readElement(content, p);
      children.push(child.node);
      p = child.end;
    }
  }
  return { node: { tag, content, children }, end };
}

/**
 * The single element a buffer holds.
 *
 * @param buf The encoding
 */
function parse(buf: Buffer): Asn1 {
  return readElement(buf, 0).node;
}

/**
 * The child at `index`, required to carry `tag` when one is given.
 *
 * @param node The parent
 * @param index Which child
 * @param tag The tag it must carry
 */
function child(node: Asn1, index: number, tag?: number): Asn1 {
  const found = node.children[index];
  if (!found || (tag !== undefined && found.tag !== tag)) {
    throw new Error("PKCS#12: unexpected structure");
  }
  return found;
}

/**
 * The bytes of an OCTET STRING, also when BER splits it into constructed chunks (and of an implicitly tagged one).
 *
 * @param node The element
 */
function octets(node: Asn1): Buffer {
  return node.tag & CONSTRUCTED ? Buffer.concat(node.children.map(octets)) : node.content;
}

/**
 * The dotted form of an OBJECT IDENTIFIER.
 *
 * @param node The element
 */
function oid(node: Asn1): string {
  if (node.tag !== TAG_OID || node.content.length === 0) {
    throw new Error("PKCS#12: expected an object identifier");
  }
  const bytes = node.content;
  const parts: number[] = [];
  let value = 0;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  const first = parts.shift() ?? 0;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

/**
 * A small non-negative INTEGER (iteration counts, versions).
 *
 * @param node The element
 */
function integer(node: Asn1): number {
  if (node.tag !== TAG_INTEGER || node.content.length === 0 || node.content.length > 6) {
    throw new Error("PKCS#12: expected a small integer");
  }
  return node.content.reduce((n, b) => n * 256 + b, 0);
}

/**
 * The password as PKCS#12 hashes it: BMPString (UTF-16 big-endian) with its two-byte terminator.
 *
 * @param password The bundle's password
 */
function bmpPassword(password: string): Buffer {
  const out = Buffer.alloc((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    out.writeUInt16BE(password.charCodeAt(i), i * 2);
  }
  return out;
}

/**
 * RFC 7292 appendix B.2: key material from password and salt — `id` 1 a key, 2 an IV, 3 a MAC key.
 *
 * @param digest The hash and its block size
 * @param digest.hash The hash name
 * @param digest.blockBytes Its block size in bytes
 * @param password The password as bmpPassword returns it
 * @param salt The salt
 * @param iterations The iteration count
 * @param id What the material is for
 * @param bytes How many bytes
 */
export function pkcs12Kdf(
  digest: { hash: string; blockBytes: number },
  password: Buffer,
  salt: Buffer,
  iterations: number,
  id: number,
  bytes: number,
): Buffer {
  const v = digest.blockBytes;
  const stretch = (b: Buffer): Buffer => {
    const out = Buffer.alloc(v * Math.ceil(b.length / v));
    for (let i = 0; i < out.length; i++) {
      out[i] = b[i % b.length];
    }
    return out;
  };
  const diversifier = Buffer.alloc(v, id);
  const input = Buffer.concat([stretch(salt), stretch(password)]);
  const blocks: Buffer[] = [];
  for (let have = 0; ;) {
    let a = createHash(digest.hash).update(diversifier).update(input).digest();
    for (let r = 1; r < iterations; r++) {
      a = createHash(digest.hash).update(a).digest();
    }
    blocks.push(a);
    have += a.length;
    if (have >= bytes) {
      return Buffer.concat(blocks).subarray(0, bytes);
    }
    const b = stretch(a);
    for (let j = 0; j < input.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = input[j + k] + b[k] + carry;
        input[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
}

/** RFC 2268 PITABLE (the digits of pi, permuted). */
const PI_TABLE = [
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d, 0xc6, 0x7e, 0x37,
  0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2, 0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3,
  0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32, 0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0,
  0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82, 0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14,
  0xa7, 0x8c, 0xf1, 0xdc, 0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6,
  0x26, 0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03, 0xf8, 0x11,
  0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7, 0x08, 0xe8, 0xea, 0xde, 0x80,
  0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a, 0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74,
  0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec, 0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf,
  0x50, 0xa1, 0xf4, 0x70, 0x39, 0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55,
  0x97, 0x31, 0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9, 0xd3,
  0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9, 0x0d, 0x38, 0x34, 0x1b,
  0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e, 0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c,
  0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
];

/**
 * RFC 2268 key expansion: the 64 round words for a key and its effective key bits.
 *
 * @param key The key (1–128 bytes)
 * @param effectiveBits The effective key length in bits
 */
function rc2Expand(key: Buffer, effectiveBits: number): Uint16Array {
  const t = key.length;
  const l = new Uint8Array(128);
  l.set(key);
  for (let i = t; i < 128; i++) {
    l[i] = PI_TABLE[(l[i - 1] + l[i - t]) & 0xff];
  }
  const t8 = Math.ceil(effectiveBits / 8);
  const tm = 0xff % 2 ** (8 + effectiveBits - 8 * t8);
  l[128 - t8] = PI_TABLE[l[128 - t8] & tm];
  for (let i = 127 - t8; i >= 0; i--) {
    l[i] = PI_TABLE[l[i + 1] ^ l[i + t8]];
  }
  const k = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = l[2 * i] | (l[2 * i + 1] << 8);
  }
  return k;
}

const RC2_SHIFTS = [1, 2, 3, 5];

/**
 * RFC 2268 decryption of one 8-byte block in place.
 *
 * @param k The round words
 * @param block The block (changed in place)
 */
function rc2DecryptBlock(k: Uint16Array, block: Buffer): void {
  const r = [block.readUInt16LE(0), block.readUInt16LE(2), block.readUInt16LE(4), block.readUInt16LE(6)];
  let j = 63;
  const mixing = (): void => {
    for (let i = 3; i >= 0; i--) {
      const s = RC2_SHIFTS[i];
      r[i] = ((r[i] >>> s) | (r[i] << (16 - s))) & 0xffff;
      r[i] = (r[i] - k[j] - (r[(i + 3) % 4] & r[(i + 2) % 4]) - (~r[(i + 3) % 4] & r[(i + 1) % 4])) & 0xffff;
      j--;
    }
  };
  const mashing = (): void => {
    for (let i = 3; i >= 0; i--) {
      r[i] = (r[i] - k[r[(i + 3) % 4] & 63]) & 0xffff;
    }
  };
  for (const [rounds, mash] of [
    [5, true],
    [6, true],
    [5, false],
  ] as const) {
    for (let n = 0; n < rounds; n++) {
      mixing();
    }
    if (mash) {
      mashing();
    }
  }
  r.forEach((w, i) => block.writeUInt16LE(w, i * 2));
}

/**
 * RC2 in CBC mode, decryption only, without removing the padding.
 *
 * @param data The ciphertext (a multiple of 8 bytes)
 * @param key The key
 * @param iv The 8-byte IV
 * @param effectiveBits The effective key length in bits
 */
export function rc2CbcDecrypt(data: Buffer, key: Buffer, iv: Buffer, effectiveBits: number): Buffer {
  if (data.length % 8 !== 0 || iv.length !== 8) {
    throw new Error("PKCS#12: RC2 data is not a whole number of blocks");
  }
  const k = rc2Expand(key, effectiveBits);
  const out = Buffer.alloc(data.length);
  let previous = iv;
  for (let at = 0; at < data.length; at += 8) {
    const cipher = data.subarray(at, at + 8);
    const block = Buffer.from(cipher);
    rc2DecryptBlock(k, block);
    for (let i = 0; i < 8; i++) {
      out[at + i] = block[i] ^ previous[i];
    }
    previous = cipher;
  }
  return out;
}

/**
 * Removes PKCS#7 padding; a wrong one means a wrong password or broken data.
 *
 * @param data The decrypted bytes
 */
function unpad(data: Buffer): Buffer {
  const n = data[data.length - 1];
  if (!n || n > 8 || n > data.length || data.subarray(data.length - n).some(b => b !== n)) {
    throw new Error("PKCS#12: decryption failed (wrong password?)");
  }
  return data.subarray(0, data.length - n);
}

/**
 * Decrypts PKCS#12 password-based encrypted bytes with one of the two algorithms a Govee bundle carries.
 *
 * @param algorithm The AlgorithmIdentifier
 * @param data The ciphertext
 * @param password The password as bmpPassword returns it
 */
function decrypt(algorithm: Asn1, data: Buffer, password: Buffer): Buffer {
  const name = oid(child(algorithm, 0));
  if (name !== OID.pbeSha1TripleDes && name !== OID.pbeSha1Rc2With40Bits) {
    throw new Error(`PKCS#12: unsupported encryption ${name}`);
  }
  const params = child(algorithm, 1, TAG_SEQUENCE);
  const salt = octets(child(params, 0, TAG_OCTET_STRING));
  const iterations = integer(child(params, 1));
  const sha1 = MAC_DIGESTS["1.3.14.3.2.26"];
  if (name === OID.pbeSha1TripleDes) {
    const key = pkcs12Kdf(sha1, password, salt, iterations, 1, 24);
    const iv = pkcs12Kdf(sha1, password, salt, iterations, 2, 8);
    const decipher = createDecipheriv("des-ede3-cbc", key, iv);
    decipher.setAutoPadding(false);
    return unpad(Buffer.concat([decipher.update(data), decipher.final()]));
  }
  const key = pkcs12Kdf(sha1, password, salt, iterations, 1, 5);
  const iv = pkcs12Kdf(sha1, password, salt, iterations, 2, 8);
  return unpad(rc2CbcDecrypt(data, key, iv, 40));
}

/**
 * Checks the bundle's MAC over the authenticated safe — a wrong password fails here in its own words.
 *
 * @param macData The MacData element
 * @param authSafe The bytes the MAC covers
 * @param password The password as bmpPassword returns it
 */
function verifyMac(macData: Asn1, authSafe: Buffer, password: Buffer): void {
  const digestInfo = child(macData, 0, TAG_SEQUENCE);
  const digestOid = oid(child(child(digestInfo, 0, TAG_SEQUENCE), 0));
  const digest = MAC_DIGESTS[digestOid];
  if (!digest) {
    throw new Error(`PKCS#12: unsupported MAC digest ${digestOid}`);
  }
  const expected = octets(child(digestInfo, 1, TAG_OCTET_STRING));
  const salt = octets(child(macData, 1, TAG_OCTET_STRING));
  const iterations = macData.children[2] ? integer(macData.children[2]) : 1;
  const macKey = pkcs12Kdf(digest, password, salt, iterations, 3, createHash(digest.hash).digest().length);
  const actual = createHmac(digest.hash, macKey).update(authSafe).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("PKCS#12: MAC could not be verified (wrong password?)");
  }
}

/**
 * Collects the bags of one SafeContents, nested SafeContents bags included, in their order.
 *
 * @param safeContents The SafeContents element
 * @param into Where the bags go
 */
function collectBags(safeContents: Asn1, into: { id: string; value: Asn1 }[]): void {
  for (const bag of safeContents.children) {
    const id = oid(child(bag, 0));
    const value = child(child(bag, 1), 0);
    if (id === OID.safeContentsBag) {
      collectBags(value, into);
    } else {
      into.push({ id, value });
    }
  }
}

/**
 * Reads the client key and certificate from a PKCS#12 bundle: the first shrouded key bag and the first certificate bag,
 * as PEM. Throws on a wrong password, an encryption other than Govee's two, or a bundle without either.
 *
 * @param der The bundle
 * @param password Its password
 */
export function readPkcs12(der: Buffer, password: string): { key: string; cert: string } {
  const pass = bmpPassword(password);
  const pfx = parse(der);
  const authSafeInfo = child(pfx, 1, TAG_SEQUENCE);
  if (oid(child(authSafeInfo, 0)) !== OID.data) {
    throw new Error("PKCS#12: only password integrity is supported");
  }
  const authSafe = octets(child(child(authSafeInfo, 1), 0));
  if (pfx.children[2]) {
    verifyMac(pfx.children[2], authSafe, pass);
  }
  const bags: { id: string; value: Asn1 }[] = [];
  for (const info of parse(authSafe).children) {
    const type = oid(child(info, 0));
    const content = child(child(info, 1), 0);
    if (type === OID.data) {
      collectBags(parse(octets(content)), bags);
    } else if (type === OID.encryptedData) {
      const encrypted = child(content, 1, TAG_SEQUENCE);
      collectBags(parse(decrypt(child(encrypted, 1, TAG_SEQUENCE), octets(child(encrypted, 2)), pass)), bags);
    }
  }
  const keyBag = bags.find(b => b.id === OID.shroudedKeyBag);
  if (!keyBag) {
    throw new Error("No private key found in P12");
  }
  const pkcs8 = decrypt(child(keyBag.value, 0, TAG_SEQUENCE), octets(child(keyBag.value, 1, TAG_OCTET_STRING)), pass);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const key = privateKey.export({ type: privateKey.asymmetricKeyType === "rsa" ? "pkcs1" : "pkcs8", format: "pem" });
  const certBag = bags.find(b => b.id === OID.certBag && oid(child(b.value, 0)) === OID.x509Certificate);
  if (!certBag) {
    throw new Error("No certificate found in P12");
  }
  const cert = new X509Certificate(octets(child(child(certBag.value, 1), 0))).toString();
  return { key: String(key), cert };
}
