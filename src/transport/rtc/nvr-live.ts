import { EventEmitter } from "node:events";
import type { LiveAudioFrame, LiveVideoFrame } from "../../core/contracts.js";
import { hasIdr } from "../p2p/annexb.js";
import {
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PortalLinkType,
  PORTAL_HEADER_LENGTH,
  PORTAL_LIVE_KEEPALIVE,
} from "./portal-packet.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";

/** A whole NVR video access unit after its 22-byte header; truncated or unknown codecs are not delivered. */
export function nvrVideo(frame: Buffer): LiveVideoFrame | undefined {
  const h = parsePortalHeader(frame);
  if (!h || h.commandId !== 1300 || h.paramLength !== frame.length - PORTAL_HEADER_LENGTH || h.paramLength < 26) return;
  const body = frame.subarray(PORTAL_HEADER_LENGTH);
  const data = body.subarray(22);
  if (body.readUInt32LE(0) !== data.length || (body[5] !== 0 && body[5] !== 1)) return;
  if (data[0] !== 0 || data[1] !== 0 || (data[2] !== 1 && !(data[2] === 0 && data[3] === 1))) return;
  const codec = body[5] === 1 ? "h265" : "h264";
  const timestampMs = Number(body.readBigUInt64LE(14));
  if (!Number.isSafeInteger(timestampMs)) return;
  return {
    data,
    codec,
    keyframe: hasIdr(data, codec),
    width: body.readUInt16LE(10),
    height: body.readUInt16LE(12),
    timestampMs,
  };
}

/** NVR audio access units in the observed AAC-LC or G.711 A-law formats, with their source timestamp. */
export function nvrAudio(frame: Buffer): LiveAudioFrame | undefined {
  const h = parsePortalHeader(frame);
  if (!h || h.commandId !== 1301 || h.paramLength !== frame.length - PORTAL_HEADER_LENGTH || h.paramLength <= 16)
    return;
  const body = frame.subarray(PORTAL_HEADER_LENGTH);
  if (body.readUInt32LE(0) !== body.length - 16 || (body[5] !== 0 && body[5] !== 2)) return;
  const timestampMs = Number(body.readBigUInt64LE(8));
  if (!Number.isSafeInteger(timestampMs)) return;
  return { codec: body[5] === 0 ? "aac-lc" : "g711a", data: body.subarray(16), timestampMs };
}

/** NVR start/stop use the station envelope; the start selects one camera and one of its sensors. */
export function nvrCommand(accountId: string, channel: number, sensor: number, start: boolean): Buffer {
  return buildPortalPacket({
    commandId: 1350,
    channel: 255,
    segment: start ? 2 : 3,
    isResponse: start ? 1 : 0,
    payload: {
      account_id: accountId,
      cmd: start ? 1003 : 1004,
      payload: start
        ? {
            ClientOS: "WEB",
            entrytype: 1,
            camera_type: 0,
            streamtype: 2,
            key: "",
            msg_id: "",
            audio_chn: channel,
            stitch_mode: 1,
            chn_list: [{ index: 0, chn: channel, sensor }],
          }
        : {},
    },
  });
}

export interface NvrLiveOptions {
  session: RtcSessionOptions;
  channel: number;
  sensor: 0 | 1;
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

/** A dedicated NVR media session: its teardown cannot close another sensor or the command session. */
export class NvrLiveStream extends EventEmitter {
  private session?: RtcSession;
  private running = false;
  private started = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private readonly onConnected = () => {
    if (!this.running || this.started) return;
    this.started = true;
    if (
      !this.session!.sendCommand(nvrCommand(this.opts.session.adminUserId, this.opts.channel, this.opts.sensor, true))
    ) {
      this.fail(new Error("rtc nvr: start refused"));
      return;
    }
    this.heartbeat = setInterval(() => {
      if (!this.session!.sendRaw(PORTAL_LIVE_KEEPALIVE)) this.fail(new Error("rtc nvr: keepalive refused"));
    }, 10_000);
    this.heartbeat.unref();
    this.emit("start");
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("rtc nvr: session closed"));
  private readonly onMedia = (frame: Buffer) => this.receive(frame);
  private readonly onCommand = (frame: Buffer, link: number) => {
    const h = parsePortalHeader(frame);
    if (
      this.started &&
      link === PortalLinkType.COMMAND &&
      h?.commandId === 1350 &&
      h.channel === 255 &&
      h.segment === 2 &&
      h.isResponse === 1
    ) {
      const reply = parsePortalPacket(frame, link);
      if (reply?.errCode !== undefined && reply.errCode !== 0)
        this.fail(new Error(`rtc nvr: start rejected (${reply.errCode})`));
      return;
    }
    this.receive(frame);
  };

  constructor(private readonly opts: NvrLiveOptions) {
    super();
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    this.started = false;
    const session = (this.opts.createSession ?? ((opts) => new RtcSession(opts)))(this.opts.session);
    this.session = session;
    session.on("connected", this.onConnected);
    session.on("commandData", this.onCommand);
    session.on("mediaData", this.onMedia);
    session.on("error", this.onError);
    session.on("close", this.onClose);
    this.watch(25_000);
    Promise.resolve()
      .then(() => {
        if (this.running) return session.connect();
      })
      .catch(this.onError);
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    const session = this.session!;
    session.off("connected", this.onConnected);
    session.off("commandData", this.onCommand);
    session.off("mediaData", this.onMedia);
    session.off("close", this.onClose);
    if (this.started && session.isConnected)
      session.sendCommand(nvrCommand(this.opts.session.adminUserId, this.opts.channel, this.opts.sensor, false));
    session.close();
    session.off("error", this.onError);
    this.emit("stop");
  }

  private watch(ms: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.fail(new Error("rtc nvr: video deadline expired")), ms);
    this.deadline.unref();
  }

  private fail(error: Error): void {
    if (!this.running) return;
    try {
      this.emit("error", error);
    } finally {
      this.stop();
    }
  }

  private receive(frame: Buffer): void {
    if (!this.running || !this.started) return;
    const video = nvrVideo(frame);
    if (video) {
      this.watch(15_000);
      this.emit("video", video);
      return;
    }
    const audio = nvrAudio(frame);
    if (audio) this.emit("audio", audio);
  }
}
