/**
 * STUN messages (RFC 5389) as the vendor app's ICE and TURN clients speak them: a 20-byte header (u16 type, u16
 * attribute length, magic cookie, 96-bit transaction id), then type-length-value attributes padded to 4 bytes.
 * MESSAGE-INTEGRITY is HMAC-SHA1 over the message up to that attribute, the length field counting it;
 * FINGERPRINT is the CRC-32 of the message up to it XOR `0x5354554e`. Addresses are IPv4, XORed with the cookie.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";

const COOKIE = 0x2112a442;
/** Message types: method ‖ class (request 0x000, indication 0x010, success 0x100, error 0x110). */
export const Stun = {
  BINDING: 0x001,
  BINDING_OK: 0x101,
  ALLOCATE: 0x003,
  REFRESH: 0x004,
  CREATE_PERMISSION: 0x008,
  SEND: 0x016,
  DATA: 0x017,
  SUCCESS: 0x100,
  CLASS: 0x110,
} as const;
export const Attr = {
  USERNAME: 0x0006,
  INTEGRITY: 0x0008,
  ERROR: 0x0009,
  LIFETIME: 0x000d,
  PEER: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  RELAYED: 0x0016,
  TRANSPORT: 0x0019,
  MAPPED: 0x0020,
  PRIORITY: 0x0024,
  FINGERPRINT: 0x8028,
  CONTROLLED: 0x8029,
} as const;

export interface StunMessage {
  type: number;
  id: Buffer;
  /** First occurrence of each attribute. */
  attrs: Map<number, Buffer>;
  raw: Buffer;
  /** Offset of MESSAGE-INTEGRITY, 0 when absent. */
  integrity: number;
}

export interface Address {
  address: string;
  port: number;
}

/** A message of `type`: the attributes in order, then MESSAGE-INTEGRITY under `key` and FINGERPRINT when asked. */
export function encodeStun(
  type: number,
  id: Buffer,
  attrs: [number, Buffer][],
  key?: Buffer,
  fingerprint = false,
): Buffer {
  let m = Buffer.alloc(20);
  m.writeUInt16BE(type);
  m.writeUInt32BE(COOKIE, 4);
  id.copy(m, 8);
  const add = (t: number, v: Buffer) => {
    const a = Buffer.alloc(4 + ((v.length + 3) & ~3));
    a.writeUInt16BE(t);
    a.writeUInt16BE(v.length, 2);
    v.copy(a, 4);
    m = Buffer.concat([m, a]);
    m.writeUInt16BE(m.length - 20, 2);
  };
  for (const [t, v] of attrs) add(t, v);
  if (key) {
    m.writeUInt16BE(m.length - 20 + 24, 2);
    add(Attr.INTEGRITY, createHmac("sha1", key).update(m).digest());
  }
  if (fingerprint) {
    m.writeUInt16BE(m.length - 20 + 8, 2);
    add(Attr.FINGERPRINT, u32((crc32(m) ^ 0x5354554e) >>> 0));
  }
  return m;
}

/** A datagram as a STUN message; `undefined` unless the cookie, the length and any FINGERPRINT check out. */
export function decodeStun(raw: Buffer): StunMessage | undefined {
  if (raw.length < 20 || raw[0]! > 1 || raw.readUInt32BE(4) !== COOKIE || raw.readUInt16BE(2) + 20 !== raw.length)
    return undefined;
  const msg: StunMessage = { type: raw.readUInt16BE(0), id: raw.subarray(8, 20), attrs: new Map(), raw, integrity: 0 };
  for (let o = 20; o + 4 <= raw.length;) {
    const t = raw.readUInt16BE(o);
    const v = raw.subarray(o + 4, o + 4 + raw.readUInt16BE(o + 2));
    if (t === Attr.INTEGRITY && !msg.integrity) msg.integrity = o;
    if (t === Attr.FINGERPRINT && v.readUInt32BE() !== (crc32(raw.subarray(0, o)) ^ 0x5354554e) >>> 0) return undefined;
    if (!msg.attrs.has(t)) msg.attrs.set(t, v);
    o += 4 + ((v.length + 3) & ~3);
  }
  return msg;
}

/** Whether MESSAGE-INTEGRITY is present and matches under `key`. */
export function stunIntegrity(msg: StunMessage, key: Buffer): boolean {
  if (!msg.integrity) return false;
  const head = Buffer.from(msg.raw.subarray(0, msg.integrity));
  head.writeUInt16BE(msg.integrity - 20 + 24, 2);
  const mac = createHmac("sha1", key).update(head).digest();
  return timingSafeEqual(mac, msg.raw.subarray(msg.integrity + 4, msg.integrity + 24));
}

/** The long-term credential key: MD5 of `user:realm:password`. */
export function longTermKey(user: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${user}:${realm}:${password}`).digest();
}

/** An IPv4 XOR-*-ADDRESS value. */
export function xorAddress(a: Address): Buffer {
  const v = Buffer.alloc(8);
  v[1] = 1;
  v.writeUInt16BE(a.port ^ (COOKIE >>> 16), 2);
  v.writeUInt32BE((a.address.split(".").reduce((n, b) => n * 256 + Number(b), 0) ^ COOKIE) >>> 0, 4);
  return v;
}

/** An IPv4 XOR-*-ADDRESS value read back; `undefined` for another family. */
export function readXorAddress(v: Buffer | undefined): Address | undefined {
  if (!v || v.length < 8 || v[1] !== 1) return undefined;
  const n = (v.readUInt32BE(4) ^ COOKIE) >>> 0;
  return { address: [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join("."), port: v.readUInt16BE(2) ^ (COOKIE >>> 16) };
}

/** The ERROR-CODE class × 100 + number, 0 when absent. */
export function stunError(msg: StunMessage): number {
  const v = msg.attrs.get(Attr.ERROR);
  return v && v.length >= 4 ? (v[2]! & 7) * 100 + v[3]! : 0;
}

export function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
