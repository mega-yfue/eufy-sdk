import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { SharedLiveSource } from "../shared-live-source.js";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * A camera commonly sends SPS/PPS once, with the FIRST keyframe of a stream. Every consumer that joins
 * later — and every snapshot, which skips the first (often partial) IDR by default — then collects a
 * burst whose parameter sets are already in the past, which is the `non-existing PPS 0 referenced`
 * decode failure. Only the source sees every frame from stream start, so only the source can answer
 * what the current parameter sets are; a consumer cannot recover them from what it was given.
 */
const START = Buffer.from([0, 0, 0, 1]);

function unit(...nals: number[][]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [START, Buffer.from(n)]));
}

const SPS = [0x67, 0x42, 0x00];
const PPS = [0x68, 0xce, 0x01];
const IDR = [0x65, 0x88, 0x84];
const DELTA = [0x41, 0x9a, 0x02];

function frame(data: Buffer, keyframe: boolean): LiveVideoFrame {
  return { keyframe, width: 1920, height: 1080, codec: "h264", data };
}

class FakeStream extends EventEmitter implements LiveStreamHandle {
  start(): this {
    return this;
  }
  stop(): void {}
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

function sourceWithStream() {
  const streams: FakeStream[] = [];
  const source = new SharedLiveSource({
    makeStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
  });
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
    stream.video(frame(unit(IDR), true)); // a bare IDR: this is the burst that fails to decode alone
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
