/**
 * One T9000 command session end to end: sign → signalling socket → `scall` → the hub's SDP offer →
 * our answer → ICE → DTLS → the command data channel open.
 *
 * The signalling exchange, as the portal runs it and as confirmed live:
 *
 *   → scall                          (action 3, channel 0, the hub's own session)
 *   ← scall {status: 100, turn}      the hub granted the session and handed out TURN credentials
 *   ← info  {sdp | format:"SDP"}     the hub's offer, as scall JSON
 *   → info  {sdp}                    the answer
 *   ↔ info  {candidate}              trickle ICE on the same channel; "" ends it
 *   ← scall {status: 200}            → ack
 *   ← scall {status: 486 | 408}      busy / timeout: the session fails
 *   ← hangup                         the hub ended it
 *
 * The command data channel is the session: `close` fires once, when the channel closes, the peer fails,
 * the signalling socket drops or {@link RtcSession.close} is called, even while the peer connection is
 * nominally up.
 *
 * Both the signalling client and the peer are injectable.
 */

import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../../core/logger.js";
import { RtcPeer, type RtcPeerOptions, type TurnConfig } from "./peer.js";
import { PortalLinkType } from "./portal-packet.js";
import { scallJsonToSdp, sdpToScallJson, toWireCandidate } from "./scall-sdp.js";
import { RtcSignalingClient, type RtcInnerMessage, type RtcSignalingOptions } from "./signaling.js";

export interface RtcSessionOptions extends RtcSignalingOptions {
  peer?: RtcPeerOptions;
  createSignaling?: (opts: RtcSignalingOptions) => RtcSignalingClient;
  createPeer?: (opts: RtcPeerOptions) => RtcPeer;
}

/** How long the signalling auth may take. */
const AUTH_TIMEOUT_MS = 15_000;

export interface RtcSessionEvents {
  connected: [];
  close: [];
  error: [err: Error];
  /** A reassembled command or notify frame: portal packet bytes + the link type it arrived on. */
  commandData: [frame: Buffer, linkType: number];
  /** A reassembled live-video frame. */
  mediaData: [frame: Buffer];
}

interface CallPayload {
  status?: number;
  turn?: TurnConfig;
}

interface InfoPayload {
  format?: string;
  value?: string;
  candidate?: string;
  sdp?: string;
}

