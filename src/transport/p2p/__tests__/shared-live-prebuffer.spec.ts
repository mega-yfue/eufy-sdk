import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedLiveSource, type SharedLiveSourceOptions } from "../shared-live-source.js";
import type { LiveAudioFrame, LiveVideoFrame } from "../../../core/contracts.js";
import { streamFactory } from "./live-source-fixtures.js";

/** One synthetic video frame, using an IDR-shaped byte for a keyframe and a slice-shaped byte otherwise. */
function video(keyframe: boolean): LiveVideoFrame {
  return { keyframe, width: 960, height: 540, codec: "h264", data: Buffer.from([0, 0, 0, 1, keyframe ? 0x67 : 0x41]) };
}

function audio(): LiveAudioFrame {
  return { codec: "aac-lc", data: Buffer.from([0xff, 0xf1]) };
}

function mk(opts: Partial<Omit<SharedLiveSourceOptions, "makeStream">> = {}) {
  const { makeStream, streams } = streamFactory();
  const source = new SharedLiveSource({ makeStream, lingerMs: 5000, ...opts });
  return { source, last: () => streams[streams.length - 1] as EventEmitter & { video(f: LiveVideoFrame): void } };
}

/** Deliver one frame per `stepMs` at `at`, marking a keyframe every `gopMs`, on the fake clock. */
function deliver(
  stream: { video(frame: LiveVideoFrame): void },
  { from, to, stepMs, gopMs }: { from: number; to: number; stepMs: number; gopMs: number },
): void {
  for (let at = from; at <= to; at += stepMs) {
    vi.setSystemTime(at);
    stream.video(video(at % gopMs === 0));
  }
}

function arrivals(buffered: readonly { timestampMs: number }[]): number[] {
  return buffered.map((item) => item.timestampMs);
}

/**
 * A drain has to be decodable, so a run covering the requested window starts at or before it on a
 * keyframe. Beginning inside the window under-delivers by up to a whole keyframe interval; beginning at an
 * older keyframe than necessary hands over media outside the request. Retention obeys the same rule,
 * because a ring trimmed tighter than the drain cannot answer it.
 */
