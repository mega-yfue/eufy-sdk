/**
 * Native fragmented-MP4 (fMP4 / CMAF) muxer — pure Node, ZERO dependency (only `node:buffer`).
 *
 * Produces a continuous, dependency-free CMAF stream: an `ftyp`+`moov` init segment followed by
 * `moof`+`mdat` media fragments.
 *
 * Feed it {@link LiveVideoFrame}s (Annex-B) and optional station-declared AAC frames. It emits the
 * `init` segment once the video parameter sets and requested audio configuration are known, then a
 * media fragment at the first keyframe after `fragmentSeconds` has elapsed. Annex-B start codes are
 * rewritten to AVCC length prefixes. AAC-LC's ADTS transport headers are removed from `mdat` samples; AAC-ELD
 * arrives as raw access units and is stored as is.
 *
 * H.265 note: the `hvcC` NAL arrays (VPS/SPS/PPS) are exact; the profile/tier/level header fields use
 * safe Main-profile defaults (decoders re-read the SPS from the arrays).
 *
 * The declared picture size comes from the parameter sets rather than from a {@link LiveVideoFrame}
 * header, because it is the size a decoder will produce. One init segment describes the whole recording,
 * so a source that reconfigures mid-session keeps the geometry it opened with in `tkhd` and the sample
 * entry; the samples carry their own parameter sets, which is how a decoder follows the change.
 *
 * @module p2p/fmp4
 */
import { codedGeometry, extractParamSets, splitAnnexbNals, type ParamSets } from "./annexb.js";
import { AAC_SAMPLE_RATE, AAC_SAMPLES_PER_FRAME, parseAdtsHeader } from "./adts.js";
import type { AudioCodec, LiveAudioFrame, LiveVideoFrame, MediaFragment, VideoCodec } from "../../core/contracts.js";

const TIMESCALE = 90000; // 90kHz — the conventional media timescale
const DEFAULT_FRAME_TICKS = TIMESCALE / 15; // fallback per-sample duration (~15fps) before we measure

export interface Fmp4Options {
  /** Minimum fragment length; a new fragment opens on the first keyframe past this (default 2s). */
  fragmentSeconds?: number;
  /** Assumed fps for the first sample's duration before inter-frame timing is known (default 15). */
  fps?: number;
  /** Include an AAC track when the source declares AAC-LC or AAC-ELD before the first media fragment. */
  audio?: boolean;
}

/** Type strings for the H.264 / H.265 sample entry + decoder-config boxes. */
const CODEC_BOXES: Record<Exclude<VideoCodec, "av1">, { sample: string; config: string }> = {
  h264: { sample: "avc1", config: "avcC" },
  h265: { sample: "hvc1", config: "hvcC" },
};

interface Sample {
  data: Buffer; // AVCC length-prefixed
  duration: number; // in TIMESCALE ticks
  keyframe: boolean;
}

type AacCodec = Exclude<AudioCodec, "g711a" | "opus">;
const AAC_ELD_SAMPLES_PER_FRAME = 480;
const ADTS_FREQUENCY_INDEX_16K = 8;
const ADTS_CHANNELS_MONO = 1;

export class Fmp4Muxer {
  private params?: ParamSets;
  private codec: Exclude<VideoCodec, "av1"> = "h264";
  private width = 0;
  private height = 0;
  private initSent = false;
  private seq = 1;
  private baseDecodeTime = 0; // running decode time (ticks) for tfdt
  private fragTicks = 0; // ticks accumulated in the open fragment
  private samples: Sample[] = [];
  /** Ticks from the first video sample's start to the newest sample's end, at its provisional duration. */
  private videoTicks = 0;
  private readonly audioRequested: boolean;
  private audioCodec?: AacCodec;
  /** Decoder config of an AAC-ELD track, taken from its frames; absent for AAC-LC, whose `esds` config is fixed. */
  private audioConfig?: Buffer;
  private audioDisabled = false;
  private audioSamples: Sample[] = [];
  private audioBaseDecodeTime = 0;
  private firstVideoTimestampMs?: number;
  private firstAudioTimestampMs?: number;
  private lastAudioTimestampMs?: number;
  private timelineOriginMs?: number;
  private timelineAligned = false;
  private readonly fragmentTicks: number;
  private readonly firstDuration: number;

