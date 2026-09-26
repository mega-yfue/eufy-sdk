/**
 * P2P session lifecycle manager — owns the {@link P2PSession} registry and decides WHEN a session is
 * open. It exists to stop battery-powered cameras draining: a persistent P2P session runs a
 * 5 s PING heartbeat forever (keeping the device awake), so instead of opening every station eagerly
 * and holding it open, this opens a station's session **on demand** (first command / stream / pre-warm)
 * and **auto-closes** it after an idle window whose length depends on the station's power tier.
 *
 * Pure transport: it knows nothing about capabilities or events. The power tier per station
 * (`wired` = mains HomeBase / plugged camera → persistent; `battery` = standalone battery cam → short
 * idle-detach) is injected as plain data via {@link SessionManagerOpts.poweredFor} by the facade, so
 * `model/` is never imported here (the decorrelation invariant).
 *
 * Refcount model — ONE counter per station, shared by every "reason to stay connected": a live stream
 * retains it while any viewer is attached; a control command and a speculative pre-warm (e.g. a doorbell
 * ring) each take a **hold**, which retains it and then releases itself when its timer expires. When the
 * counter hits zero the idle timer arms; a new retain cancels it. `wired` stations use an infinite
 * window (never auto-close); `battery` stations a short one.
 *
 * A hold is distinguished from an attached viewer only for {@link SessionManager.resetWhenUnused},
 * which may close through expiring holds but must wait for a real viewer.
 *
 * @module transport/p2p/session-manager
 */
import { Timer } from "../../core/util.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { P2PSession } from "./p2p-session.js";

/** A station's power tier — governs its idle window. */
export type PowerTier = "wired" | "battery";

/**
 * A station open was abandoned because its entry was closed or superseded while the factory ran.
 *
 * Distinct from a connect failure: nothing is wrong with the device, the caller's reason to open it
 * simply stopped applying. A speculative caller treats this as a non-event; anyone who asked for the
 * session on a caller's behalf must still surface it.
 */
export class SessionSupersededError extends Error {}

/** Default idle window for a battery station before its session is closed to let the device sleep. */
export const BATTERY_IDLE_MS = 300_000;
/** How long a single control command holds a session warm after dispatch (a burst keeps re-holding). */
export const COMMAND_KEEPALIVE_MS = 15_000;
/**
 * Default window a speculative pre-warm (e.g. after a doorbell ring) holds its user for. Expiring
 * releases that user; it does not close the session — the station's own idle window then runs, so an
 * unattended pre-warm on a battery station costs this plus {@link BATTERY_IDLE_MS}.
 */
export const PREWARM_MS = 28_000;

/**
 * Per-station lifecycle state. `session` is the live connection (absent while cold); `retained` counts
 * the active reasons to stay connected; `holdTimers` is the subset of those that expire on their own, so
 * its size IS the hold count and a discarded entry cannot leave one running; `idle` is armed only when
 * `retained` is zero; `connecting` coalesces concurrent cold opens.
 *
 * The power tier is deliberately NOT stored: it is resolved per idle-arm, so a station whose battery
 * evidence arrives after its first session still gets the right window. `station` IS stored, because a
 * key is not always a station serial and the tier is a property of the hardware rather than of the
 * connection: every session to one station shares its power tier and its idle window length.
 */
interface SessionEntry {
  station: string;
  session?: P2PSession;
  retained: number;
  holdTimers: Set<ReturnType<typeof setTimeout>>;
  reset?: PromiseWithResolvers<void>;
  idle: Timer;
  connecting?: Promise<P2PSession>;
}

