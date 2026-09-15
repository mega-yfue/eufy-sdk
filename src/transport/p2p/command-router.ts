/**
 * P2P command router — the transport-side owner of the ThroughTek PPCS sessions and every wire
 * operation over them: opening sessions, resolving a serial to its session + routing params,
 * mapping a transport-neutral {@link Command} to a concrete frame (encryption level, wire shape),
 * the fire-and-forget control senders, request/reply queries, and the media provider.
 *
 * Layering: this module knows P2P bytes; it does NOT know capabilities. Frame → semantic-event
 * decoding is a model concern, so raw frames are handed back to the client via {@link P2PRouterDeps.onFrame}
 * (the client gates them on device capabilities and emits typed events). This keeps transport free of
 * any `model/` import — the capability↔transport decorrelation invariant.
 */
import type { MegaHttpClient } from "../http/mega-client.js";
import type { EufyDevice } from "../../core/types.js";
import type {
  Command,
  Ff09Identity,
  AutoLockSnapshot,
  MediaProvider,
  ScalarForm,
  AacEncoder,
  SharedSourceHints,
  AbortableCall,
  TalkbackHandle,
} from "../../core/contracts.js";
import { StationKeyUnavailableError, StationUnreachableError } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { assertNever } from "../../core/util.js";
import { setTimeout as sleep } from "node:timers/promises";
import { CONNECT_TIMEOUT_MS, P2PSession, type P2PFrame } from "./p2p-session.js";
import { buildDirectBinaryBody } from "./write-commands.js";
import { CommandType } from "./commands.js";
import {
  buildFf09Frame,
  buildFf09QueryFrame,
  buildFf09SettingToggleFrame,
  buildFf09AutolockSetFrame,
  decryptFf09Frame,
  parseFf09SettingsResponse,
  decodeFf09AutoLockSnapshot,
  ff09ReplyKeyTime,
  ff09TransferPayload,
  CMD_TRANSFER_PAYLOAD,
} from "../ff09.js";
import { decodeP2PCloudIPs } from "./codec.js";
import { P2P_ENVELOPE } from "./envelope.js";
import { freshestLanIp } from "./lan-ip.js";
import { captureSnapshotFromShared, recordClip } from "./media.js";
import type { FfmpegLevel } from "../ffmpeg.js";
import { LiveStream } from "./live-stream.js";
import { SharedLiveSource, type Consumer } from "./shared-live-source.js";
import {
  SessionManager,
  SessionSupersededError,
  PREWARM_MS,
  type PowerTier,
  type SessionManagerOpts,
} from "./session-manager.js";
import { openReadableFromConsumer } from "./readable-egress.js";
import { Talkback } from "./talkback.js";
import { FragmentRecording } from "./fragment-recording.js";
import { traceLiveStart, type LiveTrace } from "./live-trace.js";

/**
 * How many times each idempotent "direct" control command (camera on/off 1035, spotlight
 * brightness 1401 / color-temp 1410 / enable 1403) is repeated over P2P. Sends are fire-and-forget
 * over UDP with no app-level ACK we wait on, so we repeat for loss resilience on lossy RF. The app
 * itself sent 2–6× depending on the command; we standardize on the higher end (idempotent, so extra
 * sends are harmless). Bump if drops are seen on marginal links.
 */
const DIRECT_CMD_SENDS = 5;

/**
 * Settle `work` as it settles, or reject the moment `signal` aborts, whichever comes first.
 *
 * The underlying wait is left to finish on its own: these are shared negotiations whose result other callers
 * are also waiting on, so a caller abandoning its own call must not cancel the work itself. This abandons
 * WAITING, which is the only part that belonged to the caller.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/**
 * How long each command is given where the level-2 key is a REQUIREMENT — the HomeBase-routed commands
 * that cannot be framed without it. This grace is per call, because a delayed `CMD_GATEWAYINFO` on an old
 * session may still produce the key while the command waits.
 */
const LEVEL2_GRACE_MS = 25_000;

/**
 * The bound a caller waits for the level-2 negotiation to SETTLE, measured from connect.
 *
 * For a caller that picks its seal once from {@link P2PSession.hasLevel2Key} and has no second chance. A media
 * start reads the key on every send and is re-issued by the warm-up, so it needs no wait; a property write
 * framed level-1 to a family that only accepts level-2 is ignored, and nothing re-frames it. Session-scoped,
 * so a station that offers no key does not charge this to every later command.
 */
const LEVEL2_SETTLE_MS = 8_000;

/**
 * What a caller's own deadline on a station call has to clear, in milliseconds.
 *
 * A caller that bounds one of these calls itself races these waits, and a bound below them reports the
 * caller's own expiry in place of the reason this SDK was about to give — the two are indistinguishable to
 * whoever reads the outcome, and they call for different next steps. Published so that bound can be derived
 * rather than copied: a literal in a caller's source is a second source of truth that goes stale silently
 * when these change.
 *
 * `connect` applies to every call on a station, because nothing can be addressed to one before its session is
 * up, and it is the session's own connect deadline: a session that reaches it closes itself, so waiting past it
 * waits on a connection that can no longer answer. `level2Grace` applies twice where the key is required: the
 * negotiation is re-prompted once.
 */
export const P2P_STATION_WAITS = {
  connect: CONNECT_TIMEOUT_MS,
  level2Grace: LEVEL2_GRACE_MS,
  level2Settle: LEVEL2_SETTLE_MS,
} as const;

/** How long a station's live RTSP URL push is awaited — the connect wait and the URL wait together. */
const RTSP_URL_READ_TIMEOUT_MS = 12_000;

/**
 * Options accepted when warming a {@link SharedLiveSource} for a device (all optional).
 *
 * {@link SharedSourceHints} are the members any media egress may supply, because any of them may be the
 * call that opens the pull; the rest reach it only from a caller that warms a source directly.
 */
export interface SharedLiveOpts extends SharedSourceHints, AbortableCall {
  eccPrivateKey?: Buffer;
  keepAliveMs?: number;
  lingerMs?: number;
  /** Battery/solar continuous-stream budget in ms (default 45000). */
  batteryBudgetMs?: number;
  /** Grace after the budget notice to `extend()` before auto-stop, in ms (default 10000). */
  budgetGraceMs?: number;
}

/**
 * The option names a shared source is actually built from — the allowlist
 * {@link P2PCommandRouter.warnIgnoredLiveOpts} compares against.
 *
 * It exists because `live()`'s options reach the router as a loose `Record<string, unknown>` (a host
 * passes per-egress settings like `timeoutMs` in the same bag), so walking the caller's own keys would
 * report members that were never a shared-source concern as "ignored".
 */
const SHARED_LIVE_OPT_KEYS = [
  "eccPrivateKey",
  "keepAliveMs",
  "lingerMs",
  "preBufferSeconds",
  "powered",
  "batteryBudgetMs",
  "budgetGraceMs",
] as const satisfies readonly (keyof SharedLiveOpts)[];

/**
 * Whether two shared-source option values are the same as far as a caller is concerned.
 *
 * `eccPrivateKey` is a `Buffer`, and identity comparison makes two callers passing the same key from
 * different reads look like a disagreement — warning on every single call for options that in fact
 * match.
 */
function sameLiveOpt(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return a === b;
}

/** The P2P session + routing params resolved for a device serial (see {@link P2PCommandRouter.resolveSession}). */
interface ResolvedSession {
  session: P2PSession;
  parentSn: string;
  channel: number;
  accountId: string;
  homeBaseAttached: boolean;
}

/**
 * The mutable cell a live source reads its session out of. Assigning `session` points every later
 * `makeStream` call at a different connection, leaving the source itself in place.
 */
interface HeldSession {
  session: P2PSession;
}

/**
 * The facade-side dependencies the router needs. It owns the sessions map and all wire logic, but
 * defers device-list access + lifecycle/frame event fan-out to the client (which owns the typed
 * EventEmitter and the model-coupled frame decode).
 */
export interface P2PRouterDeps {
  mega: MegaHttpClient;
  /** Diagnostics sink, forwarded to every P2P session. Omit for silence. */
  logger?: Logger;
  /** ffmpeg `-loglevel` for the media (snapshot/record) paths. Default `"error"`. */
  ffmpegLogLevel?: FfmpegLevel;
  /** The ffmpeg executable the media paths run. Default: the bare name, looked up on `PATH`. */
  ffmpegPath?: string;
  /** Current (already-loaded) device list. */
  listDevices: () => EufyDevice[];
  /** Load the device list if it isn't loaded yet (delegates to the client's getDevices). */
  ensureDevices: () => Promise<void>;
  onConnect: (stationSn: string) => void;
  onClose: (stationSn: string) => void;
  onError: (err: Error) => void;
  onLevel2Ready: (stationSn: string, cipherId: number) => void;
  /** A raw decoded frame — the client emits the low-level `p2p` event + runs the semantic decode. */
  onFrame: (stationSn: string, frame: P2PFrame) => void;
  /**
   * Power tier per parent-station serial (`"wired"` = persistent session, `"battery"` = on-demand +
   * idle-detach). Injected by the facade from resolved capabilities — plain data, so transport never
   * imports model. Default (absent): every station treated as `"wired"` (today's persistent behaviour).
   */
  poweredFor?: (parentSn: string) => PowerTier;
  /** Idle/keepalive window overrides for the session lifecycle (see {@link SessionManagerOpts}). */
  sessionIdle?: Pick<SessionManagerOpts, "batteryIdleMs">;
  /** LAN address overrides for direct P2P, keyed by parent-station serial (host or host:port). */
  localAddresses?: Record<string, string>;
  /** Suppress the `255.255.255.255` local-lookup broadcast; cloud lookup and a known LAN address still run. */
  noBroadcast?: boolean;
}

export class P2PCommandRouter {
  /** P2P session lifecycle: on-demand open + battery-aware idle-detach + refcount, per session key. */
  private readonly manager: SessionManager;
  /** Error objects already forwarded while a station startup awaits the same session signal. */
  private readonly reportedErrors = new WeakSet<Error>();
  /** One shared live source per `${parentSn}:${channel}` — collapses N live() calls to one pull. */
  private readonly liveSources = new Map<string, SharedLiveSource>();
  /** The options each live source was built from, so a later caller's conflicting ones can be reported. */
  private readonly liveSourceOpts = new Map<string, SharedLiveOpts>();
  /**
   * The session each live source pulls over — the station's own serial, or the source's own media
   * session key.
   *
   * Written the instant the choice is made and BEFORE the connection is opened, which is what makes it
   * a reservation rather than a record. Two cameras started together (the four-tile case this feature
   * exists for) would otherwise both find the station's session free: a consumer attaches only after
   * `sharedLiveSourceFor` returns, so neither is visible to the other through consumer counts, and both
   * would take the shared connection and contend on it.
   *
   * A station entry is kept as well as a media one, because "is the station's own session already
   * claimed" is the question being asked, and an entry that is present but not yet in
   * {@link liveSources} is a claim in flight.
   */
  private readonly liveSessionKeys = new Map<string, string>();
  /**
   * The open talkback per `${parentSn}:${channel}`, if any. The device plays one audio stream at a
   * time and the session carries one audio sequence, so this path is exclusive where a live pull is
   * shared — see {@link P2PCommandRouter.openTalkback}.
   */
  private readonly talkbacks = new Map<string, Talkback>();
  /** cipher_id → ECC private key (one eufylife get_ciphers call per cipher), shared across (re)opens. */
  private readonly cipherKeyCache = new Map<number, string | undefined>();

