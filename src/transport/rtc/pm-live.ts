/**
 * Live view over the vendor app's PrivMedia (PM) call: the live commands as `ANKE` RTCP APP frames, the station's
 * SRTP video turned into Annex-B access units.
 *
 * `ANKE` frame, all fields little-endian: u32 magic 0x12345678, u32 seq, u8 type, 3 bytes 0xAA, u32 payload length,
 * u32 checksum (the byte sum of bytes 0..15 and the payload, wrapping), then the payload. Type 1 carries data, 2
 * acknowledges the seq it echoes, 8 asks for an MTU reply (type 9); 8 and 9 are not checksummed. It leaves as a plain
 * RTCP APP packet (subtype 30, name `ANKE`, sender SSRC = the call's audio value, payload zero-padded to 4 bytes); the
 * station's frames arrive as SRTCP whose bytes 8..11 read `AZWC`, the frame from byte 12.
 */
import { EventEmitter } from "node:events";
import type { LiveStreamHandle } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { hasIdr } from "../p2p/annexb.js";
import { MAGIC_WORD } from "../p2p/codec.js";
import { traceLiveStart } from "../p2p/live-trace.js";
import type { RtcCallSdp } from "./call.js";
import { commandFrame, type RtcCommandCounter } from "./data-channel.js";
import type { IceAgent } from "./ice.js";
import { RtpDepacketizer, SrtpReceiver, idrAt, mediaOpen } from "./rtp.js";

const MAGIC = 0x12345678;
const AZWC = 0x415a5743;
const VIDEO_PT: Record<number, "h264" | "h265"> = { 97: "h265", 99: "h264" };
/** How far in ms a live-stream trailer timestamp may lie ahead of the clock: 100 years of 365.25 days. */
const TRAILER_AHEAD = 3155760000000n;

/** The app's media AES-GCM gate (`RTCSdkClient.setDeviceVersion`, `isEncVersion`); any other model always encrypts. */
const MEDIA_GCM: Record<string, (v: number) => boolean> = {
  T8223: () => true,
  T8224: () => true,
  T8030: () => true,
  T8025: () => true,
  T8172: (v) => v >= 1021,
  T8N00: (v) => (v >= 1089 && v < 1200) || v >= 1209,
  T9000: (v) => v >= 4100,
};

/** Whether a device's live media is AES-GCM: by serial prefix and the firmware version with its dots removed. */
export function mediaGcm(sn: string, version: number): boolean {
  return MEDIA_GCM[sn.slice(0, 5)]?.(version) ?? true;
}

/** The `ANKE` checksum of a frame: bytes 0..15 and the payload its length field states. */
export function ankeChecksum(f: Buffer): number {
  let sum = 0;
  for (const b of f.subarray(0, 16)) sum += b;
  for (const b of f.subarray(20, 20 + f.readUInt32LE(12))) sum += b;
  return sum >>> 0;
}

/** An `ANKE` frame of `type` with `payload`. */
export function ankeFrame(seq: number, type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const f = Buffer.concat([Buffer.alloc(20, 0xaa), payload]);
  f.writeUInt32LE(MAGIC, 0);
  f.writeUInt32LE(seq >>> 0, 4);
  f[8] = type;
  f.writeUInt32LE(payload.length, 12);
  f.writeUInt32LE(type === 9 ? 0 : ankeChecksum(f), 16);
  return f;
}

interface Sent {
  seq: number;
  frame: Buffer;
  retries: number;
  last: number;
  timeout: number;
}

/**
 * The `ANKE` reliability layer of one call. A data frame is resent unchanged every 100 ms tick once 100, 200, 500,
 * 500 and 500 ms have passed since its previous send, and dropped one 500 ms period after the fifth resend or on its
 * ACK. A received data frame is ACKed, duplicates (among the last 1000 seqs) only re-ACKed; new payloads queue for
 * {@link Anke.result}.
 */
export class Anke {
  private seq = 0;
  private readonly sent: Sent[] = [];
  private readonly seen: number[] = [];
  private readonly received: Buffer[] = [];
  private readonly timer = setInterval(() => this.tick(), 100);

  constructor(
    private readonly ssrc: number,
    private readonly out: (packet: Buffer) => void,
  ) {}

  /** Send `payload` as a type-1 frame. */
  send(payload: Buffer): void {
    const frame = ankeFrame(this.seq, 1, payload);
    this.sent.push({ seq: this.seq++, frame, retries: 0, last: Date.now(), timeout: 100 });
    this.write(frame);
  }