  constructor(opts: Fmp4Options = {}) {
    this.fragmentTicks = (opts.fragmentSeconds ?? 2) * TIMESCALE;
    this.firstDuration = opts.fps ? TIMESCALE / opts.fps : DEFAULT_FRAME_TICKS;
    this.audioRequested = opts.audio ?? false;
  }

  /**
   * Push one access unit. Returns any completed segments: the `init` on the first keyframe, and/or a
   * media fragment when this frame closed the open one. Returns `undefined` if nothing is emitted yet
   * (e.g. delta frames before the first keyframe).
   *
   * A sample lasts until the next frame's `timestampMs`, measured from the first keyframe's, so the video
   * timeline follows the arrival clock; a frame that shares the previous one's timestamp leaves that
   * sample one tick long, and the next frame's duration absorbs the difference.
   */
  push(frame: LiveVideoFrame, timestampMs = now()): MediaFragment | undefined {
    if (frame.codec === "av1") throw new Error("fMP4 muxer: AV1 is not supported");
    let init: Buffer | undefined;

    if (!this.params) {
      if (!frame.keyframe) return undefined; // wait for the first keyframe (carries the param sets)
      const ps = extractParamSets(frame.data);
      if (!ps || ps.codec === "av1") return undefined;
      this.params = ps;
      this.codec = ps.codec;
      const declared = codedGeometry(ps);
      this.width = declared?.width ?? frame.width;
      this.height = declared?.height ?? frame.height;
      this.firstVideoTimestampMs = timestampMs;
    }

    if (this.firstVideoTimestampMs !== undefined && this.samples.length) {
      const previous = this.samples[this.samples.length - 1];
      const arrival = Math.round((timestampMs - this.firstVideoTimestampMs) * (TIMESCALE / 1000));
      const duration = Math.max(1, arrival - (this.videoTicks - previous.duration));
      this.fragTicks += duration - previous.duration;
      this.videoTicks += duration - previous.duration;
      previous.duration = duration;
    }

    let fragment: Buffer | undefined;
    // Boundary: a keyframe that opens a fragment past the minimum length closes the current one first.
    if (frame.keyframe && this.samples.length > 0 && this.fragTicks >= this.fragmentTicks) {
      if (!this.initSent) {
        this.audioDisabled = !this.audioCodec;
        init = this.buildInit();
        this.initSent = true;
      }
      fragment = this.buildFragment();
    }

    this.samples.push({ data: annexbToAvcc(frame.data), duration: this.firstDuration, keyframe: frame.keyframe });
    this.fragTicks += this.firstDuration;
    this.videoTicks += this.firstDuration;

    if (!this.initSent && (!this.audioRequested || this.audioCodec || this.audioDisabled)) {
      init = this.buildInit();
      this.initSent = true;
    }

    if (init || fragment) {
      return { init, data: fragment ?? Buffer.alloc(0), keyframe: !!fragment && this.samplesStartKeyframe() };
    }
    return undefined;
  }

  /**
   * Add one station-declared AAC access unit to the audio track: an ADTS frame for AAC-LC, a raw access unit
   * described by its frame's config for AAC-ELD. G.711 and Opus remain available via `live()`.
   */
  pushAudio(frame: LiveAudioFrame, timestampMs = now()): MediaFragment | undefined {
    if (!this.audioRequested || this.audioDisabled) return undefined;
    if (frame.codec === "g711a" || frame.codec === "opus") {
      if (this.initSent) return undefined;
      this.audioDisabled = true;
      if (!this.params) return undefined;
      this.initSent = true;
      return { init: this.buildInit(), data: Buffer.alloc(0), keyframe: false };
    }
    if (this.audioCodec && this.audioCodec !== frame.codec) {
      return this.disableAudio();
    }
    let sample: Buffer;
    if (frame.codec === "aac-eld") {
      this.audioConfig = frame.config;
      sample = frame.data;
    } else {
      const header = parseAdtsHeader(frame.data);
      if (!header || header.frameLength > frame.data.length) {
        throw new Error(`fMP4 muxer: ${frame.codec} frame is not a complete ADTS access unit`);
      }
      if (header.frequencyIndex !== ADTS_FREQUENCY_INDEX_16K || header.channels !== ADTS_CHANNELS_MONO) {
        return this.disableAudio();
      }
      sample = frame.data.subarray(header.headerLength, header.frameLength);
    }
    this.audioCodec = frame.codec;
    this.firstAudioTimestampMs ??= timestampMs;
    const measured =
      this.lastAudioTimestampMs === undefined
        ? 0
        : Math.round((timestampMs - this.lastAudioTimestampMs) * (AAC_SAMPLE_RATE / 1000));
    this.lastAudioTimestampMs = timestampMs;
    if (this.timelineAligned && this.audioSamples.length === 0 && this.timelineOriginMs !== undefined) {
      this.audioBaseDecodeTime = Math.round((timestampMs - this.timelineOriginMs) * (AAC_SAMPLE_RATE / 1000));
    } else if (measured > 0 && this.audioSamples.length) {
      this.audioSamples[this.audioSamples.length - 1].duration = measured;
    }
    this.audioSamples.push({
      data: sample,
      duration: frame.codec === "aac-eld" ? AAC_ELD_SAMPLES_PER_FRAME : AAC_SAMPLES_PER_FRAME,
      keyframe: true,
    });
    if (!this.params || this.initSent) return undefined;
    this.initSent = true;
    return { init: this.buildInit(), data: Buffer.alloc(0), keyframe: false };
  }

