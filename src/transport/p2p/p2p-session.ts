/**
 * Minimal eufy P2P (ThroughTek PPCS) UDP session for ONE station.
 *
 * Scope: realtime *device state / sensor events* from a HomeBase — not video.
 * The connect handshake (local + cloud lookup → CHECK_CAM hole-punch → CAM_ID)
 * and PING/PONG heartbeat are full, but command *sending* and video/audio
 * streaming are intentionally omitted. Crucially, HomeBase control-channel
 * notifications (sensor open/close, alarm mode, …) are AES-128-ECB encrypted with
 * the *Level-1* key derived from sn + p2p_did alone — so we decrypt them without
 * the gateway cipher negotiation.
 *
 * Reassembly note: control notifications are small and arrive in a single UDP
 * datagram, so this parses one-frame-per-packet (with multiple frames per packet)
 * and does not reassemble frames that span datagrams.
 */
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  type Address,
  type P2PDataFrameHeader,
  MAGIC_WORD,
  P2P_DATA_HEADER_BYTES,
  P2PDataType,
  P2PDataTypeHeader,
  RequestMessageType,
  ResponseMessageType,
  buildAckPayload,
  buildCheckCamPayload,
  buildCommandHeader,
  buildLocalLookupPayload,
  buildLookupWithKeyPayload,
  buildLookupWithKeyPayload2,
  buildRawCommandPayload,
  buildStringCommandPayload,
  buildIntStringCommandPayload,
  buildVoidCommandPayload,
  decryptP2PData,
  encryptP2PData,
  paddingP2PData,
  deriveLevel2KeyFromGatewayInfo,
  frameMessage,
  gatewayInfoCipherId,
  hasHeader,
  p2pCommandEncryptionKey,
  parseDataFrameHeader,
  parseLookupAddr,
  readNullTerminatedString,
} from "./codec.js";
import { commandName, CommandType } from "./commands.js";
import { traceLiveStart, type LiveTrace } from "./live-trace.js";
import { noopLogger, type Logger } from "../../core/logger.js";

const LOCAL_LOOKUP_PORT = 32108;
const HEARTBEAT_MS = 5_000;
/**
 * How long a path may go without answering a heartbeat before it stops being committed to.
 *
 * Three heartbeats. The station answers every PING, so one missed answer is a lost datagram and three is the
 * path being gone.
 */
const PATH_SILENCE_MS = HEARTBEAT_MS * 3;
const LOOKUP_RETRY_MS = 1_000;
/**
 * The receive buffer a session's socket asks the OS for.
 *
 * A station sends a keyframe as one burst: measured on a HomeBase 3, up to 161 video datagrams of 1074 bytes
 * within 10 ms. With the Linux default buffer of 212992 bytes, the kernel dropped part of such bursts before
 * the socket was read, and the frames those datagrams belonged to arrived incomplete. 4 MiB queues many
 * such bursts, so a keyframe survives the event loop being busy elsewhere for a moment.
 */
const RECEIVE_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * How long a station is given to answer a lookup before the connection gives up on it and closes.
 *
 * The whole deadline for reaching a station: the lookups are re-sent every second until one is answered, and
 * a connection that reaches this closes itself, so nothing addressed to that station can succeed afterwards.
 * Published because it bounds every wait on a session connecting — a second number for the same deadline
 * elsewhere would outlive the connection it waits on and charge the difference to every failure.
 */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * The channel a command addresses the station itself on, rather than one of its cameras, and the value a
 * session's channel-taking methods resolve an omitted channel to.
 */
export const STATION_CHANNEL = 255;
/** CMD_GATEWAYINFO — sent once on connect to prompt the station to start reporting. */
const CMD_GATEWAYINFO = 1100;
const CMD_START_REALTIME_MEDIA = 1003;
const CMD_STOP_REALTIME_MEDIA = 1004;
/**
 * Own-session cameras (the P2P session IS the camera, not a HomeBase serving child channels) start
 * live media with a `CMD_CONTROL_PAYLOAD` (1700) wrapping inner `commandType/cmd = 1000` (START_LIVE)
 * carrying the client RSA modulus as `encryptkey`, then hold it open with a `1139` keepalive —
 * distinct from the HomeBase `1003` path.
 */
const CMD_CONTROL_PAYLOAD = 1700;
const CMD_START_LIVE = 1000;
const CMD_STREAM_KEEPALIVE = 1139;
/**
 * The `1700` START_LIVE frame-header `type` byte.
 *
 * The current app does not derive this from the encryption level: it was captured sending 10 to one
 * own-session camera and 11 to another, both at signCode 8 (level-2 GCM), differing by model and firmware
 * generation rather than by cipher. Measured against the camera the app sends 11 to, a start carrying either
 * value is accepted and delivers a keyframe, so the byte does not gate the stream on that firmware.
 *
 * The values are kept split by level because that is the pairing each has been verified in — 10 with
 * level-2, 11 with level-1 — not because the level is known to select them.
 */
const START_LIVE_FRAME_TYPE_L1 = 11;
const START_LIVE_FRAME_TYPE_L2 = 10;
const CMD_VIDEO_FRAME = 1300;
const CMD_AUDIO_FRAME = 1301;
/**
 * Talkback (host→device audio) start/stop. Which pair applies is a **topology** fact, exactly as it
 * is for the media start: a HomeBase-attached camera takes the direct `1005`/`1006` frames, an
 * own-session camera takes `CMD_CONTROL_PAYLOAD` (1700) wrapping inner `commandType` `1001`/`1002`.
 * Both were captured live on 2026-07-31 in one session — a HomeBase serving two cameras (channels 2
 * and 3) took `1005`/`1006`, and a standalone T8170 on channel 0 took `1700`/`1001`+`1002` and never
 * saw a `1005` at all. The app's own Android sources carry both pairs
 * (`security_device/p2p/TalkBackCmdKt.java:23,28,33,38`).
 */
const CMD_START_TALKBACK = 1005;
const CMD_STOP_TALKBACK = 1006;
const CMD_START_SPEAK = 1001;
const CMD_END_SPEAK = 1002;
/** Bytes of header the device expects ahead of each outbound audio frame — see {@link P2PSession.sendAudioFrame}. */
const AUDIO_SEND_HEADER_BYTES = 16;
/**
 * The outbound audio channel is **reliable and ordered**, unlike the ordinary control path.
 * The device acknowledges each frame and stalls on a gap: one lost datagram blocks every later frame
 * behind it, so playback stops dead rather than glitching. Measured on a live capture of the app
 * talking to a camera: 20 of 53 frames needed a retransmit (38% loss), acknowledgement latency ran
 * 7/57/660 ms (min/median/max), and the app kept at most 7 frames unacknowledged at once.
 *
 * Recovery mirrors that measurement: a frame still unacknowledged after {@link AUDIO_RETRANSMIT_MS} is
 * sent **once** more and then forgotten. Three properties are load-bearing, each verified against a
 * real camera:
 *  - The timeout sits ABOVE the slowest acknowledgement the device is known to take (660 ms). Repeating
 *    a frame that was merely slow doubles the send rate, which delays acknowledgements further; the
 *    resulting spiral collapses the whole session — video included — within seconds.
 *  - A frame is repeated at most once. Repeating until some deadline amplifies traffic roughly 20× and
 *    causes more loss than it repairs.
 *  - Pacing never waits on the outstanding count. The device plays a continuous stream, so throttling
 *    the feed to let acknowledgements catch up starves it far faster than loss does.
 *
 * Abandoning a frame after that one repeat is a deliberate trade against the alternatives above, but it
 * does leave a permanent hole in an ordered stream — which by the ordering property means playback can
 * stop dead there. That is not something to hide behind a bounded map: the frame is dropped AND an
 * `audioGap` event is emitted, so the send side can tell a caller its audio may have stalled instead of
 * pacing on into silence.
 */
const AUDIO_RETRANSMIT_MS = 700;
const AUDIO_MAX_SENDS = 2;
/**
 * An own-session live start is acknowledged like an audio frame, and a start the device never took leaves
 * the camera silent with nothing to time out against but the warm-up deadline.
 *
 * So it is retained and repeated byte-identically until the device acknowledges it. Byte-identical is what
 * makes repeating safe: the frame carries its sequence number and its ciphertext, and a device receiving the
 * same sequence repeatedly starts the stream once — captured acknowledging one start's sequence seventeen
 * times while streaming it once. A rebuilt start would instead read as a second, different start.
 *
 * Repeating until acknowledged is the app's own behaviour: it was captured sending the identical start 20
 * times across 272 ms to a camera still waking, which acknowledged after 238 ms, and once to a camera that
 * acknowledged in 9 ms. A count-bounded repeat cannot express that — the number of sends a start needs is
 * whatever its acknowledgement latency demands, which measured 4–16 ms awake and 238 ms waking.
 */
const LIVE_START_RETRANSMIT_MS = 150;
/**
 * How long a live start is repeated before it is abandoned as unacknowledged.
 *
 * Two bounds sit either side of this. Below: the acknowledgement latencies actually measured — 4–37 ms from
 * an awake own-session camera, 238 ms from one still waking — and this stays an order of magnitude above
 * them, because abandoning early does not repair anything. A repeat is byte-identical and so is the same
 * start; what follows an abandonment is a start under a NEW sequence, which is a second start rather than a
 * repair, and the app never issues one. Above: the warm-up deadline a source gives the whole start (20s by
 * default), so an abandoned start is reported while the warm-up is still running — the trace is then the
 * reason the warm-up failed, not a footnote to it — and there is room for several fresh starts within it.
 */
const LIVE_START_ACK_DEADLINE_MS = 3000;
/**
 * Half the 16-bit sequence space: a datagram whose distance from the last one exceeds this is read as
 * arriving from behind rather than as a near-full-space jump forward, which is how the numbering wraps
 * without the datagram after the wrap looking like a huge gap.
 */
const SEQUENCE_LOOKBACK = 0x8000;
/**
 * How far back a datagram may be numbered and still be read as a retransmission of something already
 * reassembled rather than as the device having restarted its numbering.
 *
 * Measured against the app's own captures of two own-session cameras: across 1758 video datagrams the
 * deepest repeat arrived 120 numbers behind the high-water mark, so this bound sits an order of magnitude
 * clear of a genuine repeat. The bound is what the classification needs to exist at all, because the two
 * misreadings cost differently: a repeat mistaken for a restart discards one logical frame, while a restart
 * mistaken for a repeat discards every datagram until the new numbering climbs back past the frozen mark —
 * so the depth is what caps that second cost, at a bounded run of datagrams instead of half the space.
 */
const STALE_RETRANSMIT_DEPTH = 1024;

/** Additional UDP source ports registered alongside the session's own during cloud lookup. */
const PUNCH_PROBE_SOCKETS = 7;
/** Chosen maximum wait for a missing datagram; 250 ms is not a measured device resend delay. */
const REORDER_WAIT_MS = 250;
/** Maximum later datagrams held behind a hole, bounding retained memory and the delay before resuming. */
const REORDER_MAX_DATAGRAMS = 128;
/**
 * Datagram gaps traced per live start. A lossy channel can drop hundreds of datagrams in one start, and the
 * first few establish the pattern; the rest would only flood a host's log, so the trace stops there while
 * reassembly carries on unchanged.
 *
 * The budget is re-armed where a start is actually issued, not on every `startLiveMedia` call: that call is
 * also the keepalive tick, which arrives every few seconds for the whole life of a stream and would re-arm
 * the budget often enough that it bounded a window rather than the log.
 */
const MAX_TRACED_DATAGRAM_GAPS = 8;
/**
 * A datagram retained for retransmission until the device acknowledges its sequence number: the exact bytes
 * that were sent, when they first went out and when they last did, and how many times they have been sent.
 */
