/**
 * eufy P2P low-level primitives — deterministic, unit-tested. The realtime UDP
 * session that drives them lives in p2p-session.ts.
 *
 * The ThroughTek PPCS on-wire protocol, implemented from live packet captures + the disassembled
 * V6 app; credentials come from the mega API. Verified byte-exact against captured frames (see the
 * p2p specs — GCM-tag authentication on real level-2 frames).
 *
 * Every UDP packet is `[msgType:2][payloadLen:2 BE][payload]`. Every P2P data
 * frame inside a DATA packet starts with the ASCII magic "XZYH".
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface Address {
  host: string;
  port: number;
}

/** Magic word at the start of every P2P data frame. */
export const MAGIC_WORD = "XZYH";

/** UDP message types (1st byte always 0xf1). */
export const RequestMessageType = {
  LOCAL_LOOKUP: Buffer.from([0xf1, 0x30]),
  LOOKUP_WITH_KEY: Buffer.from([0xf1, 0x26]),
  /** `ListReq_DSK`: the same body as a variant-2 lookup, answered with {@link ResponseMessageType.LIST_REQ_ACK}. */
  LOOKUP_WITH_KEY2: Buffer.from([0xf1, 0x6a]),
  RLY_HELLO: Buffer.from([0xf1, 0x70]),
  RLY_PORT: Buffer.from([0xf1, 0x72]),
  RLY_REQ: Buffer.from([0xf1, 0x80]),
  RLY_PKT: Buffer.from([0xf1, 0x83]),
  CHECK_CAM: Buffer.from([0xf1, 0x41]),
  CHECK_CAM2: Buffer.from([0xf1, 0x42]),
  PING: Buffer.from([0xf1, 0xe0]),
  PONG: Buffer.from([0xf1, 0xe1]),
  DATA: Buffer.from([0xf1, 0xd0]),
  ACK: Buffer.from([0xf1, 0xd1]),
  END: Buffer.from([0xf1, 0xf0]),
} as const;

export const ResponseMessageType = {
  LOCAL_LOOKUP_RESP: Buffer.from([0xf1, 0x41]),
  LOOKUP_ADDR: Buffer.from([0xf1, 0x40]),
  /** The relay servers a cloud lookup server names: `[count:1][pad:3]` then `count` address records. */
  LIST_REQ_ACK: Buffer.from([0xf1, 0x69]),
  RLY_HELLO_ACK: Buffer.from([0xf1, 0x71]),
  /** A relay's answer to RLY_PORT: `[mark:4 BE][port:2 BE][pad:2]`, the port being the one it relays on. */
  RLY_PORT_ACK: Buffer.from([0xf1, 0x73]),
  RLY_REQ_ACK: Buffer.from([0xf1, 0x81]),
  /** A relay endpoint to register with: one address record, then `[handle:4 BE]`. */
  RLY_TO: Buffer.from([0xf1, 0x82]),
  CAM_ID: Buffer.from([0xf1, 0x42]),
  /** A lookup server's answer to a P2P request: `[result:1]` first, 0 when the request is accepted. */
  P2P_REQ_ACK: Buffer.from([0xf1, 0x21]),
  /**
   * The device's own address record, sent in answer to CHECK_CAM ahead of CAM_ID: its 20-byte device id, one
   * record in `encodeAddress`'s shape naming the address it answers from, then 8 zero bytes (44-byte payload).
   */
  CAM_ADDR: Buffer.from([0xf1, 0x43]),
  /** A relay reporting the path to the device ready: the device's 20-byte id, sent from the relay endpoint. */
  RLY_RDY: Buffer.from([0xf1, 0x84]),
  PING: Buffer.from([0xf1, 0xe0]),
  PONG: Buffer.from([0xf1, 0xe1]),
  DATA: Buffer.from([0xf1, 0xd0]),
  ACK: Buffer.from([0xf1, 0xd1]),
  END: Buffer.from([0xf1, 0xf0]),
} as const;

