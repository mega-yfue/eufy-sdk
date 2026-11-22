/**
 * The PRIV1 data channel of the vendor app's native RTC client: commands and their replies, and the station's
 * notifies, over KCP on the call's libjuice ICE.
 *
 * Send: a command is an `XZYH` frame, cut into chunks of at most 120000 bytes; each chunk gets the Wrtc link header
 * of {@link wrtcLink} with element type 1 and is one KCP message on conv 1. With the Multi KCP type every KCP datagram
 * is prefixed by 32 bytes, `u32 LE conv ‖ u32 LE 1 ‖ 24 zero bytes`.
 *
 * Receive: a Multi datagram longer than 32 bytes loses its prefix and goes to conv 3 when its u32 is 3, else to conv
 * 1; anything else goes to conv 1 whole, and the 4-byte `EF BE` transport probe is dropped. Each KCP message is read
 * by {@link readLinkMessage}; element type 1 feeds the reply stream, type 3 the notify stream, every other type is
 * `link`. Both streams carry `XZYH` frames (16-byte header, u32 LE body length at 6); a frame with another magic
 * empties its stream. A reply resolves the oldest pending command of its command id with its body as sent. A notify
 * whose header byte 10 is `0x0a` is AES-128-GCM, `tag(16) ‖ iv(12) ‖ ciphertext` under the channel key, and is dropped
 * when it does not open.
 *
 * KCP runs as the app's thread does, every 1 ms: update each conv, then take one message from each. Conv 1 is
 * `nodelay(1, 2, 2, 1)`, windows 512, MTU 1200, minimum RTO 2; the Multi conv 3 `nodelay(1, 1, 2, 1)`, windows 2048,
 * MTU 1200, minimum RTO 1.
 */
import { EventEmitter } from "node:events";
import { crc32 } from "node:zlib";
import { MAGIC_WORD, buildRawCommandPayload, gcmOpen, gcmSeal } from "../p2p/codec.js";
import { RtcCallType } from "./call.js";
import { IceAgent, turnServer } from "./ice.js";
import { Kcp } from "./kcp.js";
import type { RtcSignalClient } from "./signal-client.js";

const CHUNK = 120_000;
const CMD = 1;
const NOTIFY = 3;
const GCM_VERSION = 0x0a;
const PROBE = Buffer.from([0xef, 0xbe, 0, 0]);
/** The app's per-model firmware gate for the command AES-GCM; any other model always encrypts. */
const CMD_GCM: Record<string, (v: number) => boolean> = {
  T9000: (v) => v > 4099,
  T8N00: (v) => (v >= 1089 && v <= 1199) || v > 1208,
  T8223: (v) => v > 3375,
  T8224: (v) => v > 3475,
  T8030: (v) => v > 3742,
  T8172: (v) => v > 1021,
  T8025: () => false,
};
/** The `webrtc_sdk_version` from which a model's PRIV1 runs the Multi KCP type (`file_agent_get_kcp_type`). */
const KCP_MULTI_FROM: Record<string, string> = {
  T8223: "6.1.3",
  T8224: "6.1.3",
  T8030: "7.1.3",
  T8025: "7.1.3",
  T8N00: "7.1.2",
  T9000: "7.1.2",
};
/** The process-wide Wrtc link send counter, zero at load and shared by both header variants. */
let linkCounter = 0;

/** Whether a device's commands go AES-GCM: by serial prefix and the firmware version with its dots removed. */
export function cmdGcm(sn: string, version: number): boolean {
  return CMD_GCM[sn.slice(0, 5)]?.(version) ?? true;
}

/**
 * Whether a device's PRIV1 runs the Multi KCP type: any model without a floor, or no version, does; a version that is
 * not `x.y.z` does except on a T8030 or T8025; otherwise the floor is compared on its second and third numbers only, as
 * the app's `compare_version_bc` does.
 */
export function kcpMulti(sn: string, sdkVersion?: string): boolean {
  const model = sn.slice(0, 5);
  const from = KCP_MULTI_FROM[model];
  if (!from || !sdkVersion) return true;
  if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) return model !== "T8030" && model !== "T8025";
  const [, b1, c1] = sdkVersion.split(".").map(Number);
  const [, b2, c2] = from.split(".").map(Number);
  return b1 !== b2 ? b1! > b2! : c1! >= c2!;
}

/**
 * One Wrtc link packet, all fields little-endian, unnamed bytes 0. Multi: `u16 9, u16 24, u32 length, u8 1, 3 bytes,
 * u32 time(s), u8 type, 3 bytes, u32 counter`; Single: `u16 9, u16 20, u16 length, u8 1, u8 0, u32 time(s), u8 type,
 * 3 bytes, u32 counter`; then the data.
 */
