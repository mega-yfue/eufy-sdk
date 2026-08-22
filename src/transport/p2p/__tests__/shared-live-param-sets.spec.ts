import { describe, expect, it } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * A camera commonly sends SPS/PPS once, with the FIRST keyframe of a stream. Every consumer that joins
 * later — and every snapshot, which skips the first (often partial) IDR by default — then collects a
 * burst whose parameter sets are already in the past, which is the `non-existing PPS 0 referenced`
 * decode failure. Only the source sees every frame from stream start, so only the source can answer
 * what the current parameter sets are; a consumer cannot recover them from what it was given.
 */
const { sps: SPS, pps: PPS, idr: IDR, delta: DELTA } = H264;

const frame = (data: Buffer, keyframe = true) => videoFrame(data, { keyframe });

function sourceWithStream() {
  const { makeStream, streams } = streamFactory();
  const source = new SharedLiveSource({ makeStream });
  const consumer = source.attach();
  return { source, stream: streams[0], consumer };
}

describe("SharedLiveSource parameter-set cache", () => {
  it("has nothing to offer before any frame has arrived", () => {
    const { source, consumer } = sourceWithStream();
    expect(source.parameterSets).toBeUndefined();
    consumer.detach();
  });

  it("retains the parameter sets a keyframe carried", () => {
    const { source, stream, consumer } = sourceWithStream();
    stream.video(frame(unit(SPS, PPS, IDR), true));
    expect(source.parameterSets?.sps).toHaveLength(1);
    expect(source.parameterSets?.pps).toHaveLength(1);
    expect(source.parameterSets?.codec).toBe("h264");
    consumer.detach();
  });

  it("keeps them across later frames that carry none — the whole point of retaining them", () => {
    const { source, stream, consumer } = sourceWithStream();
    stream.video(frame(unit(SPS, PPS, IDR), true));
    stream.video(frame(unit(DELTA), false));
    const bareIdr = frame(unit(IDR), true);
    stream.video(bareIdr);
    expect(source.parameterSets?.sps).toHaveLength(1);
    consumer.detach();
  });

  it("replaces them when the stream re-announces different ones", () => {
    const { source, stream, consumer } = sourceWithStream();
    stream.video(frame(unit(SPS, PPS, IDR), true));
    const changed = [0x67, 0x4d, 0x00];
    stream.video(frame(unit(changed, PPS, IDR), true));
    expect(source.parameterSets?.sps[0]).toEqual(Buffer.from(changed));
    consumer.detach();
  });

  it("forgets them on teardown, so a rebuilt stream never primes with a dead stream's sets", () => {
    const { source, stream, consumer } = sourceWithStream();
    stream.video(frame(unit(SPS, PPS, IDR), true));
    consumer.detach();
    source.dispose();
    expect(source.parameterSets).toBeUndefined();
  });
});