interface RetainedDatagram {
  data: Buffer;
  firstSentAt: number;
  sentAt: number;
  sends: number;
}
/** CMD_SET_PAYLOAD (1350) wraps a JSON command; CMD_DATABASE_IMAGE (1308) is the image reply. */
const CMD_SET_PAYLOAD = 1350;
/** CMD_NOTIFY_PAYLOAD (1351) — the station's unsolicited JSON notification. */
const CMD_NOTIFY_PAYLOAD = 1351;
/** CMD_CAMERA_INFO — a camera reporting its OWN params, as a root-level array. */
const CMD_CAMERA_INFO = 1103;
const CMD_DATABASE_IMAGE = 1308;
/** CMD_DATABASE (1306) — P2P SQLite-ish query; reply carries `{cmd:10000,count,data:[…]}`. */
const CMD_DATABASE = 1306;
/**
 * Inner query cmds carried in a {@link CMD_DATABASE} payload. `FULL_TABLE` reads one table whole;
 * `COMBINATION_WITH_AI` is the AI event-history read that bundles the face roster.
 */
const DB_QUERY = { FULL_TABLE: 10000, COMBINATION_WITH_AI: 10011 } as const;
/** AAD for the level-2 (gateway/"signCode 8") AES-256-GCM frames — fixed across all eufy P2P. */
const GCM_AAD = Buffer.from("eufy security");

/**
 * Transport wiring for a PPCS session — internal to the SDK; a host reaches sessions through the facade.
 * @internal
 */
export interface P2PSessionConfig {
  stationSn: string;
  p2pDid: string;
  /** Cloud lookup servers (decodeP2PCloudIPs of the station's p2p_conn/app_conn). */
  cloudAddresses?: Address[];
  /** DSK key for the cloud-lookup payload. Optional — local lookup needs none. */
  dskKey?: string;
  /** Known LAN address of the station, for a direct (non-broadcast) local lookup. */
  localAddress?: string;
  /** Disable UDP broadcast local lookup (e.g. cloud-only). Default false. */
  noBroadcast?: boolean;
  /**
   * Resolve a station `cipher_id` → its ECC private key hex (from cloud `get_ciphers`). When
   * provided, the session auto-negotiates the **level-2** session key on connect: it reads the
   * `cipher_id` + ECIES envelope from the `CMD_GATEWAYINFO` reply, derives the key, and calls
   * `setLevel2Key()` — so signCode 2/8 frames (camera info, event DB, event images) decrypt live.
   */
  resolveCipherKey?: (cipherId: number) => Promise<string | undefined>;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
}

/**
 * Lift a notify payload's `params` array into a `param_type → param_value` map, or `undefined` when
 * the payload isn't one.
 *
 * A station volunteers an attached device's state as `[{dev_type, param_type, param_value}, …]`, and
 * those `param_type` ids are the cloud record's own — so this is a format unwrap, not an
 * interpretation. Entries missing an id or a value are skipped rather than stored as `"undefined"`.
 *
 * Two frames are read this way, each in ONE shape, because the caller lands these as the reporting device's
 * params — which widens the evidence its typed reads are gated on, so a reply that merely happens to carry an
 * array must not be mistaken for a device reporting its own state. A station's notify nests an attached
 * device's array under `payload`; a camera's own `CMD_CAMERA_INFO` puts it at the root. Reading each only in
 * its measured shape is what keeps the distinction.
 */