/** P2P data-channel types (2nd byte of the data-type header). */
export const P2PDataType = { DATA: 0, VIDEO: 1, CONTROL: 2, BINARY: 3 } as const;
export const P2PDataTypeHeader = {
  DATA: Buffer.from([0xd1, 0x00]),
  VIDEO: Buffer.from([0xd1, 0x01]),
  CONTROL: Buffer.from([0xd1, 0x02]),
  BINARY: Buffer.from([0xd1, 0x03]),
} as const;

/** The fixed-width 16-byte header of every P2P data frame (after "XZYH"). */
export const P2P_DATA_HEADER_BYTES = 16;

export interface P2PDataFrameHeader {
  commandId: number;
  bytesToRead: number;
  /** Byte 10: 8 when the station speaks level 2 over ECC, which decides the 1100 unwrap; 1 otherwise. */
  version: number;
  channel: number;
  signCode: number;
  type: number;
}

/** Frame a UDP packet: `[msgType:2][payloadLen:2 BE][payload]`. */
export function frameMessage(msgType: Buffer, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(payload.length, 0);
  return Buffer.concat([msgType, len, payload]);
}

/** True if `msg` begins with the given 2-byte message type. */
export function hasHeader(msg: Buffer, type: Buffer): boolean {
  return msg.length >= 2 && msg[0] === type[0] && msg[1] === type[1];
}

/** Pad a string into a fixed-width (multiple-of-chunk) zero-filled buffer. */
export function stringWithLength(input: string, chunkLength = 128): Buffer {
  const b = Buffer.from(input);
  const size = b.byteLength < chunkLength ? chunkLength : Math.ceil(b.byteLength / chunkLength) * chunkLength;
  const out = Buffer.alloc(size);
  b.copy(out);
  return out;
}

/** `EUPRCAM-000000-XXXXX` → the 20-byte buffer used in lookup/check payloads. */
export function p2pDidToBuffer(p2pDid: string): Buffer {
  const a = p2pDid.split("-");
  const b1 = stringWithLength(a[0], 8); // 8-byte prefix
  const b2 = Buffer.allocUnsafe(4);
  b2.writeUInt32BE(Number.parseInt(a[1], 10), 0); // 4-byte BE number
  const b3 = stringWithLength(a[2], 8); // 8-byte suffix
  return Buffer.concat([b1, b2, b3], 20);
}

/**
 * The cloud lookup servers of a station's record, read as the app reads them: `app_conn` is the init string
 * it hands the P2P connect, `p2p_conn` only a fallback. An empty field counts as absent.
 */
export function stationCloudAddresses(
  raw: { app_conn?: string; p2p_conn?: string } | undefined,
): Address[] | undefined {
  const conn = raw?.app_conn || raw?.p2p_conn;
  return conn ? decodeP2PCloudIPs(conn) : undefined;
}

/**
 * Decode a station's `p2p_conn` / `app_conn` string into the eufy cloud lookup
 * server addresses (port 32100). XOR cipher with a fixed lookup table, seed 0x39.
 */
export function decodeP2PCloudIPs(data: string): Address[] {
  const lookupTable = Buffer.from(
    "4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df",
    "hex",
  );
  const [encoded] = data.split(":");
  const output = Buffer.alloc(encoded.length / 2);
  for (let i = 0; i <= data.length / 2; i++) {
    let z = 0x39;
    for (let j = 0; j < i; j++) z = z ^ output[j];
    const x = data.charCodeAt(i * 2 + 1) - 65; // 'A'
    const y = (data.charCodeAt(i * 2) - 65) * 0x10;
    output[i] = z ^ lookupTable[i % lookupTable.length] ^ (x + y);
  }
  const result: Address[] = [];
  for (const ip of output.toString("utf8").split(",")) if (ip) result.push({ host: ip, port: 32100 });
  return result;
}

/**
 * The level-1 AES-128-ECB key, as the app builds it from the session's DID string: its first 16 characters, the
 * station serial's last 7 written over the first 7.
 */
export function p2pCommandEncryptionKey(stationSn: string, p2pDid: string): string {
  return `${stationSn.slice(-7)}${p2pDid.slice(7, 16)}`;
}

/**
 * AES-128-ECB decrypt of a P2P payload as the app's `aes_decrypt` runs it over its zero-filled receive buffer: every
 * block up to `ceil(length / 16)`, a final partial block completed with zeros, the result cut back to `length`.
 */
