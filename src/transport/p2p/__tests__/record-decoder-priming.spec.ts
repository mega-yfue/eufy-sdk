import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { fakeFfmpeg, H264, H265, nalTypes, START_CODE } from "./live-source-fixtures.js";
import type { P2PFrame, P2PSession } from "../p2p-session.js";

/**
 * `record` starts its clip at the SECOND keyframe so the first (often partial) one is skipped — which
 * drops any parameter sets announced only with it. The result is the same undecodable run the live
 * snapshot suffered, and it also defeats the codec sniff: a run of bare slices carries no config NAL, so
 * an H.265 clip would be muxed as H.264.
 */
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const ffmpeg = fakeFfmpeg(() => ({ stdout: MP4 }));

vi.mock("../../ffmpeg.js", () => ({ spawnFfmpeg: (args: string[]) => ffmpeg.spawnFfmpeg(args) }));

const { recordClip } = await import("../media.js");

/** Minimal fake P2PSession: lets a test push plaintext CMD_VIDEO_FRAME payloads. */
class FakeSession extends EventEmitter {
  startLiveMedia() {}
  stopLiveMedia() {}
  push(nals: readonly (readonly number[])[], keyframe: boolean) {
    const hdr = Buffer.alloc(0x16);
    hdr.writeUInt8(keyframe ? 0x01 : 0x00, 0x04);
    hdr.writeInt16LE(1920, 0x0a);
    hdr.writeInt16LE(1080, 0x0c);
    const body = Buffer.concat(nals.flatMap((n) => [START_CODE, Buffer.from(n)]));
    this.emit("data", { commandId: 1300, channel: 0, signCode: 0, data: Buffer.concat([hdr, body]) } as P2PFrame);
  }
}

/** Record a zero-second clip: the run closes on the keyframe that starts it. */
async function clipFrom(announce: readonly (readonly number[])[], then: readonly (readonly number[])[]) {
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
    ffmpeg.runs.length = 0;
  });

  it("primes a clip whose parameter sets were dropped with the skipped first keyframe", async () => {
    await clipFrom([H264.sps, H264.pps, H264.idr], [H264.idr]);
    expect(nalTypes(ffmpeg.runs[0].stdin)).toEqual([0x67, 0x68, 0x65]);
  });

  it("labels an H.265 clip as hevc rather than falling back on a run of bare slices", async () => {
    await clipFrom([H265.vps, H265.sps, H265.pps, H265.idr], [H265.idr]);
    expect(ffmpeg.runs[0].args).toContain("hevc");
    expect(nalTypes(ffmpeg.runs[0].stdin)).toEqual([0x40, 0x42, 0x44, 0x26]);
  });

  it("primes a clip carrying only an SPS — the literal missing-PPS case", async () => {
    await clipFrom([H264.sps, H264.pps, H264.idr], [H264.sps, H264.idr]);
    expect(nalTypes(ffmpeg.runs[0].stdin)).toEqual([0x67, 0x68, 0x67, 0x65]);
  });

  it("re-announces sets a self-contained clip already carried, which a decoder ignores", async () => {
    await clipFrom([H264.idr], [H264.sps, H264.pps, H264.idr]);
    expect(nalTypes(ffmpeg.runs[0].stdin)).toEqual([0x67, 0x68, 0x67, 0x68, 0x65]);
  });
});
