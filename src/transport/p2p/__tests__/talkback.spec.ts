import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { MAGIC_WORD } from "../codec.js";
import { withGcmKey } from "./session-fixtures.js";

/**
 * Byte layout of the host→device talkback frames, asserted against a live capture of the app driving
 * three cameras across both topologies (2026-07-31): a HomeBase serving channels 2 and 3, and a
 * standalone T8170 on channel 0.
 *
 * The datagram the capture shows for one audio frame, from the `XZYH` magic onward:
 *
 * ```
 * 585a5948  1505  90000000  0100  0000  0000  80000000 00000000 0000000000000000  fff16040…
 * XZYH      1301  len=144   magic ch=0  type  adtsLen  channel  (8 zero bytes)    ADTS frame
 *                           0100  sign=0
 * ```
 *
 * A session is driven directly with a stubbed socket + connect address, so the frames are asserted as
 * they would leave the wire without any UDP.
 */
const KEY32 = Buffer.alloc(32, 7);

interface Internals {
  socket: { send: ReturnType<typeof vi.fn> };
  connectAddress: { host: string; port: number };
}

/** A session with its socket stubbed and an address in place, so sends are captured not transmitted. */
function newSession(opts: { level2?: boolean } = {}): { session: P2PSession; sent: Buffer[] } {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const sent: Buffer[] = [];
  const internals = session as unknown as Internals;
  internals.socket = { send: vi.fn((buf: Buffer) => void sent.push(Buffer.from(buf))) };
  internals.connectAddress = { host: "<cam-lan-ip>", port: 32100 };
  if (opts.level2) withGcmKey(session, KEY32);
  return { session, sent };
}

/** Strip the DRW (`f1d0`) wrapper and return the frame from its `XZYH` magic onward. */
function frameOf(datagram: Buffer): Buffer {
  const at = datagram.indexOf(Buffer.from(MAGIC_WORD));
  expect(at).toBeGreaterThanOrEqual(0);
  return datagram.subarray(at);
}

/** The `[dataTypeHeader(2)][seq(2 BE)]` the DRW payload leads with, ahead of the magic. */
function dataTypeAndSeq(datagram: Buffer): { dataType: number; seq: number } {
  const at = datagram.indexOf(Buffer.from(MAGIC_WORD));
  return { dataType: datagram[at - 3], seq: datagram.readUInt16BE(at - 2) };
}

/** One whole ADTS AAC frame: AAC-LC, 16 kHz, mono, `payloadLen` bytes of payload. */
function adtsFrame(payloadLen: number): Buffer {
  const total = 7 + payloadLen;
  const h = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x00, 0x1f, 0xfc]);
  h[3] = 0x40 | ((total >> 11) & 0x03);
  h[4] = (total >> 3) & 0xff;
  h[5] = ((total & 0x07) << 5) | 0x1f;
  return Buffer.concat([h, Buffer.alloc(payloadLen, 0xa5)]);
}