export function decryptP2PData(data: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(paddingP2PData(data)), d.final()]).subarray(0, data.length);
}

/** The int32 result a `CMD_GATEWAYINFO` reply opens with when the device refuses level-2. */
const GATEWAY_LEVEL2_REFUSED = -103;

/**
 * Whether a `CMD_GATEWAYINFO` (1100) reply is a level-2 refusal: int32 LE `GATEWAY_LEVEL2_REFUSED` (`99 ff
 * ff ff`) in place of a cipher. Any other opening is not a refusal.
 */
export function gatewayInfoRefused(gwPayload: Buffer): boolean {
  return gwPayload.length >= 4 && gwPayload.readInt32LE(0) === GATEWAY_LEVEL2_REFUSED;
}

/**
 * The eufy ECIES KDF: HMAC-SHA256 feedback chaining under the label "ECIES". Each emitted
 * 32-byte block is `HMAC(shared, t ‖ "ECIES")` where `t` starts at the label and is updated to
 * `HMAC(shared, t)` before every block. Reversed byte-exact from `kdf_func` in `libmega_media_sdk.so`.
 */
function eufyKdf(shared: Buffer, outLen: number): Buffer {
  const hmac = (k: Buffer, d: Buffer): Buffer => createHmac("sha256", k).update(d).digest();
  const label = Buffer.from("ECIES");
  let out: Buffer = Buffer.alloc(0);
  let t: Buffer = label;
  while (out.length < outLen) {
    t = hmac(shared, t);
    out = Buffer.concat([out, hmac(shared, Buffer.concat([t, label]))]);
  }
  return out.subarray(0, outLen);
}

/** Options for {@link eciesUnwrap}. */
export interface EciesUnwrapOptions {
  /**
   * When true, the envelope carries a trailing 32-byte HMAC tag over `iv ‖ ct` (the video
   * `CMD_VIDEO_FRAME` envelope, which is `ephPub(33) ‖ iv(16) ‖ ct(48) ‖ HMAC(32)`). The tag is
   * verified with `kdf[16:48]` as the MAC key and a mismatch yields `undefined`. When false (the
   * `CMD_GATEWAYINFO` envelope, `ephPub(33) ‖ iv(16) ‖ ct(48)`) there is no HMAC step.
   */
  verifyHmac?: boolean;
  /** Whether the AES-128-CBC plaintext is PKCS7-padded (video: true). Default false (zero-/no-pad). */
  pkcs7?: boolean;
}

/**
 * The shared ECIES unwrap primitive used by both the gateway and the video paths.
 *
 * `envelope` = `ephemeralPub(33, compressed P-256) ‖ iv(16) ‖ ct(48) [‖ HMAC(32)]`. Derivation:
 * `S = ECDH_X(eccPriv, ephPub)` → `kdf = eufyKDF(S)` → `aesKey = kdf[0:16]`; (optionally verify
 * `HMAC(kdf[16:48], iv‖ct) == tag`) → `AES-128-CBC(aesKey, iv, ct)` → plaintext. Returns the
 * decrypted bytes, or `undefined` on any parse / HMAC / cipher failure (fails closed, never throws).
 */
export function eciesUnwrap(
  envelope: Buffer,
  eccPrivateKeyHex: string,
  options: EciesUnwrapOptions = {},
): Buffer | undefined {
  try {
    const needsMac = options.verifyHmac === true;
    const minLen = 33 + 16 + 48 + (needsMac ? 32 : 0);
    if (envelope.length < minLen) return undefined;
    const ephemeralPub = envelope.subarray(0, 33);
    const iv = envelope.subarray(33, 49);
    const ct = envelope.subarray(49, 49 + 48);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(eccPrivateKeyHex, "hex"));
    const shared = ecdh.computeSecret(ephemeralPub); // 32-byte X coordinate
    const kdf = eufyKdf(shared, 48);
    if (needsMac) {
      const macKey = kdf.subarray(16, 48);
      const tag = envelope.subarray(97, 97 + 32);
      const computed = createHmac("sha256", macKey)
        .update(envelope.subarray(33, 97)) // iv ‖ ct
        .digest();
      if (!timingSafeEqual(computed, tag)) return undefined;
    }
    const aesKey = kdf.subarray(0, 16);
    const dec = createDecipheriv("aes-128-cbc", aesKey, iv);
    dec.setAutoPadding(false);
    let full: Buffer = Buffer.concat([dec.update(ct), dec.final()]);
    if (options.pkcs7) {
      const pad = full[full.length - 1];
      if (pad >= 1 && pad <= 16 && full.subarray(full.length - pad).every((b) => b === pad)) {
        full = full.subarray(0, full.length - pad);
      }
    }
    return Buffer.from(full);
  } catch {
    return undefined;
  }
}

