import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import type { RtcCallSdp } from "../call.js";
import type { IceAgent } from "../ice.js";
import { Anke, RtcPmLiveStream, ankeChecksum, ankeFrame } from "../pm-live.js";
import { RTC_SRTP_KEY, aesCm, mediaOpen, srtpKey } from "../rtp.js";

const CALL: RtcCallSdp = {
  ufrag: "abcd",
  pwd: "q".repeat(22),
  key: "0123456789abcdefXYZ",
  iv: "ivivivivivab",
  audio: 0x11223344,
  video: 7,
};
const CHANNEL = 3;
const START = JSON.stringify({ cmd: 1003, mChannel: CHANNEL, payload: { chn_list: [] } });
const STOP = JSON.stringify({ cmd: 1004, mChannel: CHANNEL, mValue3: 0, payload: { channel: CHANNEL } });
const SSRC = 0x0a0b0c0d;
const [M, S] = [RTC_SRTP_KEY.subarray(0, 16), RTC_SRTP_KEY.subarray(16)];

/** The station's GCM: key = first 16 chars, nonce = the iv string, no AAD, tag appended. */
function seal(unit: Buffer, clear: number): Buffer {
  const c = createCipheriv("aes-128-gcm", Buffer.from(CALL.key.slice(0, 16)), Buffer.from(CALL.iv));
  const ct = Buffer.concat([c.update(unit.subarray(clear)), c.final()]);
  return Buffer.concat([unit.subarray(0, clear), ct, c.getAuthTag()]);
}

function srtp(seq: number, payload: Buffer, marker: boolean, pt = 99): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(9000, 4);
  h.writeUInt32BE(SSRC, 8);
  const body = Buffer.concat([h, aesCm(srtpKey(M, S, 0, 16), srtpKey(M, S, 2, 14), SSRC, seq, payload)]);
  const tag = createHmac("sha1", srtpKey(M, S, 1, 20))
    .update(body)
    .update(Buffer.alloc(4))
    .digest();
  return Buffer.concat([body, tag.subarray(0, 10)]);
}

/** A station SRTCP APP `AZWC` packet around an ANKE frame, index `i`. */
function srtcpApp(frame: Buffer, i = 1): Buffer {
  const pad = Buffer.alloc((4 - (frame.length % 4)) % 4);
  const h = Buffer.from([0x9e, 204, 0, 0, 0, 0, 0, 0, 0x41, 0x5a, 0x57, 0x43]);
  h.writeUInt16BE((12 + frame.length + pad.length) / 4 - 1, 2);
  h.writeUInt32BE(SSRC, 4);
  const rest = aesCm(srtpKey(M, S, 3, 16), srtpKey(M, S, 5, 14), SSRC, i, Buffer.concat([h.subarray(8), frame, pad]));
  const e = Buffer.alloc(4);
  e.writeUInt32BE((0x80000000 | i) >>> 0);
  const body = Buffer.concat([h.subarray(0, 8), rest, e]);
  return Buffer.concat([
    body,
    createHmac("sha1", srtpKey(M, S, 4, 20))
      .update(body)
      .digest()
      .subarray(0, 10),
  ]);
}

const xzyhReply = (result: number) => {
  const f = Buffer.alloc(20);
  f.write("XZYH", 0, "latin1");
  f.writeUInt16LE(1350, 4);
  f.writeUInt32LE(4, 6);
  f.writeInt32LE(result, 16);
  return f;
};

/** The ANKE frame of one APP packet the app wrote, after the plain 12-byte RTCP header. */
const frameOf = (p: Buffer) => p.subarray(12, 12 + 20 + p.readUInt32LE(24));