export function wrtcLink(type: number, data: Buffer, multi: boolean): Buffer {
  const h = Buffer.alloc(multi ? 24 : 20);
  const at = multi ? [4, 8, 12, 16, 20] : [4, 6, 8, 12, 16];
  h.writeUInt16LE(9, 0);
  h.writeUInt16LE(h.length, 2);
  if (multi) h.writeUInt32LE(data.length, at[0]);
  else h.writeUInt16LE(data.length, at[0]);
  h[at[1]!] = 1;
  h.writeUInt32LE(Math.floor(Date.now() / 1000) >>> 0, at[2]);
  h[at[3]!] = type;
  h.writeUInt32LE(linkCounter, at[4]);
  linkCounter = (linkCounter + 1) >>> 0;
  return Buffer.concat([h, data]);
}

/**
 * A received KCP message: a 20-byte head (u32 LE at 8 = data length, which must be the rest of the message and not 0;
 * u32 LE at 12 = its CRC-32), then a Wrtc link packet (magic 9, its header length at 2 and data length at 4, which
 * together must reach the packet's end). Its element type and data, `undefined` when a check fails.
 */
export function readLinkMessage(msg: Buffer, multi: boolean): { type: number; data: Buffer } | undefined {
  const n = msg.length - 20;
  if (n <= 0 || msg.readUInt32LE(8) !== n || msg.readUInt32LE(12) !== crc32(msg.subarray(20))) return undefined;
  const p = msg.subarray(20);
  if (p.length < (multi ? 24 : 20) || p.readUInt16LE(0) !== 9) return undefined;
  const hdr = p.readUInt16LE(2);
  const len = multi ? p.readUInt32LE(4) : p.readUInt16LE(4);
  if (hdr + len < p.length) return undefined;
  return { type: p[multi ? 16 : 12]!, data: p.subarray(hdr, hdr + len) };
}

/**
 * An `XZYH` command frame: magic, u16 LE id, u32 LE body length, byte 10 version, 11 0, 12 channel, 13 sign code,
 * 14 and 15 0, then the body.
 */
function xzyh(cmd: number, body: Buffer, channel: number, version: number, sign: number): Buffer {
  const id = Buffer.alloc(2);
  id.writeUInt16LE(cmd);
  return Buffer.concat([Buffer.from(MAGIC_WORD), id, buildRawCommandPayload(body, channel, sign, [version, 0])]);
}

/** The per-device count every AES-GCM command carries, from 0x01020304, shared by the data channel and RTCP. */
export interface RtcCommandCounter {
  word: number;
}

/**
 * A command's `XZYH` frame, its body (JSON text without NUL, or the native body) and header byte 12 = `channel`. With
 * `seal` and a body of 1 to 0x200000 bytes it is AES-128-GCM under the first 16 bytes of the key: byte 10 `0x0a`, byte
 * 13 1, body {@link gcmSeal} under the counter, which counts on.
 */
export function commandFrame(
  cmd: number,
  body: string | Buffer,
  channel: number,
  seal?: { key: Buffer; counter: RtcCommandCounter },
): Buffer {
  const text = Buffer.from(body);
  return seal && text.length >= 1 && text.length <= 0x200000
    ? xzyh(cmd, gcmSeal(seal.key, text, seal.counter.word++), channel, GCM_VERSION, 1)
    : xzyh(cmd, text, channel, 1, 0);
}

function kcp(conv: number, out: (d: Buffer) => void): Kcp {
  const k = new Kcp(conv, out);
  k.nodelay(1, conv === 1 ? 2 : 1, 2, 1);
  k.wndsize(conv === 1 ? 512 : 2048, conv === 1 ? 512 : 2048);
  k.setmtu(1200);
  k.rxMinrto = conv === 1 ? 2 : 1;
  return k;
}

