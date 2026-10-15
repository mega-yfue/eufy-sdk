/**
 * Live view of a T8223 doorbell (Video Doorbell C31) over a portal `call` {@link RtcSession}.
 *
 * The doorbell is its own station and streams no PTCS framing: its video arrives as plain RTP on the
 * offer's H.264 video m-line, which a {@link RtcPeerOptions.mediaTrack} peer hands over as `rtp`. This
 * stream depacketizes it into whole Annex-B access units, one per frame. Each stream owns its session:
 * starting it places the call, stopping it hangs up.
 */
import { EventEmitter } from "node:events";
import type { LiveStreamHandle, LiveVideoFrame } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { hasIdr } from "../p2p/annexb.js";
import type { RtcPeerOptions } from "./peer.js";
import type { RtcSession } from "./session.js";

const START_CODE = Buffer.from([0, 0, 0, 1]);

/**
 * H.264 RTP depacketizer (RFC 6184 single NAL / STAP-A / FU-A). Feed whole RTP packets; it calls `onUnit`
 * with each complete Annex-B access unit when the marker bit closes it. A unit with a sequence gap or an
 * unterminated fragment is dropped, never delivered short. RTCP multiplexed on the same transport (PT
 * 200-207, which reads as 72-79 in the RTP payload-type bits) is skipped.
 */
export class H264Depacketizer {
  private nals: Buffer[] = [];
  private fu: Buffer[] | undefined;
  private lastSeq = -1;
  private broken = false;

  constructor(private readonly onUnit: (unit: Buffer, timestamp: number) => void) {}

  push(packet: Buffer): void {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return;
    const pt = packet[1] & 0x7f;
    if (pt >= 72 && pt <= 79) return;
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
        this.onUnit(Buffer.concat(parts), timestamp);
      }
      this.nals = [];
      this.fu = undefined;
      this.broken = false;
    }
  }
}

/** A `LiveStreamHandle` over one portal `call` to a T8223 doorbell. */
export class RtcCallLiveStream extends EventEmitter implements LiveStreamHandle {
  private readonly logger: Logger;
  private running = false;
  private readonly depacketizer = new H264Depacketizer((unit, ts) => this.onUnit(unit, ts));

  /** `session` is a session on a {@link RtcPeerOptions.mediaTrack} peer, not yet connected. */
  constructor(
    private readonly session: RtcSession,
    logger?: Logger,
  ) {
    super();
    this.logger = logger ?? noopLogger;
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    const { session } = this;
    session.on("rtp", (packet) => this.depacketizer.push(packet));
    session.on("close", () => this.fail(new Error("rtc call: session closed")));
    session.on("error", (e) => this.fail(e));
    session.connect().catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))));
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.teardown();
    this.emit("stop");
  }

  private onUnit(unit: Buffer, timestamp: number): void {
    const frame: LiveVideoFrame = {
      codec: "h264",
      data: unit,
      keyframe: hasIdr(unit, "h264"),
      width: 0,
      height: 0,
      sourceTimestamp: timestamp,
    };
    this.emit("video", frame);
  }

  private fail(err: Error): void {
    if (!this.running) return;
    this.logger.warn(`[rtc-call] ${err.message}`);
    this.teardown();
    this.emit("error", err);
  }

  private teardown(): void {
    this.running = false;
    this.session.close();
  }
}