  /** Permanently omit incompatible audio while allowing the video recording to continue. */
  private disableAudio(): MediaFragment | undefined {
    this.audioDisabled = true;
    this.audioSamples = [];
    if (!this.params || this.initSent) return undefined;
    this.initSent = true;
    return { init: this.buildInit(), data: Buffer.alloc(0), keyframe: false };
  }

  /** Flush the open fragment (call at end-of-stream). Returns the final fragment, or undefined. */
  flush(): MediaFragment | undefined {
    if (!this.samples.length) return undefined;
    let init: Buffer | undefined;
    if (!this.initSent) {
      this.audioDisabled = !this.audioCodec;
      init = this.buildInit();
      this.initSent = true;
    }
    const data = this.buildFragment();
    return { init, data, keyframe: true };
  }

  private samplesStartKeyframe(): boolean {
    return this.samples[0]?.keyframe ?? false;
  }

  // ── Box builders ────────────────────────────────────────────────────────────────────────────

  private buildInit(): Buffer {
    this.alignTimeline();
    return Buffer.concat([this.ftyp(), this.moov()]);
  }

  private alignTimeline(): void {
    if (this.timelineAligned || this.firstVideoTimestampMs === undefined) return;
    const origin = Math.min(this.firstVideoTimestampMs, this.firstAudioTimestampMs ?? this.firstVideoTimestampMs);
    this.timelineOriginMs = origin;
    this.baseDecodeTime = Math.round((this.firstVideoTimestampMs - origin) * (TIMESCALE / 1000));
    this.audioBaseDecodeTime = Math.round(((this.firstAudioTimestampMs ?? origin) - origin) * (AAC_SAMPLE_RATE / 1000));
    this.timelineAligned = true;
  }

  private buildFragment(): Buffer {
    const samples = this.samples;
    const audioSamples = this.audioSamples;
    this.samples = [];
    this.audioSamples = [];
    this.fragTicks = 0;
    const seq = this.seq++;
    const moof = this.moof(seq, samples, audioSamples);
    const videoData = Buffer.concat(samples.map((s) => s.data));
    const audioData = Buffer.concat(audioSamples.map((s) => s.data));
    const mdat = box("mdat", videoData, audioData);
    const dataOffset = moof.length + 8;
    patchTrunDataOffsets(moof, audioSamples.length ? [dataOffset, dataOffset + videoData.length] : [dataOffset]);
    this.baseDecodeTime += samples.reduce((n, s) => n + s.duration, 0);
    this.audioBaseDecodeTime += audioSamples.reduce((n, s) => n + s.duration, 0);
    return Buffer.concat([moof, mdat]);
  }

  private ftyp(): Buffer {
    return box("ftyp", Buffer.concat([str("iso5"), u32(0), str("iso5"), str("iso6"), str("mp41"), str("cmfc")]));
  }

  private moov(): Buffer {
    return box("moov", this.mvhd(), this.trak(), ...(this.hasAudioTrack() ? [this.audioTrak()] : []), this.mvex());
  }

  private mvhd(): Buffer {
    const b = Buffer.alloc(100);
    b.writeUInt32BE(0, 0); // version/flags
    b.writeUInt32BE(0, 4); // creation
    b.writeUInt32BE(0, 8); // modification
    b.writeUInt32BE(TIMESCALE, 12);
    b.writeUInt32BE(0, 16); // duration (0 = fragmented)
    b.writeUInt32BE(0x00010000, 20); // rate 1.0
    b.writeUInt16BE(0x0100, 24); // volume 1.0
    writeMatrix(b, 32);
    b.writeUInt32BE(this.hasAudioTrack() ? 3 : 2, 96);
    return box("mvhd", b);
  }

