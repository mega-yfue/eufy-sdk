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
  TalkbackHandle,
} from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { assertNever } from "../../core/util.js";
import { P2PSession, type P2PFrame } from "./p2p-session.js";
import { buildDirectBinaryBody, buildDeviceNameBody } from "./write-commands.js";
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
import { SharedLiveSource } from "./shared-live-source.js";
import { SessionManager, PREWARM_MS, type PowerTier, type SessionManagerOpts } from "./session-manager.js";
import { Fmp4Muxer } from "./fmp4.js";
import { openReadableFromConsumer } from "./readable-egress.js";
import { Talkback } from "./talkback.js";
import { FragmentRecording } from "./fragment-recording.js";

/**
 * How many times each idempotent "direct" control command (camera on/off 1035, spotlight
 * brightness 1401 / color-temp 1410 / enable 1403) is repeated over P2P. Sends are fire-and-forget
 * over UDP with no app-level ACK we wait on, so we repeat for loss resilience on lossy RF. The app
 * itself sent 2–6× depending on the command; we standardize on the higher end (idempotent, so extra
 * sends are harmless). Bump if drops are seen on marginal links.
 */
const DIRECT_CMD_SENDS = 5;

/** Options accepted when warming a {@link SharedLiveSource} for a device (all optional). */
export interface SharedLiveOpts {
  eccPrivateKey?: Buffer;
  keepAliveMs?: number;
  lingerMs?: number;
  preBufferSeconds?: number;
  /** Runtime power source (`"battery"` incl solar / `"wired"`) — the model supplies it; bounds the stream. */
  powered?: "wired" | "battery";
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
  sessionIdle?: Pick<SessionManagerOpts, "batteryIdleMs" | "wiredIdleMs" | "commandKeepAliveMs">;
  /** LAN address overrides for direct P2P, keyed by parent-station serial (host or host:port). */
  localAddresses?: Record<string, string>;
}

export class P2PCommandRouter {
  /** Per-station P2P session lifecycle: on-demand open + battery-aware idle-detach + refcount. */
  private readonly manager: SessionManager;
  /** Error objects already forwarded while a station startup awaits the same session signal. */
  private readonly reportedErrors = new WeakSet<Error>();
  /** One shared live source per `${parentSn}:${channel}` — collapses N live() calls to one pull. */
  private readonly liveSources = new Map<string, SharedLiveSource>();
  /** The options each live source was built from, so a later caller's conflicting ones can be reported. */
  private readonly liveSourceOpts = new Map<string, SharedLiveOpts>();
  /**
   * The open talkback per `${parentSn}:${channel}`, if any. The device plays one audio stream at a
   * time and the session carries one audio sequence, so this path is exclusive where a live pull is
   * shared — see {@link P2PCommandRouter.openTalkback}.
   */
  private readonly talkbacks = new Map<string, Talkback>();
  /** cipher_id → ECC private key (one eufylife get_ciphers call per cipher), shared across (re)opens. */
  private readonly cipherKeyCache = new Map<number, string | undefined>();

