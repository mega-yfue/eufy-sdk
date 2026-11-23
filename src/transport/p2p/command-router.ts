/**
 * P2P command router — the transport-side owner of the ThroughTek PPCS sessions and every wire
 * operation over them: opening sessions, resolving a serial to its session + routing params,
 * mapping a transport-neutral {@link Command} to a concrete frame (encryption level, wire shape),
 * the control senders, request/reply queries, and the media provider.
 *
 * Layering: this module knows P2P bytes; it does NOT know capabilities. Frame → semantic-event
 * decoding is a model concern, so raw frames are handed back to the client via {@link P2PRouterDeps.onFrame}
 * (the client gates them on device capabilities and emits typed events). This keeps transport free of
 * any `model/` import — the capability↔transport decorrelation invariant.
 */
import { abortable } from "../abortable.js";
import type { MegaHttpClient } from "../http/mega-client.js";
import type { EufyDevice } from "../../core/types.js";
import type {
  Command,
  Ff09Identity,
  AutoLockSnapshot,
  MediaProvider,
  RecordingDownload,
  AacEncoder,
  SharedSourceHints,
  AbortableCall,
  LiveAudioFrame,
  LiveFrames,
  TalkbackCodec,
  TalkbackHandle,
} from "../../core/contracts.js";
import {
  DeviceChannelUnresolvedError,
  RecordingDownloadError,
  CommandResultError,
  StationUnreachableError,
} from "../../core/contracts.js";
import { buildKeyedActuatePayload, keyedPayloadReportCode, keyedPayloadSeqMark } from "./keyed-payload.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { assertNever, isStationSerial } from "../../core/util.js";
import { memberAccountId } from "../../core/member.js";
import { setTimeout as sleep } from "node:timers/promises";
import { CONNECT_TIMEOUT_MS, P2PSession, STATION_CHANNEL, type P2PFrame } from "./p2p-session.js";
import { buildDirectBinaryBody, buildStringBody } from "./write-commands.js";
import { buildDoorlockPassThrough, sealStationPayload } from "./doorlock-pass-through.js";
import { CommandType } from "./commands.js";
import {
  buildFf09Frame,
  buildFf09QueryFrame,
  buildFf09SettingToggleFrame,
  buildFf09AutolockSetFrame,
  buildFf09TlvFrame,
  decryptFf09Frame,
  parseFf09SettingsResponse,
  decodeFf09AutoLockSnapshot,
  ff09ReplyKeyTime,
  ff09TransferPayload,
  CMD_TRANSFER_PAYLOAD,
} from "../ff09.js";
import { P2PDataType, stationCloudAddresses } from "./codec.js";
import { P2P_ENVELOPE } from "./envelope.js";
import { freshestLanIp } from "./lan-ip.js";
import { captureSnapshotFromShared, recordClip } from "./media.js";
import {
  RECORDING_STATIONS,
  decodeRecording,
  receiveRecording,
  type RecordingStation,
  type RecordingTransfer,
} from "./recording-download.js";
import type { FfmpegLevel } from "../ffmpeg.js";
import { LiveStream } from "./live-stream.js";
import { SharedLiveSource, attachUnlessAborted, type Consumer } from "./shared-live-source.js";
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
import { stationChannels, stationOf } from "./station-channels.js";

/**
 * `GET_CAMERA_INFO` (1103) body of the app's params read (`getParams`): `[u32 mValue = 255][u32 mValueSub = 903]`
 * (`msgType` 14, two little-endian ints). A HomeBase answers on channel 255 with its whole parameter table, every
 * attached device's entries under its own channel.
 */
const GET_PARAMS_BODY = Buffer.from("ff00000087030000", "hex");

/**
 * The app's esiotkit pinger (`P2PPingManagerImpl`, `PingTask`): one 1139 every `PING_INTERVAL_MS` per parent serial
 * that is not a station, for `PING_WINDOW_MS` after each command and device-list change, without end while live view
 * plays and for `PING_WINDOW_MS` after it stops; a windowed task ends `PING_TASK_MAX_MS`, or its window if longer,
 * after it began. The parent's thing properties `p2p_ping_interval` (ms) and `p2p_ping_timeout` (s) replace the
 * interval and the window when above 0.
 */
const PING_INTERVAL_MS = 3_000;
const PING_WINDOW_MS = 300_000;
const PING_TASK_MAX_MS = 30 * 60_000;

/**
 * The app's legacy pinger (`PingTimeUtil`) runs beside it for a hub that is `SnUtils.O4` and not `P4`, whose model
 * strategy answers `isNeedPing`: one 1139 every `PING_INTERVAL_MS` within 240 s (`MAX_TIME`, 120 s for a FgCam's
 * `pingTime`) of the last command to the hub, whatever that command (`P2PConfigManager` listener after
 * `ActionInterceptor`). The hub prefixes and their window.
 */
const LEGACY_PING_MS: ReadonlyArray<readonly [string, number]> = [
  ...["T8122", "T8123", "T8124", "T8130", "T8131", "T8134", "T8B00", "T8170", "T8171", "T8790", "T81A0"].map(
    (prefix) => [prefix, 240_000] as const,
  ),
  ["T86P2", 120_000],
];

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
 * waits on a connection that can no longer answer.
 */
export const P2P_STATION_WAITS = { connect: CONNECT_TIMEOUT_MS } as const;

/** How long a station's live RTSP URL push is awaited — the connect wait and the URL wait together. */
const RTSP_URL_READ_TIMEOUT_MS = 12_000;

/**
 * How a level-2 setting write is settled on the device's answer, as the vendor app's P2P request does by
 * default (`P2PRequestConfig.Companion.from`, `KmmP2PRequest.canRetry`): success is code `0`, the answer is
 * the device's reply to the command itself, awaited up to 30 s; a code from 1 to 20 is resent once while
 * under 10 s from the first send.
 */
const WRITE_ANSWER = { timeoutMs: 30_000, retries: 1, retryWindowMs: 10_000, retryCodes: [1, 20] } as const;

/**
 * How long a talkback waits for an audio frame, counted from the first frame of either kind its media session
 * delivers, to learn which codec the speaker plays. A live session delivers audio every 30–64 ms, so a running stream
 * answers at once. A stream that delivers video and no audio opens as `aac-lc` once this elapses; one that delivers
 * nothing ends with its source's warm-up deadline.
 */
const TALKBACK_CODEC_WAIT_MS = 3000;

/** Models whose speaker plays `aac-eld` talkback; every other model talks `aac-lc`. */
const ELD_TALKBACK_MODELS: ReadonlySet<string> = new Set(["T8410C"]);

/**
 * The codec a camera's speaker plays: `aac-eld` when the first audio frame `consumer` delivers is `aac-eld`, otherwise
 * `aac-lc`. The `timeoutMs` wait starts at the consumer's first frame of either kind, so a cold source's warm-up is not
 * counted. Resolves `aac-lc` when that wait elapses with no audio, or when the consumer or `talk` stops first.
 */
function speakerCodec(consumer: Consumer, talk: Talkback, timeoutMs: number): Promise<TalkbackCodec> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (codec: TalkbackCodec): void => {
      clearTimeout(timer);
      consumer.off("video", onVideo);
      consumer.off("audio", onAudio);
      consumer.off("stop", onStop);
      talk.off("stop", onStop);
      resolve(codec);
    };
    const onVideo = (): void => {
      timer ??= setTimeout(() => settle("aac-lc"), timeoutMs);
    };
    const onAudio = (frame: LiveAudioFrame): void => settle(frame.codec === "aac-eld" ? "aac-eld" : "aac-lc");
    const onStop = (): void => settle("aac-lc");
    consumer.on("video", onVideo);
    consumer.on("audio", onAudio);
    consumer.on("stop", onStop);
    talk.once("stop", onStop);
  });
}

/**
 * Options accepted when warming a {@link SharedLiveSource} for a device (all optional).
 *
 * {@link SharedSourceHints} are the members any media egress may supply, because any of them may be the
 * call that opens the pull; the rest reach it only from a caller that warms a source directly.
 */
