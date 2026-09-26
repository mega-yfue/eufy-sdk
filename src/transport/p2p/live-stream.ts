/**
 * Managed realtime live stream over P2P — turns a station's `CMD_VIDEO_FRAME` (1300) /
 * `CMD_AUDIO_FRAME` (1301) frames into a clean, continuous **Annex-B H.264** (+ audio) elementary
 * feed a muxer can ingest.
 *
 * Two video frame variants are handled:
 *  - **Plaintext** (`signCode 0`, e.g. HomeBase-attached cameras): a fixed 22-byte frame header
 *    (`parseVideoFrameHeader`) followed directly by Annex-B NAL units — verified live (960×540,
 *    keyframe = header flag bit0). We strip the 22-byte header.
 *  - **Encrypted** (E2E cameras): the body is AES-256-GCM under a per-stream media key wrapped in a
 *    keyframe ECIES envelope. If an `eccPrivateKey` is supplied we run `VideoFrameDecoder`; otherwise
 *    those frames are skipped (no key → no video).
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
import type { AudioCodec, LiveAudioFrame, LiveVideoFrame, VideoCodec } from "../../core/contracts.js";

const CMD_VIDEO_FRAME = 1300;
const CMD_AUDIO_FRAME = 1301;
const VIDEO_HEADER_LEN = 0x16; // 22-byte CMD_VIDEO_FRAME header before the Annex-B payload
const AUDIO_HEADER_LEN = 0x10; // 16-byte CMD_AUDIO_FRAME header before the audio payload
/** Byte offset of the codec id between the frame-size and frame-number fields. */
const AUDIO_TYPE_OFFSET = 0x05;
const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);

/**
 * Codec ids the station puts at {@link AUDIO_TYPE_OFFSET}, as the v6 app maps them
 * (`AudioReader.AAC_LC = 0`, `G711A = 2`, `AAC_ELD = 7`).
 *
 * The app's `PCM_SILENCE = -1` is absent on purpose: it is not a wire value. The app injects it
 * itself when a stream produces no audio at all, to feed its decoder silence.
 */
const AUDIO_CODECS: Readonly<Record<number, AudioCodec>> = { 0: "aac-lc", 2: "g711a", 7: "aac-eld" };

/**
 * Undecodable video payloads traced per stream. Every frame of a stream whose cipher this build cannot read
 * decodes to nothing, so the first few say everything the rest would repeat once per frame.
 */
const MAX_TRACED_DECODE_FAILURES = 3;

/**
 * How often the media start is re-issued to hold a stream open, when a caller expresses no preference.
 *
 * This is **on by default** because some cameras stop sending without it. With the nudge disabled, a
 * T8170 went quiet 13.6 s into a plain `live()` — no `stop`, no `error`, the feed simply stopped — and
 * ran the full window with it on (185 frames vs 704 over 40 s).
 *
 * Which cameras need it does **not** follow topology or power source, so there is no predicate to gate
 * it on: measured across four cameras, an own-session T8410 and both HomeBase-attached cameras (T8210,
 * T8114) held a 40 s stream up with the nudge disabled, while the own-session T8170 did not. All four
 * are battery. Since a camera that needs it goes silent rather than reporting anything, the default
 * covers the one that fails.
 *
 * What the nudge costs differs by topology, and only one branch is a true keepalive: an own-session
 * camera's `startLiveMedia` tracks that the stream is already started and sends the small ping, while a
 * HomeBase-attached camera has no such state and re-sends the full media start — a genuine restart on
 * that path.
 *
 * That restart is harmless on a station serving ONE camera and harmful on a station serving several: it
 * re-asserts this camera's channel every interval, so two attached streams contend continuously. Measured on
 * a real base as a full start every 3 s from each. So an attached stream stops nudging as soon as the station
 * delivers a frame of its own channel — see the private `settleKeepalive`. The measurement that justifies it
 * is the one above: the attached cameras held their window with the nudge disabled outright.
 */
export const DEFAULT_KEEPALIVE_MS = 3000;

