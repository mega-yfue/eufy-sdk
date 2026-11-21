/**
 * Managed realtime live stream over P2P — turns a station's `CMD_VIDEO_FRAME` (1300) /
 * `CMD_AUDIO_FRAME` (1301) frames into a clean, continuous **Annex-B H.264** (+ audio) elementary
 * feed a muxer can ingest.
 *
 * Two video frame variants are handled:
 *  - **Plaintext** (`signCode 0`, e.g. HomeBase-attached cameras): a fixed 22-byte frame header
 *    (`parseVideoFrameHeader`) followed directly by Annex-B NAL units (keyframe = header
 *    flag bit0). We strip the 22-byte header.
 *  - **Encrypted keyframes**: either the AES-256-GCM body under a media key wrapped in an ECIES envelope
 *    for the P-256 key the start offered ({@link VideoFrameDecoder}, the session's
 *    {@link P2PSession.mediaEccPrivateKey} unless `eccPrivateKey` names another), or an AES-ECB head under a
 *    media key wrapped for the session's RSA key ({@link P2PSession.decodeVideoFrame}).
 *
 * Emits: `video` ({@link LiveVideoFrame} — Annex-B), `audio` ({@link LiveAudioFrame}), `start`, `stop`,
 * `error`.
 */
import { EventEmitter } from "node:events";
import { STATION_CHANNEL, type P2PSession, type P2PFrame } from "./p2p-session.js";
import { AccessUnitAssembler, VideoFrameDecoder } from "./video.js";
import { sniffAnnexbCodec } from "./annexb.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { traceLiveStart, type LiveTrace } from "./live-trace.js";
import type { LiveAudioFrame, LiveFrames, LiveVideoFrame, VideoCodec } from "../../core/contracts.js";
import {
  AUDIO_CODECS,
  AUDIO_HEADER_LEN,
  AUDIO_TYPE_OFFSET,
  CMD_AUDIO_FRAME,
  isSealedAudio,
  openSealedAudio,
} from "./audio-frame.js";

const CMD_VIDEO_FRAME = 1300;
const VIDEO_HEADER_LEN = 0x16; // 22-byte CMD_VIDEO_FRAME header before the Annex-B payload
const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);

/**
 * AudioSpecificConfig (ISO/IEC 14496-3) of a station's `aac-eld` audio, which the station does not send: an
 * `aac-eld` frame carries one raw access unit after its 16-byte header, with no transport framing.
 *
 * Fields: audio object type 39 (ER AAC-ELD), 16 kHz, mono, 480-sample frames, no LD-SBR. These are the bytes the
 * v6 app's native AAC decoder (`AudioFDKDecode`) configures libfdk with for raw ELD access units.
 */
const AAC_ELD_AUDIO_SPECIFIC_CONFIG = Buffer.from("f8f03000", "hex");

/**
 * Undecodable video payloads traced per stream. Every frame of a stream whose cipher this build cannot read
 * decodes to nothing, so the first few say everything the rest would repeat once per frame.
 */
const MAX_TRACED_DECODE_FAILURES = 3;

export interface LiveStreamOptions {
  /** The frames the app starts and stops this device's live view with, and the ability its key form reads. */
  frames: LiveFrames;
  /**
   * Camera channel to START (the device's `device_channel`) — sent in CMD_START_REALTIME_MEDIA to
   * select which camera on a multi-camera HomeBase streams. Defaults to the station channel.
   *
   * On a HomeBase-attached camera it is ALSO what inbound media is matched against, so one camera's stream
   * never carries another camera's frames: a station fanning several cameras out over one session tags every
   * media frame with the camera it belongs to. A frame tagged for a channel a sibling started is never taken,
   * however long the station keeps serving that sibling instead of this one.
   */
  channel?: number;
  /**
   * P-256 private key (32B) whose public point the camera wraps each keyframe's media key for. Defaults to the
   * session's `P2PSession.mediaEccPrivateKey`, once its start offered that pair.
   */
  eccPrivateKey?: Buffer;
  /** The admin user id the start carries (`$userId`). */
  accountId?: string;
  /**
   * Runtime topology fact (from the device record: `parent_sn && parent_sn !== sn`): true = the camera rides a
   * HomeBase's session, which tags its media with the camera's channel, and this stream takes only its own.
   */
  homeBaseAttached?: boolean;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
}

export class LiveStream extends EventEmitter {
  private listening = false;
  private decoder?: VideoFrameDecoder;
  /** Last codec sniffed off a keyframe; delta frames (no config NAL) inherit it. Default h264. */
  private lastCodec: VideoCodec = "h264";
  /** Rebuilds an access unit the station split across several frames — see {@link AccessUnitAssembler}. */
  private readonly units = new AccessUnitAssembler((drop) => this.reportDroppedUnit(drop));
  /** Whether a missing video datagram or incomplete unit invalidated the current reference chain. */
  private awaitingKeyframeAfterGap = false;
  private readonly videoGapHandler = () => {
    this.units.discard();
    this.awaitingKeyframeAfterGap = true;
  };
  /** The channel inbound media must be tagged with, once {@link acceptsMedia} trusts the station's tag. */
  private mediaChannel?: number;
  private tracedFirstVideoCommand = false;
  private tracedFirstVideoUnit = false;
  private tracedFirstKeyframe = false;
  private tracedDecodeFailures = 0;
  private tracedFirstForeignFrame = false;
  /** The channel this stream starts, stops and traces under; an omitted one is {@link STATION_CHANNEL}. */
  private readonly channel: number;
  private readonly handler = (f: P2PFrame) => this.onFrame(f);
  private readonly logger: Logger;

