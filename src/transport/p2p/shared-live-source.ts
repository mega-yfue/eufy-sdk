/**
 * Shared live source — one underlying {@link LiveStream} (one PPCS pull) fanned out to N consumers.
 *
 * The first consumer warms one stream, every later consumer shares it, and the pull is torn down only
 * after the last consumer leaves plus a linger grace.
 *
 * State machine (per `${parentSn}:${channel}`):
 *
 *   idle ──attach──▶ warming ──first keyframe──▶ live
 *     ▲                                            │
 *     │                                     last detach
 *  linger timer fires (teardown)                   ▼
 *   stopped ◀──────────────────────────────── lingering ──attach (cancels teardown, reuses warm)──▶ live
 *
 * `stopped` is torn-down-but-rebuildable: a later `attach()` rebuilds via the `makeStream` factory.
 * `dispose()` is permanent (session close / router shutdown).
 *
 * Per consumer: a bounded queue with **drop-to-keyframe** backpressure — a slow consumer that
 * overflows drops its backlog and resyncs at the next IDR, never stalling upstream or its peers.
 * On `attach()` the last cached keyframe is replayed (keyframe-prime) so a new consumer decodes
 * immediately instead of waiting a full GOP.
 *
 * Transport-only: speaks {@link LiveStreamHandle} + {@link LiveVideoFrame}, never a capability.
 *
 * @module p2p/shared-live-source
 */
import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../../core/logger.js";
import { Timer } from "../../core/util.js";
import { updatedParamSets, type ParamSets } from "./annexb.js";
import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame, StreamBudgetNotice } from "../../core/contracts.js";

/** Lifecycle state of a {@link SharedLiveSource}. */
export type SharedLiveState = "idle" | "warming" | "live" | "lingering" | "stopped";

export interface SharedLiveSourceOptions {
  /**
   * Factory that builds a fresh, **un-started** {@link LiveStreamHandle}. Called on every (re)warm so
   * a reconnect rebuilds the stream rather than reusing a dead one. `SharedLiveSource` calls
   * `.start()` itself.
   */
  makeStream: () => LiveStreamHandle;
  /** No-consumer grace before teardown (default 8000ms). Distinct from the stream's keepalive. */
  lingerMs?: number;
  /** Per-consumer bounded queue depth; overflow → drop-to-keyframe (default 900 ≈ 30s @ 30fps). */
  maxQueue?: number;
  /** Rolling prebuffer window in seconds, 0 = off (default 0). */
  preBufferSeconds?: number;
  /** Advisory HomeBase concurrent-stream cap, surfaced for observability only. */
  concurrentCap?: number;
  /**
   * Warm-up start retry interval (default 2000ms). After warming, if no frame has arrived, the source
   * re-issues the start ({@link LiveStreamHandle.nudge}) every interval — self-healing a start that
   * raced the level-2 key negotiation, independent of any caller keepalive.
   */
  warmRetryMs?: number;
  /**
   * Warm-up deadline (default 20000ms). If no frame arrives within it, the source emits `error` to
   * consumers ("failed to start") and tears down, so `live()` never hangs silently on a dead start.
   */
  warmTimeoutMs?: number;
  /**
   * Power source, a runtime device fact (`"battery"` incl. solar, or `"wired"`) — NOT a device family
   * trait; the model derives it from the resolved capability set and passes it through. `"wired"`
   * (default) streams unbounded; `"battery"` bounds a continuous stream to {@link batteryBudgetMs}.
   */
  powered?: "wired" | "battery";
  /** Battery/solar continuous-stream budget before the `budget` notice fires (default 45000ms). */
  batteryBudgetMs?: number;
  /** Grace after the budget notice to call `extend()` before the source auto-stops (default 10000ms). */
  budgetGraceMs?: number;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
  /** Prefix label for log lines (e.g. the `parentSn:channel` key), for multi-source disambiguation. */
  label?: string;
  /**
   * Called when the FIRST consumer attaches (0→1). The router uses this to register the source as a
   * "user" of the station's P2P session (so an active stream cancels the session's idle-detach). Paired
   * with {@link onIdle}. Optional — omit if the caller doesn't manage session lifecycle.
   */
  onActive?: () => void;
  /** Called when the LAST consumer detaches (1→0) — the router releases its session user. See {@link onActive}. */
  onIdle?: () => void;
}

