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
import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import {
  constants,
  createECDH,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
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
  buildRelayPacketPayload,
  buildRelayRequestPayload,
  buildRawCommandPayload,
  intStringCommandBody,
  stringPairCommandBody,
  buildVoidCommandPayload,
  decryptP2PData,
  encryptP2PData,
  paddingP2PData,
  deriveLevel2KeyFromGatewayInfo,
  deriveLevel2KeyFromRsaGatewayInfo,
  frameMessage,
  gatewayInfoRefused,
  gcmOpen,
  gcmSeal,
  hasHeader,
  p2pCommandEncryptionKey,
  parseDataFrameHeader,
  p2pDidToBuffer,
  parseLookupAddr,
  parseRelayList,
  parseRelayPortAck,
  parseRelayTo,
  readNullTerminatedString,
} from "./codec.js";
import { commandName, CommandType } from "./commands.js";
import { renderFrame, setPayloadJson } from "./write-commands.js";
import { traceLiveStart, type LiveTrace } from "./live-trace.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { CMD_DATABASE, CMD_DATABASE_IMAGE, DB_QUERY, DB_TABLE_TIMEOUT_MS, fullTableQuery } from "./database-wire.js";
import { StationUnreachableError, type SessionFrame } from "../../core/contracts.js";

const LOCAL_LOOKUP_PORT = 32108;
/**
 * The app's CS2 alive (`cs2p2p_PPPP_thread_recv_DRW`): an ALIVE after each 999 ms that nothing arrived from the peer,
 * and the session closed as timed out once more than {@link ALIVE_MISSES} go unanswered; anything received resets it.
 */
const ALIVE_MS = 1_000;
/** The miss limit `cs2p2p_PPPP_Initialize` sets for a plain init string. */
const ALIVE_MISSES = 6;
const LOOKUP_RETRY_MS = 1_000;
/**
 * Lookup rounds a connect counts, from the lookup server's acknowledgement of its P2P request, before it
 * also asks for a relayed path.
 *
 * The vendor client's own threshold for the mode its app connects remote stations in: its round counter
 * starts at 1 on the first one-second round after a P2P_REQ_ACK with result 0, steps once a round, and the
 * relay handshake begins once it exceeds this. A connect whose request is never acknowledged, as for a
 * device that is offline, never asks for a relay.
 */
const RELAY_AFTER_ACKED_ROUNDS = 24;
/** RLY_PKT copies sent per RLY_TO, as the vendor client sends them. */
const RELAY_PACKET_COPIES = 4;
/**
 * The receive buffer a session's socket asks the OS for.
 *
 * A station sends a keyframe as one burst, up to 161 video datagrams of 1074 bytes within 10 ms. The Linux
 * default buffer of 212992 bytes drops part of such a burst before the socket is read, and the frames those
 * datagrams belong to arrive incomplete. 4 MiB queues many
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
 *
 * The relay handshake starts once the lookup server has acknowledged the P2P request for 24 lookup rounds, so
 * about 25 s in. The vendor app's own remote connect has a 30 s budget, which leaves the handshake 3–6 s.
 * Forty-five seconds keeps the vendor's threshold and gives the handshake about 20 s to complete. A station that
 * never acknowledges the request, as an offline one does, takes this long to fail.
 */
export const CONNECT_TIMEOUT_MS = 45_000;
/**
 * The channel a command addresses the station itself on, rather than one of its cameras, and the value a
 * session's channel-taking methods resolve an omitted channel to.
 */
export const STATION_CHANNEL = 255;
/**
 * CMD_GATEWAYINFO — sent header-only on connect to prompt the station to start reporting. The reply carries the
 * level-2 key envelope in one layout under either seal: level-1 encrypted (signCode 1) or in the clear
 * (signCode 0).
 */
const CMD_GATEWAYINFO = 1100;
/** The app's station ping: header only, on 0xff, never sealed, through the command sender (`zx_p2p_send_command`). */
const CMD_PING = 1139;
/**
 * The app's notify reader checks, after a channel-2 frame and at most once per this many ms, whether the slot holds a
 * key, and sends the header-only `CMD_GATEWAYINFO` again on every third check that finds none.
 */
const GATEWAY_CHECK_MS = 1_000;
const CMD_VIDEO_FRAME = 1300;
const CMD_AUDIO_FRAME = 1301;
/** Bytes of header the device expects ahead of each outbound audio frame — see {@link P2PSession.sendAudioFrame}. */
const AUDIO_SEND_HEADER_BYTES = 16;
/**
 * The outbound audio channel is **reliable and ordered**, unlike the ordinary control path.
 * The device acknowledges each frame and stalls on a gap: one lost datagram blocks every later frame
 * behind it, so playback stops dead rather than glitching. In the app's own talkback the device's
 * acknowledgements take up to 660 ms, and the app keeps at most 7 frames unacknowledged at once.
 *
 * Recovery mirrors that: a frame still unacknowledged after {@link AUDIO_RETRANSMIT_MS} is
 * sent **once** more and then forgotten. Three properties are load-bearing:
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
 * The DRW resend tick: `thread_recv_DRW` requeues the head of each channel's unacked queue once `time()` has
 * moved 2 s past its last mark. No give-up count for an unacknowledged index is known; a closed session drops
 * what it retained.
 */
const DRW_RESEND_MS = 2000;
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
 * In the app's own traffic the deepest repeat arrives about 120 numbers behind the high-water mark, so this
 * bound sits an order of magnitude
 * clear of a genuine repeat. The bound is what the classification needs to exist at all, because the two
 * misreadings cost differently: a repeat mistaken for a restart discards one logical frame, while a restart
 * mistaken for a repeat discards every datagram until the new numbering climbs back past the frozen mark —
 * so the depth is what caps that second cost, at a bounded run of datagrams instead of half the space.
 */
const STALE_RETRANSMIT_DEPTH = 1024;

/**
 * The lookup servers with each hostname resolved once to an IPv4 address. IPs pass through; a hostname that
 * does not resolve is dropped.
 */