  constructor(private readonly deps: P2PRouterDeps) {
    this.manager = new SessionManager({
      poweredFor: deps.poweredFor,
      logger: deps.logger,
      onAutoClose: (key) =>
        P2PCommandRouter.isMediaSessionKey(key) ? this.tearDownMediaSession(key) : this.tearDownStation(key),
      ...deps.sessionIdle,
    });
  }

  /** Forward one P2P failure once even when both the session listener and startup waiter observe it. */
  private reportError(error: unknown): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!this.reportedErrors.has(normalized)) {
      this.reportedErrors.add(normalized);
      this.deps.onError(normalized);
    }
    return normalized;
  }

  /**
   * Emit a live trace under a station session's handle, for work this router does ON that session before
   * the session itself records anything — reaching the station, and resolving what a device is on it. Same
   * handle as everything the session goes on to trace, which is what groups one attempt.
   */
  private traceOnStation(session: P2PSession, trace: LiveTrace): void {
    traceLiveStart(this.deps.logger ?? noopLogger, trace, session.traceId);
  }

  /**
   * Whether this transport stack drives `dev`'s `ff09-*` commands — true when the device has its own
   * usable P2P endpoint (a non-empty `p2p_did`). The command sink asks each stack this to route a
   * transport-neutral command. Keyed on the endpoint, NOT `classifyDevice`'s `realtime` tag: that tag is
   * `"p2p"` for the ENTIRE `eufy_security` category, so it can't tell a P2P lock (T8531, own `p2p_did`)
   * from an MQTT-only lock/garage (T85D0, empty `p2p_did`) — routing the latter to P2P throws
   * `no P2P session`.
   */
  static claimsDevice(dev: EufyDevice): boolean {
    return typeof dev.p2pDid === "string" && dev.p2pDid.length > 0;
  }

  /**
   * The open P2P sessions by key — a station's own under its serial, a camera's media session under
   * `<stationSn>#live:<channel>` (a snapshot; mutate via the lifecycle methods, not this map).
   */
  getSessions(): Map<string, P2PSession> {
    return this.manager.liveSessions();
  }

  /**
   * Speculatively open + briefly hold a station's session (e.g. after a doorbell ring) so a
   * tap-to-view / talkback attaches to a warm session. Transport-neutral: the facade maps the semantic
   * event → station and decides whether this station may be pre-warmed at all; the router never learns
   * event semantics.
   *
   * One hold, taken before the open so a slow connect can't idle-close mid-flight. It expires on its
   * own, which arms the station's idle window rather than closing the session, per {@link PREWARM_MS}.
   * A second hold after the open would buy nothing: {@link openSession} returns once the socket is bound
   * and the lookups are away, not once the peer has answered, so both would expire together.
   *
   * Best-effort — a failed open surfaces via `onError`. A {@link SessionSupersededError} does not: the
   * session was deliberately closed underneath a speculative open, which is not a fault to report.
   */
  async prewarm(parentSn: string, ms: number = PREWARM_MS): Promise<void> {
    this.manager.hold(parentSn, ms, parentSn);
    try {
      await this.openSession(parentSn, parentSn);
    } catch (e) {
      if (e instanceof SessionSupersededError) return;
      this.deps.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Close every P2P session and drop them. */
  async closeAll(): Promise<void> {
    const talking = [...this.talkbacks.values()];
    this.talkbacks.clear();
    await Promise.all(talking.map((t) => t.stop().catch(() => {})));
    for (const src of this.liveSources.values()) src.dispose();
    this.liveSources.clear();
    this.liveSourceOpts.clear();
    this.liveSessionKeys.clear();
    await this.manager.closeAll();
  }

  /** This serial's loaded record, or `undefined` — the one place the cached list is searched by serial. */
  private recordFor(sn: string): EufyDevice | undefined {
    return this.deps.listDevices().find((d) => d.sn === sn);
  }

  /** The parent-station key a device's session lives under (its HomeBase, or itself if standalone). */
  private stationKeyFor(dev: EufyDevice): string {
    const raw = (dev.raw ?? {}) as Record<string, any>;
    return raw.parent_sn && raw.parent_sn !== dev.sn ? (raw.parent_sn as string) : (dev.stationSn ?? dev.sn);
  }

  /**
   * The parent-station serial a device serial's session lives under — the single source of truth for
   * session keying, used by the facade (e.g. to pre-warm the right station for an event). Returns the
   * serial itself if the device isn't loaded (a standalone device is its own station).
   */
  stationKeyOf(sn: string): string {
    const dev = this.recordFor(sn);
    return dev ? this.stationKeyFor(dev) : sn;
  }

  /** Reset only a standalone device's session; an attached device must not close its shared HomeBase. */
  async resetStandaloneSession(sn: string): Promise<void> {
    const device = this.recordFor(sn);
    if (!device) return;
    const station = this.stationKeyFor(device);
    if (station === sn) await this.manager.resetWhenUnused(station);
  }

  /**
   * Open (or reuse) the P2P session for a station **on demand**, coalescing concurrent cold opens via
   * the {@link SessionManager}. A command / stream / pre-warm opens only the station it targets; idle
   * battery stations auto-close. The station's own record carries the P2P creds — a serial with no
   * record of its own throws, because every value the session carries comes from that one record (the
   * endpoint dialled, its cloud and LAN addresses, the admin user id the cipher lookup quotes) and is
   * keyed under that one serial, so there is no partial answer to give. A per-station DSK key is
   * fetched best-effort (ThroughTek PPCS UDP, LAN broadcast fallback if the key lookup fails). The LAN
   * address for a direct local lookup is a caller-supplied override ({@link P2PRouterDeps.localAddresses})
   * when present, else the freshest private IP in the record ({@link freshestLanIp}) — so P2P works
   * on-LAN even when broadcast is blocked (AP isolation) or the record's `ip_addr` went stale.
   */
  /**
   * The key a camera's own media session is filed under, distinct from every station serial because a
   * serial contains no `#`.
   */
  private static mediaSessionKey(parentSn: string, channel: number): string {
    return `${parentSn}#live:${channel}`;
  }

  /** Whether `key` names a media session rather than a station's own. */
  private static isMediaSessionKey(key: string): boolean {
    return key.includes("#live:");
  }

  /**
   * Open (or reuse) a SECOND connection to a station, carrying one camera's media and nothing else.
   *
   * One session serves one camera: a station fans its cameras over a session and answers the most recent
   * start on it, so two cameras down one tunnel take it from each other in turn. Another connection is
   * how a station serves another camera.
   *
   * The hardware was shown to do this before the SDK did. A first-party display showing four tiles was
   * captured opening one PPCS session per camera, with three cameras' video arriving in the same second
   * at 2304x1296, 1600x1200 and 3840x2160 — three geometries at once, which no composed stream can be.
   * Reproduced here afterwards on a base carrying two attached cameras, one at 3840x2160, both holding
   * full frame rate at once over a session each, where the same pair down one session could only take
   * turns.
   *
   * It carries media alone. The station announces its state to every client that connects, so a session
   * wired to the same fan-out would report every event a second time; {@link makeSession} leaves this one
   * unannounced, and the station's own session stays the single source of connection state, control
   * notifications and frames.
   *
   * The level-2 key is waited for here on the same terms the station's own session gets, because a
   * connection is not usable for this without one: an attached camera's media start has no level-1 form,
   * so a start issued before the key arrives is dropped as `media-command-unsent`, and the stream then
   * shows nothing until a later keepalive tick happens to find the key. A connected session that cannot
   * carry the start is not a connected session, so this refuses rather than returning one.
   */
  private async openMediaSession(parentSn: string, channel: number, signal?: AbortSignal): Promise<P2PSession> {
    const session = await this.openSession(P2PCommandRouter.mediaSessionKey(parentSn, channel), parentSn);
    let ready = await abortable(session.awaitLevel2Key(LEVEL2_GRACE_MS, "call"), signal);
    if (!ready && session.repromptLevel2Key()) {
      ready = await abortable(session.awaitLevel2Key(LEVEL2_GRACE_MS, "call"), signal);
    }
    if (!ready) throw new StationKeyUnavailableError(parentSn);
    return session;
  }

  /** Open (or reuse) the session filed under `key`, dialling `parentSn`'s endpoint. */
  private async openSession(key: string, parentSn: string): Promise<P2PSession> {
    return this.manager.acquire(
      key,
      async (register) => {
        const stationDev = this.recordFor(parentSn);
        if (!stationDev) throw new Error(`station ${parentSn} is not in the device list`);
        const raw = (stationDev.raw ?? {}) as Record<string, any>;
        const did = (stationDev.p2pDid ?? raw.p2p_did) as string | undefined;
        if (!did) throw new Error(`no P2P endpoint (p2p_did) for station ${parentSn}`);
        let dskKey: string | undefined;
        try {
          dskKey = (await this.deps.mega.getDskKeys([parentSn]))[parentSn]?.dskKey;
        } catch (e) {
          this.deps.onError(e instanceof Error ? e : new Error(String(e)));
        }
        const localAddress = this.deps.localAddresses?.[parentSn] ?? freshestLanIp(raw);
        const session = this.makeSession(parentSn, did, raw, dskKey, localAddress, key, key === parentSn);
        register(session);
        await session.connect();
        return session;
      },
      parentSn,
    );
  }

  /**
   * Build + wire a {@link P2PSession} for a station (NOT yet connected — the caller awaits `connect()`).
   *
   * `resolveCipherKey` auto-negotiates the level-2 session key from `CMD_GATEWAYINFO` by resolving the
   * cipher's ECC private key via cloud `get_ciphers`, so signCode 2/8 frames decrypt live; results are
   * cached on the router instance so a lazy re-open (after idle-detach) reuses the lookup. Only a
   * SUCCESSFUL lookup is cached — caching `undefined` after a transient failure would permanently
   * disable level-2 for the session's life.
   *
   * The `close` handler drops the session from the {@link SessionManager} and disposes any shared live
   * source riding this station (consumers get `stop`; a later attach rebuilds via the factory).
   *
   * A session filed under a media key is wired for errors and its own teardown ONLY. Connection state,
   * level-2 readiness and inbound frames all reach the owner through the station's own session, and a
   * station announces those to every client that connects — so fanning a second connection's copies out
   * under the same station serial would report each one twice, and a close would tear down the station
   * while its own session is still serving.
   */
  private makeSession(
    stationSn: string,
    did: string,
    raw: Record<string, any>,
    dskKey: string | undefined,
    localAddress: string | undefined,
    key: string,
    announces: boolean,
  ): P2PSession {
    const conn = (raw?.p2p_conn ?? raw?.app_conn) as string | undefined;
    const adminUserId = ((raw?.member as any)?.admin_user_id as string) || this.deps.mega.auth?.userId || "";
    const session = new P2PSession({
      stationSn,
      p2pDid: did,
      cloudAddresses: conn ? decodeP2PCloudIPs(conn) : undefined,
      localAddress,
      dskKey,
      noBroadcast: this.deps.noBroadcast,
      resolveCipherKey: async (cipherId: number) => {
        if (this.cipherKeyCache.has(cipherId)) return this.cipherKeyCache.get(cipherId);
        let ecc: string | undefined;
        try {
          const ciphers = await this.deps.mega.getCiphers([cipherId], adminUserId, stationSn);
          ecc = ciphers.find((c) => Number(c.cipher_id) === cipherId)?.ecc_private_key;
          if (ecc === undefined && ciphers[0]?.ecc_private_key !== undefined) {
            ecc = ciphers[0].ecc_private_key;
            this.traceOnStation(session, {
              phase: "cipher-fallback",
              cipherId,
              answeredCipherId: Number(ciphers[0].cipher_id),
            });
          }
        } catch (e) {
          this.deps.onError(e instanceof Error ? e : new Error(String(e)));
        }
        if (ecc !== undefined) this.cipherKeyCache.set(cipherId, ecc);
        return ecc;
      },
      logger: this.deps.logger ?? noopLogger,
    });
    session.on("error", (e: Error) => this.reportError(e));
    if (!announces) {
      session.on("close", () => {
        if (this.manager.get(key) === session) this.tearDownMediaSession(key);
      });
      return session;
    }
    session.on("connect", () => {
      if (this.manager.get(stationSn) === session) this.deps.onConnect(stationSn);
    });
    session.on("close", () => {
      if (this.manager.get(stationSn) !== session) return;
      this.tearDownStation(stationSn);
    });
    session.on("level2Ready", ({ cipherId }: { cipherId: number }) => this.deps.onLevel2Ready(stationSn, cipherId));
    session.on("data", (f: P2PFrame) => this.deps.onFrame(stationSn, f));
    return session;
  }

  /**
   * Open (or reuse) a station's P2P session and await its completed handshake. An optional abort only
   * stops this wait; session ownership remains with {@link SessionManager} and its normal teardown.
   */
  async ensureStation(parentSn: string, signal?: AbortSignal): Promise<void> {
    try {
      const session = await this.openSession(parentSn, parentSn);
      if (session.isConnected) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
          session.off("connect", onConnect);
          session.off("error", onError);
          session.off("close", onClose);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error(`P2P session closed before connecting for station ${parentSn}`));
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException("P2P station wait aborted", "AbortError"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        session.once("connect", onConnect);
        session.once("error", onError);
        session.once("close", onClose);
        if (session.isConnected) onConnect();
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("P2P station wait aborted", "AbortError");
      throw this.reportError(error);
    }
  }

  /** Resolve a serial to its loaded device record, opening its station's P2P session on demand. */
  async deviceFor(sn: string): Promise<EufyDevice> {
    if (!this.deps.listDevices().length) await this.deps.ensureDevices();
    const dev = this.recordFor(sn);
    if (!dev) throw new Error(`device ${sn} not found`);
    await this.openSession(this.stationKeyFor(dev), this.stationKeyFor(dev));
    return dev;
  }

  /**
   * Route a transport-neutral {@link Command} to its wire transport — the command-sink
   * implementation. Capability modules emit intent; this is the one place that knows P2P.
   */
  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    switch (cmd.kind) {
      // ── Intents — the transport picks the encryption level (see resolveScalarParam / setJson). ──
      case "set-param":
        await this.resolveScalarParam(sn, cmd.param, cmd.value, cmd.form);
        return;
      case "set-json":
        await this.routeControl(sn, P2P_ENVELOPE.CONTROL_PAYLOAD, { commandType: cmd.param, data: cmd.data });
        return;
      case "set-json-raw":
        await this.sendJsonRaw(sn, cmd.cmd, cmd.data, cmd.channel);
        return;
      case "set-payload":
        await this.sendSetPayloadEnvelope(sn, cmd.cmd, cmd.payload, cmd.channel, cmd.mValue3, undefined, cmd.form);
        return;
      case "p2p-station-scalar":
        await this.sendStationScalar(sn, cmd.cmd, cmd.value, cmd.channel);
        return;
      case "p2p-int-string":
        await this.sendIntString(sn, cmd.cmd, cmd.value, cmd.valueSub, cmd.channel);
        return;
      // ── Raw wire kinds — the privacy burst is a bespoke multi-frame sequence, not a set-param. ──
      case "p2p-privacy-burst":
        await this.sendPrivacyBurst(sn, cmd.enabled);
        return;
      case "ff09-actuate":
        await this.sendFf09Actuate(sn, cmd);
        return;
      case "ff09-autolock":
        await this.sendFf09Autolock(sn, cmd);
        return;
      case "ff09-setting-toggle":
        await this.sendFf09SettingToggle(sn, cmd);
        return;
      case "aiot-dp":
        throw new Error(`aiot-dp command (DP ${cmd.dp}) not routable over P2P: AIoT MQTT devices use the MQTT router`);
      case "mqtt-dp":
      case "mqtt-dp-preset":
      case "mqtt-dp-color":
        // The `eufy_life` DP writes are secure-MQTT-only — the facade routes them to MqttCommandRouter.
        // Reaching the P2P router means a routing bug; fail loud rather than silently no-op.
        throw new Error(`${cmd.kind} is a secure-MQTT-only command and must not reach the P2P router (routing bug)`);
      default:
        // Exhaustiveness: a new Command kind that reaches the P2P router unhandled must fail loud, not
        // fall through and resolve as a silent fire-and-forget success (a guess that looks like success).
        return assertNever(cmd);
    }
  }

  /**
   * Restart a HomeBase. `RESTART_HUB` (1034) is a station-scalar on the broadcast channel 255: a
   * level-2 frame whose body is `[u32 value][account_id padded]` — the same shape as the hub
   * alarm-volume control. ✅ Wire-confirmed byte-exact from a capture of the app's own Restart
   * (2026-08-03) and HW-tested: the captured frame carried value `0` and rebooted the hub. Replays
   * like every other level-2 control, so a single dropped datagram doesn't lose it.
   */
  async rebootStation(sn: string): Promise<void> {
    // value 0 — the exact value the captured app frame carried when it rebooted the hub.
    await this.replayLevel2Send(sn, `reboot ${sn}`, ({ session, accountId }) =>
      session.sendRawLevel2Bytes(buildDirectBinaryBody(0, accountId), 255, P2P_ENVELOPE.RESTART_HUB, 8),
    );
  }

  /**
   * A {@link MediaProvider} bound to one serial — resolves the session then calls `p2p/media`.
   *
   * Every live egress here is a consumer of the SAME shared pull, so N `live()` calls collapse to one
   * PPCS session and a live snapshot against a warm, keyframe-primed source costs no extra pull at all; a
   * cold source warms one and waits for a clean keyframe. Each shared egress passes its complete options
   * through because any of them may create the source, whose power and retention hints are fixed for
   * everyone who joins later. The bounded {@link MediaProvider.record} clip is the exception: it opens its
   * own pull, receives its session topology directly, and requires the level-2 key an attached camera's
   * start has no level-1 form for.
   */
  mediaProviderFor(sn: string): MediaProvider {
    return {
      snapshotLive: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, opts ?? {});
        return captureSnapshotFromShared(source, {
          ...opts,
          logger: this.deps.logger ?? noopLogger,
          ffmpegLevel: this.deps.ffmpegLogLevel,
          ffmpegPath: this.deps.ffmpegPath,
        });
      },
      live: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, opts as SharedLiveOpts, true);
        return this.attachUnlessAborted(source, (opts as SharedLiveOpts | undefined)?.signal);
      },
      openReadable: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, opts ?? {}, true);
        return openReadableFromConsumer(this.attachUnlessAborted(source, opts?.signal), opts);
      },
      recordFragments: (opts) => this.recordFragments(sn, opts),
      talkback: (opts) => this.openTalkback(sn, opts),
      p2pQuery: (subCmd, opts) => this.p2pQuery(sn, subCmd, opts),
      p2pControlQuery: (param, data, opts) => this.p2pControlQuery(sn, param, data, opts),
      record: async (seconds, opts) => {
        const { session, channel, accountId, homeBaseAttached } = await this.resolveSession(sn, {
          waitLevel2: "soft",
          requireLevel2ForAttached: true,
        });
        return recordClip(session, seconds, {
          channel,
          accountId,
          homeBaseAttached,
          ...opts,
          logger: this.deps.logger ?? noopLogger,
          ffmpegLevel: this.deps.ffmpegLogLevel,
          ffmpegPath: this.deps.ffmpegPath,
        });
      },
    };
  }

  /**
   * Open a {@link Talkback} on a device's camera channel.
   *
   * **The camera only plays host audio while its media session is open** — verified live on three
   * cameras: the identical start + audio frames produce silence with no media session and audible
   * playback with one. So this attaches a consumer to the shared live source and holds it for the
   * talkback's lifetime, releasing it on stop. The source is shared and refcounted, so an already-open
   * stream costs nothing extra and a talkback on an otherwise idle camera opens the session it needs
   * instead of playing into silence.
   *
   * The level-2 key is waited for softly: only the HomeBase-attached path requires it, and
   * {@link Talkback.start} reports that failure precisely, so a hard wait here would reject an
   * own-session camera that legitimately never negotiates one.
   *
   * Both of the media consumer's events are forwarded rather than left to default. An unhandled
   * `error` on it would take the host process down, and a warm-up failure is exactly the condition
   * that makes talkback silent, so it reaches the caller when one is listening and the log otherwise.
   * A `budget` notice means a battery camera's session is about to auto-stop and take the audio with
   * it mid-sentence; forwarding it lets a caller extend, while ignoring it stops on schedule and
   * protects the battery. The budget belongs to the shared source rather than to one consumer, so a
   * single `extend()` covers a live stream and a talkback running side by side.
   *
   * `stop` ends the talkback with it. The media session going away is the one condition under which
   * audio cannot be heard no matter how well it is framed, so pacing on into a dead session would be
   * silent failure rather than a shorter clip.
   *
   * **One talkback per camera at a time.** Unlike a live pull, this path cannot be fanned out: both
   * handles would pace onto one session's single audio sequence, interleaving two AAC streams into
   * something unplayable, and whichever stopped first would close the device's path under the other —
   * with no error on either side. The second caller is refused rather than handed the first one's
   * handle, which would silently discard its `encoder` and hand it a clip already in progress.
   *
   * The refusal is decided and RECORDED in one synchronous step, before the shared media source is awaited.
   * Warming that source is a round-trip, so two concurrent callers would otherwise both find the map empty,
   * both build a talkback, and the second would overwrite the first in the map — two paced streams on the one
   * audio sequence, and the orphaned handle no longer reachable by {@link P2PCommandRouter.closeAll}. The
   * entry is therefore claimed by the talkback itself, which the media consumer is wired into once it exists;
   * a failure to warm or to open the audio path releases the claim.
   *
   * The claim is re-checked after the wait for the mirror case: a station close or `closeAll` in that window
   * stops the talkback that is holding it, and starting the pacing tick on a stopped talkback would pace into
   * a session nobody is listening on.
   */
  private async openTalkback(
    sn: string,
    opts: { encoder?: AacEncoder } & SharedSourceHints = {},
  ): Promise<TalkbackHandle> {
    const { session, parentSn, channel, homeBaseAttached } = await this.resolveSession(sn, { waitLevel2: "soft" });
    const logger = this.deps.logger ?? noopLogger;
    const key = `${parentSn}:${channel}`;
    if (this.talkbacks.has(key)) {
      throw new Error(
        `talkback: ${sn} is already talking — the device plays one audio stream at a time; stop the ` +
          `open talkback before starting another`,
      );
    }
    let consumer: Consumer | undefined;
    const talk = new Talkback(session, {
      channel,
      homeBaseAttached,
      encoder: opts.encoder,
      releaseMedia: () => consumer?.stop(),
      logger,
    });
    talk.on("stop", () => {
      if (this.talkbacks.get(key) === talk) this.talkbacks.delete(key);
    });
    this.talkbacks.set(key, talk);
    try {
      const source = await this.sharedLiveSourceFor(sn, opts);
      if (this.talkbacks.get(key) !== talk) {
        throw new Error(`talkback: ${sn} was closed while its media session was warming`);
      }
      consumer = source.attach();
      consumer.on("error", (e: Error) => {
        if (talk.listenerCount("error")) talk.emit("error", e);
        else logger.warn?.(`talkback: media session for ${sn} failed: ${e.message}`);
      });
      consumer.on("budget", (notice) => talk.emit("budget", notice));
      consumer.on("stop", () => {
        void talk.stop().catch((e: unknown) => logger.warn?.(`talkback: stop for ${sn} failed: ${String(e)}`));
      });
      return talk.start();
    } catch (e) {
      if (this.talkbacks.get(key) === talk) this.talkbacks.delete(key);
      consumer?.stop();
      throw e;
    }
  }

  /**
   * Resolve a serial to its **shared live source** — one underlying pull per `${parentSn}:${channel}`,
   * fanned out to every consumer (see {@link SharedLiveSource}). Lazily warmed on the first consumer;
   * the `makeStream` factory rebuilds a fresh {@link LiveStream} on each (re)warm so a reconnect can
   * recover. Uses `waitLevel2:"soft"` — mirrors `live()`, no hard-fail on a standalone camera. Wires
   * `onActive`/`onIdle` so an attached stream counts as a user of the station's P2P session (cancels
   * the session idle-detach while streaming; its longer idle timer arms when the last consumer leaves).
   *
   * A source that has **stopped** (linger teardown, failed start, budget auto-stop, upstream error) is
   * dropped here rather than re-used, whatever is still attached to it. Its pull is dead, so nothing is
   * being protected by keeping it — and keeping it would leave the options of whichever egress created
   * it first in force for the process lifetime, so a stray `powered` from the day's first snapshot would
   * still be dictating the budget hours later. Dropping it lets the next caller build a fresh source
   * from its own options.
   *
   * Attachment count is deliberately NOT part of that test. A failed start fails its consumers without
   * detaching them, so a caller still holding its handle leaves the count non-zero — and requiring an
   * empty source here would hand one dead source out for the life of the client. A caller must
   * re-acquire through this method after a failure; `attach()` on the dropped source throws, because it
   * has been disposed.
   *
   * Several cameras behind one station each get their own source: the station tags every media frame with the
   * camera it belongs to, and {@link LiveStream} takes only its own.
   *
   * Whether they can be SERVED at the same time is the station's business, not this map's. Where it serves one
   * camera at a time, a pull still lingering for a camera nobody is watching would go on re-issuing its own
   * media start against the one being asked for, so opening a new channel releases those first — see
   * {@link releaseLingeringSiblings}. A pull with consumers is never touched. The release runs before the
   * reuse branch, so a reuse frees the station as a cold start does.
   *
   * `mayOpenOwnSession` decides whether a camera that finds the station's own session claimed may open a
   * connection of its own for it. Only the continuous-pull egresses pass it. A still must not: it wants one
   * frame, and a socket plus a level-2 negotiation per thumbnail is a cost a tile refresh cannot justify —
   * so a still asked for while a sibling is being watched contends as it always did, and the caller's
   * retained image answers it. A live view still outranks a tile; what changed is that two live views no
   * longer have to outrank each other.
   *
   * The session goes into a {@link HeldSession} cell, so it can be replaced under a source that stays in
   * place.
   */
  async sharedLiveSourceFor(
    sn: string,
    opts: SharedLiveOpts = {},
    mayOpenOwnSession = false,
  ): Promise<SharedLiveSource> {
    const { session, parentSn, channel, accountId, homeBaseAttached } = await this.resolveSession(sn, {
      waitLevel2: "soft",
      requireLevel2ForAttached: true,
      signal: opts.signal,
    });
    const key = `${parentSn}:${channel}`;
    let source = this.liveSources.get(key);
    if (source && source.state === "stopped") {
      this.dropLiveSource(key);
      source = undefined;
    }
    this.releaseLingeringSiblings(parentSn, channel);
    if (!source) {
      const logger = this.deps.logger ?? noopLogger;
      const sessionKey =
        mayOpenOwnSession && homeBaseAttached && this.stationSessionInUse(parentSn, key)
          ? P2PCommandRouter.mediaSessionKey(parentSn, channel)
          : parentSn;
      this.liveSessionKeys.set(key, sessionKey);
      let held: HeldSession;
      try {
        held = {
          session: sessionKey === parentSn ? session : await this.openMediaSession(parentSn, channel, opts.signal),
        };
      } catch (error) {
        this.liveSessionKeys.delete(key);
        throw error;
      }
      source = new SharedLiveSource({
        makeStream: (ctx) =>
          new LiveStream(held.session, {
            channel,
            accountId,
            homeBaseAttached,
            eccPrivateKey: opts.eccPrivateKey,
            keepAliveMs: opts.keepAliveMs,
            reassertWanted: ctx.reassertWanted,
            logger,
          }),
        lingerMs: opts.lingerMs,
        preBufferSeconds: opts.preBufferSeconds,
        powered: opts.powered,
        batteryBudgetMs: opts.batteryBudgetMs,
        budgetGraceMs: opts.budgetGraceMs,
        logger,
        label: key,
        onActive: () => this.manager.retain(sessionKey),
        onIdle: () => this.manager.release(sessionKey),
        onStopped: () => this.closeMediaSession(key),
        onStartFailed: () => this.onLiveStartFailed(sn, key),
        onSessionUnreachable: () => this.replaceUnreachableSession(sn, key, held),
      });
      this.liveSources.set(key, source);
      this.liveSourceOpts.set(key, opts);
      return source;
    }
    this.warnIgnoredLiveOpts(key, opts);
    return source;
  }

  /**
   * Tear down any pull on this station that is lingering for ANOTHER camera, before starting this one.
   *
   * A lingering pull has no consumers but is still held open, and on an attached camera holding it open means
   * re-sending the full media start every keepalive tick. Two channels doing that at once over ONE session,
   * which serves one camera at a time, leaves the new stream receiving nothing but the old camera's frames
   * for as long as the linger lasts.
   *
   * Several cameras genuinely being WATCHED together are never disturbed — the linger exists to make
   * re-opening the SAME camera cheap, and it keeps doing that. What it may not do is keep a camera nobody is
   * looking at competing with one somebody just asked for.
   *
   * An `idle` source is skipped, because it is not a linger and holds nothing: it has never warmed, so it
   * has sent no media start and is competing for nothing. Without that, two cameras opened at the same
   * moment destroy each other — the second finds the first's source built but not yet attached to, reads
   * zero consumers as a linger, and disposes the source its caller is holding. Which is the four-tile case
   * this whole path exists for.
   *
   * A sibling lingering on a connection of its OWN is skipped for the same reason stated the other way: the
   * contention this releases is contention over one session, and that sibling is not on this one. Dropping
   * it would close a socket and throw away the cheap re-attach the linger exists to provide, to relieve a
   * competition that is not happening.
   *
   * A snapshot tile is nobody looking. Opening a live view in the Home app takes that cell fullscreen, so the
   * pulls refreshing the other cells are off screen, yet each goes on re-issuing its own media start every
   * retry tick — measured as four pulls warming together off one HomeBase, a live request landing 1.4 s later,
   * and the live consumer receiving nothing beyond the retained keyframe until its deadline fired. So a live
   * request also takes the channel from a sibling held only by snapshots, while a snapshot request takes
   * nothing from anyone: a home page must not fight itself, and a viewer outranks a thumbnail in one
   * direction only.
   */
  private releaseLingeringSiblings(parentSn: string, channel: number): void {
    const own = `${parentSn}:${channel}`;
    for (const [key, source] of [...this.liveSources]) {
      if (!key.startsWith(`${parentSn}:`) || key === own || source.consumerCount > 0) continue;
      if (source.state === "idle") continue;
      if (this.liveSessionKeys.get(key) !== parentSn) continue;
      (this.deps.logger ?? noopLogger).debug(
        `[live ${key}] releasing a pull nothing is attached to so ${own} can start — ` +
          `one session serves one camera at a time`,
      );
      this.dropLiveSource(key);
    }
  }

  /**
   * Whether another camera has already claimed this station's OWN session, ignoring `key`.
   *
   * The question a newcomer has to answer is not whether the station is busy — it can serve one camera
   * per connection — but whether the connection it would otherwise share is taken. A camera on a media
   * session of its own does not hold this one, so a station whose first camera has since stopped hands
   * its own session to the next arrival rather than opening a socket beside an idle one.
   *
   * A claim counts while its source is still `idle`, source or no source. That is a start that has been
   * handed to its caller but not yet attached to, and it is the only state in which two cameras asked for
   * at the same moment can see each other: consumers attach after this method has already run for both.
   *
   * The cost is that a pull genuinely abandoned before its first attach goes on holding the station's own
   * session, and the next camera pays for a connection of its own rather than reclaiming it. That is one
   * socket against destroying a start someone is waiting on, which is not a close trade.
   *
   * A stopped source is skipped even when consumers are still attached to it. A failed start fails its
   * consumers without detaching them, so a caller still holding a dead handle leaves the count non-zero,
   * and counting that as a viewer would put every later camera on a connection of its own until the
   * client restarted. Only a source that can still deliver holds a place.
   */
  private stationSessionInUse(parentSn: string, key: string): boolean {
    for (const [siblingKey, sessionKey] of this.liveSessionKeys) {
      if (siblingKey === key || sessionKey !== parentSn) continue;
      const sibling = this.liveSources.get(siblingKey);
      if (!sibling) return true;
      if (sibling.state === "stopped") continue;
      if (sibling.state !== "idle" && sibling.consumerCount === 0) continue;
      return true;
    }
    return false;
  }

  /**
   * Whether the stream on `key` should re-assert its channel to hold the station.
   *
   * A re-assert on an attached camera is a full media start, so it takes the station from whichever camera
   * it was serving. Three answers, in order:
   *
   *  - Nothing attached: no. There is nobody to take the station for.
   *  - A live viewer attached: yes. That is the picture someone is looking at.
   *  - Held only for stills, while a sibling on this station has a live viewer: no. A still refreshes a
   *    tile that is off screen while the live view is on it, and one session serving one camera at a time
   *    cannot satisfy both — and a still does not open a connection of its own. Measured: a still on a sibling halved a live view's frame rate for as long as
   *    it took, and its own capture then took fifteen seconds because it was contending.
   *
   * A still with no live sibling re-asserts, so a tile refreshing on a quiet station is
   * unaffected.
   */

  /**
   * Attach a consumer, unless the caller has already abandoned the call.
   *
   * The acquisition it just waited through can outlast the caller's interest, and a consumer attached for
   * somebody who has gone keeps the pull warm for nobody. Detaching immediately gives the pull back, which
   * lets it linger and fall away if this was the only thing holding it, and leaves it untouched if it was
   * not.
   */
  private attachUnlessAborted(source: SharedLiveSource, signal?: AbortSignal): Consumer {
    const consumer = source.attach();
    if (signal?.aborted) {
      consumer.detach();
      signal.throwIfAborted();
    }
    return consumer;
  }

  /**
   * Dispose one cached live source and forget it, so the next acquisition builds a fresh one. Its claim
   * on a session goes with it, and a media session opened for this source alone is closed: nothing else
   * can reach that connection, so leaving it open would hold a socket and a station keepalive for a
   * camera no longer being pulled. A claim on the STATION's own session is released without closing
   * anything — that connection carries the station's control traffic and outlives any one camera.
   */
  private dropLiveSource(key: string): void {
    const source = this.liveSources.get(key);
    if (!source) return;
    source.dispose();
    this.liveSources.delete(key);
    this.liveSourceOpts.delete(key);
    this.closeMediaSession(key);
  }

  /** Close and forget the media session `key`'s live source owned, if it owned one. */
  private closeMediaSession(key: string): void {
    const sessionKey = this.liveSessionKeys.get(key);
    if (sessionKey === undefined) return;
    this.liveSessionKeys.delete(key);
    if (!P2PCommandRouter.isMediaSessionKey(sessionKey)) return;
    void this.manager
      .close(sessionKey)
      .catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))));
  }

  /**
   * Drop the live source a media session was carrying, after that session closed on its own.
   *
   * The source holds the closed connection and never re-resolves it, so it can only answer its retained
   * keyframe and then fail on its warm-up deadline. Its consumers get `stop`, and the next attach builds
   * a fresh source — which, finding the station busy again, opens a fresh media session for it.
   */
  private tearDownMediaSession(sessionKey: string): void {
    this.manager.remove(sessionKey);
    for (const [key, owned] of this.liveSessionKeys) {
      if (owned === sessionKey) {
        this.liveSessionKeys.delete(key);
        this.dropLiveSource(key);
        return;
      }
    }
  }

  /**
   * Drop everything that was riding a station's session, and report the station closed.
   *
   * A live source holds the `P2PSession` it was BUILT with and never re-resolves it, so one left cached
   * past its session is handed back to the next viewer over a dead connection: it answers the retained
   * keyframe, then fails on the warm-up deadline. Talkbacks are the same shape. Both are therefore
   * dropped whenever the session under them goes.
   *
   * Reached two ways, both idempotent: the session's own `close` event, when it died while still the
   * station's registered session, and {@link SessionManagerOpts.onAutoClose}, when the manager closed it
   * unasked. A close a CALLER made is deliberately not routed here — {@link closeAll} disposes its own
   * sources first, and {@link replaceUnreachableSession} keeps its source alive on purpose to rewarm it
   * on the replacement session.
   */
  private tearDownStation(stationSn: string): void {
    this.manager.remove(stationSn);
    for (const key of [...this.liveSources.keys()]) {
      if (key.startsWith(`${stationSn}:`)) this.dropLiveSource(key);
    }
    for (const [key, talk] of this.talkbacks) {
      if (key.startsWith(`${stationSn}:`)) {
        this.talkbacks.delete(key);
        void talk.stop().catch(() => {});
      }
    }
    this.deps.onClose(stationSn);
  }

  /**
   * A live start produced no keyframe. Drop the source, and recycle the device's P2P session when doing so
   * is safe.
   *
   * Rebuilding the stream alone is not enough when it is the session, or the per-device state carried on
   * it, that has stopped serving this camera: every later attach builds another stream over the same
   * cached session and fails identically, which is why only a client restart recovered it.
   *
   * What a recycle actually replaces is the `P2PSession` INSTANCE. `close()` discards the manager's entry
   * first and invalidates that connection's level-2 key and sequence; the next acquisition builds a new
   * instance with a new socket, a new RSA keypair offered as `encryptkey`, and fresh sequence windows.
   *
   * The close is issued BEFORE the source is dropped, because discarding the manager entry is synchronous:
   * from that moment a concurrent acquisition resolves a fresh session rather than the doomed one. It would
   * find the not-yet-dropped source in that window, which is exactly why a stopped source is replaced
   * regardless of what is attached to it.
   *
   * Only a **standalone** device's session is recycled, resolved through {@link stationKeyOf} so this and
   * {@link resetStandaloneSession} cannot disagree about what standalone means. An attached camera shares
   * its HomeBase session with every other camera on it, and closing that to recover one would drop the
   * rest, so an attached camera gets the stream rebuild and nothing more. Unlike
   * {@link resetStandaloneSession} this does not wait for the station to fall idle: the failed source's own
   * session user is still counted, so a deferred reset would never fire.
   */
  private onLiveStartFailed(sn: string, key: string): void {
    const station = this.stationKeyOf(sn);
    if (station !== sn) {
      this.dropLiveSource(key);
      return;
    }
    void this.manager
      .close(station)
      .catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => this.dropLiveSource(key));
  }

  /**
   * Replace the session under a warming source whose media start nothing acknowledged, and warm again on it.
   *
   * Only a STANDALONE device's session is replaced, for the reason {@link onLiveStartFailed} gives: an attached
   * camera shares its HomeBase session with every other camera on it, and closing that to recover one would
   * drop the rest. Such a source keeps the re-issue it always had.
   *
   * The source is left warming throughout, holding the deadline it started, so this either produces a stream
   * within that window or fails exactly as it would have. A replacement that cannot be opened leaves the
   * source to its deadline rather than failing it early — the window is the caller's contract.
   */
  private replaceUnreachableSession(sn: string, key: string, held: HeldSession): void {
    const station = this.stationKeyOf(sn);
    if (station !== sn) return;
    void (async () => {
      try {
        await this.manager.close(station);
        const { session } = await this.resolveSession(sn);
        if (this.liveSources.get(key) !== undefined) {
          held.session = session;
          this.liveSources.get(key)?.rewarm();
        }
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  /**
   * Warn when a caller asks for a shared source with options that disagree with the ones it was built
   * from. A source is created once per `${parentSn}:${channel}` and every later caller simply joins it,
   * so those options are dropped — the failure mode being a battery camera streaming unbounded because
   * whichever egress opened the source first did not pass `powered`. Nothing can be re-applied to a
   * pull that consumers are already attached to, so this reports the conflict rather than pretending to
   * honour it; a source that has since stopped is dropped instead, in {@link sharedLiveSourceFor}.
   */
  private warnIgnoredLiveOpts(key: string, opts: SharedLiveOpts): void {
    const first = this.liveSourceOpts.get(key);
    if (!first) return;
    const ignored = SHARED_LIVE_OPT_KEYS.filter((k) => opts[k] !== undefined && !sameLiveOpt(opts[k], first[k]));
    if (!ignored.length) return;
    (this.deps.logger ?? noopLogger).warn?.(
      `[p2p] ${key} already streaming — ignoring ${ignored.join(", ")} (a shared source keeps the ` +
        `options it was created with; open the source with them, or stop it first)`,
    );
  }

  /**
   * **Continuous fragmented-MP4 recording** — attach a consumer to the device's shared live source and
   * yield CMAF fragments (init segment first, then a `moof`+`mdat` per keyframe boundary) muxed by the
   * dependency-free internal fMP4 muxer. The returned recording handle exposes battery-budget notices
   * and detaches its consumer on `stop`, iterator return, or iterator throw. No ffmpeg.
   */
  recordFragments(
    sn: string,
    opts: { fragmentSeconds?: number; eccPrivateKey?: Buffer; keepAliveMs?: number } & SharedSourceHints = {},
  ): FragmentRecording {
    const source = this.sharedLiveSourceFor(sn, opts);
    return new FragmentRecording(source, opts);
  }

  /**
   * **Generic P2P request/reply query.** Sends a `SET_PAYLOAD` (1350) wrapper carrying `subCmd` on the
   * device channel, then resolves with the reply frame's `payload` — the `NOTIFY_PAYLOAD` (1351)
   * whose JSON `cmd` echoes `subCmd` — decoded off the session `data` event. Needs the level-2 key.
   */
  async p2pQuery(sn: string, subCmd: number, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const { session, channel, accountId } = await this.resolveSession(sn, { waitLevel2: true });
    const timeoutMs = opts.timeoutMs ?? 15000;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for p2p query ${subCmd} reply from ${sn}`));
      }, timeoutMs);
      const onData = (f: P2PFrame): void => {
        const j = f.json as { cmd?: number; payload?: unknown } | undefined;
        if (j?.cmd === subCmd && j.payload && typeof j.payload === "object") {
          cleanup();
          resolve(j.payload as Record<string, unknown>);
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        session.off("data", onData);
      };
      session.on("data", onData);
      // SET_PAYLOAD(1350) wrapping {account_id, cmd:subCmd, mChannel, mValue3:0, payload:{}} on the device channel.
      // sendSetPayload can throw synchronously (e.g. "not connected"); clean up the listener + timer
      // so they don't dangle until the timeout, then propagate the failure.
      try {
        session.sendSetPayload(subCmd, {}, { accountId, channel });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * **Generic control-payload request/reply query.** Sends a `CONTROL_PAYLOAD` (1700) `{commandType,
   * data}` (level chosen by topology, like {@link routeControl}), then resolves with the reply
   * frame's `payload` — the `NOTIFY_PAYLOAD` (1351) whose JSON `cmd` echoes `param` — decoded off the
   * session `data` event. The listener is armed BEFORE the send so a fast reply can't race it (same
   * ordering as {@link p2pQuery}).
   */
  async p2pControlQuery(
    sn: string,
    param: number,
    data: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    // Resolve the session up front so the reply listener attaches to the exact session the send will
    // use; sendBySessionLevel re-reads the session for the send itself.
    const { session } = await this.resolveSession(sn, { waitLevel2: false });
    const timeoutMs = opts.timeoutMs ?? 15000;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for p2p control query ${param} reply from ${sn}`));
      }, timeoutMs);
      const onData = (f: P2PFrame): void => {
        const j = f.json as { cmd?: number; payload?: unknown } | undefined;
        if (j?.cmd === param && j.payload && typeof j.payload === "object") {
          cleanup();
          resolve(j.payload as Record<string, unknown>);
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        session.off("data", onData);
      };
      session.on("data", onData);
      // CONTROL_PAYLOAD(1700) {commandType:param, data}: L1 ECB for a standalone device, L2 GCM for a
      // HomeBase-attached one. sendBySessionLevel re-reads the session; the reply lands on the same session.
      const json = JSON.stringify({ commandType: param, data });
      this.sendBySessionLevel(sn, {
        l1: ({ session: s, channel: ch }) => {
          s.sendStringPayloadCommand(P2P_ENVELOPE.CONTROL_PAYLOAD, json, ch);
          return Promise.resolve();
        },
        l2: async ({ session: s, channel: ch, parentSn }) => {
          if (!(await s.awaitLevel2Key(LEVEL2_GRACE_MS, "call"))) {
            throw new StationKeyUnavailableError(parentSn);
          }
          s.sendRawLevel2(json, ch, P2P_ENVELOPE.CONTROL_PAYLOAD);
        },
      }).catch((e) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /**
   * Resolve a scalar `"set-param"` intent to a concrete P2P frame — the ONE place that maps a
   * capability's *what* (param + value + {@link ScalarForm}) to the *how* (encryption level + wire):
   * `"auto"` defers the level to {@link sendBySessionLevel} — the ONE decision point — while
   * `"int-string"` pins L1 and `"direct-binary"` pins L2.
   */
  private async resolveScalarParam(sn: string, param: number, value: number, form: ScalarForm): Promise<void> {
    if (form === "int-string") {
      await this.sendIntStringCommand(sn, param, value);
      return;
    }
    if (form === "direct-binary") {
      await this.sendDirectBinary(sn, param, value);
      return;
    }
    await this.sendBySessionLevel(sn, {
      l1: () => this.sendIntStringCommand(sn, param, value),
      l2: () => this.sendDirectBinary(sn, param, value),
    });
  }

  /**
   * Read the camera's LIVE authoritative RTSP URL — host, path, and the credentials it enforces
   * RIGHT NOW — by writing the publish switch `CMD_NAS_SWITCH` (idempotent when already on, and never
   * touching the credentials themselves, so a NAS/NVR consuming the stream elsewhere is undisturbed)
   * plus `CMD_NAS_TEST` to start the livestream, then awaiting the `rtspUrl` event `P2PSession` emits
   * for a matching-channel `CMD_NAS_SWITCH` push. This is the only source of the freshly-generated
   * credentials: the vendor app regenerates them on every publish toggle and the cloud record lags.
   *
   * Both provokes go through {@link resolveScalarParam} `"auto"` — the ONE level decision — not a
   * pinned level-1 send: a keyed HomeBase publishes 1145 on its level-2 seal, and the level-1 form is
   * silently ignored there (the likely cause of attached-camera reads never answering). The shared
   * path also repeats the datagram for RF resilience, exactly as the normal publish does.
   *
   * A single channel-filtered listener is armed BEFORE the provokes and torn down on either outcome,
   * so a fast push cannot fall in a re-arm gap and a station that never answers leaks nothing. The
   * station is shared by every channel (a HomeBase multiplexes its attached cameras over one session),
   * so a push for another camera is filtered out rather than resolving this read.
   *
   * Bounded by {@link RTSP_URL_READ_TIMEOUT_MS}: the abort covers `resolveSession`'s connect wait and
   * the URL wait. The device/station resolution ahead of them relies on its own HTTP timeouts.
   *
   * `undefined` on any failure: no route, no account id, or no matching push before the deadline.
   */
  async readReportedRtspUrl(sn: string): Promise<string | undefined> {
    const log = this.deps.logger ?? noopLogger;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RTSP_URL_READ_TIMEOUT_MS);
    const { signal } = controller;
    try {
      const { session, channel, accountId } = await this.resolveSession(sn, { waitLevel2: "soft", signal });
      if (!accountId) return undefined;
      // Arm the wait BEFORE provoking, so a push that arrives between the two writes is not lost.
      const url = this.awaitRtspUrl(session, channel, signal);
      // Provoke through the ONE level decision (and its RF-resilience repeat), but do not block the read
      // on the retransmits finishing: the URL push can land after the first datagram, so the read
      // returns as soon as it arrives (or the deadline aborts), while the repeats run to completion.
      // The publish switch alone does not elicit the push; the livestream test paired with it does.
      for (const cmd of [CommandType.CMD_NAS_SWITCH, CommandType.CMD_NAS_TEST]) {
        void this.resolveScalarParam(sn, cmd, 1, "auto").catch((e) =>
          log.debug(`[p2p] ${sn} RTSP provoke ${cmd} failed`, e),
        );
      }
      return await url;
    } catch (e) {
      log.debug(`[p2p] ${sn} live RTSP URL read ${signal.aborted ? "timed out" : "failed"}`, e);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One channel-filtered wait for the station's `rtspUrl` push: a single persistent listener, attached
   * up front and removed on resolve or abort, so nothing leaks and no push falls in a re-arm gap. The
   * station multiplexes every attached camera's channel over one session, so a push for another camera
   * is ignored rather than resolving the wrong read.
   */
  private awaitRtspUrl(session: P2PSession, channel: number, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onUrl = (ev: { channel: number; url: string }): void => {
        if (ev.channel !== channel) return;
        cleanup();
        resolve(ev.url);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason ?? new Error("aborted"));
      };
      const cleanup = (): void => {
        session.off("rtspUrl", onUrl);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
      session.on("rtspUrl", onUrl);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * The single point that turns a session into an encryption **level**: level-2 when the session HOLDS a
   * level-2 key, level-1 otherwise. Both the `"auto"` scalar path and the JSON control path route
   * through here, so the rule is defined exactly once.
   *
   * The discriminator is the key, NOT topology, because that is what the app does. Captured across five
   * peers of four device families and both topologies, every peer used ONE seal for every command family
   * it sent — level-2 for each keyed session including two own-session cameras, level-1 only for the two
   * whose negotiation never completes. Reading attachment instead mispredicts those two own-session
   * cameras, and a level-2-only wire chosen for a session that holds no key cannot be sent at all.
   *
   * The key is waited for softly: a session that will not have one falls through to level-1, which is a
   * working wire here rather than a degraded guess, instead of spending a per-call grace to learn that.
   */
  private async sendBySessionLevel(
    sn: string,
    send: { l1: (r: ResolvedSession) => Promise<void>; l2: (r: ResolvedSession) => Promise<void> },
  ): Promise<void> {
    const resolved = await this.resolveSession(sn, { waitLevel2: "settle" });
    await (resolved.session.hasLevel2Key ? send.l2(resolved) : send.l1(resolved));
  }

  /**
   * Resolve a device serial to its P2P session + routing params: the HomeBase/parent session for an
   * attached camera or the device's own, its `device_channel`, and the admin account id. Opens the
   * station's P2P session on demand if needed and waits for it to connect, then holds it warm briefly
   * (a command keepalive, so a burst of commands / a follow-up read reuses it instead of paying a fresh
   * handshake — a no-op for a wired/persistent station).
   *
   * `waitLevel2` states what the caller does about the key:
   *
   *  - `true` — cannot frame without it. Waits the full grace, re-prompts once, and throws if refused.
   *  - `"settle"` — picks its seal once from {@link P2PSession.hasLevel2Key}. Waits {@link LEVEL2_SETTLE_MS}
   *    session-scoped for the negotiation to conclude either way, then proceeds. Never throws.
   *  - `"soft"` — frames per send and is re-issued, so it does not wait at all.
   *  - `false` / absent — no wait; enough to read topology.
   *
   * `requireLevel2ForAttached` promotes a `"soft"` caller to `true` on a HomeBase-attached camera, whose media
   * start has no level-1 form at all.
   *
   * A `"soft"` caller frames per send: an own-session start issued with no key rides level 1, and its own
   * re-issue rides level 2 once the key lands. Nothing bounds an unanswered `CMD_GATEWAYINFO`, so a waiting
   * caller's grace is the bound, charged from connect.
   *
   * Only a caller that REQUIRES the key re-prompts — see {@link P2PSession.repromptLevel2Key}, which explains
   * why one settled negotiation is not the last word.
   *
   * A session whose {@link P2PSession.pathAnswering} is false is closed and re-resolved before it is handed
   * over: the station answers every heartbeat, so a path silent past several of them is gone. A session
   * reporting nothing about its path is not reporting that evidence and is handed over as it is. Replaced at
   * most once per resolution, so a station whose replacement is silent too is returned rather than closed
   * again.
   */
  private async resolveSession(
    sn: string,
    opts: { waitLevel2?: boolean | "soft" | "settle"; requireLevel2ForAttached?: boolean; signal?: AbortSignal } = {},
    /** Whether this resolution has already replaced a silent path — see the check below. */
    rebuilt = false,
  ): Promise<ResolvedSession> {
    const dev = await this.deviceFor(sn);
    const raw = (dev.raw ?? {}) as Record<string, any>;
    const homeBaseAttached = !!raw.parent_sn && raw.parent_sn !== sn;
    const parentSn = homeBaseAttached ? (raw.parent_sn as string) : (dev.stationSn ?? sn);
    const session =
      this.manager.get(parentSn) ??
      this.manager.get(sn) ??
      (dev.stationSn ? this.manager.get(dev.stationSn) : undefined);
    if (!session) {
      const stations = this.manager.keys().filter((k) => !P2PCommandRouter.isMediaSessionKey(k));
      throw new Error(`no P2P session for ${sn} (known: ${stations.join(", ") || "none"})`);
    }
    if (session.pathAnswering === false && !rebuilt) {
      (this.deps.logger ?? noopLogger).debug(`[p2p] ${parentSn} path stopped answering — rebuilding before use`);
      await this.manager
        .close(parentSn)
        .catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))));
      return await this.resolveSession(sn, opts, true);
    }
    this.manager.bumpCommand(parentSn, parentSn);
    const channel = typeof raw.device_channel === "number" ? (raw.device_channel as number) : 0;
    const stationAdminId = (raw.member as any)?.admin_user_id;
    const stationModel = this.recordFor(parentSn)?.model;
    const accountId = (stationAdminId as string) ?? this.deps.mega.auth?.userId ?? "";

    this.traceOnStation(session, {
      phase: "station-resolved",
      topology: homeBaseAttached ? "attached" : "own",
      channel,
      stationAdmin:
        typeof stationAdminId !== "string"
          ? "unstated"
          : stationAdminId === this.deps.mega.auth?.userId
            ? "self"
            : "other",
      ...(stationModel ? { stationModel } : {}),
    });

    const t0 = Date.now();
    let waitedMs = 0;
    if (!session.isConnected) {
      this.traceOnStation(session, { phase: "session-connect-wait", waitMs: P2P_STATION_WAITS.connect });
      while (!session.isConnected && Date.now() - t0 < P2P_STATION_WAITS.connect) {
        opts.signal?.throwIfAborted();
        await sleep(200);
      }
      waitedMs = Date.now() - t0;
      this.traceOnStation(
        session,
        session.isConnected ? { phase: "session-connected", waitedMs } : { phase: "session-unreachable", waitedMs },
      );
    }
    opts.signal?.throwIfAborted();
    if (!session.isConnected) throw new StationUnreachableError(parentSn, waitedMs);
    if (opts.waitLevel2) {
      if (opts.waitLevel2 === "settle") {
        await abortable(session.awaitLevel2Key(LEVEL2_SETTLE_MS, "session"), opts.signal);
        return { session, parentSn, channel, accountId, homeBaseAttached };
      }
      const required = opts.waitLevel2 !== "soft" || (opts.requireLevel2ForAttached === true && homeBaseAttached);
      if (!required) return { session, parentSn, channel, accountId, homeBaseAttached };
      let ready = await abortable(session.awaitLevel2Key(LEVEL2_GRACE_MS, "call"), opts.signal);
      if (!ready && session.repromptLevel2Key()) {
        ready = await abortable(session.awaitLevel2Key(LEVEL2_GRACE_MS, "call"), opts.signal);
      }
      if (!ready) throw new StationKeyUnavailableError(parentSn);
    }
    return { session, parentSn, channel, accountId, homeBaseAttached };
  }

  /**
   * Shared machinery for the fire-and-forget **level-2 control senders** (direct-binary, station
   * scalar, set-payload envelope): resolve the device's HomeBase P2P session (waiting for connect +
   * the level-2 key), then replay the one-shot `send` `DIRECT_CMD_SENDS`× at 200ms spacing for RF
   * resilience. If NONE went out (no key / not connected) we throw, so a fully-dropped command
   * surfaces as an error, not a false success.
   *
   * `resolved` lets a caller that already has a {@link ResolvedSession} (e.g. `sendFf09Autolock`,
   * which resolves once up front to arm its GET-reply listener) skip a redundant re-resolve — cheap
   * once the level-2 key is ready (a Map lookup + already-satisfied waits), but still wasted work the
   * MQTT sibling doesn't do. Omit it to resolve fresh, as every other caller does.
   */
  private async replayLevel2Send(
    sn: string,
    describe: string,
    send: (r: ResolvedSession) => boolean,
    resolved?: ResolvedSession,
  ): Promise<void> {
    resolved ??= await this.resolveSession(sn, { waitLevel2: true });
    let sent = false;
    for (let i = 0; i < DIRECT_CMD_SENDS; i++) {
      if (send(resolved)) sent = true;
      await sleep(200);
    }
    if (!sent) {
      throw new Error(`${describe} for ${sn} was never sent (no level-2 key / session not connected)`);
    }
  }

  /**
   * **"Direct" binary control command** (camera on/off `1035`, spotlight brightness `1401` / color-temp
   * `1410` / enable `1403`, audio switches): the 136-byte body ({@link buildDirectBinaryBody} with the
   * resolved device channel) on that channel at signCode 8, `outerCmd` = the param id.
   */
  private async sendDirectBinary(sn: string, outerCmd: number, value: number): Promise<void> {
    await this.replayLevel2Send(sn, `direct cmd ${outerCmd}`, ({ session, channel, accountId }) =>
      session.sendRawLevel2Bytes(buildDirectBinaryBody(value, accountId, channel), channel, outerCmd, 8),
    );
  }

  /**
   * **Station-scoped scalar** (`p2p-station-scalar` intent): the 132-byte channel-less body
   * ({@link buildDirectBinaryBody} with no `channel`) on an EXPLICIT channel, signCode 8. The
   * HomeBase's own controls ride the station broadcast channel 255 (alarm/speaker volume 1235).
   */
  private async sendStationScalar(sn: string, outerCmd: number, value: number, channel: number): Promise<void> {
    await this.replayLevel2Send(sn, `station scalar cmd ${outerCmd}`, ({ session, accountId }) =>
      session.sendRawLevel2Bytes(buildDirectBinaryBody(value, accountId), channel, outerCmd, 8),
    );
  }

  /** Send a level-1 int-plus-string frame with authenticated account identity injected by the transport. */
  private async sendIntString(
    sn: string,
    commandType: number,
    value: number,
    valueSub: number,
    channel: number,
  ): Promise<void> {
    const { session, accountId } = await this.resolveSession(sn);
    if (!accountId) throw new Error(`int-plus-string command ${commandType} for ${sn} requires an account id`);
    session.sendIntStringCommand(commandType, value, valueSub, accountId, channel);
  }

  /**
   * **`set-json-raw` intent** — bare JSON, no envelope: outer P2P cmd = `outerCmd` itself, plaintext
   * exactly `{account_id,...data}` (`session.sendRawLevel2` with no wrapper). Reversed from a live
   * capture of the app's own SET_SNOOZE_TIME (1271) frame — see `param-dictionary.ts`'s `1271` entry
   * (`snoozeTime`); the alarm-delay config (1255, `arming.ts`'s `ARMING_CMD.ALARM_DELAY_CONFIG`) reuses
   * the same bare-JSON shape.
   */
  private async sendJsonRaw(
    sn: string,
    outerCmd: number,
    data: Record<string, unknown>,
    channel: number,
  ): Promise<void> {
    await this.replayLevel2Send(sn, `set-json-raw cmd ${outerCmd}`, ({ session, accountId }) =>
      session.sendRawLevel2(JSON.stringify({ account_id: accountId, ...data }), channel, outerCmd),
    );
  }

  /**
   * **`set-payload` intent** — a `SET_PAYLOAD` (1350) envelope (`{account_id,cmd,mChannel,mValue3:cmd,
   * payload}`). The intent's `channel` is authoritative (resolveSession supplies only the session +
   * account_id) — so a capability that targets a specific channel isn't overridden. `resolved` — see
   * {@link replayLevel2Send}'s doc — lets a caller that already resolved the session skip a redundant
   * re-resolve.
   *
   * **Level follows topology** when `form` is `"auto"`, as in {@link resolveScalarParam}: a
   * HomeBase-attached device takes the GCM signCode-8 form, a standalone one the level-1 form. A
   * standalone camera never negotiates a level-2 key, so pinning this to level 2 makes the envelope
   * unreachable on exactly the devices that serve their own RTSP stream. Verified live: a standalone
   * camera accepts the level-1 form. With no `form` (default) it stays level-2 only.
   */
  private async sendSetPayloadEnvelope(
    sn: string,
    cmd: number,
    payload: Record<string, unknown>,
    channel: number,
    mValue3?: number,
    resolved?: ResolvedSession,
    form?: ScalarForm,
  ): Promise<void> {
    if (form === "auto") {
      await this.sendBySessionLevel(sn, {
        l1: ({ session, accountId }) => {
          session.sendSetPayload(cmd, payload, { accountId, channel });
          return Promise.resolve();
        },
        // NB: do NOT forward sendBySessionLevel's resolved session here — it was resolved with
        // waitLevel2:false (enough to read topology), so on a HomeBase-attached device the level-2
        // key may not be ready yet. Let replayLevel2Send re-resolve with waitLevel2:true and wait for
        // it, exactly as the non-`form` path below does; otherwise the send throws "never sent".
        l2: () =>
          this.replayLevel2Send(sn, `set-payload cmd ${cmd}`, ({ session, accountId }) =>
            session.sendControlLevel2(cmd, channel, accountId, payload, mValue3 ?? cmd),
          ),
      });
      return;
    }
    await this.replayLevel2Send(
      sn,
      `set-payload cmd ${cmd}`,
      ({ session, accountId }) => session.sendControlLevel2(cmd, channel, accountId, payload, mValue3 ?? cmd),
      resolved,
    );
  }

  /**
   * **`ff09-actuate` intent** — build the `ff09` AES-128-CBC frame ({@link buildFf09Frame}, shared with the
   * MQTT transport — see `transport/ff09.ts`) and dispatch it in the `1940` TRANSFER_PAYLOAD envelope
   * (`{apiCommand, lock_payload, seq_num, time}`) as a `set-payload` (1350), `mValue3=0`, on the lock's
   * device channel. This is the P2P envelope; the capability module only supplies identity, never wire
   * bytes and never the routing channel — that's re-resolved here from the device record.
   */
  private async sendFf09Actuate(sn: string, cmd: Ff09Identity): Promise<void> {
    const resolved = await this.resolveSession(sn, { waitLevel2: true });
    const frame = buildFf09Frame({
      engage: cmd.engage,
      adminUserId: cmd.adminUserId,
      username: cmd.username,
      shortUserId: cmd.shortUserId,
      deviceSn: cmd.deviceSn,
    });
    await this.sendSetPayloadEnvelope(
      sn,
      CMD_TRANSFER_PAYLOAD,
      ff09TransferPayload(frame),
      resolved.channel,
      0,
      resolved,
    );
  }

  /**
   * How long {@link sendFf09Autolock} waits for the device's settings **GET** reply before
   * giving up. Unlike the MQTT sibling (`MqttCommandRouter.dispatchFf09Autolock`, one TCP publish), the P2P
   * GET is replayed `DIRECT_CMD_SENDS`× over ~800ms by {@link sendSetPayloadEnvelope} for RF
   * resilience before this wait even starts counting down the rest — so the budget only needs to cover
   * the reply's own travel time, not the resend window.
   */
  private static readonly FF09_SETTINGS_GET_TIMEOUT_MS = 10000;

  /**
   * **`ff09-autolock` intent over P2P** — read-modify-write the T8531's auto-lock setting. The
   * P2P sibling of `MqttCommandRouter.dispatchFf09Autolock`; same GET-then-SET shape, same `ff09`
   * frame/cipher. ✅ LIVE-VERIFIED end-to-end (2026-07-18): `dev.lock()?.setAutoLock(false)` THEN
   * `setAutoLock(true)` driven through this exact codepath against a real T8531, both directions
   * confirmed via the app UI showing autolock off then on afterward — not just byte-exact against a
   * capture. Differs from the MQTT flow only in the envelope + reply matching:
   *
   * Resolves the session ONCE up front (needed to arm the reply listener before sending) and passes it
   * to both `sendSetPayloadEnvelope` calls (GET + SET) — skips the redundant re-resolve each would
   * otherwise do internally (see {@link replayLevel2Send}'s doc).
   *
   *  1. Build the settings GET frame ({@link buildFf09QueryFrame}) and send it the same way
   *     `sendFf09Actuate` sends a lock/unlock — a `1940` TRANSFER_PAYLOAD `set-payload` (1350) on the
   *     lock's device channel. Arm a `session.on("data", …)` listener BEFORE sending (same
   *     arm-before-send ordering as {@link p2pQuery}), matching the reply by `f.json.cmd ===
   *     CMD_TRANSFER_PAYLOAD` (the device's `/res`-equivalent reply always carries this inner cmd,
   *     same as any other transfer-payload traffic on this channel — so `cmd` alone isn't enough) AND
   *     `f.json.payload.time` equal to the GET's own `time`. **Confirmed live (2026-07-17) against a
   *     real T8531 capture: the P2P reply's `time` field is a HEX STRING** (e.g. `"6A5908BD"`),
   *     identical to the MQTT reply's convention — NOT the decimal the outbound `time` field uses. No
   *     reply within {@link FF09_SETTINGS_GET_TIMEOUT_MS} throws (same rationale as the MQTT side:
   *     guessing A7/A8 would be worse than failing loud).
   *  2+3. Decrypt the reply, preserve the current delay (`a2`) + `A7`/`A8` passthrough values (`a4`/
   *     `a5`), and build the SET frame — the decrypt→read→rebuild shared with the MQTT sibling as
   *     `transport/ff09.ts`'s {@link buildFf09AutolockSetFrame} — then send it the same fire-and-forget
   *     way as `sendFf09Actuate` (no ack wait, matching every other P2P write in this router; there is no
   *     `commandAck` event plumbing at this layer — that's an `EufyMega`-level concern the MQTT
   *     dispatcher happens to have because it owns its own MQTT connection lifecycle).
   */
  private async sendFf09Autolock(
    sn: string,
    cmd: {
      adminUserId: string;
      deviceSn: string;
      enabled: boolean;
      delaySeconds?: number;
    },
  ): Promise<void> {
    const resolved = await this.resolveSession(sn, { waitLevel2: true });

    // ── 1. GET current settings, matched back by keyTime (shared with getAutoLockState — see helper). ──
    const getReply = await this.fetchFf09SettingsGetReply(sn, cmd, resolved);

    // ── 2+3. Decrypt the reply, preserve A7/A8 + delay, build the SET frame (shared with the MQTT
    //         sibling — see buildFf09AutolockSetFrame), then send it fire-and-forget. ──────────────
    const setFrame = buildFf09AutolockSetFrame({
      lockPayload: getReply.lockPayload,
      keyTime: getReply.keyTime,
      adminUserId: cmd.adminUserId,
      deviceSn: cmd.deviceSn,
      enabled: cmd.enabled,
      delaySeconds: cmd.delaySeconds,
    });
    await this.sendSetPayloadEnvelope(
      sn,
      CMD_TRANSFER_PAYLOAD,
      ff09TransferPayload(setFrame),
      resolved.channel,
      0,
      resolved,
    );
  }

  /**
   * Shared GET-and-wait step behind both {@link sendFf09Autolock} (which reads to preserve A7/A8 across
   * a write) and {@link getAutoLockState} (which reads for its own sake) — extracted so the two don't
   * drift on the arm-before-send / listener-leak / keyTime-matching machinery. Arms a
   * `session.on("data", …)` listener BEFORE sending the GET (same ordering as {@link p2pQuery}); the
   * `cleanup`/`onData`/`timer` are hoisted out of the Promise executor so the try/catch can tear the
   * listener down if the send itself throws (without it a send failure would leak `onData` on the
   * long-lived shared session for the full timeout window). Matches the reply by inner
   * `cmd === CMD_TRANSFER_PAYLOAD` AND `payload.time` (a hex string live) equal to the GET's own
   * keyTime. Throws if no matching reply arrives within {@link FF09_SETTINGS_GET_TIMEOUT_MS}.
   */
  private async fetchFf09SettingsGetReply(
    sn: string,
    cmd: { adminUserId: string; deviceSn: string },
    resolved: ResolvedSession,
  ): Promise<{ lockPayload: string; keyTime: number }> {
    const { session } = resolved;
    const query = buildFf09QueryFrame({ adminUserId: cmd.adminUserId, deviceSn: cmd.deviceSn });
    let onData!: (f: P2PFrame) => void;
    let timer!: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      session.off("data", onData);
    };
    const getReplyPromise = new Promise<{ lockPayload: string; keyTime: number } | undefined>((resolve) => {
      onData = (f: P2PFrame): void => {
        const j = f.json as { cmd?: number; payload?: Record<string, unknown> } | undefined;
        if (j?.cmd !== CMD_TRANSFER_PAYLOAD || !j.payload) return;
        const rawTime = j.payload.time;
        const lockPayload = j.payload.lock_payload;
        if (typeof lockPayload !== "string" || (typeof rawTime !== "string" && typeof rawTime !== "number")) return;
        const keyTime = ff09ReplyKeyTime(rawTime);
        if (keyTime === undefined || keyTime !== query.time) return; // other traffic — keep waiting
        cleanup();
        resolve({ lockPayload, keyTime });
      };
      timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, P2PCommandRouter.FF09_SETTINGS_GET_TIMEOUT_MS);
      session.on("data", onData);
    });
    try {
      await this.sendSetPayloadEnvelope(
        sn,
        CMD_TRANSFER_PAYLOAD,
        ff09TransferPayload(query),
        resolved.channel,
        0,
        resolved,
      );
    } catch (e) {
      cleanup();
      throw e;
    }
    const getReply = await getReplyPromise;
    if (!getReply) {
      throw new Error(
        `fetchFf09SettingsGetReply(${sn}): no settings GET reply within ` +
          `${P2PCommandRouter.FF09_SETTINGS_GET_TIMEOUT_MS}ms.`,
      );
    }
    return getReply;
  }

  /**
   * **Read the T8531's current auto-lock settings over P2P** — the `Ff09SettingsReader` behind
   * `dev.lock()?.getAutoLockState()`. A pure GET, no SET: reuses {@link fetchFf09SettingsGetReply} (the
   * same GET step {@link sendFf09Autolock} runs internally to preserve A7/A8), then decrypts + decodes
   * fields `a1`-`a5` per `transport/ff09.ts`'s response tag map (`a1`=enabled, `a2`=delaySeconds,
   * `a3`=isSchedule, `a4`/`a5`=schedule start/end as raw `[hour,minute]` byte pairs — see
   * {@link readFf09HourMinute}'s doc for why these aren't a packed number). Live-verified only insofar
   * as the underlying GET step already is (`setAutoLock`'s own read) — the standalone read path itself
   * has not been independently exercised against a real device yet.
   */
  async getAutoLockState(sn: string, cmd: { adminUserId: string; deviceSn: string }): Promise<AutoLockSnapshot> {
    const resolved = await this.resolveSession(sn, { waitLevel2: true });
    const getReply = await this.fetchFf09SettingsGetReply(sn, cmd, resolved);
    return decodeFf09AutoLockSnapshot(
      parseFf09SettingsResponse(
        decryptFf09Frame({
          lockPayload: getReply.lockPayload,
          keyTime: getReply.keyTime,
          adminUserId: cmd.adminUserId,
          deviceSn: cmd.deviceSn,
        }),
      ),
    );
  }

  /**
   * **`ff09-setting-toggle` intent** — the COMPACT single-setting `SET_SETTINGS` write (currently:
   * T8531 Rain Mode, `settingId` = `ff09.ts`'s `FF09_SETTING_ID.RAIN_MODE`). Unlike
   * {@link sendFf09Autolock}, this is a pure blind write — no GET pass, no reply wait — since the
   * compact frame ({@link buildFf09SettingToggleFrame}) only carries the one field being changed, same
   * fire-and-forget shape as {@link sendFf09Actuate}. ✅ LIVE-VERIFIED end-to-end (2026-07-18):
   * `dev.lock()?.setRainMode()` driven through this exact codepath against a real T8531, both
   * directions confirmed via the app UI showing the new state afterward — not just byte-exact against a
   * capture. See `transport/ff09.ts`'s "Rain Mode" doc section. The routing channel is re-resolved from
   * the device record — the capability never supplies it.
   */
  private async sendFf09SettingToggle(
    sn: string,
    cmd: { adminUserId: string; deviceSn: string; settingId: number; value: boolean },
  ): Promise<void> {
    const resolved = await this.resolveSession(sn, { waitLevel2: true });
    const frame = buildFf09SettingToggleFrame({
      adminUserId: cmd.adminUserId,
      deviceSn: cmd.deviceSn,
      settingId: cmd.settingId,
      value: cmd.value,
    });
    await this.sendSetPayloadEnvelope(
      sn,
      CMD_TRANSFER_PAYLOAD,
      ff09TransferPayload(frame),
      resolved.channel,
      0,
      resolved,
    );
  }

  /**
   * Send a level-1 **int+string** command (floodlight/spotlight switch 1400 on IndoorOutdoor /
   * SoloCam-spotlight / Cam2C-3). No level-2 key needed (standalone level-1 ECB). Fire-and-forget,
   * repeated for RF resilience.
   */
  private async sendIntStringCommand(sn: string, outerCmd: number, value: number): Promise<void> {
    const { session, channel, accountId } = await this.resolveSession(sn);
    for (let i = 0; i < DIRECT_CMD_SENDS; i++) {
      session.sendIntStringCommand(outerCmd, value, channel, accountId, channel);
      await sleep(200);
    }
  }

  /**
   * Play the **privacy-mode multi-frame burst** over P2P (the `p2p-privacy-burst` command). Privacy
   * does NOT engage as one frame — the app sends a MULTI-CHANNEL BURST of level-2 (signCode 8) frames.
   * Reversed from a live capture: 1103 precursor on ch255 → 6250 SET on ch0 ×2 → 6250 SET on the
   * camera channel ×3 → 1103 companion on ch0. Every frame is signCode 8 (a signCode-1 header on a
   * GCM body is silently dropped).
   */
  private async sendPrivacyBurst(sn: string, enabled: boolean): Promise<void> {
    const { session, channel, accountId } = await this.resolveSession(sn, { waitLevel2: true });

    const setJson = Buffer.from(
      JSON.stringify({
        account_id: accountId,
        cmd: P2P_ENVELOPE.PRIVACY_MODE,
        mChannel: channel,
        mValue3: 0,
        payload: { switch: enabled ? 1 : 0 },
      }),
      "utf-8",
    );
    const camInfoPre = Buffer.from("ff00000087030000", "hex"); // 1103 GET_CAMERA_INFO precursor
    const gap = () => sleep(150);

    session.sendRawLevel2Bytes(camInfoPre, 255, P2P_ENVELOPE.GET_CAMERA_INFO, 8); // precursor on the station channel
    await gap();
    for (let i = 0; i < 2; i++) {
      session.sendRawLevel2Bytes(setJson, 0, P2P_ENVELOPE.SET_PAYLOAD, 8); // SET on ch0 (station scope)
      await gap();
    }
    for (let i = 0; i < 3; i++) {
      session.sendRawLevel2Bytes(setJson, channel, P2P_ENVELOPE.SET_PAYLOAD, 8); // SET on the camera channel
      await gap();
    }
    session.sendRawLevel2Bytes(camInfoPre, 0, P2P_ENVELOPE.GET_CAMERA_INFO, 8); // 1103 companion on ch0
  }

  /**
   * Route a control command (`{commandType, data}`) to a device over P2P: HomeBase-attached →
   * level-2 GCM (bare plaintext, channel in the frame header), standalone → level-1 ECB. Waits for
   * the session to connect + (for HomeBase) the level-2 key.
   */
  private async routeControl(
    sn: string,
    outerCmd: number,
    inner: { commandType: number; data: unknown },
  ): Promise<void> {
    // HomeBase-attached → level-2 GCM (wait for the key); standalone → level-1 ECB. The L1/L2 choice
    // itself lives in sendBySessionLevel; here we only supply the two JSON senders.
    const json = JSON.stringify(inner);
    await this.sendBySessionLevel(sn, {
      l1: ({ session, channel }) => {
        session.sendStringPayloadCommand(outerCmd, json, channel);
        return Promise.resolve();
      },
      l2: async ({ session, channel }) => {
        if (!(await session.awaitLevel2Key(LEVEL2_GRACE_MS, "call"))) {
          throw new Error(`level-2 key not ready for ${sn} — cannot route HomeBase command`);
        }
        session.sendRawLevel2(json, channel, outerCmd);
      },
    });
  }
}