  /** One station frame. */
  input(f: Buffer): void {
    if (f.length < 20 || f.readUInt32LE(0) !== MAGIC) return;
    const [seq, type] = [f.readUInt32LE(4), f[8]!];
    if ((type & 0xfe) !== 8 && f.readUInt32LE(16) !== ankeChecksum(f)) return;
    if (type === 2) for (let i = this.sent.length; i--;) if (this.sent[i]!.seq === seq) this.sent.splice(i, 1);
    if (type === 8 && f.length >= 34) this.write(ankeFrame(seq, 9, f.subarray(20, 34)));
    if (type !== 1) return;
    if (!this.seen.includes(seq)) {
      if (this.seen.push(seq) > 1000) this.seen.shift();
      this.received.push(Buffer.from(f.subarray(20, 20 + f.readUInt32LE(12))));
    }
    this.write(ankeFrame(seq, 2));
  }

  /**
   * The app's check of a command's answer, taking one queued payload: -1 when none is queued; its length when it is
   * 15 bytes or shorter, not an `XZYH` frame of command `cmd`, or states an empty body; else the i32 at byte 16 (a
   * reply shorter than 20 bytes reads 0xAA past its end). Above 0 is success.
   */
  result(cmd: number): number {
    const p = this.received.shift();
    if (!p) return -1;
    if (p.length <= 15 || p.toString("latin1", 0, 4) !== MAGIC_WORD || p.readUInt16LE(4) !== cmd || !p.readUInt32LE(6))
      return p.length;
    return Buffer.concat([p, Buffer.alloc(4, 0xaa)]).readInt32LE(16);
  }

  close(): void {
    clearInterval(this.timer);
  }

  private tick(): void {
    const now = Date.now();
    for (const s of [...this.sent]) {
      if (now - s.last < Math.min(500, s.timeout)) continue;
      if (s.retries >= 5) {
        this.sent.splice(this.sent.indexOf(s), 1);
        continue;
      }
      s.retries++;
      s.last = now;
      s.timeout = s.timeout < 200 ? s.timeout + 100 : 500;
      this.write(s.frame);
    }
  }

  private write(frame: Buffer): void {
    const pad = Buffer.alloc((4 - (frame.length % 4)) % 4);
    const h = Buffer.from([0x9e, 204, 0, 0, 0, 0, 0, 0, 0x41, 0x4e, 0x4b, 0x45]);
    h.writeUInt16BE((12 + frame.length + pad.length) / 4 - 1, 2);
    h.writeUInt32BE(this.ssrc >>> 0, 4);
    this.out(Buffer.concat([h, frame, pad]));
  }
}

/** A live command as the app's RTC sender frames it: its id, body, header channel and header byte 14. */
export interface RtcLiveCommand {
  cmd: number;
  body: Buffer;
  channel: number;
  flag: number;
}

export interface RtcPmLiveOptions {
  /** The PM call's `sdp_info`: its audio value is the RTCP sender SSRC, its key and iv the media AES-GCM's. */
  call: RtcCallSdp;
  /** Whether the device's media is AES-GCM ({@link mediaGcm}). */
  gcm: boolean;
  /** Whether its live commands are ({@link cmdGcm}). */
  cmdGcm: boolean;
  /** The commands that start (framed on `start()`) and stop (framed when sent) the view. */
  start: () => RtcLiveCommand;
  stop: () => RtcLiveCommand;
  counter?: RtcCommandCounter;
  logger?: Logger;
}

/**
 * One live view on a PM call's media ICE. `start()` sends the start once ICE is connected and then checks for its
 * answer at once and every second, ten times: a queued reply above 0 or a first video unit is success, any other
 * answer or ten empty checks end the view with `error`. `stop()` sends the stop.
 *
 * Video is the SRTP RTP of payload type 97 (H.265) or 99 (H.264). With `gcm`, a parameter-set packet (H.264 SPS/PPS
 * over 18 bytes, H.265 VPS/SPS/PPS over 16) is opened from its third byte; a packet that does not open is kept. Each
 * access unit's last byte must be the start's header channel (`sendRTCChannelNotify`), else it is dropped; the 8
 * bytes before it, a u64 LE ms timestamp no further than 100 years ahead of the clock, go with it. A key frame of 17
 * bytes or more with its IDR NAL header past offset 0 is then opened from that header + 2, and dropped when it does
 * not open. After a drop, units wait for the next key frame.
 */
export class RtcPmLiveStream extends EventEmitter implements LiveStreamHandle {
  private readonly srtp = new SrtpReceiver();
  private readonly anke: Anke;
  private readonly logger: Logger;
  private readonly seal?: { key: Buffer; counter: RtcCommandCounter };
  private readonly units = new Map<number, RtpDepacketizer>();
  private running = false;
  private closed = false;
  private firstUnit = false;
  private firstKey = false;
  private waitKey = false;
  private startedAt = 0;
  private startCommand?: RtcLiveCommand;
  private readonly onConnected = () => {
    traceLiveStart(this.logger, { phase: "session-connected", waitedMs: Date.now() - this.startedAt });
    this.sendStart();
  };
  private readonly onClose = () => {
    this.closed = true;
    this.anke.close();
    this.fail(new Error("rtc pm live: session closed"));
  };

