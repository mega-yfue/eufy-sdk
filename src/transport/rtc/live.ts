/**
 * Live video from a **HomeBase Professional S1 (T9000)** over the portal control channel.
 *
 * Everything here was read off the portal's own data-channel traffic (captured in the owner's browser on
 * 2026-09-26) and then replayed from this SDK's session, frame by frame, verified with ffprobe:
 *
 *  - The portal opens **hub sessions only** (`channelId 0`, no `subSn`); video rides the station session.
 *  - Start is `1003` inside a `1350` SET_PAYLOAD on the station channel, but two header/body details
 *    decide whether the encoder starts at all: the portal packet header byte the codec calls `isResponse`
 *    carries the portal's **`streamId` = 1** for a live view, and `chn_list` is an **array of objects**
 *    `{index, chn, sensor, isUps, isClicked}` — sent as `[chn]` with `isResponse 0` the hub ACKs and never
 *    encodes (`1366 currentEncLoadRatio: 0`); sent this way it reports `currentEncLoadRatio: 16` within a second.
 *  - The video arrives on the **`idr`** data channel, PTCS channel 5 (LIVE), 800-byte payloads, reassembled
 *    into portal packets `cmd 1300` whose channel is **`100 + camera channel`**. Each body is
 *    `[hub prefix][Annex B HEVC]` — 22 bytes on a keyframe (it embeds the picture size), 2 on a P-frame —
 *    so the payload starts at the first `00 00 00 01`. HEVC Main, 1920×1080, 20 fps, parameter sets ~1/s.
 *  - Before the start the portal sends `1103 {}`, `9100 {}` and `9257` (two-int body, channel 0); which of
 *    them the hub actually needs has not been bisected, so they are replayed as captured.
 *  - Every ~29 s the portal sends a raw, unframed 36-byte keepalive (20-byte prefix + bare `XZYH 1139`);
 *    the hub echoes it. It is sent with {@link RtcSession.sendRaw}, not through the PTCS framer.
 *  - **One RTC session per account.** A second session on the same account connects and receives nothing,
 *    not even ACKs — which is why this rides the command router's per-station session instead of its own.
 */
import { EventEmitter } from "node:events";
import type { LiveVideoFrame, LiveStreamConsumer } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import type { RtcSession } from "./session.js";
import {
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PORTAL_HEADER_LENGTH,
  PortalLinkType,
  type SegmentCounter,
} from "./portal-packet.js";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "./commands.js";

export const T9000Live = {
  /** Inner `cmd` that starts a live view (portal `lw`/`Ew`). */
  START: 1003,
  /** Inner `cmd` that stops it. */
  STOP: 1004,
  /** Portal packet id the reassembled video frames carry. */
  MEDIA: 1300,
  /** Media packet channel = this + the camera's `device_channel`. */
  MEDIA_CHANNEL_BASE: 100,
  /** The play slot a single-camera live streams on: the hub answers on MEDIA_CHANNEL_BASE + PLAY_ID
   * regardless of the camera's own device channel (verified: a camera on device_channel 5 streams on 101). */
  PLAY_ID: 1,
  /** Portal packet id of the raw keepalive. */
  KEEPALIVE: 1139,
  KEEPALIVE_MS: 29_000,
  /** The portal's `streamId` for a live view, carried in the header byte the codec names `isResponse`. */
  STREAM_ID: 1,
} as const;

/** The portal's 36-byte data-channel keepalive, byte for byte (20-byte prefix + bare `XZYH 1139`). */
export const T9000_KEEPALIVE = Buffer.from(
  "0009000010000000000000006300000000000000585a5948730400000000000000000002",
  "hex",
);

/** The three commands the portal sends before a start; replayed as captured. */
export function buildT9000LivePrelude(opts: { accountId: string; seg: SegmentCounter }): Buffer[] {
  const { accountId, seg } = opts;
  return [
    buildPortalPacket({
      commandId: PORTAL_CMD_SET_PAYLOAD,
      channel: PORTAL_STATION_CHANNEL,
      segment: seg.next(),
      payload: { account_id: accountId, cmd: 1103, payload: {} },
    }),
    buildPortalPacket({
      commandId: PORTAL_CMD_SET_PAYLOAD,
      channel: PORTAL_STATION_CHANNEL,
      segment: seg.next(),
      payload: { account_id: accountId, cmd: 9100, payload: {} },
    }),
    buildPortalPacket({
      commandId: 9257,
      channel: 0,
      segment: seg.next(),
      payload: { value: 0, value1: 0, account_id: accountId },
    }),
  ];
}

