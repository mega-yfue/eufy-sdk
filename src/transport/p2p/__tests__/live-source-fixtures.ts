import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { H264_CHROMA_PROFILES, splitAnnexbNals } from "../annexb.js";
import type { P2PFrame } from "../p2p-session.js";
import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * Shared fixtures for the shared-live-source specs — a fake upstream stream, the source factory that
 * collects the streams it builds, and Annex-B builders.
 *
 * Every spec around `SharedLiveSource` needs the same three things: something satisfying
 * {@link LiveStreamHandle} that a test can push frames into, a `makeStream` that records what was built
 * (so "one pull for N consumers" and "rebuilt after teardown" are checkable), and a way to synthesize an
 * access unit. Kept here rather than per spec so they cannot drift from each other or from the real
 * shapes — the same reason `ff09-test-fixtures.ts` exists.
 */

/** A fake upstream stream: counts lifecycle calls and lets a spec emit frames on demand. */
export class FakeStream extends EventEmitter implements LiveStreamHandle {
  started = 0;
  stopped = 0;
  nudged = 0;

  start(): this {
    this.started++;
    return this;
  }

  stop(): void {
    this.stopped++;
  }

  /** How many re-issues asked for a real start rather than a keepalive — see `undelivered-restart.spec.ts`. */
  forced = 0;

  nudge(force?: boolean): void {
    this.nudged++;
    if (force) this.forced++;
  }

  /** Emit one video frame to the source. */
  video(frame: LiveVideoFrame): void {
    this.emit("video", frame);
  }

  /** Emit one audio frame to the source. Defaults to a short AAC-LC payload. */
  audio(frame: Partial<LiveAudioFrame> = {}): void {
    this.emit("audio", { codec: "aac-lc", data: Buffer.alloc(8), ...frame });
  }
}

/**
 * A `makeStream` factory plus the array it fills. `streams.length` is the number of PULLS a source has
 * opened, which is what distinguishes sharing one stream from opening several.
 */
export function streamFactory(): { makeStream: () => FakeStream; streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  return {
    streams,
    makeStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };
}

/** The 4-byte Annex-B start code, as a real stream emits it. */
export const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** H.264 NAL bodies by type: SPS 7, PPS 8, IDR 5, non-IDR slice 1. */
export const H264 = {
  sps: [0x67, 0x42, 0x00],
  pps: [0x68, 0xce, 0x01],
  idr: [0x65, 0x88, 0x84],
  delta: [0x41, 0x9a, 0x02],
} as const;

/** H.265 NAL bodies by type: VPS 32, SPS 33, PPS 34, IDR 19. */
export const H265 = {
  vps: [0x40, 0x01, 0x0c],
  sps: [0x42, 0x01, 0x01],
  pps: [0x44, 0x01, 0xc1],
  idr: [0x26, 0x01, 0xaf],
} as const;

/** Build an Annex-B access unit from NAL bodies, each with a start code. */
export function unit(...nals: readonly (readonly number[])[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [START_CODE, Buffer.from(nal)]));
}

/**
 * A big-endian bit writer with the two syntax-element encodings an H.26x parameter set is written in.
 *
 * The geometry specs need parameter sets that are REALLY encoded — a hand-written byte array cannot
 * state "1920 wide with a bottom crop of 4" in a form a reader could disagree with, so it would pin
 * nothing. This writes the same exp-Golomb the standard specifies, and `rbsp()` applies the
 * emulation-prevention escaping a device's own bitstream carries.
 */
class BitWriter {
  private readonly bits: number[] = [];

  /** Write the low `count` bits of `value`, most significant first. */
  u(count: number, value: number): this {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }

  /**
   * Unsigned exp-Golomb: `n` leading zeros, a 1, then `n` bits of `value + 1`.
   *
   * Widened through `BigInt` so a field can be encoded past 32 bits. A 33-bit code word is the case a signed
   * shift silently wraps on, so a writer that could not express one could not test for it either.
   */
  ue(value: number): this {
    const coded = (BigInt(value) + 1n).toString(2);
    for (let i = 0; i < coded.length - 1; i++) this.bits.push(0);
    for (const bit of coded) this.bits.push(bit === "1" ? 1 : 0);
    return this;
  }