/**
 * A single consumer of a {@link SharedLiveSource}. Structurally a {@link LiveStreamHandle} (so
 * `live()` can hand it back directly), plus backpressure controls used by the readable egress.
 */
export interface Consumer extends LiveStreamHandle {
  /** Detach a previously registered listener (mirrors {@link LiveStreamHandle.on}). */
  off(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  off(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  off(event: "start" | "stop", listener: () => void): this;
  off(event: "error", listener: (err: Error) => void): this;
  /** Subscribe to frames carrying the source-captured arrival time used by the prebuffer. */
  onMedia(listener: (item: TimedMediaFrame) => void): this;
  /** True once the source has replayed a cached keyframe to this consumer (no GOP wait on join). */
  readonly primed: boolean;
  /** True while this consumer is dropping frames after an overflow, waiting for the next IDR. */
  readonly awaitingKeyframe: boolean;
  /** Hold delivery — frames queue (bounded) until {@link resume}; overflow drops to the next IDR. */
  pause(): void;
  /** Resume delivery and drain the queued backlog. */
  resume(): void;
  /** Leave the source (refcount--). Idempotent. `stop()` is an alias (LiveStreamHandle). */
  detach(): void;
}

/** One media frame retained with its transport-arrival time for prebuffer continuity. */
export type TimedMediaFrame =
  | { kind: "video"; frame: LiveVideoFrame; timestampMs: number }
  | { kind: "audio"; frame: LiveAudioFrame; timestampMs: number };

/** Internal per-consumer state + delivery. Exposed to callers only through the {@link Consumer} view. */
class ConsumerImpl extends EventEmitter implements Consumer {
  private queue: TimedMediaFrame[] = [];
  private paused = false;
  private detached = false;
  primed = false;
  awaitingKeyframe = false;
  /** Cached keyframe to replay, held until a "video" listener actually subscribes (see below). */
  private pendingPrime?: Extract<TimedMediaFrame, { kind: "video" }>;

  constructor(
    private readonly onDetach: (c: ConsumerImpl) => void,
    private readonly maxQueue: number,
  ) {
    super();
    // Deliver the keyframe-prime only once someone is listening. `live()` is async, so a naive
    // microtask replay would fire the cached IDR before the caller attaches its "video" handler and
    // it would be lost. "newListener" fires just BEFORE the first video listener is added, so a
    // microtask from here lands right after that listener is in place — the join is decodable.
    this.on("newListener", (event) => {
      if (event !== "video" || this.listenerCount("video") !== 0) return;
      const kf = this.pendingPrime;
      if (!kf) return;
      this.pendingPrime = undefined;
      queueMicrotask(() => this.deliverVideo(kf.frame, kf.timestampMs));
    });
  }

  /** Stage a keyframe to replay when the first video listener subscribes. */
  prime(item: Extract<TimedMediaFrame, { kind: "video" }>): void {
    this.primed = true;
    this.pendingPrime = item;
  }

  /** Attached-by-construction — `start()` is a no-op so a Consumer satisfies LiveStreamHandle. */
  start(): this {
    return this;
  }

  onMedia(listener: (item: TimedMediaFrame) => void): this {
    this.on("media", listener);
    return this;
  }

  stop(): void {
    this.detach();
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.queue = [];
    this.onDetach(this);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.detached) return;
    this.paused = false;
    const q = this.queue;
    this.queue = [];
    for (const it of q) this.flush(it);
  }

  /** Source → consumer video. Honors resync-to-keyframe and the bounded queue. */
  deliverVideo(frame: LiveVideoFrame, timestampMs: number): void {
    if (this.detached) return;
    if (this.awaitingKeyframe) {
      if (!frame.keyframe) return; // still hunting the resync point
      this.awaitingKeyframe = false;
    }
    this.accept({ kind: "video", frame, timestampMs });
  }

  /** Source → consumer audio. Dropped entirely while resyncing (audio has no keyframes). */
  deliverAudio(frame: LiveAudioFrame, timestampMs: number): void {
    if (this.detached || this.awaitingKeyframe) return;
    this.accept({ kind: "audio", frame, timestampMs });
  }

  private accept(item: TimedMediaFrame): void {
    if (!this.paused && this.queue.length === 0) {
      this.flush(item);
      return;
    }
    this.queue.push(item);
    if (this.queue.length > this.maxQueue) {
      // Overflow: this consumer can't keep up — drop the backlog and resync at the next IDR. The
      // source and every other consumer are untouched.
      this.queue = [];
      this.awaitingKeyframe = true;
    }
  }

  private flush(item: TimedMediaFrame): void {
    if (item.kind === "video") this.emit("video", item.frame);
    else this.emit("audio", item.frame);
    this.emit("media", item);
  }

  fail(err: Error): void {
    if (!this.detached) this.emit("error", err);
  }

  end(): void {
    if (!this.detached) this.emit("stop");
  }

  budget(notice: StreamBudgetNotice): void {
    if (!this.detached) this.emit("budget", notice);
  }
}

export class SharedLiveSource {
  private stream?: LiveStreamHandle;
  private readonly consumers = new Set<ConsumerImpl>();
  /** No-consumer teardown grace (arm/cancel on the last-detach / re-attach transition). */
  private readonly lingerTimer = new Timer();
  private _state: SharedLiveState = "idle";
  private disposed = false;