describe("outbound audio frame (CMD_AUDIO_FRAME 1301)", () => {
  it("rides the video data-type channel, plaintext, with the captured 16-byte header", () => {
    const { session, sent } = newSession();
    const frame = adtsFrame(121); // 128-byte ADTS frame, the size the capture's first frames carry
    session.sendAudioFrame(0, frame);

    expect(sent).toHaveLength(1);
    const { dataType, seq } = dataTypeAndSeq(sent[0]);
    expect(dataType).toBe(0x01); // VIDEO
    expect(seq).toBe(0);

    const f = frameOf(sent[0]);
    expect(f.readUInt16LE(4)).toBe(1301);
    expect(f.readUInt32LE(6)).toBe(frame.length + 16);
    expect(f.subarray(10, 12)).toEqual(Buffer.from([0x01, 0x00])); // magic
    expect(f[12]).toBe(0); // frame-header channel
    expect(f[13]).toBe(0); // signCode 0 — audio is never encrypted
    expect(f[14]).toBe(0); // type

    const body = f.subarray(16);
    expect(body.readUInt32LE(0)).toBe(frame.length);
    expect(body.readUInt32LE(4)).toBe(0);
    expect(body.subarray(8, 16)).toEqual(Buffer.alloc(8));
    expect(body.subarray(16)).toEqual(frame);
  });

  it("repeats the camera channel in both the frame header and the body", () => {
    const { session, sent } = newSession();
    session.sendAudioFrame(3, adtsFrame(100));
    const f = frameOf(sent[0]);
    expect(f[12]).toBe(3);
    expect(f.subarray(16).readUInt32LE(4)).toBe(3);
  });

  it("declares a length that agrees with the ADTS header's own — the invariant the capture holds", () => {
    const { session, sent } = newSession();
    for (const payload of [64, 99, 121, 200]) session.sendAudioFrame(2, adtsFrame(payload));
    for (const datagram of sent) {
      const body = frameOf(datagram).subarray(16);
      const adts = body.subarray(16);
      const adtsLen = ((adts[3] & 0x03) << 11) | (adts[4] << 3) | ((adts[5] & 0xe0) >> 5);
      expect(body.readUInt32LE(0)).toBe(adtsLen);
      expect(frameOf(datagram).readUInt32LE(6)).toBe(adtsLen + 16);
    }
  });

  it("counts audio frames on a sequence of their own, not the control channel's", () => {
    const { session, sent } = newSession({ level2: true });
    session.sendAudioFrame(0, adtsFrame(64));
    session.sendFrame({ cmd: 1005, body: "native", payload: {}, layout: "u32-ch" }, 0); // a control send in between must not disturb the audio counter
    session.sendAudioFrame(0, adtsFrame(64));
    const audio = sent.filter((d) => dataTypeAndSeq(d).dataType === 0x01);
    expect(audio.map((d) => dataTypeAndSeq(d).seq)).toEqual([0, 1]);
  });

  it("sends nothing when the session has no address yet", () => {
    const { session, sent } = newSession();
    (session as unknown as { connectAddress?: unknown }).connectAddress = undefined;
    session.sendAudioFrame(0, adtsFrame(64));
    expect(sent).toEqual([]);
  });
});

/**
 * The audio channel is reliable and ordered: the device acknowledges each frame and stalls on a gap,
 * so a lost datagram blocks everything behind it. Measured on the app's own capture — 20 of 53 frames
 * were retransmitted — which is why playback previously stopped after ~2 s at the first loss.
 */