  /** Signed exp-Golomb, in the standard's mapping of positives to odd code numbers. */
  se(value: number): this {
    return this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /**
   * The NAL body: `header`, then this bitstream closed by an rbsp_trailing_bits and byte-aligned, with
   * emulation-prevention bytes inserted so the result is a real NAL rather than one a start-code scan
   * could cut in half.
   */
  rbsp(header: readonly number[]): number[] {
    const bits = [...this.bits, 1];
    while (bits.length % 8 !== 0) bits.push(0);
    const body: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
      if (body.length >= 2 && body[body.length - 2] === 0 && body[body.length - 1] === 0 && byte <= 3) {
        body.push(3);
      }
      body.push(byte);
    }
    return [...header, ...body];
  }
}

/**
 * The reader's own list, re-exported so a spec can walk it.
 *
 * Read from the reader rather than restated: a profile the writer omits cannot produce a set that exercises
 * the reader's branch for it, so two lists are only ever evidence while they agree.
 */
export const CHROMA_BRANCH_PROFILES = [...H264_CHROMA_PROFILES];

/** How an H.264 sequence parameter set states the geometry a decoder will produce. */
export interface H264SpsShape {
  widthMbs: number;
  heightMapUnits: number;
  crop?: { left?: number; right?: number; top?: number; bottom?: number };
  /** 100 (High) takes the chroma/bit-depth/scaling-matrix branch; the default 66 (Baseline) does not. */
  profileIdc?: number;
  /** 4:2:0 by default; only read on the High-profile branch, and it scales the crop offsets. */
  chromaFormatIdc?: number;
  /** Cleared for an interlaced set, which doubles the coded height and the vertical crop unit. */
  frameMbsOnly?: boolean;
  /** Present-and-signalled scaling lists, the variable-length branch a reader must skip exactly. */
  scalingMatrix?: boolean;
}

/**
 * An H.264 SPS NAL body (type 7) encoding `shape` — the input to a coded-geometry read.
 *
 * A signalled scaling matrix writes one list per index, each a run of `delta_scale` values whose length is
 * not declared anywhere — which is what a reader has to consume exactly rather than skip by size.
 */
export function h264Sps(shape: H264SpsShape): number[] {
  const profileIdc = shape.profileIdc ?? 66;
  const chromaFormatIdc = shape.chromaFormatIdc ?? 1;
  const frameMbsOnly = shape.frameMbsOnly ?? true;
  const crop = shape.crop;
  const w = new BitWriter();
  w.u(8, profileIdc).u(8, 0).u(8, 40).ue(0);
  if (H264_CHROMA_PROFILES.has(profileIdc)) {
    w.ue(chromaFormatIdc);
    if (chromaFormatIdc === 3) w.u(1, 0);
    w.ue(0)
      .ue(0)
      .u(1, 0)
      .u(1, shape.scalingMatrix ? 1 : 0);
    if (shape.scalingMatrix) {
      for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
        w.u(1, 1);
        for (let c = 0; c < (i < 6 ? 16 : 64); c++) w.se(c === 0 ? 1 : 0);
      }
    }
  }
  w.ue(0).ue(0).ue(0).ue(1).u(1, 0);
  w.ue(shape.widthMbs - 1)
    .ue(shape.heightMapUnits - 1)
    .u(1, frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u(1, 0);
  w.u(1, 1).u(1, crop ? 1 : 0);
  if (crop)
    w.ue(crop.left ?? 0)
      .ue(crop.right ?? 0)
      .ue(crop.top ?? 0)
      .ue(crop.bottom ?? 0);
  w.u(1, 0);
  return w.rbsp([0x67]);
}

/** How an H.265 sequence parameter set states the geometry a decoder will produce. */
export interface H265SpsShape {
  widthLuma: number;
  heightLuma: number;
  window?: { left?: number; right?: number; top?: number; bottom?: number };
  /** 4:2:0 by default; it scales the conformance-window offsets. */
  chromaFormatIdc?: number;
  /** Sub-layers beyond the base one, which add the per-layer profile/level records to skip. */
  maxSubLayersMinus1?: number;
}