async function resolveLookupServers(addresses: Address[]): Promise<Address[]> {
  const resolved = await Promise.all(
    addresses.map(async (addr) => {
      if (isIP(addr.host)) return addr;
      try {
        const [host] = await resolve4(addr.host);
        return host ? { host, port: addr.port } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return resolved.filter((addr): addr is Address => addr !== undefined);
}

/** Additional UDP source ports registered alongside the session's own during cloud lookup. */
const PUNCH_PROBE_SOCKETS = 7;
/** Chosen maximum wait for a missing datagram; 250 ms is not a measured device resend delay. */
const REORDER_WAIT_MS = 250;
/** Maximum wait for a missing video datagram. */
const VIDEO_REORDER_WAIT_MS = 700;
/** Maximum later datagrams held behind a hole, bounding retained memory and the delay before resuming. */
const REORDER_MAX_DATAGRAMS = 128;
/**
 * Datagram gaps traced per live start. A lossy channel can drop hundreds of datagrams in one start, and the
 * first few establish the pattern; the rest would only flood a host's log, so the trace stops there while
 * reassembly carries on unchanged.
 *
 * The budget is re-armed where a media start is sent ({@link P2PSession.sendFrame}).
 */
const MAX_TRACED_DATAGRAM_GAPS = 8;
/**
 * A datagram retained for retransmission until the device acknowledges its sequence number: the exact bytes
 * that were sent, when they last went out, and how many times they have been sent.
 */
interface RetainedDatagram {
  data: Buffer;
  sentAt: number;
  sends: number;
}
/** CMD_SET_PAYLOAD (1350) wraps a JSON command; CMD_DATABASE_IMAGE (1308) is the image reply. */
const CMD_SET_PAYLOAD = 1350;
/** CMD_NOTIFY_PAYLOAD (1351) — the station's unsolicited JSON notification. */
const CMD_NOTIFY_PAYLOAD = 1351;
/** The longest command answer whose body the app's `zx_p2p_get_exec_result` reads a code from. */
const RESULT_BODY_MAX = 132;
/**
 * CMD_CAMERA_INFO — params as a root-level array. On a camera's channel it is that camera's OWN report; on
 * {@link STATION_CHANNEL} a HomeBase answers with its whole table, every entry's `dev_type` naming the
 * channel it belongs to.
 */
const CMD_CAMERA_INFO = 1103;

/** Serial prefixes the app's native `isStation` names: such a session takes the level-1 key at sign mode <= 0. */
const LEVEL1_AT_SIGN0_PREFIXES = ["T8001", "T8002", "T8010", "T8030", "T8021", "T8025"];

/** The app's sender re-reads sign mode 0 every 50 ms, 29 times, before it gives up and marks the slot -1. */
const SIGN0_POLL_MS = 50;
const SIGN0_POLLS = 29;

/** Commands the app's sender frames on header channel 0xff whatever channel they address. */
const STATION_HEADER_COMMANDS = new Set([1001, 1002, 1054, 1060, CMD_PING]);

/**
 * The header byte-14 counter some frames carry, cycling 10..251: one byte for the whole native library, shared by
 * every session — see {@link P2PSession.headerCounter}.
 */
let headerCounterByte = 0;

/** The `cmd` of a 1350 body's JSON, as the app's sender reads it to pick the seal; `undefined` for any other body. */
function jsonCmdOf(body: Buffer): number | undefined {
  try {
    const cmd = (JSON.parse(body.toString("utf-8")) as { cmd?: unknown }).cmd;
    return typeof cmd === "number" ? cmd : undefined;
  } catch {
    return undefined;
  }
}

/** The GCM sub-header word a connect starts at (`zx_update_p2p_connect_info`), little-endian `[04, 03, 02, 01]`. */
const GCM_WORD_START = 0x01020304;

/**
 * Transport wiring for a PPCS session — internal to the SDK; a host reaches sessions through the facade.
 * @internal
 */
export interface P2PSessionConfig {
  stationSn: string;
  p2pDid: string;
  /** Cloud lookup servers (the station record's `app_conn`, else `p2p_conn`: {@link stationCloudAddresses}). */
  cloudAddresses?: Address[];
  /** DSK key for the cloud-lookup payload. Optional — local lookup needs none. */
  dskKey?: string;
  /** Known LAN address of the station, for a direct (non-broadcast) local lookup. */
  localAddress?: string;
  /** Disable UDP broadcast local lookup (e.g. cloud-only). Default false. */
  noBroadcast?: boolean;
  /**
   * Resolve a station `cipher_id` named by a `CMD_GATEWAYINFO` reply of header `version` → its private key from
   * cloud `get_ciphers`: the ECC private key hex for version 8, the RSA private key for any other. Called once per
   * negotiation. When provided, the session auto-negotiates the **level-2** session key on connect: it
   * reads the `cipher_id` + envelope from the `CMD_GATEWAYINFO` reply and derives the key, by the ECIES unwrap
   * for version 8 and the RSA unwrap otherwise.
   */
  resolveCipherKey?: (cipherId: number, version: number) => Promise<string | undefined>;
  /**
   * The user id the app connects a station under (`IUser.getUid`, `AnkerAccountManager.e` of the station: the
   * router's `memberAccountId`): the sign-1 GCM key is built from it.
   */
  userId?: string;
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
 * its measured shape is what keeps the distinction. A `CMD_CAMERA_INFO` answered on {@link STATION_CHANNEL}
 * is the station's per-channel table and is read by {@link channelReport} instead.
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
 * Split a station's `CMD_CAMERA_INFO` table into one `param_type → param_value` map per channel, or
 * `undefined` when the payload carries no entry naming one.
 *
 * A HomeBase answers on {@link STATION_CHANNEL} with every attached camera's params in one root array, each
 * entry's `dev_type` naming the channel it belongs to and 255 naming the station. Flattened, each id keeps
 * whichever channel came last, so no camera reads its own state from it.
 */
function channelReport(payload: unknown): Record<number, Record<number, string>> | undefined {
  const list = (payload as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(list)) return undefined;
  const out: Record<number, Record<number, string>> = {};
  for (const entry of list) {
    const p = entry as { dev_type?: unknown; param_type?: unknown; param_value?: unknown };
    if (typeof p?.dev_type !== "number" || typeof p.param_type !== "number" || p.param_value == null) continue;
    (out[p.dev_type] ??= {})[p.param_type] = String(p.param_value);
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
  /**
   * A station's camera-info table, one `param_type → param_value` map per channel it names (255 is the
   * station). Set instead of {@link params} when the station answered on {@link STATION_CHANNEL}, so each
   * channel's state can land on the device attached there.
   */
  channelParams?: Record<number, Record<number, string>>;
}

/** Per-process counter behind {@link P2PSession.traceId} — see it for why this is not a serial. */
let traceSequence = 0;

/**
 * The rows or refusal code of the first complete table document in an accumulated `CMD_DATABASE` reply.
 *
 * `undefined` while none has closed, which is what makes the document's own structure the completion
 * signal: the frames carry no index, no total and no terminator, and the last one is padded past the
 * closing brace so the accumulation is never valid JSON in its entirety.
 *
 * A non-zero numeric `mIntRet` answers a refusal code; a `data` array answers rows, and `data: "[]"` or
 * `data: ""` answers an empty page. A closed object carrying neither rows nor a refusal is skipped. The
 * case is a tail left by an earlier reply that timed out: it begins mid-row, closes into a valid
 * object carrying no rows, and reporting it would answer an empty table for a full one.
 *
 * Re-decoded UTF-8 first. `dbChunk` carries latin1, which preserves the bytes and mangles every name
 * outside ASCII until the document is read back in the encoding it was written in.
 */
function firstTableRows(text: string): { rows?: unknown[]; error?: number } | undefined {
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  for (let start = decoded.indexOf("{"); start >= 0; start = decoded.indexOf("{", start + 1)) {
    const end = closingBrace(decoded, start);
    if (end < 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded.slice(start, end + 1));
    } catch {
      continue;
    }
    const reply = parsed as { data?: unknown; mIntRet?: unknown } | null;
    if (typeof reply?.mIntRet === "number" && reply.mIntRet !== 0) return { error: reply.mIntRet };
    if (reply?.data === "[]" || reply?.data === "") return { rows: [] };
    if (Array.isArray(reply?.data)) return { rows: reply.data };
  }
  return undefined;
}

/** The index of the brace closing the object opened at `start`, or -1 while it has not arrived. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

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
   * identical events. The condition is
   * reported once and again only if the channel recovers and stalls afresh.
   */
  private audioStalled = false;
  private audioRetransmitTimer?: ReturnType<typeof setInterval>;
  private lastPongData?: Buffer;
  /**
   * When the selected peer last answered outbound P2P traffic on this connection.
   *
   * Each answer also emits `peerAnswer` with this time: a PONG or an ACK from the connected address is the
   * station replying on this connection now.
   */
  private lastPeerAt?: number;
  /** When anything last arrived from the connected peer, and the ALIVEs sent since without an answer. */
  private lastHeardAt = 0;
  private aliveMisses = 0;
  private lookupTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  /** Extra sockets registered alongside {@link socket} while connecting; see {@link PUNCH_PROBE_SOCKETS}. */
  private probeSockets: dgram.Socket[] = [];
  /** Cloud lookup inputs resolved once for a connection. */
  private cloudLookup?: { key: string; addresses: Address[] };
  /**
   * Lookup rounds since the lookup server acknowledged this connect's P2P request, or `undefined` while it
   * has not; see {@link RELAY_AFTER_ACKED_ROUNDS}.
   */
  private ackedRounds?: number;
  /**
   * The relay handshake of a connect that has fallen back to one, by the step it waits on: the relay list
   * (`list`, answering ListReq_DSK), a relay's hello acknowledgement (`hello`), that relay's port (`port`),
   * then the relay-ready the device's registration produces (`request`, re-sending RLY_REQ meanwhile).
   */
  private relay?: { step: "list" | "hello" | "port" | "request"; relays: Address[]; via?: Address; mark?: number };
  /** Local outbound IPv4 reported inside LOOKUP_WITH_KEY requests. */
  private selfHost?: string;
  /**
   * In-flight multi-datagram frame per data channel (see reassemble): the payload gathered so far under its
   * parsed header, or, without a header, the start of a frame header cut by the datagram boundary.
   */
  private readonly pendingByDataType = new Map<
    number,
    { header?: P2PDataFrameHeader; chunks: Buffer[]; byteLength: number }
  >();
  /** Last delivered datagram sequence number per data type. */
  private readonly lastSeqByType = new Map<number, number>();
  /** Held datagrams and their active gap timer, grouped by data type. */
  private readonly reorderByType = new Map<
    number,
    { held: Map<number, Buffer>; timer?: ReturnType<typeof setTimeout> }
  >();
  private tracedDatagramGaps = 0;
  private readonly level1Key: Buffer;
  /**
   * The app's session slots: sign mode `+208`, negotiated version `+236`, the AES-128-ECB key `+0xd8` and the
   * AES-256-GCM key `+0xf0`. A connect starts them at 0, 1 and no key; a gateway info naming a cipher and the key it
   * unwraps to move them ({@link gatewayInfoSlots}, {@link setLevel2Key}); {@link seal} and {@link openFrame}
   * read them.
   */
  private signMode = 0;
  private sessionVersion = 1;
  private ecbKey?: Buffer;
  private gcmKey?: Buffer;
  /** The GCM sub-header word, counted on per GCM send. */
  private gcmWord = GCM_WORD_START;
  /** Header byte 11: the app's per-connection command counter, written then moved on by every command sent. */
  private commandCount = 0;
  /** The 1100 resend check of the app's notify reader: its last run and its run count since the last resend. */
  private gatewayCheck = { atMs: 0, runs: 0 };
  private rsaPrivateKey?: KeyObject;
  private rsaModulusHex?: string;
  /** The P-256 pair a media start offers; see {@link mediaEccPrivateKey}. */
  private mediaEcc?: { privateKey: Buffer; point: string };
  /** Whether a gateway info came as version 8, which the app records per station (`P2PClient.h`) for its media key. */
  private notifiedVersion8 = false;
  /**
   * Channel-2 frames that arrived while a gateway info's key step runs, in arrival order. The app runs that step's
   * blocking lookup on the thread that reads channel 2, so nothing else on it is read until the step ends.
   */
  private heldNotifies?: Array<[P2PDataFrameHeader, Buffer, number]>;
  /** Connection generation that owns every asynchronous result derived from its gateway envelope. */
  private connectionGeneration = 0;
  /** Whether this connection's latest `CMD_GATEWAYINFO` reply was a refusal — see {@link gatewayInfoRefused}. */
  private gatewayRefused = false;
  /** Datagrams sent through {@link sendAcknowledged} and not yet acknowledged, by sequence, oldest first. */
  private readonly unackedCommands = new Map<number, Buffer>();
  private commandRetransmitTimer?: ReturnType<typeof setInterval>;
  /** The DATA datagrams sent while a {@link sendAcknowledged} call runs its send. */
  private capturedCommands?: Buffer[];

  private readonly logger: Logger;

  constructor(private readonly cfg: P2PSessionConfig) {
    super();
    this.level1Key = Buffer.from(p2pCommandEncryptionKey(cfg.stationSn, cfg.p2pDid));
    this.logger = cfg.logger ?? noopLogger;
  }

  /**
   * This session's opaque handle for tracing — `station-N` by order of construction in this process.
   *
   * Not the serial: a trace carrying one could not be retained by a host, which is the whole point of the
   * phase vocabulary. It groups one station's records within a run and resolves to nothing outside it.
   */
  readonly traceId = `station-${++traceSequence}`;

  /** Emit a live trace under this session's handle. */
  private trace(trace: LiveTrace): void {
    traceLiveStart(this.logger, trace, this.traceId);
  }

  /**
   * Hold the 32-byte key a version-8 gateway info unwraps to, as the app's `zx_set_p2p_ecckey` does: the GCM slot and
   * sign mode 8, the negotiated version left as the gateway info set it.
   */
  setLevel2Key(key: Buffer): void {
    if (key.length !== 32) throw new Error(`level-2 key must be 32 bytes, got ${key.length}`);
    this.gcmKey = key;
    this.signMode = 8;
  }

  /** Whether a gateway info's key is held: sign mode 2 (its RSA-unwrapped ECB key) or 8 (its ECIES key). */
  get hasLevel2Key(): boolean {
    return this.signMode >= 2;
  }

  /**
   * Take one decrypted `CMD_GATEWAYINFO` reply as the app does: its native step ({@link gatewayInfoSlots}), then its
   * key step, `NotifyInterceptor`'s, for every reply. The key step gets what native hands Java: the `cipher_id` and the
   * 128 bytes after it (129 at version 8) for a `cipher_id` of 2 or more, the bytes up to the first NUL for 1, and 0 with
   * no body for a reply naming none. It looks the private key up for the header `version` (`resolveCipherKey`) and
   * unwraps it by ECIES for version 8 ({@link setLevel2Key}) and by RSA otherwise (the ECB slot, sign mode 2). Channel-2
   * frames wait in {@link heldNotifies} until it ends, then go through in arrival order.
   *
   * Emits `level2Ready` for either key, and `error` when the ECC unwrap fails; an RSA unwrap failure is only traced,
   * and leaves the session at sign mode 1 as the app's does. A key step that ends without a key is traced unless a key
   * is held or another gateway info is held behind it. A step whose connection generation ended does nothing.
   */
  private negotiateLevel2Key(gwPayload: Buffer, version: number): void {
    const cipherId = gwPayload.length >= 4 ? gwPayload.readInt32LE(0) : 0;
    this.gatewayInfoSlots(cipherId, version);
    this.notifiedVersion8 ||= version === 8;
    this.gatewayRefused = gatewayInfoRefused(gwPayload);
    if (!this.cfg.resolveCipherKey) return;
    const generation = this.connectionGeneration;
    this.heldNotifies = [];
    const after = gwPayload.subarray(4);
    const body =
      cipherId >= 2
        ? after.subarray(0, version === 8 ? 129 : 128)
        : cipherId === 1
          ? after.subarray(0, after.includes(0) ? after.indexOf(0) : after.length)
          : Buffer.alloc(0);
    void this.gatewayKeyStep(body, Math.max(cipherId, 0), version, generation).finally(() => {
      if (generation !== this.connectionGeneration) return;
      const held = this.heldNotifies ?? [];
      this.heldNotifies = undefined;
      for (let i = 0; i < held.length; i++) {
        const heldAgain = this.heldNotifies as typeof held | undefined;
        if (heldAgain) {
          heldAgain.push(...held.slice(i));
          break;
        }
        this.handleFrame(...held[i]!);
      }
    });
  }

  /** One gateway info's key step on the body native hands Java — see {@link negotiateLevel2Key}. */
  private async gatewayKeyStep(body: Buffer, cipherId: number, version: number, generation: number): Promise<void> {
    const ecc = version === 8;
    const conclude = (unavailable: LiveTrace): void => {
      if (this.hasLevel2Key || this.heldNotifies?.some(([h]) => h.commandId === CMD_GATEWAYINFO)) return;
      this.trace(unavailable);
    };
    this.trace({ phase: "level2-negotiating", cipherId, version });
    try {
      const privateKey = await this.cfg.resolveCipherKey!(cipherId, version);
      if (this.closed || generation !== this.connectionGeneration) return;
      if (!privateKey) {
        this.logger.debug(`[p2p] ${this.cfg.stationSn} no ECC or RSA key for cipher_id ${cipherId}`);
        conclude(
          this.gatewayRefused
            ? { phase: "level2-unavailable", reason: "gateway-refused" }
            : { phase: "level2-unavailable", reason: "no-cipher-key", cipherId },
        );
        return;
      }
      const key = ecc
        ? deriveLevel2KeyFromGatewayInfo(body, privateKey)
        : deriveLevel2KeyFromRsaGatewayInfo(body, privateKey);
      if (!key) {
        conclude({ phase: "level2-unavailable", reason: "derivation-failed", cipherId });
        if (ecc) this.emit("error", new Error(`level-2 key derivation failed (cipher_id ${cipherId})`));
        return;
      }
      if (ecc) this.setLevel2Key(key);
      else {
        this.ecbKey = key;
        this.signMode = 2;
      }
      this.logger.debug(`[p2p] ${this.cfg.stationSn} level-2 key negotiated (cipher_id ${cipherId})`);
      this.trace({ phase: "level2-ready", cipherId });
      this.emit("level2Ready", { cipherId });
    } catch (e) {
      if (this.closed || generation !== this.connectionGeneration) return;
      conclude({ phase: "level2-unavailable", reason: "derivation-failed", cipherId });
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * The native step of a gateway info (`handleNotifyCommand` 1100), whatever the session held. Naming a cipher: the
   * header's version, the GCM slot = the account's user id (32 characters) with the serial's last 7 over its first
   * 7, the ECB slot = the level-1 key, sign mode 1. Refused (`cipher_id` < 0) on a {@link LEVEL1_AT_SIGN0_PREFIXES}
   * serial: the ECB slot and sign mode 1 alone. `cipher_id` 0 changes nothing.
   */
  private gatewayInfoSlots(cipherId: number, version: number): void {
    if (cipherId >= 1) {
      this.sessionVersion = version;
      this.gcmKey = this.userIdKey;
    } else if (cipherId === 0 || !this.level1AtSign0) {
      return;
    }
    this.ecbKey = this.level1Key;
    this.signMode = 1;
  }

  /**
   * The session slots as a connect starts them (`zx_update_p2p_connect_info`): sign mode 0, version 1, no key. The
   * version-8 mark goes too: the app drops it on the 1044 that `zx_clear_p2p_connect_info_by_session` sends.
   */
  private resetSlots(): void {
    this.notifiedVersion8 = false;
    this.signMode = 0;
    this.sessionVersion = 1;
    this.ecbKey = undefined;
    this.gcmKey = undefined;
    this.gcmWord = GCM_WORD_START;
  }

  /**
   * The account's user id (32 characters) with the serial's last 7 over its first 7: the GCM key a gateway info
   * naming a cipher puts in the GCM slot, and the key the app's receiver opens a version-8 sign-1 frame with.
   */
  private get userIdKey(): Buffer {
    const key = Buffer.alloc(32);
    key.write((this.cfg.userId ?? "").slice(0, 32), "latin1");
    key.write(this.cfg.stationSn.slice(-7), "latin1");
    return key;
  }

  /** Whether this serial is one {@link LEVEL1_AT_SIGN0_PREFIXES} names. */
  private get level1AtSign0(): boolean {
    return LEVEL1_AT_SIGN0_PREFIXES.some((prefix) => this.cfg.stationSn.startsWith(prefix));
  }

  /**
   * Open an inbound frame body as the app's `zx_p2p_notify_read` does, by the frame's own header bytes. Sign 0 stays as
   * is. A version-8 frame other than a gateway info is AES-256-GCM, AAD "eufy security", `tag(16) ‖ nonce(12) ‖
   * ciphertext` for every sign, under the GCM slot from sign 2 up and under {@link userIdKey} at sign 1; one shorter
   * than 29 bytes or that does not open stays as it came. Any other frame is AES-128-ECB ({@link decryptP2PData}):
   * sign 2 under the ECB slot, as is while that slot is empty, any other sign under the level-1 key.
   */
  private openFrame(header: P2PDataFrameHeader, payload: Buffer): Buffer {
    const { signCode, version, commandId } = header;
    if (signCode === 0) return payload;
    if (version === 8 && commandId !== CMD_GATEWAYINFO) {
      const key = signCode >= 2 ? this.gcmKey : this.userIdKey;
      return (key && payload.length >= 29 && gcmOpen(key, payload)) || payload;
    }
    if (signCode === 2) return this.ecbKey?.[0] ? decryptP2PData(payload, this.ecbKey) : payload;
    return decryptP2PData(payload, this.level1Key);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether {@link close} has run since the last {@link connect}: this session will not connect again on its own. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Ask the OS for {@link RECEIVE_BUFFER_BYTES} on a bound socket, and log once per session when it grants
   * less (debug) or refuses (warn).
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
    const [level, outcome] =
      granted > 0 ? (["debug", ` (granted ${granted})`] as const) : (["warn", " (request refused)"] as const);
    this.logger[level](
      `[p2p] ${this.cfg.stationSn} UDP receive buffer below the ${RECEIVE_BUFFER_BYTES} bytes requested` +
        outcome +
        `; live video can lose keyframes. Raise the OS limit (net.core.rmem_max on Linux, ` +
        `kern.ipc.maxsockbuf on BSD) to at least ${RECEIVE_BUFFER_BYTES}.`,
    );
  }

  /**
   * Open the socket and start the lookup → hole-punch handshake.
   *
   * A socket closed or failing while binding never invokes its bind callback, so the bind wait also
   * settles on the socket's `close` and `error`. On `close`, a connect whose session was closed meanwhile
   * returns without starting the handshake, so it never sends a lookup or arms a timer on a closed
   * session. On `error`, connect closes the session and rejects with {@link StationUnreachableError}
   * carrying the bind error as its `cause`.
   */
  async connect(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.closed = false;
    this.connectionGeneration += 1;
    this.ackedRounds = undefined;
    this.resetInboundSequencing();
    this.resetSlots();
    this.heldNotifies = undefined;
    this.gatewayRefused = false;
    this.commandCount = 0;

    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg, rinfo) => this.onMessage(msg, rinfo, socket));
    socket.on("error", (e) => this.emit("error", e));

    const generation = this.connectionGeneration;
    await new Promise<void>((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
      socket.bind(() => {
        socket.off("error", reject);
        try {
          socket.setBroadcast(true);
        } catch {
          /* broadcast not permitted — cloud path still works */
        }
        this.requestReceiveBuffer(socket);
        resolve();
      });
    }).catch(async (error: unknown) => {
      await this.close();
      throw new StationUnreachableError(this.cfg.stationSn, 0, { cause: error });
    });
    if (generation !== this.connectionGeneration) return;

    void P2PSession.detectLocalIp().then((host) => {
      if (host && !this.closed) this.selfHost = host;
    });

    const { dskKey, cloudAddresses } = this.cfg;
    this.cloudLookup = dskKey && cloudAddresses?.length ? { key: dskKey, addresses: cloudAddresses } : undefined;
    if (this.cloudLookup && cloudAddresses) {
      void resolveLookupServers(cloudAddresses).then((addresses) => {
        if (this.cloudLookup && !this.closed && generation === this.connectionGeneration)
          this.cloudLookup.addresses = addresses;
      });
    }
    if (this.cloudLookup) await this.startPunchProbes();
    if (this.closed) return;
    this.trace({
      phase: "lookup-channels",
      local: !this.cfg.noBroadcast || this.cfg.localAddress !== undefined,
      cloud: this.cloudLookup !== undefined,
      ...(this.cloudLookup ? {} : { cloudMissing: dskKey ? "cloud-addresses" : "dsk-key" }),
    });
    this.sendLookups();
    this.lookupTimer = setInterval(() => this.sendLookups(), LOOKUP_RETRY_MS);
    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        this.emit("error", new Error(`P2P connect timeout for ${this.cfg.stationSn} (${this.relayProgress()})`));
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
    // background self-IP probe has resolved; every real capture of a relay endpoint (RLY_TO, f182)
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
    this.countAckedRound();
    this.sendRelay();
  }

  /** Step {@link ackedRounds} for one lookup round, and start the relay handshake once it passes its threshold. */
  private countAckedRound(): void {
    if (this.ackedRounds === undefined || this.relay || !this.cloudLookup) return;
    this.ackedRounds += 1;
    if (this.ackedRounds > RELAY_AFTER_ACKED_ROUNDS) this.relay = { step: "list", relays: [] };
  }

  /**
   * How far this connect got towards a relay: the handshake step it was waiting on (`list` meaning no lookup
   * server named a relay), `not started` where it had not fallen back yet, or `no cloud lookup` where it could
   * not.
   */
  private relayProgress(): string {
    return `relay: ${this.relay?.step ?? (this.cloudLookup ? "not started" : "no cloud lookup")}`;
  }

  /**
   * Send the relay handshake's message for the step it waits on, from the session's own socket.
   *
   * The order is the vendor client's: ListReq_DSK to the cloud lookup servers, RLY_HELLO to every relay they
   * list, RLY_PORT to the first of those relays that acknowledges, then RLY_REQ to the lookup servers naming
   * that relay's port and mark. The lookup server has the device register with the relay, and the relay
   * answers RLY_RDY.
   */
  private sendRelay(): void {
    const relay = this.relay;
    const lookup = this.cloudLookup;
    if (!relay || !lookup || this.connected) return;
    if (relay.step === "list") {
      const payload = buildLookupWithKeyPayload2(this.cfg.p2pDid, lookup.key);
      for (const addr of lookup.addresses) this.send(addr, RequestMessageType.LOOKUP_WITH_KEY2, payload);
    } else if (relay.step === "hello") {
      for (const addr of relay.relays) this.send(addr, RequestMessageType.RLY_HELLO);
    } else if (relay.step === "port" && relay.via) {
      this.send(relay.via, RequestMessageType.RLY_PORT);
    } else if (relay.step === "request" && relay.via && relay.mark !== undefined) {
      const payload = buildRelayRequestPayload(this.cfg.p2pDid, relay.via, relay.mark);
      for (const addr of lookup.addresses) this.send(addr, RequestMessageType.RLY_REQ, payload);
    }
  }

  /** Advance the relay handshake on one of its answers, arriving on the session's own socket. */
  private onRelayMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const relay = this.relay;
    if (!relay || this.connected) return;
    if (hasHeader(msg, ResponseMessageType.LIST_REQ_ACK)) {
      if (relay.step !== "list" && relay.step !== "hello") return;
      for (const listed of parseRelayList(msg))
        if (!relay.relays.some((known) => known.host === listed.host && known.port === listed.port))
          relay.relays.push(listed);
      if (relay.relays.length) relay.step = "hello";
    } else if (hasHeader(msg, ResponseMessageType.RLY_HELLO_ACK)) {
      const listed = relay.relays.some((known) => known.host === rinfo.address && known.port === rinfo.port);
      if (relay.step !== "hello" || !listed) return;
      relay.via = { host: rinfo.address, port: rinfo.port };
      relay.step = "port";
    } else if (hasHeader(msg, ResponseMessageType.RLY_PORT_ACK)) {
      const ack = parseRelayPortAck(msg);
      if (relay.step !== "port" || !relay.via || !ack) return;
      relay.via = { host: relay.via.host, port: ack.port };
      relay.mark = ack.mark;
      relay.step = "request";
    } else {
      return;
    }
    this.logger.debug(`[p2p] ${this.cfg.stationSn} relay -> ${relay.step}`);
    this.sendRelay();
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
   * An unmodelled type is not by itself evidence about a session that is failing. Correlate one against a
   * WORKING session before reading it as a cause.
   *
   * P2P_REQ_ACK is the lookup server acknowledging this connect's P2P request; the first one carrying result 0
   * starts the round count {@link RELAY_AFTER_ACKED_ROUNDS} measures.
   *
   * CAM_ADDR is recognised and dropped: it names the address the device is already answering from, and the
   * CAM_ID that follows it is what completes the connect. RLY_TO is a relay endpoint, never the device: it is
   * answered with {@link RELAY_PACKET_COPIES} RLY_PKTs carrying its handle, and the RLY_RDY naming this
   * session's device completes the connect with the relay as the peer. The other relay answers advance the
   * handshake {@link sendRelay} drives, and are dropped outside it.
   */
  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, socket = this.socket): void {
    if (!socket) return;
    const fromConnectedPeer =
      this.connected && this.connectAddress?.host === rinfo.address && this.connectAddress.port === rinfo.port;
    if (fromConnectedPeer) {
      this.lastHeardAt = Date.now();
      this.aliveMisses = 0;
    }
    if (fromConnectedPeer && (hasHeader(msg, ResponseMessageType.PONG) || hasHeader(msg, ResponseMessageType.ACK))) {
      this.lastPeerAt = Date.now();
      this.emit("peerAnswer", this.lastPeerAt);
    }
    if (!hasHeader(msg, ResponseMessageType.DATA)) {
      this.logger.debug(
        `[p2p] ${this.cfg.stationSn} <<< ${rinfo.address}:${rinfo.port} header=${msg.subarray(0, 2).toString("hex")} len=${msg.length}`,
      );
    }
    if (hasHeader(msg, ResponseMessageType.LOCAL_LOOKUP_RESP)) {
      // LOCAL_LOOKUP_RESP shares 0xf141 with CAM_ID; treat a pre-connect response
      // from the lookup as "device here, hole-punch it".
      if (!this.connected) this.beginCheckCam({ host: rinfo.address, port: rinfo.port }, socket);
    } else if (hasHeader(msg, ResponseMessageType.LOOKUP_ADDR)) {
      if (!this.connected) {
        const addr = parseLookupAddr(msg);
        if (addr) {
          this.logger.debug(`[p2p] ${this.cfg.stationSn} LOOKUP_ADDR -> ${addr.host}:${addr.port}`);
          if (addr.host !== "0.0.0.0") this.beginCheckCam(addr, socket);
        }
      }
    } else if (hasHeader(msg, ResponseMessageType.RLY_TO)) {
      const to = parseRelayTo(msg);
      if (!this.connected && to && to.address.host !== "0.0.0.0") {
        this.logger.debug(`[p2p] ${this.cfg.stationSn} RLY_TO -> ${to.address.host}:${to.address.port}`);
        const payload = buildRelayPacketPayload(to.handle, this.cfg.p2pDid);
        for (let i = 0; i < RELAY_PACKET_COPIES; i++)
          this.send(to.address, RequestMessageType.RLY_PKT, payload, socket);
      }
    } else if (hasHeader(msg, ResponseMessageType.RLY_RDY)) {
      if (msg.subarray(4, 24).equals(p2pDidToBuffer(this.cfg.p2pDid))) {
        this.logger.debug(`[p2p] ${this.cfg.stationSn} RLY_RDY from relay ${rinfo.address}:${rinfo.port}`);
        this.onConnected({ host: rinfo.address, port: rinfo.port }, socket);
      }
    } else if (hasHeader(msg, ResponseMessageType.P2P_REQ_ACK)) {
      if (!this.connected && this.ackedRounds === undefined && msg.length > 4 && msg[4] === 0) this.ackedRounds = 0;
    } else if (
      hasHeader(msg, ResponseMessageType.LIST_REQ_ACK) ||
      hasHeader(msg, ResponseMessageType.RLY_HELLO_ACK) ||
      hasHeader(msg, ResponseMessageType.RLY_PORT_ACK) ||
      hasHeader(msg, ResponseMessageType.RLY_REQ_ACK)
    ) {
      if (socket === this.socket) this.onRelayMessage(msg, rinfo);
    } else if (hasHeader(msg, ResponseMessageType.CAM_ID)) {
      this.onConnected({ host: rinfo.address, port: rinfo.port }, socket);
    } else if (hasHeader(msg, ResponseMessageType.END)) {
      if (!fromConnectedPeer) return;
      this.logger.debug(`[p2p] ${this.cfg.stationSn} END from the peer — closing`);
      void this.close().catch((error) => this.emit("error", error));
    } else if (hasHeader(msg, ResponseMessageType.PONG)) {
      this.lastPongData = msg.length > 4 ? msg.subarray(4) : undefined;
    } else if (hasHeader(msg, ResponseMessageType.PING)) {
      this.send({ host: rinfo.address, port: rinfo.port }, RequestMessageType.PONG, undefined, socket); // echo
    } else if (hasHeader(msg, ResponseMessageType.ACK)) {
      this.onAck(msg);
    } else if (hasHeader(msg, ResponseMessageType.DATA)) {
      if (this.connected) this.onData(msg, { host: rinfo.address, port: rinfo.port });
    } else if (!hasHeader(msg, ResponseMessageType.CAM_ADDR)) {
      this.logger.debug(`[p2p] ${this.cfg.stationSn} UNHANDLED payload hex: ${msg.toString("hex")}`);
    }
  }

  private beginCheckCam(addr: Address, socket: dgram.Socket): void {
    this.logger.debug(`[p2p] ${this.cfg.stationSn} beginCheckCam -> ${addr.host}:${addr.port} (+/-3)`);
    const payload = buildCheckCamPayload(this.cfg.p2pDid);
    // Hole-punch the reported port and a small neighbourhood (NAT remapping).
    this.send(addr, RequestMessageType.CHECK_CAM, payload, socket);
    for (let p = addr.port - 3; p <= addr.port + 3; p++)
      if (p !== addr.port) this.send({ host: addr.host, port: p }, RequestMessageType.CHECK_CAM, payload, socket);
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
      this.requestReceiveBuffer(socket);
    }
    this.connected = true;
    this.connecting = false;
    this.connectAddress = addr;
    if (this.lookupTimer) clearInterval(this.lookupTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.relay = undefined;
    this.logger.debug(`[p2p] ${this.cfg.stationSn} connected ${addr.host}:${addr.port}`);

    this.gatewayCheck = { atMs: Date.now(), runs: 0 };
    this.sendCommand(CMD_GATEWAYINFO);
    this.lastHeardAt = Date.now();
    this.aliveMisses = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connectAddress || Date.now() - this.lastHeardAt < ALIVE_MS) return;
      this.lastHeardAt = Date.now();
      if (++this.aliveMisses > ALIVE_MISSES) {
        this.logger.debug(`[p2p] ${this.cfg.stationSn} ${ALIVE_MISSES} ALIVEs unanswered — closing as timed out`);
        void this.close().catch((error) => this.emit("error", error));
        return;
      }
      this.send(this.connectAddress, RequestMessageType.PING, this.lastPongData);
    }, ALIVE_MS);
    this.emit("connect");
  }

  /**
   * Run `send` and retain each DATA datagram it emits under its own sequence until the device acknowledges
   * that sequence, as the app's DRW channel holds an element in its unacked queue (`cs2p2p_DoDRWSend` sends
   * each index once). Every {@link DRW_RESEND_MS} the oldest retained datagram, and only that one, goes again
   * byte-identically (`thread_recv_DRW` moves the head of the channel's unacked queue back to ready), until a
   * `DRWAck` lists it. The device answers a sequence once, however many copies arrive, and `onData` drops the
   * repeats of that answer by their sequence. Answers what `send` answered.
   */
  sendAcknowledged(send: () => boolean): boolean {
    this.capturedCommands = [];
    let sent: boolean;
    let captured: Buffer[];
    try {
      sent = send();
    } finally {
      captured = this.capturedCommands;
      this.capturedCommands = undefined;
    }
    for (const data of captured) this.retainCommand(data);
    return sent;
  }

  /** Hold `data` under its sequence until acknowledged, re-sending the oldest held one — see {@link sendAcknowledged}. */
  private retainCommand(data: Buffer): void {
    this.unackedCommands.set(data.readUInt16BE(2), data);
    if (this.commandRetransmitTimer) return;
    this.commandRetransmitTimer = setInterval(() => {
      const [head] = this.unackedCommands.values();
      if (head && this.connectAddress) this.send(this.connectAddress, RequestMessageType.DATA, head);
    }, DRW_RESEND_MS);
    this.commandRetransmitTimer.unref?.();
  }

  private clearCommandRetransmit(): void {
    clearInterval(this.commandRetransmitTimer);
    this.commandRetransmitTimer = undefined;
  }

  /**
   * Send a **string-payload control command** (the JSON control wrapper `1700` / media `1350`),
   * sealed by the session ({@link seal}) — the WRITE
   * primitive behind `setProperty`. `value` is the JSON the app wraps (`{commandType, data}`); the
   * device unwraps and applies it. Fire-and-forget today (the device echoes the new state back as a
   * param update); request/response correlation is a later refinement.
   */
  sendStringPayloadCommand(commandType: number, value: string, channel: number = STATION_CHANNEL): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    this.transmit(commandType, channel, Buffer.from(value, "utf-8"), { text: true });
  }

  /**
   * Send an **int+string control command**, sealed by the session — the wire shape
   * the app uses for the floodlight/spotlight switch (`CMD_SET_FLOODLIGHT_MANUAL_SWITCH` 1400) on
   * IndoorOutdoor / SoloCam-spotlight / Cam2C-3 families: `value` (0/1), `valueSub` (channel), and
   * `strValue` (admin `account_id`). See {@link intStringCommandBody}. Fire-and-forget.
   */
  sendIntStringCommand(
    commandType: number,
    value: number,
    valueSub: number,
    strValue: string,
    channel = STATION_CHANNEL,
  ): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    this.transmit(commandType, channel, intStringCommandBody(value, valueSub, strValue));
  }

  /** Send a {@link stringPairCommandBody} command on `channel`, sealed by the session. */
  sendStringPairCommand(commandType: number, strValue: string, strValueSub: string, channel: number): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    this.transmit(commandType, channel, stringPairCommandBody(strValue, strValueSub));
  }

  /**
   * Header byte 14 of a frame that carries the session's counter, as the app's native sender writes it:
   * `bump` moves it on (to 10 when `(b + 5) & 0xff < 15`, else up one, so it cycles 10..251) and writes it,
   * `current` writes it as it stands, no mode writes 0.
   */
  private headerCounter(mode?: "bump" | "current"): number {
    if (mode === "bump") headerCounterByte = ((headerCounterByte + 5) & 0xff) < 15 ? 10 : headerCounterByte + 1;
    return mode ? headerCounterByte : 0;
  }

  /** Send `payload` as the body of `outerCmd` on `channel`, sealed by the session ({@link seal}). `false` when not connected. */
  sendBytes(payload: Buffer, channel: number, outerCmd: number): boolean {
    if (!this.connectAddress) return false;
    this.transmit(outerCmd, channel, payload);
    return true;
  }

  /**
   * Push one **whole ADTS AAC frame** toward the device as `CMD_AUDIO_FRAME` (1301) on the video
   * data-type channel, plaintext (signCode 0) in both topologies — the audio itself is never
   * encrypted, only the start/stop control frames are. The 16-byte header the device expects ahead of
   * the payload is `[uint32 frameLength][uint32 channel][8 zero bytes]`, where `frameLength` repeats
   * the ADTS header's own length field. The trailing 8 bytes are zero in both topologies — the app
   * never populates them.
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
    this.unackedAudio.set(seq, { data, sentAt, sends: 1 });
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
      const to = this.connectAddress;
      const now = Date.now();
      for (const [sequence, held] of to ? this.unackedAudio : []) {
        if (now - held.sentAt < AUDIO_RETRANSMIT_MS) continue;
        this.unackedAudio.delete(sequence);
        if (held.sends >= AUDIO_MAX_SENDS) {
          if (!this.audioStalled) this.emit("audioGap", sequence);
          this.audioStalled = true;
          continue;
        }
        held.sends++;
        held.sentAt = now;
        this.unackedAudio.set(sequence, held);
        this.send(to!, RequestMessageType.DATA, held.data);
      }
      if (to && this.unackedAudio.size) return;
      clearInterval(this.audioRetransmitTimer);
      this.audioRetransmitTimer = undefined;
    }, AUDIO_RETRANSMIT_MS / 2);
  }

  /**
   * Clear acknowledged commands and audio frames. The device's acknowledgement lists the sequence numbers it has
   * taken on a given data-type channel: `[dataTypeHeader:2][count:2 BE][seq:2 BE]×count`.
   *
   * DATA acknowledgements release commands retained by {@link sendAcknowledged}. The video data-type
   * acknowledgements release outbound talkback frames, whose ordered channel stalls on a gap.
   */
  private onAck(msg: Buffer): void {
    if (msg.length < 8 || msg[4] !== 0xd1) return;
    const count = msg.readUInt16BE(6);
    if (msg[5] === P2PDataType.DATA) {
      for (let i = 0; i < count && 10 + 2 * i <= msg.length; i++) {
        this.unackedCommands.delete(msg.readUInt16BE(8 + 2 * i));
      }
      if (!this.unackedCommands.size) this.clearCommandRetransmit();
      return;
    }
    if (msg[5] !== P2PDataType.VIDEO) return;
    for (let i = 0; i < count && 10 + 2 * i <= msg.length; i++) {
      this.unackedAudio.delete(msg.readUInt16BE(8 + 2 * i));
    }
    if (count > 0) this.audioStalled = false;
  }

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
   * the pinned engine. Returns `undefined` on failure (frame is skipped).
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
   * The session's P-256 pair: the private scalar as 32 bytes, and the public point as 128 hex characters,
   * `x ‖ y` without the uncompressed-point prefix, the form a media start carries in its key.
   * `ECDH.getPrivateKey()` drops a scalar's leading zero bytes, so the scalar is padded back to 32.
   */
  private mediaEccPair(): { privateKey: Buffer; point: string } {
    if (!this.mediaEcc) {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      this.mediaEcc = {
        privateKey: Buffer.from(ecdh.getPrivateKey("hex").padStart(64, "0"), "hex"),
        point: ecdh.getPublicKey().subarray(1).toString("hex"),
      };
    }
    return this.mediaEcc;
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

  /**
   * The 32-byte P-256 private scalar of the point a media start offered ({@link sendFrame}); the camera wraps each
   * keyframe's AES-256-GCM media key in an ECIES envelope for it ({@link VideoFrameDecoder}). `undefined` until a
   * start offered it.
   */
  get mediaEccPrivateKey(): Buffer | undefined {
    return this.mediaEcc?.privateKey;
  }

  /**
   * Send one frame of a product's bundle as {@link renderFrame} builds it, with `$entryType` and the media `$key`:
   * the app's `getCrypto`, the session's P-256 point once a gateway info came as version 8 or for an `ability` of 128
   * up, else the RSA modulus. Header byte 14 is the frame's `counter` ({@link headerCounter}). Sealed by the session,
   * sent once and resent by DRW ({@link sendAcknowledged}).
   */
  sendFrame(frame: SessionFrame, channel: number, userId = "", ability = 0, entryType = 0): void {
    if (!this.connectAddress) throw new Error(`P2P session ${this.cfg.stationSn} is not connected`);
    const ecc = this.notifiedVersion8 || ability >= 128;
    let keyed = false;
    const { cmd, body, header } = renderFrame(frame, channel, userId, {
      $entryType: () => entryType,
      $key: () => ((keyed = true), ecc ? this.mediaEccPair().point : this.rsaModulus()),
    });
    const streamId = this.headerCounter(
      frame.counter === "bump" || frame.counter === "current" ? frame.counter : undefined,
    );
    if (keyed) {
      this.tracedDatagramGaps = 0;
      this.trace({ phase: "media-command", cmd, key: ecc ? "ecc" : "rsa" });
    }
    this.sendAcknowledged(() => {
      this.transmit(cmd, header, body, { streamId, text: frame.body !== "native" });
      return true;
    });
  }

  /**
   * Seal a command body as the app's `zx_p2p_send_command` does, by the session slots at the moment it seals:
   *  - sign mode <= 0 on a {@link LEVEL1_AT_SIGN0_PREFIXES} serial first takes the level-1 key into the ECB slot at
   *    sign mode 1; any other session below sign mode 1 sends in the clear;
   *  - 1001, 1054, 1060 and a 1350 whose JSON `cmd` is 1001 are AES-128-ECB under the ECB slot, sign byte 1 (1001
   *    and 1054 always, the others on a version-8 session, the sign mode otherwise);
   *  - any other command on a version-8 session is AES-256-GCM under the GCM slot, `tag(16) ‖ nonce(12) ‖ word(4) ‖
   *    ciphertext` with AAD "eufy security", version byte 8, sign byte = the mode, the word counted on per send;
   *  - otherwise AES-128-ECB under the ECB slot, sign byte = the mode. A `text` body is encrypted with its NUL.
   * An ECB slot that is not a 16-character key marks the slot -2 and sends that frame in the clear.
   */
  private seal(cmd: number, plaintext: Buffer, text: boolean): { body: Buffer; signCode: number; version: number } {
    const clear = { body: plaintext, signCode: 0, version: 1 };
    if (this.signMode <= 0 && this.level1AtSign0) {
      this.ecbKey = this.level1Key;
      this.signMode = 1;
    }
    if (this.signMode < 1 || cmd === CMD_PING) return clear;
    const v8 = this.sessionVersion === 8;
    const ecbOnly =
      cmd === 1001 || cmd === 1054 || cmd === 1060 || (cmd === CMD_SET_PAYLOAD && jsonCmdOf(plaintext) === 1001);
    if (v8 && !ecbOnly) {
      const body = gcmSeal(this.gcmKey!, plaintext, this.gcmWord);
      this.gcmWord = (this.gcmWord + 1) >>> 0;
      return { body, signCode: this.signMode, version: 8 };
    }
    if (!this.ecbKey || this.ecbKey.length !== 16 || this.ecbKey.includes(0)) {
      this.signMode = -2;
      return clear;
    }
    const signCode = cmd === 1001 || cmd === 1054 || (ecbOnly && v8) ? 1 : this.signMode;
    const body = text ? Buffer.concat([plaintext, Buffer.alloc(1)]) : plaintext;
    return { body: encryptP2PData(paddingP2PData(body), this.ecbKey), signCode, version: 1 };
  }

  /**
   * Send one command whose body is `plaintext`, sealed by {@link seal}, as the app's sender does. One that finds sign
   * mode 0 re-reads it every {@link SIGN0_POLL_MS} until it changes, at most {@link SIGN0_POLLS} times, then marks the
   * slot -1 (later sends no longer wait) and seals by what it finds. Header byte 11 is {@link commandCount}, byte 12 the
   * channel (0xff for {@link STATION_HEADER_COMMANDS}), byte 14 `streamId`; the sequence number and the counters are
   * taken when the datagram goes, and a send made inside
   * {@link sendAcknowledged} stays retained however late it goes. Nothing goes once its connection has ended.
   */
  private transmit(
    cmd: number,
    channel: number,
    plaintext: Buffer,
    opts: { streamId?: number; text?: boolean } = {},
  ): void {
    const generation = this.connectionGeneration;
    const retain = this.capturedCommands !== undefined;
    const go = (late: boolean): void => {
      if (!this.connectAddress || generation !== this.connectionGeneration) return;
      const sealed = this.seal(cmd, plaintext, opts.text === true);
      const counter = this.commandCount;
      this.commandCount = (this.commandCount + 1) & 0xff;
      const data = Buffer.concat([
        buildCommandHeader(this.seqNumber, cmd),
        buildRawCommandPayload(
          sealed.body,
          STATION_HEADER_COMMANDS.has(cmd) ? STATION_CHANNEL : channel,
          sealed.signCode,
          [sealed.version, counter],
          opts.streamId ?? 0,
        ),
      ]);
      this.seqNumber = (this.seqNumber + 1) & 0xffff;
      if (late && retain) this.retainCommand(data);
      this.send(this.connectAddress, RequestMessageType.DATA, data);
    };
    if (this.signMode !== 0) return go(false);
    let polls = 0;
    const poll = (): void => {
      if (this.signMode === 0 && ++polls < SIGN0_POLLS) return void setTimeout(poll, SIGN0_POLL_MS).unref?.();
      if (this.signMode === 0) this.signMode = -1;
      go(true);
    };
    setTimeout(poll, SIGN0_POLL_MS).unref?.();
  }

  /** Send the app's 1139 ping: no body, header channel 0xff, unsealed, counted and waited for like any command. */
  sendPing(): void {
    this.transmit(CMD_PING, STATION_CHANNEL, Buffer.alloc(0));
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
    this.logger.debug(`[p2p] ${this.cfg.stationSn} requestImage ${filePath}`);
    this.sendDatabasePayload(value, channel);
  }

  /**
   * Query an on-station database table over P2P (edge-AI face DB, event records, …).
   * Sends `CMD_SET_PAYLOAD{cmd:CMD_DATABASE, payload:{cmd:DB_QUERY.FULL_TABLE, table}}`.
   * The HomeBase streams back `CMD_DATABASE` (1306) frames `{cmd:10000,count,data:[…]}`,
   * level-1-encrypted — decoded and emitted as `dbChunk` (decrypted text) per frame.
   * Tables: `familiar_faces`, `person_basic_info`, `event_person_list`, `history_record_info`.
   *
   * Throws while a {@link readDatabase} is accumulating: every table answers `{data:[…]}` and the
   * frames tie no chunk to its request, so a second query's reply would be assembled into the first
   * one's buffer and answered as its rows.
   */
  queryDatabase(
    table: string,
    opts: { accountId?: string; channel?: number; query?: Record<string, unknown>; innerCmd?: number } = {},
  ): void {
    if (this.dbReadInFlight) throw new Error(`queryDatabase: ${this.cfg.stationSn} is already reading a table`);
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
    const value = setPayloadJson(CMD_DATABASE, inner, { accountId: opts.accountId, channel });
    this.logger.debug(`[p2p] ${this.cfg.stationSn} queryDatabase ${table} ch=${channel}`);
    this.sendDatabasePayload(value, channel);
  }

  /** Send the `CMD_SET_PAYLOAD` of a database read or stored-image request, sealed by the session. */
  private sendDatabasePayload(value: string, channel: number): void {
    this.transmit(CMD_SET_PAYLOAD, channel, Buffer.from(value, "utf-8"), { text: true });
  }

  /**
   * Request the on-device edge-AI **face roster** over P2P — the phone-free path.
   *
   * NOT a dedicated face command (the `1194`/`1195` path never responds on a HomeBase). The
   * app reads the DB directly: a `CMD_DATABASE` (1306) query of `person_basic_info` with inner
   * `cmd 10000` on `mChannel 255`. The HomeBase replies with the level-1 `CMD_DATABASE` response
   * (reassembled by `onData`, surfaced via `dbChunk`) listing every person: `{person_id, name,
   * relation, group_id, …}` — `stranger\d+` names are auto-assigned (unfamiliar). ~10 KB.
   * Shaped as the app's own request. `account_id` must be the station
   * `admin_user_id` (a wrong/absent id or a camera session answers result `-104`).
   */
  requestFaces(opts: { accountId?: string; channel?: number } = {}): void {
    this.queryDatabase("person_basic_info", {
      accountId: opts.accountId,
      channel: opts.channel,
      innerCmd: DB_QUERY.FULL_TABLE,
      query: fullTableQuery(),
    });
  }

  /**
   * Read a date-ranged page of `history_record_info` from the station. The reply's `data` array groups
   * recording rows with companion tables; each group retains its `table_name` and `payload`.
   * `startTime` is `"0"` for the newest page or the oldest row's `yyyyMMddHHmmss` cursor for older rows.
   */
  queryRecordPage(opts: {
    accountId?: string;
    startDate: string;
    endDate: string;
    startTime?: string;
    count?: number;
  }): Promise<unknown[]> {
    return this.readDatabase("history_record_info", {
      accountId: opts.accountId,
      innerCmd: DB_QUERY.QUERY_LOCAL,
      query: {
        count: opts.count ?? 20,
        start_date: opts.startDate,
        end_date: opts.endDate,
        start_time: opts.startTime ?? "0",
        event_type: 0,
        ai_type: 0,
        storage_cloud: -1,
        trigger_type: 0,
        detection_type: 0,
        flag: 0,
      },
    });
  }

  /**
   * Query one on-station table and answer its rows, once the reply is whole.
   *
   * The request half of {@link queryDatabase} with its reply assembled: `CMD_DATABASE` arrives as
   * several frames whose decrypted text is a fragment of one document, so the fragments are
   * accumulated here and scanned after each one. Answers that document's `data` rows. Rejects when
   * `signal` aborts, and when `timeoutMs` (default {@link DB_TABLE_TIMEOUT_MS}) elapses with no
   * complete reply, and when the station answers a non-zero `mIntRet`.
   *
   * One read at a time per session: while one is accumulating, every {@link queryDatabase} on the
   * session throws, so a second reply cannot land in this buffer.
   */
  async readDatabase(
    table: string,
    opts: {
      accountId?: string;
      innerCmd?: number;
      query?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown[]> {
    if (opts.signal?.aborted) throw new Error("readDatabase: aborted");
    this.queryDatabase(table, {
      accountId: opts.accountId,
      innerCmd: opts.innerCmd,
      query: opts.query ?? fullTableQuery(),
    });
    this.dbReadInFlight = true;
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        let text = "";
        const onChunk = (chunk: { text: string }): void => {
          text += chunk.text;
          const result = firstTableRows(text);
          if (result?.error !== undefined)
            settle(() => reject(new Error(`readDatabase: ${table} refused: ${result.error}`)));
          else if (result?.rows) settle(() => resolve(result.rows!));
        };
        const timer = setTimeout(
          () => settle(() => reject(new Error(`readDatabase: ${this.cfg.stationSn} sent no complete ${table}`))),
          opts.timeoutMs ?? DB_TABLE_TIMEOUT_MS,
        );
        const onAbort = (): void => settle(() => reject(new Error("readDatabase: aborted")));
        const settle = (finish: () => void): void => {
          clearTimeout(timer);
          this.off("dbChunk", onChunk);
          opts.signal?.removeEventListener("abort", onAbort);
          finish();
        };

        this.on("dbChunk", onChunk);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      this.dbReadInFlight = false;
    }
  }

  /** Whether a {@link readDatabase} is accumulating; see {@link queryDatabase} for what it bars. */
  private dbReadInFlight = false;

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
      query: fullTableQuery(),
    });
  }

  /**
   * Low-level: send a `CMD_SET_PAYLOAD` (1350) wrapping `{account_id, cmd:<subCmd>, mChannel,
   * payload, transaction}`, sealed by the session. The reply arrives as a `NOTIFY_PAYLOAD`
   * (1351) frame (surfaced via the `data` event / `frame.json`).
   *
   * `opts.key` makes it a keyed envelope: the sealed per-command key rides ahead of the other fields
   * as the value's `key`, and the value goes out unencrypted, encryption-type 0, with `=` written
   * `=` — the form the vendor app sends one in, and the one form the device reads it in.
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
      key?: string;
      /** The payload's keys at the top level of the envelope, in place of `payload`. */
      unzip?: boolean;
      /** Header byte 14: the session counter bumped, or as it stands — see {@link headerCounter}. */
      counter?: "bump" | "current";
      /** The envelope's `mValue3`: 0 unless given, as the app sends it for every subCmd but 1025. */
      mValue3?: number;
    } = {},
  ): void {
    if (!this.connectAddress) throw new Error("not connected");
    const channel = opts.channel ?? 0;
    const keyed = opts.key !== undefined;
    const json = opts.rawValue ? JSON.stringify(opts.rawValue) : setPayloadJson(subCmd, payload, { ...opts, channel });
    const value = keyed ? json.replace(/=/g, "\\u003d") : json;
    const cmd = opts.wrapCmd ?? CMD_SET_PAYLOAD;
    const streamId = this.headerCounter(opts.counter);
    this.logger.debug(`[p2p] ${this.cfg.stationSn} sendSetPayload subCmd=${subCmd}`);
    this.transmit(cmd, channel, Buffer.from(value, "utf-8"), { streamId, text: true });
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
   * Only once the data type's reorder wait passes, or {@link REORDER_MAX_DATAGRAMS} pile up, is the datagram
   * treated as lost: a pending frame is discarded and delivery resumes from the earliest held datagram.
   *
   * A datagram shorter than the 8-byte DATA header carries no sequence number and is dropped unacknowledged.
   */
  private onData(msg: Buffer, addr: Address): void {
    if (msg.length < 8) return;
    const dataTypeBuffer = msg.subarray(4, 6);
    const seqNo = msg.subarray(6, 8).readUInt16BE();
    const dataType = dataTypeBuffer[1]; // 0=DATA 1=VIDEO 2=CONTROL 3=BINARY
    this.send(addr, RequestMessageType.ACK, buildAckPayload(this.ackTypeHeader(dataType), seqNo));

    const prevSeq = this.lastSeqByType.get(dataType);
    const advance = prevSeq === undefined ? 1 : (seqNo - prevSeq) & 0xffff;
    if (advance === 0) return;
    if (advance > SEQUENCE_LOOKBACK) {
      if (0x10000 - advance <= STALE_RETRANSMIT_DEPTH) return;
      if (
        (dataType === P2PDataType.VIDEO || this.pendingByDataType.has(dataType)) &&
        this.tracedDatagramGaps++ < MAX_TRACED_DATAGRAM_GAPS
      )
        this.trace({ phase: "sequence-restart", dataType });
      this.clearReorderTimer(dataType);
      this.reorderByType.delete(dataType);
      this.pendingByDataType.delete(dataType);
      if (dataType === P2PDataType.VIDEO) this.emit("videoGap");
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
    const timer = setTimeout(
      () => {
        reorder.timer = undefined;
        this.abandonHole(dataType);
      },
      dataType === P2PDataType.VIDEO ? VIDEO_REORDER_WAIT_MS : REORDER_WAIT_MS,
    );
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
    if (
      (dataType === P2PDataType.VIDEO || this.pendingByDataType.has(dataType)) &&
      this.tracedDatagramGaps++ < MAX_TRACED_DATAGRAM_GAPS
    )
      this.trace({ phase: "datagram-gap", dataType });
    this.pendingByDataType.delete(dataType);
    if (dataType === P2PDataType.VIDEO) this.emit("videoGap");
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

  /**
   * Reassemble one in-sequence datagram body into logical frames.
   *
   * Frames are packed back to back, so a frame header can itself be cut by a datagram boundary. The start
   * of a header left at the end of a datagram is carried into the next one rather than discarded; dropping
   * it would lose that frame and every frame after it until a datagram happened to begin on a header.
   * Payload fragments retain their original slices and are copied once, when the complete frame is delivered.
   */
  private reassemble(dataType: number, datagramBody: Buffer): void {
    const pending = this.pendingByDataType.get(dataType);
    this.pendingByDataType.delete(dataType);
    let body = pending && !pending.header ? Buffer.concat([...pending.chunks, datagramBody]) : datagramBody;

    if (pending?.header) {
      const taken = Math.min(pending.header.bytesToRead - pending.byteLength, body.length);
      pending.chunks.push(body.subarray(0, taken));
      pending.byteLength += taken;
      body = body.subarray(taken);
      if (pending.byteLength < pending.header.bytesToRead) {
        this.pendingByDataType.set(dataType, pending);
        return;
      }
      this.handleFrame(pending.header, Buffer.concat(pending.chunks, pending.byteLength), dataType);
    }

    while (body.length >= P2P_DATA_HEADER_BYTES && body.subarray(0, 4).toString() === MAGIC_WORD) {
      const header = parseDataFrameHeader(body);
      const payload = body.subarray(P2P_DATA_HEADER_BYTES);
      if (payload.length < header.bytesToRead) {
        this.pendingByDataType.set(dataType, { header, chunks: [payload], byteLength: payload.length });
        return;
      }
      this.handleFrame(header, payload.subarray(0, header.bytesToRead), dataType);
      body = body.subarray(P2P_DATA_HEADER_BYTES + header.bytesToRead);
    }
    if (
      body.length > 0 &&
      body.length < P2P_DATA_HEADER_BYTES &&
      MAGIC_WORD.startsWith(body.subarray(0, 4).toString())
    ) {
      this.pendingByDataType.set(dataType, { chunks: [body], byteLength: body.length });
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

  /**
   * Decrypt and dispatch one inbound data frame.
   *
   * A `CMD_GATEWAYINFO` (1100) reply carries the ECIES envelope for the level-2 session key. When a
   * cipher-key resolver is configured, the key of the reply's own header version is not held (the app holds the
   * ECC and the RSA key apart) and no negotiation is in flight, the reply starts one (async, fire-and-forget);
   * a reply landing while one is in flight is ignored.
   *
   * A `CMD_DATABASE` (1306) reply opened with the session key is emitted as that opened text; a level-1 pass
   * over its raw bytes would be noise.
   */
  private handleFrame(header: P2PDataFrameHeader, payload: Buffer, dataType: number): void {
    if (dataType !== P2PDataType.CONTROL) return this.dispatchFrame(header, payload, dataType);
    if (this.heldNotifies) return void this.heldNotifies.push([header, payload, dataType]);
    this.dispatchFrame(header, payload, dataType);
    this.checkGatewayResend();
  }

  /**
   * The app's 1100 resend check: at most once per {@link GATEWAY_CHECK_MS}, while the slot is below sign mode 1 or its
   * ECB key is empty, every third check sends the header-only `CMD_GATEWAYINFO` again, with no limit.
   */
  private checkGatewayResend(): void {
    const now = Date.now();
    if (now - this.gatewayCheck.atMs <= GATEWAY_CHECK_MS) return;
    this.gatewayCheck.atMs = now;
    if (this.signMode >= 1 && this.ecbKey) return;
    if (++this.gatewayCheck.runs < 3) return;
    this.gatewayCheck.runs = 0;
    this.sendCommand(CMD_GATEWAYINFO);
  }

  /** Open and dispatch one inbound frame — see {@link handleFrame}. */
  private dispatchFrame(header: P2PDataFrameHeader, payload: Buffer, dataType: number): void {
    let data = payload;
    // Media frames (video 1300 / audio 1301) are NOT level-1/2 control frames — their bodies use the
    // per-frame video cipher (RSA-wrapped AES, see decodeVideoFrame) or are plaintext. Leave them raw
    // so the generic control decrypt below doesn't corrupt them; LiveStream decodes video via
    // decodeVideoFrame and strips the audio header itself.
    const isMedia = header.commandId === CMD_VIDEO_FRAME || header.commandId === CMD_AUDIO_FRAME;
    if (!isMedia && payload.length > 0) data = this.openFrame(header, payload);
    const openedLevel2 = data !== payload && header.signCode >= 2;
    if (header.commandId === CMD_GATEWAYINFO) {
      this.logger.debug(
        `[p2p] ${this.cfg.stationSn} level-2 gateway info v${header.version} ch ${header.channel} sign ${header.signCode} ${data.length}B (cipher_id ${data.length >= 4 ? data.readInt32LE(0) : 0})`,
      );
      this.negotiateLevel2Key(data, header.version);
    }
    if (header.commandId === CMD_DATABASE && openedLevel2) {
      this.emit("dbChunk", { stationSn: this.cfg.stationSn, text: data.toString("latin1") });
    } else if (header.commandId === CMD_DATABASE && header.signCode > 0) {
      // Otherwise the reply chunks are level-1 encrypted with a trailing byte past the block boundary, which
      // opens as noise: only the block-aligned head is the JSON-ish text fragment the caller accumulates.
      const n = data.length - (data.length % 16);
      if (n >= 16)
        this.emit("dbChunk", { stationSn: this.cfg.stationSn, text: data.subarray(0, n).toString("latin1") });
    } else if (header.commandId === CMD_DATABASE) {
      this.emit("dbChunk", { stationSn: this.cfg.stationSn, text: payload.toString("latin1") });
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
      const stationTable = header.commandId === CMD_CAMERA_INFO && header.channel === STATION_CHANNEL;
      const byChannel = stationTable ? channelReport(frame.json) : undefined;
      const reported =
        header.commandId === CMD_NOTIFY_PAYLOAD
          ? paramReport(frame.json?.payload)
          : header.commandId === CMD_CAMERA_INFO && !stationTable
            ? paramReport(frame.json)
            : undefined;
      if (byChannel) frame.channelParams = byChannel;
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
    // Channel 0 carries the answers to commands, read by the app's `zx_p2p_get_exec_result` by command id alone and
    // never decrypted: an empty body is code 0, a body of 1 to 132 bytes its first int32 LE, a longer one its length.
    if (dataType === P2PDataType.DATA) {
      const n = payload.length;
      const code = n === 0 ? 0 : n <= RESULT_BODY_MAX ? Buffer.concat([payload, Buffer.alloc(4)]).readInt32LE(0) : n;
      this.emit("commandResult", { code, channel: header.channel, commandId: header.commandId });
    }
    this.emit("data", frame);
  }

  /** Skips a port outside 1..65535 like a failed send; dgram would throw on it, uncaught in the message listener. */
  private send(addr: Address, type: Buffer, payload?: Buffer, socket = this.socket, done?: () => void): void {
    if (!socket) return;
    if (addr.port < 1 || addr.port > 65535) {
      this.logger.debug(`[p2p] send skipped ${addr.host}:${addr.port}: not a UDP port`);
      done?.();
      return;
    }
    if (type === RequestMessageType.DATA && payload) this.capturedCommands?.push(payload);
    const packet = frameMessage(type, payload);
    socket.send(packet, addr.port, addr.host, (err) => {
      if (err) this.logger.warn(`[p2p] send err ${addr.host}:${addr.port}`, err.message);
      done?.();
    });
  }

  /** Finish the END send on the current socket before closing it; send completion is not a peer ACK. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopPunchProbes();
    this.connectionGeneration += 1;
    this.resetSlots();
    this.connected = false;
    this.connecting = false;
    if (this.lookupTimer) clearInterval(this.lookupTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.relay = undefined;
    if (this.audioRetransmitTimer) clearInterval(this.audioRetransmitTimer);
    this.audioRetransmitTimer = undefined;
    this.unackedAudio.clear();
    this.audioStalled = false;
    this.clearCommandRetransmit();
    this.unackedCommands.clear();
    this.resetInboundSequencing();
    const socket = this.socket;
    if (socket && this.connectAddress) {
      await new Promise<void>((resolve) =>
        this.send(this.connectAddress!, RequestMessageType.END, undefined, socket, resolve),
      );
    }
    await new Promise<void>((resolve) => {
      if (!socket) return resolve();
      socket.close(() => resolve());
    });
    this.socket = undefined;
    this.emit("close");
  }
}