  private trak(): Buffer {
    return box("trak", this.tkhd(), this.mdia());
  }

  private tkhd(): Buffer {
    const b = Buffer.alloc(84);
    b.writeUInt32BE(0x00000007, 0); // flags: enabled | in movie | in preview
    b.writeUInt32BE(1, 12); // track id
    b.writeUInt32BE(0, 20); // duration
    writeMatrix(b, 40);
    b.writeUInt32BE(this.width << 16, 76); // width 16.16
    b.writeUInt32BE(this.height << 16, 80); // height 16.16
    return box("tkhd", b);
  }

  private mdia(): Buffer {
    const mdhd = Buffer.alloc(32);
    mdhd.writeUInt32BE(0, 0);
    mdhd.writeUInt32BE(TIMESCALE, 12);
    mdhd.writeUInt32BE(0, 16); // duration
    mdhd.writeUInt16BE(0x55c4, 24); // language "und"
    const hdlr = box(
      "hdlr",
      Buffer.concat([u32(0), u32(0), str("vide"), u32(0), u32(0), u32(0), Buffer.from("VideoHandler\0")]),
    );
    return box("mdia", box("mdhd", mdhd), hdlr, this.minf());
  }

  private minf(): Buffer {
    const vmhd = box("vmhd", Buffer.concat([u32(1), Buffer.alloc(8)])); // flags=1
    const dref = box("dref", Buffer.concat([u32(0), u32(1), box("url ", u32(1))]));
    const dinf = box("dinf", dref);
    return box("minf", vmhd, dinf, this.stbl());
  }

  private stbl(): Buffer {
    return box(
      "stbl",
      box("stsd", Buffer.concat([u32(0), u32(1), this.sampleEntry()])),
      box("stts", Buffer.concat([u32(0), u32(0)])),
      box("stsc", Buffer.concat([u32(0), u32(0)])),
      box("stsz", Buffer.concat([u32(0), u32(0), u32(0)])),
      box("stco", Buffer.concat([u32(0), u32(0)])),
    );
  }

  private sampleEntry(): Buffer {
    const { sample, config } = CODEC_BOXES[this.codec];
    const head = Buffer.alloc(78);
    head.writeUInt16BE(1, 6); // data_reference_index
    head.writeUInt16BE(this.width, 24);
    head.writeUInt16BE(this.height, 26);
    head.writeUInt32BE(0x00480000, 28); // horizresolution 72dpi
    head.writeUInt32BE(0x00480000, 32); // vertresolution 72dpi
    head.writeUInt16BE(1, 40); // frame_count
    head.writeUInt16BE(0x18, 74); // depth
    head.writeInt16BE(-1, 76); // pre_defined
    const cfg = box(config, this.codec === "h264" ? this.avcC() : this.hvcC());
    return box(sample, Buffer.concat([head, cfg]));
  }

  private avcC(): Buffer {
    const ps = this.params!;
    const sps = ps.sps[0] ?? Buffer.alloc(4);
    const parts: Buffer[] = [
      Buffer.from([1, sps[1] ?? 0x42, sps[2] ?? 0x00, sps[3] ?? 0x1e, 0xff, 0xe0 | ps.sps.length]),
    ];
    for (const s of ps.sps) parts.push(u16(s.length), s);
    parts.push(Buffer.from([ps.pps.length]));
    for (const p of ps.pps) parts.push(u16(p.length), p);
    return Buffer.concat(parts);
  }