interface Pending {
  cmd: number;
  resolve: (body: Buffer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RtcDataChannelEvents {
  /** A station notify: its command id and (decrypted) body. */
  notify: [cmd: number, body: Buffer];
  /** A message of another element type (2 file, 4 playback, 7 stream, 0x62, 0x63). */
  link: [type: number, data: Buffer];
  close: [];
}

export class RtcDataChannel extends EventEmitter<RtcDataChannelEvents> {
  /** Writes are refused until ICE connects or a first message arrives, as the app's `file_agent_connected` gates them. */
  connected = false;
  private readonly kcps: Kcp[];
  private readonly streams = new Map<number, Buffer>([
    [CMD, Buffer.alloc(0)],
    [NOTIFY, Buffer.alloc(0)],
  ]);
  private readonly pending: Pending[] = [];
  private readonly key: Buffer;
  private readonly seal?: { key: Buffer; counter: RtcCommandCounter };
  private readonly timer: NodeJS.Timeout;

  /**
   * `out` sends one datagram on the ICE pair. `key` is the PRIV1 call's `sdp_info` key, whose first 16 bytes key the
   * command GCM; `gcm` is {@link cmdGcm} for the device, `counter` its command counter; `multi` the Multi KCP type.
   */
  constructor(
    private readonly out: (datagram: Buffer) => void,
    private readonly opts: { multi: boolean; key: string; gcm: boolean; counter?: RtcCommandCounter },
  ) {
    super();
    this.key = Buffer.from(opts.key, "latin1").subarray(0, 16);
    if (opts.gcm) this.seal = { key: this.key, counter: opts.counter ?? { word: 0x01020304 } };
    const send = (conv: number) => (d: Buffer) => this.out(opts.multi ? Buffer.concat([prefix(conv), d]) : d);
    this.kcps = opts.multi ? [kcp(1, send(1)), kcp(3, send(3))] : [kcp(1, send(1))];
    this.timer = setInterval(() => {
      for (const k of this.kcps) {
        k.update(Date.now());
        const m = k.recv();
        if (m) this.onMessage(m);
      }
    }, 1);
  }

  /** One datagram from the ICE pair. */
  input(d: Buffer): void {
    if (d.length === 4 && d.readUInt16LE(0) === 0xbeef) return;
    if (!this.opts.multi || d.length <= 32) return void this.kcps[0]!.input(d);
    this.kcps[d.readUInt32LE(0) === 3 && this.kcps[1] ? 1 : 0]!.input(d.subarray(32));
  }

  /**
   * Send a command on the data channel, the app's route for all but its RTCP-bound live commands, as
   * {@link commandFrame} (sealed with {@link cmdGcm}); resolves with the reply body, rejects after 20 s (35 s for a
   * 1350 whose `cmd` is 6236).
   */
  command(cmd: number, body: string | Buffer, channel = 0): Promise<Buffer> {
    if (!this.connected) return Promise.reject(new Error("rtc data channel not connected"));
    const frame = commandFrame(cmd, body, channel, this.seal);
    for (let o = 0; o < frame.length; o += CHUNK)
      this.kcps[0]!.send(wrtcLink(CMD, frame.subarray(o, o + CHUNK), this.opts.multi));
    const long = cmd === 1350 && jsonCmd(String(body)) === 6236;
    return new Promise((resolve, reject) => {
      const p: Pending = {
        cmd,
        resolve,
        reject,
        timer: setTimeout(() => this.settle(p, new Error(`rtc command ${cmd} timed out`)), long ? 35_000 : 20_000),
      };
      this.pending.push(p);
    });
  }

  close(): void {
    clearInterval(this.timer);
    for (const p of [...this.pending]) this.settle(p, new Error("rtc data channel closed"));
    this.emit("close");
  }

  private settle(p: Pending, result: Buffer | Error): void {
    clearTimeout(p.timer);
    this.pending.splice(this.pending.indexOf(p), 1);
    if (result instanceof Error) p.reject(result);
    else p.resolve(result);
  }

  private onMessage(m: Buffer): void {
    const msg = readLinkMessage(m, this.opts.multi);
    if (!msg) return;
    this.connected = true;
    const stream = this.streams.get(msg.type);
    if (!stream) return void this.emit("link", msg.type, msg.data);
    let buf = Buffer.concat([stream, msg.data]);
    while (buf.length >= 16) {
      if (buf.toString("latin1", 0, 4) !== MAGIC_WORD) buf = Buffer.alloc(0);
      else if (buf.length >= 16 + buf.readUInt32LE(6)) {
        const end = 16 + buf.readUInt32LE(6);
        this.onFrame(msg.type, buf.subarray(0, 16), buf.subarray(16, end));
        buf = buf.subarray(end);
      } else break;
    }
    this.streams.set(msg.type, buf);
  }

  private onFrame(type: number, head: Buffer, body: Buffer): void {
    const cmd = head.readUInt16LE(4);
    if (type === CMD) {
      const p = this.pending.find((q) => q.cmd === cmd);
      if (p) this.settle(p, Buffer.from(body));
      return;
    }
    const plain = head[10] === GCM_VERSION ? (body.length > 28 ? gcmOpen(this.key, body) : undefined) : body;
    if (plain) this.emit("notify", cmd, Buffer.from(plain));
  }
}

function prefix(conv: number): Buffer {
  const p = Buffer.alloc(32);
  p.writeUInt32LE(conv, 0);
  p.writeUInt32LE(1, 4);
  return p;
}

function jsonCmd(json: string): unknown {
  try {
    return (JSON.parse(json) as { cmd?: unknown }).cmd;
  } catch {
    return undefined;
  }
}

/** Per candidate type: resend period while the retry count is below the limit, the period from then on. */
const RESEND: [type: string, ms: number, below: number, after: number][] = [
  ["typ host", 300, 8, 1000],
  ["typ srflx", 500, 6, 1500],
  ["", 800, 4, 2000],
];

/**
 * Place a PRIV1 call and run its data channel as the app does. `flag` is the call's `sdp_info` byte 2 (3 with the
 * Multi KCP type of {@link kcpMulti}, else 0); `version` the firmware with its dots removed; `counter` the device's
 * command counter. The call's 100 or 200 `turn` is the TURN server (port 3478 when it has none); on the 200 the libjuice agent ({@link IceAgent} `juice`) gathers with the
 * call's own ufrag and pwd on both sides. Each local candidate of slot `n − 1` (n < 9) goes out as INFO
 * `{"file_candidate", "file_candidate_num"}` and again until the station acks it, every 300 ms (host, 1000 ms after 8
 * sends), 500 ms (srflx, 1500 ms after 6) or 800 ms (relay, 2000 ms after 4), doubled from the fifth resend; once
 * gathering is done the local description goes out once as INFO `{"sdp"}`. A station candidate is added once per slot
 * number. ICE connected opens the channel and sends the KCP transport probe `EF BE 00 00` five times 1 ms apart.
 */
export function priv1(
  signal: RtcSignalClient,
  opts: { sn: string; version: number; flag: number; counter?: RtcCommandCounter },
): RtcDataChannel {
  const call = signal.call(RtcCallType.PRIV1, opts.flag);
  const agent = new IceAgent(call.ufrag, call.pwd, true);
  const channel = new RtcDataChannel((d) => agent.write(d), {
    multi: (opts.flag & 1) === 1,
    key: call.key,
    gcm: cmdGcm(opts.sn, opts.version),
    counter: opts.counter,
  });
  const mine = (uuid: string) => uuid === call.uuid;
  const lines: string[] = [];
  const slots = new Set<number>();
  const acked = new Set<number>();
  const timers = new Map<number | string, NodeJS.Timeout>();
  const onTrying = (uuid: string, turn: unknown) => {
    if (mine(uuid)) agent.turn = turnServer(turn, 3478);
  };
  const onAnswer = (uuid: string) => {
    if (!mine(uuid)) return;
    void agent.start(call.ufrag, call.pwd).then(() => {
      const sdp = `a=ice-ufrag:${call.ufrag}\r\na=ice-pwd:${call.pwd}\r\n${lines.map((l) => `${l}\r\n`).join("")}`;
      signal.info(uuid, { sdp: `${sdp}a=end-of-candidates\r\na=ice-options:ice2\r\n` });
    });
  };
  const onCandidate = (uuid: string, line: string, num: number) => {
    if (!mine(uuid) || slots.has(num)) return;
    slots.add(num);
    agent.addRemoteCandidate(line);
  };
  const onAck = (uuid: string, num: number) => void (mine(uuid) && acked.add(num));
  signal.on("trying", onTrying).on("answer", onAnswer).on("fileCandidate", onCandidate).on("fileCandidateAck", onAck);
  agent.on("candidate", (line) => {
    lines.push(line);
    const slot = Number(/^a=candidate:(\d+)/.exec(line)?.[1]) - 1;
    if (!(slot < 8)) return;
    const [, ms, below, after] = RESEND.find(([t]) => line.includes(t))!;
    let sends = 0;
    const send = () => {
      if (acked.has(slot)) return;
      signal.info(call.uuid, { file_candidate: line, file_candidate_num: slot });
      timers.set(slot, setTimeout(send, (sends < below ? ms : after) * (sends >= 5 ? 2 : 1)));
      sends++;
    };
    send();
  });
  agent.on("data", (d) => channel.input(d));
  agent.once("connected", () => {
    channel.connected = true;
    for (let i = 0; i < 5; i++)
      timers.set(
        `probe${i}`,
        setTimeout(() => agent.write(PROBE), i),
      );
  });
  channel.once("close", () => {
    timers.forEach(clearTimeout);
    signal
      .off("trying", onTrying)
      .off("answer", onAnswer)
      .off("fileCandidate", onCandidate)
      .off("fileCandidateAck", onAck);
    agent.close();
    signal.hangup(call.uuid);
  });
  return channel;
}
