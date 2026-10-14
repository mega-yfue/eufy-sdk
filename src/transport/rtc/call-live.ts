/**
 * Live view of a standalone WebRTC doorbell (Video Doorbell C30/C31, T8224/T8223) over the portal's
 * `call` signalling.
 *
 * These doorbells answer no PPCS lookup and their cloud record carries no `app_conn`; the eufy app
 * reaches them only through the portal: sign → WS join → `call` → the doorbell's full SDP offer (an
 * Opus audio m-line and an H.264 video m-line in one BUNDLE) → answer → ICE over the relay the `call`
 * reply grants → DTLS-SRTP. Unlike the T9000 there is no data channel and no PTCS framing: the video
 * arrives as plain RTP on the offer's video track, so this stream depacketizes H.264 (single NAL,
 * STAP-A, FU-A) into whole Annex-B access units, cut on the RTP marker bit.
 *
 * Verified live on a T8223: ICE completes, DTLS finishes, 1024x768 H.264 + Opus flow within seconds.
 */
import { EventEmitter } from "node:events";
import type { IceServer, PeerConnection, Track } from "node-datachannel";
import type { LiveStreamHandle, LiveVideoFrame } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { hasIdr } from "../p2p/annexb.js";
import { forceDtlsRole } from "./scall-sdp.js";
import type { TurnConfig } from "./peer.js";
import { RtcSignalingClient, type RtcInnerMessage } from "./signaling.js";

/** How long the portal has to authenticate the signalling socket. */
const AUTH_TIMEOUT_MS = 10_000;
const START_CODE = Buffer.from([0, 0, 0, 1]);

export interface RtcCallLiveOptions {
  authToken: string;
  gtoken: string;
  userId: string;
  /** The doorbell's own serial: it is its own station on the portal. */
  sn: string;
  adminUserId?: string;
  shard: string;
  country: string;
  logger?: Logger;
}

function turnServers(turn: TurnConfig): IceServer[] {
  const both = (hostname: string, port: number): IceServer[] => [
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnUdp" },
    { hostname, port, username: turn.turn_user, password: turn.turn_password, relayType: "TurnTcp" },
  ];
  const servers = both(turn.turn_addr, turn.turn_port);
  if (turn.alt_turn_addr && turn.alt_turn_port) servers.push(...both(turn.alt_turn_addr, turn.alt_turn_port));
  return servers;
}

/** The `a=mid` of the first m-section of `kind` in an SDP, if any. */
export function midOf(sdp: string, kind: "video" | "audio"): string | undefined {
  const section = sdp.split(/(?=^m=)/m).find((s) => s.startsWith(`m=${kind} `));
  return section?.match(/^a=mid:([^\r\n]+)/m)?.[1]?.trim();
}