/** The two random inputs of {@link eciesWrap}, injectable so a spec can pin an envelope's bytes. */
export interface EciesWrapOptions {
  /** The ephemeral P-256 private key for the exchange (32 bytes); generated fresh when absent. */
  ephemeralPrivateKey?: Buffer;
  /** The AES-128-CBC IV, which the envelope carries (16 bytes); random when absent. */
  iv?: Buffer;
}

/**
 * The sealing counterpart of {@link eciesUnwrap} with `verifyHmac` and `pkcs7` both set.
 *
 * Seals `plaintext` for `peerPublicKey` (a P-256 point, compressed or uncompressed) as
 * `ephemeralPub(33, compressed) ‖ iv(16) ‖ ct ‖ HMAC(32)`: `S = ECDH_X(ephemeral, peer)` →
 * `kdf = eufyKDF(S)` → `ct = AES-128-CBC(kdf[0:16], iv, PKCS7(plaintext))`, tagged
 * `HMAC-SHA256(kdf[16:48], iv ‖ ct)`.
 */
export function eciesWrap(plaintext: Buffer, peerPublicKey: Buffer, options: EciesWrapOptions = {}): Buffer {
  const ecdh = createECDH("prime256v1");
  if (options.ephemeralPrivateKey) ecdh.setPrivateKey(options.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const kdf = eufyKdf(ecdh.computeSecret(peerPublicKey), 48);
  const iv = options.iv ?? randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", kdf.subarray(0, 16), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = createHmac("sha256", kdf.subarray(16, 48)).update(iv).update(ct).digest();
  return Buffer.concat([ecdh.getPublicKey(null, "compressed"), iv, ct, tag]);
}

/**
 * The AES-256-GCM key a version-8 `CMD_GATEWAYINFO` (1100) gives, as the app's native `DecryptECC` reads the body
 * after `cipher_id`: `ephemeralPub(33, compressed P-256) ‖ iv(16) ‖ ciphertext(48) ‖ HMAC(32)`, under the first 64 hex
 * characters of the cipher's `ecc_private_key` — ECDH → eufyKDF → HMAC-SHA256 checked with `kdf[16:48]` over
 * `iv ‖ ciphertext` → AES-128-CBC with `kdf[0:16]`. The key is the first 32 plaintext bytes. Answers `undefined`
 * where the body is short or does not open.
 */
export function deriveLevel2KeyFromGatewayInfo(body: Buffer, eccPrivateKeyHex: string): Buffer | undefined {
  const plain = eciesUnwrap(body, eccPrivateKeyHex.slice(0, 64), { verifyHmac: true });
  return plain && plain.length >= 32 ? Buffer.from(plain.subarray(0, 32)) : undefined;
}

/**
 * The AES-128-ECB key any other `CMD_GATEWAYINFO` (1100) gives, as the app reads the body after `cipher_id`: the
 * whole body decrypted `RSA/ECB/PKCS1Padding` under the cipher's `private_key` (newlines and the `RSA PRIVATE KEY`
 * armor lines dropped, the rest base64 read as PKCS#8 DER whatever the armor says), the plaintext made a Java `String`
 * (UTF-8), and the first 16 bytes of that string in JNI's modified UTF-8
 * as the native setter copies them, zero beyond its end. The padding is checked here over the raw RSA result so a wrong key fails closed:
 * under OpenSSL's implicit rejection, `RSA_PKCS1_PADDING` answers random bytes for it instead of throwing.
 *
 * Answers `undefined` when the key does not parse, the body is not one modulus long or the padding is wrong.
 */
export function deriveLevel2KeyFromRsaGatewayInfo(body: Buffer, rsaPrivateKey: string): Buffer | undefined {
  try {
    const b64 = rsaPrivateKey.replace(/-----(BEGIN|END) RSA PRIVATE KEY-----/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
    const key = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
    const modulusBits = key.asymmetricKeyDetails?.modulusLength;
    if (!modulusBits || body.length !== Math.ceil(modulusBits / 8)) return undefined;
    const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, body);
    if (block[0] !== 0x00 || block[1] !== 0x02) return undefined;
    const separator = block.indexOf(0x00, 2);
    if (separator < 10) return undefined;
    const sessionKey = Buffer.alloc(16);
    modifiedUtf8(block.subarray(separator + 1).toString("utf-8")).copy(sessionKey, 0, 0, 16);
    return sessionKey;
  } catch {
    return undefined;
  }
}

/** A string as JNI's `GetStringUTFChars` gives it: modified UTF-8, U+0000 and each UTF-16 unit encoded on their own. */
function modifiedUtf8(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

/** Local-lookup payload: two zero bytes. */
export function buildLocalLookupPayload(): Buffer {
  return Buffer.from([0x00, 0x00]);
}

/** Cloud-lookup payload (variant 2): `[p2pDid:20][dskKey][0x00000000]`. */
export function buildLookupWithKeyPayload2(p2pDid: string, dskKey: string): Buffer {
  return Buffer.concat([p2pDidToBuffer(p2pDid), Buffer.from(dskKey), Buffer.from([0, 0, 0, 0])]);
}

/** Encode an address as `[flags:2 BE=0x0002][port:2 LE][ip:4 reversed][pad:8]` — same shape as a
 * LOCAL_LOOKUP_RESP/CAM_ID record. It carries the self-reported candidate in a LOOKUP_WITH_KEY request
 * (reverse-engineered byte-exact from a live capture of the real app's own request) and the relay address
 * in a RLY_REQ. */
function encodeAddress(host: string, port: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeUInt16BE(0x0002, 0); // constant in every captured request; purpose unconfirmed
  out.writeUInt16LE(port, 2);
  const octets = host.split(".").map(Number);
  out[4] = octets[3];
  out[5] = octets[2];
  out[6] = octets[1];
  out[7] = octets[0];
  return out; // bytes 8-15 stay zero
}

/**
 * Cloud-lookup payload — the CLASSIC variant (`LOOKUP_WITH_KEY`, 0xf126), reverse-engineered
 * byte-exact against the app's own request (cold-start, phone
 * force-stopped then reopened). Distinct from {@link buildLookupWithKeyPayload2} (`LOOKUP_WITH_KEY2`,
 * 0xf16a) which eufy-sdk already sent: that variant only ever got relay-pool candidates back for a
 * remote (cross-WAN) target; THIS variant is what got the real app a genuine direct-device address.
 *
 * `[p2pDid:20][selfAddr:16][clientVersion:4 = 02 05 01 05][dskKey][0x00000000]`. `selfAddr` is the
 * caller's own observed LAN host:port (the socket's own bound address) — a STUN-like self-report, NOT
 * the target's address. `clientVersion` was `02 05 01 05` in every capture; reproduced verbatim since
 * its exact semantics (and whether it's validated) are unconfirmed.
 */
export function buildLookupWithKeyPayload(p2pDid: string, selfHost: string, selfPort: number, dskKey: string): Buffer {
  return Buffer.concat([
    p2pDidToBuffer(p2pDid),
    encodeAddress(selfHost, selfPort),
    Buffer.from([0x02, 0x05, 0x01, 0x05]),
    Buffer.from(dskKey),
    Buffer.from([0, 0, 0, 0]),
  ]);
}

/** RLY_REQ payload: `[p2pDid:20][relay address record:16][mark:4 BE]`, naming the relay port and mark a RLY_PORT_ACK gave. */
export function buildRelayRequestPayload(p2pDid: string, relay: Address, mark: number): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(mark >>> 0, 0);
  return Buffer.concat([p2pDidToBuffer(p2pDid), encodeAddress(relay.host, relay.port), tail]);
}

/** RLY_PKT payload: `[handle:4 BE][p2pDid:20][role:1][pad:3]`; a connecting client's role byte is 0. */
export function buildRelayPacketPayload(handle: number, p2pDid: string): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(handle >>> 0, 0);
  return Buffer.concat([head, p2pDidToBuffer(p2pDid), Buffer.alloc(4)]);
}

