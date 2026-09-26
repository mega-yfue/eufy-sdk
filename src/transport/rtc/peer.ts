/**
 * The WebRTC peer for a T9000 session — libdatachannel through `node-datachannel`, driven the way the
 * portal drives a browser's RTCPeerConnection.
 *
 * The hub is the offerer: it sends its SDP once it has granted the session, we answer. Six data channels
 * are declared in the portal's order (`WebrtcDataChannel` first — the command channel — then audio, idr,
 * video, notify, download). Every one of them carries PTCS-framed portal packets; which logical channel
 * a reassembled frame belongs to is the PTCS header's channel (command / notify / live / …), not the
 * data channel it rode on, and the portal's own receiver reads it the same way.
 *
 * ICE on a LAN is deliberately **host-only** by default. The hub offers a TURN relay and a
 * server-reflexive candidate too, and both pass STUN checks — so ICE may nominate one — yet neither
 * completes DTLS on current firmware: if one wins the race the handshake stalls ~31 s and drops. Keeping
 * only host candidates on both sides settles ICE on the direct LAN pair every time, which is also what
 * the phone does on the same network (captured: ICE straight to the station's LAN address).
 *
 * The native peer is injectable so the state machine is testable without a network.
 */

import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { PortalFramer, PortalFramerFactory } from "./framer.js";
import { PortalLinkType } from "./portal-packet.js";
import { PtcsFramer } from "./ptcs-framer.js";
import {
  ANKER_MAX_MESSAGE_SIZE,
  HUB_SDP_MID,
  forceDtlsRole,
  iceCandidateType,
  keepHostCandidates,
  pinMaxMessageSize,
  sdpToScallJson,
} from "./scall-sdp.js";

export type IcePolicy = "host-only" | "all" | "relay";

export interface TurnConfig {
  turn_addr: string;
  turn_port: number;
  turn_user: string;
  turn_password: string;
  alt_turn_addr?: string;
  alt_turn_port?: number;
}

/** The slice of `node-datachannel`'s `DataChannel` the peer uses. */
export interface NativeDataChannel {
  getLabel(): string;
  isOpen(): boolean;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

/** The slice of `node-datachannel`'s `PeerConnection` the peer uses. */
export interface NativePeerConnection {
  close(): void;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void;
  localDescription(): { type: string; sdp: string } | null;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: { id?: number; unordered?: boolean }): NativeDataChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onGatheringStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: NativeDataChannel) => void): void;
}

export interface NativeIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: "TurnUdp" | "TurnTcp" | "TurnTls";
}

export interface NativePeerConfig {
  iceServers: NativeIceServer[];
  iceTransportPolicy: "all" | "relay";
  maxMessageSize: number;
  enableIceTcp: boolean;
  bindAddress?: string;
}

export type NativePeerFactory = (name: string, config: NativePeerConfig) => NativePeerConnection;

export interface RtcPeerOptions {
  icePolicy?: IcePolicy;
  /** Local interface to bind; helps a multi-homed host pick the LAN the hub is on. */
  bindAddress?: string;
  createPeer?: NativePeerFactory;
  createFramer?: PortalFramerFactory;
  logger?: Logger;
  /** How long to wait for libdatachannel to produce the local answer. */
  answerTimeoutMs?: number;
  /**
   * Pin OUR DTLS role, by pinning the complement into the hub's offer before it is applied — the role
   * has to be fixed where it is DECIDED, since rewriting our own answer changes only what we announce
   * and deadlocks the handshake.
   *
   * Defaults to `active`, which is what the portal plays: left to itself libdatachannel answers
   * `passive`, taking the odd stream ids while the hub is paired with the even ones. Pass `undefined`
   * to leave the hub's `actpass` alone and let libdatachannel choose.
   */
  dtlsRole?: "active" | "passive";
  /**
   * How to assign SCTP stream ids: `portal` (default) pins the portal's odd ids, which match the DTLS
   * server role libdatachannel takes; `auto` leaves the choice to libdatachannel.
   */
  dataChannelIds?: "auto" | "portal";
}

export interface RtcPeerEvents {
  commandChannelOpen: [];
  /** The command channel went away while the peer itself may still be up. */
  commandChannelClosed: [];
  data: [label: string, frame: Buffer, linkType: number];
  iceCandidate: [candidate: string];
  iceGatheringComplete: [];
  connectionState: [state: string];
  error: [err: Error];
}

/** The portal's channel list; index 0 is the command channel. */
export const DATA_CHANNEL_LABELS = ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"] as const;
export const COMMAND_CHANNEL = DATA_CHANNEL_LABELS[0];