/** Unsigned Exp-Golomb reader over an RBSP (emulation-prevention bytes removed). */
class BitReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  bit(): number {
    const b = this.buf[this.pos >> 3] ?? 0;
    const v = (b >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros++;
    return (1 << zeros) - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/** Width and height from an H.264 SPS NAL (header byte included); `undefined` when it cannot be read. */
export function h264SpsSize(nal: Buffer): { width: number; height: number } | undefined {
  try {
    const rbsp: number[] = [];
    for (let i = 1; i < nal.length; i++) {
      if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      rbsp.push(nal[i]);
    }
    const r = new BitReader(Buffer.from(rbsp));
    const profile = r.bits(8);
    r.bits(16);
    r.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue();
      r.ue();
      r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (r.bit()) {
            let last = 8;
            let next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) next = (last + r.se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.bit();
    const wMbs = r.ue() + 1;
    const hMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let [cl, cr, ct, cb] = [0, 0, 0, 0];
    if (r.bit()) [cl, cr, ct, cb] = [r.ue(), r.ue(), r.ue(), r.ue()];
    const cropX = chroma === 0 ? 1 : 2;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = wMbs * 16 - (cl + cr) * cropX;
    const height = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * cropY;
    return width > 0 && height > 0 ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * H.264 RTP depacketizer (RFC 6184 single NAL / STAP-A / FU-A). Feed whole RTP packets; it calls `onUnit`
 * with each complete Annex-B access unit when the marker bit closes it. A unit with a sequence gap or an
 * unterminated fragment is dropped, never delivered short.
 */
/**
 * Reject an offer's `m=application` (data channel) section: port 0 and out of the BUNDLE group. The
 * T8223 offers one but never completes the SCTP association, and libdatachannel fails the whole peer
 * when SCTP does not come up, cutting the video ~30 s into every call.
 */
export function rejectDataSection(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  let inApp = false;
  let appMid: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("m=")) {
      inApp = lines[i].startsWith("m=application");
      if (inApp) lines[i] = lines[i].replace(/^m=application \d+/, "m=application 0");
    } else if (inApp && lines[i].startsWith("a=mid:")) appMid = lines[i].slice(6).trim();
  }
  if (appMid !== undefined)
    for (let i = 0; i < lines.length; i++)
      if (lines[i].startsWith("a=group:BUNDLE"))
        lines[i] = lines[i]
          .split(" ")
          .filter((t, k) => k === 0 || t !== appMid)
          .join(" ");
  return lines.join(eol);
}

export class H264Depacketizer {
  private nals: Buffer[] = [];
  private fu: Buffer[] | undefined;
  private lastSeq = -1;
  private broken = false;

  constructor(private readonly onUnit: (unit: Buffer, nals: Buffer[], timestamp: number) => void) {}

  push(packet: Buffer): void {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return;
    const pt = packet[1] & 0x7f;
    if (pt >= 72 && pt <= 79) return; // RTCP multiplexed on the same transport (PT 200-207)
    const marker = (packet[1] & 0x80) !== 0;
    const seq = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);
    if (this.lastSeq >= 0 && seq !== ((this.lastSeq + 1) & 0xffff)) this.broken = true;
    this.lastSeq = seq;
    const cc = packet[0] & 0x0f;
    let off = 12 + cc * 4;
    if (packet[0] & 0x10) {
      if (packet.length < off + 4) return;
      off += 4 + packet.readUInt16BE(off + 2) * 4;
    }
    let end = packet.length;
    if (packet[0] & 0x20) end -= packet[packet.length - 1];
    if (end <= off) return;
    const p = packet.subarray(off, end);
    const type = p[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.nals.push(Buffer.from(p));
    } else if (type === 24) {
      let o = 1;
      while (o + 2 <= p.length) {
        const len = p.readUInt16BE(o);
        if (o + 2 + len > p.length) break;
        this.nals.push(Buffer.from(p.subarray(o + 2, o + 2 + len)));
        o += 2 + len;
      }
    } else if (type === 28 && p.length > 2) {
      const start = (p[1] & 0x80) !== 0;
      const stop = (p[1] & 0x40) !== 0;
      if (start) this.fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)])];
      if (this.fu) this.fu.push(Buffer.from(p.subarray(2)));
      else this.broken = true;
      if (stop && this.fu) {
        this.nals.push(Buffer.concat(this.fu));
        this.fu = undefined;
      }
    }
    if (marker) {
      if (!this.broken && !this.fu && this.nals.length) {
        const parts: Buffer[] = [];
        for (const n of this.nals) parts.push(START_CODE, n);
        this.onUnit(Buffer.concat(parts), this.nals, timestamp);
      }
      this.nals = [];
      this.fu = undefined;
      this.broken = false;
    }
  }
}

