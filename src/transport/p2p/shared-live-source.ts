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
import { LiveStreamStartError, type LiveStreamStartFailureReason } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { Timer } from "../../core/util.js";
import { codedGeometry, updatedParamSets, type CodedGeometry, type ParamSets } from "./annexb.js";
import { traceLiveStart, type LiveTrace } from "./live-trace.js";
import type {
  LiveAudioFrame,
  LiveStreamConsumer,
  LiveStreamHandle,
  LiveVideoConfig,
  LiveVideoFrame,
  StreamBudgetNotice,
} from "../../core/contracts.js";

/** A finite positive duration in seconds as milliseconds; absent, non-finite and non-positive mean off. */
function durationMs(seconds: number | undefined): number {
  const milliseconds = (seconds ?? 0) * 1000;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}

/**
 * Whether two coded configurations describe the same decoder — the test an announcement is gated on.
 *
 * Compared by value rather than by identity, because the configuration is resolved per frame: an unchanged
 * stream produces an equal object every time, and identity would announce on every one of them.
 *
 * Not `core/util`'s `structuralEqual`, which owns change detection over decoded parameter VALUES: this
 * compares three declared primitives on the delivery path of every frame of every consumer, where a keyed
 * recursive walk would be the wrong cost for a fixed shape that cannot nest.
 */
function sameConfig(a: LiveVideoConfig, b: LiveVideoConfig | undefined): boolean {
  return b !== undefined && a.codec === b.codec && a.width === b.width && a.height === b.height;
}

/** Lifecycle state of a {@link SharedLiveSource}. */
export type SharedLiveState = "idle" | "warming" | "live" | "lingering" | "stopped";

export interface SharedLiveSourceOptions {
  /**
   * Factory that builds a fresh, **un-started** {@link LiveStreamHandle}. Called on every (re)warm so
   * a reconnect rebuilds the stream rather than reusing a dead one. `SharedLiveSource` calls
   * `.start()` itself.
   *
   * `ctx.reassertWanted` answers whether this pull still has anyone attached. A stream that re-asserts a
   * channel to hold it open should consult it, so a pull nothing is watching stops competing for a session
   * that serves one camera at a time.
   */
  makeStream: (ctx: { reassertWanted: () => boolean }) => LiveStreamHandle;
  /** No-consumer grace before teardown (default 8000ms). Distinct from the stream's keepalive. */
  lingerMs?: number;
  /** Per-consumer bounded queue depth; overflow → drop-to-keyframe (default 900 ≈ 30s @ 30fps). */
  maxQueue?: number;
  /** Rolling prebuffer window in seconds, 0 = off (default 0). */
  preBufferSeconds?: number;
  /**
   * Warm-up start retry interval (default 2000ms). After warming, if no keyframe has arrived, the source
   * re-issues the start ({@link LiveStreamHandle.nudge}) every interval — self-healing a start that
   * raced the level-2 key negotiation, independent of any caller keepalive.
   */
  warmRetryMs?: number;
  /**
   * Warm-up deadline (default 20000ms). If no keyframe arrives within it, the source emits `error` to
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
  /**
   * Called when a stream is torn down having **never delivered a keyframe**, AFTER consumers have been told.
   *
   * A source can only rebuild its stream; it holds a factory, not the session that stream rides on. When
   * the session — or the per-device state carried on it — is what has stopped serving this device, every
   * rebuild starts another stream over the same session and dies the same way, so the owner of the session
   * has to hear about it to do anything else.
   *
   * The condition is deliberately "no keyframe ever arrived", not "the warm-up deadline fired". A start can
   * fail without that deadline being reached — an upstream error or stop can arrive first, the battery
   * budget can stop the pull, and a caller that gives up before the deadline cancels it on the way out
   * (`clearWarmWatch`) — and all of those are the same dead start. Enumerating the ways instead of naming
   * the condition is how the case that actually happens gets left out.
   *
   * Not called by {@link SharedLiveSource.dispose}: the owner asked for that one, and it is the very thing
   * an owner does in response to this callback.
   */
  onStartFailed?: () => void;
  /**
   * The pull has ended and will not resume: the linger elapsed, the battery budget ran out, or the source
   * was torn down. A later attach builds a fresh stream rather than reviving this one.
   *
   * Distinct from {@link onIdle} by what is still running. `onIdle` fires at the last detach, while the
   * linger is still holding the pull open so a quick re-attach costs nothing; between the two the pull is
   * alive. This fires when it is not.
   */
  onStopped?: () => void;
  /**
   * A media start was abandoned unacknowledged before anything was delivered, so this session is not being
   * heard. The owner is asked for a replacement and calls {@link SharedLiveSource.rewarm} once it has one.
   *
   * Asked at most once per warm-up: further abandonments are the same session saying the same thing.
   */
  onSessionUnreachable?: () => void;
}

