/**
 * The live pull of one camera behind a **HomeBase S1 Pro (T9000)**, over the station's control session.
 *
 * Wire, as the portal sends it on the command data channel:
 *
 *  - Start is inner `cmd 1003` in a `1350` SET_PAYLOAD on the station channel `255`. The header byte the
 *    codec names `isResponse` carries the portal's `streamId`, `1` for a live view, and `chn_list` is an
 *    array of `{index, chn, sensor, isUps, isClicked}` objects. Stop is inner `cmd 1004`, the same way.
 *  - Video arrives on the live link as portal packets `1300` on channel `100 + play id`; a single-camera
 *    view is play id `1`, whatever the camera's own channel. Each body is a fixed 22-byte media header,
 *    then the Annex B video it declares. See {@link parseMediaBody}.
 *  - A raw, unframed keepalive (a 20-byte prefix and a bare `XZYH 1139`) goes out every ~29 s; the hub
 *    echoes it.
 *
 * The station serves one live view at a time on that play slot, so the router builds at most one pull per
 * station. This is a {@link LiveStreamHandle}: fan-out, backpressure and the start deadline are the
 * shared live source's.
 */
import { EventEmitter } from "node:events";
import type { LiveStreamHandle, LiveVideoFrame } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { hasIdr } from "../p2p/annexb.js";
import type { RtcSession } from "./session.js";
import {
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PORTAL_CMD_SET_PAYLOAD,
  PORTAL_HEADER_LENGTH,
  PORTAL_STATION_CHANNEL,
  type SegmentCounter,
} from "./portal-packet.js";

/** Inner `cmd` that starts a live view. */
const LIVE_START = 1003;
/** Inner `cmd` that stops it. */
const LIVE_STOP = 1004;
/** Portal packet id of a video frame. */
const LIVE_MEDIA = 1300;
/** The media channel of a single-camera view: `100` plus play id `1`. */
const LIVE_MEDIA_CHANNEL = 101;
/** The portal's `streamId` for a live view, in the header byte the codec names `isResponse`. */
const LIVE_STREAM_ID = 1;
/** How often the raw keepalive goes out. */
const KEEPALIVE_MS = 29_000;
/** The portal's 36-byte data-channel keepalive: a 20-byte prefix and a bare `XZYH 1139`. */
const KEEPALIVE = Buffer.from("0009000010000000000000006300000000000000585a5948730400000000000000000002", "hex");

/** The media header ahead of the video in a `1300` body. */
const MEDIA_HEADER_LENGTH = 22;
/** The header's stream type for HEVC. */
const STREAM_TYPE_HEVC = 1;

/**
 * Read a `1300` body: a 22-byte media header (u32 LE video length at 0, stream type at 5, u16 LE width
 * and height at 10 and 12), then the Annex B video. This is the layout the portal's own HEVC worker
 * parses. Answers `undefined` for a short body, a stream that is not HEVC, or a declared length the body
 * does not hold.
 */
export function parseMediaBody(body: Buffer): { data: Buffer; width: number; height: number } | undefined {
  if (body.length < MEDIA_HEADER_LENGTH || body[5] !== STREAM_TYPE_HEVC) return undefined;
  const length = body.readUInt32LE(0);
  if (body.length < MEDIA_HEADER_LENGTH + length) return undefined;
  return {
    data: body.subarray(MEDIA_HEADER_LENGTH, MEDIA_HEADER_LENGTH + length),
    width: body.readUInt16LE(10),
    height: body.readUInt16LE(12),
  };
}

export interface RtcLiveOptions {
  session: RtcSession;
  /** The session's segment counter, shared with the command router so segments never collide. */
  seg: SegmentCounter;
  stationSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /** The station's `member.admin_user_id`. */
  accountId: string;
  logger?: Logger;
}

/**
 * One camera's live pull. `start()` sends the start; a non-zero start ACK or a closed session ends it with
 * `error`, and `stop()` sends the stop. Frames are `h265` Annex B, keyframes being IDRs.
 */