describe("prebuffer drain bounds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The window a caller asked for is the media it needs; a run beginning inside it silently answers a
   * shorter request. With a two-second keyframe interval and a four-second window that is up to half the
   * media gone, which is the difference between a usable pre-event clip and a token one.
   */
  it("covers the whole requested window rather than beginning inside it", () => {
    const { source, last } = mk({ preBufferSeconds: 4 });
    source.attach();
    deliver(last(), { from: 0, to: 6_500, stepMs: 500, gopMs: 2_000 });

    const { buffered } = source.attachWithPrebuffer(4);
    expect(buffered[0].timestampMs).toBeLessThanOrEqual(2_500);
    expect(arrivals(buffered)).toContain(3_000);
    expect((buffered[0] as { frame: LiveVideoFrame }).frame.keyframe).toBe(true);
  });

  /**
   * The other side of the same bound. A caller asking for two seconds of a ten-second window must not be
   * handed the ten, or the window it configured for one egress silently becomes the drain length for
   * every other.
   */
  it("hands over no more than the requested window and one keyframe interval", () => {
    const { source, last } = mk({ preBufferSeconds: 10 });
    source.attach();
    deliver(last(), { from: 0, to: 10_000, stepMs: 500, gopMs: 2_000 });

    const { buffered } = source.attachWithPrebuffer(2);
    expect(buffered[0].timestampMs).toBe(8_000);
  });

  /** A finite request beyond the timer range still drains no more than the configured window. */
  it("caps a large drain request at the configured window", () => {
    const { source, last } = mk({ preBufferSeconds: 4 });
    source.attach();
    deliver(last(), { from: 0, to: 6_000, stepMs: 500, gopMs: 2_000 });

    expect(source.ringBuffer(3e9)).toEqual(source.ringBuffer(4));
    expect(source.ringBuffer(4)).not.toEqual([]);
  });

  /** Asking for none is a request, not an omission: it must not be read as "whatever is retained". */
  it("hands over nothing at all when no window is asked for", () => {
    const { source, last } = mk({ preBufferSeconds: 10 });
    source.attach();
    deliver(last(), { from: 0, to: 6_000, stepMs: 500, gopMs: 2_000 });

    expect(source.attachWithPrebuffer(0).buffered).toEqual([]);
    expect(source.ringBuffer(0)).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "hands over nothing for an invalid %s-second request",
    (seconds) => {
      const { source, last } = mk({ preBufferSeconds: 10 });
      source.attach();
      deliver(last(), { from: 0, to: 6_000, stepMs: 500, gopMs: 2_000 });

      expect(source.attachWithPrebuffer(seconds).buffered).toEqual([]);
      expect(source.ringBuffer(seconds)).toEqual([]);
    },
  );

  /**
   * Retention is measured on transport arrival, because a frame carries no device clock. Delivery is
   * bursty, so a stall makes everything already retained look expired at once — and trimming to the
   * newest keyframe then leaves a window holding a single frame. What the camera captured before the
   * trigger is exactly what a pre-event window is for, so it is kept.
   */
  it("keeps a decodable window across a delivery stall instead of emptying it", () => {
    const { source, last } = mk({ preBufferSeconds: 4 });
    source.attach();
    deliver(last(), { from: 0, to: 2_500, stepMs: 500, gopMs: 2_000 });

    vi.setSystemTime(9_000);
    last().video(video(true));

    const { buffered } = source.attachWithPrebuffer(4);
    expect(buffered.length).toBeGreaterThan(1);
    expect(buffered[0].timestampMs).toBeLessThanOrEqual(2_000);
  });

  /** Audio is retained beside video, and a drain still opens on a video keyframe. */
  it("retains audio in the window without letting it open the drain", () => {
    const { source, last } = mk({ preBufferSeconds: 4 });
    source.attach();
    vi.setSystemTime(1_000);
    last().video(video(true));
    vi.setSystemTime(1_020);
    (last() as unknown as EventEmitter).emit("audio", audio());
    vi.setSystemTime(1_040);
    last().video(video(false));

    const { buffered } = source.attachWithPrebuffer(4);
    expect(buffered.map((item) => item.kind)).toEqual(["video", "audio", "video"]);
  });
});

describe("prebuffer retention", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * A long group has one decodable anchor, and dropping it makes every retained frame unusable. The source
   * keeps that anchor and the complete run after it until a newer keyframe gives the time-based trim
   * somewhere safe to move to.
   */
  it("keeps the complete decodable run through a group longer than the configured window", () => {
    const { source, last } = mk({ preBufferSeconds: 4 });
    source.attach();
    vi.setSystemTime(0);
    last().video(video(true));
    deliver(last(), { from: 100, to: 400_000, stepMs: 100, gopMs: 1_000_000 });

    const drained = source.ringBuffer(4);
    expect(drained).toHaveLength(4_001);
    expect(drained[0].keyframe).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 3e9])(
    "retains nothing when configured with an invalid %s-second window",
    (preBufferSeconds) => {
      const { source, last } = mk({ preBufferSeconds });
      source.attach();
      deliver(last(), { from: 0, to: 4_000, stepMs: 500, gopMs: 2_000 });

      expect(source.ringBuffer(10)).toEqual([]);
      expect(source.attachWithPrebuffer(10).buffered).toEqual([]);
    },
  );

  /** A source with no window retains nothing, whatever a caller then asks to drain. */
  it("retains nothing when no window was configured", () => {
    const { source, last } = mk();
    source.attach();
    deliver(last(), { from: 0, to: 4_000, stepMs: 500, gopMs: 2_000 });

    expect(source.ringBuffer(10)).toEqual([]);
    expect(source.attachWithPrebuffer(10).buffered).toEqual([]);
  });
});