export interface LiveStreamOptions {
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
  /** Camera ECC private key (32B) for E2E/encrypted cameras; omit for plaintext cameras. */
  eccPrivateKey?: Buffer;
  /** Admin account id — required for the level-2 (`signCode 8`) media-start payload selecting a camera. */
  accountId?: string;
  /**
   * Re-send the media start every N ms to hold the stream open. Defaults to
   * {@link DEFAULT_KEEPALIVE_MS}; pass `0` to disable.
   */
  keepAliveMs?: number;
  /**
   * How long an attached stream tolerates silence on its own channel before re-asserting again, in ms.
   *
   * The re-assert is settled by the first own-channel frame, because settling it is what stops two attached
   * streams contending over one session, which serves one camera at a time. Silence for this long says the station
   * is no longer serving this camera, which is the only condition the re-assert was for. Defaults to twice
   * the keepalive interval, so a stream whose media flows never reaches it.
   */
  stallMs?: number;
  /**
   * Whether re-asserting this camera's channel is still wanted, consulted each time the stall window
   * elapses. Absent means always wanted.
   *
   * A re-assert on an attached camera is a full media start, so it takes the station from whichever camera
   * it was serving. Whether that is wanted depends on who is attached to this pull and to its siblings,
   * which this stream cannot see. Its owner can, so it asks rather than assuming.
   *
   * The watch keeps re-arming while this answers false, so a pull that gains a consumer re-asserts at the
   * next window rather than staying silent for the rest of its life.
   */
  reassertWanted?: () => boolean;
  /**
   * Runtime topology fact (from the device record: `parent_sn && parent_sn !== sn`): true = the camera
   * rides a HomeBase's session (start via the level-2 `1003` payload), false = own-session camera
   * (start via the `1700`/`cmd 1000` path, level-2 or level-1 per the session key). NOT a family trait.
   */
  homeBaseAttached?: boolean;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
}

export class LiveStream extends EventEmitter {
  private listening = false;
  private decoder?: VideoFrameDecoder;
  private kaTimer?: ReturnType<typeof setInterval>;
  /** Last codec sniffed off a keyframe; delta frames (no config NAL) inherit it. Default h264. */
  private lastCodec: VideoCodec = "h264";
  /** Rebuilds an access unit the station split across several frames — see {@link AccessUnitAssembler}. */
  private readonly units = new AccessUnitAssembler((drop) => this.reportDroppedUnit(drop));
  /** The channel inbound media must be tagged with, once {@link acceptsMedia} trusts the station's tag. */
  private mediaChannel?: number;
  private tracedFirstVideoCommand = false;
  private tracedFirstVideoUnit = false;
  private tracedFirstKeyframe = false;
  private tracedDecodeFailures = 0;
  private tracedFirstForeignFrame = false;
  private stallTimer?: ReturnType<typeof setTimeout>;
  /**
   * The channel this stream starts, stops, traces under and matches its own abandonment on. An omitted
   * channel resolves to {@link STATION_CHANNEL} — the value the session resolves it to.
   */
  private readonly channel: number;
  private readonly handler = (f: P2PFrame) => this.onFrame(f);
  /** Forwards `liveStartUnacknowledged` only where it carries this stream's own channel. */
  private readonly unackedHandler = (channel: number) => {
    if (channel === this.channel) this.emit("unacknowledged");
  };
  /** End an active pull when its connected peer stops answering, so the next pull can resolve a new path. */
  private readonly pathStaleHandler = () => this.stop();
  private readonly logger: Logger;