/** CHECK_CAM hole-punch payload: `[p2pDid:20][0x000000]`. */
export function buildCheckCamPayload(p2pDid: string): Buffer {
  return Buffer.concat([p2pDidToBuffer(p2pDid), Buffer.from([0, 0, 0])]);
}

/** 10-byte command header: `[dataTypeHeader:2][seq:2 BE]["XZYH"][cmd:2 LE]`. */
export function buildCommandHeader(
  seqNumber: number,
  commandType: number,
  dataTypeHeader: Buffer = P2PDataTypeHeader.DATA,
): Buffer {
  const seq = Buffer.allocUnsafe(2);
  seq.writeUInt16BE(seqNumber, 0);
  const cmd = Buffer.allocUnsafe(2);
  cmd.writeUInt16LE(commandType, 0);
  return Buffer.concat([dataTypeHeader, seq, Buffer.from(MAGIC_WORD), cmd]);
}

/** 10-byte empty command body for the given channel (used by CMD_GATEWAYINFO etc.). */
export function buildVoidCommandPayload(channel = 255): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([channel, 0x00]),
    Buffer.from([0x00, 0x00]),
  ]);
}

/** AES-128-ECB encrypt (no auto-padding) — P2P control payloads. Inverse of decryptP2PData. */
export function encryptP2PData(data: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** Zero-pad to a multiple of `blocksize` (eufy P2P pads with 0x00, NOT PKCS7). */
export function paddingP2PData(data: Buffer, blocksize = 16): Buffer {
  const size = data.byteLength < blocksize ? blocksize : Math.ceil(data.byteLength / blocksize) * blocksize;
  const out = Buffer.alloc(size);
  data.copy(out);
  return out;
}

const GCM_AAD = Buffer.from("eufy security");

/**
 * An AES-GCM command body, AES-128 or AES-256 by the key's length, AAD "eufy security", a fresh 12-byte nonce:
 * `tag(16) ‖ nonce(12) ‖ word(4, LE) ‖ ciphertext`.
 */
export function gcmSeal(key: Buffer, plaintext: Buffer, word: number): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, nonce);
  c.setAAD(GCM_AAD);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const w = Buffer.alloc(4);
  w.writeUInt32LE(word >>> 0);
  return Buffer.concat([c.getAuthTag(), nonce, w, ct]);
}

