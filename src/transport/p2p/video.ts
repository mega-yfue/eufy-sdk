/**
 * eufy P2P video-frame decoder (`CMD_VIDEO_FRAME`, command id 1300).
 *
 * Station→phone H.264 frames ride the `d101` media channel. Each frame's body is AES-256-GCM
 * encrypted (AAD "eufy security") under a **per-stream media key**. Keyframes carry a 129-byte
 * ECIES envelope that wraps the 32-byte media key with the camera's ECC private key (the
 * `ecc_private_key` from `get_ciphers`, or the E2E vault key for vault-enabled cameras); P/B-frames
 * omit the envelope and reuse the media key recovered from the most recent keyframe.
 *
 * Frame layout (the payload AFTER the 16-byte "XZYH" data-frame header):
 * ```
 * [0x00:0x16] 22B header  : u32@0=ciphertext len (LE); flag@0x04 bit0 = keyframe/has-ECIES-key;
 *                           res s16@0x0a=width, s16@0x0c=height; ts@0x0e
 * [0x16:0x97] 129B ECIES envelope (KEYFRAMES ONLY): ephPub(33, compressed P-256) ‖ iv(16) ‖ ct(48) ‖ HMAC(32)
 * [0x97:0xa7] 16B  GCM tag
 * [0xa7:0xb3] 12B  GCM IV/nonce
 * [0xb3:end]  H.264 ciphertext (AES-256-GCM)
 * ```
 *
 * Format + crypto reversed byte-exact from `libmega_media_sdk.so` and verified against a live
 * capture. The frame layout is the block comment above.
 */
import { createDecipheriv } from "node:crypto";
import { eciesUnwrap } from "./codec.js";

/** AAD used for the AES-256-GCM body cipher of every video frame, and of a recording's audio. */
export const VIDEO_GCM_AAD = Buffer.from("eufy security");

/** Fixed byte offsets within the frame payload (after the 16-byte XZYH header). */
const HEADER_LEN = 0x16; // 22-byte frame header
const ENVELOPE_OFFSET = 0x16; // ECIES envelope (keyframes only)
const ENVELOPE_LEN = 0x81; // 129 bytes
const GCM_TAG_OFFSET = 0x97; // 16-byte GCM tag
const GCM_TAG_LEN = 16;
const GCM_NONCE_OFFSET = 0xa7; // 12-byte GCM nonce
const GCM_NONCE_LEN = 12;
const BODY_OFFSET = 0xb3; // H.264 ciphertext

/** Parsed fields of a `CMD_VIDEO_FRAME` 22-byte header. */
export interface VideoFrameHeader {
  /**
   * Length of the body THIS frame carries, from u32 LE @ 0x00 — not the length of the access unit it
   * belongs to.
   *
   * A station serves a unit larger than {@link STATION_CHUNK_BYTES} as several frames, and each one
   * declares only its own share: measured on two models, a 70190-byte unit arrived as `64000` then
   * `6190`, and a 104451-byte keyframe as `64000` then `40451`. A frame that carries a whole unit
   * declares the whole unit, however large — a captured keyframe declares 0x3b323.
   */
  payloadLength: number;
  /** True when flag@0x04 bit0 is set: a keyframe carrying the ECIES envelope. */
  keyframe: boolean;
  /** Raw flag byte at 0x04. */
  flags: number;
  /**
   * u16 LE @ 0x06 — repeated across every frame of ONE access unit, which is what makes it usable as
   * part of a unit's identity. What it counts differs by model (one increments it per unit, another
   * leaves it 0 for the whole stream), so it is never read as a count on its own.
   */
  sequence: number;
  /** Frame width (s16 LE @ 0x0a). */
  width: number;
  /** Frame height (s16 LE @ 0x0c). */
  height: number;
  /** Timestamp word (u32 LE @ 0x0e). */
  timestamp: number;
}

/** A successfully decoded video frame. */
export interface DecodedVideoFrame {
  /** True if this was a keyframe (IDR) — its envelope re-keyed the decoder. */
  keyframe: boolean;
  /** Decrypted H.264 elementary-stream bytes. */
  h264: Buffer;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/**
 * Parse the 22-byte `CMD_VIDEO_FRAME` header. Does not validate lengths beyond the header itself,
 * so it is safe to call on a (sufficiently long) buffer to inspect frame metadata without keys.
 */
export function parseVideoFrameHeader(payload: Buffer): VideoFrameHeader | undefined {
  if (payload.length < HEADER_LEN) return undefined;
  const flags = payload.readUInt8(0x04);
  return {
    payloadLength: payload.readUInt32LE(0x00),
    keyframe: (flags & 0x01) === 1,
    flags,
    sequence: payload.readUInt16LE(0x06),
    width: payload.readInt16LE(0x0a),
    height: payload.readInt16LE(0x0c),
    timestamp: payload.readUInt32LE(0x0e),
  };
}

/**
 * Decodes a single P2P video stream into H.264. Construct one per stream with the camera's 32-byte
 * ECC private key; feed it `CMD_VIDEO_FRAME` payloads in order. Keyframes re-key the decoder via
 * their ECIES envelope; P/B-frames reuse the cached media key. All failure modes (short/garbage
 * frame, wrong key, tampered HMAC, GCM auth failure) return `undefined` — the decoder never throws.
 */
export class VideoFrameDecoder {
  private readonly eccPrivateKeyHex: string;
  private mediaKey?: Buffer;

