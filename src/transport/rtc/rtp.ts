/**
 * The station's media as the vendor app's native RTC client receives it: SRTP and SRTCP (RFC 3711,
 * AES_CM_128_HMAC_SHA1_80, key derivation rate 0) multiplexed on one transport, keyed by the SDES line of the offer
 * the app builds for the station, H.264 (RFC 6184) / H.265 (RFC 7798) RTP depacketised to Annex B, and the media
 * AES-GCM layer above it.
 */
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

/** The `inline:` master key ‖ salt of the `a=crypto:1 AES_CM_128_HMAC_SHA1_80` line in both offer m-sections. */
export const RTC_SRTP_KEY = Buffer.from("FvLcvU2P3ZWmQxgPAgcDu7Zl9vftYElFOjEzhWs5", "base64");
const TAG = 10;
const START_CODE = Buffer.from([0, 0, 0, 1]);
const START3 = START_CODE.subarray(1);

/**
 * One media unit opened with the call's media key and iv strings: AES-128-GCM under the key string's first 16 bytes,
 * the iv string as the nonce, no AAD, the tag the unit's last 16 bytes; bytes before `clear` are not encrypted. The
 * plaintext unit (16 bytes shorter), `undefined` when it does not open. An audio payload is encrypted whole, a
 * parameter-set NAL from its third byte, a key frame from its IDR NAL header + 2.
 */
export function mediaOpen(key: string, iv: string, unit: Buffer, clear: number): Buffer | undefined {
  try {
    const d = createDecipheriv("aes-128-gcm", Buffer.from(key, "latin1").subarray(0, 16), Buffer.from(iv, "latin1"));
    d.setAuthTag(unit.subarray(unit.length - 16));
    return Buffer.concat([unit.subarray(0, clear), d.update(unit.subarray(clear, unit.length - 16)), d.final()]);
  } catch {
    return undefined;
  }
}

/**
 * The offset of an Annex-B unit's IDR NAL header, -1 without one: the first header after a `00 00 01` of type 5
 * (H.264, headers from offset 1023 on not searched) or 19 (H.265).
 */
export function idrAt(unit: Buffer, codec: "h264" | "h265"): number {
  for (let at = unit.indexOf(START3); at >= 0; at = unit.indexOf(START3, at + 4)) {
    const h = at + 3;
    if (codec === "h264" ? (unit[h]! & 0x1f) === 5 : ((unit[h]! >> 1) & 0x3f) === 19) return h;
    if (codec === "h264" && h >= 0x3ff) break;
  }
  return -1;
}

/** AES counter mode from IV = salt·2¹⁶ ⊕ SSRC·2⁶⁴ ⊕ index·2¹⁶ over `data`. */
export function aesCm(key: Buffer, salt: Buffer, ssrc: number, index: number, data: Buffer): Buffer {
  const iv = Buffer.alloc(16);
  salt.copy(iv, 0, 0, 14);
  iv.writeUInt32BE((iv.readUInt32BE(4) ^ ssrc) >>> 0, 4);
  const i = Buffer.alloc(6);
  i.writeUIntBE(index, 0, 6);
  for (let b = 0; b < 6; b++) iv[8 + b]! ^= i[b]!;
  return createCipheriv("aes-128-ctr", key, iv).update(data);
}

/** The `n`-byte session key of `label` (0..2 SRTP cipher/auth/salt, 3..5 SRTCP) from the master key and salt. */
export function srtpKey(master: Buffer, salt: Buffer, label: number, n: number): Buffer {
  const s = Buffer.from(salt);
  s[7]! ^= label;
  return aesCm(master, s, 0, 0, Buffer.alloc(n));
}

interface Keys {
  key: Buffer;
  auth: Buffer;
  salt: Buffer;
}

/**
 * The receive side of one SRTP master key: {@link SrtpReceiver.unprotect} authenticates and decrypts an SRTP or
 * (payload type 192..223) SRTCP packet, `undefined` when the tag does not match. The rollover counter of each SSRC
 * follows RFC 3711 Appendix A.
 */
export class SrtpReceiver {
  private readonly rtp: Keys;
  private readonly rtcp: Keys;
  private readonly roc = new Map<number, { roc: number; seq: number }>();

  constructor(master: Buffer = RTC_SRTP_KEY) {
    const [key, salt] = [master.subarray(0, 16), master.subarray(16, 30)];
    const derive = (l: number): Keys => ({
      key: srtpKey(key, salt, l, 16),
      auth: srtpKey(key, salt, l + 1, 20),
      salt: srtpKey(key, salt, l + 2, 14),
    });
    this.rtp = derive(0);
    this.rtcp = derive(3);
  }

  unprotect(p: Buffer): Buffer | undefined {
    const pt = p[1]! & 0x7f;
    return pt >= 64 && pt < 96 ? this.unprotectRtcp(p) : this.unprotectRtp(p);
  }