  private hvcC(): Buffer {
    const ps = this.params!;
    const header = Buffer.from([
      1, // configurationVersion
      0x01, // general_profile_space(0)+tier(0)+profile_idc(1=Main)
      0x60,
      0x00,
      0x00,
      0x00, // general_profile_compatibility_flags
      0x90,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // general_constraint_indicator_flags (48 bits)
      0x5a, // general_level_idc (level 3.0 placeholder)
      0xf0,
      0x00, // min_spatial_segmentation_idc
      0xfc, // parallelismType
      0xfd, // chromaFormat 4:2:0
      0xf8, // bitDepthLumaMinus8 = 0
      0xf8, // bitDepthChromaMinus8 = 0
      0x00,
      0x00, // avgFrameRate
      0x0f, // constantFrameRate(0)+numTemporalLayers(1)+temporalIdNested(0)+lengthSizeMinusOne(3)
    ]);
    const arrays: Buffer[] = [];
    const push = (nalType: number, nals: Buffer[]) => {
      if (!nals.length) return;
      const parts: Buffer[] = [Buffer.from([0x80 | nalType]), u16(nals.length)]; // array_completeness=1
      for (const n of nals) parts.push(u16(n.length), n);
      arrays.push(Buffer.concat(parts));
    };
    push(32, ps.vps);
    push(33, ps.sps);
    push(34, ps.pps);
    return Buffer.concat([header, Buffer.from([arrays.length]), ...arrays]);
  }

  private mvex(): Buffer {
    return box("mvex", this.trex(1), ...(this.hasAudioTrack() ? [this.trex(2)] : []));
  }

  private trex(trackId: number): Buffer {
    const trex = Buffer.alloc(24);
    trex.writeUInt32BE(trackId, 4);
    trex.writeUInt32BE(1, 8);
    return box("trex", trex);
  }

  private moof(seq: number, samples: Sample[], audioSamples: Sample[]): Buffer {
    const mfhd = box("mfhd", Buffer.concat([u32(0), u32(seq)]));
    return box(
      "moof",
      mfhd,
      this.traf(1, this.baseDecodeTime, samples),
      ...(this.hasAudioTrack() && audioSamples.length ? [this.traf(2, this.audioBaseDecodeTime, audioSamples)] : []),
    );
  }

  private traf(trackId: number, baseDecodeTime: number, samples: Sample[]): Buffer {
    // tfhd: default-base-is-moof (0x020000) + default_sample_flags present (0x20)? We set per-sample
    // flags in trun instead, so tfhd carries only track id + default-base-is-moof.
    const tfhd = box("tfhd", Buffer.concat([u32(0x020000), u32(trackId)]));
    const tfdt = box("tfdt", Buffer.concat([u32(0x01000000), u64(baseDecodeTime)]));
    return box("traf", tfhd, tfdt, this.trun(samples));
  }

  /**
   * One track fragment run, declaring exactly the per-sample fields its body carries.
   *
   * `tr_flags` is data-offset-present (`0x000001`) | sample-duration-present (`0x000100`) |
   * sample-size-present (`0x000200`) | sample-flags-present (`0x000400`). A parser sizes the sample
   * table from these flags alone, so every extra flag adds a 4-byte field per sample that it then reads
   * past the end of the box. A flag set wider than the body makes the run overrun its own size and the
   * whole fragment undemuxable, which is why the value and the loop below must be read together.
   *
   * Composition-time offsets are deliberately absent: the source delivers access units in decode order
   * with no reordering, so each sample's composition time equals its decode time.
   *
   * `data_offset` is written as zero and patched with the sample data's position once the enclosing
   * `moof` is assembled and its length is known.
   */
  private trun(samples: Sample[]): Buffer {
    const flags = 0x000701;
    const parts: Buffer[] = [u32(flags), u32(samples.length), u32(0)];
    for (const s of samples) {
      parts.push(u32(s.duration), u32(s.data.length), u32(s.keyframe ? 0x02000000 : 0x01010000));
    }
    return box("trun", Buffer.concat(parts));
  }

  private hasAudioTrack(): boolean {
    return !!this.audioCodec && !this.audioDisabled;
  }

  private audioTrak(): Buffer {
    return box("trak", this.audioTkhd(), this.audioMdia());
  }

  private audioTkhd(): Buffer {
    const b = Buffer.alloc(84);
    b.writeUInt32BE(0x00000007, 0);
    b.writeUInt32BE(2, 12);
    b.writeUInt16BE(0x0100, 36);
    writeMatrix(b, 40);
    return box("tkhd", b);
  }

  private audioMdia(): Buffer {
    const mdhd = Buffer.alloc(32);
    mdhd.writeUInt32BE(AAC_SAMPLE_RATE, 12);
    mdhd.writeUInt16BE(0x55c4, 24);
    const hdlr = box(
      "hdlr",
      Buffer.concat([u32(0), u32(0), str("soun"), u32(0), u32(0), u32(0), Buffer.from("SoundHandler\0")]),
    );
    return box("mdia", box("mdhd", mdhd), hdlr, this.audioMinf());
  }