/** Which logical channel a reassembled frame belongs to, named after the portal's data channels. */
export function labelForLinkType(linkType: number): string {
  switch (linkType) {
    case PortalLinkType.NOTIFY:
      return "notify";
    case PortalLinkType.LIVE:
      return "video";
    case PortalLinkType.FILE:
      return "download";
    case PortalLinkType.PLAYBACK:
      return "playback";
    default:
      return COMMAND_CHANNEL;
  }
}
/**
 * SCTP stream ids the portal assigns, read off its own live session: its `WebrtcDataChannel` is id
 * **0**, and the rest follow in channel order. Even ids are the DTLS **client**'s half under RFC 8832,
 * which says what the portal is — and therefore what we have to be, since the hub pairs with one side
 * of that split and ignores channels opened on the other. Hence the `active` default in
 * {@link RtcPeerOptions.dtlsRole}: the two are one decision, not two.
 */
const DATA_CHANNEL_IDS: Record<string, number> = {
  WebrtcDataChannel: 0,
  audio: 2,
  idr: 4,
  video: 6,
  notify: 8,
  download: 10,
};

function turnServers(turn: TurnConfig): NativeIceServer[] {
  const both = (hostname: string, port: number): NativeIceServer[] => [
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnUdp" },
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnTcp" },
  ];
  const servers = both(turn.turn_addr, turn.turn_port);
  if (turn.alt_turn_addr && turn.alt_turn_port) servers.push(...both(turn.alt_turn_addr, turn.alt_turn_port));
  return servers;
}

async function loadNativePeerFactory(): Promise<NativePeerFactory> {
  // `node-datachannel` is an OPTIONAL dependency: only a T9000 (S1 Pro) station needs the WebRTC
  // transport. It still installs by default (npm installs optionalDependencies; a consumer opts out
  // with `--omit=optional`, and a failed install of it doesn't fail the overall install). What this
  // dynamic import buys is deferring the native addon's *load* until a T9000 is actually driven, with
  // a clear message if it is absent rather than a bare module-not-found.
  let ndc: typeof import("node-datachannel");
  try {
    ndc = await import("node-datachannel");
  } catch (err) {
    throw new Error(
      "the WebRTC transport for a HomeBase S1 Pro (T9000) needs the optional 'node-datachannel' package — " +
        "install it to drive a T9000 over RTC (`npm install node-datachannel`)",
      { cause: err },
    );
  }
  return (name, config) => new ndc.PeerConnection(name, config as never) as unknown as NativePeerConnection;
}