  /** Last keyframe access unit seen — replayed to a joining consumer (keyframe-prime). */
  private lastKeyframe?: Extract<TimedMediaFrame, { kind: "video" }>;
  /** Last parameter sets the stream announced — see {@link parameterSets}. */
  private lastParamSets?: ParamSets;
  /** Rolling prebuffer, keyframe-alignable on drain. */
  private ring: TimedMediaFrame[] = [];

  /** Warm-up start-retry ticker (interval) + single-shot deadline; cleared once the first frame arrives. */
  private warmRetryTimer?: ReturnType<typeof setInterval>;
  private readonly warmDeadlineTimer = new Timer();
  /** Battery budget timer + post-notice grace timer (battery/solar sources only). */
  private readonly budgetTimer = new Timer();
  private readonly budgetGraceTimer = new Timer();

  private readonly lingerMs: number;
  private readonly maxQueue: number;
  private readonly preBufferMs: number;
  private readonly warmRetryMs: number;
  private readonly warmTimeoutMs: number;
  private readonly powered: "wired" | "battery";
  private readonly batteryBudgetMs: number;
  private readonly budgetGraceMs: number;
  private readonly logger: Logger;
  private readonly tag: string;

  constructor(private readonly opts: SharedLiveSourceOptions) {
    this.lingerMs = opts.lingerMs ?? 8000;
    this.maxQueue = opts.maxQueue ?? 900;
    this.preBufferMs = (opts.preBufferSeconds ?? 0) * 1000;
    this.warmRetryMs = opts.warmRetryMs ?? 2000;
    this.warmTimeoutMs = opts.warmTimeoutMs ?? 20000;
    this.powered = opts.powered ?? "wired";
    this.batteryBudgetMs = opts.batteryBudgetMs ?? 45000;
    this.budgetGraceMs = opts.budgetGraceMs ?? 10000;
    this.logger = opts.logger ?? noopLogger;
    this.tag = opts.label ? `[live ${opts.label}]` : "[live]";
  }