export interface SessionManagerOpts {
  /** Idle window for battery stations (ms). Default {@link BATTERY_IDLE_MS}. */
  batteryIdleMs?: number;
  /** Keepalive a single command holds after dispatch (ms). Default {@link COMMAND_KEEPALIVE_MS}. */
  commandKeepAliveMs?: number;
  /**
   * Power tier per station serial — injected by the facade (no model import). Default: everything
   * `wired`. Asked about the STATION a session connects to, never the key it is filed under, so every
   * session to one station gets that station's idle window.
   */
  poweredFor?: (parentSn: string) => PowerTier;
  /**
   * Called with the KEY of a session the manager closed on its OWN initiative — an elapsed idle window,
   * or a deferred reset falling due. The key, not the station: several sessions can share a station and
   * only the one that closed is stale, so an owner told the station would tear down connections that are
   * still serving.
   *
   * Those two are the only closes with no caller to follow up: everything riding the session is stale the
   * moment it goes, and only the owner knows what that is. A close a caller asked for is that caller's to
   * clean up after, which is why this does not fire for {@link SessionManager.close},
   * {@link SessionManager.closeAll}, or a superseded open.
   */
  onAutoClose?: (key: string) => void;
  /** Diagnostics sink for the lifecycle transitions (open / idle-arm / detach). Omit for silence. */
  logger?: Logger;
}

