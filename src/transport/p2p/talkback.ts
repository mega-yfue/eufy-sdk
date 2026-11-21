/**
 * Managed talkback session over P2P — the send-side twin of `live-stream.ts`. Takes audio from a host in
 * the codec the camera's speaker plays (AAC-LC ADTS, or raw AAC-ELD access units), recovers frame
 * boundaries, and paces the frames onto the wire at their own playback rate, bracketed by the device's
 * start/stop control frames.
 *
 * Pacing is the reason this exists rather than a bare `sendAudioFrame` loop. Each AAC-LC frame at
 * 16 kHz is 1024 samples — exactly 64 ms of audio — and each AAC-ELD access unit is 512 samples, 32 ms.
 * The device plays what arrives when it arrives.
 * A host piping a file would otherwise deliver a minute of audio in a few hundred milliseconds and
 * lose all but the tail. A live source paces itself and simply keeps the queue near-empty.
 *
 * The pacer is **wall-clock**, not tick-counted: a timer callback that runs late releases every frame
 * it owes rather than one. Releasing one per tick loses each late tick permanently, which measures as a
 * feed slower than realtime on a loaded event loop — and this feature attaches to a shared live source,
 * so muxing video on the same loop is the normal case, not the edge case.
 *
 * @module p2p/talkback
 */
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type {
  AacEncoder,
  SessionFrame,
  StreamBudgetNotice,
  TalkbackCodec,
  TalkbackHandle,
} from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import {
  AAC_FRAME_MS,
  AdtsFrameReader,
  describeAdts,
  isSupportedAdts,
  MAX_AUDIO_FRAME_BYTES,
  parseAdtsHeader,
} from "./adts.js";

/**
 * The subset of the session this needs — send the start/stop frame, push one audio frame, and report a frame the
 * device never acknowledged. The audio channel is ordered, so an abandoned frame is a permanent hole
 * that stalls everything behind it; the listener pair lets that surface instead of going silent.
 */
export interface TalkbackSink {
  sendFrame(frame: SessionFrame, channel: number): void;
  sendAudioFrame(channel: number, frame: Buffer): void;
  on?(event: "audioGap", listener: (seq: number) => void): unknown;
  off?(event: "audioGap", listener: (seq: number) => void): unknown;
}

export interface TalkbackOptions {
  channel: number;
  /** The frames the app opens and closes this device's talkback with (`start_intercom`, `stop_intercom`). */
  start: SessionFrame;
  stop: SessionFrame;
  /** Converts PCM to ADTS when the caller feeds PCM instead of AAC. */
  encoder?: AacEncoder;
  /**
   * Releases the media session this talkback is riding inside. Called once on {@link Talkback.stop}.
   * The device only plays host audio while its media session is open (the identical frames are
   * silent without one), so the session is held for the talkback's whole lifetime.
   */
  releaseMedia?(): void;
  /**
   * Frames the pacing queue holds before `writable()` applies backpressure. The default is two
   * seconds of audio — enough to ride out scheduler jitter without letting a file source buffer the
   * whole clip in memory.
   */
  highWaterFrames?: number;
  /**
   * Stop by itself after this long with nothing written. A handle holds a consumer on the shared live
   * source and a repeating timer, and neither is reaped by anything but an explicit
   * {@link Talkback.stop} — a battery camera's power budget does not apply to a wired one. A caller
   * that drops the handle would otherwise pin a P2P pull for the life of the process. Pass `0` to
   * disable. Default {@link DEFAULT_IDLE_TIMEOUT_MS}.
   */
  idleTimeoutMs?: number;
  logger?: Logger;
}

/**
 * Audio the pacing queue holds before a writable applies backpressure: two seconds, enough to ride out scheduler
 * jitter without letting a file source buffer a whole clip in memory.
 */
const HIGH_WATER_MS = 2000;

/**
 * Playback duration of one `aac-eld` talkback access unit: ER AAC-ELD with LD-SBR (`f8f0212c00bc00`), 512 samples at
 * 16 kHz.
 */
const TALKBACK_ELD_FRAME_MS = 32;

/**
 * How long a talkback waits for audio before stopping itself. Comfortably longer than any gap a live
 * or press-to-talk source produces mid-sentence, and short enough that an abandoned handle does not
 * outlive the conversation it belonged to.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * A talkback session bound to one camera channel. Opens the device's path on construction via
 * {@link start}, then drains queued frames on a tick of one frame's duration until {@link stop}.
 */