/**
 * An H.265 SPS NAL body (type 33) encoding `shape` — the input to a coded-geometry read.
 *
 * `profile_tier_level` is written as the base layer's fixed 96 bits followed by whatever the sub-layers
 * signal, which is the length a reader has to skip exactly to reach the geometry behind it.
 */
export function h265Sps(shape: H265SpsShape): number[] {
  const chromaFormatIdc = shape.chromaFormatIdc ?? 1;
  const layers = shape.maxSubLayersMinus1 ?? 0;
  const w = new BitWriter();
  w.u(4, 0).u(3, layers).u(1, 1);
  w.u(2, 0).u(1, 0).u(5, 1).u(32, 0x60000000).u(1, 1).u(1, 0).u(1, 0).u(1, 1);
  w.u(22, 0).u(22, 0).u(8, 120);
  for (let i = 0; i < layers; i++) w.u(1, 1).u(1, 1);
  if (layers > 0) for (let i = layers; i < 8; i++) w.u(2, 0);
  for (let i = 0; i < layers; i++) {
    w.u(2, 0).u(1, 0).u(5, 1).u(32, 0x60000000).u(1, 1).u(1, 0).u(1, 0).u(1, 1).u(22, 0).u(22, 0);
    w.u(8, 120);
  }
  w.ue(0).ue(chromaFormatIdc);
  if (chromaFormatIdc === 3) w.u(1, 0);
  w.ue(shape.widthLuma)
    .ue(shape.heightLuma)
    .u(1, shape.window ? 1 : 0);
  const win = shape.window;
  if (win)
    w.ue(win.left ?? 0)
      .ue(win.right ?? 0)
      .ue(win.top ?? 0)
      .ue(win.bottom ?? 0);
  w.ue(0).ue(0);
  return w.rbsp([0x42, 0x01]);
}

/** A video frame carrying `data`. Defaults to a 1920x1080 H.264 keyframe. */
export function videoFrame(data: Buffer, over: Partial<LiveVideoFrame> = {}): LiveVideoFrame {
  return { keyframe: true, width: 1920, height: 1080, codec: "h264", data, ...over };
}

/** The 22-byte `CMD_VIDEO_FRAME` header a station puts before the Annex-B payload. */
const VIDEO_HEADER_LEN = 0x16;
/** The 16-byte `CMD_AUDIO_FRAME` header a station puts before the audio payload. */
const AUDIO_HEADER_LEN = 0x10;

/**
 * A plaintext `CMD_VIDEO_FRAME` (1300) as it arrives off the wire: the 22-byte header — declared payload
 * length at 0x00, keyframe flag bit0 at 0x04, geometry at 0x0a/0x0c — then one Annex-B access unit.
 *
 * Wire-level, unlike {@link videoFrame}, which is the decoded frame a consumer is handed.
 */
export function p2pVideoFrame(opts: {
  nal: Buffer;
  keyframe?: boolean;
  /** The raw flag byte at 0x04, overriding `keyframe`. */
  flags?: number;
  width?: number;
  height?: number;
  channel?: number;
}): Partial<P2PFrame> {
  const header = Buffer.alloc(VIDEO_HEADER_LEN);
  header.writeUInt8(opts.flags ?? (opts.keyframe ? 0x01 : 0x00), 0x04);
  header.writeInt16LE(opts.width ?? 960, 0x0a);
  header.writeInt16LE(opts.height ?? 540, 0x0c);
  const body = Buffer.concat([START_CODE, opts.nal]);
  header.writeUInt32LE(body.length, 0x00);
  return { commandId: 1300, channel: opts.channel ?? 0, signCode: 0, data: Buffer.concat([header, body]) };
}

/** A `CMD_AUDIO_FRAME` (1301): the 16-byte header carrying the codec id at 0x05, then the payload. */
export function p2pAudioFrame(audioType: number, payload: Buffer, channel = 0): Partial<P2PFrame> {
  const header = Buffer.alloc(AUDIO_HEADER_LEN);
  header.writeUInt32LE(payload.length, 0x00);
  header.writeUInt8(audioType, 0x05);
  return { commandId: 1301, channel, signCode: 0, data: Buffer.concat([header, payload]) };
}

