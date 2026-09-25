import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { expect } from "vitest";

/**
 * Station-side ECIES and GCM sealing for specs: a synthetic camera P-256 keypair stands in for the
 * cipher's ECC key, so frames are built exactly as the station builds them without any account material.
 */
export const AAD = Buffer.from("eufy security");
const LABEL = Buffer.from("ECIES");

/** The eufy ECIES KDF (HMAC-SHA256 feedback under "ECIES"), mirrored from the station side. */
export function eufyKdf(shared: Buffer, outLen: number): Buffer {
  const hmac = (k: Buffer, d: Buffer): Buffer => createHmac("sha256", k).update(d).digest();
  let out: Buffer = Buffer.alloc(0);
  let t: Buffer = LABEL;
  while (out.length < outLen) {
    t = hmac(shared, t);
    out = Buffer.concat([out, hmac(shared, Buffer.concat([t, LABEL]))]);
  }
  return out.subarray(0, outLen);
}

/** PKCS7-pad to the AES block size (16). */
export function pkcs7(data: Buffer): Buffer {
  const pad = 16 - (data.length % 16 || 0) || 16;
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

/** Build the 129-byte ECIES envelope wrapping `mediaKey` for the given camera public key. */
export function wrapEnvelope(mediaKey: Buffer, cameraPubUncompressed: Buffer): Buffer {
  const eph = createECDH("prime256v1");
  eph.generateKeys();
  const ephPub = eph.getPublicKey(undefined, "compressed"); // 33B
  const shared = eph.computeSecret(cameraPubUncompressed); // ECDH_X
  const kdf = eufyKdf(shared, 48);
  const aesKey = kdf.subarray(0, 16);
  const macKey = kdf.subarray(16, 48);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-cbc", aesKey, iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7(mediaKey)), c.final()]); // 32B -> 48B with PKCS7
  const mac = createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ct]))
    .digest();
  const env = Buffer.concat([ephPub, iv, ct, mac]);
  expect(env.length).toBe(129);
  return env;
}

/** GCM-seal `h264` under `mediaKey`; returns { nonce, tag, ct }. */
export function sealBody(mediaKey: Buffer, h264: Buffer): { nonce: Buffer; tag: Buffer; ct: Buffer } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", mediaKey, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(h264), c.final()]);
  return { nonce, tag: c.getAuthTag(), ct };
}