export class RtcSession extends EventEmitter<RtcSessionEvents> {
  private readonly signaling: RtcSignalingClient;
  private readonly peer: RtcPeer;
  private readonly logger: Logger;
  private turn?: TurnConfig;
  private authOk = false;
  private authWaiter?: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private connected = false;
  private closed = false;
  private closeAnnounced = false;
  private sdpHandled = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RtcSessionOptions) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.signaling = (opts.createSignaling ?? ((o) => new RtcSignalingClient(o)))(opts);
    this.peer = (opts.createPeer ?? ((o) => new RtcPeer(o)))({ logger: this.logger, ...opts.peer });

    this.signaling.on("message", (inner) => {
      this.chain = this.chain
        .then(() => this.onSignaling(inner))
        .catch((e: unknown) => {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        });
    });
    this.signaling.on("close", () => {
      this.connected = false;
      this.announceClose();
    });
    this.signaling.on("error", (e) => this.emit("error", e));

    this.peer.on("iceCandidate", (c) => this.signaling.sendInfoCandidate(toWireCandidate(c)));
    this.peer.on("iceGatheringComplete", () => this.signaling.sendInfoCandidate(""));
    this.peer.on("commandChannelOpen", () => {
      if (this.connected) return;
      this.connected = true;
      this.logger.debug(`[rtc] ${this.opts.stationSn} command channel open`);
      this.emit("connected");
    });
    this.peer.on("commandChannelClosed", () => {
      if (!this.connected) return;
      this.connected = false;
      this.logger.debug(`[rtc] ${this.opts.stationSn} command channel closed`);
      this.announceClose();
    });
    this.peer.on("connectionState", (state) => {
      if ((state === "failed" || state === "closed") && this.connected) {
        this.connected = false;
        this.announceClose();
      }
    });
    this.peer.on("error", (e) => this.emit("error", e));
    this.peer.on("data", (frame, linkType) => {
      if (linkType === PortalLinkType.LIVE) this.emit("mediaData", frame);
      else this.emit("commandData", frame, linkType);
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Start the sequence; resolves once `scall` is sent. `connected` fires when the channel opens. A session
   * closed by the time the sign fetch or the auth completes rejects instead of opening the socket or
   * placing the call.
   */
  async connect(): Promise<void> {
    await this.signaling.fetchSign();
    if (this.closed) throw new Error("RTC session closed before the call was placed");
    await this.signaling.connect();
    await this.waitForAuth();
    if (this.closed) throw new Error("RTC session closed before the call was placed");
    this.logger.debug(`[rtc] ${this.opts.stationSn} authenticated — scall`);
    this.signaling.sendCall();
  }

  /** Send one portal packet; false when the command channel isn't open. */
  sendCommand(portalPacket: Buffer): boolean {
    return this.peer.sendCommand(portalPacket);
  }

  /** Send unframed bytes on the command channel; false when it isn't open. */
  sendRaw(bytes: Buffer): boolean {
    return this.peer.sendRaw(bytes);
  }

  /**
   * Hang up and tear both sides down; `close` fires once, here if nothing announced it before. A
   * `connect()` still waiting for the signalling auth is rejected and its timer stopped.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    try {
      if (this.signaling.isOpen) this.signaling.sendHangup();
    } catch {
      /* the socket may already be gone */
    }
    this.signaling.close();
    this.peer.close();
    this.settleAuth(new Error("RTC session closed while waiting for signalling auth"));
    this.announceClose();
  }

  private announceClose(): void {
    if (this.closeAnnounced) return;
    this.closeAnnounced = true;
    this.emit("close");
  }

  private waitForAuth(): Promise<void> {
    if (this.authOk) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authWaiter = undefined;
        reject(new Error("RTC signalling auth timeout"));
      }, AUTH_TIMEOUT_MS);
      this.authWaiter = { resolve, reject, timer };
    });
  }

  /** Settle a pending auth wait: resolve it, or reject it with `err`; either way its timer stops. */
  private settleAuth(err?: Error): void {
    const waiter = this.authWaiter;
    if (!waiter) return;
    this.authWaiter = undefined;
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve();
  }

  private async onSignaling(inner: RtcInnerMessage): Promise<void> {
    if (inner.action === 1 && inner.code === 200) {
      this.authOk = true;
      this.settleAuth();
    }
    if (!inner.data) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(inner.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (inner.dataType) {
      case "scall":
      case "call":
        await this.onCall(payload as CallPayload);
        return;
      case "info":
        await this.onInfo(payload as InfoPayload);
        return;
      case "hangup":
        this.logger.debug(`[rtc] ${this.opts.stationSn} hub hung up`);
        return;
      default:
        return;
    }
  }

  /** A `scall` status: `100` grants the relay, `200` is acknowledged, `486`/`408` fail the session. */
  private async onCall(payload: CallPayload): Promise<void> {
    if (this.closed) return;
    const status = payload.status;
    if (status === 100 && payload.turn) {
      this.turn = payload.turn;
      await this.peer.init(payload.turn);
      return;
    }
    if (status === 200) {
      this.signaling.sendAck();
      return;
    }
    if (status === 486 || status === 408) {
      this.emit("error", new Error(`RTC ${this.opts.stationSn} scall answered ${status}`));
      this.close();
    }
  }

  /**
   * An `info`: trickle ICE, in either of the two shapes the hub sends, or the hub's SDP offer. The offer
   * is answered only once a TURN grant is in: the peer is relay-only, so an offer ahead of `scall 100`
   * is reported and left unanswered.
   */
  private async onInfo(payload: InfoPayload): Promise<void> {
    if (this.closed) return;
    if (payload.format === "CANDIDATE") {
      if (payload.value) this.peer.addRemoteCandidate(payload.value);
      return;
    }
    if (payload.candidate !== undefined) {
      if (payload.candidate) this.peer.addRemoteCandidate(payload.candidate);
      return;
    }
    const sdpText = payload.value ?? payload.sdp;
    if (!sdpText || (payload.format !== "SDP" && !payload.sdp)) return;
    if (this.sdpHandled) return;
    if (!this.turn) {
      this.emit("error", new Error(`RTC ${this.opts.stationSn} offered before granting a relay`));
      return;
    }
    this.sdpHandled = true;
    let offer: string;
    try {
      offer = scallJsonToSdp(JSON.parse(sdpText));
    } catch {
      offer = sdpText;
    }
    const answer = await this.peer.handleRemoteOffer(offer);
    this.signaling.sendInfoSdp(JSON.stringify(sdpToScallJson(answer)));
    this.logger.debug(`[rtc] ${this.opts.stationSn} answered the hub's offer`);
  }
}
