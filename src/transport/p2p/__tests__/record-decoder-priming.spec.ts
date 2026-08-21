import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { P2PFrame, P2PSession } from "../p2p-session.js";

/**
 * `record` starts its clip at the SECOND keyframe so the first (often partial) one is skipped — which
 * drops any parameter sets announced only with it. The result is the same undecodable run the live
 * snapshot suffered, and it also defeats the codec sniff: a run of bare slices carries no config NAL, so
 * an H.265 clip would be muxed as H.264.
 *
 * `../../ffmpeg.js` is mocked to observe the bytes and the `-f` the mux was given.
 */
const START = Buffer.from([0, 0, 0, 1]);
const H264_SPS = [0x67, 0x42, 0x00];
const H264_PPS = [0x68, 0xce, 0x01];
const H264_IDR = [0x65, 0x88, 0x84];
const H265_VPS = [0x40, 0x01, 0x0c];
const H265_SPS = [0x42, 0x01, 0x01];
const H265_PPS = [0x44, 0x01, 0xc1];
const H265_IDR = [0x26, 0x01, 0xaf];

const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

const muxed: { args: string[]; input: Buffer }[] = [];

vi.mock("../../ffmpeg.js", () => ({
  spawnFfmpeg: vi.fn((args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    const chunks: Buffer[] = [];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
      final(cb) {
        muxed.push({ args, input: Buffer.concat(chunks) });
        queueMicrotask(() => {
          child.stdout.emit("data", MP4);
          child.emit("close", 0);
        });
        cb();
      },
    });
    return child;
  }),
}));

const { recordClip } = await import("../media.js");

/** Minimal fake P2PSession: lets a test push plaintext CMD_VIDEO_FRAME payloads. */
class FakeSession extends EventEmitter {
  startLiveMedia() {}
  stopLiveMedia() {}
  push(nals: number[][], keyframe: boolean) {
    const hdr = Buffer.alloc(0x16);
    hdr.writeUInt8(keyframe ? 0x01 : 0x00, 0x04);
    hdr.writeInt16LE(1920, 0x0a);
    hdr.writeInt16LE(1080, 0x0c);
    const body = Buffer.concat(nals.flatMap((n) => [START, Buffer.from(n)]));
    this.emit("data", { commandId: 1300, channel: 0, signCode: 0, data: Buffer.concat([hdr, body]) } as P2PFrame);
  }
}

/** The NAL type byte of each NAL in a buffer. */
function nalTypes(buf: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) types.push(buf[i + 4]);
  }
  return types;
}

/** Record a zero-second clip: the run closes on the keyframe that starts it. */
async function clipFrom(announce: number[][], then: number[][]) {
  const session = new FakeSession();
  const clip = recordClip(session as unknown as P2PSession, 0, { keepAliveMs: 0, timeoutMs: 1000 });
  await Promise.resolve();
  const skippedFirstKeyframe = announce;
  const keyframeTheClipStartsAt = then;
  session.push(skippedFirstKeyframe, true);
  session.push(keyframeTheClipStartsAt, true);
  return clip;
}

describe("recordClip — decoder priming", () => {
  beforeEach(() => {
    muxed.length = 0;
  });

  it("primes a clip whose parameter sets were dropped with the skipped first keyframe", async () => {
    await clipFrom([H264_SPS, H264_PPS, H264_IDR], [H264_IDR]);
    expect(nalTypes(muxed[0].input)).toEqual([0x67, 0x68, 0x65]);
  });

  it("labels an H.265 clip as hevc rather than falling back on a run of bare slices", async () => {
    await clipFrom([H265_VPS, H265_SPS, H265_PPS, H265_IDR], [H265_IDR]);
    expect(muxed[0].args).toContain("hevc");
    expect(nalTypes(muxed[0].input)).toEqual([0x40, 0x42, 0x44, 0x26]);
  });

  it("primes a clip carrying only an SPS — the literal missing-PPS case", async () => {
    await clipFrom([H264_SPS, H264_PPS, H264_IDR], [H264_SPS, H264_IDR]);
    expect(nalTypes(muxed[0].input)).toEqual([0x67, 0x68, 0x67, 0x65]);
  });

  it("re-announces sets a self-contained clip already carried, which a decoder ignores", async () => {
    await clipFrom([H264_IDR], [H264_SPS, H264_PPS, H264_IDR]);
    expect(nalTypes(muxed[0].input)).toEqual([0x67, 0x68, 0x67, 0x68, 0x65]);
  });
});
