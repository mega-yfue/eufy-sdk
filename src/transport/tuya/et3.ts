/**
 * Tuya `et=3` reply body crypto.
 *
 * An `et=3` `api.json` request is plaintext form params plus a `sign` (see {@link buildSignPreimage}) —
 * there is NO encrypted request blob. The server encrypts only the **response**: the envelope's
 * `result` arrives as a base64 AES-128-GCM blob instead of a JSON object. This module derives the
 * per-reply key and opens that blob; {@link TuyaClient} applies it transparently so callers keep
 * reading `envelope.result` as an object.
 *
 * Blob layout (`layout-std`): `nonce(12) ‖ ciphertext ‖ tag(16)`, no AAD, 12-byte GCM nonce,
 * 16-byte tag. The plaintext is gzip-compressed when it carries the gzip magic (`1f 8b`).
 *
 * Reversed from `libthing_security.so` (`getEncryptoKey`) and `Business.verifyResponseResult`,
 * verified by GCM tag authentication and the md5 reply-sign against captured frames.
 */
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolveSignKey } from "./sign.js";

/**
 * The per-reply AES-128 key, `getEncryptoKey(requestId, ecode)`: take the lowercase hex of
 * `HMAC-SHA256(key = requestId, msg = K[+ "_" + ecode])`, keep the first 16 hex characters, and use
 * those characters as 16 ASCII bytes. `K` is the app HMAC key ({@link resolveSignKey}).
 *
 * `ecode` is the session's per-login encryption code (`User.ecode`, read from the decrypted
 * `login.reg` reply). `ecode === null` selects the pre-session variant `msg = K` used to open the
 * `token.get` and `login.reg` replies themselves, before any `ecode` is known.
 */
export function deriveBodyKey(requestId: string, ecode: string | null): Buffer {
  const k = resolveSignKey();
  const msg = ecode === null ? k : `${k}_${ecode}`;
  const hex = createHmac("sha256", requestId).update(msg, "utf-8").digest("hex");
  return Buffer.from(hex.slice(0, 16), "ascii");
}

/**
 * Decrypt an `et=3` reply `result`: base64 → AES-128-GCM-decrypt-verify (`nonce = blob[0:12]`,
 * `tag = blob[-16:]`, ciphertext between), gunzip when the plaintext is gzip-framed, and return the
 * plaintext JSON string. Throws when the blob is too short or the GCM tag fails to authenticate.
 */
export function decryptReply(key: Buffer, resultB64: string): string {
  const blob = Buffer.from(resultB64, "base64");
  if (blob.length < 12 + 16) {
    throw new Error("tuya et=3 reply too short to hold a 12-byte nonce + 16-byte tag");
  }
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const text = plain.length >= 2 && plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain;
  return text.toString("utf-8");
}

/**
 * Verify the reply integrity sign: `sign == md5hex("result=" + resultB64 + "||t=" + t + "||" + keyStr)`,
 * where `keyStr` is the 16 ASCII key bytes read as a latin1 string (the key's own characters). A
 * mismatch means a wrong body key or a tampered reply. The comparison is case-insensitive over the
 * 32-hex sign.
 */
export function verifyReplySign(key: Buffer, resultB64: string, t: string, sign: string): boolean {
  const preimage = `result=${resultB64}||t=${t}||${key.toString("latin1")}`;
  const computed = createHash("md5").update(preimage, "utf-8").digest("hex");
  return computed.toLowerCase() === sign.toLowerCase();
}
