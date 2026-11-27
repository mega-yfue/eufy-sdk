/**
 * The station's media as the vendor app's native RTC client receives it: plain RTP and RTCP multiplexed on one
 * transport (the app's libjingle negotiates SDES but its SRTP session protects and unprotects nothing), H.264
 * (RFC 6184) / H.265 (RFC 7798) RTP depacketised to Annex B, and the media AES-GCM layer above it.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

const START_CODE = Buffer.from([0, 0, 0, 1]);
const START3 = START_CODE.subarray(1);

/**
 * One media unit opened with the call's media key and iv strings: AES-128-GCM under the key string's first 16 bytes,
 * the iv string as the nonce, no AAD, the tag the unit's last 16 bytes; bytes before `clear` are not encrypted. The
 * plaintext unit (16 bytes shorter), `undefined` when its tag fails, unless `keep`: then the bytes deciphered all the
 * same, as the app's audio receiver inserts them. An audio payload is encrypted whole, a parameter-set NAL from its
 * third byte, a key frame from its IDR NAL header + 2.
 */
export function mediaOpen(key: string, iv: string, unit: Buffer, clear: number, keep = false): Buffer | undefined {
  const d = createDecipheriv("aes-128-gcm", ...gcmKey(key, iv));
  const plain = Buffer.concat([unit.subarray(0, clear), d.update(unit.subarray(clear, unit.length - 16))]);
  try {
    d.setAuthTag(unit.subarray(unit.length - 16));
    d.final();
    return plain;
  } catch {
    return keep ? plain : undefined;
  }
}

/** A talkback audio payload sealed whole as {@link mediaOpen} opens it, the tag appended. */
export function mediaSeal(key: string, iv: string, payload: Buffer): Buffer {
  const c = createCipheriv("aes-128-gcm", ...gcmKey(key, iv));
  return Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
}

const gcmKey = (key: string, iv: string) =>
  [Buffer.from(key, "latin1").subarray(0, 16), Buffer.from(iv, "latin1")] as const;

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

/** An RTP packet's payload past its CSRCs and header extension, padding removed; `undefined` when nothing is left. */
export function rtpPayload(packet: Buffer): Buffer | undefined {
  let off = 12 + (packet[0]! & 0x0f) * 4;
  if (packet[0]! & 0x10) {
    if (packet.length < off + 4) return undefined;
    off += 4 + packet.readUInt16BE(off + 2) * 4;
  }
  const end = packet.length - (packet[0]! & 0x20 ? packet[packet.length - 1]! : 0);
  return end > off ? packet.subarray(off, end) : undefined;
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
    const p = rtpPayload(packet);
    if (!p) return;
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