function fakeAgent(connected = false) {
  const agent = Object.assign(new EventEmitter(), { connected, write: vi.fn<(d: Buffer) => void>() });
  return agent as typeof agent & IceAgent;
}

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe("ANKE frame", () => {
  it("checksums bytes 0..15 and the payload, 0xAA pad included", () => {
    const f = ankeFrame(1, 1, Buffer.from([1, 2, 3]));
    expect([...f.subarray(0, 12)]).toEqual([0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0, 1, 0xaa, 0xaa, 0xaa]);
    expect(f.readUInt32LE(16)).toBe(0x78 + 0x56 + 0x34 + 0x12 + 1 + 1 + 3 * 0xaa + 3 + 6);
    expect(ankeChecksum(f)).toBe(f.readUInt32LE(16));
  });

  it("ACKs a data frame with type 2, re-ACKs a duplicate without queueing it, drops a bad checksum", () => {
    const out: Buffer[] = [];
    const anke = new Anke(CALL.audio, (p) => out.push(p));
    const data = ankeFrame(7, 1, xzyhReply(1));
    anke.input(data);
    anke.input(data);
    const bad = Buffer.from(data);
    bad.writeUInt32LE(8, 4);
    anke.input(bad);
    expect(out).toHaveLength(2);
    for (const p of out) {
      const ack = frameOf(p);
      expect([ack.length, ack.readUInt32LE(4), ack[8], ack.readUInt32LE(12)]).toEqual([20, 7, 2, 0]);
      expect(ack.readUInt32LE(16)).toBe(ankeChecksum(ack));
    }
    expect(anke.result(1350)).toBe(1);
    expect(anke.result(1350)).toBe(-1);
    anke.close();
  });

  it("resends a frame +100, +200, +500, +500, +500 ms, then drops it; an ACK stops it", () => {
    const at: number[] = [];
    const t0 = Date.now();
    const anke = new Anke(CALL.audio, () => at.push(Date.now() - t0));
    anke.send(Buffer.from("x"));
    vi.advanceTimersByTime(5000);
    expect(at).toEqual([0, 100, 300, 800, 1300, 1800]);
    at.length = 0;
    anke.send(Buffer.from("y"));
    anke.input(ankeFrame(1, 2));
    vi.advanceTimersByTime(5000);
    expect(at).toEqual([5000]);
    anke.close();
  });
});

describe("media AES-GCM", () => {
  it("opens an audio payload whole, its tag the last 16 bytes", () => {
    const audio = Buffer.from("opus frame bytes");
    const sealed = seal(audio, 0);
    expect(sealed.length).toBe(audio.length + 16);
    expect(mediaOpen(CALL.key, CALL.iv, sealed, 0)).toEqual(audio);
    sealed[0]! ^= 1;
    expect(mediaOpen(CALL.key, CALL.iv, sealed, 0)).toBeUndefined();
  });
});

