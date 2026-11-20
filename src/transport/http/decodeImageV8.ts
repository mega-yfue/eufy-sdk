/**
 * V8 `v8_eufysecurity:` push-thumbnail / stored-cover decoder.
 *
 * Unlike v1 (header-only AES-ECB) and v2 (header-only AES-GCM), a v8 blob is encrypted **in full**
 * to the account's **advanced-encryption ("vault") key**: the station wraps a random AES-256 key to
 * the account's P-256 vault public key and GCM-encrypts the whole JPEG under it. Only a holder of the
 * matching vault **private key** can read it — so this decoder needs that key supplied by the caller;
 * there is no keyless path as there is for v1/v2.
 *
 * Wire format (offsets are byte indexes into the blob):
 * ```
 *  0..16   "v8_eufysecurity:"            (16-byte ASCII prefix)
 * 16..32   <SERIAL>                      (16-byte station serial)
 *     32   ':'                           (separator)
 *     33   pinCodeId                     (1 byte; which vault key wrapped the AES key)
 * 34..163  key envelope                  (129 bytes when pinCodeId != 1; the ECIES-wrapped AES-256 key)
 *163..175  GCM nonce                     (12 bytes)
 *175..191  GCM tag                       (16 bytes)
 *191..end  GCM ciphertext               (the encrypted JPEG)
 * ```
 * The 129-byte envelope is the same ECIES shape the P2P video path already uses
 * (`ephemeralPub(33) ‖ iv(16) ‖ ct(48) ‖ HMAC(32)`), so {@link eciesUnwrap} recovers the AES-256
 * key from it; its first 32 plaintext bytes are the key. Reversed from `SecureDecoder.f` /
 * `E2EEUtils` in the v6.1 app.
 */
import { createDecipheriv } from "node:crypto";
import { eciesUnwrap } from "../p2p/codec.js";

/** The `v8_eufysecurity:` wrapper prefix (including the trailing colon) that tags a v8 blob. */
const V8_PREFIX = "v8_eufysecurity:";

const PREFIX_LEN = V8_PREFIX.length; // 16
const PIN_OFFSET = 33;
const ENVELOPE_OFFSET = 34;
const ENVELOPE_LEN = 129;
const NONCE_OFFSET = 163;
const TAG_OFFSET = 175;
const CT_OFFSET = 191;
const AES_KEY_LEN = 32;

/** True if the blob is a v8 `v8_eufysecurity:` encrypted image. */
export function isV8Image(data: Buffer): boolean {
  return data.length >= CT_OFFSET && data.subarray(0, PREFIX_LEN).toString("latin1") === V8_PREFIX;
}

/**
 * Decode a v8 `v8_eufysecurity:` image using the account's vault **private key** (hex, 32-byte P-256
 * scalar). Returns the decrypted JPEG, or `null` if the blob is not v8, is truncated, uses the
 * unsupported pinCodeId-1 (legacy RSA) envelope, or the key does not unwrap it (wrong vault key,
 * tampered blob). Fails closed — never throws.
 *
 * `eccPrivateKeyHex` must be the private key for the `pinCodeId` the blob names; a blob's pinCodeId is
 * at byte 33. A caller holding several vault keys selects by that byte.
 */
export function decodeImageV8(data: Buffer, eccPrivateKeyHex: string): Buffer | null {
  if (!isV8Image(data)) return null;
  // pinCodeId 1 wraps the key to a legacy cloud RSA key (128-byte blob), not the ECIES envelope this
  // decoder (and the vault private key) handle. No sample of it has been seen; refuse rather than guess.
  if (data[PIN_OFFSET] === 1) return null;
  try {
    const envelope = data.subarray(ENVELOPE_OFFSET, ENVELOPE_OFFSET + ENVELOPE_LEN);
    const nonce = data.subarray(NONCE_OFFSET, TAG_OFFSET);
    const tag = data.subarray(TAG_OFFSET, CT_OFFSET);
    const ct = data.subarray(CT_OFFSET);
    if (envelope.length < ENVELOPE_LEN || tag.length < 16 || ct.length === 0) return null;

    const unwrapped = eciesUnwrap(envelope, eccPrivateKeyHex, { verifyHmac: true, pkcs7: true });
    if (!unwrapped || unwrapped.length < AES_KEY_LEN) return null;
    const aesKey = unwrapped.subarray(0, AES_KEY_LEN);

    const dec = createDecipheriv("aes-256-gcm", aesKey, nonce);
    dec.setAuthTag(tag);
    const out = Buffer.concat([dec.update(ct), dec.final()]);
    // A correct key + intact blob yields a JPEG (FF D8). Anything else means the wrong key slipped
    // past the GCM tag check (it cannot) or the payload is not an image — reject either way.
    return out.length >= 2 && out[0] === 0xff && out[1] === 0xd8 ? out : null;
  } catch {
    return null; // wrong key (GCM tag mismatch), truncation, or a malformed envelope
  }
}