  constructor(
    private readonly session: P2PSession,
    private readonly opts: LiveStreamOptions = {},
  ) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.channel = opts.channel ?? STATION_CHANNEL;
    if (opts.homeBaseAttached && opts.channel !== undefined) this.mediaChannel = opts.channel;
    if (opts.eccPrivateKey) this.decoder = new VideoFrameDecoder(opts.eccPrivateKey);
  }

  /** Emit a live trace under its session's handle and the channel this stream pulls. */
  private trace(trace: LiveTrace): void {
    const session = this.session.traceId;
    traceLiveStart(this.logger, trace, session ? `${session}:${this.channel}` : undefined);
  }

  /** Begin streaming: attach the frame listener and tell the station to start realtime media. */
  start(): this {
    if (this.listening) return this;
    this.listening = true;
    this.session.on("data", this.handler);
    this.session.on("liveStartUnacknowledged", this.unackedHandler);
    this.session.on("pathStale", this.pathStaleHandler);
    this.sendStart();
    const keepAliveMs = this.opts.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
    if (keepAliveMs > 0) {
      this.kaTimer = setInterval(() => this.sendStart(), keepAliveMs);
    }
    this.emit("start");
    return this;
  }

  /**
   * Stop re-issuing the media start once this camera's own media has arrived, on an attached camera.
   *
   * The nudge differs by topology and only one branch is a ping: an own-session camera sends a small
   * keepalive, while an attached camera has no such state and re-sends the FULL media start. Over one session,
   * which serves one camera at a time, that restart re-asserts this channel against whatever else is warm on
   * it, so two
   * attached streams restart every interval and contend for the station continuously — measured on a real base
   * as a full start every 3 s from each.
   *
   * A frame of this camera's own channel is the station stating it is serving THIS camera, which is the only
   * thing the restart was trying to bring about. The SDK's own measurement agrees it is then unnecessary: both
   * attached cameras held a 40 s stream with the nudge disabled, while the own-session camera that needs it
   * went quiet at 13.6 s without it — so an own-session stream keeps its ping.
   *
   * The warm-up retry a shared source runs is untouched: it recovers a start that raced the level-2 key, and
   * it stops at the first keyframe by its own rule.
   */
  private settleKeepalive(): void {
    if (!this.opts.homeBaseAttached) return;
    this.armStallWatch();
    if (!this.kaTimer) return;
    clearInterval(this.kaTimer);
    this.kaTimer = undefined;
    this.logger.debug(`[live ch${this.channel}] station is serving this camera — holding off the attached restart`);
  }

  /**
   * Re-arm the attached re-assert if this camera's own media goes silent.
   *
   * Holding the re-assert off is right while the station is serving this camera and wrong the moment it stops:
   * a station that switches to a sibling leaves this stream with no frames, no error and no `stop`, and the
   * warm-up watch that would have caught it was cleared by the first frame. Silence is therefore the condition
   * the re-assert exists for, and the only one — re-arming while media flows is the contention this settle was
   * introduced to remove.
   *
   * Replaced on every own-channel frame, so the window is measured from the last one.
   *
   * Gated on {@link LiveStreamOptions.reassertWanted}: silence with nobody attached is not a condition to
   * act on, because the re-assert would take the station from a camera someone is watching.
   */
  private armStallWatch(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const keepAliveMs = this.opts.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
    if (keepAliveMs <= 0) return;
    const stallMs = this.opts.stallMs ?? keepAliveMs * 2;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (!this.listening || this.kaTimer) return;
      if (this.opts.reassertWanted?.() === false) {
        this.trace({ phase: "channel-silent", silentMs: stallMs, outcome: "declined" });
        this.logger.debug(
          `[live ch${this.channel}] no own media for ${stallMs}ms, and its owner does not want this channel re-asserted — staying quiet`,
        );
        this.armStallWatch();
        return;
      }
      this.trace({ phase: "channel-silent", silentMs: stallMs, outcome: "reasserted" });
      this.logger.debug(`[live ch${this.channel}] no own media for ${stallMs}ms — re-asserting this camera's channel`);
      this.sendStart();
      this.kaTimer = setInterval(() => this.sendStart(), keepAliveMs);
    }, stallMs);
    this.stallTimer.unref?.();
  }

  /**
   * Re-issue the start command (idempotent while listening) — the media-start / keepalive nudge. The
   * shared source calls this to retry a start that raced key negotiation, until frames flow. Safe to
   * call repeatedly: `startLiveMedia` self-selects start vs keepalive per the session state.
   */
  nudge(force?: boolean): void {
    if (this.listening) this.sendStart(force);
  }

  private sendStart(force?: boolean): void {
    try {
      this.session.startLiveMedia(this.opts.channel, this.opts.accountId, this.opts.homeBaseAttached, { force });
    } catch (e) {
      // Non-fatal: the session may be mid-reconnect; the warm-up retry will re-issue the start.
      this.logger.debug(`[live] startLiveMedia deferred (session not ready): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Stop streaming: detach the listener and tell the station to stop. Idempotent. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.session.off("data", this.handler);
    this.session.off("liveStartUnacknowledged", this.unackedHandler);
    this.session.off("pathStale", this.pathStaleHandler);
    if (this.kaTimer) clearInterval(this.kaTimer);
    this.kaTimer = undefined;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    try {
      this.session.stopLiveMedia(this.opts.channel, this.opts.accountId);
    } catch (e) {
      this.logger.debug(`[live] stopLiveMedia ignored: ${e instanceof Error ? e.message : e}`);
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
          this.settleKeepalive();
          this.emit("video", {
            keyframe: unit.keyframe,
            width: unit.width,
            height: unit.height,
            codec: this.lastCodec,
            data: unit.data,
          });
        }
      } else if (f.commandId === CMD_AUDIO_FRAME) {
        const audio = f.data.length > AUDIO_HEADER_LEN ? f.data.subarray(AUDIO_HEADER_LEN) : f.data;
        if (audio.length) {
          const codecId = f.data.length > AUDIO_TYPE_OFFSET ? f.data.readUInt8(AUDIO_TYPE_OFFSET) : undefined;
          const codec = codecId === undefined ? undefined : AUDIO_CODECS[codecId];
          if (!codec) {
            this.logger.debug(`[live] dropping audio frame: unknown codec id ${codecId ?? "missing"}`);
          } else {
            this.emit("audio", { codec, data: audio });
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
   * sees both. The station DOES say which camera a media frame belongs to: measured with two cameras of
   * different geometry streaming at once on one HomeBase, the frame's channel field partitioned them
   * exactly — 43 frames of 1920x1080 on the started channel 0 and 28 of 640x480 on channel 2, video and
   * audio alike — while each handle was delivered both cameras' frames.
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
   * The Annex-B payload of a frame that starts an access unit. The session decodes it when it can (it
   * holds the RSA private key, and handles the plaintext form); the legacy header-strip and the ECIES
   * {@link VideoFrameDecoder} are the fallbacks for an E2E camera.
   */
  private annexbOf(payload: Buffer, signCode: number): Buffer | undefined {
    const annexb = this.session.decodeVideoFrame?.(payload, signCode) ?? this.plaintextAnnexB(payload);
    if (annexb) return annexb;
    const decoded = this.decoder?.decodeFrame(payload)?.h264;
    if (!decoded && this.tracedDecodeFailures++ < MAX_TRACED_DECODE_FAILURES) {
      this.trace({ phase: "video-decode-empty", signCode });
    }
    return decoded;
  }

  /**
   * Report an access unit the transport could not complete.
   *
   * Loud once per stream, then quiet: a station losing datagrams steadily would otherwise flood a host's
   * log with one line per unit, and the first one already says everything the rest repeat. A dropped unit is
   * otherwise silent in both directions: no frame reaches a consumer, and nothing states why.
   */
  private reportDroppedUnit(drop: { carried: number; chunks: number; count: number }): void {
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
  /** This channel's media start was abandoned unacknowledged — see {@link LiveStreamHandle}. */
  on(event: "unacknowledged", listener: () => void): this;
  emit(event: "video", frame: LiveVideoFrame): boolean;
  emit(event: "audio", frame: LiveAudioFrame): boolean;
  emit(event: "start" | "stop" | "unacknowledged"): boolean;
  emit(event: "error", err: Error): boolean;
}
