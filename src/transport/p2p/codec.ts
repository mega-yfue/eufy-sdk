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
import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
  LOOKUP_WITH_KEY2: Buffer.from([0xf1, 0x6a]),
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
  LOOKUP_ADDR2: Buffer.from([0xf1, 0x82]),
  CAM_ID: Buffer.from([0xf1, 0x42]),
  TURN_SERVER_CAM_ID: Buffer.from([0xf1, 0x84]),
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
 * The "Level 1" AES-128-ECB key for P2P command/control encryption — derivable
 * from sn + p2p_did alone (no cipher needed). HomeBase control-channel
 * notifications (sensor/alarm events) use exactly this key.
 */
export function p2pCommandEncryptionKey(stationSn: string, p2pDid: string): string {
  return `${stationSn.slice(-7)}${p2pDid.substring(p2pDid.indexOf("-"), p2pDid.indexOf("-") + 9)}`;
}

/** AES-128-ECB decrypt of a P2P payload (no padding). */
export function decryptP2PData(data: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

/** The `cipher_id` named in a decrypted `CMD_GATEWAYINFO` (1100) payload (uint16 LE @0). */
export function gatewayInfoCipherId(gwPayload: Buffer): number {
  return gwPayload.length >= 2 ? gwPayload.readUInt16LE(0) : 0;
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
 * Derive the P2P **level-2** (signCode 2/8) AES-256-GCM session key from a *decrypted*
 * `CMD_GATEWAYINFO` (1100) payload and the station's ECC private key (from `get_ciphers`).
 *
 * Layout of the decrypted payload: `cipher_id(2 LE) ‖ 0000 ‖ ECIES-envelope(129)`, where the
 * envelope is `ephemeralPub(33, compressed P-256) ‖ iv(16) ‖ ciphertext(48)`. ECIES =
 * ECDH(eccPriv, ephemeralPub) → eufyKDF(SHA-256/HMAC, label "ECIES") → AES-128-CBC decrypt →
 * 32-byte session key. Reversed from `libmega_media_sdk.so`; verified to reproduce the live key.
 * Returns the 32-byte key, or undefined if the inputs don't parse.
 */
export function deriveLevel2KeyFromGatewayInfo(gwPayload: Buffer, eccPrivateKeyHex: string): Buffer | undefined {
  const plain = eciesUnwrap(gwPayload.subarray(4, 4 + 129), eccPrivateKeyHex);
  if (!plain) return undefined;
  const key = plain.subarray(0, 32);
  return key.length === 32 ? Buffer.from(key) : undefined;
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
 * LOCAL_LOOKUP_RESP/CAM_ID record, embedded here as a self-reported candidate. Reverse-engineered
 * byte-exact from a live capture of the real app's own LOOKUP_WITH_KEY request. */
function encodeSelfAddress(host: string, port: number): Buffer {
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
    encodeSelfAddress(selfHost, selfPort),
    Buffer.from([0x02, 0x05, 0x01, 0x05]),
    Buffer.from(dskKey),
    Buffer.from([0, 0, 0, 0]),
  ]);
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

/**
 * Command body carrying a string `value` (e.g. CMD_SET_PAYLOAD JSON). Mirrors the
 * app's `buildCommandWithStringTypePayload`: `[len:2 LE][00 00][01 00][channel,encType][00 00][data]`.
 * When `key` is given the data is zero-padded to 16 and AES-128-ECB encrypted, and
 * `encType` is written in the channel word (level-1 encryption = 1).
 */
export function buildStringCommandPayload(value: string, channel = 0, key?: Buffer, encType = 1): Buffer {
  const encrypted = !!key && key.length === 16;
  const raw = Buffer.from(value, "utf-8");
  const data = encrypted ? encryptP2PData(paddingP2PData(raw), key!) : raw;
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16LE(data.length, 0);
  return Buffer.concat([
    header,
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([channel, encrypted ? encType : 0x00]),
    Buffer.from([0x00, 0x00]),
    data,
  ]);
}

/**
 * Build an **int+string** command body: `valueSub(u32 LE) ‖ value(u32 LE) ‖ strValue(len-prefixed)`,
 * AES-128-ECB encrypted (level-1) like {@link buildStringCommandPayload}. This is the wire shape the
 * eufy app uses for the floodlight/spotlight manual switch (`CMD_SET_FLOODLIGHT_MANUAL_SWITCH` 1400)
 * on IndoorOutdoor / SoloCam-spotlight / Cam2C/3 families — where `value` = 0/1, `valueSub` = the
 * device channel, and `strValue` = the admin `account_id`. The `strValue` uses the 128-byte-chunk
 * length prefix ({@link stringWithLength}).
 */
export function buildIntStringCommandPayload(
  value: number,
  valueSub: number,
  strValue: string,
  channel = 0,
  key?: Buffer,
  encType = 1,
): Buffer {
  const encrypted = !!key && key.length === 16;
  const someInt = Buffer.allocUnsafe(4);
  someInt.writeUInt32LE(valueSub >>> 0, 0);
  const valueBuf = Buffer.allocUnsafe(4);
  valueBuf.writeUInt32LE(value >>> 0, 0);
  const strBuf = strValue.length === 0 ? Buffer.alloc(0) : stringWithLength(strValue);
  const body = Buffer.concat([someInt, valueBuf, strBuf]);
  const data = encrypted ? encryptP2PData(paddingP2PData(body), key!) : body;
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16LE(data.length, 0);
  return Buffer.concat([
    header,
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([channel, encrypted ? encType : 0x00]),
    Buffer.from([0x00, 0x00]),
    data,
  ]);
}

/**
 * Build a command body around an ALREADY-encrypted (or plaintext) `data` buffer with an explicit
 * `signCode` — used for level-2 (`signCode 8`, AES-256-GCM) commands like the media-start 1350 the
 * app sends. Same on-wire layout as `buildStringCommandPayload` but the caller supplies the body and
 * the signCode verbatim (no ECB step): `len(u16) ‖ 0000 ‖ 0100 ‖ [channel, signCode] ‖ 0000 ‖ data`.
 */
export function buildRawCommandPayload(
  data: Buffer,
  channel = 0,
  signCode = 0,
  magic: [number, number] = [0x01, 0x00],
  streamId = 0,
): Buffer {
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16LE(data.length, 0);
  return Buffer.concat([
    header,
    Buffer.from([0x00, 0x00]),
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
    channel: frame.readUInt8(12),
    signCode: frame.readUInt8(13),
    type: frame.readUInt8(14),
  };
}

/** Parse a LOOKUP_ADDR / LOOKUP_ADDR2 response into a device address. */
export function parseLookupAddr(msg: Buffer): Address {
  const port = msg.subarray(6, 8).readUInt16LE();
  const host = `${msg[11]}.${msg[10]}.${msg[9]}.${msg[8]}`;
  return { host, port };
}

/** Read a NUL-terminated UTF-8 string (CMD_NOTIFY_PAYLOAD carries JSON this way). */
export function readNullTerminatedString(data: Buffer, encoding: BufferEncoding = "utf8"): string {
  const end = data.indexOf(0x00);
  return data.subarray(0, end === -1 ? data.length : end).toString(encoding);
}
