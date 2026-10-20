/**
 * RTC command router: drives a station over the portal's WebRTC data channel instead of P2P.
 *
 * The T9000 answers no P2P lookup, but it accepts the portal's control channel: sign → WS join → scall →
 * SDP answer → ICE over the relay the hub grants → DTLS → SCTP data channels, with commands riding
 * `WebrtcDataChannel` as portal packets (see {@link buildPortalPacket}).
 *
 * `set-payload` rides the `1350` SET_PAYLOAD envelope, inner `{account_id, cmd, mValue3, payload}`;
 * `set-json` rides the `1700` CONTROL_PAYLOAD envelope, inner `{account_id, cmd, commandType, data}`.
 * A command to the station goes on the station channel `255`; an attached device's command shares the
 * station's session and keeps the device's channel. Other command kinds are refused.
 *
 * One session per station, reused across commands and closed after {@link IDLE_CLOSE_MS} without one;
 * a live pull holds it open. Sends on a session are serialised; an ACK is correlated by its outer command
 * and segment, since it carries no inner command. An ACK is not an observation of the resulting state.
 *
 * Live view of an attached camera rides the same session (the hub accepts one RTC session per account),
 * through one shared live source per station: the station serves one camera at a time, so a second
 * camera is refused until the first one's view ends.
 */
import {
  LiveSnapshotUnavailableError,
  type AbortableCall,
  type Command,
  type MediaProvider,
  type SharedSourceHints,
} from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { abortable } from "../abortable.js";
import { captureSnapshotFromShared } from "../p2p/media.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import { SharedLiveSource, attachUnlessAborted } from "../p2p/shared-live-source.js";
import { RtcLiveStream } from "./live.js";
import { PORTAL_KEEPALIVE, PORTAL_KEEPALIVE_MS } from "./portal-keepalive.js";
import { RtcCallLiveStream } from "./call-live.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import {
  buildPortalPacket,
  parsePortalPacket,
  PORTAL_CMD_SET_PAYLOAD,
  PORTAL_STATION_CHANNEL,
  PortalLinkType,
  SegmentCounter,
} from "./portal-packet.js";

/** The CONTROL_PAYLOAD envelope for a commandType/data request. */
const PORTAL_CMD_CONTROL_PAYLOAD = 1700;
/** The envelope carrying a correlated JSON control result. */
const PORTAL_CMD_NOTIFY_PAYLOAD = 1351;

/** How long a command waits for its envelope ACK. */
const ACK_TIMEOUT_MS = 8_000;
/**
 * How long a session has to come up. A healthy hub answers in ~2 s; the bound sits under the ~15 s a
 * service call is commonly given, so a hub outage surfaces as this router's error.
 */
const CONNECT_TIMEOUT_MS = 12_000;
/** An idle station session is closed after this long. */
const IDLE_CLOSE_MS = 60_000;

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The `gtoken` header value the mega session's authed HTTP calls carry. */
  gtoken: string;
}

/** Where a command goes: the station's session, and whether it addresses the station or a device on it. */
export interface RtcRoute {
  /** The station's signaling exchange; defaults to compact SDP. */
  signalingMode?: "call" | "scall";
  /** Candidate policy used by the station's exchange; defaults to relay-only. */
  iceTransportPolicy?: "relay" | "all";
  /**
   * The station streams video as RTP on its offer's video track and serves no data channel, so it takes
   * no portal command; see `RtcPeerOptions.mediaTrack`.
   */
  mediaTrack?: boolean;
  stationSn: string;
  /**
   * The station's `member.admin_user_id`, the account the session and the payload name; the logged-in
   * user when the station's record carries none.
   */
  adminUserId?: string;
  /** True for a device attached to the station, which keeps the command's own channel. */
  attached: boolean;
}