describe("audio channel acknowledgement + retransmission", () => {
  /** The device's acknowledgement frame: `[f1d1][len][dataTypeHeader][count][seq…]`. */
  function ackFor(seqs: number[]): Buffer {
    const body = Buffer.alloc(4 + 2 * seqs.length);
    body[0] = 0xd1;
    body[1] = 0x01; // VIDEO data-type channel
    body.writeUInt16BE(seqs.length, 2);
    seqs.forEach((s, i) => body.writeUInt16BE(s, 4 + 2 * i));
    const out = Buffer.concat([Buffer.from([0xf1, 0xd1]), Buffer.alloc(2), body]);
    out.writeUInt16BE(body.length, 2);
    return out;
  }

  function feedAck(session: P2PSession, seqs: number[]): void {
    (session as unknown as { onMessage(m: Buffer, r: unknown): void }).onMessage(ackFor(seqs), {
      address: "<cam-lan-ip>",
      port: 32100,
    });
  }

  it("holds each frame until the device acknowledges its sequence number", () => {
    const { session } = newSession();
    session.sendAudioFrame(0, adtsFrame(64));
    session.sendAudioFrame(0, adtsFrame(64));
    expect(session.audioInFlight).toBe(2);

    feedAck(session, [0]);
    expect(session.audioInFlight).toBe(1);
    feedAck(session, [1]);
    expect(session.audioInFlight).toBe(0);
  });

  it("ignores acknowledgements for another data-type channel", () => {
    const { session } = newSession();
    session.sendAudioFrame(0, adtsFrame(64));
    const ack = ackFor([0]);
    ack[5] = 0x00; // the control channel, not video
    (session as unknown as { onMessage(m: Buffer, r: unknown): void }).onMessage(ack, { address: "x", port: 1 });
    expect(session.audioInFlight).toBe(1);
  });

  it("resends an unacknowledged frame byte-for-byte, and stops once acknowledged", () => {
    vi.useFakeTimers();
    try {
      const { session, sent } = newSession();
      session.sendAudioFrame(0, adtsFrame(64));
      const first = sent[0];

      // Nothing is resent inside the device's own acknowledgement latency (up to 660 ms observed):
      // retransmitting there re-sends frames that were merely slow and collapses the session.
      vi.advanceTimersByTime(600);
      expect(sent).toHaveLength(1);

      vi.advanceTimersByTime(400);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(first); // identical bytes — the channel is ordered by sequence

      feedAck(session, [0]);
      const after = sent.length;
      vi.advanceTimersByTime(500);
      expect(sent.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a lost frame exactly once, never building an amplifying flood", () => {
    vi.useFakeTimers();
    try {
      const { session, sent } = newSession();
      session.sendAudioFrame(0, adtsFrame(64));
      // Never acknowledged: one retry, then the frame is let go. Repeated retrying was measured
      // turning 314 frames into 6538 datagrams on a real camera and caused more loss than it fixed.
      vi.advanceTimersByTime(5000);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(session.audioInFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Letting a frame go leaves a permanent hole in an ordered stream, so it is reported rather than
   * dropped quietly. Nothing else can observe it: the entry is evicted, so the in-flight count reads
   * healthy while the device's playback has stopped at the gap.
   */
  it("reports the sequence number of a frame it gave up on", () => {
    vi.useFakeTimers();
    try {
      const { session } = newSession();
      const gaps: number[] = [];
      session.on("audioGap", (seq: number) => gaps.push(seq));

      session.sendAudioFrame(0, adtsFrame(64));
      expect(session.audioInFlight).toBe(1);

      vi.advanceTimersByTime(5000);

      expect(gaps).toEqual([0]);
      expect(session.audioInFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A stall is an episode, not a per-frame event. Once the device stops acknowledging, every later
   * frame is abandoned in turn — measured live as 74 consecutive frames on a battery camera whose media
   * session was stopped mid-clip by its power budget. Reporting each one buries the condition it is
   * meant to surface.
   */
  it("reports a stall once, not once per abandoned frame", () => {
    vi.useFakeTimers();
    try {
      const { session } = newSession();
      const gaps: number[] = [];
      session.on("audioGap", (seq: number) => gaps.push(seq));

      for (let i = 0; i < 20; i++) session.sendAudioFrame(0, adtsFrame(64));
      vi.advanceTimersByTime(5000);

      expect(gaps).toHaveLength(1);
      expect(session.audioInFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports again when the channel recovers and then stalls afresh", () => {
    vi.useFakeTimers();
    try {
      const { session } = newSession();
      const gaps: number[] = [];
      session.on("audioGap", (seq: number) => gaps.push(seq));

      session.sendAudioFrame(0, adtsFrame(64));
      vi.advanceTimersByTime(5000);
      expect(gaps).toHaveLength(1);

      // The device starts acknowledging again — the stall is over, so a later one is news.
      session.sendAudioFrame(0, adtsFrame(64));
      feedAck(session, [1]);
      session.sendAudioFrame(0, adtsFrame(64));
      vi.advanceTimersByTime(5000);

      expect(gaps).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent about a frame the device did acknowledge", () => {
    vi.useFakeTimers();
    try {
      const { session } = newSession();
      const gaps: number[] = [];
      session.on("audioGap", (seq: number) => gaps.push(seq));

      session.sendAudioFrame(0, adtsFrame(64));
      feedAck(session, [0]);
      vi.advanceTimersByTime(5000);

      expect(gaps).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