/** The start-live frame for ONE camera, exactly as the portal builds it for a single-camera view. */
export function buildT9000StartLive(opts: { accountId: string; channel: number; segment: number }): Buffer {
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: PORTAL_STATION_CHANNEL,
    segment: opts.segment,
    isResponse: T9000Live.STREAM_ID,
    payload: {
      account_id: opts.accountId,
      cmd: T9000Live.START,
      payload: {
        ClientOS: "WEB",
        entrytype: 0,
        camera_type: 0,
        key: "",
        msg_id: 116,
        audio_chn: -1,
        streamtype: 2,
        stitch_mode: 1,
        chn_list: [{ index: 0, chn: opts.channel, sensor: 0, isUps: 0, isClicked: true }],
        pip_cord: { x1: 0, y1: 0, x2: 0, y2: 0 },
        station_video_type: 6,
        play_id: 1,
      },
    },
  });
}

export function buildT9000StopLive(opts: { accountId: string; segment: number }): Buffer {
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: PORTAL_STATION_CHANNEL,
    segment: opts.segment,
    isResponse: T9000Live.STREAM_ID,
    payload: { account_id: opts.accountId, cmd: T9000Live.STOP, payload: {} },
  });
}

const ANNEX_B_START = Buffer.from([0, 0, 0, 1]);

/** The Annex B payload of a `1300` body: everything from the first start code (the hub prefix dropped). */
export function stripT9000FramePrefix(body: Buffer): Buffer {
  const at = body.indexOf(ANNEX_B_START);
  return at > 0 ? body.subarray(at) : body;
}

/** True when the Annex B access unit carries an HEVC IDR/CRA slice or a parameter set (a decoder can start here). */
export function isHevcKeyframe(annexB: Buffer): boolean {
  let at = annexB.indexOf(ANNEX_B_START);
  while (at >= 0 && at + 4 < annexB.length) {
    const type = (annexB[at + 4]! >> 1) & 0x3f;
    if (type === 19 || type === 20 || type === 21 || type === 32) return true;
    at = annexB.indexOf(ANNEX_B_START, at + 4);
  }
  return false;
}

/**
 * One consumer of a {@link RtcLive}: the shape `openReadableFromConsumer` and `MediaProvider.live` want.
 * Frames are HEVC Annex B; a consumer starts on the first keyframe and, after a pause, resumes on the next.
 */
export class RtcLiveConsumer extends EventEmitter implements LiveStreamConsumer {
  awaitingKeyframe = true;
  private paused = false;
  private detached = false;

  constructor(private readonly owner: RtcLive) {
    super();
  }

  get primed(): boolean {
    return !this.awaitingKeyframe;
  }

  start(): this {
    return this;
  }

  stop(): void {
    this.detach();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.awaitingKeyframe = true; // pick up cleanly on the next keyframe
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.owner.release(this);
    this.emit("stop");
  }

  onMedia(listener: (item: { kind: "video"; frame: LiveVideoFrame }) => void): this {
    this.on("video", (frame: LiveVideoFrame) => listener({ kind: "video", frame }));
    return this;
  }

  /** @internal */
  deliver(frame: LiveVideoFrame): void {
    if (this.detached || this.paused) return;
    if (this.awaitingKeyframe) {
      if (!frame.keyframe) return;
      this.awaitingKeyframe = false;
      this.emit("start");
    }
    this.emit("video", frame);
  }

  /** @internal */
  fail(err: Error): void {
    if (this.detached) return;
    this.emit("error", err);
    this.detach();
  }
}

export interface RtcLiveOptions {
  session: RtcSession;
  /** The session's segment counter — shared with the command router so segments never collide. */
  seg: SegmentCounter;
  stationSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /** The member id commands attribute themselves to. */
  accountId: string;
  /** Called when the last consumer leaves and the live has been stopped. */
  onIdle?: () => void;
  logger?: Logger;
  keepaliveMs?: number;
}

/**
 * The live view of ONE camera on a T9000: started on the first consumer, stopped after the last one, one
 * per (station, channel). Frames are emitted as {@link LiveVideoFrame}s (`codec: "hevc"`, Annex B).
 */
export class RtcLive {
  private readonly consumers = new Set<RtcLiveConsumer>();
  private started = false;
  private keepalive?: ReturnType<typeof setInterval>;
  private readonly onMedia = (frame: Buffer, linkType: number) => this.onMediaFrame(frame, linkType);
  private readonly onCmd = (frame: Buffer, linkType: number) => this.onCommandFrame(frame, linkType);
  private startSegment = -1;
  private strayLogged = 0;
  private width = 0;
  private height = 0;
  private readonly onClose = () =>
    this.fail(new Error(`rtc live ${this.opts.stationSn}#${this.opts.channel}: session closed`));

  constructor(private readonly opts: RtcLiveOptions) {}

