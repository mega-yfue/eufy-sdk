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
 * The station's own database is read over the same channel: a `set-payload` with inner `1306`
 * (CMD_DATABASE) answers a table and inner `1308` (CMD_DATABASE_IMAGE) a stored image, each as one
 * notify frame carrying the whole document, zstd-compressed when large. The notify link carries
 * unrelated station reports between them, so a reply is matched by its content, never by arrival order.
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
  type LiveStreamHandle,
  type SharedSourceHints,
  type MediaSourceSelection,
} from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { abortable } from "../abortable.js";
import { captureSnapshotFromShared } from "../p2p/media.js";
import {
  CMD_DATABASE,
  CMD_DATABASE_IMAGE,
  DB_QUERY,
  DB_TABLE_TIMEOUT_MS,
  fullTableQuery,
} from "../p2p/database-wire.js";
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
  shard: () => string;
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

/** What a send waits for instead of its ACK: the notify body `pick` claims, its bound, and its abort. */
interface StationReply<T> {
  pick: (body: Record<string, unknown>) => T | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  private lastTransaction = 0;

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  async dispatchCommand(route: RtcRoute, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload" && cmd.kind !== "set-json") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the RTC control channel (only set-payload or set-json)`);
    }
    if (route.mediaTrack) throw new Error(`rtc: ${route.stationSn} serves media only and takes no portal command`);
    const channel = route.attached ? cmd.channel : PORTAL_STATION_CHANNEL;
    if (cmd.kind === "set-json") {
      return this.sendQueued(route, PORTAL_CMD_CONTROL_PAYLOAD, cmd.param, channel, {
        cmd: cmd.param,
        commandType: cmd.param,
        data: cmd.data,
      });
    }
    return this.sendQueued(route, PORTAL_CMD_SET_PAYLOAD, cmd.cmd, channel, {
      cmd: cmd.cmd,
      mValue3: cmd.mValue3 ?? 0,
      payload: cmd.payload,
    });
  }

  /**
   * Query one on-station table over the station's control channel and answer its rows.
   *
   * Sends the `1350` envelope with inner `{cmd: 1306, payload: {cmd: 10000, table, payload, transaction}}`,
   * the whole-table query, on the station channel. The hub ACKs on the command link and answers with one notify frame whose body
   * carries `{cmd, table, data, mIntRet, msg, transaction, …}`, echoing the read's `transaction`; that echo
   * is the only thing a reply is attributed by, and every read sends a `transaction` no other read on this
   * router has sent. Resolves with the reply's `data` rows. Rejects with the hub's `msg` on a non-zero
   * `mIntRet`, on an ACK refusing the envelope, at once when `signal` aborts (queued or sent), when the
   * session closes, and when `timeoutMs` (default {@link DB_TABLE_TIMEOUT_MS}) elapses with no reply.
   *
   * One read or command at a time per station: the read holds the station's send queue until it settles.
   */
  readTable(
    route: RtcRoute,
    table: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown[]> {
    const transaction = this.nextTransaction();
    const inner = {
      cmd: DB_QUERY.FULL_TABLE,
      table,
      payload: fullTableQuery(),
      transaction,
    };
    return this.sendQueued(
      route,
      PORTAL_CMD_SET_PAYLOAD,
      CMD_DATABASE,
      PORTAL_STATION_CHANNEL,
      { cmd: CMD_DATABASE, mValue3: 0, payload: inner },
      {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        pick: (body) => {
          if (String(body.transaction) !== transaction) return undefined;
          if (typeof body.mIntRet === "number" && body.mIntRet !== 0) {
            throw new Error(`rtc: ${route.stationSn} refused ${table}: ${body.msg ?? body.mIntRet} (${body.mIntRet})`);
          }
          return Array.isArray(body.data) ? body.data : undefined;
        },
      },
    );
  }

  /**
   * Fetch one stored image by its on-station path over the station's control channel.
   *
   * Sends the `1350` envelope with inner `{cmd: 1308, payload: [{file}]}` on the station channel. The hub
   * ACKs on the command link and answers with one notify frame whose body is `{file, content}`, `content`
   * the image in base64, and no `transaction`; the reply is the one whose `file` equals `filePath`. A reply
   * arriving after an abandoned read of the same path carries that path's bytes, which are the bytes a
   * later read of it asks for. Resolves with the decoded bytes. Rejects on an ACK refusing the envelope,
   * at once when `signal` aborts (queued or sent), when the session closes, and when `timeoutMs` (default
   * {@link DB_TABLE_TIMEOUT_MS}) elapses with no reply.
   *
   * One read or command at a time per station: the read holds the station's send queue until it settles.
   */
  readImage(
    route: RtcRoute,
    filePath: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    return this.sendQueued(
      route,
      PORTAL_CMD_SET_PAYLOAD,
      CMD_DATABASE_IMAGE,
      PORTAL_STATION_CHANNEL,
      { cmd: CMD_DATABASE_IMAGE, mValue3: 0, payload: [{ file: filePath }] },
      {
        ...opts,
        pick: (body) =>
          body.file === filePath && typeof body.content === "string" ? Buffer.from(body.content, "base64") : undefined,
      },
    );
  }

  /**
   * A `transaction` stamp in the vendor app's shape, a decimal epoch-in-milliseconds string, strictly
   * greater than the last one this router issued, so two reads in the same millisecond never share one.
   */
  private nextTransaction(): string {
    this.lastTransaction = Math.max(Date.now(), this.lastTransaction + 1);
    return String(this.lastTransaction);
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
   */
  trackMediaProviderFor(route: RtcRoute): MediaProvider {
    return this.callMediaProviderFor(
      route,
      route.stationSn,
      (session) => new RtcCallLiveStream(session, this.deps.logger),
      `record is not available for ${route.stationSn} over a portal call`,
      45_000,
    );
  }

  /** NVR media uses a dedicated call per camera, independent of station commands. */
  nvrMediaProviderFor(route: RtcLiveRoute, views: readonly number[]): MediaProvider {
    return {
      ...this.callMediaProviderFor(
        route,
        route.cameraSn,
        (session, accountId, view) =>
          new RtcLiveStream({
            session,
            seg: new SegmentCounter(),
            stationSn: route.stationSn,
            channel: route.channel,
            accountId,
            logger: this.deps.logger,
            nvr: true,
            view,
          }),
        "record is not available over an NVR portal call",
      ),
      views,
    };
  }

  /** Share a dedicated-call source and its consumer operations under one route key. */
  private callMediaProviderFor(
    route: RtcRoute,
    key: string,
    makeStream: (session: RtcSession, accountId: string, view: number) => LiveStreamHandle,
    recordError: string,
    warmTimeoutMs?: number,
  ): MediaProvider {
    const sourceFor = (opts: SharedSourceHints & AbortableCall & MediaSourceSelection = {}): SharedLiveSource => {
      opts.signal?.throwIfAborted();
      const view = opts.view ?? 0;
      const sourceKey = view === 0 ? key : `${key}:view:${view}`;
      let source = this.callSources.get(sourceKey);
      if (!source) {
        source = new SharedLiveSource({
          makeStream: () => {
            const identity = this.deps.identity();
            if (!identity) throw new Error(`rtc: not logged in, cannot call ${route.stationSn}`);
            const accountId = route.adminUserId || identity.userId;
            return makeStream(this.newSession(route, accountId, identity), accountId, view);
          },
          label: sourceKey,
          logger: this.deps.logger,
          powered: opts.powered,
          preBufferSeconds: opts.preBufferSeconds,
          warmTimeoutMs,
        });
        this.callSources.set(sourceKey, source);
      }
      return source;
    };
    return {
      live: async (opts) => attachUnlessAborted(sourceFor(opts), opts?.signal),
      openReadable: async (opts) => openReadableFromConsumer(attachUnlessAborted(sourceFor(opts), opts?.signal), opts),
      snapshotLive: async (opts) =>
        captureSnapshotFromShared(sourceFor(opts), {
          ...opts,
          logger: this.deps.logger,
          ffmpegPath: this.deps.ffmpegPath,
        }),
      record: async () => {
        throw new Error(recordError);
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
   * Send one envelope on the station's session, queued behind its other sends, and settle as
   * {@link sendAwaitAck} does. `body` is the inner payload; the station session, the `account_id` it is
   * stamped with and the packet are resolved here, so a command and a read reach the wire through the same
   * steps. With `reply.signal`, the caller's wait rejects the moment it aborts, also while the send is still
   * queued; a send not yet made by then is skipped.
   */
  private async sendQueued<T = void>(
    route: RtcRoute,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    body: Record<string, unknown>,
    reply?: StationReply<T>,
  ): Promise<T> {
    reply?.signal?.throwIfAborted();
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${route.stationSn}`);
    const adminUserId = route.adminUserId || identity.userId;
    const st = await abortable(this.stationSession(route, adminUserId, identity), reply?.signal);
    const segment = st.seg.next();
    const packet = buildPortalPacket({
      commandId: outerCmd,
      channel,
      segment,
      payload: { account_id: adminUserId, ...body },
    });
    const run = st.queue.then(() =>
      this.sendAwaitAck(route.stationSn, st, packet, outerCmd, innerCmd, channel, segment, reply),
    );
    st.queue = run.catch(() => undefined);
    return abortable(run, reply?.signal);
  }

  /**
   * Without `reply`, completes on the command ACK or a correlated control-result notification. The
   * notification must match the request channel, parameter and segment and contain a structured payload.
   * Receipt does not establish physical actuation. Bounded by {@link ACK_TIMEOUT_MS}.
   *
   * With `reply`, a zero-result ACK is not the answer: the first notify body (an object) for which
   * `reply.pick` answers a value resolves with it, one `pick` throws on rejects with that error, and every
   * other notify frame is left alone. Bounded by `reply.timeoutMs` (default {@link DB_TABLE_TIMEOUT_MS}),
   * and ended by `reply.signal`; one already aborted is not sent.
   *
   * Either way an ACK with a non-zero result code rejects, and the command is sent once.
   */
  private sendAwaitAck<T = void>(
    sn: string,
    st: StationSession,
    packet: Buffer,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    segment: number,
    reply?: StationReply<T>,
  ): Promise<T> {
    const timeoutMs = reply ? (reply.timeoutMs ?? DB_TABLE_TIMEOUT_MS) : ACK_TIMEOUT_MS;
    const awaited = reply ? "reply" : "ACK";
    return new Promise<T>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        if (!p) return;
        if (reply && linkType === PortalLinkType.NOTIFY && typeof p.data === "object" && p.data !== null) {
          let picked: T | undefined;
          try {
            picked = reply.pick(p.data as Record<string, unknown>);
          } catch (e) {
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (picked === undefined) return;
          cleanup();
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} answered`);
          resolve(picked);
          return;
        }
        if (p.segment !== segment) return;
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
        if (reply && p.errCode === 0) return;
        cleanup();
        if (acknowledgement && p.errCode !== 0) {
          reject(new Error(`rtc: ${sn} rejected cmd ${innerCmd} (err ${p.errCode})`));
        } else {
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} acked`);
          resolve(undefined as T);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`rtc: ${sn} session closed while waiting for cmd ${innerCmd} ${awaited}`));
      };
      const onAbort = () => {
        cleanup();
        reject(reply?.signal?.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ${awaited} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        reply?.signal?.removeEventListener("abort", onAbort);
        this.touch(sn, st);
      };
      if (reply?.signal?.aborted) {
        onAbort();
        return;
      }
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      reply?.signal?.addEventListener("abort", onAbort, { once: true });
      if (!st.session.sendCommand(packet)) {
        cleanup();
        reject(new Error(`rtc: ${sn} command channel not open, cmd ${innerCmd} not sent`));
      }
    });
  }

  private newSession(route: RtcRoute, adminUserId: string, identity: RtcIdentity): RtcSession {
    return (this.deps.createSession ?? ((o: RtcSessionOptions) => new RtcSession(o)))({
      authToken: identity.authToken,
      gtoken: identity.gtoken,
      stationSn: route.stationSn,
      adminUserId,
      shard: this.deps.shard(),
      country: this.deps.country ?? "US",
      logger: this.deps.logger,
      signalingMode: route.signalingMode,
      peer: { logger: this.deps.logger, iceTransportPolicy: route.iceTransportPolicy, mediaTrack: route.mediaTrack },
    });
  }

  private async stationSession(route: RtcRoute, adminUserId: string, identity: RtcIdentity): Promise<StationSession> {
    const sn = route.stationSn;
    const existing = this.sessions.get(sn);
    if (existing) {
      await existing.ready;
      if (existing.session.isConnected) {
        this.touch(sn, existing);
        return existing;
      }
      this.drop(sn, existing);
    }
    const session = this.newSession(route, adminUserId, identity);
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
   * session closed and every listener gone, when `connect()` throws, the session closes first (rejecting
   * with the failure that closed it, when it carries one), or {@link CONNECT_TIMEOUT_MS} passes. A single
   * promise, so an early failure cannot leave a second one rejecting unheard.
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
      const onClose = (err?: Error) =>
        finish(err ?? new Error(`rtc: ${sn} session closed before the command channel opened`));
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