  /** @param eccPrivateKey the camera's 32-byte ECC private key (P-256 scalar). */
  constructor(eccPrivateKey: Buffer) {
    if (eccPrivateKey.length !== 32) throw new Error("eccPrivateKey must be 32 bytes");
    this.eccPrivateKeyHex = eccPrivateKey.toString("hex");
  }

  /** The media key recovered from the most recent keyframe, if any. */
  get currentMediaKey(): Buffer | undefined {
    return this.mediaKey ? Buffer.from(this.mediaKey) : undefined;
  }

  /**
   * Recover the per-stream media key from a keyframe's 129-byte ECIES envelope: ECIES unwrap
   * (ECDH → eufyKDF → AES-128-CBC, with the trailing HMAC verified) → 32-byte AES-256-GCM key.
   */
  private unwrapMediaKey(envelope: Buffer): Buffer | undefined {
    const key = eciesUnwrap(envelope, this.eccPrivateKeyHex, { verifyHmac: true, pkcs7: true });
    return key && key.length === 32 ? key : undefined;
  }

  /**
   * Decode one video frame. Returns the keyframe flag and decrypted H.264 bytes, or `undefined`
   * if the frame is malformed, the envelope/key is wrong, or GCM authentication fails.
   */
  decodeFrame(payload: Buffer): DecodedVideoFrame | undefined {
    const header = parseVideoFrameHeader(payload);
    if (!header) return undefined;

    if (header.keyframe) {
      if (payload.length < ENVELOPE_OFFSET + ENVELOPE_LEN) return undefined;
      const envelope = payload.subarray(ENVELOPE_OFFSET, ENVELOPE_OFFSET + ENVELOPE_LEN);
      const key = this.unwrapMediaKey(envelope);
      if (!key) return undefined; // wrong key / tampered HMAC — fail closed, keep any prior key
      this.mediaKey = key;
    }

    const mediaKey = this.mediaKey;
    if (!mediaKey) return undefined; // P/B-frame before any keyframe — no key yet

    if (payload.length < BODY_OFFSET) return undefined;
    const tag = payload.subarray(GCM_TAG_OFFSET, GCM_TAG_OFFSET + GCM_TAG_LEN);
    const nonce = payload.subarray(GCM_NONCE_OFFSET, GCM_NONCE_OFFSET + GCM_NONCE_LEN);
    const body = payload.subarray(BODY_OFFSET);

    try {
      const dec = createDecipheriv("aes-256-gcm", mediaKey, nonce);
      dec.setAAD(VIDEO_GCM_AAD);
      dec.setAuthTag(tag);
      // Two allocations, not three. AES-GCM returns the whole plaintext from `update()` and an EMPTY
      // buffer from `final()` (which only verifies the tag), so concatenating unconditionally copies
      // every frame into a second full-size Buffer for nothing. At ~25 fps that is a frame-sized
      // allocation per frame thrown at an allocator that does not give the pages back: a consumer on a
      // memory-capped host measured RSS growing roughly with the bytes streamed while its own
      // accounting stayed flat. The concat stays as the correct fallback for any mode that splits.
      const head = dec.update(body);
      const tail = dec.final();
      const h264: Buffer = tail.length ? Buffer.concat([head, tail]) : head;
      return { keyframe: header.keyframe, h264, width: header.width, height: header.height };
    } catch {
      return undefined;
    }
  }
}

/** One whole access unit recovered from the frame (or frames) the station sent it in. */
export interface AssembledAccessUnit {
  /** Low 32-bit header timestamp from the first frame of this access unit. */
  sourceTimestampMs: number;
  /** True when the unit's own header flagged it a keyframe — a point a consumer may begin decoding at. */
  keyframe: boolean;
  /** Frame width the unit's header declared. */
  width: number;
  /** Frame height the unit's header declared. */
  height: number;
  /** The complete payload, as long as the header said it would be. */
  data: Buffer;
}

/**
 * The payload size a station fills a `CMD_VIDEO_FRAME` to before splitting an access unit across
 * several of them.
 *
 * Verified on two independent camera models on one account: every frame of a split unit declared
 * EXACTLY this, and the unit's last frame declared less.
 *
 * Matched by equality, never as a floor. Stations that do not split deliver whole units in one frame far
 * above this — measured at 148057, 231954 and 234670 bytes on three other models — and treating "at least
 * this big" as "more is coming" holds those units back and then discards them as truncated, which costs
 * exactly the keyframes a decoder cannot start without.
 */
export const STATION_CHUNK_BYTES = 64000;

/**
 * Reassembles a `CMD_VIDEO_FRAME` access unit the station split across several frames.
 *
 * Each frame declares only the payload IT carries ({@link VideoFrameHeader.payloadLength}), so the unit's
 * total length is nowhere on the wire and cannot be waited for. What the wire does carry, verified on two
 * models:
 *
 *  - the frames of one unit **repeat its header** — same timestamp, same {@link VideoFrameHeader.sequence} —
 *    while consecutive units differ in both;
 *  - every frame of a split unit is filled to {@link STATION_CHUNK_BYTES} except the last;
 *  - a frame that STARTS a unit begins with an Annex-B start code once decoded, and a continuation begins
 *    mid-NAL, so it does not.
 *
 * A unit is therefore held only while its latest frame is full, and completed the moment a shorter one
 * arrives — no delivery latency for the overwhelming majority of units, which arrive in one frame below
 * the threshold. The identity match and the missing start code are required TOGETHER before appending:
 * either alone would let two decodable units merge, and a merge is invisible to a consumer that trusts
 * the contract.
 *
 * **A unit is delivered only when it is complete.** A lost datagram makes the P2P layer discard the frame
 * it was reassembling, so a unit whose tail never arrives is ended by the next unit's first frame while
 * still full — that one is dropped and reported, never handed on short. Truncated bytes are worse than
 * none: a decoder given an access unit shorter than its own slice headers promise reports bitstream
 * truncation and produces no picture at all.
 *
 * Two consequences worth stating. A unit that is exactly the threshold long, or an exact multiple of it,
 * ends on a full frame and is dropped as truncated — one frame in ~64000, reported, and the alternative is
 * handing a decoder bytes that may genuinely be short. And a station that fills to some OTHER size is not
 * recognised: its units stay exactly as they arrive rather than being mis-joined.
 */
export class AccessUnitAssembler {
  private open?: { header: VideoFrameHeader; chunks: Buffer[]; carried: number };
  private droppedUnits = 0;