  get mediaChannel(): number {
    // The hub streams a single-camera live on the play slot (100 + PLAY_ID), NOT on 100 + the camera's
    // device channel — those coincide only for a camera on device_channel 1.
    return T9000Live.MEDIA_CHANNEL_BASE + T9000Live.PLAY_ID;
  }

  get active(): boolean {
    return this.started;
  }

  attach(): RtcLiveConsumer {
    const c = new RtcLiveConsumer(this);
    this.consumers.add(c);
    if (!this.started) this.start();
    return c;
  }

  /** @internal */
  release(c: RtcLiveConsumer): void {
    if (!this.consumers.delete(c)) return;
    if (this.consumers.size === 0) this.stop();
  }

  private start(): void {
    const { session, seg, accountId, logger } = this.opts;
    this.started = true;
    session.on("mediaData", this.onMedia);
    session.on("commandData", this.onCmd);
    session.on("close", this.onClose);
    for (const pkt of buildT9000LivePrelude({ accountId, seg })) session.sendCommand(pkt);
    this.startSegment = seg.next();
    this.strayLogged = 0;
    const sent = session.sendCommand(
      buildT9000StartLive({ accountId, channel: this.opts.channel, segment: this.startSegment }),
    );
    logger?.info?.(`[rtc] ${this.opts.stationSn}#${this.opts.channel} live start sent=${sent}`);
    if (!sent)
      return this.fail(new Error(`rtc live ${this.opts.stationSn}#${this.opts.channel}: command channel not open`));
    this.keepalive = setInterval(() => {
      if (!session.sendRaw(T9000_KEEPALIVE)) logger?.warn?.(`[rtc] ${this.opts.stationSn} keepalive not sent`);
    }, this.opts.keepaliveMs ?? T9000Live.KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    const { session, seg, accountId, logger } = this.opts;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    session.off("mediaData", this.onMedia);
    session.off("commandData", this.onCmd);
    session.off("close", this.onClose);
    try {
      session.sendCommand(buildT9000StopLive({ accountId, segment: seg.next() }));
    } catch {
      /* the session may already be gone */
    }
    logger?.info?.(`[rtc] ${this.opts.stationSn}#${this.opts.channel} live stopped`);
    this.opts.onIdle?.();
  }

  private fail(err: Error): void {
    for (const c of [...this.consumers]) c.fail(err);
    this.stop();
  }

  /** What the hub says back while a live is up: the start's ACK (with its error code) and the encoder notifies. */
  private onCommandFrame(frame: Buffer, linkType: number): void {
    const p = parsePortalPacket(frame, linkType);
    if (!p) return;
    const tag = `[rtc] ${this.opts.stationSn}#${this.opts.channel}`;
    if (p.isResponse && p.segment === this.startSegment) {
      this.opts.logger?.info?.(`${tag} live start acked err=${p.errCode ?? 0}`);
      return;
    }
    const inner = (p.data ?? {}) as { cmd?: number; payload?: unknown };
    if (inner.cmd === 1366 || inner.cmd === 6246) {
      this.opts.logger?.info?.(`${tag} hub notify ${inner.cmd} ${JSON.stringify(inner.payload ?? "").slice(0, 160)}`);
    }
  }

  private onMediaFrame(frame: Buffer, linkType: number): void {
    if (linkType !== PortalLinkType.LIVE) return;
    const h = parsePortalHeader(frame);
    if (!h) return;
    if (h.commandId !== T9000Live.MEDIA || h.channel !== this.mediaChannel) {
      if (this.strayLogged < 3) {
        this.strayLogged++;
        this.opts.logger?.info?.(
          `[rtc] ${this.opts.stationSn}#${this.opts.channel} media frame on cmd ${h.commandId} channel ${h.channel} (expected ${T9000Live.MEDIA} on ${this.mediaChannel}), ${h.paramLength}B`,
        );
      }
      return;
    }
    const body = frame.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + h.paramLength);
    const prefixLen = body.indexOf(ANNEX_B_START);
    // The keyframe's 22-byte hub prefix carries the picture size (u16 LE at 10 and 12); P-frames carry 2 bytes.
    if (prefixLen >= 14) {
      const w = body.readUInt16LE(10);
      const hh = body.readUInt16LE(12);
      if (w > 0 && hh > 0) {
        this.width = w;
        this.height = hh;
      }
    }
    const data = prefixLen > 0 ? body.subarray(prefixLen) : body;
    const out = {
      codec: "hevc",
      data,
      keyframe: isHevcKeyframe(data),
      width: this.width,
      height: this.height,
    } as unknown as LiveVideoFrame;
    for (const c of this.consumers) c.deliver(out);
  }
}
