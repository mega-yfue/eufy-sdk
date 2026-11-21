import { describe, expect, it, vi } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/** A lingering source confirms resumed upstream delivery independently of the joining consumer's keyframe gate. */
const keyframe = () => videoFrame(unit(H264.sps, H264.pps, H264.idr), { keyframe: true });

function source(over: { lingerMs?: number; warmTimeoutMs?: number } = {}) {
  const { makeStream, streams } = streamFactory();
  const src = new SharedLiveSource({
    makeStream,
    warmTimeoutMs: 50,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  });
  return { src, streams };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a consumer joining a lingering source", () => {
  it("fails when no frame arrives after the join despite a recent cached keyframe", async () => {
    const { src, streams } = source();
    const first = src.attach();
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    const failures: Error[] = [];
    rejoined.on("error", (error) => failures.push(error));
    rejoined.on("video", () => undefined);
    await settle(150);

    expect(failures.map((error) => error.name)).toEqual(["LiveStreamStartError"]);
  });

  it("does not fail when the stream is still being served", async () => {
    const { src, streams } = source();
    const first = src.attach();
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    const failures: Error[] = [];
    rejoined.on("error", (error) => failures.push(error));
    rejoined.on("video", () => undefined);
    streams[0]!.video(keyframe());
    await settle(150);

    expect(failures).toEqual([]);
    rejoined.detach();
  });

  /**
   * Any frame after the join settles the watch, not a keyframe.
   *
   * The join already carries a decodable picture — the retained keyframe is replayed to it — so what the watch
   * is missing is evidence the stream is STILL being served, and a delta frame is that evidence. Requiring a
   * keyframe instead made the deadline outlive an actively delivering stream whenever its group of pictures
   * was longer than the window, and `onWarmTimeout` fails EVERY consumer and tears the source down: a healthy
   * viewer would lose its stream because a snapshot joined it.
   */
  it("settles on a delta frame, a stream still being served needing no fresh keyframe to prove it", async () => {
    const { src, streams } = source({ warmTimeoutMs: 60 });
    const first = src.attach();
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    const failures: Error[] = [];
    rejoined.on("error", (err) => failures.push(err));
    rejoined.on("video", () => undefined);
    await settle(10);
    streams[0]!.video(videoFrame(unit(H264.delta), { keyframe: false }));
    await settle(120);

    expect(failures).toEqual([]);
    rejoined.detach();
  });

  /** The first consumer of a cold source is already watched by warming; reuse must not double the watch. */
  it("leaves a cold first attach to the warm-up it already had", async () => {
    const { src, streams } = source();
    const consumer = src.attach();
    const failures: Error[] = [];
    consumer.on("error", (error) => failures.push(error));
    streams[0]!.video(keyframe());
    await settle(150);

    expect(failures).toEqual([]);
    consumer.detach();
  });
});