export class RtcPeer extends EventEmitter<RtcPeerEvents> {
  private pc?: NativePeerConnection;
  private readonly channels = new Map<string, NativeDataChannel>();
  private framer?: PortalFramer;
  private readonly wireTally = new Map<string, number>();
  private framerInit?: Promise<void>;
  private commandOpen = false;
  private remoteSet = false;
  private handlingOffer = false;
  private channelsCreated = false;
  private gatheringDone = false;
  /** Set by the framer's wire callback when the native channel refused a packet mid-send. */
  private wireSendFailed = false;
  private readonly pending: string[] = [];
  private localAnswer?: { resolve: (sdp: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private readonly icePolicy: IcePolicy;
  private readonly logger: Logger;
  private readonly createFramer: PortalFramerFactory;

  constructor(private readonly opts: RtcPeerOptions = {}) {
    super();
    this.icePolicy = opts.icePolicy ?? "host-only";
    this.logger = opts.logger ?? noopLogger;
    this.createFramer = opts.createFramer ?? (() => new PtcsFramer());
  }

  /** Create the native peer. `turn` is what the hub granted in `scall 100`; unused under `host-only`. */
  async init(turn?: TurnConfig): Promise<void> {
    if (this.pc) return;
    const createPeer = this.opts.createPeer ?? (await loadNativePeerFactory());
    const config: NativePeerConfig = {
      iceServers: this.icePolicy === "host-only" || !turn ? [] : turnServers(turn),
      iceTransportPolicy: this.icePolicy === "relay" ? "relay" : "all",
      maxMessageSize: ANKER_MAX_MESSAGE_SIZE,
      enableIceTcp: true,
    };
    if (this.opts.bindAddress) config.bindAddress = this.opts.bindAddress;
    const pc = createPeer("eufy-sdk", config);
    this.pc = pc;
    pc.onLocalDescription((sdp, type) => {
      if (String(type).toLowerCase() === "answer" && this.localAnswer) {
        clearTimeout(this.localAnswer.timer);
        this.localAnswer.resolve(sdp);
        this.localAnswer = undefined;
      }
    });
    pc.onLocalCandidate((candidate) => {
      if (!candidate) return;
      if (!this.acceptsCandidate(candidate)) return;
      this.emit("iceCandidate", candidate);
    });
    pc.onGatheringStateChange((state) => {
      if (state === "complete" && !this.gatheringDone) {
        this.gatheringDone = true;
        this.emit("iceGatheringComplete");
      }
    });
    pc.onStateChange((state) => {
      this.logger.debug(`[rtc] peer state ${state}`);
      this.emit("connectionState", state);
    });
    pc.onDataChannel((dc) => this.wireChannel(dc.getLabel(), dc));
  }

  /** The hub offered: declare our channels, apply the offer, return the answer SDP to signal back. */
  async handleRemoteOffer(offerSdp: string): Promise<string> {
    const pc = this.pc;
    if (!pc) throw new Error("RTC peer not initialised");
    if (this.handlingOffer) throw new Error("RTC peer already handling an offer");
    this.handlingOffer = true;
    try {
      let offer = this.icePolicy === "host-only" ? keepHostCandidates(offerSdp) : offerSdp;
      // Choosing our DTLS role means editing the role in the HUB's offer, not in our answer. The hub
      // offers `actpass` and leaves the choice to libdatachannel; rewriting our answer afterwards only
      // changes what we ANNOUNCE, never the role libdatachannel plays, which deadlocks the handshake.
      // Pinning the offer to one concrete role leaves libdatachannel exactly one legal answer — the
      // complement — so what we announce and what we do are the same thing.
      const dtlsRole = "dtlsRole" in this.opts ? this.opts.dtlsRole : "active";
      if (dtlsRole) offer = forceDtlsRole(offer, dtlsRole === "passive" ? "active" : "passive");
      const answerWait = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.localAnswer = undefined;
          reject(new Error("timed out waiting for the local SDP answer"));
        }, this.opts.answerTimeoutMs ?? 15_000);
        this.localAnswer = { resolve, reject, timer };
      });
      // The hub's offer goes in FIRST, and the channels are declared onto the answer it puts us in.
      // Creating them first is what a reader expects — the answer should describe them — but
      // `createDataChannel` makes libdatachannel negotiate on its own: it fires `negotiationNeeded` and
      // produces a local OFFER, leaving the peer in `have-local-offer` when the hub's offer arrives.
      // Whoever won that race decided the session, and the losing side shipped our offer as the answer:
      // the hub then ran its connectivity checks against an ICE ufrag/pwd nobody was listening on, so
      // ICE failed with a textbook-looking signalling log. Data channels need no m-line of their own —
      // the offer already carries the SCTP one — so declaring them after costs nothing.
      pc.setRemoteDescription(offer, "offer");
      this.remoteSet = true;
      this.createChannels();
      // Only an ANSWER counts. `localDescription()` also answers while the peer sits in
      // `have-local-offer`, and taking that would ship the offer as the answer — the same failure by a
      // shorter path.
      const local = pc.localDescription();
      let answer = String(local?.type ?? "").toLowerCase() === "answer" ? (local?.sdp ?? "") : "";
      if (!answer) answer = await answerWait;
      else if (this.localAnswer) {
        clearTimeout(this.localAnswer.timer);
        this.localAnswer = undefined;
      }
      this.flushPending();
      return pinMaxMessageSize(answer);
    } finally {
      this.handlingOffer = false;
    }
  }

  /** Our answer, in the JSON shape the hub parses (`info` with `sdp`). */
  answerAsScallJson(answerSdp: string): string {
    return JSON.stringify(sdpToScallJson(answerSdp));
  }

  addRemoteCandidate(candidate: string): void {
    if (!this.pc) return;
    if (!this.acceptsCandidate(candidate)) return;
    if (!this.remoteSet || this.handlingOffer) {
      this.pending.push(candidate);
      return;
    }
    this.addNow(candidate);
  }

  get isCommandChannelReady(): boolean {
    const dc = this.channels.get(COMMAND_CHANNEL);
    return this.commandOpen && !!dc?.isOpen();
  }

  /**
   * Send one portal packet on the command channel, through the framer. False when the channel is not
   * usable OR the native send refused a wire packet — a dropped frame must not read as success.
   */
  /**
   * Send bytes on the command channel AS THEY ARE — no PTCS framing. The portal's data-channel keepalive
   * (a 20-byte prefix + a bare `XZYH 1139`, every ~29 s, echoed by the hub) rides the wire unframed, and the
   * framer would wrap it. False when the channel isn't open.
   */
  sendRaw(bytes: Buffer): boolean {
    const dc = this.channels.get(COMMAND_CHANNEL);
    if (!dc?.isOpen()) return false;
    return dc.sendMessageBinary(bytes);
  }

  sendCommand(portalPacket: Buffer): boolean {
    const dc = this.channels.get(COMMAND_CHANNEL);
    if (!dc?.isOpen() || !this.commandOpen || !this.framer?.isReady()) return false;
    this.wireSendFailed = false;
    try {
      this.framer.sendFrame(portalPacket);
    } catch (e) {
      this.logger.warn(`[rtc] command send failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return !this.wireSendFailed;
  }

  close(): void {
    this.framer?.destroy();
    this.framer = undefined;
    this.framerInit = undefined;
    if (this.localAnswer) {
      // Reject rather than drop: handleRemoteOffer is awaiting this, and a silent drop hangs it.
      clearTimeout(this.localAnswer.timer);
      const pending = this.localAnswer;
      this.localAnswer = undefined;
      pending.reject(new Error("RTC peer closed while waiting for the local SDP answer"));
    }
    this.commandOpen = false;
    this.gatheringDone = false;
    this.pc?.close();
    this.pc = undefined;
    this.channels.clear();
    this.channelsCreated = false;
    this.remoteSet = false;
    this.pending.length = 0;
  }

  private acceptsCandidate(candidate: string): boolean {
    const type = iceCandidateType(candidate);
    if (this.icePolicy === "host-only") return type === "host";
    if (this.icePolicy === "relay") return type === "relay";
    return true;
  }

  private createChannels(): void {
    if (!this.pc || this.channelsCreated) return;
    this.channelsCreated = true;
    for (const label of DATA_CHANNEL_LABELS) {
      const pinned = this.opts.dataChannelIds === "auto" ? undefined : DATA_CHANNEL_IDS[label];
      const dc = this.pc.createDataChannel(label, { id: pinned, unordered: false });
      this.wireChannel(label, dc);
    }
  }

  private wireChannel(label: string, dc: NativeDataChannel): void {
    if (this.channels.has(label)) return;
    this.channels.set(label, dc);
    dc.onOpen(() => {
      this.logger.debug(`[rtc] data channel open ${label}`);
      if (label !== COMMAND_CHANNEL) return;
      void this.initFramer(dc)
        .then(() => {
          if (!this.pc || !dc.isOpen() || !this.framer?.isReady()) return;
          this.commandOpen = true;
          this.emit("commandChannelOpen");
        })
        .catch((e: unknown) => {
          if (!this.pc || !dc.isOpen()) return;
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        });
    });
    dc.onClosed(() => {
      this.logger.debug(`[rtc] data channel closed ${label}`);
      if (label !== COMMAND_CHANNEL) return;
      // The command path is the session: announce it so a caller stops believing it is connected.
      const wasOpen = this.commandOpen;
      this.commandOpen = false;
      if (wasOpen) this.emit("commandChannelClosed");
    });
    dc.onError((err) => this.emit("error", new Error(`RTC data channel ${label}: ${err}`)));
    dc.onMessage((msg) => {
      const buf = typeof msg === "string" ? Buffer.from(msg) : Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      // Per-channel wire tally (debug): the first packets of each label, then one line per 100.
      const n = (this.wireTally.get(label) ?? 0) + 1;
      this.wireTally.set(label, n);
      if (n <= 3 || n % 100 === 0) {
        this.logger.debug(`[rtc] wire ${label} #${n} ${buf.length}B ${buf.subarray(0, 8).toString("hex")}`);
      }
      if (this.framer?.isReady()) {
        this.framer.recvPacket(buf);
        return;
      }
      // Before the framer is up (the command channel not open yet) nothing can be reassembled.
      this.emit("data", label, buf, 0);
    });
  }

  private initFramer(dc: NativeDataChannel): Promise<void> {
    if (this.framerInit) return this.framerInit;
    const framer = this.createFramer();
    this.framer = framer;
    this.framerInit = framer
      .init(
        (packet) => {
          if (!dc.isOpen() || !dc.sendMessageBinary(packet)) this.wireSendFailed = true;
        },
        (frame, linkType) => this.emit("data", labelForLinkType(linkType), frame, linkType),
      )
      .catch((e: unknown) => {
        if (this.framer === framer) {
          framer.destroy();
          this.framer = undefined;
          this.framerInit = undefined;
        }
        throw e;
      });
    return this.framerInit;
  }

  private addNow(candidate: string): void {
    try {
      this.pc?.addRemoteCandidate(candidate, HUB_SDP_MID);
    } catch (e) {
      this.logger.warn(`[rtc] addRemoteCandidate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private flushPending(): void {
    const queued = this.pending.splice(0);
    for (const c of queued) this.addNow(c);
  }
}