/** An inbound AES-GCM body `tag(16) ‖ nonce(12) ‖ ciphertext` opened under `key`; `undefined` when it does not open. */
export function gcmOpen(key: Buffer, body: Buffer): Buffer | undefined {
  try {
    const d = createDecipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, body.subarray(16, 28));
    d.setAAD(GCM_AAD);
    d.setAuthTag(body.subarray(0, 16));
    return Buffer.concat([d.update(body.subarray(28)), d.final()]);
  } catch {
    return undefined;
  }
}

/**
 * The plaintext body of an **int+string** command: `valueSub(u32 LE) ‖ value(u32 LE) ‖ strValue` in the 128-byte-chunk
 * length form ({@link stringWithLength}), omitted when empty. The eufy app's shape for the floodlight/spotlight manual
 * switch (`CMD_SET_FLOODLIGHT_MANUAL_SWITCH` 1400) on IndoorOutdoor / SoloCam-spotlight / Cam2C/3 families: `value` =
 * 0/1, `valueSub` = the device channel, `strValue` = the admin `account_id`.
 */
export function intStringCommandBody(value: number, valueSub: number, strValue: string): Buffer {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32LE(valueSub >>> 0, 0);
  head.writeUInt32LE(value >>> 0, 4);
  return strValue.length === 0 ? head : Buffer.concat([head, stringWithLength(strValue)]);
}

/**
 * The plaintext body of a **string-pair** command: five zero bytes, then `strValue` and `strValueSub`, each in the
 * 128-byte-chunk length form ({@link stringWithLength}). `CMD_DOWNLOAD_VIDEO` (1024) takes this shape on a HomeBase 2:
 * `strValue` = the recording's path on the station, `strValueSub` = the station admin `account_id`.
 */
