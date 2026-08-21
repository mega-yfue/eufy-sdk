/**
 * Annex-B elementary-stream helpers — the single NAL-sniffing source of truth for the P2P media
 * pipeline. Both the live source (codec tag on every frame) and the fMP4 muxer (parameter sets for
 * the init segment) read the stream through here, so the start-code scan + NAL-type decode lives in
 * exactly one place.
 *
 * H.264 (Annex-B): NAL type = `byte & 0x1f`; SPS = 7, PPS = 8, IDR = 5.
 * H.265/HEVC (Annex-B): NAL type = `(byte >> 1) & 0x3f`; VPS = 32, SPS = 33, PPS = 34, IDR = 19/20.
 *
 * @module p2p/annexb
 */
import type { VideoCodec } from "../../core/contracts.js";

/** The 4-byte Annex-B start code emitted ahead of a re-serialized NAL. */
const ANNEXB_START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** Iterate the byte offset of every NAL payload (first byte after a 3- or 4-byte start code). */
function* nalStarts(buf: Buffer): Generator<number> {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) yield i + 3;
    else if (i + 4 < buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1)
      yield i + 4;
  }
}

/** Split an Annex-B access unit into its individual NAL bodies (start codes stripped). */
export function splitAnnexbNals(buf: Buffer): Buffer[] {
  const offsets = [...nalStarts(buf)];
  const nals: Buffer[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? startCodeBegin(buf, offsets[k + 1]) : buf.length;
    const nal = buf.subarray(offsets[k], end);
    if (nal.length) nals.push(nal);
  }
  return nals;
}

/**
 * Sniff the codec of an Annex-B access unit by its parameter-set NAL units. Returns `undefined` when
 * the buffer carries no config NAL (a plain delta frame) — the caller should carry the last-known
 * codec rather than guess. Only the first 64 bytes are scanned (config NALs lead the access unit).
 */
export function sniffAnnexbCodec(buf: Buffer): VideoCodec | undefined {
  for (const p of nalStarts(buf)) {
    if (p > 64) break;
    const b = buf[p];
    const hevc = (b >> 1) & 0x3f;
    if (hevc === 32 || hevc === 33 || hevc === 34) return "h265";
    const h264 = b & 0x1f;
    if (h264 === 7 || h264 === 8) return "h264";
  }
  return undefined;
}

/** Parameter sets extracted from a keyframe access unit — the input to an fMP4 init segment. */
export interface ParamSets {
  codec: VideoCodec;
  /** H.264 SPS / H.265 SPS NAL bodies (start-code stripped), in stream order. */
  sps: Buffer[];
  /** H.264 PPS / H.265 PPS NAL bodies. */
  pps: Buffer[];
  /** H.265 VPS NAL bodies (empty for H.264). */
  vps: Buffer[];
}

/**
 * Extract the SPS/PPS (and, for H.265, VPS) parameter-set NAL bodies from a keyframe access unit.
 * Each returned buffer is the raw NAL (start-code stripped), ready to embed in an `avcC` / `hvcC`
 * decoder-config record. Returns `undefined` if no parameter sets are present.
 */
export function extractParamSets(buf: Buffer): ParamSets | undefined {
  const codec = sniffAnnexbCodec(buf);
  if (!codec) return undefined;
  const offsets = [...nalStarts(buf)];
  if (!offsets.length) return undefined;
  const sps: Buffer[] = [];
  const pps: Buffer[] = [];
  const vps: Buffer[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? startCodeBegin(buf, offsets[k + 1]) : buf.length;
    const nal = buf.subarray(start, end);
    if (!nal.length) continue;
    const b = nal[0];
    if (codec === "h265") {
      const t = (b >> 1) & 0x3f;
      if (t === 32) vps.push(nal);
      else if (t === 33) sps.push(nal);
      else if (t === 34) pps.push(nal);
    } else {
      const t = b & 0x1f;
      if (t === 7) sps.push(nal);
      else if (t === 8) pps.push(nal);
    }
  }
  if (!sps.length && !pps.length) return undefined;
  return { codec, sps, pps, vps };
}

/**
 * The parameter sets in force after `buf`, folding what it announces into `current`.
 *
 * A camera commonly announces SPS/PPS ONCE, with the first keyframe of a stream, so anything that will
 * later hand a burst to a decoder has to watch EVERY unit go past — including ones it discards.
 *
 * Folds per kind rather than replacing wholesale, because a decoder retains the last set it was given of
 * EACH kind: a unit announcing an SPS alone re-states that SPS and says nothing about the PPS, so
 * replacing the whole record would drop a PPS that is still in force. A codec change replaces
 * everything — sets from another codec describe a different bitstream.
 *
 * Cheap on the overwhelmingly common case: {@link extractParamSets} answers from a bounded head scan when
 * a unit carries no config NAL, so an ordinary delta frame costs no full-buffer walk.
 */
export function updatedParamSets(buf: Buffer, current: ParamSets | undefined): ParamSets | undefined {
  const announced = extractParamSets(buf);
  if (!announced) return current;
  if (!current || current.codec !== announced.codec) return announced;
  return {
    codec: announced.codec,
    sps: announced.sps.length ? announced.sps : current.sps,
    pps: announced.pps.length ? announced.pps : current.pps,
    vps: announced.vps.length ? announced.vps : current.vps,
  };
}

/**
 * Re-emit `sets` as Annex-B NALs immediately ahead of `annexb`, so a unit whose parameter sets were
 * sent earlier in the stream becomes decodable on its own.
 *
 * A decoder reads parameter sets in stream order, so they are emitted VPS → SPS → PPS: a PPS ahead of
 * the SPS it references is as useless as none at all. Sets carrying no NALs return the input unchanged
 * rather than an equal copy, so a caller that already has a self-contained unit pays nothing.
 *
 * Emitting a duplicate set is harmless — a decoder overwrites the entry with the same id — which is why
 * this needs no knowledge of what the unit already carries; {@link extractParamSets} answers that for a
 * caller that wants to prime only when necessary.
 */
export function prefixParamSets(annexb: Buffer, sets: ParamSets): Buffer {
  const ordered = [...sets.vps, ...sets.sps, ...sets.pps];
  if (!ordered.length) return annexb;
  const prefix: Buffer[] = [];
  for (const nal of ordered) prefix.push(ANNEXB_START, nal);
  return Buffer.concat([...prefix, annexb]);
}

/** Given a NAL payload offset, back up over its (3- or 4-byte) start code to the code's first byte. */
function startCodeBegin(buf: Buffer, payloadOffset: number): number {
  // payloadOffset points just past 00 00 01; a 4-byte code has an extra leading 00.
  const threeByte = payloadOffset - 3;
  if (threeByte >= 1 && buf[threeByte - 1] === 0) return threeByte - 1;
  return threeByte;
}

/**
 * Whether an Annex-B access unit contains an IDR (keyframe) NAL. Cheap scan used to key-align the
 * ring buffer / fragment boundaries when the frame header's keyframe flag isn't authoritative.
 */
export function hasIdr(buf: Buffer, codec: VideoCodec): boolean {
  for (const p of nalStarts(buf)) {
    const b = buf[p];
    if (codec === "h265") {
      const t = (b >> 1) & 0x3f;
      if (t === 19 || t === 20) return true;
    } else if ((b & 0x1f) === 5) return true;
  }
  return false;
}
