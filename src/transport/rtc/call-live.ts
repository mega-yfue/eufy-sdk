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
import { RtpDepacketizer } from "./rtp.js";
import type { RtcPeerOptions } from "./peer.js";
import type { RtcSession } from "./session.js";

/** A `LiveStreamHandle` over one portal `call` to a T8223 doorbell. */
export class RtcCallLiveStream extends EventEmitter implements LiveStreamHandle {
  private readonly logger: Logger;
  private running = false;
  private readonly depacketizer = new RtpDepacketizer("h264", (unit, ts) => this.onUnit(unit, ts));

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
