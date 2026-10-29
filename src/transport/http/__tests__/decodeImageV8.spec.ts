import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeImageV8, isV8Image } from "../decodeImageV8.js";

// ── Synthesis of a v8 blob, mirroring the station's forward operations ───────────────────────────
// This replicates the ECIES *encrypt* side + the AES-256-GCM image wrap so the test proves the
// decoder against a known keypair, with no captured sample or real key. The KDF below is byte-exact
// with `eufyKdf` in ../p2p/codec (HMAC-SHA256 feedback chaining under the "ECIES" label).

function eufyKdf(shared: Buffer, outLen: number): Buffer {
  const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  const label = Buffer.from("ECIES");
  let out = Buffer.alloc(0);
  let t = label;
  while (out.length < outLen) {
    t = hmac(shared, t);
    out = Buffer.concat([out, hmac(shared, Buffer.concat([t, label]))]);
  }
  return out.subarray(0, outLen);
}

function pkcs7(buf: Buffer, block = 16): Buffer {
  const pad = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** ECIES-wrap a payload (the AES-256 key) to `recipientPubUncompressed`, producing the 129-byte envelope. */
function eciesWrap(payload: Buffer, recipientPubUncompressed: Buffer): Buffer {
  const eph = createECDH("prime256v1");
  eph.generateKeys();
  const ephPubCompressed = eph.getPublicKey(undefined, "compressed"); // 33 bytes
  const shared = eph.computeSecret(recipientPubUncompressed); // 32-byte X
  const kdf = eufyKdf(shared, 48);
  const cbcKey = kdf.subarray(0, 16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", cbcKey, iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(pkcs7(payload)), cipher.final()]); // 48 bytes for a 32-byte payload
  const mac = createHmac("sha256", kdf.subarray(16, 48))
    .update(Buffer.concat([iv, ct]))
    .digest();
  return Buffer.concat([ephPubCompressed, iv, ct, mac]); // 33 + 16 + 48 + 32 = 129
}

function buildV8(jpeg: Buffer, serial: string, pinCodeId: number, pubUncompressed: Buffer): Buffer {
  const aesKey = randomBytes(32);
  const envelope = eciesWrap(aesKey, pubUncompressed);
  const nonce = randomBytes(12);
  const gcm = createCipheriv("aes-256-gcm", aesKey, nonce);
  const ct = Buffer.concat([gcm.update(jpeg), gcm.final()]);
  const tag = gcm.getAuthTag();
  const prefix = Buffer.from("v8_eufysecurity:", "latin1");
  const sn = Buffer.from(serial.padEnd(16, "0").slice(0, 16), "latin1");
  return Buffer.concat([prefix, sn, Buffer.from(":", "latin1"), Buffer.from([pinCodeId]), envelope, nonce, tag, ct]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg body".repeat(20))]);

describe("decodeImageV8", () => {
  it("round-trips a v8 blob with the matching vault private key", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const privHex = ecdh.getPrivateKey("hex");
    const pub = ecdh.getPublicKey(); // uncompressed
    const blob = buildV8(JPEG, "T8030P000000000A", 14, pub);

    expect(isV8Image(blob)).toBe(true);
    const out = decodeImageV8(blob, privHex);
    expect(out).not.toBeNull();
    expect(out!.equals(JPEG)).toBe(true);
  });

  it("returns null for the wrong vault key (GCM tag rejects it, never partial output)", () => {
    const station = createECDH("prime256v1");
    station.generateKeys();
    const blob = buildV8(JPEG, "T8030P000000000A", 14, station.getPublicKey());
    const other = createECDH("prime256v1");
    other.generateKeys();
    expect(decodeImageV8(blob, other.getPrivateKey("hex"))).toBeNull();
  });

  it("is not fooled by v1/v2 blobs or truncated input", () => {
    const anyKey = createECDH("prime256v1");
    anyKey.generateKeys();
    const hex = anyKey.getPrivateKey("hex");
    expect(isV8Image(Buffer.from("v2_eufysecurity:whatever"))).toBe(false);
    expect(decodeImageV8(Buffer.from("eufysecurity:short"), hex)).toBeNull();
    expect(decodeImageV8(Buffer.from("v8_eufysecurity:too-short"), hex)).toBeNull();
  });

  it("refuses the unsupported pinCodeId-1 (legacy RSA) envelope rather than guessing", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const blob = buildV8(JPEG, "T8030P000000000A", 1, ecdh.getPublicKey());
    expect(decodeImageV8(blob, ecdh.getPrivateKey("hex"))).toBeNull();
  });
});