/**
 * A fake {@link P2PSession} for the {@link LiveStream} specs: records the channel of every start and stop,
 * and extracts a plaintext frame body exactly as the real session does.
 */
export class FakeP2PSession extends EventEmitter {
  /** The channel each `startLiveMedia` named, in order. */
  readonly starts: (number | undefined)[] = [];
  /** The channel each `stopLiveMedia` named, in order. */
  readonly stops: (number | undefined)[] = [];

  get started(): number {
    return this.starts.length;
  }

  get stopped(): number {
    return this.stops.length;
  }

  /** The channel the most recent start named. */
  get startChannel(): number | undefined {
    return this.starts.at(-1);
  }

  /**
   * Mirrors the real session's extraction: the body is the `payloadLength` the header declares, and an
   * encrypted frame needs the RSA key this fake has no equivalent of, so it answers undefined there.
   */
  decodeVideoFrame(data: Buffer, signCode: number): Buffer | undefined {
    if (data.length < VIDEO_HEADER_LEN) return undefined;
    const declared = data.readUInt32LE(0);
    if (signCode > 0 && declared >= 128) return undefined;
    return data.subarray(VIDEO_HEADER_LEN, VIDEO_HEADER_LEN + declared);
  }

  startLiveMedia(channel?: number): void {
    this.starts.push(channel);
  }

  stopLiveMedia(channel?: number): void {
    this.stops.push(channel);
  }

  push(frame: Partial<P2PFrame>): void {
    this.emit("data", frame as P2PFrame);
  }
}

/**
 * The NAL type byte of every NAL in a buffer, in order — the shape assertion for "what did the decoder
 * receive". Reads the stream through {@link splitAnnexbNals}, the module under test's own scan, rather
 * than a second hand-rolled start-code walk per spec.
 */
export function nalTypes(buf: Buffer): number[] {
  return splitAnnexbNals(buf).map((nal) => nal[0]);
}

/** What a faked ffmpeg run should do with the bytes it was given. */
export type FfmpegOutcome = { stdout: Buffer } | { exitCode: number; stderr: string } | { spawnError: string };

/**
 * A baseline JPEG carrying nothing but the geometry the encoder wrote into it: SOI, then a complete
 * SOF0 whose height/width fields are the ones a reader has to answer with, then EOI. Enough for the
 * snapshot path, which validates the SOI and reads the frame header.
 */
export function jpegOf(width: number, height: number): Buffer {
  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]),
    Buffer.alloc(9), // three component descriptors — unread, but the declared segment length covers them
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof0, Buffer.from([0xff, 0xd9])]);
}

/**
 * A `vi.mock` factory body for `../../ffmpeg.js` that records each spawn's argv and stdin, and answers
 * with whatever `outcome()` says at the time it is called.
 *
 * The media specs all need the same thing — the exact bytes handed to ffmpeg, because asserting only the
 * returned image passes even with the code under test removed. `outcome` is a getter rather than a value
 * so a spec can change the answer per case without re-mocking the module.
 */
export function fakeFfmpeg(outcome: () => FfmpegOutcome): {
  spawnFfmpeg: (args: string[]) => unknown;
  runs: { args: string[]; stdin: Buffer }[];
} {
  const runs: { args: string[]; stdin: Buffer }[] = [];
  return {
    runs,
    spawnFfmpeg: (args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      const chunks: Buffer[] = [];
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk as Buffer);
          cb();
        },
        final(cb) {
          runs.push({ args, stdin: Buffer.concat(chunks) });
          const answer = outcome();
          queueMicrotask(() => {
            if ("spawnError" in answer) return child.emit("error", new Error(answer.spawnError));
            if ("stdout" in answer) child.stdout.emit("data", answer.stdout);
            else child.stderr.emit("data", Buffer.from(answer.stderr));
            child.emit("close", "stdout" in answer ? 0 : answer.exitCode);
          });
          cb();
        },
      });
      return child;
    },
  };
}