describe("RtcPmLiveStream", () => {
  const sps = Buffer.concat([Buffer.from([0x67, 0x42]), Buffer.alloc(20, 0x11)]);
  const pps = Buffer.concat([Buffer.from([0x68, 0xce]), Buffer.alloc(20, 0x22)]);
  const idr = Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const sc = Buffer.from([0, 0, 0, 1]);
  const trailer = () => {
    const t = Buffer.alloc(9);
    t.writeBigUInt64LE(BigInt(Date.now()));
    t[8] = CHANNEL;
    return t;
  };
  /** SPS, PPS, IDR as the station sends them: each parameter set sealed from byte 2, the IDR from its header + 2. */
  function keyframe(seq: number): Buffer[] {
    const unit = Buffer.concat([sc, sps, sc, pps, sc, idr]);
    const sealed = seal(unit, 4 + sps.length + 4 + pps.length + 4 + 2);
    const idrPart = sealed.subarray(4 + sps.length + 4 + pps.length + 4);
    return [
      srtp(seq, seal(sps, 2), false),
      srtp(seq + 1, seal(pps, 2), false),
      srtp(seq + 2, Buffer.concat([idrPart, trailer()]), true),
    ];
  }

  function stream(gcm = true) {
    const agent = fakeAgent();
    const s = new RtcPmLiveStream(agent, { call: CALL, gcm, cmdGcm: gcm, channel: CHANNEL, start: START, stop: STOP });
    const errors: Error[] = [];
    const frames: LiveVideoFrame[] = [];
    s.on("error", (e) => errors.push(e)).on("video", (f) => frames.push(f));
    return { agent, s, errors, frames };
  }

  it("sends the start once ICE connects, as a plain RTCP APP `ANKE` frame of a sealed 1350", () => {
    const { agent, s } = stream();
    s.start();
    expect(agent.write).not.toHaveBeenCalled();
    agent.emit("connected");
    const p = agent.write.mock.calls[0]![0];
    expect([p[0], p[1], p.readUInt32BE(4), p.toString("latin1", 8, 12)]).toEqual([0x9e, 204, CALL.audio, "ANKE"]);
    const f = frameOf(p);
    expect(p.length).toBe(12 + Math.ceil(f.length / 4) * 4);
    expect(p.readUInt16BE(2)).toBe(p.length / 4 - 1);
    expect([f.readUInt32LE(4), f[8], f.readUInt32LE(16)]).toEqual([0, 1, ankeChecksum(f)]);
    const x = f.subarray(20);
    expect([x.toString("latin1", 0, 4), x.readUInt16LE(4), x[10], x[12], x[13]]).toEqual([
      "XZYH",
      1350,
      0x0a,
      CHANNEL,
      1,
    ]);
    const body = x.subarray(16);
    expect(body.readUInt32LE(28)).toBe(0x01020304);
    const d = createDecipheriv("aes-128-gcm", Buffer.from(CALL.key.slice(0, 16)), body.subarray(16, 28));
    d.setAAD(Buffer.from("eufy security"));
    d.setAuthTag(body.subarray(0, 16));
    expect(Buffer.concat([d.update(body.subarray(32)), d.final()]).toString()).toBe(START);
  });

  it("emits the decrypted key frame from a station SRTP stream, parameter sets opened from byte 2", () => {
    const { agent, s, frames } = stream();
    s.start();
    for (const p of keyframe(100)) agent.emit("data", p);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ codec: "h264", keyframe: true, sourceTimestamp: 9000 });
    expect(frames[0]!.data).toEqual(Buffer.concat([sc, sps, sc, pps, sc, idr]));
  });

  it("drops a unit whose trailer names another channel, then waits for a key frame", () => {
    const { agent, s, frames } = stream(false);
    s.start();
    const p = (seq: number, ch: number) => {
      const t = trailer();
      t[8] = ch;
      return srtp(seq, Buffer.concat([Buffer.from([0x41, 0x9a, 1, 2]), t]), true);
    };
    agent.emit("data", p(1, CHANNEL + 1));
    agent.emit("data", p(2, CHANNEL));
    expect(frames).toHaveLength(0);
  });

  it("succeeds on the station's 1350 reply, and on a first video unit", async () => {
    const a = stream();
    a.s.start();
    a.agent.emit("connected");
    a.agent.emit("data", srtcpApp(ankeFrame(0, 1, xzyhReply(1))));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(a.errors).toEqual([]);
    expect(a.agent.write.mock.calls.some(([p]) => frameOf(p)[8] === 2)).toBe(true);

    const b = stream();
    b.s.start();
    b.agent.emit("connected");
    await vi.advanceTimersByTimeAsync(3_000);
    for (const p of keyframe(1)) b.agent.emit("data", p);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(b.errors).toEqual([]);

    const c = stream();
    c.s.start();
    c.agent.emit("connected");
    await vi.advanceTimersByTimeAsync(9_900);
    expect(c.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(c.errors.map((e) => e.message)).toEqual(["rtc pm live: start not answered"]);
  });

  it("fails at once on a reply of 0", async () => {
    const { agent, s, errors } = stream();
    s.start();
    agent.emit("connected");
    agent.emit("data", srtcpApp(ankeFrame(0, 1, xzyhReply(0))));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(errors).toHaveLength(1);
  });

  it("sends the stop as the next ANKE frame, inner cmd 1004", () => {
    const agent = fakeAgent(true);
    const s = new RtcPmLiveStream(agent, {
      call: CALL,
      gcm: false,
      cmdGcm: false,
      channel: CHANNEL,
      start: START,
      stop: STOP,
    });
    s.start();
    s.stop();
    const f = frameOf(agent.write.mock.calls[1]![0]);
    expect(f.readUInt32LE(4)).toBe(1);
    expect(JSON.parse(f.subarray(36).toString()).cmd).toBe(1004);
  });
});