/**
 * A single consumer of a {@link SharedLiveSource}. A {@link LiveStreamConsumer} (so `live()` can hand it
 * back directly), plus the listener removal and arrival-timed feed the recording and readable egresses use.
 */
export interface Consumer extends LiveStreamConsumer {
  /** What this consumer holds the pull for. */
  /** Detach a previously registered listener (mirrors {@link LiveStreamHandle.on}). */
  off(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  off(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  off(event: "start" | "stop", listener: () => void): this;
  off(event: "error", listener: (err: Error) => void): this;
  /** Subscribe to frames carrying the source-captured arrival time used by the prebuffer. */
  onMedia(listener: (item: TimedMediaFrame) => void): this;
  /** True once the source has replayed a cached keyframe to this consumer (no GOP wait on join). */
  readonly primed: boolean;
  /** Leave the source (refcount--). Idempotent. `stop()` is an alias (LiveStreamHandle). */
  detach(): void;
}

/**
 * One media frame retained with its transport-arrival time for prebuffer continuity.
 *
 * A video frame carries the coded configuration in force when it ARRIVED, because the item outlives that
 * moment: it is the unit a keyframe-prime replays to a consumer that joined later and the unit a prebuffer
 * drain hands over, and both have to announce the configuration their media was coded under rather than
 * whichever one is current by the time they are delivered.
 */
export type TimedMediaFrame =
  | { kind: "video"; frame: LiveVideoFrame; timestampMs: number; config: LiveVideoConfig }
  | { kind: "audio"; frame: LiveAudioFrame; timestampMs: number };

/** Internal per-consumer state + delivery. Exposed to callers only through the {@link Consumer} view. */
class ConsumerImpl extends EventEmitter implements Consumer {
  private queue: TimedMediaFrame[] = [];
  private paused = false;
  private detached = false;
  primed = false;
  awaitingKeyframe = false;
  /** The last coded configuration announced to THIS consumer — see {@link flush}. */
  private config?: LiveVideoConfig;
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
      queueMicrotask(() => this.deliverVideo(kf));
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

  /**
   * Release delivery and hand over the queued backlog, stopping the moment the sink re-pauses.
   *
   * A sink applies backpressure by pausing from inside its own delivery handler, so draining the whole
   * backlog regardless would push a bound's worth of frames past a sink that already said it was full —
   * relocating this queue into whatever unbounded buffer sits behind it and defeating the drop-to-keyframe
   * policy the bound exists to arm. Whatever is left instead stays queued and keeps counting against the
   * bound, so a sink that never keeps up resynchronises at an IDR rather than replaying stale media.
   *
   * Detachment is re-checked each step: a sink may detach from inside a delivery handler, and this walks a
   * local copy the detach cannot empty.
   */
  resume(): void {
    if (this.detached) return;
    this.paused = false;
    const q = this.queue;
    this.queue = [];
    for (let i = 0; i < q.length; i++) {
      if (this.detached) return;
      if (this.paused) {
        this.retainUndelivered(q.slice(i));
        return;
      }
      this.flush(q[i]!);
    }
  }

  /**
   * Source → consumer video, honouring resync-to-keyframe and the bounded queue.
   *
   * Takes the whole item rather than a frame, because a keyframe-prime replays a RETAINED one and has to
   * arrive by the same route: a primed keyframe is exactly the IDR a resynchronising consumer is waiting
   * for, so it must clear that wait as a live keyframe does, and it carries the configuration its own media
   * was coded under. While that wait is unsatisfied a delta frame is dropped — nothing can begin at it.
   */
  deliverVideo(item: Extract<TimedMediaFrame, { kind: "video" }>): void {
    if (this.detached) return;
    if (this.awaitingKeyframe) {
      if (!item.frame.keyframe) return;
      this.awaitingKeyframe = false;
    }
    this.accept(item);
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
    this.dropBacklogPastBound();
  }

  /** Restore an undelivered backlog ahead of anything a mid-drain handler queued behind it. */
  private retainUndelivered(undelivered: TimedMediaFrame[]): void {
    this.queue = this.queue.length > 0 ? undelivered.concat(this.queue) : undelivered;
    this.dropBacklogPastBound();
  }

  /**
   * Overflow: this consumer can't keep up — drop the backlog and resync at the next IDR. The source and
   * every other consumer are untouched.
   */
  private dropBacklogPastBound(): void {
    if (this.queue.length > this.maxQueue) {
      this.queue = [];
      this.awaitingKeyframe = true;
    }
  }

  /**
   * Hand one item to this consumer's listeners, announcing a coded configuration it has not been told
   * about ahead of the frame that carries it.
   *
   * The single delivery point is where the announcement belongs, because every way media reaches a
   * consumer passes through here: a live frame, a replayed keyframe-prime, and a backlog drained by
   * {@link resume}. Comparing against what this consumer was last given rather than what the source last
   * saw is what makes a primed join and a post-overflow resynchronisation correct.
   */
  private flush(item: TimedMediaFrame): void {
    if (item.kind === "video") {
      if (!sameConfig(item.config, this.config)) {
        this.config = item.config;
        this.emit("video-config", item.config);
      }
      this.emit("video", item.frame);
    } else this.emit("audio", item.frame);
    this.emit("media", item);
  }

  /**
   * Tell this consumer why its stream is over.
   *
   * Skipped when nothing is listening: `emit("error")` on an `EventEmitter` with no `"error"` listener
   * throws {@link ERR_UNHANDLED_ERROR} instead of returning, and this emit sits inside a synchronous
   * fan-out reached from the transport's own datagram handler — so a consumer that only ever wanted `stop`
   * would strand every consumer after it in the loop and take the host's process with it. Such a
   * consumer still gets its `stop` from {@link end}.
   */
  fail(err: Error): void {
    if (!this.detached && this.listenerCount("error") > 0) this.emit("error", err);
  }

  end(): void {
    if (!this.detached) this.emit("stop");
  }

  budget(notice: StreamBudgetNotice): void {
    if (!this.detached) this.emit("budget", notice);
  }
}

/** Per-process counter behind {@link SharedLiveSource.trace}'s handle. */
let pullSequence = 0;

export class SharedLiveSource {
  private stream?: LiveStreamHandle;
  private readonly consumers = new Set<ConsumerImpl>();
  /** No-consumer teardown grace (arm/cancel on the last-detach / re-attach transition). */
  private readonly lingerTimer = new Timer();
  private _state: SharedLiveState = "idle";
  private disposed = false;

  /**
   * What the CURRENT stream generation has delivered — replaced wholesale by every {@link warm}, so a new
   * generation cannot inherit a previous one's evidence and no field can be forgotten in the reset.
   *
   * All three are read together to stage a start failure: `keyframe` is what makes a stream live at all,
   * while `video` and `audio` are what separate a source that produced nothing from one whose units were
   * never decodable and one that is answering with sound and no picture — the three stages of
   * {@link LiveStreamStartError}.
   */
  private delivered = { keyframe: false, video: false, audio: false };
  /** Last keyframe access unit seen — replayed to a joining consumer (keyframe-prime). */
  private lastKeyframe?: Extract<TimedMediaFrame, { kind: "video" }>;
  /** Last parameter sets the stream announced — see {@link parameterSets}. */
  private lastParamSets?: ParamSets;
  /**
   * The geometry the parameter sets in force state, and the sets it was read from.
   *
   * Holding the sets it came from is what keeps the read to one per announcement: `updatedParamSets`
   * returns the SAME object when a frame announces nothing, so identity says the geometry cannot have
   * moved without comparing any bytes.
   */
  private declaredGeometry?: CodedGeometry;
  private configuredFrom?: ParamSets;
  /** Rolling prebuffer, keyframe-alignable on drain. */
  private ring: TimedMediaFrame[] = [];

  /** Warm-up start-retry ticker (interval) + single-shot deadline; cleared once the first keyframe arrives. */
  private warmRetryTimer?: ReturnType<typeof setInterval>;
  /** Whether this warm-up has already asked its owner to replace the session. */
  private sessionReplacementAsked = false;
  /**
   * Whether the pending watch is a REUSE watch, which any frame settles.
   *
   * A cold warm-up needs a keyframe: nothing can be decoded without one. A join already holds the retained
   * keyframe, so what its watch is missing is evidence the stream is still being served — and a delta frame is
   * that evidence. Requiring a keyframe there let the deadline outlive an actively delivering stream whose
   * group of pictures is longer than the window, and the timeout fails EVERY consumer.
   */
  private reuseWatch = false;
  /** This source's opaque handle for tracing — see {@link SharedLiveSource.trace}. */
  private readonly traceId: string;
  /**
   * How many re-issues this watch has spent with nothing arriving since it was armed.
   *
   * What a stream delivered BEFORE the current watch is no evidence about now — a reused stream's upstream may
   * have served plenty and since been dropped by the station, and the retained keyframe replayed to a joining
   * consumer says nothing either. Only a frame arriving after the watch was armed does, and {@link delivered}
   * is reset to track exactly that.
   *
   * The first re-issue is therefore a keepalive: a reuse cannot yet know which case it is in, and a keepalive
   * is right where the station is still serving and harmless where it is not. A second one due with nothing
   * arrived is the answer — no bound of its own, the retry's own cadence.
   */
  private fruitlessReissues = 0;
  private readonly warmDeadlineTimer = new Timer();
  private warmAttempts = 0;
  /** Battery budget timer + post-notice grace timer (battery/solar sources only). */
  private readonly budgetTimer = new Timer();
  private readonly budgetGraceTimer = new Timer();

  private readonly lingerMs: number;
  private readonly maxQueue: number;
  private readonly preBufferMs: number;
  private readonly warmRetryMs: number;
  private readonly warmTimeoutMs: number;
  private powered: "wired" | "battery";
  private readonly batteryBudgetMs: number;
  private readonly budgetGraceMs: number;
  private readonly logger: Logger;
  private readonly tag: string;

  constructor(private readonly opts: SharedLiveSourceOptions) {
    this.lingerMs = opts.lingerMs ?? 8000;
    this.maxQueue = opts.maxQueue ?? 900;
    this.preBufferMs = durationMs(opts.preBufferSeconds);
    this.warmRetryMs = opts.warmRetryMs ?? 2000;
    this.warmTimeoutMs = opts.warmTimeoutMs ?? 20000;
    this.powered = opts.powered ?? "wired";
    this.batteryBudgetMs = opts.batteryBudgetMs ?? 45000;
    this.budgetGraceMs = opts.budgetGraceMs ?? 10000;
    this.logger = opts.logger ?? noopLogger;
    this.tag = opts.label ? `[live ${opts.label}]` : "[live]";
    this.traceId = `pull-${++pullSequence}`;
  }

  get state(): SharedLiveState {
    return this._state;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /** Reconcile the stream budget when the device's operating power claim changes. */
  setPowerTier(tier: "wired" | "battery"): void {
    if (this.powered === tier) return;
    this.powered = tier;
    if (tier === "wired") this.clearBudget();
    else if (!this.disposed && this.stream && this.delivered.keyframe) this.armBudget();
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
    else this.watchReusedStream();

    // Keyframe-prime: stage the last IDR so a joining consumer decodes without a full GOP wait. The
    // consumer replays it the moment a "video" listener subscribes (live() is async — see prime()).
    if (prime && this.lastKeyframe) consumer.prime(this.lastKeyframe);
    return consumer;
  }

  /**
   * Emit a live trace under this source's opaque handle — `pull-N` by order of construction in this process.
   *
   * Not {@link SharedLiveSourceOptions.label}, which is the router's `stationSn:channel` key: that is a serial,
   * and a serial in a retained record survives every redaction a host applies.
   */
  private trace(trace: LiveTrace): void {
    traceLiveStart(this.logger, trace, this.traceId);
  }

  /**
   * Build the underlying stream, wire its frames into the fan-out, and start it.
   *
   * Every warm goes through here, so a source that is rebuilt on a replacement session listens on exactly
   * the events the first attempt did.
   */
  private openStream(): void {
    const stream = this.opts.makeStream({ reassertWanted: () => this.consumerCount > 0 });
    this.stream = stream;
    stream.on("video", (frame) => this.onVideo(frame));
    stream.on("audio", (frame) => this.onAudio(frame));
    stream.on("stop", () => this.onUpstreamEnd());
    stream.on("error", (err) => this.onUpstreamError(err));
    stream.on("unacknowledged", () => this.onStartUnacknowledged());
    stream.start();
  }

  /**
   * Build + start the underlying stream, wire its frames into the fan-out, and watch the warm-up.
   */
  private warm(): void {
    this._state = "warming";
    this.sessionReplacementAsked = false;
    this.reuseWatch = false;
    this.fruitlessReissues = 0;
    this.delivered = { keyframe: false, video: false, audio: false };
    this.warmAttempts = 1;
    this.logger.debug(`${this.tag} warming (retry=${this.warmRetryMs}ms deadline=${this.warmTimeoutMs}ms)`);
    this.trace({ phase: "warming", retryMs: this.warmRetryMs, deadlineMs: this.warmTimeoutMs });
    this.openStream();
    this.armWarmWatch();
  }

  /**
   * A start was abandoned unacknowledged. Ask for a replacement session where nothing has been delivered yet.
   *
   * The abandonment is roughly twenty byte-identical sends with no reply, against acknowledgement latencies of
   * 4–37 ms awake and 238 ms waking, so it is the session that is not being heard rather than a slow device —
   * `P2PSession` says as much: the camera was never told to stream, so this warm-up can only time out. Where
   * media has already flowed the abandonment means something else and this does nothing.
   *
   * The retry ticker is stopped while a replacement is awaited, because every tick it issues goes to the same
   * unheard session. The DEADLINE is left running: the window belongs to the attempt, not to the session it
   * started on.
   */
  private onStartUnacknowledged(): void {
    if (this.disposed || this.sessionReplacementAsked) return;
    if (this.delivered.video || this.delivered.audio || this.delivered.keyframe) return;
    if (!this.opts.onSessionUnreachable) return;
    this.sessionReplacementAsked = true;
    this.logger.debug(`${this.tag} start unacknowledged with nothing delivered — asking for a fresh session`);
    if (this.warmRetryTimer) clearInterval(this.warmRetryTimer);
    this.warmRetryTimer = undefined;
    this.opts.onSessionUnreachable();
  }

  /**
   * Warm again on a session the owner has replaced, inside the deadline the first attempt started.
   *
   * The previous stream is dropped rather than stopped through the state machine: it speaks to a session that
   * is gone, and its `stop` would be read as an upstream end. Only a warm-up that asked for a replacement
   * rewarms, so this is inert on a source that is streaming or has already failed.
   */
  rewarm(): void {
    if (this.disposed || !this.sessionReplacementAsked || this._state !== "warming") return;
    const previous = this.stream;
    this.stream = undefined;
    previous?.stop();
    this.fruitlessReissues = 0;
    this.openStream();
    this.warmAttempts++;
    this.logger.debug(`${this.tag} warming again on a replacement session (attempt ${this.warmAttempts})`);
    this.warmRetryTimer = setInterval(() => this.reissueStart(), this.warmRetryMs);
  }

  /**
   * Arm the deadline a stream must deliver within, and the ticker that re-issues its start until it does.
   *
   * The deadline is armed before the ticker so that a retry falling on the same instant as the deadline is
   * never issued, which keeps `attempts` on {@link LiveStreamStartError} equal to the number of media starts
   * actually sent. A stream with no `nudge` cannot be retried, so its watch stays at one attempt however long
   * the deadline is.
   */
  private armWarmWatch(): void {
    this.warmDeadlineTimer.arm(this.warmTimeoutMs, () => this.onWarmTimeout());
    this.warmRetryTimer = setInterval(() => this.reissueStart(), this.warmRetryMs);
  }

  /**
   * Re-issue this stream's media start, asking for a REAL start while nothing has arrived.
   *
   * On an own-session camera a re-issue is a keepalive once the session believes the channel is started, and
   * that belief outlives a station which acknowledged a start and then served nothing: every later re-issue is
   * then a keepalive holding a stream that was never started. Nothing arriving since this watch was armed, across
   * more than one re-issue, is this source's own evidence that the channel is not being served — see
   * {@link fruitlessReissues} for why one is not enough and why what the stream delivered earlier is not
   * evidence. Once media arrives the keepalive is what is wanted, and an attached camera re-sends a full start
   * either way.
   */
  private reissueStart(): void {
    const current = this.stream;
    if (!current?.nudge) return;
    this.warmAttempts++;
    const arrivedSinceWatch = this.delivered.video || this.delivered.audio;
    if (arrivedSinceWatch) this.fruitlessReissues = 0;
    else this.fruitlessReissues++;
    current.nudge(!arrivedSinceWatch && this.fruitlessReissues > 1);
  }

  /**
   * Watch a stream this consumer joined rather than warmed, so a dead one cannot pass for a live one.
   *
   * A reused stream hands a joining consumer the retained keyframe at once, which is evidence about the past:
   * it says the stream WAS being served, not that it still is. A caller commits to media on that frame — a
   * process, a negotiated session — so a stream the station has quietly stopped serving strands it with no
   * deadline, because warming is what arms one and a reuse skips warming by definition.
   *
   * The watch is the warm-up's own, deadline and retry alike, and the first frame to arrive AFTER the join
   * clears it, that being the only frame which says the stream is still being served. A stream still serving
   * clears it long before the deadline fires; one that is not fails its consumers exactly as a cold start that
   * never delivered would.
   *
   * The start is re-issued at once and then on the retry's cadence, because a station that stopped serving a
   * channel when its last consumer left is the very case the retry recovers: waiting the whole window to
   * report what one re-issued start can fix is a timeout where a stream was available.
   *
   * Nothing is armed while a watch is already pending, so several consumers joining one reused stream share the
   * watch the first of them started.
   */
  private watchReusedStream(): void {
    if (this.warmDeadlineTimer.pending || this.warmRetryTimer !== undefined) return;
    this.delivered = { keyframe: false, video: false, audio: false };
    this.fruitlessReissues = 0;
    this.reuseWatch = true;
    this.warmAttempts = 0;
    this.armWarmWatch();
    const current = this.stream;
    if (current?.nudge) {
      this.warmAttempts++;
      current.nudge();
    }
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
    if (this.disposed || !this.stream || this.powered !== "battery") return;
    this.clearBudget();
    this.budgetTimer.arm(ms ?? this.batteryBudgetMs, () => this.onBudgetExpire());
  }

  /** Settle a reuse watch on any frame — the join already holds a decodable picture. */
  private settleReuseWatch(): void {
    if (!this.reuseWatch) return;
    this.reuseWatch = false;
    if (this._state === "warming") this._state = "live";
    this.clearWarmWatch();
  }

  /** Stop the warm-up retry + deadline (the stream is confirmed live). */
  private clearWarmWatch(): void {
    if (this.warmRetryTimer) clearInterval(this.warmRetryTimer);
    this.warmRetryTimer = undefined;
    this.warmDeadlineTimer.cancel();
  }

  /**
   * No keyframe within the warm-up window — surface a start failure to consumers, tear down, and report the
   * failed start to the owner (see {@link SharedLiveSourceOptions.onStartFailed}) so it can recycle what
   * this source cannot reach.
   */
  private onWarmTimeout(): void {
    if (this.disposed || !this.stream) return;
    const err = this.startFailure("warm-timeout");
    this.logger.warn(`${this.tag} ${err.message} (consumers=${this.consumers.size})`);
    for (const c of [...this.consumers]) c.fail(err);
    this.teardown("stopped");
  }

  /**
   * The typed failure for a start that produced no keyframe, staged by what the source did deliver: nothing
   * at all, audio without a single video frame, or access units a decoder cannot begin at.
   *
   * Video takes precedence when both arrived: audio alongside video says nothing a caller needs, while video
   * without a keyframe does.
   */
  private startFailure(reason: LiveStreamStartFailureReason, cause?: unknown): LiveStreamStartError {
    return new LiveStreamStartError({
      reason,
      stage: this.delivered.video ? "awaiting-keyframe" : this.delivered.audio ? "audio-only" : "awaiting-first-frame",
      timeoutMs: this.warmTimeoutMs,
      attempts: this.warmAttempts,
      cause,
    });
  }

  private onVideo(frame: LiveVideoFrame): void {
    this.delivered.video = true;
    this.fruitlessReissues = 0;
    this.settleReuseWatch();
    this.lastParamSets = updatedParamSets(frame.data, this.lastParamSets);
    const item = { kind: "video", frame, timestampMs: Date.now(), config: this.configOf(frame) } as const;
    if (frame.keyframe) {
      this.lastKeyframe = item;
      const wasWarming = this.warmRetryTimer !== undefined || this.warmDeadlineTimer.pending;
      this.delivered.keyframe = true;
      if (this._state === "warming") this._state = "live";
      if (wasWarming) {
        this.clearWarmWatch();
        this.logger.debug(
          `${this.tag} first keyframe — live (${item.config.width}x${item.config.height} ${item.config.codec}, powered=${this.powered})`,
        );
        if (this.powered === "battery") this.armBudget(); // battery drain starts now
      }
    }
    this.pushRing(item);
    for (const c of this.consumers) c.deliverVideo(item);
  }

  /**
   * The coded configuration this frame belongs to: what the parameter sets state, or the frame header's own
   * report where they state nothing readable.
   *
   * The parameter sets are preferred because they define the size a decoder produces while the header only
   * reports it. The fMP4 muxer prefers them for the same reason, though it answers from the sets ONE unit
   * carried rather than from the sets in force, so the two can differ on a keyframe that re-states only a
   * PPS — a muxer is handed frames, not this source's fold.
   *
   * Falling back rather than staying silent is what lets a consumer act on the announcement alone. A set
   * whose geometry cannot be read would otherwise leave it with nothing to rebuild on, which is worse than
   * the header it would have had to diff for itself.
   *
   * Only a keyframe carries parameter sets, so the read costs one parse per announcement: `updatedParamSets`
   * answers with the same object when a frame announces none, and identity settles it from there.
   */
  private configOf(frame: LiveVideoFrame): LiveVideoConfig {
    if (this.lastParamSets !== this.configuredFrom) {
      this.configuredFrom = this.lastParamSets;
      this.declaredGeometry = this.lastParamSets ? codedGeometry(this.lastParamSets) : undefined;
    }
    // The DISPLAY size only: a config announces the picture a consumer should show, not the
    // macroblock-aligned size it is coded at (which `CodedGeometry` also carries, for a consumer that
    // decodes frames itself and has to crop).
    return this.declaredGeometry
      ? {
          codec: this.lastParamSets!.codec,
          width: this.declaredGeometry.width,
          height: this.declaredGeometry.height,
        }
      : { codec: frame.codec, width: frame.width, height: frame.height };
  }

  private onAudio(frame: LiveAudioFrame): void {
    const item = { kind: "audio", frame, timestampMs: Date.now() } as const;
    this.delivered.audio = true;
    this.fruitlessReissues = 0;
    this.settleReuseWatch();
    this.pushRing(item);
    for (const c of this.consumers) c.deliverAudio(frame, item.timestampMs);
  }

  /**
   * Retain the rolling window, trimmed to the same run a full-window drain asks for.
   *
   * Retention and drain obey one rule, because a ring trimmed tighter than the drain's rule cannot
   * answer it — the media would already be gone. That rule is {@link windowStart}.
   *
   * A keyframe is the only place a run may begin, so it is also the only anchor a time-based trim has. A
   * stream that stops coding them keeps its last decodable run until another keyframe gives the trim
   * somewhere safe to move to: a separate frame-count ceiling would override the configured window, and
   * cutting mid-group would leave retained media no decoder can start from.
   */
  private pushRing(item: TimedMediaFrame): void {
    if (this.preBufferMs <= 0) return;
    this.ring.push(item);
    const start = this.windowStart(item.timestampMs - this.preBufferMs);
    if (start > 0) this.ring.splice(0, start);
  }

  /**
   * Drain the rolling prebuffer: a decodable run covering the last `seconds` of retained media, capped
   * at the configured `preBufferSeconds`. Asking for none hands over none. The host decides when to
   * drain (e.g. on a motion event) and where to send it.
   *
   * The run opens on the newest keyframe at or before the window starts, so it covers the whole request
   * and over-delivers by however far back that keyframe sits — one keyframe interval on a steady stream,
   * more where delivery stalled, since retention is timed on arrival and a frame carries no device clock.
   * Beginning inside the window instead would under-deliver by that same distance, which on a short window
   * is most of it, and a decoder allows no third option.
   */
  ringBuffer(seconds: number): LiveVideoFrame[] {
    return this.bufferedMedia(seconds)
      .filter((item): item is Extract<TimedMediaFrame, { kind: "video" }> => item.kind === "video")
      .map((item) => item.frame);
  }

  private bufferedMedia(seconds: number): TimedMediaFrame[] {
    const requested = Math.min(durationMs(seconds), this.preBufferMs);
    if (requested <= 0 || !this.ring.length) return [];
    const start = this.windowStart(Date.now() - requested);
    return this.isKeyframe(this.ring[start]) ? this.ring.slice(start) : [];
  }

  /**
   * Where a decodable run covering everything from `cutoff` onwards begins in the ring.
   *
   * The newest keyframe at or before `cutoff` is that place: it is the latest point a decoder can start
   * from and still produce every frame in the window. When the ring reaches no further back than the
   * cutoff, its oldest keyframe is the most of the window that exists. When it holds no keyframe at all,
   * nothing in it is decodable and index `0` reports that to the caller, which checks.
   */
  private windowStart(cutoff: number): number {
    let start = -1;
    for (let i = 0; i < this.ring.length; i++) {
      if (!this.isKeyframe(this.ring[i])) continue;
      if (this.ring[i].timestampMs > cutoff && start >= 0) break;
      start = i;
    }
    return start < 0 ? 0 : start;
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

  /**
   * Stop + drop the underlying stream and clear the prime/ring caches. Rebuildable via attach().
   *
   * The stream reference is dropped BEFORE stopping it, because `stop()` emits `"stop"` synchronously and
   * this source listens for that — so stopping re-enters `teardown` through {@link onUpstreamEnd}. Clearing
   * first makes that re-entry hit the `!this.stream` guard and return, which is what keeps a single
   * teardown from reporting a failed start twice (and, before that report existed, from tearing down twice).
   *
   * `report` is false only for {@link dispose}: the owner asked for that one.
   */
  private teardown(state: SharedLiveState, report = true): void {
    const stream = this.stream;
    const startFailed = stream !== undefined && !this.delivered.keyframe;
    this.stream = undefined;
    this.clearWarmWatch();
    this.clearBudget();
    this.lingerTimer.cancel();
    try {
      stream?.stop();
    } catch {
      /* stream may already be gone */
    }
    this.lastKeyframe = undefined;
    this.lastParamSets = undefined;
    this.declaredGeometry = undefined;
    this.configuredFrom = undefined;
    this.ring = [];
    this._state = state;
    if (state === "stopped") this.opts.onStopped?.();
    if (startFailed && report) this.opts.onStartFailed?.();
  }

  /**
   * Underlying stream ended unexpectedly (station max-duration / reconnect): tell consumers.
   *
   * An end before the first keyframe is also a failed start, so those consumers get the typed `error`
   * explaining why nothing played and then the `stop` that closes them — a bare `stop` would look like a
   * normal end of stream to a caller still waiting for its first frame.
   *
   * Teardown runs even if notifying a consumer throws, because what it releases — the upstream stream, the
   * warm-up timers, the ring — belongs to this source and not to the caller whose listener raised. The throw
   * itself still propagates: a listener that raises is the caller's defect to see, not this source's to
   * swallow.
   */
  private onUpstreamEnd(): void {
    if (this.disposed || !this.stream) return;
    this.logger.debug(
      `${this.tag} upstream ended (station max-duration / reconnect) — notifying ${this.consumers.size} consumer(s)`,
    );
    try {
      if (!this.delivered.keyframe) {
        const error = this.startFailure("source-ended");
        for (const c of [...this.consumers]) c.fail(error);
      }
      for (const c of [...this.consumers]) c.end();
    } finally {
      this.teardown("stopped");
    }
  }

  /** Underlying stream failed: tell consumers, then tear down regardless (see {@link onUpstreamEnd}). */
  private onUpstreamError(err: Error): void {
    if (this.disposed) return;
    this.logger.warn(`${this.tag} upstream error: ${err.message} — tearing down (consumers=${this.consumers.size})`);
    const error = this.delivered.keyframe ? err : this.startFailure("source-error", err);
    try {
      for (const c of [...this.consumers]) c.fail(error);
    } finally {
      this.teardown("stopped");
    }
  }

  /**
   * Permanent shutdown (session close / router closeAll). Consumers get `stop`; no rebuild.
   *
   * Releases the session user when consumers were still attached: {@link SharedLiveSourceOptions.onActive}
   * fired on the 0→1 transition, and this is the 1→0 one, so skipping it would leave the station pinned
   * open for a source that can never serve anyone again.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const held = this.consumers.size > 0;
    for (const c of [...this.consumers]) c.end();
    this.consumers.clear();
    this.teardown("stopped", false);
    if (held) this.opts.onIdle?.();
  }
}