export function stringPairCommandBody(strValue: string, strValueSub: string): Buffer {
  return Buffer.concat([Buffer.alloc(5), stringWithLength(strValue), stringWithLength(strValueSub)]);
}

/**
 * A command payload around an already sealed (or plaintext) `data`, with its frame fields verbatim:
 * `len(u32 LE) ‖ magic(2) ‖ [channel, signCode] ‖ [streamId, 00] ‖ data`.
 */
export function buildRawCommandPayload(
  data: Buffer,
  channel = 0,
  signCode = 0,
  magic: [number, number] = [0x01, 0x00],
  streamId = 0,
): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(data.length, 0);
  return Buffer.concat([
    header,
    Buffer.from([magic[0] & 0xff, magic[1] & 0xff]),
    Buffer.from([channel & 0xff, signCode & 0xff]),
    Buffer.from([streamId & 0xff, 0x00]),
    data,
  ]);
}

/** ACK payload for a received DATA frame: `[dataTypeHeader:2][count:2 BE][seqNo:2 BE]`. */
export function buildAckPayload(dataTypeHeader: Buffer, seqNo: number): Buffer {
  const count = Buffer.allocUnsafe(2);
  count.writeUInt16BE(1, 0);
  const seq = Buffer.allocUnsafe(2);
  seq.writeUInt16BE(seqNo, 0);
  return Buffer.concat([dataTypeHeader, count, seq]);
}

/** Parse the 16-byte data-frame header that follows the "XZYH" magic. */
export function parseDataFrameHeader(frame: Buffer): P2PDataFrameHeader {
  return {
    commandId: frame.subarray(4, 6).readUIntLE(0, 2),
    bytesToRead: frame.subarray(6, 10).readUIntLE(0, 4),
    version: frame.readUInt8(10),
    channel: frame.readUInt8(12),
    signCode: frame.readUInt8(13),
    type: frame.readUInt8(14),
  };
}

/** Read the 16-byte address record at `offset`: port little-endian at +2, IPv4 reversed at +4. */
function readAddress(buf: Buffer, offset: number): Address {
  return {
    host: `${buf[offset + 7]}.${buf[offset + 6]}.${buf[offset + 5]}.${buf[offset + 4]}`,
    port: buf.readUInt16LE(offset + 2),
  };
}

/** A LOOKUP_ADDR message's leading address record, or `undefined` for a message too short to carry it. */
export function parseLookupAddr(msg: Buffer): Address | undefined {
  return msg.length >= 12 ? readAddress(msg, 4) : undefined;
}

/** The relay servers a LIST_REQ_ACK names, in the order listed, without the unspecified address; records past the message's end are dropped. */
export function parseRelayList(msg: Buffer): Address[] {
  const out: Address[] = [];
  const count = msg.length > 4 ? msg[4] : 0;
  for (let i = 0; i < count && 8 + 16 * (i + 1) <= msg.length; i++) {
    const addr = readAddress(msg, 8 + 16 * i);
    if (addr.host !== "0.0.0.0") out.push(addr);
  }
  return out;
}

/** A RLY_PORT_ACK's mark and relay port, or `undefined` for a message too short to carry them. */
export function parseRelayPortAck(msg: Buffer): { mark: number; port: number } | undefined {
  return msg.length >= 10 ? { mark: msg.readUInt32BE(4), port: msg.readUInt16BE(8) } : undefined;
}

/** A RLY_TO's relay endpoint and handle, or `undefined` for a message too short to carry them. */
export function parseRelayTo(msg: Buffer): { address: Address; handle: number } | undefined {
  return msg.length >= 24 ? { address: readAddress(msg, 4), handle: msg.readUInt32BE(20) } : undefined;
}

/** Read a NUL-terminated UTF-8 string (CMD_NOTIFY_PAYLOAD carries JSON this way). */
export function readNullTerminatedString(data: Buffer, encoding: BufferEncoding = "utf8"): string {
  const end = data.indexOf(0x00);
  return data.subarray(0, end === -1 ? data.length : end).toString(encoding);
}