  get state(): SharedLiveState {
    return this._state;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  get concurrentCap(): number | undefined {
    return this.opts.concurrentCap;
  }

  /**
   * The parameter sets (SPS/PPS, plus VPS for H.265) most recently announced on this stream, or
   * `undefined` before any have been seen.
   *
   * A camera commonly sends them ONCE, with the first keyframe of a stream. Every later access unit is
   * then undecodable in isolation, so a consumer that collects a burst — and cannot see frames from
   * before it joined — has no way to recover them. This source watches every frame from stream start,
   * which makes it the only holder of the answer. A caller re-emits them ahead of its collected burst.
   *
   * Cleared when the stream is torn down, so a rebuilt stream never primes a burst with a dead stream's sets.
   */
  get parameterSets(): ParamSets | undefined {
    return this.lastParamSets;
  }

  /**
   * Attach a new consumer. Warms the stream on the first attach (or cancels a pending linger teardown
   * and reuses the warm stream), then replays the cached keyframe so the consumer can decode at once.
   */
  attach(): Consumer {
    return this.attachConsumer(true);
  }

  /**
   * Attach at the same instant a keyframe-aligned prebuffer snapshot is taken. The returned consumer
   * is not separately keyframe-primed, so replaying `buffered` followed by its live events neither
   * duplicates the newest IDR nor leaves a gap at the handoff.
   */
  attachWithPrebuffer(seconds: number): { consumer: Consumer; buffered: TimedMediaFrame[] } {
    const consumer = this.attachConsumer(false);
    return { consumer, buffered: this.bufferedMedia(seconds) };
  }

  private attachConsumer(prime: boolean): Consumer {
    if (this.disposed) throw new Error("SharedLiveSource is disposed");
    const wasEmpty = this.consumers.size === 0;
    const consumer = new ConsumerImpl((c) => this.onDetach(c), this.maxQueue);
    this.consumers.add(consumer);
    if (wasEmpty) this.opts.onActive?.();

    if (this.lingerTimer.pending) {
      // Re-attach inside the linger window: cancel teardown, keep the warm stream (the reuse flow).
      this.lingerTimer.cancel();
      if (this._state === "lingering") this._state = this.lastKeyframe ? "live" : "warming";
      this.logger.debug(
        `${this.tag} re-attach in linger window — reusing warm stream (consumers=${this.consumers.size})`,
      );
    }

    if (!this.stream) this.warm();

    // Keyframe-prime: stage the last IDR so a joining consumer decodes without a full GOP wait. The
    // consumer replays it the moment a "video" listener subscribes (live() is async — see prime()).
    if (prime && this.lastKeyframe) consumer.prime(this.lastKeyframe);
    return consumer;
  }

  /** Build + start the underlying stream, wire its frames into the fan-out, and watch the warm-up. */
  private warm(): void {
    this._state = "warming";
    this.logger.debug(`${this.tag} warming (retry=${this.warmRetryMs}ms deadline=${this.warmTimeoutMs}ms)`);
    const stream = this.opts.makeStream();
    this.stream = stream;
    stream.on("video", (frame) => this.onVideo(frame));
    stream.on("audio", (frame) => this.onAudio(frame));
    stream.on("stop", () => this.onUpstreamEnd());
    stream.on("error", (err) => this.onUpstreamError(err));
    stream.start();
    // Warm-up watch: re-issue the start until a frame flows (self-heals a start that raced the
    // level-2 key), and fail loudly if none arrives within the deadline instead of hanging silently.
    this.warmRetryTimer = setInterval(() => this.stream?.nudge?.(), this.warmRetryMs);
    this.warmDeadlineTimer.arm(this.warmTimeoutMs, () => this.onWarmTimeout());
  }

  /** Arm the battery budget timer (battery/solar sources) — replaces any pending budget/grace. */
  private armBudget(): void {
    this.clearBudget();
    this.budgetTimer.arm(this.batteryBudgetMs, () => this.onBudgetExpire());
  }

  private clearBudget(): void {
    this.budgetTimer.cancel();
    this.budgetGraceTimer.cancel();
  }

  /**
   * Battery budget elapsed: notify consumers (with an {@link StreamBudgetNotice.extend} handle) and arm
   * the grace timer. If no one extends within the grace, auto-stop the pull to protect the battery.
   */
  private onBudgetExpire(): void {
    if (this.disposed || !this.stream) return;
    this.logger.debug(
      `${this.tag} battery budget elapsed — notifying consumers, ${this.budgetGraceMs}ms grace to extend`,
    );
    // Arm the auto-stop BEFORE notifying: a host that calls extend() synchronously in the handler must
    // cancel this grace (extendBudget clears it), not have it re-armed afterwards.
    this.budgetGraceTimer.arm(this.budgetGraceMs, () => {
      for (const c of [...this.consumers]) c.end();
      this.teardown("stopped");
    });
    const notice: StreamBudgetNotice = { graceMs: this.budgetGraceMs, extend: (ms) => this.extendBudget(ms) };
    for (const c of [...this.consumers]) c.budget(notice);
  }

  /** Re-push the battery budget (host called `extend()` from the notice), cancelling the auto-stop. */
  private extendBudget(ms?: number): void {
    if (this.disposed || !this.stream) return;
    this.clearBudget();
    this.budgetTimer.arm(ms ?? this.batteryBudgetMs, () => this.onBudgetExpire());
  }

  /** Stop the warm-up retry + deadline (the stream is confirmed live). */
  private clearWarmWatch(): void {
    if (this.warmRetryTimer) clearInterval(this.warmRetryTimer);
    this.warmRetryTimer = undefined;
    this.warmDeadlineTimer.cancel();
  }

  /** No frame within the warm-up window — surface a start failure to consumers and tear down. */
  private onWarmTimeout(): void {
    if (this.disposed || !this.stream) return;
    const err = new Error("live stream failed to start (no frames within warm-up window)");
    this.logger.warn(`${this.tag} ${err.message} (${this.warmTimeoutMs}ms, consumers=${this.consumers.size})`);
    for (const c of [...this.consumers]) c.fail(err);
    this.teardown("stopped");
  }

  private onVideo(frame: LiveVideoFrame): void {
    const item = { kind: "video", frame, timestampMs: Date.now() } as const;
    if (this.warmRetryTimer || this.warmDeadlineTimer.pending) {
      this.clearWarmWatch(); // first frame → warmed
      this.logger.debug(
        `${this.tag} first frame — live (${frame.width}x${frame.height} ${frame.codec}, powered=${this.powered})`,
      );
      if (this.powered === "battery") this.armBudget(); // battery drain starts now
    }
    this.lastParamSets = updatedParamSets(frame.data, this.lastParamSets);
    if (frame.keyframe) {
      this.lastKeyframe = item;
      if (this._state === "warming") this._state = "live";
    }
    this.pushRing(item);
    for (const c of this.consumers) c.deliverVideo(frame, item.timestampMs);
  }

  private onAudio(frame: LiveAudioFrame): void {
    const item = { kind: "audio", frame, timestampMs: Date.now() } as const;
    this.pushRing(item);
    for (const c of this.consumers) c.deliverAudio(frame, item.timestampMs);
  }

  private pushRing(item: TimedMediaFrame): void {
    if (this.preBufferMs <= 0) return;
    this.ring.push(item);
    const cutoff = item.timestampMs - this.preBufferMs;
    // Trim expired frames, but keep the window keyframe-aligned: never drop past the newest keyframe
    // that still lets the oldest retained frame be an IDR, so a drain is decodable.
    let firstKeep = 0;
    for (let i = 0; i < this.ring.length; i++) {
      if (this.ring[i].timestampMs >= cutoff && this.isKeyframe(this.ring[i])) {
        firstKeep = i;
        break;
      }
      if (this.ring[i].timestampMs >= cutoff) {
        // in-window but not a keyframe — keep scanning for the aligned start unless none exists
        firstKeep = i;
      }
    }
    // Prefer to start at a keyframe at or before firstKeep so the buffer opens decodable.
    let align = firstKeep;
    for (let i = firstKeep; i >= 0; i--) {
      if (this.isKeyframe(this.ring[i])) {
        align = i;
        break;
      }
    }
    if (align > 0) this.ring.splice(0, align);
  }

  /**
   * Drain the rolling prebuffer: the retained frames within `seconds` (capped at
   * `preBufferSeconds`), trimmed to open on a keyframe so the returned run is decodable. The host
   * decides when to drain (e.g. on a motion event) and where to send it.
   */
  ringBuffer(seconds: number): LiveVideoFrame[] {
    return this.bufferedMedia(seconds)
      .filter((item): item is Extract<TimedMediaFrame, { kind: "video" }> => item.kind === "video")
      .map((item) => item.frame);
  }

  private bufferedMedia(seconds: number): TimedMediaFrame[] {
    if (this.preBufferMs <= 0 || !this.ring.length) return [];
    const cutoff = Date.now() - Math.min(seconds * 1000, this.preBufferMs);
    let start = this.ring.findIndex((item) => item.timestampMs >= cutoff && this.isKeyframe(item));
    if (start < 0) start = this.ring.findIndex((item) => this.isKeyframe(item));
    return start < 0 ? [] : this.ring.slice(start);
  }

  private isKeyframe(item: TimedMediaFrame): boolean {
    return item.kind === "video" && item.frame.keyframe;
  }

  /**
   * Handle a consumer leaving. When the last one detaches (1→0), release the station-session user via
   * {@link SharedLiveSourceOptions.onIdle} (its own longer idle timer then arms) and arm the stream's
   * linger teardown.
   */
  private onDetach(consumer: ConsumerImpl): void {
    this.consumers.delete(consumer);
    if (this.consumers.size === 0 && !this.disposed) {
      this.opts.onIdle?.();
      this.arm();
    }
  }

  /** Refcount hit zero — arm the linger teardown. A new attach in the window cancels it. */
  private arm(): void {
    this._state = "lingering";
    this.logger.debug(`${this.tag} last consumer left — lingering ${this.lingerMs}ms before teardown`);
    this.lingerTimer.arm(this.lingerMs, () => this.teardown("stopped"));
  }

  /** Stop + drop the underlying stream and clear the prime/ring caches. Rebuildable via attach(). */
  private teardown(state: SharedLiveState): void {
    this.clearWarmWatch();
    this.clearBudget();
    this.lingerTimer.cancel();
    try {
      this.stream?.stop();
    } catch {
      /* stream may already be gone */
    }
    this.stream = undefined;
    this.lastKeyframe = undefined;
    this.lastParamSets = undefined;
    this.ring = [];
    this._state = state;
  }

  /** Underlying stream ended unexpectedly (station max-duration / reconnect): tell consumers. */
  private onUpstreamEnd(): void {
    if (this.disposed || !this.stream) return;
    this.logger.debug(
      `${this.tag} upstream ended (station max-duration / reconnect) — notifying ${this.consumers.size} consumer(s)`,
    );
    for (const c of [...this.consumers]) c.end();
    this.teardown("stopped");
  }

  private onUpstreamError(err: Error): void {
    if (this.disposed) return;
    this.logger.warn(`${this.tag} upstream error: ${err.message} — tearing down (consumers=${this.consumers.size})`);
    for (const c of [...this.consumers]) c.fail(err);
    this.teardown("stopped");
  }

  /** Permanent shutdown (session close / router closeAll). Consumers get `stop`; no rebuild. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of [...this.consumers]) c.end();
    this.consumers.clear();
    this.teardown("stopped");
  }
}
