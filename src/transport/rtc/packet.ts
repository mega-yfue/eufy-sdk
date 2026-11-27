/**
 * The station signalling packet of the vendor app's native RTC client, and the ciphers its bodies use.
 *
 * A packet is a 60-byte little-endian header and a body. Header bytes: 0 u16 packet type 3, 2 u16 CRC, 4 u16
 * message kind, 6 u16 body length, 8 u32 `time(NULL)`, 12 u8 protocol version 7, 13 u8 client byte, 14 u8
 * direction (0 request, 1 response), 15 u8, 16 u16 status, 18 u8, 19 u8 flag bits (0x01 = re-discover), 20 the
 * hub serial in 16 zero-padded ASCII bytes, 40 u8 extended-header length 20, 41 u8 body kind, 42 u8 seq, 43 u8
 * route id, 44 u8, 46..56 proxy info, 57/58 sdk version 0, 3, 59 u8 2 when wrapped.
 *
 * The CRC is CRC-16/XMODEM (poly 0x1021, init 0, unreflected) over header bytes 4..60 then the body.
 *
 * Every UDP datagram travels in a type-8 wrapper: u16 8, u16 inner + pad length, a 16-byte random XOR mask in
 * clear, u8 pad length (low byte), u8 random, the inner packet XORed with the mask, random padding.
 */
import { createPublicKey, constants, publicEncrypt, randomBytes, randomInt } from "node:crypto";
import { decryptP2PData, encryptP2PData, paddingP2PData } from "../p2p/codec.js";

export const RTC_HEADER_LENGTH = 60;
/** Message kinds (header byte 4). */
export const RtcKind = { REG: 1, CALL: 2, ACK: 3, INFO: 4, DISCOVER: 9 } as const;
/** Body kinds (header byte 41). */
export const RtcBody = { JSON: 2, PUBKEY: 3, SESSION_KEY: 4, KEEP_ALIVE: 6, CALL: 7 } as const;
/** The key string the client decrypts the server's 401 with. */
export const RTC_DEFAULT_KEY = "&#%@!_eufy_anker";
/** The client byte (header byte 13) the app writes on every packet. */
const CLIENT_BYTE = 6;
const WRAPPED = 8;

/** CRC-16/XMODEM. */
export function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Header fields of an outgoing request; `ts` defaults to the current unix second. */
export interface RtcRequest {
  kind: number;
  sn: string;
  seq: number;
  route: number;
  ts?: number;
  /** Header byte 15. */
  extra?: number;
  /** Header byte 44. */
  b44?: number;
}

/** A request header, unsealed: {@link rtcPacket} completes it. */
export function rtcHeader(r: RtcRequest): Buffer {
  const h = Buffer.alloc(RTC_HEADER_LENGTH);
  h.writeUInt16LE(r.kind, 4);
  h.writeUInt32LE(r.ts ?? Math.floor(Date.now() / 1000), 8);
  h[13] = CLIENT_BYTE;
  h[15] = r.extra ?? 0;
  h.write(r.sn, 20, 16, "latin1");
  h[42] = r.seq;
  h[43] = r.route;
  h[44] = r.b44 ?? 0;
  return h;
}

/** Header ‖ body with the type, version, lengths, body kind, sdk version and CRC the sender stamps. */
export function rtcPacket(header: Buffer, bodyKind = 0, body: Buffer = Buffer.alloc(0)): Buffer {
  const p = Buffer.concat([header.subarray(0, RTC_HEADER_LENGTH), body]);
  p.writeUInt16LE(3, 0);
  p.writeUInt16LE(body.length, 6);
  p[12] = 7;
  p[40] = 20;
  p[41] = bodyKind;
  p[57] = 0;
  p[58] = 3;
  p.writeUInt16LE(crc16(p.subarray(4)), 2);
  return p;
}

/** The type-8 wrapper of a sealed packet: sets header byte 59 to 2, re-CRCs, masks, pads by `rand() % (979 − len)`. */
export function wrapRtcPacket(packet: Buffer): Buffer {
  const inner = Buffer.from(packet);
  inner[59] = 2;
  inner.writeUInt16LE(crc16(inner.subarray(4)), 2);
  const pad = randomInt(Math.max(1, 979 - inner.length));
  const out = randomBytes(22 + inner.length + pad);
  out.writeUInt16LE(WRAPPED, 0);
  out.writeUInt16LE(inner.length + pad, 2);
  out[20] = pad & 0xff;
  for (let i = 0; i < inner.length; i++) out[22 + i] = inner[i]! ^ out[4 + (i & 15)]!;
  return out;
}

/** A received packet: the 60-byte header and the body its length field names. */
export interface RtcPacket {
  header: Buffer;
  body: Buffer;
}

/**
 * A received datagram, unwrapped when type 8 (≥ 23 bytes), answered only for a type-3 packet of version > 2 with
 * a 20-byte extended header and a matching CRC; `undefined` otherwise.
 */
export function parseRtcDatagram(datagram: Buffer): RtcPacket | undefined {
  let d = datagram;
  if (d.length >= 23 && d.readUInt16LE(0) === WRAPPED) {
    const n = Math.min(d.readUInt16LE(2) - d[20]!, d.length - 22);
    d = Buffer.alloc(Math.max(0, n));
    for (let i = 0; i < d.length; i++) d[i] = datagram[22 + i]! ^ datagram[4 + (i & 15)]!;
  }
  if (d.length < RTC_HEADER_LENGTH || d.readUInt16LE(0) !== 3 || d[12]! <= 2 || d[40] !== 20) return undefined;
  const end = RTC_HEADER_LENGTH + d.readUInt16LE(6);
  if (end > d.length || crc16(d.subarray(4, end)) !== d.readUInt16LE(2)) return undefined;
  return { header: d.subarray(0, RTC_HEADER_LENGTH), body: d.subarray(RTC_HEADER_LENGTH, end) };
}

/**
 * The AES-128 key of a body: the key string's first 16 bytes with the decimal int32 `ts` written over its tail,
 * cut at the first NUL and zero-filled to 16.
 */
export function rtcKey(keyStr: string, ts: number): Buffer {
  const t = String(ts | 0);
  const b = Buffer.alloc(17);
  Buffer.from(keyStr, "latin1").copy(b, 0, 0, 16);
  b.write(t, 16 - t.length, "latin1");
  b[16] = 0;
  const k = Buffer.alloc(16);
  b.copy(k, 0, 0, b.indexOf(0));
  return k;
}

/** AES-128-ECB under {@link rtcKey}, zero-padded to 16. */
export function rtcEncrypt(data: Buffer, keyStr: string, ts: number): Buffer {
  return encryptP2PData(paddingP2PData(data), rtcKey(keyStr, ts));
}

/** Inverse of {@link rtcEncrypt}; the zero padding stays. */
export function rtcDecrypt(data: Buffer, keyStr: string, ts: number): Buffer {
  return decryptP2PData(data, rtcKey(keyStr, ts));
}

/** RSA-1024 PKCS#1 v1.5 public encrypt under a 256-hex-char modulus, exponent 65537. */
export function rsaEncrypt(data: Buffer, modulusHex: string): Buffer {
  const key = createPublicKey({
    key: { kty: "RSA", n: Buffer.from(modulusHex, "hex").toString("base64url"), e: "AQAB" },
    format: "jwk",
  });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, data);
}
