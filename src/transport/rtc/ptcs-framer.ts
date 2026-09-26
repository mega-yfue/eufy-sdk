/**
 * The PTCS packetiser — a clean-room implementation of the framing the portal wraps around every
 * portal packet on `WebrtcDataChannel`, written from the wire behaviour of the portal's own module
 * (`libsctp`, "SCTP Version V1.0.3") observed offline: frames of 0–16 000 bytes pushed in, the packets
 * that came out, and what the receiving side reassembled from them. Nothing of that module ships here.
 *
 * Every wire packet is the same size, `28 + maxPacketBytes`, zero-padded. The live portal sends 1000 →
 * 1028-byte packets; the offline vectors were taken at 800, and the receiver accepts either, since the
 * size is carried per packet:
 *
 *   0   "PTCS"
 *   4   u8   3              constant — protocol version, as far as the vectors show
 *   5   u8   channel        the SCTP channel the frame belongs to: 0 command, 2 notify, 3 file, 4 playback, 5 live
 *   6   u16  sequence       a FRAME counter: every packet of a frame carries the same value, and it
 *                           steps once per frame. Both sources agree — the live portal sent 25, 26, 27
 *                           on three consecutive one-packet frames, and in the offline vectors each
 *                           frame's packets all carry the generator's starting 0, which a per-PACKET
 *                           counter could not produce.
 *   8   u32  frame id       one value per frame, shared by all its packets — the portal uses a ms clock
 *   12  u32  frame length   total bytes of the frame
 *   16  u16  packet index   0-based position of this packet in the frame
 *   18  u16  0x4000 | (last ? 0x0400 : 0) | payload length      (payload ≤ 1023 fits the low bits)
 *   20  8 × 0
 *   28  payload             `payload length` bytes, then zeros to the packet size
 *
 * No forward-error-correction packets were ever emitted (the module's FEC group setting changed
 * nothing), and a frame with one packet missing never reassembles — so the receiver here does the same:
 * it completes a frame only when every index up to the `last` one is present and their lengths add up.
 * Frames whose packets stop arriving are dropped after `staleMs`.
 */

import { isPortalPacket, PortalLinkType } from "./portal-packet.js";
import type { PortalFramer } from "./framer.js";

const MAGIC = Buffer.from("PTCS", "ascii");
export const PTCS_HEADER_LENGTH = 28;
/**
 * The portal's packet payload size, read off its own wire: every packet it sends on the command channel
 * is 1028 bytes, i.e. 1000 of payload after the 28-byte header.
 */
export const PTCS_DEFAULT_PAYLOAD_BYTES = 1000;
const FLAG_BASE = 0x4000;
const FLAG_LAST = 0x0400;
const LENGTH_MASK = 0x03ff;

/** SCTP channel ids as the portal numbers them, and the link type each maps to on receive. */
export const PtcsChannel = {
  COMMAND: 0,
  LIVE: 1,
  NOTIFY: 2,
  FILE: 3,
  PLAYBACK: 4,
} as const;

export function linkTypeForChannel(channel: number): number {
  switch (channel) {
    case PtcsChannel.COMMAND:
      return PortalLinkType.COMMAND;
    case PtcsChannel.NOTIFY:
      return PortalLinkType.NOTIFY;
    case PtcsChannel.FILE:
      return PortalLinkType.FILE;
    case PtcsChannel.PLAYBACK:
      return PortalLinkType.PLAYBACK;
    case 1:
    case 5:
      return PortalLinkType.LIVE;
    default:
      return PortalLinkType.INNER;
  }
}

export interface PtcsHeader {
  channel: number;
  /** The sender's running packet counter — see the header map. */
  sequence: number;
  frameId: number;
  frameLength: number;
  index: number;
  last: boolean;
  payloadLength: number;
}

export function parsePtcsHeader(packet: Buffer): PtcsHeader | undefined {
  if (packet.length < PTCS_HEADER_LENGTH || packet.subarray(0, 4).compare(MAGIC) !== 0) return undefined;
  const flags = packet.readUInt16LE(18);
  return {
    channel: packet[5]!,
    sequence: packet.readUInt16LE(6),
    frameId: packet.readUInt32LE(8),
    frameLength: packet.readUInt32LE(12),
    index: packet.readUInt16LE(16),
    last: (flags & FLAG_LAST) !== 0,
    payloadLength: flags & LENGTH_MASK,
  };
}

/** Split one frame into wire packets. */
export function packetize(
  frame: Buffer,
  opts: { channel?: number; frameId: number; payloadBytes?: number; sequence?: number },
): Buffer[] {
  const size = opts.payloadBytes ?? PTCS_DEFAULT_PAYLOAD_BYTES;
  if (size <= 0 || size > LENGTH_MASK) throw new RangeError(`PTCS payload size ${size} out of range`);
  const channel = opts.channel ?? PtcsChannel.COMMAND;
  const count = Math.max(1, Math.ceil(frame.length / size));
  const sequence = (opts.sequence ?? 0) & 0xffff;
  const packets: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = frame.subarray(i * size, Math.min(frame.length, (i + 1) * size));
    const last = i === count - 1;
    const packet = Buffer.alloc(PTCS_HEADER_LENGTH + size);
    MAGIC.copy(packet, 0);
    packet[4] = 3;
    packet[5] = channel & 0xff;
    packet.writeUInt16LE(sequence, 6);
    packet.writeUInt32LE(opts.frameId >>> 0, 8);
    packet.writeUInt32LE(frame.length >>> 0, 12);
    packet.writeUInt16LE(i, 16);
    packet.writeUInt16LE(FLAG_BASE | (last ? FLAG_LAST : 0) | chunk.length, 18);
    chunk.copy(packet, PTCS_HEADER_LENGTH);
    packets.push(packet);
  }
  return packets;
}