  constructor(
    private readonly agent: IceAgent,
    private readonly opts: RtcPmLiveOptions,
  ) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.anke = new Anke(opts.call.audio, (p) => agent.write(p));
    if (opts.cmdGcm)
      this.seal = {
        key: Buffer.from(opts.call.key, "latin1").subarray(0, 16),
        counter: opts.counter ?? { word: 0x01020304 },
      };
    agent.on("data", (d) => this.onDatagram(d));
    agent.once("close", this.onClose);
  }

  start(): this {
    if (this.running || this.closed) return this;
    this.running = true;
    this.startedAt = Date.now();
    this.startCommand = this.opts.start();
    if (this.agent.connected) this.sendStart();
    else this.agent.once("connected", this.onConnected);
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.agent.off("connected", this.onConnected);
    void this.command(this.opts.stop());
    this.emit("stop");
  }

  private async sendStart(): Promise<void> {
    if (!(await this.command(this.startCommand!)) && this.running)
      this.fail(new Error("rtc pm live: start not answered"));
  }

  /** Send a command over `ANKE` and check its answer as the app does (`setCmd2Rtcp`); `true` on success. */
  private async command(c: RtcLiveCommand): Promise<boolean> {
    this.anke.send(commandFrame(c.cmd, c.body, c.channel, this.seal, c.flag));
    for (let i = 0; i < 10 && !this.closed; i++) {
      const r = this.anke.result(c.cmd);
      if (r > 0 || this.firstUnit) return true;
      if (r !== -1) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  private fail(err: Error): void {
    if (!this.running) return;
    this.running = false;
    this.logger.warn(`[rtc-pm] ${err.message}`);
    this.emit("error", err);
  }

  private onDatagram(d: Buffer): void {
    const p = this.srtp.unprotect(d);
    if (!p) return;
    const pt = p[1]! & 0x7f;
    if (pt >= 64 && pt < 96) {
      if (p.length > 11 && p.length % 4 === 0 && p.readUInt32BE(8) === AZWC) this.anke.input(p.subarray(12));
      return;
    }
    const codec = VIDEO_PT[pt];
    if (!codec || !this.running) return;
    let units = this.units.get(pt);
    if (!units) {
      const single = this.opts.gcm ? (nal: Buffer) => this.openParameterSet(codec, nal) : undefined;
      units = new RtpDepacketizer(codec, (unit, ts) => this.onUnit(codec, unit, ts), single);
      this.units.set(pt, units);
    }
    units.push(p);
  }

  private openParameterSet(codec: "h264" | "h265", nal: Buffer): Buffer {
    const set =
      codec === "h265"
        ? [32, 33, 34].includes((nal[0]! >> 1) & 0x3f) && nal.length > 16
        : [7, 8].includes(nal[0]! & 0x1f) && nal.length > 18;
    return (set && mediaOpen(this.opts.call.key, this.opts.call.iv, nal, 2)) || nal;
  }

  private onUnit(codec: "h264" | "h265", unit: Buffer, timestamp: number): void {
    const keyframe = hasIdr(unit, codec);
    if (!keyframe && this.waitKey) return;
    if (unit[unit.length - 1] !== this.startCommand!.channel) return void (this.waitKey = true);
    const ahead = BigInt(Math.floor(Date.now() / 1000)) * 1000n + TRAILER_AHEAD;
    let data = unit.subarray(
      0,
      unit.length - (unit.length >= 9 && unit.readBigUInt64LE(unit.length - 9) <= ahead ? 9 : 1),
    );
    const idr = keyframe && this.opts.gcm && data.length >= 17 ? idrAt(data, codec) : -1;
    if (idr >= 1) {
      const plain = mediaOpen(this.opts.call.key, this.opts.call.iv, data, idr + 2);
      if (!plain) return void (this.waitKey = true);
      data = plain;
    }
    if (keyframe) this.waitKey = false;
    if (!this.firstUnit) traceLiveStart(this.logger, { phase: "first-video-unit", keyframe });
    if (keyframe && !this.firstKey) traceLiveStart(this.logger, { phase: "first-keyframe" });
    this.firstUnit = true;
    this.firstKey ||= keyframe;
    this.emit("video", { codec, data, keyframe, width: 0, height: 0, sourceTimestamp: timestamp });
  }
}