/** The camera a live view is for, on its station's route. */
export interface RtcLiveRoute extends RtcRoute {
  cameraSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`); picks the smart host. */
  shard: () => string | Promise<string>;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  logger?: Logger;
  onError?: (e: Error) => void;
  /** ffmpeg for the live still (`ffmpeg` on PATH by default). */
  ffmpegPath?: string;
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

/** A station's live pull: the camera it serves and its shared source. */
interface StationLive {
  cameraSn: string;
  source: SharedLiveSource;
}

interface StationSession {
  session: RtcSession;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises sends so ACKs can't be attributed to the wrong command. */
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
  /** Live pulls holding the session open. */
  leases: number;
}

/**
 * A {@link RtcCommandRouter.keepWarm} hold on one station: the keepalive timer sending
 * {@link PORTAL_KEEPALIVE}, the session listeners that end it and record the hub's echo, and whether the
 * last keepalive sent is still unechoed.
 */
interface WarmHold {
  keepalive?: ReturnType<typeof setInterval>;
  /** The station session the hold leases, and its `close` and `keepaliveEcho` listeners the disposer removes. */
  watch?: { st: StationSession; onClose: () => void; onEcho: () => void };
  /** A keepalive went out and the hub has not echoed it since. */
  awaitingEcho: boolean;
  dispose: () => void;
}

/**
 * A live start for one camera while the station streams another: the station streams one camera at a
 * time. A live still refused this way is a {@link LiveSnapshotUnavailableError} with `source-failed`.
 */
class StationStreamBusyError extends Error {
  constructor(stationSn: string, servingSn: string) {
    super(`rtc live: ${stationSn} is serving ${servingSn}; the station streams one camera at a time`);
    this.name = "StationStreamBusyError";
  }
}

export class RtcCommandRouter {
  private readonly sessions = new Map<string, StationSession>();
  private readonly lives = new Map<string, StationLive>();
  private readonly warm = new Map<string, WarmHold>();
  private readonly callSources = new Map<string, SharedLiveSource>();
  /** The latest shard each `call` source resolved, read by its `makeStream` (see {@link trackMediaProviderFor}). */
  private readonly callShards = new Map<string, string>();

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  async dispatchCommand(route: RtcRoute, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload" && cmd.kind !== "set-json") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the RTC control channel (only set-payload or set-json)`);
    }
    if (route.mediaTrack) throw new Error(`rtc: ${route.stationSn} serves media only and takes no portal command`);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${route.stationSn}`);
    const { stationSn } = route;
    const adminUserId = route.adminUserId || identity.userId;
    const channel = route.attached ? cmd.channel : PORTAL_STATION_CHANNEL;
    const st = await this.stationSession(route, adminUserId, identity);
    const outerCmd = cmd.kind === "set-json" ? PORTAL_CMD_CONTROL_PAYLOAD : PORTAL_CMD_SET_PAYLOAD;
    const innerCmd = cmd.kind === "set-json" ? cmd.param : cmd.cmd;
    const payload =
      cmd.kind === "set-json"
        ? { account_id: adminUserId, cmd: cmd.param, commandType: cmd.param, data: cmd.data }
        : { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload };
    const segment = st.seg.next();
    const packet = buildPortalPacket({ commandId: outerCmd, channel, segment, payload });
    const run = st.queue.then(() => this.sendAwaitAck(stationSn, st, packet, outerCmd, innerCmd, channel, segment));
    st.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The media of a camera on a T9000: live video, a readable feed and a live still over the station's
   * session. Recording has no wire here and is refused; the optional members it has no wire for are absent.
   */
  mediaProviderFor(route: RtcLiveRoute): MediaProvider {
    return {
      live: (opts) => this.withLiveSource(route, opts ?? {}, (source) => attachUnlessAborted(source, opts?.signal)),
      openReadable: (opts) =>
        this.withLiveSource(route, opts ?? {}, (source) =>
          openReadableFromConsumer(attachUnlessAborted(source, opts?.signal), opts),
        ),
      snapshotLive: (opts) =>
        this.withLiveSource(route, opts ?? {}, (source) =>
          captureSnapshotFromShared(source, { ...opts, logger: this.deps.logger, ffmpegPath: this.deps.ffmpegPath }),
        ).catch((e: unknown) => {
          if (!(e instanceof StationStreamBusyError)) throw e;
          throw new LiveSnapshotUnavailableError("source-failed", e.message, { cause: e });
        }),
      record: async () => {
        throw new Error(`record is not available for ${route.cameraSn} over the T9000 control channel`);
      },
    };
  }

  /**
   * Live view of a station on a {@link RtcRoute.mediaTrack} route: a live feed, a readable feed and a live
   * still, from one shared source per station whose every warm-up places a fresh `call` on its own
   * session. Recording has no wire here and is refused.
   *
   * `SharedLiveSource` calls `makeStream` synchronously, so the shard cannot be awaited inside it. Each
   * async entry point resolves the shard and records it in {@link callShards} before touching the source;
   * `makeStream` reads the latest recorded value.
   */
  trackMediaProviderFor(route: RtcRoute): MediaProvider {
    const sn = route.stationSn;
    const sourceFor = (hints: SharedSourceHints = {}): SharedLiveSource => {
      let source = this.callSources.get(sn);
      if (!source) {
        source = new SharedLiveSource({
          makeStream: () => {
            const identity = this.deps.identity();
            if (!identity) throw new Error(`rtc: not logged in, cannot call ${sn}`);
            const shard = this.callShards.get(sn);
            if (shard === undefined) throw new Error(`rtc: no shard resolved for ${sn}`);
            const session = this.newSession(route, route.adminUserId || identity.userId, identity, shard);
            return new RtcCallLiveStream(session, this.deps.logger);
          },
          label: sn,
          logger: this.deps.logger,
          powered: hints.powered,
          preBufferSeconds: hints.preBufferSeconds,
          warmTimeoutMs: 45_000,
        });
        this.callSources.set(sn, source);
      }
      return source;
    };
    const resolveShard = async (): Promise<void> => {
      this.callShards.set(sn, await this.deps.shard());
    };
    return {
      live: async (opts) => {
        await resolveShard();
        return attachUnlessAborted(sourceFor(opts), opts?.signal);
      },
      openReadable: async (opts) => {
        await resolveShard();
        return openReadableFromConsumer(attachUnlessAborted(sourceFor(opts), opts?.signal), opts);
      },
      snapshotLive: async (opts) => {
        await resolveShard();
        return captureSnapshotFromShared(sourceFor(opts), {
          ...opts,
          logger: this.deps.logger,
          ffmpegPath: this.deps.ffmpegPath,
        });
      },
      record: async () => {
        throw new Error(`record is not available for ${sn} over a portal call`);
      },
    };
  }

  /**
   * Tear down every station session (logout / shutdown). Each live source is disposed before its session
   * closes, so its consumers end cleanly and its stop still rides the session.
   */
  close(): void {
    for (const [sn, src] of this.callSources) {
      this.callSources.delete(sn);
      this.callShards.delete(sn);
      src.dispose();
    }
    for (const [sn, live] of this.lives) {
      this.lives.delete(sn);
      live.source.dispose();
    }
    for (const [sn, st] of this.sessions) this.drop(sn, st);
  }

  /**
   * Hand `use` the station's live source for this camera, in the same turn the source is created or reused,
   * so a consumer it attaches is counted before any other caller looks.
   *
   * The station streams one camera at a time. Another camera whose source has consumers refuses this one,
   * before the session is awaited and again after; one with none (never attached or lingering)
   * holds nothing a viewer needs, so it is disposed and the slot taken. The first caller's
   * {@link SharedSourceHints} configure a new source.
   */
  private async withLiveSource<T>(
    route: RtcLiveRoute,
    opts: SharedSourceHints & AbortableCall,
    use: (source: SharedLiveSource) => T,
  ): Promise<Awaited<T>> {
    opts.signal?.throwIfAborted();
    this.refuseIfWatched(route);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot open ${route.stationSn}`);
    const accountId = route.adminUserId || identity.userId;
    const st = await abortable(this.stationSession(route, accountId, identity), opts.signal);
    this.refuseIfWatched(route);
    const current = this.lives.get(route.stationSn);
    if (current && current.cameraSn !== route.cameraSn) {
      this.deps.logger?.debug?.(
        `[rtc] ${route.stationSn} releasing the unwatched source of ${current.cameraSn} for ${route.cameraSn}`,
      );
      this.lives.delete(route.stationSn);
      current.source.dispose();
    }
    let live = this.lives.get(route.stationSn);
    if (!live) {
      live = { cameraSn: route.cameraSn, source: this.newLiveSource(route, st, accountId, opts) };
      this.lives.set(route.stationSn, live);
    }
    return await use(live.source);
  }

  /** Refuse a camera while another camera on its station has consumers. */
  private refuseIfWatched(route: RtcLiveRoute): void {
    const current = this.lives.get(route.stationSn);
    if (current && current.cameraSn !== route.cameraSn && current.source.consumerCount > 0) {
      throw new StationStreamBusyError(route.stationSn, current.cameraSn);
    }
  }

  private newLiveSource(
    route: RtcLiveRoute,
    st: StationSession,
    accountId: string,
    hints: SharedSourceHints,
  ): SharedLiveSource {
    let leased = false;
    const release = () => {
      if (!leased) return;
      leased = false;
      st.leases = Math.max(0, st.leases - 1);
      this.touch(route.stationSn, st);
    };
    const source: SharedLiveSource = new SharedLiveSource({
      makeStream: () =>
        new RtcLiveStream({
          session: st.session,
          seg: st.seg,
          stationSn: route.stationSn,
          channel: route.channel,
          accountId,
          logger: this.deps.logger,
        }),
      label: `${route.stationSn}#${route.channel}`,
      logger: this.deps.logger,
      powered: hints.powered,
      preBufferSeconds: hints.preBufferSeconds,
      onActive: () => {
        if (leased) return;
        leased = true;
        st.leases++;
        if (st.idle) clearTimeout(st.idle);
      },
      onStopped: () => {
        release();
        if (this.lives.get(route.stationSn)?.source === source) this.lives.delete(route.stationSn);
      },
    });
    return source;
  }

  /**
   * Completes on the command ACK or a correlated control-result notification. The notification must
   * match the request channel, parameter and segment and contain a structured payload. Receipt does
   * not establish physical actuation. The command is sent once, bounded by {@link ACK_TIMEOUT_MS}.
   */
  private sendAwaitAck(
    sn: string,
    st: StationSession,
    packet: Buffer,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    segment: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        if (!p || p.segment !== segment) return;
        const acknowledgement = linkType === PortalLinkType.COMMAND && p.commandId === outerCmd && !!p.isResponse;
        const d = p.data as { payload?: unknown } | null | undefined;
        const notification =
          outerCmd === PORTAL_CMD_CONTROL_PAYLOAD &&
          linkType === PortalLinkType.NOTIFY &&
          p.commandId === PORTAL_CMD_NOTIFY_PAYLOAD &&
          p.isResponse === 0 &&
          p.channel === channel &&
          p.cmd === innerCmd &&
          typeof d?.payload === "object" &&
          d.payload !== null;
        if (!acknowledgement && !notification) return;
        cleanup();
        if (acknowledgement && p.errCode !== 0) {
          reject(new Error(`rtc: ${sn} rejected cmd ${innerCmd} (err ${p.errCode})`));
        } else {
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} acked`);
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`rtc: ${sn} session closed while waiting for cmd ${innerCmd} ACK`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ACK timed out after ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        this.touch(sn, st);
      };
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      if (!st.session.sendCommand(packet)) {
        cleanup();
        reject(new Error(`rtc: ${sn} command channel not open, cmd ${innerCmd} not sent`));
      }
    });
  }

  private newSession(route: RtcRoute, adminUserId: string, identity: RtcIdentity, shard: string): RtcSession {
    return (this.deps.createSession ?? ((o: RtcSessionOptions) => new RtcSession(o)))({
      authToken: identity.authToken,
      gtoken: identity.gtoken,
      stationSn: route.stationSn,
      adminUserId,
      shard,
      country: this.deps.country ?? "US",
      logger: this.deps.logger,
      signalingMode: route.signalingMode,
      peer: { logger: this.deps.logger, iceTransportPolicy: route.iceTransportPolicy, mediaTrack: route.mediaTrack },
    });
  }

  /** A connected session for `sn` to reuse, or undefined (dropping a dead one). */
  private async reusable(sn: string): Promise<StationSession | undefined> {
    const st = this.sessions.get(sn);
    if (!st) return undefined;
    await st.ready;
    if (st.session.isConnected) {
      this.touch(sn, st);
      return st;
    }
    this.drop(sn, st);
    return undefined;
  }

  /**
   * Get or open the station's session. A connected session is reused before the shard is awaited, so a
   * command on an already-connected station never waits on the unauthenticated `estimate_domain` round
   * trip — only the create path awaits it. After the await the map is re-checked, with no `await` between
   * the lookup and `this.sessions.set`, so concurrent creators still share one session.
   */
  private async stationSession(route: RtcRoute, adminUserId: string, identity: RtcIdentity): Promise<StationSession> {
    const sn = route.stationSn;
    const reused = await this.reusable(sn);
    if (reused) return reused;
    const shard = await this.deps.shard();
    if (this.sessions.has(sn)) {
      const again = await this.reusable(sn);
      if (again) return again;
    }
    const session = this.newSession(route, adminUserId, identity, shard);
    const ready = this.bringUp(sn, session);
    const st: StationSession = { session, seg: new SegmentCounter(), ready, queue: Promise.resolve(), leases: 0 };
    session.on("error", (e) => this.deps.onError?.(e));
    session.on("close", () => {
      if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    });
    this.sessions.set(sn, st);
    try {
      await ready;
    } catch (e) {
      this.drop(sn, st);
      throw e;
    }
    this.touch(sn, st);
    return st;
  }

  /**
   * One bounded bring-up: the session is up when its command channel opens, and it fails, with the
   * session closed and every listener gone, when `connect()` throws, the session closes first, or
   * {@link CONNECT_TIMEOUT_MS} passes. A single promise, so an early failure cannot leave a second one
   * rejecting unheard.
   */
  private bringUp(sn: string, session: RtcSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("connected", onConnected);
        session.off("close", onClose);
        if (err) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          this.deps.logger?.info?.(`[rtc] ${sn} command channel up`);
          resolve();
        }
      };
      const onConnected = () => finish();
      const onClose = () => finish(new Error(`rtc: ${sn} session closed before the command channel opened`));
      const timer = setTimeout(
        () => finish(new Error(`rtc: ${sn} did not come up within ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      session.once("connected", onConnected);
      session.once("close", onClose);
      Promise.resolve()
        .then(() => session.connect())
        .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }

  /**
   * Hold a station's command session open: one hold per station, its idle-close ({@link IDLE_CLOSE_MS})
   * suppressed, {@link PORTAL_KEEPALIVE} sent every {@link PORTAL_KEEPALIVE_MS}, and the session dropped
   * on a tick that finds the previous keepalive unechoed. A closed session ends the hold.
   *
   * Answers an idempotent disposer that releases the hold. Throws when no account is logged in.
   */
  keepWarm(route: RtcRoute): () => void {
    const sn = route.stationSn;
    const existing = this.warm.get(sn);
    if (existing) return existing.dispose;
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot warm ${sn}`);
    const hold: WarmHold = {
      awaitingEcho: false,
      dispose: () => {
        if (this.warm.get(sn) !== hold) return;
        this.warm.delete(sn);
        const st = hold.watch?.st;
        this.unwatch(hold);
        if (st) {
          st.leases = Math.max(0, st.leases - 1);
          this.touch(sn, st);
        }
      },
    };
    this.warm.set(sn, hold);
    void this.warmUp(sn, route, identity, hold);
    return hold.dispose;
  }

  /**
   * Bring a station session up for a {@link keepWarm} hold and start its keepalive. A bring-up that fails,
   * or a hold disposed before it completes, clears the hold and arms no timer. Each tick first checks
   * that the hub echoed the previous keepalive, and drops the session when it did not. The keepalive
   * stops when the session closes, which also clears the hold so the next command or `keepWarm`
   * rebuilds cleanly.
   */
  private async warmUp(sn: string, route: RtcRoute, identity: RtcIdentity, hold: WarmHold): Promise<void> {
    const adminUserId = route.adminUserId || identity.userId;
    let st: StationSession;
    try {
      st = await this.stationSession(route, adminUserId, identity);
    } catch (e) {
      if (this.warm.get(sn) === hold) this.warm.delete(sn);
      this.deps.onError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (this.warm.get(sn) !== hold) {
      this.touch(sn, st);
      return;
    }
    st.leases++;
    this.touch(sn, st);
    const onClose = (): void => {
      this.unwatch(hold);
      if (this.warm.get(sn) === hold) this.warm.delete(sn);
    };
    const onEcho = (): void => {
      hold.awaitingEcho = false;
    };
    hold.watch = { st, onClose, onEcho };
    st.session.once("close", onClose);
    st.session.on("keepaliveEcho", onEcho);
    hold.keepalive = setInterval(() => {
      if (hold.awaitingEcho) {
        this.deps.logger?.warn?.(`[rtc] ${sn} warm keepalive went unechoed, dropping the session`);
        this.drop(sn, st);
        return;
      }
      hold.awaitingEcho = true;
      st.session.sendRaw(PORTAL_KEEPALIVE);
    }, PORTAL_KEEPALIVE_MS);
    hold.keepalive.unref?.();
  }

  /** Stop a hold's keepalive and remove its listeners from the session it watches. */
  private unwatch(hold: WarmHold): void {
    if (hold.keepalive) clearInterval(hold.keepalive);
    hold.keepalive = undefined;
    if (hold.watch) {
      hold.watch.st.session.off("close", hold.watch.onClose);
      hold.watch.st.session.off("keepaliveEcho", hold.watch.onEcho);
    }
    hold.watch = undefined;
  }

  private touch(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (st.leases > 0) return;
    st.idle = setTimeout(() => this.drop(sn, st), IDLE_CLOSE_MS);
    st.idle.unref?.();
  }

  private drop(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    try {
      st.session.close();
    } catch {
      /* already gone */
    }
  }
}