interface Partial {
  channel: number;
  frameLength: number;
  chunks: Map<number, Buffer>;
  lastIndex?: number;
  touched: number;
}

/** Reassemble frames from wire packets, in any order, one frame at a time per (channel, id). */
export class PtcsReassembler {
  private readonly partials = new Map<string, Partial>();

  constructor(
    private readonly onFrame: (frame: Buffer, channel: number) => void,
    private readonly opts: { staleMs?: number; now?: () => number } = {},
  ) {}

  push(packet: Buffer): boolean {
    const h = parsePtcsHeader(packet);
    if (!h) return false;
    const body = packet.subarray(PTCS_HEADER_LENGTH, PTCS_HEADER_LENGTH + h.payloadLength);
    if (body.length !== h.payloadLength) return false;
    const key = `${h.channel}:${h.frameId}`;
    const now = (this.opts.now ?? Date.now)();
    let p = this.partials.get(key);
    if (!p) {
      p = { channel: h.channel, frameLength: h.frameLength, chunks: new Map(), touched: now };
      this.partials.set(key, p);
    }
    p.touched = now;
    p.chunks.set(h.index, Buffer.from(body));
    if (h.last) p.lastIndex = h.index;
    if (p.lastIndex === undefined) return true;
    let total = 0;
    const parts: Buffer[] = [];
    for (let i = 0; i <= p.lastIndex; i++) {
      const c = p.chunks.get(i);
      if (!c) return true;
      parts.push(c);
      total += c.length;
    }
    this.partials.delete(key);
    if (total !== p.frameLength) return false;
    this.onFrame(Buffer.concat(parts, total), p.channel);
    return true;
  }

  /** Drop frames that stopped arriving; call periodically. */
  expire(): number {
    const staleMs = this.opts.staleMs ?? 15_000;
    const now = (this.opts.now ?? Date.now)();
    let dropped = 0;
    for (const [key, p] of this.partials) {
      if (now - p.touched > staleMs) {
        this.partials.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  get pending(): number {
    return this.partials.size;
  }
}

/** Frame ids the way the portal draws them — a millisecond clock, nudged forward on a collision. */
export function frameIdClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    let id = now() >>> 0;
    if (id <= last) id = (last + 1) >>> 0;
    last = id;
    return id;
  };
}

export interface PtcsFramerOptions {
  payloadBytes?: number;
  /** Where the frame counter starts; the portal's was mid-run when it was observed. */
  sequence?: number;
  staleMs?: number;
  nextFrameId?: () => number;
  now?: () => number;
}

/** The {@link PortalFramer} the session uses: PTCS out, PTCS in, with the portal's channel mapping. */
export class PtcsFramer implements PortalFramer {
  private onWire?: (packet: Buffer) => void;
  private onFrame?: (frame: Buffer, linkType: number) => void;
  private reassembler?: PtcsReassembler;
  private sweep?: NodeJS.Timeout;
  private ready = false;
  private readonly nextFrameId: () => number;
  private sequence: number;

  constructor(private readonly opts: PtcsFramerOptions = {}) {
    this.nextFrameId = opts.nextFrameId ?? frameIdClock(opts.now);
    this.sequence = (opts.sequence ?? 0) & 0xffff;
  }

  async init(
    onWirePacket: (packet: Buffer) => void,
    onFrame: (frame: Buffer, linkType: number) => void,
  ): Promise<void> {
    this.onWire = onWirePacket;
    this.onFrame = onFrame;
    this.reassembler = new PtcsReassembler((frame, channel) => this.onFrame?.(frame, linkTypeForChannel(channel)), {
      staleMs: this.opts.staleMs,
      now: this.opts.now,
    });
    this.sweep = setInterval(() => this.reassembler?.expire(), 1_000);
    this.sweep.unref?.();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFrame(portalPacket: Buffer): void {
    if (!this.ready) throw new Error("PTCS framer not initialised");
    const packets = packetize(portalPacket, {
      frameId: this.nextFrameId(),
      payloadBytes: this.opts.payloadBytes,
      sequence: this.sequence,
    });
    this.sequence = (this.sequence + 1) & 0xffff;
    for (const packet of packets) this.onWire?.(packet);
  }

  recvPacket(wirePacket: Buffer): void {
    if (!this.ready) return;
    // The hub sometimes answers with a bare portal packet; pass it through as a command frame.
    if (isPortalPacket(wirePacket)) {
      this.onFrame?.(wirePacket, PortalLinkType.COMMAND);
      return;
    }
    this.reassembler?.push(wirePacket);
  }

  destroy(): void {
    this.ready = false;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    this.reassembler = undefined;
    this.onWire = undefined;
    this.onFrame = undefined;
  }
}