  constructor(
    private readonly session: P2PSession,
    private readonly opts: LiveStreamOptions,
  ) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.channel = opts.channel ?? STATION_CHANNEL;
    if (opts.homeBaseAttached && opts.channel !== undefined) this.mediaChannel = opts.channel;
  }

  /** Emit a live trace under its session's handle and the channel this stream pulls. */
  private trace(trace: LiveTrace): void {
    const session = this.session.traceId;
    traceLiveStart(this.logger, trace, session ? `${session}:${this.channel}` : undefined);
  }

  /**
   * Begin streaming: attach the frame listener and send the start, then read keyframes with the P-256 key it
   * offered, if it offered one.
   */
  start(): this {
    if (this.listening) return this;
    this.listening = true;
    this.session.on("data", this.handler);
    this.session.on("videoGap", this.videoGapHandler);
    this.sendStart();
    const eccPrivateKey = this.opts.eccPrivateKey ?? this.session.mediaEccPrivateKey;
    if (eccPrivateKey) this.decoder = new VideoFrameDecoder(eccPrivateKey);
    this.emit("start");
    return this;
  }

  /** Send the start again while listening: the shared source's warm-up retry. */
  nudge(): void {
    if (this.listening) this.sendStart();
  }

  private sendStart(): void {
    const { frames, accountId } = this.opts;
    try {
      this.session.sendFrame(frames.start, this.channel, accountId, frames.ability);
    } catch (e) {
      // Non-fatal: the session may be mid-reconnect; the warm-up retry will re-issue the start.
      this.logger.debug(`[live] start deferred (session not ready): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Stop streaming: detach the listener and tell the station to stop. Idempotent. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.session.off("data", this.handler);
    this.session.off("videoGap", this.videoGapHandler);
    this.awaitingKeyframeAfterGap = false;
    try {
      this.session.sendFrame(this.opts.frames.stop, this.channel, this.opts.accountId);
    } catch (e) {
      this.logger.debug(`[live] stop ignored: ${e instanceof Error ? e.message : e}`);
    }
    this.emit("stop");
  }

  /** Extract the Annex-B payload from a plaintext 1300 frame (fixed 22-byte header), or undefined. */
  private plaintextAnnexB(d: Buffer): Buffer | undefined {
    if (d.length > VIDEO_HEADER_LEN) {
      const body = d.subarray(VIDEO_HEADER_LEN);
      // Plaintext frames begin with a NAL start code immediately after the 22-byte header.
      if (body.length >= 4 && (body.subarray(0, 4).equals(SC4) || body.subarray(0, 3).equals(SC3))) {
        return body;
      }
    }
    return undefined;
  }

  /** Emit one accepted media frame; an audio frame with no bytes past its header emits nothing. */
  private onFrame(f: P2PFrame): void {
    const accepted = this.acceptsMedia(f);
    if (f.commandId === CMD_VIDEO_FRAME && !this.tracedFirstVideoCommand) {
      this.tracedFirstVideoCommand = true;
      this.trace({ phase: "first-video-command", signCode: f.signCode, accepted });
    }
    if (!accepted) return;
    try {
      if (f.commandId === CMD_VIDEO_FRAME) {
        for (const unit of this.units.push(f.data, (payload) => this.annexbOf(payload, f.signCode))) {
          if (this.awaitingKeyframeAfterGap) {
            if (!unit.keyframe) continue;
            this.awaitingKeyframeAfterGap = false;
          }
          if (!this.tracedFirstVideoUnit) {
            this.tracedFirstVideoUnit = true;
            this.trace({ phase: "first-video-unit", keyframe: unit.keyframe });
          }
          if (unit.keyframe && !this.tracedFirstKeyframe) {
            this.tracedFirstKeyframe = true;
            this.trace({ phase: "first-keyframe" });
          }
          // Sniff the codec only on a keyframe (it carries the parameter sets); delta frames have no
          // config NAL, so they inherit the last-known codec.
          if (unit.keyframe) this.lastCodec = sniffAnnexbCodec(unit.data) ?? this.lastCodec;
          this.emit("video", {
            sourceTimestamp: unit.sourceTimestamp,
            keyframe: unit.keyframe,
            width: unit.width,
            height: unit.height,
            codec: this.lastCodec,
            data: unit.data,
          });
        }
      } else if (f.commandId === CMD_AUDIO_FRAME) {
        const audio = this.audioPayload(f.data);
        if (audio?.length) {
          const codecId = f.data.length > AUDIO_TYPE_OFFSET ? f.data.readUInt8(AUDIO_TYPE_OFFSET) : undefined;
          const codec = codecId === undefined ? undefined : AUDIO_CODECS[codecId];
          if (!codec) {
            this.logger.debug(`[live] dropping audio frame: unknown codec id ${codecId ?? "missing"}`);
          } else {
            this.emit(
              "audio",
              codec === "aac-eld"
                ? { codec, data: audio, config: AAC_ELD_AUDIO_SPECIFIC_CONFIG }
                : { codec, data: audio },
            );
          }
        }
      }
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Whether this stream may take `frame` — the demultiplexer for a station that serves several cameras.
   *
   * Every stream over a station's session reads the same inbound feed, so with two cameras warm each stream
   * sees both. The station DOES say which camera a media frame belongs to: the frame's channel field
   * partitions them exactly, video and audio alike, while each handle is delivered both cameras' frames.
   *
   * The tag is only meaningful where a station fans out to several cameras. A camera that owns its session
   * numbers its stream for itself: one was started on channel 0 and tagged its frames channel 1, so
   * matching there would drop the whole stream. Hence only an attached camera filters.
   *
   * The match is UNCONDITIONAL, however long a station serves another camera instead of this one.
   *
   * One session serving one camera at a time hands a newly opened camera nothing but its sibling's frames until
   * it switches, so "no media of my own yet, plenty for someone else" is what an ordinary handover looks like
   * and does not distinguish a station that tags differently from one that is simply busy.
   *
   * A stream receiving none of its own media reaches the warm-up deadline and raises a typed start failure
   * naming the stage it got to. Delivering another camera's picture raises nothing.
   */
  private acceptsMedia(frame: P2PFrame): boolean {
    if (this.mediaChannel === undefined || (frame.commandId !== CMD_VIDEO_FRAME && frame.commandId !== CMD_AUDIO_FRAME))
      return true;
    if (frame.channel === this.mediaChannel) return true;
    if (!this.tracedFirstForeignFrame) {
      this.tracedFirstForeignFrame = true;
      this.trace({
        phase: "first-foreign-media-command",
        media: frame.commandId === CMD_VIDEO_FRAME ? "video" : "audio",
      });
    }
    return false;
  }

  /**
   * The Annex-B payload of a frame that starts an access unit. The authenticated ECIES/GCM
   * {@link VideoFrameDecoder} goes first: its HMAC and GCM checks fail closed on a frame not sealed for its
   * key. The session's RSA path cannot: on Node ≥ 24.5, PKCS#1 v1.5 decryption of a key not wrapped for it
   * returns pseudo-random bytes instead of throwing (implicit rejection), which would decode an ECC
   * keyframe into noise. The session's decode, which also passes plaintext frames, and the header strip
   * follow.
   */
  private annexbOf(payload: Buffer, signCode: number): Buffer | undefined {
    const decoded = this.decoder?.decodeFrame(payload)?.h264;
    if (decoded) return decoded;
    const annexb = this.session.decodeVideoFrame?.(payload, signCode) ?? this.plaintextAnnexB(payload);
    if (!annexb && this.tracedDecodeFailures++ < MAX_TRACED_DECODE_FAILURES) {
      this.trace({ phase: "video-decode-empty", signCode });
    }
    return annexb;
  }

  /**
   * The payload of an audio frame. On a stream with an ECIES decoder, a sealed frame ({@link isSealedAudio}) is
   * opened under the media key of the latest keyframe, and answers `undefined` when it does not open or arrives
   * before any keyframe gave a media key, since its bytes are ciphertext. Every other frame is the bytes after
   * its header, empty for a frame that carries only its header.
   */
  private audioPayload(frame: Buffer): Buffer | undefined {
    if (!this.decoder || !isSealedAudio(frame)) {
      return frame.subarray(AUDIO_HEADER_LEN);
    }
    const mediaKey = this.decoder.currentMediaKey;
    return mediaKey ? openSealedAudio(frame, mediaKey) : undefined;
  }

  /**
   * Report an access unit the transport could not complete.
   *
   * Loud once per stream, then quiet: a station losing datagrams steadily would otherwise flood a host's
   * log with one line per unit, and the first one already says everything the rest repeat. A dropped unit is
   * otherwise silent in both directions: no frame reaches a consumer, and nothing states why.
   */
  private reportDroppedUnit(drop: { carried: number; chunks: number; count: number }): void {
    this.awaitingKeyframeAfterGap = true;
    const message = `[live] dropped an incomplete access unit (${drop.carried} bytes in ${drop.chunks} frame(s), tail never arrived, ${drop.count} so far)`;
    if (drop.count === 1) this.logger.warn(message);
    else this.logger.debug(message);
  }
}

export interface LiveStream {
  on(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  on(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  on(event: "start" | "stop", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  // Structural conformance to LiveStreamHandle; the upstream stream never emits "budget" itself
  // (the shared source raises it on the consumer side), but the type must be assignable.
  on(event: "budget", listener: (notice: import("../../core/contracts.js").StreamBudgetNotice) => void): this;
  emit(event: "video", frame: LiveVideoFrame): boolean;
  emit(event: "audio", frame: LiveAudioFrame): boolean;
  emit(event: "start" | "stop"): boolean;
  emit(event: "error", err: Error): boolean;
}