/** A `LiveStreamHandle` over one portal `call` to a standalone WebRTC doorbell. */
export class RtcCallLiveStream extends EventEmitter implements LiveStreamHandle {
  private readonly logger: Logger;
  private signaling?: RtcSignalingClient;
  private pc?: PeerConnection;
  private videoTrack?: Track;
  private videoMid?: string;
  private firstMid = "0";
  private running = false;
  private authed = false;
  private answered = false;
  private width = 0;
  private height = 0;
  private readonly depacketizer = new H264Depacketizer((unit, nals, ts) => this.onUnit(unit, nals, ts));
  private authWait?: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly opts: RtcCallLiveOptions) {
    super();
    this.logger = opts.logger ?? noopLogger;
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    this.run().catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))));
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.teardown(true);
    this.emit("stop");
  }

  private async run(): Promise<void> {
    const o = this.opts;
    const signaling = new RtcSignalingClient({
      signalingMode: "call",
      authToken: o.authToken,
      gtoken: o.gtoken,
      stationSn: o.sn,
      adminUserId: o.adminUserId || o.userId,
      shard: o.shard,
      country: o.country,
      logger: this.logger,
    });
    this.signaling = signaling;
    signaling.on("message", (inner) => {
      this.onSignaling(inner).catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))));
    });
    signaling.on("close", () => this.fail(new Error(`rtc call ${o.sn}: signalling closed`)));
    signaling.on("error", (e) => this.fail(e));
    await signaling.fetchSign();
    await signaling.connect();
    if (!this.running) return;
    await new Promise<void>((resolve, reject) => {
      if (this.authed) return resolve();
      const timer = setTimeout(() => reject(new Error(`rtc call ${o.sn}: signalling auth timeout`)), AUTH_TIMEOUT_MS);
      this.authWait = { resolve, reject, timer };
    });
    if (!this.running) return;
    this.logger.debug(`[rtc-call] ${o.sn} authenticated, placing call`);
    signaling.sendCall();
  }

  private async onSignaling(inner: RtcInnerMessage): Promise<void> {
    if (inner.action === 1 && inner.code === 200 && !this.authed) {
      this.authed = true;
      if (this.authWait) {
        clearTimeout(this.authWait.timer);
        this.authWait.resolve();
        this.authWait = undefined;
      }
    }
    if (!inner.data || !this.running) return;
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(inner.data) as Record<string, any>;
    } catch {
      return;
    }
    if (inner.dataType === "call" || inner.dataType === "scall") {
      const status = payload.status;
      if (status === 100 && payload.turn) await this.initPeer(payload.turn as TurnConfig);
      else if (status === 200) this.signaling?.sendAck();
      else if (status === 486 || status === 408)
        this.fail(new Error(`rtc call ${this.opts.sn}: call answered ${status}`));
      return;
    }
    if (inner.dataType === "hangup") {
      this.fail(new Error(`rtc call ${this.opts.sn}: doorbell hung up`));
      return;
    }
    if (inner.dataType !== "info" || !this.pc) return;
    if (payload.format === "CANDIDATE" || payload.candidate !== undefined) {
      const c = payload.format === "CANDIDATE" ? payload.value : payload.candidate;
      if (c) this.addRemoteCandidate(String(c));
      return;
    }
    const sdp = payload.value ?? payload.sdp;
    if (!sdp || this.answered) return;
    this.answered = true;
    // The doorbell offers a data channel it never serves: libdatachannel would wait on SCTP and fail the
    // peer ~30 s in. Reject that section so the peer connects on DTLS-SRTP alone.
    const offer = rejectDataSection(forceDtlsRole(String(sdp), "passive"));
    this.videoMid = midOf(offer, "video");
    this.firstMid = offer.match(/^a=mid:([^\r\n]+)/m)?.[1]?.trim() ?? "0";
    this.logger.debug(`[rtc-call] ${this.opts.sn} offer received (video mid ${this.videoMid ?? "?"})`);
    this.pc.setRemoteDescription(offer, "offer" as never);
  }

  private addRemoteCandidate(candidate: string): void {
    try {
      this.pc?.addRemoteCandidate(candidate, this.firstMid);
    } catch (e) {
      this.logger.debug(`[rtc-call] remote candidate refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async initPeer(turn: TurnConfig): Promise<void> {
    if (this.pc) return;
    const ndc = await import("node-datachannel");
    const pc = new ndc.PeerConnection(`eufy-call-${this.opts.sn}`, {
      iceServers: turnServers(turn),
      iceTransportPolicy: "all",
      enableIceTcp: true,
    });
    this.pc = pc;
    pc.onLocalDescription((sdp, type) => {
      if (String(type).toLowerCase() !== "answer") return;
      this.signaling?.sendInfoSdp(sdp);
      this.logger.debug(`[rtc-call] ${this.opts.sn} answered the offer`);
    });
    pc.onLocalCandidate((candidate) => {
      if (candidate) this.signaling?.sendInfoCandidate(candidate);
    });
    pc.onGatheringStateChange((state) => {
      if (state === "complete") this.signaling?.sendInfoCandidate("");
    });
    pc.onStateChange((state) => {
      this.logger.debug(`[rtc-call] ${this.opts.sn} peer ${state}`);
      if (state === "failed" || state === "closed") this.fail(new Error(`rtc call ${this.opts.sn}: peer ${state}`));
    });
    pc.onTrack((track) => {
      const mid = track.mid();
      if (this.videoTrack || (this.videoMid !== undefined && mid !== this.videoMid)) return;
      this.videoTrack = track;
      track.onMessage((msg) => this.depacketizer.push(Buffer.isBuffer(msg) ? msg : Buffer.from(msg)));
      this.logger.debug(`[rtc-call] ${this.opts.sn} video track ${mid}`);
    });
  }

  private onUnit(unit: Buffer, nals: Buffer[], timestamp: number): void {
    const sps = nals.find((n) => (n[0] & 0x1f) === 7);
    if (sps) {
      const size = h264SpsSize(sps);
      if (size) {
        this.width = size.width;
        this.height = size.height;
      }
    }
    const frame: LiveVideoFrame = {
      codec: "h264",
      data: unit,
      keyframe: hasIdr(unit, "h264"),
      width: this.width,
      height: this.height,
      sourceTimestamp: timestamp,
    } as LiveVideoFrame;
    this.emit("video", frame);
  }

  private fail(err: Error): void {
    if (!this.running) return;
    this.logger.warn(`[rtc-call] ${err.message}`);
    this.teardown(false);
    this.emit("error", err);
  }

  private teardown(hangup: boolean): void {
    this.running = false;
    if (this.authWait) {
      clearTimeout(this.authWait.timer);
      this.authWait.reject(new Error("rtc call stopped"));
      this.authWait = undefined;
    }
    const signaling = this.signaling;
    this.signaling = undefined;
    try {
      if (hangup && signaling?.isOpen) signaling.sendHangup();
    } catch {
      /* already gone */
    }
    signaling?.removeAllListeners();
    signaling?.close();
    const pc = this.pc;
    this.pc = undefined;
    this.videoTrack = undefined;
    try {
      pc?.close();
    } catch {
      /* already closed */
    }
  }
}