export class Talkback extends EventEmitter implements TalkbackHandle {
  private readonly reader = new AdtsFrameReader();
  private readonly queue: Buffer[] = [];
  private readonly logger: Logger;
  /** Playback duration of one queued frame, the pacer's step: 64 ms for `aac-lc`, 32 ms for `aac-eld`. */
  private frameMs = AAC_FRAME_MS;
  private readonly idleTimeoutMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private stopped = false;
  private ended = false;
  private announcedFinish = false;
  private onRoom?: () => void;
  /** When the next frame is due, in `Date.now()` terms — the pacer's wall-clock cursor. */
  private nextDueAt = 0;
  private lastWriteAt = 0;
  /**
   * Serializes the encoder path. `write()` must not block a synchronous caller, so an encode runs
   * detached — but two detached encodes can settle out of order, and both push into a STATEFUL
   * {@link AdtsFrameReader}. Chaining keeps the frames in the order they were written and keeps the
   * end-of-input flush behind the last pending encode.
   */
  private chain: Promise<void> = Promise.resolve();
  private readonly onAudioGap = (seq: number): void => {
    this.fail(
      new Error(
        `talkback: the device never acknowledged audio frame ${seq}; the audio channel is ordered, ` +
          `so playback may have stalled from here on`,
      ),
    );
  };

  constructor(
    private readonly sink: TalkbackSink,
    private readonly opts: TalkbackOptions,
  ) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Frames the pacing queue holds before a writable applies backpressure: {@link HIGH_WATER_MS} of this codec. */
  private get highWater(): number {
    return this.opts.highWaterFrames ?? Math.ceil(HIGH_WATER_MS / this.frameMs);
  }

  /** The codec this talkback sends, set by {@link start}. */
  codec: TalkbackCodec = "aac-lc";

  /** Frames still queued for the wire. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Open the device's talkback path and begin the pacing tick. Throws when the start frame could not be sent.
   *
   * `codec` is the codec the camera's speaker plays; it fixes the input this talkback accepts and the pacing step.
   */
  start(codec: TalkbackCodec): this {
    if (this.started) return this;
    if (codec === "aac-eld" && this.opts.encoder) {
      throw new Error("talkback: this camera plays aac-eld; an AacEncoder produces aac-lc");
    }
    this.codec = codec;
    this.frameMs = codec === "aac-eld" ? TALKBACK_ELD_FRAME_MS : AAC_FRAME_MS;
    this.sink.sendFrame(this.opts.start, this.opts.channel);
    this.started = true;
    const now = Date.now();
    this.nextDueAt = now + this.frameMs;
    this.lastWriteAt = now;
    this.timer = setInterval(() => this.tick(), this.frameMs);
    this.timer.unref?.();
    this.sink.on?.("audioGap", this.onAudioGap);
    return this;
  }

  /**
   * Queue audio in the codec this talkback sends. For `aac-lc` the bytes are ADTS, or PCM when an encoder was
   * supplied, read as a stream, so a chunk carrying part of a frame is held until the rest arrives. For `aac-eld`
   * each call is one whole access unit; a unit over the device's length limit is dropped with an `error`.
   *
   * Audio written after {@link end} is dropped with an `error` rather than queued: `finished` has
   * either already fired or is owed on the frames written before it, so a late chunk would either play
   * after the clip was declared complete or never be announced at all.
   */
  write(chunk: Buffer): void {
    if (this.stopped) return;
    if (this.ended) {
      this.fail(new Error("talkback: write after end — the input was already declared finished"));
      return;
    }
    this.lastWriteAt = Date.now();
    if (this.codec === "aac-eld") {
      if (chunk.length > MAX_AUDIO_FRAME_BYTES) {
        this.fail(
          new Error(`talkback: frame of ${chunk.length} B exceeds the device's ${MAX_AUDIO_FRAME_BYTES} B limit`),
        );
        return;
      }
      if (chunk.length) this.queue.push(chunk);
      return;
    }
    if (!this.opts.encoder) {
      this.enqueue(this.reader.push(chunk));
      return;
    }
    this.chain = this.chain.then(() => this.encodeAndEnqueue(chunk));
  }

  /**
   * Declare the input finished. Nothing more may be written; once the queue drains, `finished` fires.
   * `writable()` calls this from its `final`, so a piped source needs no explicit call.
   */
  end(): void {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.chain = this.chain.then(() => this.flushEncoder()).then(() => this.announceFinishIfDone());
  }

