/**
 * One T9000 command session end to end: sign → signalling socket → `scall` → the hub's SDP offer →
 * our answer → ICE → DTLS → the command data channel open.
 *
 * The signalling exchange, as the portal runs it and as confirmed live:
 *
 *   → scall                          (action 3, channel 0)
 *   ← scall {status: 100, turn}      the hub granted the session and handed out TURN credentials
 *   ← info  {sdp | format:"SDP"}     the hub's offer, as scall JSON
 *   → info  {sdp}                    our answer, channel 0
 *   ↔ info  {candidate}              trickle ICE, channel 1; "" ends it
 *   ← scall {status: 200}            → ack
 *   ← scall {status: 486 | 408}      busy / timeout — hang up, back off, call again (bounded)
 *   ← hangup                         the hub ended it
 *
 * Both the signalling client and the peer are injectable, so the whole sequence is testable offline.
 */

import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../../core/logger.js";
import { RtcPeer, type RtcPeerOptions, type TurnConfig } from "./peer.js";
import { PortalLinkType } from "./portal-packet.js";
import { scallJsonToSdp, toWireCandidate } from "./scall-sdp.js";
import { RtcSignalingClient, type RtcInnerMessage, type RtcSignalingOptions } from "./signaling.js";

export interface RtcSessionOptions extends RtcSignalingOptions {
  /** 0 = the hub itself; a camera channel for per-camera calls. */
  channelId?: number;
  peer?: RtcPeerOptions;
  /** Test seams. */
  createSignaling?: (opts: RtcSignalingOptions) => RtcSignalingClient;
  createPeer?: (opts: RtcPeerOptions) => RtcPeer;
  authTimeoutMs?: number;
  /** How many `486`/`408` retries before giving up. */
  maxCallRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RtcSessionEvents {
  connected: [];
  turn: [turn: TurnConfig];
  close: [];
  error: [err: Error];
  /** A frame off the command/notify path: portal packet bytes + the link type it arrived on. */
  commandData: [frame: Buffer, linkType: number];
  /** A frame off the live / playback / file path — media, for a per-camera session. */
  mediaData: [frame: Buffer, linkType: number];
}

const MEDIA_LINK_TYPES: ReadonlySet<number> = new Set([
  PortalLinkType.LIVE,
  PortalLinkType.PLAYBACK,
  PortalLinkType.FILE,
]);

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

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RtcSession extends EventEmitter<RtcSessionEvents> {
  private readonly signaling: RtcSignalingClient;
  private readonly peer: RtcPeer;
  private readonly channelId: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private turn?: TurnConfig;
  private authOk = false;
  private connected = false;
  private closed = false;
  private sdpHandled = false;
  private callRetries = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RtcSessionOptions) {
    super();
    this.channelId = opts.channelId ?? 0;
    this.logger = opts.logger ?? noopLogger;
    this.sleep = opts.sleep ?? defaultSleep;
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
      if (this.closed) return;
      this.connected = false;
      this.emit("close");
    });
    this.signaling.on("error", (e) => this.emit("error", e));

    // The portal answers on channel 0 and trickles ICE on channel 1.
    // Trickled candidates ride the SAME channel as the session's SDP and scall, not a fixed channel 1.
    // The portal sends both its SDP answer and every candidate on `this.channel` (the session's own
    // channelId); pinning candidates to 1 while the session is channel 0 hands the hub candidates it
    // cannot bind to the DTLS association it just offered — ICE still comes up on the host pair, but
    // the handshake never completes because the answer and its transport parameters are split across
    // two channels.
    this.peer.on("iceCandidate", (c) => this.signaling.sendInfoCandidate(toWireCandidate(c), this.channelId));
    this.peer.on("iceGatheringComplete", () => this.signaling.sendInfoCandidate("", this.channelId));
    this.peer.on("commandChannelOpen", () => {
      if (this.connected) return;
      this.connected = true;
      this.logger.debug(`[rtc] ${this.opts.stationSn} command channel open`);
      this.emit("connected");
    });
    // The command channel IS the session: if it goes, stop reporting connected even when the peer
    // connection itself is still nominally up.
    this.peer.on("commandChannelClosed", () => {
      if (!this.connected || this.closed) return;
      this.connected = false;
      this.logger.debug(`[rtc] ${this.opts.stationSn} command channel closed`);
      this.emit("close");
    });
    this.peer.on("connectionState", (state) => {
      if ((state === "failed" || state === "closed") && this.connected && !this.closed) {
        this.connected = false;
        this.emit("close");
      }
    });
    this.peer.on("error", (e) => this.emit("error", e));
    this.peer.on("data", (_label, frame, linkType) => {
      if (MEDIA_LINK_TYPES.has(linkType)) this.emit("mediaData", frame, linkType);
      else this.emit("commandData", frame, linkType);
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Start the sequence; resolves once `scall` is sent. `connected` fires when the channel opens. */
  async connect(): Promise<void> {
    await this.signaling.fetchSign();
    await this.signaling.connect();
    await this.waitForAuth();
    this.logger.debug(`[rtc] ${this.opts.stationSn} authenticated — scall`);
    this.signaling.sendCall(this.channelId);
  }

  /** Send one portal packet; false when the command channel isn't open. */
  sendCommand(portalPacket: Buffer): boolean {
    return this.peer.sendCommand(portalPacket);
  }

  /** Send unframed bytes on the command channel (the portal's raw keepalive); false when not open. */
  sendRaw(bytes: Buffer): boolean {
    return this.peer.sendRaw(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    try {
      if (this.signaling.isOpen) this.signaling.sendHangup(this.channelId);
    } catch {
      /* the socket may already be gone */
    }
    this.signaling.close();
    this.peer.close();
  }

  private waitForAuth(): Promise<void> {
    if (this.authOk) return Promise.resolve();
    const timeoutMs = this.opts.authTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.signaling.off("message", onMsg);
        reject(new Error("RTC signalling auth timeout"));
      }, timeoutMs);
      const onMsg = (inner: RtcInnerMessage): void => {
        if (inner.action === 1 && inner.code === 200) {
          this.authOk = true;
          clearTimeout(timer);
          this.signaling.off("message", onMsg);
          resolve();
        }
      };
      this.signaling.on("message", onMsg);
    });
  }

  private async onSignaling(inner: RtcInnerMessage): Promise<void> {
    if (inner.action === 1 && inner.code === 200) this.authOk = true;
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

  private async onCall(payload: CallPayload): Promise<void> {
    if (this.closed) return;
    const status = payload.status;
    if (status === 100 && payload.turn) {
      this.callRetries = 0;
      this.turn = payload.turn;
      this.emit("turn", payload.turn);
      await this.peer.init(payload.turn);
      return;
    }
    if (status === 200) {
      this.signaling.sendAck(this.channelId);
      return;
    }
    if (status === 486 || status === 408) {
      this.callRetries++;
      this.logger.warn(`[rtc] ${this.opts.stationSn} scall ${status}, retry ${this.callRetries}`);
      try {
        this.signaling.sendHangup(this.channelId);
      } catch {
        /* not fatal */
      }
      this.peer.close();
      this.sdpHandled = false;
      this.turn = undefined;
      this.connected = false;
      if (this.callRetries > (this.opts.maxCallRetries ?? 3)) {
        this.emit("error", new Error(`RTC scall ${status} after ${this.callRetries - 1} retries`));
        return;
      }
      await this.sleep(Math.min(5_000 + this.callRetries * 5_000, 30_000));
      if (!this.closed) this.signaling.sendCall(this.channelId);
    }
  }

  private async onInfo(payload: InfoPayload): Promise<void> {
    if (this.closed) return;
    // Trickle ICE in either of the two shapes the portal has used.
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
    this.sdpHandled = true;
    if (!this.turn) {
      // The hub normally grants (scall 100) before it offers; the peer initialises without TURN
      // under host-only ICE anyway, so an offer-first hub is not fatal.
      await this.peer.init();
    }
    let offer: string;
    try {
      offer = scallJsonToSdp(JSON.parse(sdpText));
    } catch {
      offer = sdpText;
    }
    const answer = await this.peer.handleRemoteOffer(offer);
    this.signaling.sendInfoSdp(this.peer.answerAsScallJson(answer), this.channelId);
    this.logger.debug(`[rtc] ${this.opts.stationSn} answered the hub's offer`);
  }
}