function paramReport(payload: unknown): Record<number, string> | undefined {
  const list = (payload as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(list)) return undefined;
  const out: Record<number, string> = {};
  for (const entry of list) {
    const p = entry as { param_type?: unknown; param_value?: unknown };
    if (typeof p?.param_type !== "number" || p.param_value == null) continue;
    out[p.param_type] = String(p.param_value);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A decoded P2P data/notification frame.
 *
 * A decoded PPCS frame. Internal wire shape — surfaced on the facade's diagnostic event only.
 * @internal
 */
export interface P2PFrame extends P2PDataFrameHeader {
  stationSn: string;
  /** Resolved command name (e.g. "CMD_NOTIFY_PAYLOAD"), or "CMD_<id>" if unknown. */
  commandName: string;
  dataType: number;
  /** Payload after (attempted) decryption. */
  data: Buffer;
  /** Payload exactly as received, before any decryption (for diagnostics). */
  raw: Buffer;
  /** Parsed JSON when the payload is a NUL-terminated JSON document. */
  json?: { cmd?: number; payload?: unknown } & Record<string, unknown>;
  /**
   * Device params the frame reported, when its JSON carries a `params` array of
   * `{param_type, param_value}` — the shape a station uses to volunteer an attached device's state.
   *
   * Unwrapped here because it is pure framing: the entries are the SAME `param_type` ids the cloud
   * record uses, so nothing in this payload needs a capability to interpret it, and a caller can land
   * the values as device state without any per-capability decoder.
   */
  params?: Record<number, string>;
}

/** Per-process counter behind {@link P2PSession.traceId} — see it for why this is not a serial. */
let traceSequence = 0;

/**
 * A live PPCS session. Internal transport; a host drives cameras through the capability surface.
 * @internal
 */
export class P2PSession extends EventEmitter {
  private socket?: dgram.Socket;
  private connected = false;
  private connecting = false;
  private closed = false;
  /** Whether a short receive buffer has been reported, so a reconnect does not repeat the same warning. */
  private receiveBufferReported = false;
  private connectAddress?: Address;
  private seqNumber = 0;
  /**
   * Sequence counter for frames sent on the **video** data-type channel, which the device tracks
   * separately from the control channel's — today only {@link sendAudioFrame} rides it.
   */
  private videoSeqNumber = 0;
  /**
   * Audio frames sent but not yet acknowledged, keyed by their video-channel sequence number. Holding
   * the datagram (not just the payload) means a retransmit is byte-identical, which is what the
   * device's ordered channel expects.
   */
  private unackedAudio = new Map<number, RetainedDatagram>();
  /**
   * Whether the audio channel is currently in a stall — set when a frame is abandoned, cleared by the
   * next acknowledgement of any frame.
   *
   * A stall is an episode, not a per-frame event: once the device stops acknowledging, EVERY later
   * frame is abandoned in turn, so reporting each one turns a single condition into hundreds of
   * identical events. Measured live on a battery camera whose media session was stopped mid-clip by its
   * power budget: 74 consecutive frames, one event each, all saying the same thing. The condition is
   * reported once and again only if the channel recovers and stalls afresh.
   */
  private audioStalled = false;
  private audioRetransmitTimer?: ReturnType<typeof setInterval>;
  private lastPongData?: Buffer;
  /** When this connection last received a PONG — `undefined` until the first, see {@link pathSilentMs}. */
  private lastPongAt?: number;
  /** Whether the silence has already been stated, so it is traced once per connection rather than per read. */
  private pathStaleTraced = false;
  private lookupTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  /** Extra sockets registered alongside {@link socket} while connecting; see {@link PUNCH_PROBE_SOCKETS}. */
  private probeSockets: dgram.Socket[] = [];
  /** Cloud lookup inputs resolved once for a connection. */
  private cloudLookup?: { key: string; addresses: Address[] };
  /** Local outbound IPv4 reported inside LOOKUP_WITH_KEY requests. */
  private selfHost?: string;
  /** In-flight multi-datagram frame per data channel (see onData). */
  private readonly pendingByDataType = new Map<number, { header: P2PDataFrameHeader; buf: Buffer }>();
  /** Last delivered datagram sequence number per data type. */
  private readonly lastSeqByType = new Map<number, number>();
  /** Held datagrams and their active gap timer, grouped by data type. */
  private readonly reorderByType = new Map<
    number,
    { held: Map<number, Buffer>; timer?: ReturnType<typeof setTimeout> }
  >();
  private tracedDatagramGaps = 0;
  private readonly level1Key: Buffer;
  /** Negotiated 32-byte level-2/gateway key (AES-256-GCM). Set via setLevel2Key once known. */
  private level2Key?: Buffer;
  private level2Seq = 0;
  private rsaPrivateKey?: KeyObject;
  private rsaModulusHex?: string;
  /** Guards the one-shot level-2 key negotiation kicked off by the GATEWAYINFO reply. */
  private level2Negotiating = false;
  /**
   * Whether waiting for a level-2 key can still change the answer: `false` once one has been negotiated,
   * once the one-shot negotiation concluded without one, and from the start when nothing can negotiate one.
   */
  private level2Pending: boolean;
  /** Waiters parked in {@link awaitLevel2Key}, woken the moment the negotiation settles either way. */
  private readonly level2Waiters: Array<(outcome: "key" | "terminal" | "closed") => void> = [];
  /** Whether this connection has already been asked a second time for its gateway info — see {@link repromptLevel2Key}. */
  private level2Reprompted = false;
  /** When this session connected — the instant the level-2 negotiation had its chance to start. */
  private connectedAtMs?: number;
  /** Connection generation that owns every asynchronous result derived from its gateway envelope. */
  private connectionGeneration = 0;
  /**
   * Own-session channels with an active live start → the encryption variant of the start frame we
   * last sent (`"l2"` GCM / `"l1"` ECB). A keepalive tick re-issues the start if the variant should
   * change (the level-2 key arrived after an initial level-1 start), otherwise sends the 1139 nudge.
   */
  private readonly liveStartedChannels = new Map<number, "l1" | "l2">();
  private readonly unackedLiveStarts = new Map<number, RetainedDatagram & { channel: number }>();
  private liveStartRetransmitTimer?: ReturnType<typeof setInterval>;

  private readonly logger: Logger;

  constructor(private readonly cfg: P2PSessionConfig) {
    super();
    this.level1Key = Buffer.from(p2pCommandEncryptionKey(cfg.stationSn, cfg.p2pDid));
    this.logger = cfg.logger ?? noopLogger;
    this.level2Pending = cfg.resolveCipherKey !== undefined;
  }

  /**
   * This session's opaque handle for tracing — `station-N` by order of construction in this process.
   *
   * Not the serial: a trace carrying one could not be retained by a host, which is the whole point of the
   * phase vocabulary. It groups one station's records within a run and resolves to nothing outside it.
   */
  readonly traceId = `station-${++traceSequence}`;

  /**
   * How long this connection's path has been silent, or nothing where it has never answered.
   *
   * A PONG is the station stating that the path is alive. `undefined` is neither alive nor dead: it is a station
   * that has said nothing either way.
   */
  get pathSilentMs(): number | undefined {
    return this.lastPongAt === undefined ? undefined : Date.now() - this.lastPongAt;
  }

  /**
   * Whether this path can still be committed to, on the evidence the heartbeat gives.
   *
   * False where a pong arrived and then stopped for {@link PATH_SILENCE_MS}. A station that has never ponged is
   * not known to be dead, so it answers true.
   *
   * Traces the silence once per connection, on the read that first observes it.
   */
  get pathAnswering(): boolean {
    const silentMs = this.pathSilentMs;
    if (silentMs === undefined || silentMs < PATH_SILENCE_MS) return true;
    if (!this.pathStaleTraced) {
      this.pathStaleTraced = true;
      this.logger.debug(`[p2p] ${this.cfg.stationSn} path silent for ${silentMs}ms — no heartbeat answer`);
      this.trace({ phase: "path-stale", silentMs });
    }
    return false;
  }

  /** Emit a live trace under this session's handle. */
  private trace(trace: LiveTrace): void {
    traceLiveStart(this.logger, trace, this.traceId);
  }

  /** Provide the negotiated 32-byte session key so level-2 (signCode 2/8) frames can be decrypted. */
  setLevel2Key(key: Buffer): void {
    if (key.length !== 32) throw new Error(`level-2 key must be 32 bytes, got ${key.length}`);
    this.level2Key = key;
    this.settleLevel2();
  }

  /** Whether the level-2 session key has been negotiated/set. */
  get hasLevel2Key(): boolean {
    return !!this.level2Key;
  }

  /**
   * Resolve with whether a level-2 key is available, waiting only while waiting can still change that.
   *
   * A `"session"` grace is measured once, not restarted per call. Best-effort media uses it because every
   * egress asks this same session and can proceed without the key on an own-session camera; a per-call
   * budget there makes a station that offers no key charge its full budget on every later stream.
   *
   * A `"call"` grace gives the full wait to a command that cannot be framed without the key. Such a
   * command may arrive on an old session before a delayed `CMD_GATEWAYINFO`, so session age says nothing
   * about whether the key can still arrive during this command.
   *
   * The session grace runs from connect, when the station is prompted for `CMD_GATEWAYINFO`. A negotiation
   * beginning later does not restart it: best-effort media can proceed without the key, and restarting
   * would charge another grace to a source that may already be streaming. A session whose negotiation has
   * settled answers without waiting at all, since being one-shot is what makes that answer final.
   *
   * An own-session camera whose grace expires here is NOT thereby a camera that will fail to stream. Measured
   * on one account: own-session cameras of two device types negotiated a key, three others never did, and
   * cameras from that second group streamed normally at level-1 — including one of the same firmware as an
   * own-session camera that delivered no video at all for a reason of its own. An expired grace therefore
   * separates nothing on this path, and a start failure on such a session is not evidence about it.
   *
   * Every `false` answer carries a `level2-unavailable` trace naming its reason, wherever the wait ended: a
   * `terminal` outcome is the one already stated where the negotiation concluded, since that is where the
   * cipher and the cause are known, and re-stating it here would double every settled negotiation.
   */
  async awaitLevel2Key(graceMs: number, graceFrom: "call" | "session" = "call"): Promise<boolean> {
    if (this.closed) {
      this.trace({ phase: "level2-unavailable", reason: "session-closed" });
      return false;
    }
    if (this.level2Key) return true;
    if (!this.level2Pending) {
      this.trace({ phase: "level2-unavailable", reason: "not-negotiating" });
      return false;
    }
    const since = graceFrom === "call" ? Date.now() : (this.connectedAtMs ?? Date.now());
    const remaining = graceMs - (Date.now() - since);
    if (remaining <= 0) {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} no level-2 key and its ${graceMs}ms grace has elapsed`);
      this.trace({ phase: "level2-unavailable", reason: "grace-elapsed", waitedMs: graceMs });
      return false;
    }
    this.logger.debug(`[p2p] ${this.cfg.stationSn} waiting up to ${remaining}ms for the level-2 key`);
    this.trace({ phase: "level2-wait", waitMs: remaining });
    const waiters = this.level2Waiters;
    const outcome = await new Promise<"key" | "terminal" | "closed" | "timeout">((resolve) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: "key" | "terminal" | "closed" | "timeout"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const at = waiters.indexOf(wake);
        if (at >= 0) waiters.splice(at, 1);
        resolve(result);
      };
      const wake = (result: "key" | "terminal" | "closed"): void => finish(result);
      deadline = setTimeout(() => finish("timeout"), remaining);
      deadline.unref?.();
      waiters.push(wake);
    });
    if (outcome === "timeout") {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} level-2 key did not arrive within its grace`);
      this.trace({ phase: "level2-unavailable", reason: "grace-elapsed", waitedMs: remaining });
    } else if (outcome === "terminal") {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} level-2 negotiation concluded without a key`);
    } else if (outcome === "closed") {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} session closed before the level-2 key arrived`);
      this.trace({ phase: "level2-unavailable", reason: "session-closed" });
    }
    return outcome === "key";
  }

  /**
   * Ask the station for its gateway info a second time, re-opening a negotiation that concluded without a key.
   *
   * The negotiation is one-shot per connection: the station is prompted once on connect, and a reply that
   * never lands settles the wait so {@link awaitLevel2Key} answers `false` at once forever after. That is the
   * right answer for best-effort media, which proceeds at level-1 — but an operation whose ONLY wire is
   * level-2 is then refused for the whole life of that connection, while a fresh session over the same
   * device negotiates a key normally. Measured: a session that had settled refused every such operation
   * until it was rebuilt, at which point the station answered with a cipher id straight away.
   *
   * Bounded to one extra ask per connection, so a burst of such operations cannot turn a silent station into a
   * flood, and answers whether it asked — `false` when a key is already held, when nothing can negotiate one,
   * when the ask was already spent, or when there is nowhere to send it. Callers with a level-1 path must not
   * use this: re-prompting on their behalf would be noise for an answer they do not need.
   */
  repromptLevel2Key(): boolean {
    if (this.closed || this.level2Key || this.level2Reprompted) return false;
    if (!this.cfg.resolveCipherKey || !this.connectAddress) return false;
    this.level2Reprompted = true;
    this.level2Pending = true;
    this.logger.debug(`[p2p] ${this.cfg.stationSn} asking again for the level-2 key`);
    this.sendCommand(CMD_GATEWAYINFO);
    return true;
  }

  /** Record that the level-2 negotiation has finished, with or without a key, and wake every waiter. */
  private settleLevel2(reason: "terminal" | "closed" = "terminal"): void {
    this.level2Pending = false;
    const outcome = this.level2Key ? "key" : reason;
    for (const wake of this.level2Waiters.splice(0)) wake(outcome);
  }

  /**
   * Negotiate the level-2 session key from the decrypted CMD_GATEWAYINFO payload: read its
   * `cipher_id`, resolve that cipher's ECC private key (cloud `get_ciphers`, via the configured
   * `resolveCipherKey`), run the ECIES unwrap, and `setLevel2Key()`. One-shot; emits `level2Ready`
   * on success and `error` on failure (non-fatal — level-1 traffic keeps working regardless).
   *
   * Every outcome settles the wait in {@link awaitLevel2Key}, because being one-shot is what makes a
   * failure final for this connection generation: nothing will retry it there, so a later command must be
   * told at once rather than left to time out against a key that is not coming.
   */
  private negotiateLevel2Key(gwPayload: Buffer): void {
    this.level2Negotiating = true;
    const generation = this.connectionGeneration;
    const cipherId = gatewayInfoCipherId(gwPayload);
    this.trace({ phase: "level2-negotiating", cipherId });
    void (async () => {
      try {
        const eccPrivHex = await this.cfg.resolveCipherKey?.(cipherId);
        if (this.closed || generation !== this.connectionGeneration) return;
        if (!eccPrivHex) {
          this.logger.debug(`[p2p] ${this.cfg.stationSn} no ECC key for cipher_id ${cipherId}`);
          this.trace({ phase: "level2-unavailable", reason: "no-cipher-key", cipherId });
          this.settleLevel2();
          return;
        }
        const key = deriveLevel2KeyFromGatewayInfo(gwPayload, eccPrivHex);
        if (!key) {
          this.trace({ phase: "level2-unavailable", reason: "derivation-failed", cipherId });
          this.settleLevel2();
          this.emit("error", new Error(`level-2 key derivation failed (cipher_id ${cipherId})`));
          return;
        }
        this.setLevel2Key(key);
        this.logger.debug(`[p2p] ${this.cfg.stationSn} level-2 key negotiated (cipher_id ${cipherId})`);
        this.trace({ phase: "level2-ready", cipherId });
        this.emit("level2Ready", { cipherId });
      } catch (e) {
        if (this.closed || generation !== this.connectionGeneration) return;
        this.trace({ phase: "level2-unavailable", reason: "derivation-failed", cipherId });
        this.settleLevel2();
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }

  /**
   * Decrypt a level-2 P2P frame payload (AES-256-GCM, key = negotiated session key, AAD
   * "eufy security"). Both signCodes use the SAME key + layout, differing only by a 4-byte
   * cleartext sub-header — reversed from `libmega_media_sdk.so` + verified (GCM tag authenticates):
   *
   *   signCode 8 (app→station commands):  tag(16) ‖ nonce(12) ‖ `[seq,03,02,01]`(4) ‖ ciphertext  → ct@32
   *   signCode 2 (station media/db/notify): tag(16) ‖ nonce(12) ‖ ciphertext                     → ct@28
   *
   * (signCode 2 carries the station's content — `CMD_CAMERA_INFO`, `CMD_DATABASE` responses,
   * `CMD_DATABASE_IMAGE` JPEGs, notify results. signCode 2 and 8 share the one AES-256-GCM session
   * key; only the ciphertext offset differs, by the 4 sub-header bytes present on signCode 8.)
   */
  private decryptLevel2(payload: Buffer, signCode: number): Buffer | undefined {
    const ctOffset = signCode === 8 ? 32 : 28; // sign-8 has the 4-byte [seq,03,02,01] sub-header
    // tag(16)+nonce(12)=28 are at the front; ciphertext (possibly empty) follows at ctOffset.
    if (!this.level2Key || payload.length < ctOffset) return undefined;
    try {
      const tag = payload.subarray(0, 16);
      const nonce = payload.subarray(16, 28);
      const ct = payload.subarray(ctOffset);
      const d = createDecipheriv("aes-256-gcm", this.level2Key, nonce);
      d.setAAD(GCM_AAD);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      return undefined;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Ask the OS for {@link RECEIVE_BUFFER_BYTES} on a bound socket, and warn once per session when it grants
   * less or refuses.
   *
   * The request is made here rather than through `createSocket`'s `recvBufferSize`: Node applies that option
   * inside the bind callback, where a refusal is thrown out of reach of this session and ends the process.
   */
  private requestReceiveBuffer(socket: dgram.Socket): void {
    let granted: number;
    try {
      socket.setRecvBufferSize(RECEIVE_BUFFER_BYTES);
      granted = socket.getRecvBufferSize();
    } catch {
      granted = 0;
    }
    if (granted >= RECEIVE_BUFFER_BYTES || this.receiveBufferReported) return;
    this.receiveBufferReported = true;
    this.logger.warn(
      `[p2p] ${this.cfg.stationSn} UDP receive buffer below the ${RECEIVE_BUFFER_BYTES} bytes requested` +
        (granted > 0 ? ` (granted ${granted})` : " (request refused)") +
        `; live video can lose keyframes. Raise the OS limit (net.core.rmem_max on Linux, ` +
        `kern.ipc.maxsockbuf on BSD) to at least ${RECEIVE_BUFFER_BYTES}.`,
    );
  }

  /** Open the socket and start the lookup → hole-punch handshake. */
  async connect(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.closed = false;
    this.connectionGeneration += 1;
    this.resetInboundSequencing();
    if (!this.level2Key) {
      this.level2Pending = this.cfg.resolveCipherKey !== undefined;
      this.level2Negotiating = false;
      this.level2Reprompted = false;
    }

    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg, rinfo) => this.onMessage(msg, rinfo, socket));
    socket.on("error", (e) => this.emit("error", e));

    await new Promise<void>((resolve) => {
      socket.bind(() => {
        try {
          socket.setBroadcast(true);
        } catch {
          /* broadcast not permitted — cloud path still works */
        }
        this.requestReceiveBuffer(socket);
        resolve();
      });
    });

    void P2PSession.detectLocalIp().then((host) => {
      if (host && !this.closed) this.selfHost = host;
    });

    const { dskKey, cloudAddresses } = this.cfg;
    this.cloudLookup = dskKey && cloudAddresses?.length ? { key: dskKey, addresses: cloudAddresses } : undefined;
    if (this.cloudLookup) await this.startPunchProbes();
    if (this.closed) return;
    this.trace({
      phase: "lookup-channels",
      local: !this.cfg.noBroadcast || this.cfg.localAddress !== undefined,
      cloud: this.cloudLookup !== undefined,
    });
    this.sendLookups();
    this.lookupTimer = setInterval(() => this.sendLookups(), LOOKUP_RETRY_MS);
    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        this.emit("error", new Error(`P2P connect timeout for ${this.cfg.stationSn}`));
        void this.close();
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /** Cached across every `P2PSession` in this process — the local outbound IPv4 doesn't vary by
   * station, so there's no reason to re-probe it per session (e.g. once per station in a fleet). Only
   * a SUCCESSFUL probe is cached (see {@link detectLocalIp}) — a transient failure must not be memoized
   * forever. */
  private static localIpPromise?: Promise<string | undefined>;

  /** Best-effort local outbound IPv4 (the address the OS would route through to reach the internet) —
   * connects a throwaway UDP socket (no packets sent, just kernel routing) and reads its bound
   * address. Needed to self-report our own host:port inside a LOOKUP_WITH_KEY request. Bounded by its
   * own timeout so a hung probe (sandboxed/offline network) can never block anything indefinitely;
   * resolves to `undefined` on any failure so callers skip the self-report rather than send a bogus
   * `0.0.0.0` wildcard address (unconfirmed whether the cloud lookup server treats that specially).
   *
   * Two failure modes guarded here:
   *  - **Permanent poisoning**: the underlying probe promise always RESOLVES (never rejects), even on
   *    failure — so a naive `if (!cached) probe()` memoizes `undefined` exactly like a real address,
   *    forever, the first time this races (e.g. a transient blip on the very first `connect()` in the
   *    process). Every later session would then be silently stuck on the KEY2 (relay-only) lookup
   *    variant for the process's whole lifetime. Fixed by only caching a successful (non-undefined)
   *    result — a failure clears `localIpPromise` so the NEXT call re-probes.
   *  - **Teardown races**: the timeout, the `connect` callback, and the `error` handler all race to
   *    finish the same probe. Without a `settled` guard, a timeout that fires first (closes + resolves)
   *    can be followed by the `connect` callback still firing on the now-closed socket — `.address()` or
   *    a second `.close()` on an already-closed dgram socket both throw `ERR_SOCKET_DGRAM_NOT_RUNNING`
   *    SYNCHRONOUSLY, off any promise chain, surfacing as an uncaught exception. `settled` + try/catch
   *    around the teardown close that window.
   */
  private static detectLocalIp(): Promise<string | undefined> {
    if (!P2PSession.localIpPromise) {
      P2PSession.localIpPromise = new Promise<string | undefined>((resolve) => {
        const probe = dgram.createSocket("udp4");
        let settled = false;
        const finish = (result: string | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            probe.close();
          } catch {
            /* already closed/closing — nothing left to clean up */
          }
          resolve(result);
        };
        const timer = setTimeout(() => finish(undefined), 2000);
        probe.connect(53, "8.8.8.8", () => {
          try {
            finish(probe.address().address);
          } catch {
            finish(undefined);
          }
        });
        probe.once("error", () => finish(undefined));
      }).then((result) => {
        if (result === undefined) P2PSession.localIpPromise = undefined;
        return result;
      });
    }
    return P2PSession.localIpPromise;
  }

  private sendLookups(): void {
    if (this.connected || !this.socket) return;
    // Local: broadcast + (optionally) the known LAN address.
    const localPayload = buildLocalLookupPayload();
    if (!this.cfg.noBroadcast)
      this.send({ host: "255.255.255.255", port: LOCAL_LOOKUP_PORT }, RequestMessageType.LOCAL_LOOKUP, localPayload);
    if (this.cfg.localAddress)
      this.send(
        { host: this.cfg.localAddress, port: LOCAL_LOOKUP_PORT },
        RequestMessageType.LOCAL_LOOKUP,
        localPayload,
      );
    // Cloud: needs a DSK key. Prefer the classic variant (LOOKUP_WITH_KEY, 0xf126 — what the real app
    // sends, and the only one observed to get a genuine direct-device candidate back) once the
    // background self-IP probe has resolved; every real capture of a relay-pool-only response (f182)
    // was ALSO reproducible via LOOKUP_WITH_KEY, so KEY2 (0xf16a) adds no observed candidate KEY
    // doesn't already surface — it's sent only as a same-tick fallback for the brief window before
    // `selfHost` is known (usually just the first tick or two after connect()).
    const lookup = this.cloudLookup;
    if (lookup) {
      for (const socket of [this.socket, ...this.probeSockets]) this.sendCloudLookup(socket, lookup);
      this.logger.debug(
        `[p2p] ${this.cfg.stationSn} sendLookups: cloud -> ${lookup.addresses.map((a) => `${a.host}:${a.port}`).join(", ")} self=${this.selfHost ?? "unknown"}`,
      );
    }
  }

  /** Register a bound socket's own port with each configured cloud lookup address. */
  private sendCloudLookup(socket: dgram.Socket, lookup: { key: string; addresses: Address[] }): void {
    const payload = this.selfHost
      ? buildLookupWithKeyPayload(this.cfg.p2pDid, this.selfHost, socket.address().port, lookup.key)
      : buildLookupWithKeyPayload2(this.cfg.p2pDid, lookup.key);
    const type = this.selfHost ? RequestMessageType.LOOKUP_WITH_KEY : RequestMessageType.LOOKUP_WITH_KEY2;
    for (const addr of lookup.addresses) this.send(addr, type, payload, socket);
  }

  /**
   * Route one inbound UDP datagram by its message type, tracing every non-DATA one and any type this session
   * does not model.
   *
   * An unmodelled type is not by itself evidence about a session that is failing. `0xf169` — a relay-pool
   * listing answering a cloud lookup, which a connected session has no use for — reaches the UNHANDLED branch
   * on the sessions of cameras that stream and cameras that do not alike. `0xf121` has been observed
   * straddling a level-2 wait on a camera whose failure to deliver video had a separate cause, and did not
   * recur across later probes of it. Correlate an unmodelled type against a WORKING session before reading it
   * as a cause.
   */
  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, socket = this.socket): void {
    if (!socket) return;
    if (!hasHeader(msg, ResponseMessageType.DATA)) {
      this.logger.debug(
        `[p2p] ${this.cfg.stationSn} <<< ${rinfo.address}:${rinfo.port} header=${msg.subarray(0, 2).toString("hex")} len=${msg.length}`,
      );
    }
    if (hasHeader(msg, ResponseMessageType.LOCAL_LOOKUP_RESP)) {
      // LOCAL_LOOKUP_RESP shares 0xf141 with CAM_ID; treat a pre-connect response
      // from the lookup as "device here, hole-punch it".
      if (!this.connected) this.beginCheckCam({ host: rinfo.address, port: rinfo.port }, socket);
    } else if (hasHeader(msg, ResponseMessageType.LOOKUP_ADDR) || hasHeader(msg, ResponseMessageType.LOOKUP_ADDR2)) {
      if (!this.connected) {
        const addr = parseLookupAddr(msg);
        this.logger.debug(`[p2p] ${this.cfg.stationSn} LOOKUP_ADDR -> ${addr.host}:${addr.port}`);
        if (addr.host !== "0.0.0.0") this.beginCheckCam(addr, socket);
      }
    } else if (hasHeader(msg, ResponseMessageType.CAM_ID) || hasHeader(msg, ResponseMessageType.TURN_SERVER_CAM_ID)) {
      this.onConnected({ host: rinfo.address, port: rinfo.port }, socket);
    } else if (hasHeader(msg, ResponseMessageType.PONG)) {
      this.lastPongData = msg.length > 4 ? msg.subarray(4) : undefined;
      this.lastPongAt = Date.now();
      this.pathStaleTraced = false;
    } else if (hasHeader(msg, ResponseMessageType.PING)) {
      this.send({ host: rinfo.address, port: rinfo.port }, RequestMessageType.PONG, undefined, socket); // echo
    } else if (hasHeader(msg, ResponseMessageType.ACK)) {
      this.onAck(msg);
    } else if (hasHeader(msg, ResponseMessageType.DATA)) {
      if (this.connected) this.onData(msg, { host: rinfo.address, port: rinfo.port });
    } else {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} UNHANDLED payload hex: ${msg.toString("hex")}`);
    }
  }

  private beginCheckCam(addr: Address, socket: dgram.Socket): void {
    this.logger.debug(`[p2p] ${this.cfg.stationSn} beginCheckCam -> ${addr.host}:${addr.port} (+/-3)`);
    const payload = buildCheckCamPayload(this.cfg.p2pDid);
    // Hole-punch the reported port and a small neighbourhood (NAT remapping).
    this.send(addr, RequestMessageType.CHECK_CAM, payload, socket);
    for (let p = addr.port - 3; p <= addr.port + 3; p++)
      if (p !== addr.port && p > 0)
        this.send({ host: addr.host, port: p }, RequestMessageType.CHECK_CAM, payload, socket);
  }

  /** Bind additional UDP source ports before the first cloud lookup. */
  private async startPunchProbes(): Promise<void> {
    await Promise.all(
      Array.from({ length: PUNCH_PROBE_SOCKETS }, async () => {
        const probe = dgram.createSocket("udp4");
        probe.on("error", (error) => this.logger.warn("[p2p] lookup socket error", error.message));
        probe.on("message", (msg, rinfo) => this.onMessage(msg, rinfo, probe));
        this.probeSockets.push(probe);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (bound: boolean) => {
            if (settled) return;
            settled = true;
            probe.off("error", onError);
            probe.off("close", onClose);
            if (!bound) {
              this.probeSockets = this.probeSockets.filter((socket) => socket !== probe);
              try {
                probe.close();
              } catch {}
            }
            resolve();
          };
          const onError = () => finish(false);
          const onClose = () => finish(false);
          probe.once("error", onError);
          probe.once("close", onClose);
          probe.bind(() => finish(true));
        });
      }),
    );
  }

  /** Close all lookup sockets except the one that completed the handshake. */
  private stopPunchProbes(winner?: dgram.Socket): void {
    for (const probe of this.probeSockets) {
      if (probe === winner) continue;
      probe.removeAllListeners("message");
      probe.close();
    }
    this.probeSockets = [];
  }

  private onConnected(addr: Address, socket: dgram.Socket): void {
    if (this.connected) return;
    this.stopPunchProbes(socket);
    if (this.socket !== socket) {
      this.socket?.removeAllListeners();
      this.socket?.close();
      socket.removeAllListeners("error");
      socket.on("error", (error) => this.emit("error", error));
      this.socket = socket;
    }
    this.connected = true;
    this.connectedAtMs = Date.now();
    this.connecting = false;
    this.connectAddress = addr;
    if (this.lookupTimer) clearInterval(this.lookupTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.logger.debug(`[p2p] ${this.cfg.stationSn} connected ${addr.host}:${addr.port}`);

    // Nudge the station to start reporting, then heartbeat.
    this.sendCommand(CMD_GATEWAYINFO);
    this.send(addr, RequestMessageType.PING, this.lastPongData);
    this.heartbeatTimer = setInterval(() => {
      if (this.connectAddress) this.send(this.connectAddress, RequestMessageType.PING, this.lastPongData);
    }, HEARTBEAT_MS);
    this.emit("connect");
  }

  /**
   * Start the realtime media stream for a camera `channel` (the device's `device_channel`; defaults to
   * the station channel). The camera then streams `CMD_VIDEO_FRAME` (1300) + `CMD_AUDIO_FRAME` (1301),
   * surfaced via the `data` event. Two start protocols, selected by runtime topology (never by device
   * family):
   *  - `homeBaseAttached` (the camera rides a HomeBase's session): `CMD_SET_PAYLOAD` (1350) wrapping
   *    `{cmd:1003, mChannel:channel}` at level-2, where `mChannel` picks the camera on the base.
   *  - own-session (the session is the camera itself): `CMD_CONTROL_PAYLOAD` (1700) / inner cmd 1000
   *    START_LIVE, then the 1139 keepalive to hold the stream. A bare 1003 is read as a status query
   *    there, not a stream.
   *
   * An own-session start's encryption follows the session key, not the device family: level-2 GCM once a
   * key is negotiated, level-1 ECB before that. A key that arrives after a level-1 start makes the next
   * keepalive tick re-issue the start at level-2, so a camera that only accepts level-2 recovers from a
   * `live()` that raced ahead of key negotiation.
   *
   * Each start is retained until its DATA acknowledgement and repeated every `LIVE_START_RETRANSMIT_MS` until
   * the device acknowledges one, bounded by `LIVE_START_ACK_DEADLINE_MS` rather than by a send count. Both are
   * internal to this module, so they are named as code: a public comment cannot link to what the reference does
   * not carry. Use the `LiveStream` helper for a managed feed with keepalive.
   *
   * `opts.force` sends a real start on a channel this session already counts as started, and yields to a
   * start still awaiting acknowledgement — that one is already being repeated byte-identically and is
   * abandoned at its own deadline.
   */
  startLiveMedia(
    channel: number = STATION_CHANNEL,
    accountId = "",
    homeBaseAttached = false,
    opts?: { force?: boolean },
  ): void {
    if (homeBaseAttached) {
      this.tracedDatagramGaps = 0;
      this.trace({
        phase: "media-command",
        topology: "attached",
        action: "start",
        level2: !!this.level2Key,
      });
      this.sendMediaPayloadLevel2(CMD_START_REALTIME_MEDIA, channel, accountId, {});
      return;
    }
    const want: "l1" | "l2" = this.level2Key ? "l2" : "l1";
    if (opts?.force) {
      for (const pending of this.unackedLiveStarts.values()) if (pending.channel === channel) return;
      this.liveStartedChannels.delete(channel);
    }
    if (this.liveStartedChannels.get(channel) === want) {
      this.trace({
        phase: "media-command",
        topology: "own",
        action: "keepalive",
        level2: want === "l2",
      });
      this.sendCommand(CMD_STREAM_KEEPALIVE, channel);
    } else {
      this.trace({ phase: "media-command", topology: "own", action: "start", level2: want === "l2" });
      this.tracedDatagramGaps = 0;
      this.sendStartLiveOwnSession(channel, accountId);
      this.liveStartedChannels.set(channel, want);
    }
  }

  /**
   * The own-session START_LIVE wrapper JSON (`{commandType: 1000, data: {…}}`).
   *
   * Every field is byte-verified against the current app's own start for an own-session camera, decrypted
   * from a level-2 capture: `msg_id` is 1, `extValue` repeats the inner command id 1000, `streamtype` is 2,
   * `video_type` is 12, and `transaction` is the millisecond timestamp as a string. The device answers a
   * start carrying these values with a keyframe; `encryptkey` is the modulus it RSA-wraps each keyframe's
   * AES media key with (unwrapped by {@link decodeVideoFrame}).
   */
  private startLiveJson(channel: number, accountId: string): Buffer {
    const now = Date.now();
    return Buffer.from(
      JSON.stringify({
        commandType: CMD_START_LIVE,
        data: {
          cmd: CMD_START_LIVE,
          account_id: accountId,
          accountId,
          mValueStrSub: accountId,
          mChannel: channel,
          mValue3: 0,
          mValue5: 0,
          msg_id: 1,
          camera_type: 0,
          entrytype: 0,
          extValue: CMD_START_LIVE,
          ivalue: 1,
          restore: 0,
          streamtype: 2,
          video_type: 12,
          timestamp: now,
          transaction: String(now),
          encryptkey: this.rsaModulus(),
        },
      }),
      "utf-8",
    );
  }

  /**
   * Send the own-session START_LIVE frame (outer `CMD_CONTROL_PAYLOAD` 1700, inner cmd 1000). Level-2
   * (GCM, signCode 8, frame type 10) when the session has a negotiated key, else level-1 (AES-128-ECB,
   * signCode 1, frame type 11) — chosen by the session key, not the device family. The camera RSA-wraps
   * each keyframe's AES media key with the `encryptkey` modulus (unwrapped by {@link decodeVideoFrame}).
   */
  private sendStartLiveOwnSession(channel: number, accountId: string): void {
    if (!this.connectAddress) return;
    const plain = this.startLiveJson(channel, accountId);
    let payload: Buffer;
    let signCode: number;
    let magic: [number, number];
    let frameType: number;
    if (this.level2Key) {
      const enc = this.encryptLevel2(plain);
      if (!enc) return;
      payload = enc;
      signCode = 8;
      magic = [0x08, 0x00];
      frameType = START_LIVE_FRAME_TYPE_L2;
    } else {
      payload = encryptP2PData(paddingP2PData(plain), this.level1Key);
      signCode = 1;
      magic = [0x01, 0x00];
      frameType = START_LIVE_FRAME_TYPE_L1;
    }
    const sequence = this.seqNumber;
    const data = Buffer.concat([
      buildCommandHeader(sequence, CMD_CONTROL_PAYLOAD),
      buildRawCommandPayload(payload, channel, signCode, magic, frameType),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    for (const [pendingSequence, pending] of this.unackedLiveStarts) {
      if (pending.channel === channel) this.unackedLiveStarts.delete(pendingSequence);
    }
    const sentAt = Date.now();
    this.unackedLiveStarts.set(sequence, { channel, data, firstSentAt: sentAt, sentAt, sends: 1 });
    this.armLiveStartRetransmit();
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * Repeat unacknowledged own-session live starts until the device takes one. Runs only while a start is
   * outstanding.
   *
   * A start abandoned at {@link LIVE_START_ACK_DEADLINE_MS} is traced as `media-command-unacknowledged` and
   * the channel's started state is forgotten. Both halves matter: the camera was never told to stream, so
   * the warm-up that follows can only ever time out, and the trace is what separates that from a camera that
   * got the start and stayed silent. Forgetting the state is what lets the next keepalive tick issue a real
   * start under a fresh sequence — while the channel still counts as started, every tick sends only the 1139
   * nudge, which holds a stream that was never started and cannot begin one.
   *
   * The abandonment emits `liveStartUnacknowledged` carrying the RESOLVED channel, so a listener matches it
   * against {@link STATION_CHANNEL} where it started one without naming a channel.
   */
  private armLiveStartRetransmit(): void {
    if (this.liveStartRetransmitTimer) return;
    this.liveStartRetransmitTimer = setInterval(() => {
      const outstanding = this.retransmitUnacked(this.unackedLiveStarts, {
        retransmitMs: LIVE_START_RETRANSMIT_MS,
        spent: (held) => Date.now() - held.firstSentAt >= LIVE_START_ACK_DEADLINE_MS,
        onResent: () => this.trace({ phase: "media-command-retry", action: "start" }),
        onAbandoned: (_sequence, held) => {
          this.liveStartedChannels.delete(held.channel);
          this.trace({ phase: "media-command-unacknowledged", action: "start" });
          this.emit("liveStartUnacknowledged", held.channel);
        },
      });
      if (!outstanding) this.clearLiveStartRetransmit();
    }, LIVE_START_RETRANSMIT_MS / 2);
    this.liveStartRetransmitTimer.unref?.();
  }

  private clearLiveStartRetransmit(): void {
    if (!this.liveStartRetransmitTimer) return;
    clearInterval(this.liveStartRetransmitTimer);
    this.liveStartRetransmitTimer = undefined;
  }

  /**
   * Send a **string-payload control command** (the JSON control wrapper `1700` / media `1350`)
   * over the **level-1** (AES-128-ECB) control channel — the WRITE
   * primitive behind `setProperty`. `value` is the JSON the app wraps (`{commandType, data}`); the
   * device unwraps and applies it. Fire-and-forget today (the device echoes the new state back as a
   * param update); request/response correlation is a later refinement.
   */
  sendStringPayloadCommand(commandType: number, value: string, channel: number = STATION_CHANNEL): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    const data = Buffer.concat([
      buildCommandHeader(this.seqNumber, commandType),
      buildStringCommandPayload(value, channel, this.level1Key, 1),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * Send an **int+string control command** over the level-1 (AES-128-ECB) channel — the wire shape
   * the app uses for the floodlight/spotlight switch (`CMD_SET_FLOODLIGHT_MANUAL_SWITCH` 1400) on
   * IndoorOutdoor / SoloCam-spotlight / Cam2C-3 families: `value` (0/1), `valueSub` (channel), and
   * `strValue` (admin `account_id`). See {@link buildIntStringCommandPayload}. Fire-and-forget.
   */
  sendIntStringCommand(
    commandType: number,
    value: number,
    valueSub: number,
    strValue: string,
    channel = STATION_CHANNEL,
  ): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    const data = Buffer.concat([
      buildCommandHeader(this.seqNumber, commandType),
      buildIntStringCommandPayload(value, valueSub, strValue, channel, this.level1Key, 1),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * Send a **level-2 (AES-256-GCM, signCode 8) control payload** to a HomeBase-attached device. The
   * target camera is selected by `channel` (= device_channel) + the `mChannel` envelope — the same
   * mechanism proven for camera selection in media start. Use for control commands routed through a
   * HomeBase (where level-1 ECB is rejected). Returns `false` if the level-2 key isn't negotiated
   * yet (caller can fall back to {@link sendStringPayloadCommand}).
   */
  sendControlLevel2(
    cmd: number,
    channel: number,
    accountId: string,
    payload: Record<string, unknown>,
    mValue3: number = cmd,
  ): boolean {
    if (!this.connectAddress || !this.level2Key) return false;
    const value = JSON.stringify({ account_id: accountId, cmd, mChannel: channel, mValue3, payload });
    const body = this.encryptLevel2(Buffer.from(value, "utf-8"));
    if (!body) return false;
    const data = Buffer.concat([
      buildCommandHeader(this.seqNumber, CMD_SET_PAYLOAD),
      buildRawCommandPayload(body, channel, 8, [0x08, 0x00], 0),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
    return true;
  }

  /**
   * Send a **level-2 (GCM, signCode 8) frame whose plaintext is exactly `json`** — no
   * `{account_id,cmd,mChannel,…}` envelope. The target device is selected by the frame-header
   * `channel`. This is the form the eufy app uses for control commands (confirmed by live capture:
   * floodlight = `{"commandType":1400,"data":{...}}`). Returns `false` if no level-2 key.
   */
  sendRawLevel2(json: string, channel: number, outerCmd: number = CMD_SET_PAYLOAD): boolean {
    return this.sendRawLevel2Bytes(Buffer.from(json, "utf-8"), channel, outerCmd);
  }

  /**
   * Like {@link sendRawLevel2} but the plaintext is a raw byte buffer, not a UTF-8 string. Some
   * "direct" commands (e.g. CAMERA_SWITCH 1035) carry a binary struct, not JSON.
   */
  sendRawLevel2Bytes(payload: Buffer, channel: number, outerCmd: number = CMD_SET_PAYLOAD, signCode = 8): boolean {
    if (!this.connectAddress || !this.level2Key) return false;
    const body = this.encryptLevel2(payload);
    if (!body) return false;
    // Outer command MUST match the family: media=1350 (CMD_SET_PAYLOAD), device control=1700 (the
    // generic JSON control wrapper) — verified by diffing our frame against the app's captured frame.
    // `signCode` is the frame-header sign byte: 8 for the JSON control wrapper, 1 for direct binary
    // commands like CAMERA_SWITCH (matched to the app's captured frames).
    const data = Buffer.concat([
      buildCommandHeader(this.seqNumber, outerCmd),
      buildRawCommandPayload(body, channel, signCode, [0x08, 0x00], 0),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
    return true;
  }

  /** Stop the realtime media stream (`CMD_STOP_REALTIME_MEDIA`, 1004) on a camera `channel`. */
  stopLiveMedia(channel: number = STATION_CHANNEL, accountId = ""): void {
    this.liveStartedChannels.delete(channel);
    for (const [sequence, pending] of this.unackedLiveStarts) {
      if (pending.channel === channel) this.unackedLiveStarts.delete(sequence);
    }
    if (!this.unackedLiveStarts.size && this.liveStartRetransmitTimer) {
      clearInterval(this.liveStartRetransmitTimer);
      this.liveStartRetransmitTimer = undefined;
    }
    if (this.level2Key) {
      this.sendMediaPayloadLevel2(CMD_STOP_REALTIME_MEDIA, channel, accountId, {});
    } else {
      this.sendCommand(CMD_STOP_REALTIME_MEDIA, channel);
    }
  }

  /**
   * Open the device's talkback (host→device audio) path on a camera `channel`, after which
   * {@link sendAudioFrame} is accepted until {@link stopTalkback}. Two protocols, selected by runtime
   * topology exactly as {@link startLiveMedia} selects its own:
   *  - `homeBaseAttached`: the direct `CMD_START_TALKBACK` (1005) frame at level-2, whose entire
   *    plaintext is the camera channel as a `uint32` — a 4-byte body, no envelope and no account id.
   *  - own-session: `CMD_CONTROL_PAYLOAD` (1700) wrapping `{commandType:1001, data:{transaction}}`,
   *    where `transaction` is a millisecond clock the device only echoes.
   *
   * Returns `false` when the HomeBase path is asked for without a negotiated level-2 key. The device
   * replies with the generic 132-byte acknowledgement rather than a talkback-specific result, and the
   * app does not gate its audio on it, so this is fire-and-forget like the other control sends.
   */
  startTalkback(channel: number = STATION_CHANNEL, homeBaseAttached = false): boolean {
    return this.sendTalkbackControl(channel, homeBaseAttached, true);
  }

  /** Close the talkback path opened by {@link startTalkback} — the `1006` / inner-`1002` counterpart. */
  stopTalkback(channel: number = STATION_CHANNEL, homeBaseAttached = false): boolean {
    return this.sendTalkbackControl(channel, homeBaseAttached, false);
  }

  /**
   * The one place the talkback start/stop frame is built, so the topology branch is stated once.
   * The own-session path picks its encryption from the session key rather than from topology — a
   * standalone camera that negotiated a level-2 key sends GCM, one that never did sends ECB — which
   * is the same rule `sendStartLiveOwnSession` follows.
   */
  private sendTalkbackControl(channel: number, homeBaseAttached: boolean, start: boolean): boolean {
    if (!this.connectAddress) return false;
    if (homeBaseAttached) {
      const body = Buffer.allocUnsafe(4);
      body.writeUInt32LE(channel >>> 0, 0);
      return this.sendRawLevel2Bytes(body, channel, start ? CMD_START_TALKBACK : CMD_STOP_TALKBACK, 8);
    }
    const json = JSON.stringify({
      commandType: start ? CMD_START_SPEAK : CMD_END_SPEAK,
      data: { transaction: String(Date.now()) },
    });
    if (this.level2Key) return this.sendRawLevel2(json, channel, CMD_CONTROL_PAYLOAD);
    this.sendStringPayloadCommand(CMD_CONTROL_PAYLOAD, json, channel);
    return true;
  }

  /**
   * Push one **whole ADTS AAC frame** toward the device as `CMD_AUDIO_FRAME` (1301) on the video
   * data-type channel, plaintext (signCode 0) in both topologies — the audio itself is never
   * encrypted, only the start/stop control frames are. The 16-byte header the device expects ahead of
   * the payload is `[uint32 frameLength][uint32 channel][8 zero bytes]`, where `frameLength` repeats
   * the ADTS header's own length field. The trailing 8 bytes were zero across all 418 frames of the
   * 2026-07-31 capture, on three cameras spanning both topologies — the app never populates them.
   *
   * The frames ride their own sequence counter, independent of the control channel's, starting at 0
   * for the session. Fire-and-forget: the device acknowledges the datagram, not the audio.
   */
  sendAudioFrame(channel: number, frame: Buffer): void {
    if (!this.connectAddress) return;
    const header = Buffer.alloc(AUDIO_SEND_HEADER_BYTES);
    header.writeUInt32LE(frame.length, 0);
    header.writeUInt32LE(channel >>> 0, 4);
    const seq = this.videoSeqNumber;
    const data = Buffer.concat([
      buildCommandHeader(seq, CMD_AUDIO_FRAME, P2PDataTypeHeader.VIDEO),
      buildRawCommandPayload(Buffer.concat([header, frame]), channel, 0),
    ]);
    this.videoSeqNumber = (this.videoSeqNumber + 1) & 0xffff;
    const sentAt = Date.now();
    this.unackedAudio.set(seq, { data, firstSentAt: sentAt, sentAt, sends: 1 });
    this.armAudioRetransmit();
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * How many audio frames are awaiting acknowledgement — a health signal, NOT a gate. Pacing must
   * stay at the frame rate no matter how many are outstanding: the device plays a continuous stream,
   * so slowing the feed to wait for acknowledgements starves it faster than any loss does.
   */
  get audioInFlight(): number {
    return this.unackedAudio.size;
  }

  /**
   * Resend audio frames the device has not acknowledged in time, and abandon the ones it never will.
   * Runs only while frames are outstanding.
   *
   * A frame that exhausts {@link AUDIO_MAX_SENDS} emits `audioGap` with its sequence number as it is
   * dropped. The audio channel is ordered, so that hole can stall everything queued behind it; without
   * the event nothing observes it — the map stays bounded because the entry is evicted, so the
   * in-flight count reads healthy while the speaker has gone quiet.
   */
  private armAudioRetransmit(): void {
    if (this.audioRetransmitTimer) return;
    this.audioRetransmitTimer = setInterval(() => {
      const outstanding = this.retransmitUnacked(this.unackedAudio, {
        retransmitMs: AUDIO_RETRANSMIT_MS,
        spent: (held) => held.sends >= AUDIO_MAX_SENDS,
        onAbandoned: (sequence) => {
          if (this.audioStalled) return;
          this.audioStalled = true;
          this.emit("audioGap", sequence);
        },
      });
      if (!outstanding) {
        clearInterval(this.audioRetransmitTimer);
        this.audioRetransmitTimer = undefined;
      }
    }, AUDIO_RETRANSMIT_MS / 2);
  }

  /**
   * One retransmission sweep over an acknowledged channel's retained datagrams: resend those past
   * `retransmitMs` byte-identically, abandon those the caller reports spent, and answer whether any datagram
   * is still outstanding — a caller stops its ticker once nothing is.
   *
   * Both acknowledged directions — outbound audio and the own-session live start — repeat on these terms, so
   * the sweep has one implementation. What "spent" means is the caller's, because the two are bounded by
   * different things: audio by a send count, since repeating it more amplifies the loss it is repairing; a
   * live start by elapsed time, since the sends it needs are however many its acknowledgement latency
   * demands. Datagrams are only ever retained by a send, and a send needs a connect address, so the
   * no-address case has nothing retained to sweep and simply reports idle.
   */
  private retransmitUnacked<T extends RetainedDatagram>(
    retained: Map<number, T>,
    policy: {
      retransmitMs: number;
      spent: (held: T) => boolean;
      onAbandoned: (sequence: number, held: T) => void;
      onResent?: (sequence: number, held: T) => void;
    },
  ): boolean {
    if (!this.connectAddress) return false;
    const now = Date.now();
    for (const [sequence, held] of retained) {
      if (now - held.sentAt < policy.retransmitMs) continue;
      retained.delete(sequence);
      if (policy.spent(held)) {
        policy.onAbandoned(sequence, held);
        continue;
      }
      held.sends++;
      held.sentAt = now;
      retained.set(sequence, held);
      policy.onResent?.(sequence, held);
      this.send(this.connectAddress, RequestMessageType.DATA, held.data);
    }
    return retained.size > 0;
  }

  /**
   * Clear acknowledged live starts and audio frames. The device's acknowledgement lists the sequence numbers it has
   * taken on a given data-type channel: `[dataTypeHeader:2][count:2 BE][seq:2 BE]×count`.
   *
   * DATA acknowledgements release retained own-session starts. The video data-type acknowledgements release
   * outbound talkback frames, whose ordered channel stalls on a gap.
   */
  private onAck(msg: Buffer): void {
    if (msg.length < 8 || msg[4] !== 0xd1) return;
    const count = msg.readUInt16BE(6);
    if (msg[5] === P2PDataType.DATA) {
      for (let i = 0; i < count && 10 + 2 * i <= msg.length; i++) {
        const sequence = msg.readUInt16BE(8 + 2 * i);
        if (this.unackedLiveStarts.delete(sequence)) {
          this.trace({ phase: "media-command-ack", action: "start" });
        }
      }
      if (!this.unackedLiveStarts.size) this.clearLiveStartRetransmit();
      return;
    }
    if (msg[5] !== P2PDataType.VIDEO) return;
    for (let i = 0; i < count && 10 + 2 * i <= msg.length; i++) {
      this.unackedAudio.delete(msg.readUInt16BE(8 + 2 * i));
    }
    if (count > 0) this.audioStalled = false;
  }

  /**
   * Send a CMD_SET_PAYLOAD(1350) wrapping `{account_id, cmd:<subCmd>, mChannel, mValue3:<subCmd>,
   * payload}`, encrypted level-2 (AES-256-GCM, signCode 8) — the app's media-control path. The
   * camera is selected by `mChannel` (= the device's `device_channel`) AND the frame-header channel.
   */
  private sendMediaPayloadLevel2(
    subCmd: number,
    channel: number,
    accountId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.connectAddress || !this.level2Key) {
      this.trace({
        phase: "media-command-unsent",
        reason: this.connectAddress ? "level2-key" : "address",
      });
      return;
    }
    const isStart = subCmd === CMD_START_REALTIME_MEDIA;
    // HomeBase-controlled camera path (the V6 app's media-start envelope): mChannel = device_channel,
    // an extra accountId inside payload, an RSA public modulus for the media-key handshake, and the
    // camera is ALSO selected by the FRAME-HEADER channel below.
    const innerPayload = isStart
      ? {
          ClientOS: "Android",
          accountId,
          camera_type: 0,
          entrytype: 0,
          key: this.rsaModulus(),
          streamtype: 1,
          ...payload,
        }
      : payload;
    const value = JSON.stringify({
      account_id: accountId,
      cmd: subCmd,
      mChannel: channel,
      mValue3: subCmd,
      payload: innerPayload,
    });
    const body = this.encryptLevel2(Buffer.from(value, "utf-8"));
    if (!body) return;
    // v6.0.41 level-2 media frame header: magic byte 0x08 (NOT the legacy 0x01), and a per-stream
    // slot id at the "type" byte (channel 0 = slot 0; other cameras get an incrementing slot).
    const streamId = channel === STATION_CHANNEL || channel === 0 ? 0 : 0x0a + (this.level2Seq & 0x7f);
    const data = Buffer.concat([
      buildCommandHeader(this.seqNumber, CMD_SET_PAYLOAD),
      buildRawCommandPayload(body, channel, 8, [0x08, 0x00], streamId),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * Encrypt a level-2 command body (signCode 8): `tag(16) ‖ nonce(12) ‖ [seq,03,02,01](4) ‖
   * ciphertext`, AES-256-GCM under the negotiated session key, AAD "eufy security". Inverse of
   * `decryptLevel2`. The 4-byte sub-header is cleartext (skipped on decrypt); `seq` is a counter.
   */
  /**
   * Decode a `CMD_VIDEO_FRAME` (1300) payload into clean Annex-B H.264 (the 22-byte frame header
   * stripped). Reversed from the V6 app + live H.264 captures: the 22-byte header is
   * `[0:4]len [4]keyframe [5]streamType [6:8]seq [8:10]fps [10:12]W [12:14]H [14:20]ts`. When the
   * frame is encrypted (`signCode > 0` and len ≥ 128) the bytes `[22:150]` are the RSA-wrapped AES
   * media key (decrypt with our private key, PKCS#1 v1.5 → AES key) and the video starts at offset
   * 151 with its **first 128 bytes AES-ECB(NoPadding)-encrypted**; the rest is cleartext. Plaintext
   * frames are just `[22 : 22+len]`. Returns undefined if the RSA key is missing/undecryptable.
   */
  decodeVideoFrame(data: Buffer, signCode: number): Buffer | undefined {
    if (data.length < 22) return undefined;
    const videoDataLength = data.readUInt32LE(0);
    let payloadStart = 22;
    let aesKey: Buffer | undefined;
    if (signCode > 0 && videoDataLength >= 128) {
      if (!this.rsaPrivateKey || data.length < 150) return undefined;
      aesKey = this.rsaUnwrapKey(data.subarray(22, 150));
      if (!aesKey) return undefined; // wrong/missing key → discard (whole stream is undecryptable)
      payloadStart = 151;
    }
    if (aesKey && aesKey.length >= 16) {
      const enc = data.subarray(payloadStart, payloadStart + 128);
      const tail = data.subarray(payloadStart + 128, payloadStart + videoDataLength);
      try {
        const use256 = aesKey.length >= 32;
        const d = createDecipheriv(use256 ? "aes-256-ecb" : "aes-128-ecb", aesKey.subarray(0, use256 ? 32 : 16), null);
        d.setAutoPadding(false);
        return Buffer.concat([d.update(enc), d.final(), tail]);
      } catch {
        return undefined;
      }
    }
    return data.subarray(payloadStart, payloadStart + videoDataLength);
  }

  /**
   * Unwrap the RSA-wrapped AES media key from a keyframe. Standard PKCS#1 v1.5 — decrypt with
   * `RSA_PKCS1_PADDING`. This needs Node ≥24.5 (OpenSSL 3.5.1), which re-enabled PKCS1 `privateDecrypt`
   * after the intermediate OpenSSL (3.2–3.4) disabled it as a Marvin/CVE-2023-46809 mitigation — hence
   * the pinned engine. Verified live: the strict path unwraps the 16-byte key on real E2E cameras
   * (T8171 2560×1440, T8210 640×480). Returns `undefined` on failure (frame is skipped).
   */
  private rsaUnwrapKey(wrapped: Buffer): Buffer | undefined {
    if (!this.rsaPrivateKey) return undefined;
    try {
      return privateDecrypt({ key: this.rsaPrivateKey, padding: constants.RSA_PKCS1_PADDING }, wrapped);
    } catch {
      return undefined;
    }
  }

  /**
   * The RSA-1024 public-key modulus (128-byte hex) the station uses to wrap the per-stream media
   * key. Lazily generates a keypair; `rsaPrivateKey` decrypts the media key the station returns.
   */
  private rsaModulus(): string {
    if (!this.rsaModulusHex) {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
      this.rsaPrivateKey = privateKey;
      const jwk = publicKey.export({ format: "jwk" }) as { n: string };
      this.rsaModulusHex = Buffer.from(jwk.n, "base64url").toString("hex");
    }
    return this.rsaModulusHex;
  }

  private encryptLevel2(plaintext: Buffer): Buffer | undefined {
    if (!this.level2Key) return undefined;
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.level2Key, nonce);
    c.setAAD(GCM_AAD);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    const sub = Buffer.from([this.level2Seq & 0xff, 0x03, 0x02, 0x01]);
    this.level2Seq = (this.level2Seq + 1) & 0xff;
    return Buffer.concat([c.getAuthTag(), nonce, sub, ct]);
  }

  /** Send a no-arg command frame (e.g. CMD_GATEWAYINFO) on a channel (default: the station channel). */
  private sendCommand(commandType: number, channel: number = STATION_CHANNEL): void {
    if (!this.connectAddress) return;
    const data = Buffer.concat([buildCommandHeader(this.seqNumber, commandType), buildVoidCommandPayload(channel)]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.send(this.connectAddress, RequestMessageType.DATA, data);
  }

  /**
   * Request a stored image (event thumbnail / cover) over P2P. Sends a
   * `CMD_SET_PAYLOAD` wrapping `{cmd: CMD_DATABASE_IMAGE, payload:[{file}]}` — the
   * station replies with a `CMD_DATABASE_IMAGE` frame that this session decodes and
   * emits as an `image` event `{ file, data }` (P2P images come back as plain JPEG,
   * no v1/v2 obfuscation). `filePath` is the on-station path from a push payload
   * (`pic_filepath`/`file_path`/`cover_path`). `accountId` is the admin user id when
   * known (some firmware ignores it). NOTE: needs live-device validation — the
   * control-command send path is exercised here for the first time.
   */
  requestImage(filePath: string, opts: { accountId?: string; channel?: number } = {}): void {
    if (!this.connectAddress) throw new Error("not connected");
    const channel = opts.channel ?? 0;
    const value = JSON.stringify({
      account_id: opts.accountId ?? "",
      cmd: CMD_DATABASE_IMAGE,
      mChannel: channel,
      payload: [{ file: filePath }],
      transaction: filePath,
    });
    const body = Buffer.concat([
      buildCommandHeader(this.seqNumber, CMD_SET_PAYLOAD),
      buildStringCommandPayload(value, channel, this.level1Key, 1),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.logger.debug(`[p2p] ${this.cfg.stationSn} requestImage ${filePath}`);
    this.send(this.connectAddress, RequestMessageType.DATA, body);
  }

  /**
   * Query an on-station database table over P2P (edge-AI face DB, event records, …).
   * Sends `CMD_SET_PAYLOAD{cmd:CMD_DATABASE, payload:{cmd:DB_QUERY.FULL_TABLE, table}}`.
   * The HomeBase streams back `CMD_DATABASE` (1306) frames `{cmd:10000,count,data:[…]}`,
   * level-1-encrypted — decoded and emitted as `dbChunk` (decrypted text) per frame.
   * Tables: `familiar_faces`, `person_basic_info`, `event_person_list`, `history_record_info`.
   */
  queryDatabase(
    table: string,
    opts: { accountId?: string; channel?: number; query?: Record<string, unknown>; innerCmd?: number } = {},
  ): void {
    if (!this.connectAddress) throw new Error("not connected");
    // The eufy app issues this on mChannel 255 (the station channel), not 0.
    const channel = opts.channel ?? STATION_CHANNEL;
    // Exact app structure (reversed by GCM-decrypting the app's own request):
    //   { account_id, cmd:1306, mChannel, mValue3:0,
    //     payload:{ table, cmd:<innerCmd>, payload:{…query…}, transaction } }
    // i.e. the query params are NESTED under a second `payload`, not flattened.
    const inner: Record<string, unknown> = { cmd: opts.innerCmd ?? DB_QUERY.FULL_TABLE };
    if (table) inner.table = table;
    if (opts.query) inner.payload = opts.query;
    inner.transaction = `${Date.now()}`;
    const value = JSON.stringify({
      account_id: opts.accountId ?? "",
      cmd: CMD_DATABASE,
      mChannel: channel,
      mValue3: 0,
      payload: inner,
    });
    const body = Buffer.concat([
      buildCommandHeader(this.seqNumber, CMD_SET_PAYLOAD),
      buildStringCommandPayload(value, channel, this.level1Key, 1),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.logger.debug(`[p2p] ${this.cfg.stationSn} queryDatabase ${table} ch=${channel}`);
    this.send(this.connectAddress, RequestMessageType.DATA, body);
  }

  /**
   * Standard "give me the whole table" query params the eufy app uses for a direct
   * `CMD_DATABASE` read (inner `cmd 10000`). `count` bounds the row count.
   */
  private fullTableQuery(count = 2000): Record<string, unknown> {
    return {
      count,
      start_date: "",
      end_date: "",
      start_id: 0,
      end_id: 1,
      flag: 0,
      need_ai: 1,
      res_unzip: 1,
      update_time: "0",
      start_time: "0",
      alarm_id: "",
    };
  }

  /**
   * Request the on-device edge-AI **face roster** over P2P — the phone-free path.
   *
   * NOT a dedicated face command (the `1194`/`1195` path never responds on a HomeBase). The
   * app reads the DB directly: a `CMD_DATABASE` (1306) query of `person_basic_info` with inner
   * `cmd 10000` on `mChannel 255`. The HomeBase replies with the level-1 `CMD_DATABASE` response
   * (reassembled by `onData`, surfaced via `dbChunk`) listing every person: `{person_id, name,
   * relation, group_id, …}` — `stranger\d+` names are auto-assigned (unfamiliar). ~10 KB.
   * Verified live against the app's own decrypted request. `account_id` must be the station
   * `admin_user_id` (a wrong/absent id or a camera session answers result `-104`).
   */
  requestFaces(opts: { accountId?: string; channel?: number } = {}): void {
    this.queryDatabase("person_basic_info", {
      accountId: opts.accountId,
      channel: opts.channel,
      innerCmd: DB_QUERY.FULL_TABLE,
      query: this.fullTableQuery(),
    });
  }

  /**
   * Request the **face feature rows** over P2P (`face_feature_info`, inner `cmd 10000`). Each row
   * carries `{person_id, face_name, face_id, face_picture_content, face_feature_file_path}` — where
   * `face_picture_content` is the on-station **path** to that person's enrolled face JPEG (fetch it
   * with `requestImage()` → plain JPEG via the `image` event). Surfaced via `dbChunk`.
   */
  requestFaceFeatures(opts: { accountId?: string; channel?: number } = {}): void {
    this.queryDatabase("face_feature_info", {
      accountId: opts.accountId,
      channel: opts.channel,
      innerCmd: DB_QUERY.FULL_TABLE,
      query: this.fullTableQuery(),
    });
  }

  /**
   * Low-level: send a `CMD_SET_PAYLOAD` (1350) wrapping `{account_id, cmd:<subCmd>, mChannel,
   * payload, transaction}` over the level-1 channel. The reply arrives as a `NOTIFY_PAYLOAD`
   * (1351) frame (level-1 decrypted, surfaced via the `data` event / `frame.json`).
   */
  sendSetPayload(
    subCmd: number,
    payload: unknown = {},
    opts: {
      accountId?: string;
      channel?: number;
      omitPayload?: boolean;
      wrapCmd?: number;
      rawValue?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.connectAddress) throw new Error("not connected");
    const channel = opts.channel ?? 0;
    // CMD_SET_PAYLOAD wrapper (reversed from the v6 serializer): inner `cmd` = subCmd,
    // plus mChannel + mValue3:0; the payload object carries any params ({} when none).
    // No `transaction` field in the SET_PAYLOAD value. `rawValue` overrides for testing.
    const inner: Record<string, unknown> = opts.rawValue ?? {
      account_id: opts.accountId ?? "",
      cmd: subCmd,
      mChannel: channel,
      mValue3: 0,
      ...(opts.omitPayload ? {} : { payload }),
    };
    const value = JSON.stringify(inner);
    const body = Buffer.concat([
      buildCommandHeader(this.seqNumber, opts.wrapCmd ?? CMD_SET_PAYLOAD),
      buildStringCommandPayload(value, channel, this.level1Key, 1),
    ]);
    this.seqNumber = (this.seqNumber + 1) & 0xffff;
    this.logger.debug(`[p2p] ${this.cfg.stationSn} sendSetPayload subCmd=${subCmd}`);
    this.send(this.connectAddress, RequestMessageType.DATA, body);
  }

  /**
   * Request the on-device edge-AI face roster over P2P. `COMMAND_GET_LOCAL_FACES` (1194) =
   * familiar/enrolled people; `COMMAND_GET_LOCAL_CANDIDATE_FACES` (1195) = strangers. The
   * HomeBase replies with a `NOTIFY_PAYLOAD` (1351) frame carrying the JSON roster (reassembled
   * + level-1 decrypted; listen on the `data` event for commandId 1351).
   */
  requestLocalFaces(opts: { candidate?: boolean; accountId?: string; channel?: number } = {}): void {
    this.sendSetPayload(opts.candidate ? 1195 : 1194, {}, opts);
  }

  /**
   * Acknowledge and reassemble one DATA datagram, sequenced independently per data type.
   *
   * The device numbers each data type's datagrams in its own 16-bit space and repeats what it thinks was
   * lost. A repeat of something already delivered is acknowledged, then ignored. Distance is measured
   * modulo the sequence space and read as backwards beyond {@link SEQUENCE_LOOKBACK}, which is what lets the
   * numbering wrap without the next datagram looking like a jump of nearly a full space.
   *
   * A datagram numbered further back than {@link STALE_RETRANSMIT_DEPTH} is not a repeat the device could
   * still be making: the numbering itself has restarted, which a device does when it begins a fresh stream
   * on a connection that is already up. That resynchronizes — the high-water mark moves to the restarted
   * numbering and the half-assembled frame goes — because ignoring it would freeze the mark, and every
   * datagram of the new numbering would then be read as behind it too, for as long as it took to climb back.
   *
   * A forward gap means a datagram has not arrived YET, which is not the same as lost. The device repeats
   * unacknowledged datagrams, so successors are held for a bounded wait and delivered strictly in sequence
   * if the missing one arrives. A logical frame's payload spans datagrams that carry no header of their
   * own, so reassembling around a hole is impossible; waiting for it is what keeps the frame whole.
   *
   * Only once {@link REORDER_WAIT_MS} passes, or {@link REORDER_MAX_DATAGRAMS} pile up, is the datagram
   * treated as lost: a pending frame is discarded and delivery resumes from the earliest held datagram.
   */
  private onData(msg: Buffer, addr: Address): void {
    const dataTypeBuffer = msg.subarray(4, 6);
    const seqNo = msg.subarray(6, 8).readUInt16BE();
    const dataType = dataTypeBuffer[1]; // 0=DATA 1=VIDEO 2=CONTROL 3=BINARY
    this.send(addr, RequestMessageType.ACK, buildAckPayload(this.ackTypeHeader(dataType), seqNo));

    const prevSeq = this.lastSeqByType.get(dataType);
    const advance = prevSeq === undefined ? 1 : (seqNo - prevSeq) & 0xffff;
    if (advance === 0) return;
    if (advance > SEQUENCE_LOOKBACK) {
      if (0x10000 - advance <= STALE_RETRANSMIT_DEPTH) return;
      if (this.pendingByDataType.has(dataType) && this.tracedDatagramGaps++ < MAX_TRACED_DATAGRAM_GAPS)
        this.trace({ phase: "sequence-restart", dataType });
      this.clearReorderTimer(dataType);
      this.reorderByType.delete(dataType);
      this.pendingByDataType.delete(dataType);
      this.lastSeqByType.set(dataType, seqNo);
      this.reassemble(dataType, msg.subarray(8));
      return;
    }
    if (advance === 1) {
      this.lastSeqByType.set(dataType, seqNo);
      this.reassemble(dataType, msg.subarray(8));
      this.drainReorder(dataType);
      return;
    }
    this.holdForRetransmit(dataType, seqNo, msg.subarray(8));
  }

  /** Hold a datagram that arrived past a hole, and arm the wait for the missing one to be repeated. */
  private holdForRetransmit(dataType: number, seqNo: number, body: Buffer): void {
    let reorder = this.reorderByType.get(dataType);
    if (!reorder) {
      reorder = { held: new Map<number, Buffer>() };
      this.reorderByType.set(dataType, reorder);
    }
    if (!reorder.held.has(seqNo)) reorder.held.set(seqNo, body);
    if (reorder.held.size > REORDER_MAX_DATAGRAMS) {
      this.abandonHole(dataType);
      return;
    }
    this.armReorderTimer(dataType);
  }

  /** Start a full wait for the current hole, leaving an existing wait undisturbed. */
  private armReorderTimer(dataType: number): void {
    const reorder = this.reorderByType.get(dataType);
    if (!reorder?.held.size || reorder.timer) return;
    const timer = setTimeout(() => {
      reorder.timer = undefined;
      this.abandonHole(dataType);
    }, REORDER_WAIT_MS);
    timer.unref?.();
    reorder.timer = timer;
  }

  /** Deliver held datagrams that now follow directly on from the last one delivered. */
  private drainReorder(dataType: number): void {
    const reorder = this.reorderByType.get(dataType);
    if (!reorder?.held.size) return;
    this.clearReorderTimer(dataType);
    for (;;) {
      const next = (this.lastSeqByType.get(dataType)! + 1) & 0xffff;
      const body = reorder.held.get(next);
      if (body === undefined) break;
      reorder.held.delete(next);
      this.lastSeqByType.set(dataType, next);
      this.reassemble(dataType, body);
    }
    if (reorder.held.size) this.armReorderTimer(dataType);
    else this.reorderByType.delete(dataType);
  }

  /**
   * The missing datagram was not repeated in time: report the gap, drop the frame it belonged to, and
   * resume from the earliest datagram still held so the stream keeps moving.
   */
  private abandonHole(dataType: number): void {
    const held = this.reorderByType.get(dataType)!.held;
    if (this.pendingByDataType.has(dataType) && this.tracedDatagramGaps++ < MAX_TRACED_DATAGRAM_GAPS)
      this.trace({ phase: "datagram-gap", dataType });
    this.pendingByDataType.delete(dataType);
    const last = this.lastSeqByType.get(dataType)!;
    const earliest = [...held.keys()].sort((a, b) => ((a - last) & 0xffff) - ((b - last) & 0xffff))[0];
    this.lastSeqByType.set(dataType, (earliest - 1) & 0xffff);
    this.drainReorder(dataType);
  }

  private clearReorderTimer(dataType: number): void {
    const reorder = this.reorderByType.get(dataType);
    if (!reorder?.timer) return;
    clearTimeout(reorder.timer);
    reorder.timer = undefined;
  }

  /** Reassemble one in-sequence datagram body into logical frames. */
  private reassemble(dataType: number, datagramBody: Buffer): void {
    const pending = this.pendingByDataType.get(dataType);
    let body = pending ? Buffer.concat([pending.buf, datagramBody]) : datagramBody;
    const carryHeader = pending?.header;
    this.pendingByDataType.delete(dataType);

    if (carryHeader) {
      // continuing a frame: we have header already; body is the accumulated payload
      if (body.length < carryHeader.bytesToRead) {
        this.pendingByDataType.set(dataType, { header: carryHeader, buf: body });
        return;
      }
      this.handleFrame(carryHeader, body.subarray(0, carryHeader.bytesToRead), dataType);
      body = body.subarray(carryHeader.bytesToRead);
    }

    while (body.length >= P2P_DATA_HEADER_BYTES && body.subarray(0, 4).toString() === MAGIC_WORD) {
      const header = parseDataFrameHeader(body);
      const payload = body.subarray(P2P_DATA_HEADER_BYTES);
      if (payload.length < header.bytesToRead) {
        // frame spans into following datagram(s) — stash and wait
        this.pendingByDataType.set(dataType, { header, buf: payload });
        return;
      }
      this.handleFrame(header, payload.subarray(0, header.bytesToRead), dataType);
      body = body.subarray(P2P_DATA_HEADER_BYTES + header.bytesToRead);
    }
  }

  /**
   * Forget where each data type's sequence numbering had reached, and drop any half-reassembled frame.
   *
   * A device numbers datagrams per connection and starts over on the next one, so carrying the previous
   * connection's high-water mark across would make the new connection's first datagrams look like
   * retransmissions from behind and drop them all. Half a frame from a connection that is gone can never be
   * completed either.
   */
  private resetInboundSequencing(): void {
    for (const dataType of this.reorderByType.keys()) this.clearReorderTimer(dataType);
    this.reorderByType.clear();
    this.lastSeqByType.clear();
    this.pendingByDataType.clear();
    this.tracedDatagramGaps = 0;
  }

  private ackTypeHeader(dataType: number): Buffer {
    switch (dataType) {
      case P2PDataType.VIDEO:
        return P2PDataTypeHeader.VIDEO;
      case P2PDataType.CONTROL:
        return P2PDataTypeHeader.CONTROL;
      case P2PDataType.BINARY:
        return P2PDataTypeHeader.BINARY;
      default:
        return P2PDataTypeHeader.DATA;
    }
  }

  private handleFrame(header: P2PDataFrameHeader, payload: Buffer, dataType: number): void {
    let data = payload;
    // Media frames (video 1300 / audio 1301) are NOT level-1/2 control frames — their bodies use the
    // per-frame video cipher (RSA-wrapped AES, see decodeVideoFrame) or are plaintext. Leave them raw
    // so the generic control decrypt below doesn't corrupt them; LiveStream decodes video via
    // decodeVideoFrame and strips the audio header itself.
    const isMedia = header.commandId === CMD_VIDEO_FRAME || header.commandId === CMD_AUDIO_FRAME;
    // signCode 2/8 → level-2 gateway frame (AES-256-GCM, negotiated key). Try that first
    // when a level-2 key is set; otherwise fall through to the level-1 path.
    if (isMedia) {
      /* leave raw */
    } else if ((header.signCode === 2 || header.signCode === 8) && this.level2Key) {
      const dec = this.decryptLevel2(payload, header.signCode);
      if (dec) data = dec;
    } else if (header.signCode > 0 && data.length > 0 && data.length % 16 === 0) {
      // signCode 1 → AES-128-ECB with the derivable Level-1 key (control notifications,
      // and many DATA notifications).
      try {
        data = decryptP2PData(data, this.level1Key);
      } catch {
        /* leave as-is; emit raw */
      }
    }
    // The CMD_GATEWAYINFO (1100) reply carries the ECIES envelope for the level-2 session
    // key. If a cipher-key resolver is configured, negotiate the key once (async, fire-and-forget).
    if (
      header.commandId === CMD_GATEWAYINFO &&
      header.signCode === 1 &&
      !this.level2Key &&
      !this.level2Negotiating &&
      this.cfg.resolveCipherKey
    ) {
      this.negotiateLevel2Key(data);
    }
    // CMD_DATABASE (1306) reply chunks are level-1 encrypted but NOT 16-aligned
    // (a trailing byte past the block boundary), so decrypt the block-aligned head
    // and emit the JSON-ish text fragment for the caller to accumulate/parse.
    if (header.commandId === CMD_DATABASE && header.signCode > 0) {
      const n = payload.length - (payload.length % 16);
      if (n >= 16) {
        try {
          const txt = decryptP2PData(payload.subarray(0, n), this.level1Key).toString("latin1");
          this.emit("dbChunk", { stationSn: this.cfg.stationSn, text: txt });
        } catch {
          /* ignore */
        }
      }
    }
    const frame: P2PFrame = {
      ...header,
      stationSn: this.cfg.stationSn,
      commandName: commandName(header.commandId),
      dataType,
      data,
      raw: payload,
    };
    // CMD_NOTIFY_PAYLOAD-style frames carry a NUL-terminated JSON document.
    const text = readNullTerminatedString(data);
    if (text.startsWith("{")) {
      try {
        frame.json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const reported =
        header.commandId === CMD_NOTIFY_PAYLOAD
          ? paramReport(frame.json?.payload)
          : header.commandId === CMD_CAMERA_INFO
            ? paramReport(frame.json)
            : undefined;
      if (reported) frame.params = reported;
    }
    // CMD_NAS_SWITCH (1145) is the RTSP publish switch, but the station also pushes it BACK as a data
    // frame whose string payload is the camera's full authoritative rtsp://user:pass@ip/path — the
    // credentials it enforces right now, regenerated on every publish toggle (the cloud record lags a
    // cycle). A host adopting a running stream reads the URL from here; the command router provokes it.
    if (header.commandId === CommandType.CMD_NAS_SWITCH && text.startsWith("rtsp://")) {
      this.emit("rtspUrl", { channel: header.channel, url: text });
    }
    // CMD_DATABASE_IMAGE reply: { file, content:<base64 image> } → emit decoded bytes.
    if (header.commandId === CMD_DATABASE_IMAGE && frame.json && typeof frame.json.content === "string") {
      try {
        this.emit("image", { file: frame.json.file ?? "", data: Buffer.from(frame.json.content, "base64") });
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }
    // A reply whose whole body is a four-byte int32 LE is the result of the command just sent —
    // negative is a failure (-104 file not found, -108 refused). Reading only CMD_SET_PAYLOAD
    // discarded the answer to every other write, so a clean rejection reached a caller as silence and
    // was indistinguishable from a command the station never replied to at all.
    //
    // The shape identifies it, not the command id. Both wrappers answer this way, and so does a
    // direct outer command that is no wrapper at all — 1246 replies with four bytes exactly as 1700
    // does, and a direct-binary switch is the write with the least other confirmation to fall back
    // on. An allowlist of wrappers would keep those silent.
    //
    // The body must be exactly four bytes, not merely long enough: on the wire a control reply is a
    // 36-byte sign-8 frame carrying four bytes of plaintext, measured across two captures. A frame
    // the decrypt above could not open stays ciphertext — the level-1 path needs 16-byte alignment
    // and the level-2 path can decline — and ciphertext is neither JSON nor four bytes, so a length
    // test alone would read its first word and report a fabricated code for a command whose answer
    // was never recovered. Media is excluded because its bodies are never control plaintext.
    if (!isMedia && !frame.json && data.length === 4) {
      this.emit("commandResult", { code: data.readInt32LE(0), channel: header.channel });
    }
    this.emit("data", frame);
  }

  private send(addr: Address, type: Buffer, payload?: Buffer, socket = this.socket): void {
    if (!socket) return;
    const packet = frameMessage(type, payload);
    socket.send(packet, addr.port, addr.host, (err) => {
      if (err) this.logger.warn(`[p2p] send err ${addr.host}:${addr.port}`, err.message);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopPunchProbes();
    this.connectionGeneration += 1;
    this.level2Key = undefined;
    this.level2Seq = 0;
    this.settleLevel2("closed");
    this.connected = false;
    this.connecting = false;
    if (this.lookupTimer) clearInterval(this.lookupTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.audioRetransmitTimer) clearInterval(this.audioRetransmitTimer);
    this.audioRetransmitTimer = undefined;
    this.unackedAudio.clear();
    this.audioStalled = false;
    if (this.liveStartRetransmitTimer) clearInterval(this.liveStartRetransmitTimer);
    this.liveStartRetransmitTimer = undefined;
    this.unackedLiveStarts.clear();
    this.resetInboundSequencing();
    if (this.connectAddress) this.send(this.connectAddress, RequestMessageType.END);
    await new Promise<void>((resolve) => {
      if (!this.socket) return resolve();
      this.socket.close(() => resolve());
    });
    this.socket = undefined;
    this.emit("close");
  }
}