  constructor(private readonly deps: P2PRouterDeps) {
    this.manager = new SessionManager({ poweredFor: deps.poweredFor, logger: deps.logger, ...deps.sessionIdle });
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
   * Whether this transport stack drives `dev`'s `ff09-*` commands — true when the device has its own
   * usable P2P endpoint (a non-empty `p2p_did`). The command sink asks each stack this to route a
   * transport-neutral command. Keyed on the endpoint, NOT `classifyDevice`'s `realtime` tag: that tag is
   * `"p2p"` for the ENTIRE `eufy_security` category, so it can't tell a P2P lock (T8531, own `p2p_did`)
   * from an MQTT-only lock/garage (T85D0, empty `p2p_did`) — routing the latter to P2P throws
   * `no P2P session`. This is the same fact the pre-router capability used to pick its transport.
   */
  static claimsDevice(dev: EufyDevice): boolean {
    return typeof dev.p2pDid === "string" && dev.p2pDid.length > 0;
  }

  /** Stations with a live P2P session (a snapshot; mutate via the lifecycle methods, not this map). */
  getSessions(): Map<string, P2PSession> {
    return this.manager.liveSessions();
  }

  /**
   * Speculatively open + briefly hold a station's session (e.g. after a doorbell ring) so a
   * tap-to-view / talkback attaches to a warm session. Transport-neutral: the facade maps the semantic
   * event → station and calls this; the router never learns event semantics. A user hold is taken
   * before the open so a slow connect can't idle-close mid-flight, and released `ms` later so the
   * session detaches if nothing attaches. Best-effort — a failed open surfaces via `onError`.
   */
  async prewarm(parentSn: string, ms: number = PREWARM_MS): Promise<void> {
    this.manager.addUser(parentSn);
    try {
      await this.openStation(parentSn);
    } catch (e) {
      this.deps.onError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setTimeout(() => this.manager.releaseUser(parentSn), ms).unref?.();
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
    await this.manager.closeAll();
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
    const dev = this.deps.listDevices().find((d) => d.sn === sn);
    return dev ? this.stationKeyFor(dev) : sn;
  }

  /** Reset only a standalone device's session; an attached device must not close its shared HomeBase. */
  async resetStandaloneSession(sn: string): Promise<void> {
    const device = this.deps.listDevices().find((candidate) => candidate.sn === sn);
    if (!device) return;
    const station = this.stationKeyFor(device);
    if (station === sn) await this.manager.resetWhenUnused(station);
  }

  /**
   * Open (or reuse) the P2P session for a station **on demand**, coalescing concurrent cold opens via
   * the {@link SessionManager}. A command / stream / pre-warm opens only the station it targets; idle
   * battery stations auto-close. The station's own record carries the P2P creds; a per-station DSK key
   * is fetched best-effort (ThroughTek PPCS UDP, LAN broadcast fallback if the key lookup fails). The
   * LAN address for a direct local lookup is a caller-supplied override ({@link P2PRouterDeps.localAddresses})
   * when present, else the freshest private IP in the record ({@link freshestLanIp}) — so P2P works
   * on-LAN even when broadcast is blocked (AP isolation) or the record's `ip_addr` went stale.
   */
  private async openStation(parentSn: string): Promise<P2PSession> {
    return this.manager.acquire(parentSn, async (register) => {
      const devs = this.deps.listDevices();
      const stationDev = devs.find((d) => d.sn === parentSn) ?? devs.find((d) => this.stationKeyFor(d) === parentSn);
      const raw = (stationDev?.raw ?? {}) as Record<string, any>;
      const did = (stationDev?.p2pDid ?? raw.p2p_did) as string | undefined;
      if (!did) throw new Error(`no P2P endpoint (p2p_did) for station ${parentSn}`);
      let dskKey: string | undefined;
      try {
        dskKey = (await this.deps.mega.getDskKeys([parentSn]))[parentSn]?.dskKey;
      } catch (e) {
        this.deps.onError(e instanceof Error ? e : new Error(String(e)));
      }
      const localAddress = this.deps.localAddresses?.[parentSn] ?? freshestLanIp(raw);
      const session = this.makeSession(parentSn, did, raw, dskKey, localAddress);
      register(session);
      await session.connect();
      return session;
    });
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
   */
  private makeSession(
    stationSn: string,
    did: string,
    raw: Record<string, any>,
    dskKey: string | undefined,
    localAddress: string | undefined,
  ): P2PSession {
    const conn = (raw?.p2p_conn ?? raw?.app_conn) as string | undefined;
    const adminUserId = ((raw?.member as any)?.admin_user_id as string) || this.deps.mega.auth?.userId || "";
    const session = new P2PSession({
      stationSn,
      p2pDid: did,
      cloudAddresses: conn ? decodeP2PCloudIPs(conn) : undefined,
      localAddress,
      dskKey,
      resolveCipherKey: async (cipherId: number) => {
        if (this.cipherKeyCache.has(cipherId)) return this.cipherKeyCache.get(cipherId);
        let ecc: string | undefined;
        try {
          const ciphers = await this.deps.mega.getCiphers([cipherId], adminUserId, stationSn);
          ecc = ciphers.find((c) => Number(c.cipher_id) === cipherId)?.ecc_private_key ?? ciphers[0]?.ecc_private_key;
        } catch (e) {
          this.deps.onError(e instanceof Error ? e : new Error(String(e)));
        }
        if (ecc !== undefined) this.cipherKeyCache.set(cipherId, ecc);
        return ecc;
      },
      logger: this.deps.logger ?? noopLogger,
    });
    session.on("connect", () => {
      if (this.manager.get(stationSn) === session) this.deps.onConnect(stationSn);
    });
    session.on("close", () => {
      if (this.manager.get(stationSn) !== session) return;
      this.manager.remove(stationSn);
      for (const [key, src] of this.liveSources) {
        if (key.startsWith(`${stationSn}:`)) {
          src.dispose();
          this.liveSources.delete(key);
          this.liveSourceOpts.delete(key);
        }
      }
      for (const [key, talk] of this.talkbacks) {
        if (key.startsWith(`${stationSn}:`)) {
          this.talkbacks.delete(key);
          void talk.stop().catch(() => {});
        }
      }
      this.deps.onClose(stationSn);
    });
    session.on("error", (e: Error) => this.reportError(e));
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
      const session = await this.openStation(parentSn);
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
    const dev = this.deps.listDevices().find((d) => d.sn === sn);
    if (!dev) throw new Error(`device ${sn} not found`);
    await this.openStation(this.stationKeyFor(dev));
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
   * Rename a device (or station) — a pure-P2P command (the HomeBase propagates the new name to the
   * cloud). Fire-and-forget over level-2 (`SET_DEVICE_NAME` 1217 for a device / `SET_HUB_NAME` 1216
   * for a station, on the station channel 255, body {@link buildDeviceNameBody}). `isStation` comes
   * from the resolved codec.
   */
  async renameDevice(sn: string, name: string, isStation: boolean): Promise<void> {
    const cmd = isStation ? P2P_ENVELOPE.SET_HUB_NAME : P2P_ENVELOPE.SET_DEVICE_NAME;
    await this.replayLevel2Send(sn, `rename ${sn} → "${name}"`, ({ session, channel, accountId }) =>
      session.sendRawLevel2Bytes(buildDeviceNameBody(channel, name, accountId), 255, cmd, 8),
    );
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
   * Send a raw control command (`{commandType, data}`) under an outer wrapper (default `1700`) to a
   * device over P2P. Escape hatch for tooling / reversing new commands before they get a typed
   * helper. Same routing/encryption as a capability write.
   */
  async routeControlRaw(sn: string, outerCmd: number, inner: { commandType: number; data: unknown }): Promise<void> {
    await this.deviceFor(sn);
    await this.routeControl(sn, outerCmd, inner);
  }

  /**
   * A {@link MediaProvider} bound to one serial — resolves the session then calls `p2p/media`.
   *
   * Every egress here is a consumer of the SAME shared pull, so N `live()` calls collapse to one PPCS
   * session and a live snapshot against a warm, keyframe-primed source costs no extra pull at all; a
   * cold source warms one and waits for a clean keyframe. Each therefore passes `powered` through,
   * because any of them may be the call that creates the source, and the source keeps the power hint it
   * was built with for everyone who joins later.
   */
  mediaProviderFor(sn: string): MediaProvider {
    return {
      snapshotLive: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, { powered: opts?.powered });
        return captureSnapshotFromShared(source, {
          ...opts,
          logger: this.deps.logger ?? noopLogger,
          ffmpegLevel: this.deps.ffmpegLogLevel,
          ffmpegPath: this.deps.ffmpegPath,
        });
      },
      live: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, opts as SharedLiveOpts);
        return source.attach();
      },
      openReadable: async (opts) => {
        const source = await this.sharedLiveSourceFor(sn, { powered: opts?.powered });
        return openReadableFromConsumer(source.attach(), opts);
      },
      recordFragments: (opts) => this.recordFragments(sn, opts),
      talkback: (opts) => this.openTalkback(sn, opts?.encoder, opts?.powered),
      p2pQuery: (subCmd, opts) => this.p2pQuery(sn, subCmd, opts),
      p2pControlQuery: (param, data, opts) => this.p2pControlQuery(sn, param, data, opts),
      record: async (seconds, opts) => {
        const { session, channel, accountId } = await this.resolveSession(sn, { waitLevel2: "soft" });
        return recordClip(session, seconds, {
          channel,
          accountId,
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
   * talkback's lifetime, releasing it on stop. A host already streaming pays nothing extra (the
   * source is shared and refcounted); a host that only wants to talk gets the session it needs
   * instead of silence.
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
   */
  private async openTalkback(sn: string, encoder?: AacEncoder, powered?: "wired" | "battery"): Promise<TalkbackHandle> {
    const { session, parentSn, channel, homeBaseAttached } = await this.resolveSession(sn, { waitLevel2: "soft" });
    const logger = this.deps.logger ?? noopLogger;
    const key = `${parentSn}:${channel}`;
    if (this.talkbacks.has(key)) {
      throw new Error(
        `talkback: ${sn} is already talking — the device plays one audio stream at a time; stop the ` +
          `open talkback before starting another`,
      );
    }
    const source = await this.sharedLiveSourceFor(sn, { powered });
    const consumer = source.attach();
    const talk = new Talkback(session, {
      channel,
      homeBaseAttached,
      encoder,
      releaseMedia: () => consumer.stop(),
      logger,
    });
    consumer.on("error", (e: Error) => {
      if (talk.listenerCount("error")) talk.emit("error", e);
      else logger.warn?.(`talkback: media session for ${sn} failed: ${e.message}`);
    });
    consumer.on("budget", (notice) => talk.emit("budget", notice));
    consumer.on("stop", () => {
      void talk.stop().catch((e: unknown) => logger.warn?.(`talkback: stop for ${sn} failed: ${String(e)}`));
    });
    talk.on("stop", () => {
      if (this.talkbacks.get(key) === talk) this.talkbacks.delete(key);
    });
    this.talkbacks.set(key, talk);
    try {
      return talk.start();
    } catch (e) {
      this.talkbacks.delete(key);
      consumer.stop();
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
   * A source that has **stopped** with no consumers left (linger teardown, warm timeout, budget
   * auto-stop, upstream error) is dropped here rather than re-used. Its pull is dead, so nothing is
   * being protected by keeping it — and keeping it meant the options of whichever egress happened to
   * create it first survived for the process lifetime, so a stray `powered` from the day's first
   * snapshot would still be dictating the budget hours later. Dropping it lets the next caller build a
   * fresh source from its own options, which is the difference between fixing the silent-drop defect
   * and merely reporting it.
   */
  async sharedLiveSourceFor(sn: string, opts: SharedLiveOpts = {}): Promise<SharedLiveSource> {
    const { session, parentSn, channel, accountId, homeBaseAttached } = await this.resolveSession(sn, {
      waitLevel2: "soft",
    });
    const key = `${parentSn}:${channel}`;
    let source = this.liveSources.get(key);
    if (source && source.state === "stopped" && source.consumerCount === 0) {
      source.dispose();
      this.liveSources.delete(key);
      this.liveSourceOpts.delete(key);
      source = undefined;
    }
    if (!source) {
      const logger = this.deps.logger ?? noopLogger;
      source = new SharedLiveSource({
        makeStream: () =>
          new LiveStream(session, {
            channel,
            accountId,
            homeBaseAttached,
            eccPrivateKey: opts.eccPrivateKey,
            keepAliveMs: opts.keepAliveMs,
            logger,
          }),
        lingerMs: opts.lingerMs,
        preBufferSeconds: opts.preBufferSeconds,
        powered: opts.powered,
        batteryBudgetMs: opts.batteryBudgetMs,
        budgetGraceMs: opts.budgetGraceMs,
        logger,
        label: key,
        onActive: () => this.manager.addUser(parentSn),
        onIdle: () => this.manager.releaseUser(parentSn),
      });
      this.liveSources.set(key, source);
      this.liveSourceOpts.set(key, opts);
      return source;
    }
    this.warnIgnoredLiveOpts(key, opts);
    return source;
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
   * dependency-free {@link Fmp4Muxer}. The returned recording handle exposes battery-budget notices
   * and detaches its consumer on `stop`, iterator return, or iterator throw. No ffmpeg.
   */
  recordFragments(
    sn: string,
    opts: {
      fragmentSeconds?: number;
      preBufferSeconds?: number;
      eccPrivateKey?: Buffer;
      keepAliveMs?: number;
      powered?: "wired" | "battery";
    } = {},
  ): FragmentRecording {
    const source = this.sharedLiveSourceFor(sn, {
      eccPrivateKey: opts.eccPrivateKey,
      keepAliveMs: opts.keepAliveMs,
      preBufferSeconds: opts.preBufferSeconds,
      powered: opts.powered,
    });
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
    // use; sendByTopology re-reads topology for the send itself.
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
      // HomeBase-attached one. sendByTopology re-reads topology; the reply lands on the same session.
      const json = JSON.stringify({ commandType: param, data });
      this.sendByTopology(sn, {
        l1: ({ session: s, channel: ch }) => {
          s.sendStringPayloadCommand(P2P_ENVELOPE.CONTROL_PAYLOAD, json, ch);
          return Promise.resolve();
        },
        l2: async ({ session: s, channel: ch }) => {
          const t1 = Date.now();
          while (!s.hasLevel2Key && Date.now() - t1 < 25000) await new Promise((r) => setTimeout(r, 200));
          if (!s.hasLevel2Key) throw new Error(`level-2 key not ready for ${sn} — cannot query`);
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
   * `"auto"` lets topology decide (standalone L1 int+string / HomeBase L2 direct-binary),
   * `"int-string"` pins L1, `"direct-binary"` pins L2.
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
    // "auto": topology decides the level (the ONE decision point — see sendByTopology).
    await this.sendByTopology(sn, {
      l1: () => this.sendIntStringCommand(sn, param, value),
      l2: () => this.sendDirectBinary(sn, param, value),
    });
  }

  /**
   * The single point that turns runtime **topology** into an encryption **level**. `homeBaseAttached`
   * is read fresh from the device record, then the level-1 sender runs for a standalone device or the
   * level-2 sender for a HomeBase-attached one. Both the `"auto"` scalar path and the JSON control
   * path route through here, so the L1/L2 rule is defined exactly once. The `l2` sender is responsible
   * for waiting on the level-2 key (a standalone device never negotiates one).
   */
  private async sendByTopology(
    sn: string,
    send: { l1: (r: ResolvedSession) => Promise<void>; l2: (r: ResolvedSession) => Promise<void> },
  ): Promise<void> {
    const resolved = await this.resolveSession(sn, { waitLevel2: false });
    await (resolved.homeBaseAttached ? send.l2(resolved) : send.l1(resolved));
  }

  /**
   * Resolve a device serial to its P2P session + routing params: the HomeBase/parent session for an
   * attached camera or the device's own, its `device_channel`, and the admin account id. Opens the
   * station's P2P session on demand if needed and waits for it to connect, then holds it warm briefly
   * (a command keepalive, so a burst of commands / a follow-up read reuses it instead of paying a fresh
   * handshake — a no-op for a wired/persistent station). `waitLevel2`: `true` = require the level-2 key
   * (throw if not ready); `"soft"` = best-effort short wait, don't throw; `false`/absent = no wait.
   */
  private async resolveSession(sn: string, opts: { waitLevel2?: boolean | "soft" } = {}): Promise<ResolvedSession> {
    const dev = await this.deviceFor(sn);
    const raw = (dev.raw ?? {}) as Record<string, any>;
    const homeBaseAttached = !!raw.parent_sn && raw.parent_sn !== sn;
    const parentSn = homeBaseAttached ? (raw.parent_sn as string) : (dev.stationSn ?? sn);
    const session =
      this.manager.get(parentSn) ??
      this.manager.get(sn) ??
      (dev.stationSn ? this.manager.get(dev.stationSn) : undefined);
    if (!session) {
      throw new Error(`no P2P session for ${sn} (known: ${this.manager.keys().join(", ") || "none"})`);
    }
    this.manager.bumpCommand(parentSn);
    const channel = typeof raw.device_channel === "number" ? (raw.device_channel as number) : 0;
    const accountId = ((raw.member as any)?.admin_user_id as string) ?? this.deps.mega.auth?.userId ?? "";

    const t0 = Date.now();
    while (!session.isConnected && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
    if (!session.isConnected) throw new Error(`P2P session for ${parentSn} did not connect`);
    if (opts.waitLevel2) {
      const soft = opts.waitLevel2 === "soft";
      const budget = soft ? 8000 : 25000;
      const t1 = Date.now();
      while (!session.hasLevel2Key && Date.now() - t1 < budget) await new Promise((r) => setTimeout(r, 200));
      if (!session.hasLevel2Key && !soft) throw new Error(`level-2 key not ready for ${parentSn}`);
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
      await new Promise((r) => setTimeout(r, 200));
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
   * standalone camera never negotiates a level-2 key, so pinning this to level 2 left the envelope
   * unreachable on exactly the devices that serve their own RTSP stream. Verified live: a standalone
   * camera accepts the level-1 form. With no `form` (default) it stays level-2 only, as before.
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
      await this.sendByTopology(sn, {
        l1: ({ session, accountId }) => {
          session.sendSetPayload(cmd, payload, { accountId, channel });
          return Promise.resolve();
        },
        // NB: do NOT forward sendByTopology's resolved session here — it was resolved with
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
      await new Promise((r) => setTimeout(r, 200));
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
    const gap = () => new Promise((r) => setTimeout(r, 150));

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
    // itself lives in sendByTopology; here we only supply the two JSON senders.
    const json = JSON.stringify(inner);
    await this.sendByTopology(sn, {
      l1: ({ session, channel }) => {
        session.sendStringPayloadCommand(outerCmd, json, channel);
        return Promise.resolve();
      },
      l2: async ({ session, channel }) => {
        const t1 = Date.now();
        while (!session.hasLevel2Key && Date.now() - t1 < 25000) await new Promise((r) => setTimeout(r, 200));
        if (!session.hasLevel2Key) throw new Error(`level-2 key not ready for ${sn} — cannot route HomeBase command`);
        session.sendRawLevel2(json, channel, outerCmd);
      },
    });
  }
}