  /**
   * Run PCM through the caller's encoder. Kept off {@link write}'s return path so a synchronous
   * caller isn't forced to await; an encoder failure surfaces as an `error` event.
   */
  private async encodeAndEnqueue(pcm: Buffer): Promise<void> {
    if (this.stopped) return;
    try {
      const frames = await this.opts.encoder!.encode(pcm);
      for (const f of frames) this.enqueue(this.reader.push(f));
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Admit whole frames to the pacing queue, rejecting any whose parameters the device cannot play or
   * whose length it refuses. A rejected frame is dropped with an `error` rather than silently
   * swallowed: passing it through would produce audible garbage.
   */
  private enqueue(frames: Buffer[]): void {
    for (const frame of frames) {
      const h = parseAdtsHeader(frame);
      if (!h) continue;
      if (!isSupportedAdts(h)) {
        this.fail(new Error(`talkback: audio must be AAC-LC 16000 Hz mono, got ${describeAdts(h)}`));
        continue;
      }
      if (frame.length > MAX_AUDIO_FRAME_BYTES) {
        this.fail(
          new Error(`talkback: frame of ${frame.length} B exceeds the device's ${MAX_AUDIO_FRAME_BYTES} B limit`),
        );
        continue;
      }
      this.queue.push(frame);
    }
  }

  /**
   * Release every frame the wall clock says is due, then report the clip finished once the input has
   * ended and nothing is left. Pacing is unconditional: it tracks the audio's own playback rate and
   * never waits on the device's acknowledgements, because the device is playing a continuous stream
   * and a slowed feed starves it.
   *
   * The cursor advances by one frame's duration per frame sent rather than being reset to `now`, so a
   * timer that fires late sends what it owes and the feed stays at realtime. When the queue runs dry
   * the cursor is re-based one frame ahead of `now`: the silence was the source's, and owing frames for
   * it would burst them the moment audio resumes.
   */
  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.queue.length) {
      this.nextDueAt = now + this.frameMs;
      this.idleCheck(now);
      this.announceFinishIfDone();
      return;
    }
    while (this.queue.length && now >= this.nextDueAt) {
      const frame = this.queue.shift()!;
      this.nextDueAt += this.frameMs;
      try {
        this.sink.sendAudioFrame(this.opts.channel, frame);
      } catch (e) {
        this.fail(e);
        return;
      }
    }
    if (this.queue.length < this.highWater) this.releaseWriter();
    this.announceFinishIfDone();
  }

  /**
   * Stop a talkback nothing is feeding any more. Only armed while the queue is empty — a source that
   * is merely slow keeps frames in flight, and a live source pushes on its own cadence. It covers a
   * finished clip too: a caller that listens for `finished` but never stops still holds the shared
   * consumer, which is the same leak as dropping the handle outright.
   */
  private idleCheck(now: number): void {
    if (!this.idleTimeoutMs) return;
    if (now - this.lastWriteAt < this.idleTimeoutMs) return;
    this.logger.debug?.(`talkback: nothing written for ${this.idleTimeoutMs} ms — closing the path`);
    void this.stop().catch(() => {});
  }

  /** Emit `finished` once, when the input has ended and every queued frame has reached the wire. */
  private announceFinishIfDone(): void {
    if (this.announcedFinish || !this.ended || this.queue.length) return;
    this.announcedFinish = true;
    this.emit("finished");
  }

  /** Hand a withheld `writable()` callback back, so the source resumes. */
  private releaseWriter(): void {
    if (!this.onRoom) return;
    const resume = this.onRoom;
    this.onRoom = undefined;
    resume();
  }

  /**
   * Report a failure without being able to kill the host. `error` on an `EventEmitter` THROWS when
   * nothing is listening, and every call site here is either inside the pacing interval or on a
   * detached encode — where that throw aborts the process rather than reaching a caller. The common
   * case is audio that simply isn't 16 kHz mono, which must not take the process down.
   */
  private fail(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (this.listenerCount("error")) this.emit("error", err);
    else this.logger.warn?.(err.message);
  }

  /**
   * A Writable over {@link write} that withholds its callback while the queue is at the high-water
   * mark — which is what turns `pipe()` from a file into playback at speed rather than a memory spike.
   * For `aac-eld` it is object-mode: each write is one access unit.
   */
  writable(): Writable {
    return new Writable({
      objectMode: this.codec === "aac-eld",
      write: (chunk: Buffer, _enc, cb) => {
        this.write(chunk);
        if (this.queue.length < this.highWater) cb();
        else this.onRoom = cb;
      },
      final: (cb) => {
        this.end();
        cb();
      },
    });
  }

  /** Drain an encoder's partial trailing block, so the last syllable is not lost. */
  private async flushEncoder(): Promise<void> {
    if (this.stopped || !this.opts.encoder?.flush) return;
    try {
      this.enqueue(await this.opts.encoder.flush());
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Close the path: stop pacing, drop anything still queued, and send the stop control frame. Queued
   * audio is deliberately discarded — `finished` is the event that says everything queued has already
   * reached the wire.
   *
   * Everything after the guard runs under `try`/`finally` because the teardown calls back into
   * caller-supplied code (the encoder's `close`, a withheld stream callback, the session's stop frame),
   * any of which can throw. `releaseMedia` must run regardless: the idempotence guard has already
   * latched by then, so a skipped release can never be retried, and the shared consumer would stay
   * attached — holding the P2P pull open until the process exits.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.sink.off?.("audioGap", this.onAudioGap);
      const dropped = this.queue.length;
      this.queue.length = 0;
      this.releaseWriter();
      if (dropped) this.logger.debug?.(`talkback: dropped ${dropped} queued frame(s) on stop`);
      this.opts.encoder?.close?.();
      if (this.started) this.sink.sendFrame(this.opts.stop, this.opts.channel);
    } finally {
      this.opts.releaseMedia?.();
      this.emit("stop");
    }
  }
}

export interface Talkback {
  on(event: "finished" | "stop", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
  emit(event: "finished" | "stop"): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: "budget", notice: StreamBudgetNotice): boolean;
}