  private unprotectRtp(p: Buffer): Buffer | undefined {
    if (p.length < 12 + TAG) return undefined;
    const ssrc = p.readUInt32BE(8);
    const seq = p.readUInt16BE(2);
    const s = this.roc.get(ssrc) ?? { roc: 0, seq };
    const v = s.seq < 32768 ? (seq - s.seq > 32768 ? s.roc - 1 : s.roc) : s.seq - 32768 > seq ? s.roc + 1 : s.roc;
    const body = p.subarray(0, p.length - TAG);
    const roc = Buffer.alloc(4);
    roc.writeUInt32BE(v >>> 0);
    if (!tagOk(this.rtp.auth, [body, roc], p.subarray(body.length))) return undefined;
    if (v > s.roc || (v === s.roc && seq > s.seq) || !this.roc.has(ssrc)) this.roc.set(ssrc, { roc: v, seq });
    let off = 12 + (p[0]! & 0x0f) * 4;
    if (p[0]! & 0x10 && body.length >= off + 4) off += 4 + body.readUInt16BE(off + 2) * 4;
    if (off > body.length) return undefined;
    const plain = aesCm(this.rtp.key, this.rtp.salt, ssrc, v * 65536 + seq, body.subarray(off));
    return Buffer.concat([body.subarray(0, off), plain]);
  }

  private unprotectRtcp(p: Buffer): Buffer | undefined {
    if (p.length < 8 + 4 + TAG) return undefined;
    const body = p.subarray(0, p.length - TAG);
    if (!tagOk(this.rtcp.auth, [body], p.subarray(body.length))) return undefined;
    const e = body.readUInt32BE(body.length - 4);
    const packet = body.subarray(0, body.length - 4);
    if (!(e & 0x80000000)) return Buffer.from(packet);
    const plain = aesCm(this.rtcp.key, this.rtcp.salt, p.readUInt32BE(4), e & 0x7fffffff, packet.subarray(8));
    return Buffer.concat([packet.subarray(0, 8), plain]);
  }
}

function tagOk(auth: Buffer, parts: Buffer[], tag: Buffer): boolean {
  const h = createHmac("sha1", auth);
  for (const part of parts) h.update(part);
  return timingSafeEqual(h.digest().subarray(0, TAG), tag);
}

/**
 * RTP depacketizer for H.264 (single NAL, STAP-A 24, FU-A 28) or H.265 (single NAL, AP 48, FU 49). Feed whole RTP
 * packets; it calls `onUnit` with each complete Annex-B access unit when the marker bit closes it. A unit with a
 * sequence gap or an unterminated fragment is dropped, never delivered short. RTCP multiplexed on the same
 * transport (PT 200-207, which reads as 72-79 in the RTP payload-type bits) is skipped.
 */
export class RtpDepacketizer {
  private nals: Buffer[] = [];
  private fu: Buffer[] | undefined;
  private lastSeq = -1;
  private broken = false;

  /** `single`, when given, maps each single-NAL packet's payload before it joins the unit. */
  constructor(
    private readonly codec: "h264" | "h265",
    private readonly onUnit: (unit: Buffer, timestamp: number) => void,
    private readonly single?: (nal: Buffer) => Buffer,
  ) {}

  push(packet: Buffer): void {
    if (packet.length < 12 || packet[0]! >> 6 !== 2) return;
    const pt = packet[1]! & 0x7f;
    if (pt >= 72 && pt <= 79) return;
    const marker = (packet[1]! & 0x80) !== 0;
    const seq = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);
    if (this.lastSeq >= 0 && seq !== ((this.lastSeq + 1) & 0xffff)) this.broken = true;
    this.lastSeq = seq;
    let off = 12 + (packet[0]! & 0x0f) * 4;
    if (packet[0]! & 0x10) {
      if (packet.length < off + 4) return;
      off += 4 + packet.readUInt16BE(off + 2) * 4;
    }
    let end = packet.length;
    if (packet[0]! & 0x20) end -= packet[packet.length - 1]!;
    if (end <= off) return;
    const p = packet.subarray(off, end);
    const h265 = this.codec === "h265";
    const [ap, fu, hdr] = h265 ? [48, 49, 2] : [24, 28, 1];
    const type = h265 ? (p[0]! >> 1) & 0x3f : p[0]! & 0x1f;
    if (type < ap && (h265 || type > 0)) {
      this.nals.push(Buffer.from(this.single?.(p) ?? p));
    } else if (type === ap) {
      let o = hdr;
      while (o + 2 <= p.length) {
        const len = p.readUInt16BE(o);
        if (o + 2 + len > p.length) break;
        this.nals.push(Buffer.from(p.subarray(o + 2, o + 2 + len)));
        o += 2 + len;
      }
    } else if (type === fu && p.length > hdr + 1) {
      const fh = p[hdr]!;
      if (fh & 0x80)
        this.fu = [Buffer.from(h265 ? [(p[0]! & 0x81) | ((fh & 0x3f) << 1), p[1]!] : [(p[0]! & 0xe0) | (fh & 0x1f)])];
      if (this.fu) this.fu.push(Buffer.from(p.subarray(hdr + 1)));
      else this.broken = true;
      if (fh & 0x40 && this.fu) {
        this.nals.push(Buffer.concat(this.fu));
        this.fu = undefined;
      }
    }
    if (marker) {
      if (!this.broken && !this.fu && this.nals.length) {
        const parts: Buffer[] = [];
        for (const n of this.nals) parts.push(START_CODE, n);
        this.onUnit(Buffer.concat(parts), timestamp);
      }
      this.nals = [];
      this.fu = undefined;
      this.broken = false;
    }
  }
}