  private audioMinf(): Buffer {
    const smhd = box("smhd", Buffer.alloc(8));
    const dref = box("dref", Buffer.concat([u32(0), u32(1), box("url ", u32(1))]));
    return box("minf", smhd, box("dinf", dref), this.audioStbl());
  }

  private audioStbl(): Buffer {
    return box(
      "stbl",
      box("stsd", Buffer.concat([u32(0), u32(1), this.audioSampleEntry()])),
      box("stts", Buffer.concat([u32(0), u32(0)])),
      box("stsc", Buffer.concat([u32(0), u32(0)])),
      box("stsz", Buffer.concat([u32(0), u32(0), u32(0)])),
      box("stco", Buffer.concat([u32(0), u32(0)])),
    );
  }

  private audioSampleEntry(): Buffer {
    const head = Buffer.alloc(28);
    head.writeUInt16BE(1, 6);
    head.writeUInt16BE(1, 16);
    head.writeUInt16BE(16, 18);
    head.writeUInt32BE(AAC_SAMPLE_RATE << 16, 24);
    return box("mp4a", head, this.esds());
  }

  private esds(): Buffer {
    const config = this.audioConfig ?? Buffer.from([0x14, 0x08]);
    const specific = descriptor(0x05, config);
    const decoder = descriptor(
      0x04,
      Buffer.concat([Buffer.from([0x40, 0x15, 0, 0, 0]), u32(64000), u32(32000), specific]),
    );
    const sl = descriptor(0x06, Buffer.from([0x02]));
    return box("esds", u32(0), descriptor(0x03, Buffer.concat([u16(2), Buffer.from([0]), decoder, sl])));
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

/** Wrap a payload in an MP4 box: [u32 size][4-char type][payload…]. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, "ascii");
  body.copy(b, 8);
  return b;
}

function str(s: string): Buffer {
  return Buffer.from(s, "ascii");
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/** Unity 3x3 display matrix at offset `o`. */
function writeMatrix(b: Buffer, o: number): void {
  b.writeUInt32BE(0x00010000, o); // a
  b.writeUInt32BE(0x00010000, o + 16); // d
  b.writeUInt32BE(0x40000000, o + 32); // w
}

/**
 * Rewrite Annex-B start codes to AVCC 4-byte length prefixes, RETAINING every NAL including the
 * parameter sets.
 *
 * Keeping them is what makes a recording survive a reconfiguration the init segment cannot describe: a
 * camera changes coded geometry within one session, the init segment and its out-of-band `avcC` are
 * written once, and every later keyframe re-states its own sets inside the sample. Stripping them to the
 * declared config alone would leave every sample after the first change undecodable.
 */
function annexbToAvcc(annexb: Buffer): Buffer {
  const out: Buffer[] = [];
  for (const nal of splitAnnexbNals(annexb)) {
    out.push(u32(nal.length), nal);
  }
  return Buffer.concat(out);
}

/** Walk each traf in a freshly built moof and set its trun data_offset field. */
function patchTrunDataOffsets(moof: Buffer, offsets: number[]): void {
  let offsetIndex = 0;
  for (const traf of childBoxes(moof, 0)) {
    if (traf.type !== "traf") continue;
    for (const child of childBoxes(moof, traf.start)) {
      if (child.type !== "trun") continue;
      const offset = offsets[offsetIndex++];
      if (offset === undefined) throw new Error("fMP4 muxer: missing trun data offset");
      moof.writeInt32BE(offset, child.start + 16);
    }
  }
  if (offsetIndex !== offsets.length) throw new Error("fMP4 muxer: trun count does not match data offsets");
}

/** Return the structurally valid direct children of one MP4 container box. */
function childBoxes(buf: Buffer, parentStart: number): { type: string; start: number }[] {
  const parentEnd = parentStart + buf.readUInt32BE(parentStart);
  const children: { type: string; start: number }[] = [];
  for (let start = parentStart + 8; start + 8 <= parentEnd;) {
    const size = buf.readUInt32BE(start);
    if (size < 8 || start + size > parentEnd) throw new Error("fMP4 muxer: invalid box structure");
    children.push({ type: buf.toString("ascii", start + 4, start + 8), start });
    start += size;
  }
  return children;
}

function descriptor(tag: number, payload: Buffer): Buffer {
  if (payload.length >= 128) throw new Error("fMP4 muxer: MPEG-4 descriptor is too large");
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}