export interface SharedLiveOpts extends SharedSourceHints, AbortableCall {
  eccPrivateKey?: Buffer;
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
  "lingerMs",
  "preBufferSeconds",
  "powered",
  "batteryBudgetMs",
  "budgetGraceMs",
  "entryType",
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
/** `x` as JSON, a `"$userId"` a bundle's parser put in it (`ZoneInfo.account`) the account id, as the 1350 envelope fills it. */
const withUser = (x: unknown, accountId: string) => JSON.stringify(x, (_, v) => (v === "$userId" ? accountId : v));

interface ResolvedSession {
  session: P2PSession;
  parentSn: string;
  channel: number;
  accountId: string;
  homeBaseAttached: boolean;
}

/** The options of one {@link MediaProvider.downloadRecording} call. */
type RecordingDownloadOpts = Parameters<NonNullable<MediaProvider["downloadRecording"]>>[0];

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
  /** The station answered on its own session at `atMs` — a PONG or an ACK from the connected peer. */
  onPeerAnswer?: (stationSn: string, atMs: number) => void;
  /** A raw decoded frame — the client emits the low-level `p2p` event + runs the semantic decode. */
  onFrame: (stationSn: string, frame: P2PFrame) => void;
  /**
   * Power tier per parent-station serial (`"wired"` = persistent session, `"battery"` = on-demand +
   * idle-detach). Injected by the facade from resolved capabilities — plain data, so transport never
   * imports model. Default (absent): every station treated as `"wired"` (today's persistent behaviour).
   */
  poweredFor?: (parentSn: string) => PowerTier;
  /** The frames the app starts and stops `sn`'s live view and talkback with under `parentSn`, injected by the facade. */
  liveFramesFor?: (sn: string, parentSn: string) => LiveFrames | undefined;
  /** The default value of a thing property of `sn`'s product, as its description states it. */
  thingDefault?: (sn: string, identifier: string) => string | undefined;
  /** Idle/keepalive window overrides for the session lifecycle (see {@link SessionManagerOpts}). */
  sessionIdle?: Pick<SessionManagerOpts, "batteryIdleMs">;
  /** LAN address overrides for direct P2P, keyed by parent-station serial (host or host:port). */
  localAddresses?: Record<string, string>;
  /** Suppress the `255.255.255.255` local-lookup broadcast; cloud lookup and a known LAN address still run. */
  noBroadcast?: boolean;
  /**
   * Camera wall: give each live pull of a camera behind a station a P2P connection of its own, so several stream at
   * once. Off by default: the app holds one connection per station (`zx_set_p2p_connect_info`), and a station serves
   * one camera at a time on it.
   */
  sessionPerCamera?: boolean;
}

/** The key a camera's own media connection is filed under ({@link P2PRouterDeps.sessionPerCamera}). */
const mediaKeyOf = (parentSn: string, channel: number) => `${parentSn}#live:${channel}`;
const isMediaKey = (key: string) => key.includes("#live:");

export class P2PCommandRouter {
  /** P2P session lifecycle: on-demand open + battery-aware idle-detach + refcount, per session key. */
  private readonly manager: SessionManager;
  /** Error objects already forwarded while a station startup awaits the same session signal. */
  private readonly reportedErrors = new WeakSet<Error>();
  /** One shared live source per `${parentSn}:${channel}` — collapses N live() calls to one pull. */
  private readonly liveSources = new Map<string, SharedLiveSource>();
  /** The options each live source was built from, so a later caller's conflicting ones can be reported. */
  private readonly liveSourceOpts = new Map<string, SharedLiveOpts>();
  /** Per live source key, the camera's own media connection it streams on ({@link P2PRouterDeps.sessionPerCamera}). */
  private readonly liveMedia = new Map<string, string>();
  /** The media connection a live source is waiting on, so a second request for the camera joins it. */
  private readonly mediaBuilds = new Map<string, Promise<SharedLiveSource>>();
  /**
   * The open talkback per `${parentSn}:${channel}`, if any. The device plays one audio stream at a
   * time and the session carries one audio sequence, so this path is exclusive where a live pull is
   * shared — see {@link P2PCommandRouter.openTalkback}.
   */
  private readonly talkbacks = new Map<string, Talkback>();
  /** `${user_id}_${cipher_id}` → the private key its lookup kept, shared across (re)opens as the app's `ConnectKeyFactory` shares it. */
  private readonly cipherKeyCache = new Map<string, string>();
  /** The recording download in flight per station; a station serves one at a time. */
  private readonly recordingDownloads = new Map<string, Promise<unknown>>();

  /**
   * The next keyed-payload `seq_num`, one counter for every lock as the app's `ESLP2pHelper`: seeded at
   * `random() * 1000`, taken then moved on by each command, and set to `seq_num + 1` by every `P2P_SEQ` (1916)
   * notify ({@link keyedPayloadSeqMark}).
   */
  private keyedSeq = Math.trunc(Math.random() * 1000);

  /** Per parent serial, the app's ping task: pinging until `until` (`Infinity` during live), begun at `since`. */
  private readonly pings = new Map<string, { until: number; since: number; timer: ReturnType<typeof setInterval> }>();
  /** The answered command in flight per {@link serializeAnswered} key, which the next one for that key waits on. */
  private readonly answeredQueue = new Map<string, Promise<void>>();