  /**
   * @param onDropped called for each incomplete unit discarded, with what had arrived, how many frames it
   * arrived in, and how many this assembler has dropped in total — a running count, so no caller keeps
   * its own.
   */
  constructor(private readonly onDropped?: (drop: { carried: number; chunks: number; count: number }) => void) {}

  /**
   * Feed one raw `CMD_VIDEO_FRAME` payload; returns the access units it completed — none while a unit is
   * still being filled, one in the ordinary case.
   *
   * `decode` extracts the payload of a frame, whatever the stream's encryption: it is called for EVERY
   * frame, including a continuation, because a continuation carries its own wrapped key ahead of its share
   * of the payload (measured: 129 bytes beyond what its header declares, exactly as a unit's first frame
   * carries). A continuation without its matching open unit has no Annex-B start code and cannot be emitted
   * as a complete unit, even if its repeated header says keyframe.
   */
  push(payload: Buffer, decode: (payload: Buffer) => Buffer | undefined): AssembledAccessUnit[] {
    const header = parseVideoFrameHeader(payload);
    const body = header && decode(payload);
    if (!header || !body?.length) {
      this.discard();
      return [];
    }
    const full = header.payloadLength === STATION_CHUNK_BYTES;
    const open = this.open;
    if (open && sameUnit(open.header, header) && !beginsAccessUnit(body)) {
      open.chunks.push(body);
      open.carried += body.length;
      if (full) return [];
      this.open = undefined;
      return [unitOf(open.header, Buffer.concat(open.chunks))];
    }
    this.discard();
    if (!beginsAccessUnit(body)) return [];
    if (full) {
      this.open = { header, chunks: [body], carried: body.length };
      return [];
    }
    return [unitOf(header, body)];
  }

  /** Forget an incomplete unit, counting and reporting it. */
  discard(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.droppedUnits++;
    this.onDropped?.({ carried: open.carried, chunks: open.chunks.length, count: this.droppedUnits });
  }
}

/** Whether two frames describe the same access unit: one unit's frames repeat its header. */
function sameUnit(open: VideoFrameHeader, next: VideoFrameHeader): boolean {
  return next.timestamp === open.timestamp && next.sequence === open.sequence;
}

/** Whether a decoded payload OPENS an access unit — a continuation begins mid-NAL, with no start code. */
function beginsAccessUnit(body: Buffer): boolean {
  if (body.length < 4 || body[0] !== 0 || body[1] !== 0) return false;
  return body[2] === 1 || (body[2] === 0 && body[3] === 1);
}

/** The delivered shape of a unit: its header's flags and geometry, and the payload as assembled. */
function unitOf(header: VideoFrameHeader, data: Buffer): AssembledAccessUnit {
  return {
    sourceTimestampMs: header.timestamp,
    keyframe: header.keyframe,
    width: header.width,
    height: header.height,
    data,
  };
}