/**
 * Manages P2P sessions by **key**, each recording the station it connects to. The router builds and
 * wires the actual `P2PSession` (it owns the socket and event fan-out); this decides open/close timing.
 *
 * A key is the station's serial for the one session that carries its control traffic and its events.
 * Where a station has to serve more than one camera at once it also holds a session per camera, filed
 * under a key of the router's choosing and recording the same station — so each has its own refcount and
 * its own idle window, and releasing one never disturbs another.
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  /** Invalidates station factories that finish after {@link closeAll}. */
  private generation = 0;
  private readonly logger: Logger;

  constructor(private readonly opts: SessionManagerOpts = {}) {
    this.logger = opts.logger ?? noopLogger;
  }

  /** The live session for a station, or `undefined` if not open. */
  get(key: string): P2PSession | undefined {
    return this.entries.get(key)?.session;
  }

  /** Keys of the open sessions. */
  keys(): string[] {
    return [...this.entries].filter(([, e]) => e.session).map(([sn]) => sn);
  }

  /** A plain `Map<key, P2PSession>` snapshot of the open sessions (for `getSessions()` / tests). */
  liveSessions(): Map<string, P2PSession> {
    const m = new Map<string, P2PSession>();
    for (const [sn, e] of this.entries) if (e.session) m.set(sn, e.session);
    return m;
  }

  /**
   * Get or create the lifecycle entry under `key`, recording which station it connects to. An existing
   * entry keeps the station it was opened with — the key owns one connection for its lifetime, and a
   * later caller passing a different station would otherwise re-point a live entry's power tier.
   */
  private entry(key: string, station: string): SessionEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { station, retained: 0, holdTimers: new Set(), idle: new Timer() };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * Register an already-built session for test seeding or an externally assembled connection.
   *
   * `station` defaults to the key, which is safe HERE and nowhere else in this class: the paths that open a
   * session under a key that is not a station serial all go through {@link acquire}, which requires it. A
   * caller seeding one under such a key must pass it.
   */
  register(key: string, session: P2PSession, station: string = key): void {
    this.entry(key, station).session = session;
  }

  /**
   * Ensure a session to `key` is open, building it via `factory` if cold. Concurrent calls for the
   * same cold station share ONE connect (the `connecting` promise); `factory` builds + wires + awaits
   * `connect()` and resolves the connected session.
   */
  async acquire(
    key: string,
    factory: (register: (session: P2PSession) => void) => Promise<P2PSession>,
    station: string,
  ): Promise<P2PSession> {
    const e = this.entry(key, station);
    if (e.connecting) {
      this.logger.debug(`[session ${key}] connecting — joining in-flight open`);
      return e.connecting;
    }
    if (e.session) return e.session;
    this.logger.debug(`[session ${key}] connecting now (on demand)`);
    const generation = this.generation;
    const p = factory((session) => (e.session = session));
    e.connecting = p;
    try {
      const session = await p;
      if (generation !== this.generation || this.entries.get(key) !== e) {
        await session.close();
        throw new SessionSupersededError(`P2P session start superseded for ${key}`);
      }
      e.session ??= session;
      this.logger.debug(`[session ${key}] connected`);
      return e.session;
    } finally {
      if (e.connecting === p) e.connecting = undefined;
    }
  }

  /**
   * Add a reason to stay connected; cancels a pending idle-close.
   *
   * Refused when nothing is open under `key`, for the reason {@link release} gives in the other direction: a
   * retain names a session that was acquired, and one that names nothing would file an entry with no
   * connection behind it. {@link hold} is the path that legitimately creates one, and it opens the entry
   * itself before retaining it.
   */
  retain(key: string): void {
    const e = this.entries.get(key);
    if (!e) {
      this.logger.warn(`[session ${key}] retain on a session that is not open — ignored`);
      return;
    }
    e.retained++;
    if (e.idle.pending) this.logger.debug(`[session ${key}] in use again — idle-detach cancelled`);
    e.idle.cancel();
  }

  /**
   * Release a reason; arm the idle-close when the last one goes.
   *
   * A release with nothing retained is REFUSED rather than clamped to zero. Such a release was never
   * earned on this entry, and letting it proceed would either restart a battery station's idle window
   * from scratch or complete a deferred reset a real viewer has not yet earned. Clamping to zero did
   * both silently.
   */
  release(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    if (e.retained === 0) {
      this.logger.warn(`[session ${key}] release with nothing retained — ignored`);
      return;
    }
    e.retained -= 1;
    if (e.reset && e.retained <= e.holdTimers.size) {
      void this.autoClose(key).catch((error) => this.logger.error(`[session ${key}] deferred reset failed`, error));
      return;
    }
    if (e.retained === 0) this.armIdle(key, e);
  }

  /** Re-evaluate idle timers for a station after its operating power claim changes. */
  refreshPower(station: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.station === station && entry.session && entry.retained === 0) this.armIdle(key, entry);
    }
  }

  /**
   * Hold a session warm for `commandKeepAliveMs` after a control command, then release. A burst of
   * commands each re-holds before the previous release fires, so the session never idles mid-burst.
   */
  bumpCommand(key: string, station: string): void {
    this.hold(key, this.opts.commandKeepAliveMs ?? COMMAND_KEEPALIVE_MS, station);
  }

  /**
   * Retain a session and release it again after `ms` — the primitive behind command-keepalive and event
   * pre-warm, and the only way to hold one open without an attachment to release it.
   *
   * `station` is required rather than defaulted from the key, because this is the one path that can
   * CREATE an entry: a pre-warm takes its hold before the open. An entry filed under a media key with
   * that key as its own station would be asked for the power tier of a serial that does not exist, be
   * answered `wired`, and never idle-detach — which on a battery station is the drain this class exists
   * to prevent, and is invisible until the battery is flat.
   *
   * The timer is owned by the entry, so {@link discard} cancels it. That ownership is the point: keyed
   * only by serial, an expiring hold would otherwise outlive the entry it was taken on and release a
   * retain counted by the SUCCESSOR entry — dropping a live viewer's count and arming an idle-detach
   * underneath it.
   */
  hold(key: string, ms: number, station: string): void {
    const entry = this.entry(key, station);
    this.retain(key);
    const timer = setTimeout(() => {
      entry.holdTimers.delete(timer);
      this.release(key);
    }, ms);
    timer.unref?.();
    entry.holdTimers.add(timer);
  }

  /**
   * Arm the idle-close timer for a station whose retain count just reached zero. A wired station with
   * an infinite window is left persistent (no timer). Any subsequent {@link retain} cancels it.
   */
  private armIdle(key: string, e: SessionEntry): void {
    e.idle.cancel();
    if ((this.opts.poweredFor?.(e.station) ?? "wired") !== "battery") {
      this.logger.debug(`[session ${key}] idle (nothing retained) — staying persistent (wired)`);
      return;
    }
    const idleMs = this.opts.batteryIdleMs ?? BATTERY_IDLE_MS;
    this.logger.debug(`[session ${key}] idle (nothing retained) — detaching in ${idleMs}ms unless reused`);
    e.idle.arm(idleMs, () => this.onIdle(key));
  }

  /**
   * Close a station's session once its idle window elapses with nothing retained, letting the device sleep.
   * Re-checks the count first (activity between the timer firing and now re-arms instead). Dropping the
   * entry here and the session's own `close` → {@link remove} are both idempotent.
   */
  private onIdle(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    if (e.retained > 0) return;
    this.logger.debug(`[session ${key}] idle window elapsed — disconnecting now (device can sleep)`);
    void this.autoClose(key).catch((error) => this.logger.error(`[session ${key}] idle detach failed`, error));
  }

  /**
   * Close a station the manager itself decided to close, and announce it.
   *
   * The announcement is the whole point: {@link SessionManagerOpts.onAutoClose} is how the owner learns
   * about a teardown it did not request, and so the only way anything riding the session — a lingering
   * live source, a talkback — gets dropped rather than handed out again over a dead connection.
   *
   * It fires the moment the entry is discarded, BEFORE the socket teardown and before any deferred reset
   * settles. That is deliberate on both counts: from the instant the entry is gone a fresh acquisition
   * resolves a new session while a cached source still points at the old one, so announcing later leaves
   * a window in which a viewer can attach to a stale source; and a caller awaiting a reset should find
   * the station's riders already dropped when it resumes.
   *
   * An entry that never carried a session is still torn down, but silently: a pre-warm whose open failed
   * leaves one behind, and announcing it would report a station closed that was never reported open.
   */
  private async autoClose(key: string): Promise<void> {
    const entry = this.discard(key);
    if (!entry) return;
    if (entry.session) this.opts.onAutoClose?.(key);
    await this.closeEntry(entry);
  }

  /** Drop a station's entry + timer (called from the session's `close` handler). Idempotent. */
  remove(key: string): void {
    const entry = this.discard(key);
    if (entry) this.settleReset(entry);
  }

  /** Close one station now and discard its lifecycle entry. */
  async close(key: string): Promise<void> {
    const entry = this.discard(key);
    if (entry) await this.closeEntry(entry);
  }

  /**
   * Reset once every viewer detaches, ignoring only expiring holds.
   *
   * Every caller that arrives while one is already pending gets the SAME promise: the outcome is a
   * property of the station's teardown, not of who asked, so one deferred per entry is the whole
   * mechanism — and it cannot grow with the number of callers.
   *
   * Both branches close through {@link autoClose}: the caller asked for a recycle, not for the station's
   * live sources to be dropped, so it does not clean up after one — exactly like the idle path.
   */
  resetWhenUnused(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.retained <= entry.holdTimers.size) return this.autoClose(key);
    entry.reset ??= Promise.withResolvers<void>();
    return entry.reset.promise;
  }

  /** Settle a discarded entry's reset callers with the same outcome as its session close. */
  private settleReset(entry: SessionEntry, failure?: { error: unknown }): void {
    const reset = entry.reset;
    if (!reset) return;
    entry.reset = undefined;
    if (failure) reset.reject(failure.error);
    else reset.resolve();
  }

  /** Close one discarded entry and settle only its own reset callers before preserving any failure. */
  private async closeEntry(entry: SessionEntry): Promise<void> {
    try {
      await entry.session?.close();
      this.settleReset(entry);
    } catch (error) {
      this.settleReset(entry, { error });
      throw error;
    }
  }

  /**
   * Discard one lifecycle entry and return it for bounded close/reset completion.
   *
   * Every timer the entry owns dies with it — the idle window and any hold still counting down. A
   * discarded entry owns no live timer, which is what stops a deferred release from landing on whatever
   * entry next occupies this serial.
   */
  private discard(key: string): SessionEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.idle.cancel();
    for (const timer of entry.holdTimers) clearTimeout(timer);
    entry.holdTimers.clear();
    this.entries.delete(key);
    return entry;
  }

  /** Close every session and clear all timers. */
  async closeAll(): Promise<void> {
    this.generation++;
    const entries = [...this.entries.keys()].flatMap((key) => {
      const entry = this.discard(key);
      return entry ? [entry] : [];
    });
    const results = await Promise.allSettled(entries.map((entry) => this.closeEntry(entry)));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "multiple P2P sessions failed to close");
  }
}