export class RtcLiveStream extends EventEmitter implements LiveStreamHandle {
  private running = false;
  private startSegment = -1;
  private keepalive?: ReturnType<typeof setInterval>;
  private width = 0;
  private height = 0;
  private readonly onMedia = (frame: Buffer) => this.onMediaFrame(frame);
  private readonly onCommand = (frame: Buffer, linkType: number) => this.onCommandFrame(frame, linkType);
  private readonly onClose = () => this.fail(new Error(`rtc live ${this.tag}: session closed`));

  constructor(private readonly opts: RtcLiveOptions) {
    super();
  }

  private get tag(): string {
    return `${this.opts.stationSn}#${this.opts.channel}`;
  }

  start(): this {
    if (this.running) return this;
    const { session, seg, accountId } = this.opts;
    this.running = true;
    session.on("mediaData", this.onMedia);
    session.on("commandData", this.onCommand);
    session.on("close", this.onClose);
    this.startSegment = seg.next();
    const sent = session.sendCommand(
      buildPortalPacket({
        commandId: PORTAL_CMD_SET_PAYLOAD,
        channel: PORTAL_STATION_CHANNEL,
        segment: this.startSegment,
        isResponse: LIVE_STREAM_ID,
        payload: {
          account_id: accountId,
          cmd: LIVE_START,
          payload: {
            ClientOS: "WEB",
            entrytype: 0,
            camera_type: 0,
            key: "",
            msg_id: 116,
            audio_chn: -1,
            streamtype: 2,
            stitch_mode: 1,
            chn_list: [{ index: 0, chn: this.opts.channel, sensor: 0, isUps: 0, isClicked: true }],
            pip_cord: { x1: 0, y1: 0, x2: 0, y2: 0 },
            station_video_type: 6,
            play_id: 1,
          },
        },
      }),
    );
    if (!sent) {
      queueMicrotask(() => this.fail(new Error(`rtc live ${this.tag}: command channel not open`)));
      return this;
    }
    this.keepalive = setInterval(() => {
      if (!session.sendRaw(KEEPALIVE)) this.opts.logger?.warn?.(`[rtc] ${this.tag} keepalive not sent`);
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    this.opts.logger?.debug?.(`[rtc] ${this.tag} live start sent`);
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.teardown();
    const { session, seg, accountId } = this.opts;
    session.sendCommand(
      buildPortalPacket({
        commandId: PORTAL_CMD_SET_PAYLOAD,
        channel: PORTAL_STATION_CHANNEL,
        segment: seg.next(),
        isResponse: LIVE_STREAM_ID,
        payload: { account_id: accountId, cmd: LIVE_STOP, payload: {} },
      }),
    );
    this.emit("stop");
  }

  private teardown(): void {
    this.running = false;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    const { session } = this.opts;
    session.off("mediaData", this.onMedia);
    session.off("commandData", this.onCommand);
    session.off("close", this.onClose);
  }

  private fail(err: Error): void {
    if (!this.running) return;
    this.teardown();
    this.emit("error", err);
  }

  /** The start's ACK: a non-zero result code ends the pull. */
  private onCommandFrame(frame: Buffer, linkType: number): void {
    const p = parsePortalPacket(frame, linkType);
    if (!p?.isResponse || p.segment !== this.startSegment || p.commandId !== PORTAL_CMD_SET_PAYLOAD) return;
    if (p.errCode !== 0) this.fail(new Error(`rtc live ${this.tag}: start refused (err ${p.errCode})`));
  }

  private onMediaFrame(frame: Buffer): void {
    const h = parsePortalHeader(frame);
    if (!h || h.commandId !== LIVE_MEDIA || h.channel !== LIVE_MEDIA_CHANNEL) return;
    if (h.paramLength > frame.length - PORTAL_HEADER_LENGTH) return;
    const media = parseMediaBody(frame.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + h.paramLength));
    if (!media) return;
    const { data, width, height } = media;
    if (width && height) {
      this.width = width;
      this.height = height;
    }
    const out: LiveVideoFrame = {
      codec: "h265",
      data,
      keyframe: hasIdr(data, "h265"),
      width: this.width,
      height: this.height,
    };
    this.emit("video", out);
  }
}