  constructor(private readonly deps: P2PRouterDeps) {
    this.manager = new SessionManager({
      poweredFor: deps.poweredFor,
      logger: deps.logger,
      onAutoClose: (key) => (isMediaKey(key) ? this.tearDownMedia(key) : this.tearDownStation(key)),
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
   * `no P2P session`. A standalone video lock is claimed here but takes its `ff09` frames over secure MQTT.
   */
  static claimsDevice(dev: EufyDevice): boolean {
    return typeof dev.p2pDid === "string" && dev.p2pDid.length > 0;
  }

  /**
   * The open P2P sessions by station serial (a snapshot; mutate via the lifecycle methods, not this map).
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
    this.manager.hold(parentSn, ms);
    try {
      await this.openSession(parentSn);
    } catch (e) {
      if (e instanceof SessionSupersededError) return;
      this.deps.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Close every P2P session and drop them. */
  async closeAll(): Promise<void> {
    for (const { timer } of this.pings.values()) clearInterval(timer);
    this.pings.clear();
    const talking = [...this.talkbacks.values()];
    this.talkbacks.clear();
    await Promise.all(talking.map((t) => t.stop().catch(() => {})));
    for (const src of this.liveSources.values()) src.dispose();
    this.liveSources.clear();
    this.liveSourceOpts.clear();
    this.liveMedia.clear();
    await this.manager.closeAll();
  }

  /** This serial's loaded record, or `undefined` — the one place the cached list is searched by serial. */
  private recordFor(sn: string): EufyDevice | undefined {
    return this.deps.listDevices().find((d) => d.sn === sn);
  }

  /**
   * The parent-station serial a device serial's session lives under — the single source of truth for
   * session keying, used by the facade (e.g. to pre-warm the right station for an event). Returns the
   * serial itself if the device isn't loaded (a standalone device is its own station).
   */
  stationKeyOf(sn: string): string {
    const dev = this.recordFor(sn);
    return dev ? stationOf(dev) : sn;
  }

  /**
   * Reset only a standalone device's session; an attached device must not close its shared HomeBase.
   */
  async resetStandaloneSession(sn: string): Promise<void> {
    const device = this.recordFor(sn);
    if (!device) return;
    const station = stationOf(device);
    if (station !== sn) return;
    await this.manager.resetWhenUnused(station);
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
   * Wait for `session` to connect, for up to the session's own connect deadline, and throw
   * {@link StationUnreachableError} when it does not.
   *
   * `connect()` resolves once the lookups are under way, not once a path answers, so a session handed back by
   * {@link openSession} may still be connecting: a relay connect lands about 25 s in. A level-2 grace counted
   * before this would be spent on the connect rather than on the key.
   */
  private async awaitConnected(session: P2PSession, parentSn: string, signal?: AbortSignal): Promise<void> {
    const t0 = Date.now();
    let waitedMs = 0;
    if (!session.isConnected) {
      this.traceOnStation(session, { phase: "session-connect-wait", waitMs: P2P_STATION_WAITS.connect });
      while (!session.isConnected && Date.now() - t0 < P2P_STATION_WAITS.connect) {
        signal?.throwIfAborted();
        await sleep(200);
      }
      waitedMs = Date.now() - t0;
      this.traceOnStation(
        session,
        session.isConnected ? { phase: "session-connected", waitedMs } : { phase: "session-unreachable", waitedMs },
      );
    }
    signal?.throwIfAborted();
    if (!session.isConnected) throw new StationUnreachableError(parentSn, waitedMs);
  }

  /**
   * Open (or reuse) `parentSn`'s session: one per station, as the app's slot table holds one per serial; `key` names a
   * camera's own media connection to it instead ({@link P2PRouterDeps.sessionPerCamera}).
   */
  private async openSession(parentSn: string, key = parentSn): Promise<P2PSession> {
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
          dskKey = (await this.deps.mega.getDskKeys([stationDev]))[parentSn]?.dskKey;
        } catch (e) {
          this.deps.onError(e instanceof Error ? e : new Error(String(e)));
        }
        const localAddress = this.deps.localAddresses?.[parentSn] ?? freshestLanIp(raw);
        const session = this.makeSession(parentSn, did, raw, dskKey, localAddress, key);
        register(session);
        await session.connect();
        return session;
      },
      parentSn,
    );
  }

  /** A camera's own media connection to `parentSn`, connected, or the reason it is not. */
  private async openMediaSession(parentSn: string, channel: number, signal?: AbortSignal): Promise<P2PSession> {
    const key = mediaKeyOf(parentSn, channel);
    const session = await this.openSession(parentSn, key);
    try {
      await this.awaitConnected(session, parentSn, signal);
      return session;
    } catch (error) {
      if (this.manager.get(key) === session) void this.manager.close(key).catch((e) => this.reportError(e));
      throw error;
    }
  }

  /**
   * Build + wire a {@link P2PSession} for a station (NOT yet connected — the caller awaits `connect()`).
   *
   * `resolveCipherKey` auto-negotiates the level-2 session key from `CMD_GATEWAYINFO` by resolving the
   * cipher's private keys via cloud `get_ciphers`, so signCode 2/8 frames decrypt live; results are
   * cached on the router instance so a lazy re-open (after idle-detach) reuses the lookup. Only a
   * SUCCESSFUL lookup is cached — caching `undefined` after a transient failure would permanently
   * disable level-2 for the session's life.
   *
   * A `CMD_GET_DEVICE_PING` (1152) notify is answered as the app's `P2PReceiver` does (`ZmediaUtil.sendDevicePing`):
   * 1152 to the station as `setCommandWithInt(0, 0)` on channel 0, the group-A body whose string is read off the
   * int, so 136 zero bytes, sent through the session's sender like any command.
   *
   * The `close` handler drops the session from the {@link SessionManager} and disposes any shared live
   * source riding this station (consumers get `stop`; a later attach rebuilds via the factory).
   */
  private makeSession(
    stationSn: string,
    did: string,
    raw: Record<string, any>,
    dskKey: string | undefined,
    localAddress: string | undefined,
    key = stationSn,
  ): P2PSession {
    const adminUserId = memberAccountId(raw, this.deps.mega.auth?.userId);
    const session: P2PSession = new P2PSession({
      stationSn,
      p2pDid: did,
      cloudAddresses: stationCloudAddresses(raw),
      localAddress,
      dskKey,
      noBroadcast: this.deps.noBroadcast,
      resolveCipherKey: (cipherId, version) => this.cipherKeyFor(cipherId, adminUserId, stationSn, version),
      userId: adminUserId,
      logger: this.deps.logger ?? noopLogger,
    });
    session.on("error", (e: Error) => this.reportError(e));
    session.on("data", (frame: P2PFrame) => {
      if (frame.commandId === CommandType.CMD_GET_DEVICE_PING && frame.dataType === P2PDataType.CONTROL) {
        session.sendBytes(Buffer.alloc(136), 0, CommandType.CMD_GET_DEVICE_PING);
      }
      // A camera's own media connection carries its media alone; the station's session reports the station.
      if (key === stationSn) this.onStationFrame(stationSn, frame);
    });
    if (key !== stationSn) {
      session.on("close", () => {
        if (this.manager.get(key) === session) this.tearDownMedia(key);
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
    session.on("peerAnswer", (atMs: number) => {
      if (this.manager.get(stationSn) === session) this.deps.onPeerAnswer?.(stationSn, atMs);
    });
    return session;
  }

  /** A frame from a station's session: a `P2P_SEQ` notify moves {@link keyedSeq} on, then the client decodes it. */
  private onStationFrame(stationSn: string, f: P2PFrame): void {
    const mark = keyedPayloadSeqMark(f.json);
    if (mark !== undefined) this.keyedSeq = mark + 1;
    this.deps.onFrame(stationSn, f);
  }

  /**
   * The private key of `cipherId` for a gateway info of `version`, as the app's `ConnectKeyFactory` gets it:
   * from the cache under `${userId}_${cipherId}`, else from `data[0]` of a `get_ciphers` call, asked at most twice
   * while no key comes back. Version 8 asks with `station_sn` and keeps `ecc_private_key`; any other version asks
   * with `sn` and keeps `private_key`. Only a non-empty key is cached.
   */
  private async cipherKeyFor(
    cipherId: number,
    userId: string,
    stationSn: string,
    version: number,
  ): Promise<string | undefined> {
    const cacheKey = `${userId}_${cipherId}`;
    if (this.cipherKeyCache.has(cacheKey)) return this.cipherKeyCache.get(cacheKey);
    const ecc = version === 8;
    for (let pass = 0; pass < 2; pass++) {
      try {
        const [cipher] = await this.deps.mega.getCiphers([cipherId], userId, stationSn, ecc ? "station_sn" : "sn");
        const key = ecc ? cipher?.ecc_private_key : cipher?.private_key;
        if (key) {
          this.cipherKeyCache.set(cacheKey, key);
          return key;
        }
      } catch (e) {
        this.deps.onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return undefined;
  }

  /**
   * The app's params read of a device (`getParams`): {@link GET_PARAMS_BODY} as 1103, opening the station's session
   * where none is up, on channel 0 where the device's param 6271 is "1", else on 255 for a station
   * ({@link isStationSerial}) and on its own channel for any other device. The answer
   * arrives as the station's camera-info notify. A read that cannot go is only logged, as the app does.
   */
  async getParams(sn: string): Promise<void> {
    this.pingFor(sn);
    try {
      const dev = await this.deviceFor(sn);
      await this.ensureStation(stationOf(dev));
      const { session, channel } = await this.resolveSession(sn);
      const chl = dev.params?.[6271] === "1" ? 0 : channel;
      session.sendBytes(GET_PARAMS_BODY, chl, P2P_ENVELOPE.GET_CAMERA_INFO);
    } catch (e) {
      (this.deps.logger ?? noopLogger).debug(`[p2p] ${sn} params read not sent`, e);
    }
  }

  /**
   * Open (or reuse) a station's P2P session and await its completed handshake. An optional abort only
   * stops this wait; session ownership remains with {@link SessionManager} and its normal teardown.
   */
  async ensureStation(parentSn: string, signal?: AbortSignal): Promise<void> {
    try {
      const session = await this.openSession(parentSn);
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
    await this.openSession(stationOf(dev));
    return dev;
  }

  /**
   * Route a transport-neutral {@link Command} to its wire transport — the command-sink
   * implementation. Capability modules emit intent; this is the one place that knows P2P. Answers `true`
   * when the device answered the write with success ({@link sendAnswered}, the keyed lock actuation), `false`
   * when it was sent unread.
   */
  /**
   * Open or move the ping windows of `sn`'s parent, as the app's pingers do on a request, a live start (no end) and a
   * live stop (the window from now, ending an unbounded one). The esiotkit pinger skips a parent that is a station,
   * and each tick while a command to the parent awaits its answer; the legacy pinger ({@link LEGACY_PING_MS}) takes
   * its own window from every one of these calls.
   */
  private pingFor(sn: string, live?: "live" | "stop"): void {
    const dev = this.recordFor(sn);
    const parentSn = dev ? stationOf(dev) : sn;
    const legacyMs = LEGACY_PING_MS.find(([prefix]) => parentSn.startsWith(prefix))?.[1];
    if (legacyMs) this.pingWindow(`${parentSn}#legacy`, parentSn, legacyMs, true, PING_INTERVAL_MS);
    if (isStationSerial(parentSn)) return;
    const thing = (identifier: string, unit: number, fallback: number) => {
      const value = Number(this.deps.thingDefault?.(parentSn, identifier));
      return value > 0 ? value * unit : fallback;
    };
    const windowMs = live === "live" ? Infinity : thing("p2p_ping_timeout", 1000, PING_WINDOW_MS);
    this.pingWindow(parentSn, parentSn, windowMs, live === "stop", thing("p2p_ping_interval", 1, PING_INTERVAL_MS));
  }

  /** One pinger's task under `key`: open it, or move its window as {@link pingFor} states. */
  private pingWindow(key: string, parentSn: string, forMs: number, stop: boolean, intervalMs: number): void {
    const legacy = key !== parentSn;
    const now = Date.now();
    const held = this.pings.get(key);
    if (held) {
      held.until = forMs === Infinity || stop ? now + forMs : held.until === Infinity ? Infinity : now + forMs;
      return;
    }
    const task = {
      until: now + forMs,
      since: now,
      timer: setInterval(() => {
        const at = Date.now();
        const ceiling = Math.max(PING_TASK_MAX_MS, task.until - task.since);
        if (at > task.until || (!legacy && task.until !== Infinity && at - task.since > ceiling)) {
          clearInterval(task.timer);
          this.pings.delete(key);
          return;
        }
        const session = this.manager.get(parentSn);
        if (!session?.isConnected || (!legacy && this.answeredQueue.has(parentSn))) return;
        session.sendPing();
      }, intervalMs),
    };
    task.timer.unref?.();
    this.pings.set(key, task);
  }

  async dispatchCommand(sn: string, cmd: Command): Promise<boolean> {
    this.pingFor(sn);
    switch (cmd.kind) {
      // ── Intents — the transport picks the encryption level (see resolveScalarParam / setJson). ──
      case "set-param":
        return (await this.resolveScalarParam(sn, cmd.param, cmd.value, cmd.form === "int-pair")) === true;
      case "set-json":
        return (
          (await this.routeControl(sn, P2P_ENVELOPE.CONTROL_PAYLOAD, { commandType: cmd.param, data: cmd.data })) ===
          true
        );
      case "set-json-raw":
        await this.sendJsonRaw(sn, cmd.cmd, cmd.data, cmd.channel);
        return false;
      case "set-payload":
        return (
          (await this.sendSetPayloadEnvelope(
            sn,
            cmd.cmd,
            cmd.lock ? { ...(await this.lockParams(sn, cmd.lock)), ...cmd.payload } : cmd.payload,
            cmd.channel,
            cmd.mValue3,
            undefined,
            true,
            cmd.unzip,
            cmd.counter,
          )) === true
        );
      case "p2p-station-scalar":
        await this.sendStationScalar(sn, cmd.cmd, cmd.value, cmd.channel);
        return false;
      case "p2p-int-string":
        await this.sendIntString(sn, cmd.cmd, cmd.value, cmd.valueSub, cmd.channel, cmd.form);
        return false;
      case "p2p-string":
        await this.sendNativeBody(sn, cmd.cmd, 255, (accountId) => buildStringBody(cmd.channel, cmd.value, accountId));
        return false;
      case "ff09-actuate":
        await this.sendFf09Actuate(sn, cmd);
        return false;
      case "keyed-payload-actuate":
        await this.sendKeyedPayloadActuate(sn, cmd);
        return true;
      case "doorlock-pass-through-actuate":
        await this.sendDoorlockPassThrough(sn, cmd);
        return false;
      case "ff09-autolock":
        await this.sendFf09Autolock(sn, cmd);
        return false;
      case "ff09-setting-toggle":
        await this.sendFf09SettingToggle(sn, cmd);
        return false;
      case "aiot-dp":
        throw new Error(`aiot-dp command (DP ${cmd.dp}) not routable over P2P: AIoT MQTT devices use the MQTT router`);
      case "cloud-request":
        throw new Error(`cloud-request ${cmd.path} is a cloud write and must not reach the P2P router (routing bug)`);
      case "mqtt-dp":
      case "mqtt-json":
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
   * Restart the station that owns `sn`'s P2P session. `RESTART_HUB` (1034) is a station-scalar on the
   * broadcast channel 255 whose body is `[u32 value][account_id padded]`, value `0`, sent as a level-2 frame
   * sealed by the session, sent once, resolving once sent ({@link sendAnswered}).
   */
  async rebootStation(sn: string): Promise<void> {
    return this.sendStationScalar(sn, P2P_ENVELOPE.RESTART_HUB, 0, 255);
  }

  /**
   * A {@link MediaProvider} bound to one serial — resolves the session then calls `p2p/media`.
   *
   * Every live egress here is a consumer of the SAME shared pull, so N `live()` calls collapse to one
   * PPCS session and a live snapshot against a warm shared source costs no extra pull at all; a
   * cold source warms one and waits for a clean keyframe. Each shared egress passes its complete options
   * through because any of them may create the source, whose power and retention hints are fixed for
   * everyone who joins later. The bounded {@link MediaProvider.record} clip is the exception: it opens its
   * own pull and receives its session topology directly.
   */
  mediaProviderFor(sn: string): MediaProvider {
    const station = this.recordingStationFor(sn);
    const recordings = station
      ? { downloadRecording: (opts: RecordingDownloadOpts) => this.downloadRecording(sn, station, opts) }
      : {};
    return {
      ...recordings,
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
        const source = await this.sharedLiveSourceFor(sn, opts as SharedLiveOpts);
        return attachUnlessAborted(source, (opts as SharedLiveOpts | undefined)?.signal);
      },
      openReadable: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, opts ?? {});
        return openReadableFromConsumer(attachUnlessAborted(source, opts?.signal), opts);
      },
      recordFragments: (opts) => this.recordFragments(sn, opts),
      talkback: (opts) => this.openTalkback(sn, opts),
      p2pQuery: (subCmd, opts) => this.p2pQuery(sn, subCmd, opts),
      p2pControlQuery: (param, data, opts) => this.p2pControlQuery(sn, param, data, opts),
      record: async (seconds, opts) => {
        const { session, parentSn, channel, accountId, homeBaseAttached } = await this.resolveSession(sn);
        return recordClip(session, seconds, {
          frames: this.liveFramesOf(sn, parentSn),
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
   * The {@link RecordingStation} of the station `sn` is attached to, when `sn` is a camera attached to a
   * station with an entry in {@link RECORDING_STATIONS}. A standalone device, or a camera on any other
   * station, answers `undefined`.
   */
  private recordingStationFor(sn: string): RecordingStation | undefined {
    const dev = this.recordFor(sn);
    if (!dev) return undefined;
    const parentSn = stationOf(dev);
    if (parentSn === sn) return undefined;
    return RECORDING_STATIONS.get(this.recordFor(parentSn)?.model ?? "");
  }

  /**
   * Download one recording `station` holds for the attached camera `sn`, then decode it
   * ({@link decodeRecording}). `station` is the entry {@link mediaProviderFor} bound. Downloads queue per
   * station: the station streams one recording at a time on the camera's channel, so a download starts only
   * once the previous one has drained ({@link RecordingTransfer.drained}), even when that one's caller already
   * has its answer. An abort while waiting rejects without sending anything; an abort mid-transfer rejects at
   * once and the station's turn is held until the transfer drains.
   */
  private async downloadRecording(
    sn: string,
    station: RecordingStation,
    opts: RecordingDownloadOpts,
  ): Promise<RecordingDownload> {
    opts.signal?.throwIfAborted();
    const parentSn = this.stationKeyOf(sn);
    const previous = this.recordingDownloads.get(parentSn) ?? Promise.resolve();
    const started = this.waitTurn(previous, opts.signal).then(() => this.startRecordingDownload(sn, station, opts));
    const turn: Promise<unknown> = Promise.allSettled([previous, started.then((t) => t.drained)]).then(() => {
      if (this.recordingDownloads.get(parentSn) === turn) this.recordingDownloads.delete(parentSn);
    });
    this.recordingDownloads.set(parentSn, turn);
    return started.then((t) => t.recording);
  }

  /** Resolve once `previous` settles, or reject as soon as `signal` aborts. */
  private waitTurn(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    return abortable(
      previous.then(
        () => undefined,
        () => undefined,
      ),
      signal,
    );
  }

  /**
   * Start one recording download, once the station's previous download has drained: the decoded recording,
   * and when the station is done sending it. The path is `station.path(channel, opts.recording)`, and a name
   * it refuses rejects `invalid-recording` before anything is sent. On a sealed station the cipher's ECC key
   * is looked up, and its absence rejects `key-unavailable` before anything is sent. A station in the clear
   * reads no cipher, and `opts.cipherId` is not read.
   */
  private async startRecordingDownload(
    sn: string,
    station: RecordingStation,
    opts: RecordingDownloadOpts,
  ): Promise<{ recording: Promise<RecordingDownload>; drained: Promise<void> }> {
    const { session, parentSn, channel, accountId } = await this.resolveSession(sn, { signal: opts.signal });
    const path = station.path(channel, opts.recording);
    if (!path) throw new RecordingDownloadError("invalid-recording", `no recording named ${opts.recording}`);
    const eccKey = station.sealed ? await this.cipherKeyFor(opts.cipherId, accountId, parentSn, 8) : undefined;
    if (station.sealed && !eccKey) {
      throw new RecordingDownloadError("key-unavailable", `cipher ${opts.cipherId} could not be obtained`);
    }
    const transfer = receiveRecording(session, {
      path,
      accountId,
      channel,
      finishChannel: station.finishChannel,
      missingCode: station.missingCode,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return {
      recording: transfer.frames.then((frames) => decodeRecording(frames, station, eccKey)),
      drained: transfer.drained,
    };
  }

  /**
   * Open a {@link Talkback} on a device's camera channel.
   *
   * **The camera only plays host audio while its media session is open**: the identical start + audio
   * frames produce silence with no media session and audible playback with one. So this attaches a consumer to the shared live source and holds it for the
   * talkback's lifetime, releasing it on stop. The source is shared and refcounted, so an already-open
   * stream costs nothing extra and a talkback on an otherwise idle camera opens the session it needs
   * instead of playing into silence.
   *
   * **On a model in {@link ELD_TALKBACK_MODELS}, the speaker plays the codec the camera sends.** So the first
   * audio frame of the media session this talkback holds decides its codec ({@link speakerCodec}), within
   * {@link TALKBACK_CODEC_WAIT_MS} of the session's first frame, and the claim is re-checked after that wait as
   * after the warm-up. Every other model opens `aac-lc` at once.
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
    const { session, parentSn, channel } = await this.resolveSession(sn);
    const { talkStart, talkStop } = this.liveFramesOf(sn, parentSn);
    if (!talkStart || !talkStop) throw new Error(`talkback: ${sn} has no talkback in its product's bundle`);
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
      start: talkStart,
      stop: talkStop,
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
      const codec = ELD_TALKBACK_MODELS.has(this.recordFor(sn)?.model ?? "")
        ? await speakerCodec(consumer, talk, TALKBACK_CODEC_WAIT_MS)
        : "aac-lc";
      if (this.talkbacks.get(key) !== talk) {
        throw new Error(`talkback: ${sn} was closed while its speaker codec was being read`);
      }
      return talk.start(codec);
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
   * recover. Waits for no key: the start goes sealed by whatever the session holds, as the app's does. Wires
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
   * camera at a time, a pull still lingering for a camera nobody is watching keeps the station on that camera,
   * so opening a new channel releases those first — see
   * {@link releaseLingeringSiblings}. A pull with consumers is never touched. The release runs before the
   * reuse branch, so a reuse frees the station as a cold start does.
   */
  async sharedLiveSourceFor(sn: string, opts: SharedLiveOpts = {}): Promise<SharedLiveSource> {
    const { session, parentSn, channel, accountId, homeBaseAttached } = await this.resolveSession(sn, {
      signal: opts.signal,
    });
    const frames = this.liveFramesOf(sn, parentSn);
    const key = `${parentSn}:${channel}`;
    let source = this.liveSources.get(key);
    if (source?.state === "stopped") {
      this.dropLiveSource(key);
      source = undefined;
    }
    if (source) {
      this.warnIgnoredLiveOpts(key, opts);
      return source;
    }
    const build = { sn, key, frames, channel, accountId, homeBaseAttached, opts };
    if (!(this.deps.sessionPerCamera && homeBaseAttached)) {
      this.releaseLingeringSiblings(parentSn, channel);
      return this.buildLiveSource(build, session, parentSn);
    }
    let inflight = this.mediaBuilds.get(key);
    if (!inflight) {
      inflight = this.openMediaSession(parentSn, channel, opts.signal)
        .then((media) => this.buildLiveSource(build, media, mediaKeyOf(parentSn, channel)))
        .finally(() => this.mediaBuilds.delete(key));
      this.mediaBuilds.set(key, inflight);
    }
    return await inflight;
  }

  /** The shared source for one camera on `session`, filed as `build.key`; `sessionKey` is held while it streams. */
  private buildLiveSource(
    build: {
      sn: string;
      key: string;
      frames: LiveFrames;
      channel: number;
      accountId: string;
      homeBaseAttached: boolean;
      opts: SharedLiveOpts;
    },
    session: P2PSession,
    sessionKey: string,
  ): SharedLiveSource {
    const { sn, key, frames, channel, accountId, homeBaseAttached, opts } = build;
    const logger = this.deps.logger ?? noopLogger;
    const source = new SharedLiveSource({
      makeStream: () =>
        new LiveStream(session, {
          frames,
          channel,
          accountId,
          homeBaseAttached,
          eccPrivateKey: opts.eccPrivateKey,
          entryType: opts.entryType,
          logger,
        }),
      lingerMs: opts.lingerMs,
      preBufferSeconds: opts.preBufferSeconds,
      powered: opts.powered,
      batteryBudgetMs: opts.batteryBudgetMs,
      budgetGraceMs: opts.budgetGraceMs,
      logger,
      label: key,
      onActive: () => {
        this.pingFor(sn, "live");
        this.manager.retain(sessionKey);
      },
      onIdle: () => {
        this.pingFor(sn, "stop");
        this.manager.release(sessionKey);
      },
      onStartFailed: () => this.dropLiveSource(key),
    });
    this.liveSources.set(key, source);
    this.liveSourceOpts.set(key, opts);
    if (isMediaKey(sessionKey)) this.liveMedia.set(key, sessionKey);
    return source;
  }

  /**
   * Tear down any pull on this station that is lingering for ANOTHER camera, before starting this one.
   *
   * A lingering pull has no consumers but is still held open. Two channels open at once over ONE session,
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
   * A snapshot tile is nobody looking. Opening a live view in the Home app takes that cell fullscreen, so the
   * pulls refreshing the other cells are off screen, yet each goes on re-issuing its own media start every
   * retry tick, and a live request landing among them receives nothing beyond the retained keyframe until its
   * deadline fires. So a live
   * request also takes the channel from a sibling held only by snapshots, while a snapshot request takes
   * nothing from anyone: a home page must not fight itself, and a viewer outranks a thumbnail in one
   * direction only.
   */
  private releaseLingeringSiblings(parentSn: string, channel: number): void {
    const own = `${parentSn}:${channel}`;
    for (const [key, source] of [...this.liveSources]) {
      if (!key.startsWith(`${parentSn}:`) || key === own || source.consumerCount > 0) continue;
      if (source.state === "idle") continue;
      (this.deps.logger ?? noopLogger).debug(
        `[live ${key}] releasing a pull nothing is attached to so ${own} can start — ` +
          `one session serves one camera at a time`,
      );
      this.dropLiveSource(key);
    }
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
   *    cannot satisfy both. A still on a sibling halves a live view's frame rate for as long as it takes, and its
   *    own capture slows because it contends.
   *
   * A still with no live sibling re-asserts, so a tile refreshing on a quiet station is
   * unaffected.
   */

  /**
   * Dispose one cached live source and forget it, so the next acquisition builds a fresh one. The station's
   * session stays: it carries the station's control traffic and outlives any one camera.
   */
  private dropLiveSource(key: string): void {
    const source = this.liveSources.get(key);
    if (!source) return;
    source.dispose();
    this.liveSources.delete(key);
    this.liveSourceOpts.delete(key);
    const media = this.liveMedia.get(key);
    if (media === undefined) return;
    this.liveMedia.delete(key);
    void this.manager.close(media).catch((e) => this.reportError(e instanceof Error ? e : new Error(String(e))));
  }

  /** A camera's own media connection closed: drop the source it carried (the next pull opens a new one). */
  private tearDownMedia(mediaKey: string): void {
    this.manager.remove(mediaKey);
    for (const [key, media] of this.liveMedia)
      if (media === mediaKey) {
        this.liveMedia.delete(key);
        this.dropLiveSource(key);
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
   * unasked. A close a CALLER made is deliberately not routed here — {@link closeAll} and
   * {@link resolveSession} dispose their own sources first.
   */
  private tearDownStation(stationSn: string): void {
    this.manager.remove(stationSn);
    for (const key of [...this.liveSources.keys()]) {
      if (key.startsWith(`${stationSn}:`) && !this.liveMedia.has(key)) this.dropLiveSource(key);
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
   *
   */
  recordFragments(
    sn: string,
    opts: { fragmentSeconds?: number; eccPrivateKey?: Buffer } & SharedSourceHints = {},
  ): FragmentRecording {
    const source = this.sharedLiveSourceFor(sn, opts);
    return new FragmentRecording(source, opts);
  }

  /** The frames the app starts and stops `sn`'s live view and talkback with; throws for a product with none. */
  private liveFramesOf(sn: string, parentSn: string): LiveFrames {
    const frames = this.deps.liveFramesFor?.(sn, parentSn);
    if (!frames) throw new Error(`live view: ${sn} has no live view in its product's bundle`);
    return frames;
  }

  /**
   * **Generic P2P request/reply query.** Sends a `SET_PAYLOAD` (1350) wrapper carrying `subCmd` on the
   * device channel, then resolves with the reply frame's `payload` — the `NOTIFY_PAYLOAD` (1351)
   * whose JSON `cmd` echoes `subCmd` — decoded off the session `data` event.
   */
  async p2pQuery(
    sn: string,
    subCmd: number,
    opts: { timeoutMs?: number; payload?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    const { session, channel, accountId } = await this.resolveSession(sn);
    const timeoutMs = opts.timeoutMs ?? 15000;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for p2p query ${subCmd} reply from ${sn}`));
      }, timeoutMs);
      const onData = (f: P2PFrame): void => {
        const j = f.json as { cmd?: number; payload?: unknown } | undefined;
        if (
          f.channel === channel &&
          f.commandId === CommandType.CMD_NOTIFY_PAYLOAD &&
          j?.cmd === subCmd &&
          j.payload &&
          typeof j.payload === "object"
        ) {
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
        const sent = session.sendAcknowledged(() => {
          session.sendSetPayload(subCmd, opts.payload ?? {}, { accountId, channel });
          return true;
        });
        if (!sent) throw new Error("p2p query send failed");
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * **Generic control-payload request/reply query.** Sends a `CONTROL_PAYLOAD` (1700) `{commandType,
   * data}` (sealed by the session, like {@link routeControl}), then resolves with the reply
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
    const { session, channel } = await this.resolveSession(sn);
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
      try {
        session.sendAcknowledged(() => {
          session.sendStringPayloadCommand(
            P2P_ENVELOPE.CONTROL_PAYLOAD,
            JSON.stringify({ commandType: param, data }),
            channel,
          );
          return true;
        });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * A scalar `set-param` write: the app's group-A body `[u32 channel][u32 value][account_id → 128]`, or the bare
   * `[u32 channel][u32 value]` for `pair`, sealed by the session. `answered` settles it on the device's answer
   * ({@link sendAnswered}); without it the write resolves once sent.
   */
  private resolveScalarParam(sn: string, param: number, value: number, pair = false, answered = true) {
    return this.sendDirectBinary(sn, param, value, answered, pair);
  }

  /**
   * Read the camera's LIVE authoritative RTSP URL — host, path, and the credentials it enforces
   * RIGHT NOW — by writing the publish switch `CMD_NAS_SWITCH` (idempotent when already on, and never
   * touching the credentials themselves, so a NAS/NVR consuming the stream elsewhere is undisturbed)
   * plus `CMD_NAS_TEST` to start the livestream, then awaiting the `rtspUrl` event `P2PSession` emits
   * for a matching-channel `CMD_NAS_SWITCH` push. This is the only source of the freshly-generated
   * credentials: the vendor app regenerates them on every publish toggle and the cloud record lags.
   *
   * The provokes are read by that push, not by their answers. Both go through {@link resolveScalarParam} and queue
   * on the device as every command does ({@link sendAnswered}), the test after the switch's answer.
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
      const { session, channel, accountId } = await this.resolveSession(sn, { signal });
      if (!accountId) return undefined;
      // Arm the wait BEFORE provoking, so a push that arrives between the two writes is not lost.
      const url = this.awaitRtspUrl(session, channel, signal);
      // Do not block the read on the provokes: it returns as soon as the push arrives (or the deadline aborts).
      // The publish switch alone does not elicit the push; the livestream test paired with it does.
      for (const cmd of [CommandType.CMD_NAS_SWITCH, CommandType.CMD_NAS_TEST]) {
        void this.resolveScalarParam(sn, cmd, 1, false, false).catch((e) =>
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
   * Resolve a device serial to its P2P session + routing params: the HomeBase/parent session for an
   * attached camera or the device's own, its `device_channel`, and the admin account id. Opens the
   * station's P2P session on demand if needed and waits for it to connect, then holds it warm briefly
   * (a command keepalive, so a burst of commands / a follow-up read reuses it instead of paying a fresh
   * handshake — a no-op for a wired/persistent station).
   *
   * Nothing waits for a key: a send seals with what the session holds once connected ({@link P2PSession}).
   *
   * A session already {@link P2PSession.isClosed} but not yet dropped (it closes itself on the app's ALIVE timeout)
   * is replaced before it is handed over, once per resolution; cached live sources on it are discarded first (see
   * {@link tearDownStation}).
   */
  private async resolveSession(
    sn: string,
    opts: { signal?: AbortSignal } = {},
    /** Whether this resolution has already replaced a silent path — see the check below. */
    rebuilt = false,
  ): Promise<ResolvedSession> {
    const dev = await this.deviceFor(sn);
    const parentSn = stationOf(dev);
    const homeBaseAttached = parentSn !== sn;
    const session =
      this.manager.get(parentSn) ??
      this.manager.get(sn) ??
      (dev.stationSn ? this.manager.get(dev.stationSn) : undefined);
    if (!session) {
      throw new Error(`no P2P session for ${sn} (known: ${this.manager.keys().join(", ") || "none"})`);
    }
    if (session.isClosed && !rebuilt) {
      (this.deps.logger ?? noopLogger).debug(`[p2p] ${parentSn} session closed — rebuilding before use`);
      for (const key of [...this.liveSources.keys()]) {
        if (key.startsWith(`${parentSn}:`) && !this.liveMedia.has(key)) this.dropLiveSource(key);
      }
      await this.manager
        .close(parentSn)
        .catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))));
      return await this.resolveSession(sn, opts, true);
    }
    const address = stationChannels(this.deps.listDevices()).get(sn)!;
    if (!("channel" in address)) {
      this.traceOnStation(session, { phase: "station-channel-unresolved", issue: address.issue });
      throw new DeviceChannelUnresolvedError(sn, parentSn);
    }
    this.manager.bumpCommand(parentSn);
    // The request channel `P2PRequestCreatorKt.p2pRequest` gives: 255 for a station serial.
    const channel = isStationSerial(sn) ? STATION_CHANNEL : address.channel;
    const station = parentSn === sn ? dev : this.recordFor(parentSn);
    const stationAdminId = (station?.raw as any)?.member?.admin_user_id;
    const stationModel = station?.model;
    // `ZmediaUtil` quotes `AccountDelegate.m(mHubSn)`, the station's member read by `AnkerAccountManager.u`.
    const accountId = memberAccountId(station?.raw, this.deps.mega.auth?.userId);

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

    await this.awaitConnected(session, parentSn, opts.signal);
    return { session, parentSn, channel, accountId, homeBaseAttached };
  }

  /**
   * The group-A scalar body ({@link buildDirectBinaryBody} with the resolved device channel, or its first 8 bytes
   * for `pair`) under `outerCmd` on that channel, sealed by the session. The device answers it under `outerCmd` on
   * the same channel, which `answered` settles on.
   */
  private sendDirectBinary(
    sn: string,
    outerCmd: number,
    value: number,
    answered: boolean,
    pair = false,
  ): Promise<boolean | void> {
    return this.sendAnswered(
      sn,
      outerCmd,
      ({ session, channel, accountId }) => {
        const full = buildDirectBinaryBody(value, accountId, channel);
        return session.sendBytes(pair ? full.subarray(0, 8) : full, channel, outerCmd);
      },
      undefined,
      !answered,
    );
  }

  /**
   * **Station-scoped scalar** (`p2p-station-scalar` intent): the 132-byte channel-less body
   * ({@link buildDirectBinaryBody} with no `channel`) on an EXPLICIT channel, sealed by the session. The
   * HomeBase's own controls ride the station broadcast channel 255 (alarm/speaker volume 1235).
   */
  private async sendStationScalar(sn: string, outerCmd: number, value: number, channel: number): Promise<void> {
    await this.sendAnswered(
      sn,
      outerCmd,
      ({ session, accountId }) => session.sendBytes(buildDirectBinaryBody(value, accountId), channel, outerCmd),
      undefined,
      true,
    );
  }

  /**
   * A native body (the string body {@link buildStringBody}, the bare int pair) on header `channel`, sealed by the
   * session and sent as every unread control here is ({@link sendAnswered}). `body` gets the account id.
   */
  private async sendNativeBody(
    sn: string,
    cmd: number,
    channel: number,
    body: (accountId: string) => Buffer,
  ): Promise<void> {
    await this.sendAnswered(
      sn,
      cmd,
      ({ session, accountId }) => session.sendBytes(body(accountId), channel, cmd),
      undefined,
      true,
    );
  }

  private async sendIntString(
    sn: string,
    commandType: number,
    value: number,
    valueSub: number,
    channel: number,
    form?: "int-pair",
  ): Promise<void> {
    if (form === "int-pair") {
      const pair = Buffer.alloc(8);
      pair.writeUInt32LE(valueSub >>> 0, 0);
      pair.writeUInt32LE(value >>> 0, 4);
      return this.sendNativeBody(sn, commandType, channel, () => pair);
    }
    const resolved = await this.resolveSession(sn);
    if (!resolved.accountId) throw new Error(`int-plus-string command ${commandType} for ${sn} requires an account id`);
    await this.sendAnswered(
      sn,
      commandType,
      ({ session, accountId }) => session.sendIntStringCommand(commandType, value, valueSub, accountId, channel),
      resolved,
      true,
    );
  }

  /**
   * **`set-json-raw` intent** — bare JSON, no envelope: outer P2P cmd = `outerCmd` itself, plaintext
   * exactly `{account_id,...data}`, sealed by the session. Reversed from a live
   * capture of the app's own SET_SNOOZE_TIME (1271) frame — see `param-dictionary.ts`'s `1271` entry
   * (`snoozeTime`); the alarm-delay config (1255, `arming.ts`'s `ARMING_CMD.SET_ALL_ACTION`) reuses
   * the same bare-JSON shape.
   */
  private async sendJsonRaw(
    sn: string,
    outerCmd: number,
    data: Record<string, unknown>,
    channel: number,
  ): Promise<void> {
    await this.sendAnswered(
      sn,
      outerCmd,
      ({ session, accountId }) =>
        session.sendStringPayloadCommand(outerCmd, withUser({ account_id: accountId, ...data }, accountId), channel),
      undefined,
      true,
    );
  }

  /**
   * **`set-payload` intent** — a `SET_PAYLOAD` (1350) envelope `{account_id, cmd, mChannel, mValue3, payload}` on
   * the intent's `channel` (resolveSession supplies only the session + account_id), sealed by the session. `resolved`
   * lets a caller that already resolved the session skip a re-resolve. It goes once through {@link sendAnswered},
   * which holds the device's slot until the `SET_PAYLOAD` answer; `answered` settles the call on that answer,
   * otherwise it resolves once sent.
   */
  private sendSetPayloadEnvelope(
    sn: string,
    cmd: number,
    payload: Record<string, unknown> | readonly unknown[],
    channel: number,
    mValue3?: number,
    resolved?: ResolvedSession,
    answered = false,
    unzip = false,
    counter?: "bump" | "current",
  ): Promise<boolean | void> {
    return this.sendAnswered(
      sn,
      P2P_ENVELOPE.SET_PAYLOAD,
      ({ session, accountId }) => session.sendSetPayload(cmd, payload, { accountId, channel, mValue3, unzip, counter }),
      resolved,
      !answered,
    );
  }

  /**
   * **`keyed-payload-actuate` intent** — the classic Wi-Fi lock's actuation: the sealed fields from
   * {@link buildKeyedActuatePayload}, sent as a keyed envelope through {@link P2PSession.sendSetPayload}
   * on the lock's device channel. No session key is waited for — the envelope seals its own per-command
   * key for the device's public key (fetched from the cloud, cached per serial), so it goes as soon as
   * the session is up. The acting name is the intent's account name, the app's `AccountDelegate.i()`; the envelope's
   * account id is the resolved one (`AccountDelegate.m`).
   *
   * It goes once at the next {@link keyedSeq}, as the app's `ESLAnkerP2PService.q` sends it, and
   * {@link awaitKeyedReply} settles it on the replies: a non-zero code, a sequence refusal included, throws and
   * nothing is resent. Commands run one at a time per device: the replies carry no correlation id, so one
   * command's answer must never be read as another's.
   */
  private sendKeyedPayloadActuate(sn: string, cmd: Ff09Identity): Promise<void> {
    return this.serializeAnswered(sn, async () => {
      const devicePublicKey = await this.deps.mega.getDevicePublicKey(sn);
      const { session, channel, accountId } = await this.resolveSession(sn);
      const { key, payload } = buildKeyedActuatePayload(cmd, devicePublicKey, cmd.username, {
        seqNum: this.keyedSeq++,
      });
      const code = await this.awaitKeyedReply(sn, session, channel, cmd.engage, () =>
        session.sendAcknowledged(() => {
          session.sendSetPayload(CommandType.P2P_ON_OFF_LOCK, payload, { accountId, channel, key });
          return true;
        }),
      );
      if (code !== 0) throw new Error(`keyed-payload command rejected by ${sn} with code ${code}`);
    });
  }

  /**
   * Run `work` once every answered command already queued under `key` has settled. An answer carries no
   * correlation id, so commands whose answers could be mistaken for each other share a key.
   */
  private serializeAnswered<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.answeredQueue.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.answeredQueue.set(key, settled);
    void settled.then(() => {
      if (this.answeredQueue.get(key) === settled) this.answeredQueue.delete(key);
    });
    return run;
  }

  /**
   * Send one command and hold the device's slot until its answer, as the vendor app runs one request at a time
   * per device sn (`KmmP2PClient.enqueueRequest`, the slot freed by `releaseAndEnqueueNext` on answer or
   * timeout): the next command for `sn` waits. The command goes once ({@link P2PSession.sendAcknowledged}).
   * Its answer is the {@link P2PSession} `commandResult` under its own command id (the app matches nothing else),
   * read with {@link WRITE_ANSWER}, as `SingleRequestForP2P.doSingleRequest` applies a write only once
   * `KmmP2pResponse.isSuccess`. Code `0` answers `true`; a code from 1 to 20 is resent once within the retry
   * window; any other code, or no answer by the deadline, rejects with a {@link CommandResultError}. A frame
   * under the same command id and channel that carries no code (JSON, or a reply the decrypt could not open)
   * is not the answer.
   *
   * `unread` resolves once the command is sent, the slot still held until the answer or the deadline; its
   * refusal or timeout is logged at debug only.
   *
   * The answer names the channel and command id and nothing else, so an answer arriving after its command
   * timed out settles the next one under the same pair. The device answers a sequence once, however many
   * copies of it arrive, and repeats that answer under its own sequence until acknowledged; {@link P2PSession}
   * drops the repeats.
   *
   * Absent `resolved`, the session is resolved here. A session that closed before an attempt —
   * between its resolution and the send, or across a retry — is resolved afresh, waiting for its connect, and
   * the attempt goes on the new one.
   *
   * @param send sends the command once on the session it is given; `false` is a command that was never sent.
   */
  private sendAnswered(
    sn: string,
    commandId: number,
    send: (r: ResolvedSession) => boolean | void,
    resolved?: ResolvedSession,
    unread = false,
  ): Promise<boolean | void> {
    const { timeoutMs, retries, retryWindowMs, retryCodes } = WRITE_ANSWER;
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => (dispatched = resolve));
    const answered = this.serializeAnswered(sn, async () => {
      const started = Date.now();
      let r = resolved ?? (await this.resolveSession(sn));
      for (let tries = 0; ; tries++) {
        if (r.session.isClosed) r = await this.resolveSession(sn);
        const target = r;
        const code = await this.awaitReply<number>(
          target.session,
          timeoutMs,
          () => new CommandResultError(sn, commandId, undefined, timeoutMs),
          () => {
            if (!target.session.sendAcknowledged(() => send(target) !== false)) {
              throw new Error(`command ${commandId} for ${sn} was never sent (session not connected)`);
            }
            dispatched();
          },
          (done) => ({
            result: (r) => r.commandId === commandId && done(r.code),
          }),
        );
        if (code === 0) return true;
        const retryable = code >= retryCodes[0] && code <= retryCodes[1] && tries < retries;
        if (!retryable || Date.now() - started >= retryWindowMs) {
          throw new CommandResultError(sn, commandId, code, timeoutMs);
        }
      }
    });
    if (!unread) return answered;
    answered.catch((e) => (this.deps.logger ?? noopLogger).debug(`[p2p] ${sn} command ${commandId} unread`, e));
    return Promise.race([answered, sent]).then(() => undefined);
  }

  /**
   * Arm reply listeners on `session`, then `send`, and settle on what the listeners make of the replies.
   * `read` receives `done`, which settles with an outcome, and `expire`, which (re)arms the deadline; the
   * deadline starts at `timeoutMs` and rejects with `timeout()`. A `send` that fails rejects. Every listener
   * is removed on settle, so nothing outlives the command.
   */
  private awaitReply<T>(
    session: P2PSession,
    timeoutMs: number,
    timeout: () => Error,
    send: () => void,
    read: (
      done: (outcome: T) => void,
      expire: (ms: number, onExpiry: () => void) => void,
    ) => { result?: (r: { code: number; channel: number; commandId: number }) => void; data?: (f: P2PFrame) => void },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: () => void): void => {
        if (timer) clearTimeout(timer);
        if (listeners.result) session.off("commandResult", listeners.result);
        if (listeners.data) session.off("data", listeners.data);
        outcome();
      };
      const expire = (ms: number, onExpiry: () => void): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onExpiry, ms);
      };
      const listeners = read((outcome) => settle(() => resolve(outcome)), expire);
      if (listeners.result) session.on("commandResult", listeners.result);
      if (listeners.data) session.on("data", listeners.data);
      expire(timeoutMs, () => settle(() => reject(timeout())));
      try {
        send();
      } catch (e) {
        settle(() => reject(e));
      }
    });
  }

  /**
   * Send one keyed-payload command and read its result from the replies on its channel: the `SET_PAYLOAD` echo
   * (a `commandResult`, an int32), or the `NOTIFY_PAYLOAD` `P2P_QUERY_STATUS_IN_LOCK` (1955) report of the state
   * this command drives to, by `engage` ({@link keyedPayloadReportCode}); a report of the other state is a
   * previous command's and is ignored. No reply within {@link KEYED_REPLY_MS} rejects.
   */
  private awaitKeyedReply(
    sn: string,
    session: P2PSession,
    channel: number,
    engage: boolean,
    send: () => void,
  ): Promise<number> {
    return this.awaitReply(
      session,
      P2PCommandRouter.KEYED_REPLY_MS,
      () => new Error(`keyed-payload command to ${sn} drew no reply`),
      send,
      (done) => ({
        result: (r) => r.channel === channel && done(r.code),
        data: (f) => {
          if (f.channel !== channel || f.commandId !== CommandType.CMD_NOTIFY_PAYLOAD) return;
          const code = keyedPayloadReportCode(f.json, engage);
          if (code !== undefined) done(code);
        },
      }),
    );
  }

  /** The app's overtime for a lock command (`ESLAnkerP2PService.s`, 20 s). */
  private static readonly KEYED_REPLY_MS = 20_000;

  /**
   * **`ff09-actuate` intent** — build the `ff09` AES-128-CBC frame ({@link buildFf09Frame}, shared with the
   * MQTT transport — see `transport/ff09.ts`) and dispatch it in the `1940` TRANSFER_PAYLOAD envelope
   * (`{apiCommand, lock_payload, seq_num, time}`) as a `set-payload` (1350), `mValue3=0`, on the lock's
   * device channel. This is the P2P envelope; the capability module only supplies identity, never wire
   * bytes and never the routing channel — that's re-resolved here from the device record.
   */
  private async sendFf09Actuate(sn: string, cmd: Ff09Identity): Promise<void> {
    const resolved = await this.resolveSession(sn);
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

  /** Per lock, the last `seq_num` a v2 lock setting carried (`SecuritySeqNumManager`); unseen, the clock in seconds. */
  private readonly lockSeq = new Map<string, number>();

  /**
   * The params a v2 lock setting over its station replaces the descriptor's with (`handleV2Payload`): the `ff09`
   * frame of its fields for the lock, sealed with the lock owner's key when the descriptor asks, the next per-lock
   * `seq_num`, the descriptor's `cmd` as `apiCommand`, and the frame's key time.
   */
  private async lockParams(sn: string, lock: NonNullable<Extract<Command, { kind: "set-payload" }>["lock"]>) {
    const { parentSn } = await this.resolveSession(sn);
    // The esiotkit lock path keys with the lock's own `member.admin_user_id` as stated, not `AnkerAccountManager`'s.
    const accountId: string =
      (this.recordFor(sn)?.raw as any)?.member?.admin_user_id ?? this.deps.mega.auth?.userId ?? "";
    if (lock.version === 4) {
      // `createPayloadForZhixingStationBle`: the lock's counter + 1, stored under the station (the lock's never moves).
      const seqNum = (this.lockSeq.get(sn) ?? Math.trunc(Date.now() / 1000)) + 1;
      this.lockSeq.set(parentSn, seqNum);
      return {
        payload: sealStationPayload({
          adminUserId: accountId,
          stationSn: parentSn,
          lockCmd: lock.bleCommand,
          lockPayload: lock.payload,
          seqNum,
        }),
      };
    }
    const frame = buildFf09TlvFrame({
      cmdCode: lock.cmdCode,
      fields: lock.fields,
      adminUserId: accountId,
      deviceSn: sn,
      encrypt: lock.encrypt,
      subVersion: lock.subVersion,
      functionType: lock.functionType,
    });
    const seqNum = (this.lockSeq.get(sn) ?? Math.trunc(Date.now() / 1000)) + 1;
    this.lockSeq.set(sn, seqNum);
    return { lock_payload: frame.lockPayload, seq_num: seqNum, apiCommand: lock.apiCommand, time: frame.time };
  }

  /**
   * **`doorlock-pass-through-actuate` intent** — `CMD_DOORLOCK_DATA_PASS_THROUGH` inside the
   * `CMD_SET_PAYLOAD` envelope, `mValue3=0`, on the lock's channel of the station it is paired to, its
   * `payload` the sealed blob from {@link buildDoorlockPassThrough} keyed to that station and the
   * lock's member, as the app's `ESLStationP2PService.r` does. Sent once: the blob carries its own sequence number,
   * the clock in seconds + 1 as the app sends it. The key's admin id and the TLV's short user id are the lock's
   * member (`ESLStationAesManager.a(AnkerAccountManager.e(lockSn), stationSn)`, read here off the lock's record, and
   * `OnOffRequestPayload.shortUserId`, which the intent carries); only the envelope's account id is the station's (`AccountDelegate.m(stationSn)`). The
   * `short_user_id` is hex, as on the `ff09` path, and anything but four hex digits throws rather than writing the
   * wrong user. The name is the intent's account name, the app's `AccountDelegate.i()`. Sealed by the session like
   * every command.
   */
  private async sendDoorlockPassThrough(sn: string, cmd: Ff09Identity): Promise<void> {
    const resolved = await this.resolveSession(sn);
    const { parentSn, channel } = resolved;
    if (!/^[0-9a-fA-F]{4}$/.test(cmd.shortUserId)) {
      throw new Error(
        `door-lock pass-through: ${sn} has no 4-digit hex short_user_id, got ${JSON.stringify(cmd.shortUserId)}`,
      );
    }
    const blob = buildDoorlockPassThrough({
      engage: cmd.engage,
      adminUserId: memberAccountId(this.recordFor(sn)?.raw, this.deps.mega.auth?.userId),
      shortUserId: Number.parseInt(cmd.shortUserId, 16),
      nickname: cmd.username,
      stationSn: parentSn,
      seqNum: Math.trunc(Date.now() / 1000) + 1,
    });
    (this.deps.logger ?? noopLogger).debug(
      `[p2p] ${parentSn} door-lock pass-through ${cmd.engage ? "lock" : "unlock"} ${sn} ch=${channel}`,
    );
    await this.sendSetPayloadEnvelope(
      sn,
      CommandType.CMD_DOORLOCK_DATA_PASS_THROUGH,
      { payload: blob },
      channel,
      0,
      resolved,
    );
  }

  /**
   * How long {@link sendFf09Autolock} waits for the device's settings **GET** reply before
   * giving up, counted from before the GET is sent.
   */
  private static readonly FF09_SETTINGS_GET_TIMEOUT_MS = 10000;

  /**
   * **`ff09-autolock` intent over P2P** — read-modify-write the T8531's auto-lock setting. The
   * P2P sibling of `MqttCommandRouter.dispatchFf09Autolock`; same GET-then-SET shape, same `ff09`
   * frame/cipher. Differs from the MQTT flow only in the envelope + reply matching:
   *
   * Resolves the session ONCE up front (needed to arm the reply listener before sending) and passes it
   * to both `sendSetPayloadEnvelope` calls (GET + SET) — skips the redundant re-resolve each would
   * otherwise do internally.
   *
   *  1. Build the settings GET frame ({@link buildFf09QueryFrame}) and send it the same way
   *     `sendFf09Actuate` sends a lock/unlock — a `1940` TRANSFER_PAYLOAD `set-payload` (1350) on the
   *     lock's device channel. Arm a `session.on("data", …)` listener BEFORE sending (same
   *     arm-before-send ordering as {@link p2pQuery}), matching the reply by `f.json.cmd ===
   *     CMD_TRANSFER_PAYLOAD` (the device's `/res`-equivalent reply always carries this inner cmd,
   *     same as any other transfer-payload traffic on this channel — so `cmd` alone isn't enough) AND
   *     `f.json.payload.time` equal to the GET's own `time`. **The P2P reply's `time` field is a HEX
   *     STRING** (e.g. `"6A5908BD"`),
   *     identical to the MQTT reply's convention — NOT the decimal the outbound `time` field uses. No
   *     reply within {@link FF09_SETTINGS_GET_TIMEOUT_MS} throws (same rationale as the MQTT side:
   *     guessing A7/A8 would be worse than failing loud).
   *  2+3. Decrypt the reply, preserve the current delay (`a2`) + `A7`/`A8` passthrough values (`a4`/
   *     `a5`), and build the SET frame — the decrypt→read→rebuild shared with the MQTT sibling as
   *     `transport/ff09.ts`'s {@link buildFf09AutolockSetFrame} — then send it as `sendFf09Actuate` does,
   *     resolving once sent ({@link sendAnswered}).
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
    const resolved = await this.resolveSession(sn);

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
   * {@link readFf09HourMinute}'s doc for why these aren't a packed number).
   */
  async getAutoLockState(sn: string, cmd: { adminUserId: string; deviceSn: string }): Promise<AutoLockSnapshot> {
    const resolved = await this.resolveSession(sn);
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
   * fire-and-forget shape as {@link sendFf09Actuate}. See `transport/ff09.ts`'s "Rain Mode" doc section. The routing channel is re-resolved from
   * the device record — the capability never supplies it.
   */
  private async sendFf09SettingToggle(
    sn: string,
    cmd: { adminUserId: string; deviceSn: string; settingId: number; value: boolean },
  ): Promise<void> {
    const resolved = await this.resolveSession(sn);
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
   * Route a control command (`{commandType, data}`) to a device as `outerCmd`, sealed by the session, settled on
   * the device's answer under `outerCmd` ({@link sendAnswered}).
   */
  private routeControl(
    sn: string,
    outerCmd: number,
    inner: { commandType: number; data: unknown },
  ): Promise<boolean | void> {
    return this.sendAnswered(sn, outerCmd, (r) =>
      r.session.sendStringPayloadCommand(outerCmd, withUser(inner, r.accountId), r.channel),
    );
  }
}
