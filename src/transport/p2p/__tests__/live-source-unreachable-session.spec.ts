import { describe, expect, it, vi } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

const keyframe = () => videoFrame(unit(H264.sps, H264.pps, H264.idr), { keyframe: true });

/**
 * A media start the device never acknowledged says the session is not being heard, not that the device is slow.
 *
 * The start is repeated byte-identically every 150 ms and abandoned after three seconds, so an abandonment is
 * roughly twenty sends with no reply — against acknowledgement latencies of 4–37 ms from an awake camera and
 * 238 ms from one still waking. `P2PSession` already states the consequence: the camera was never told to
 * stream, so the warm-up that follows can only ever time out.
 *
 * It was left to time out anyway. Measured on a real camera: five starts, five abandonments, and a
 * `source-error` twenty seconds after a first abandonment at three that carried the whole answer. The next
 * attempt rebuilt the session and delivered a keyframe 5.9 s later — inside the window the first attempt spent
 * re-issuing onto a session nothing was listening to.
 *
 * So the first abandonment asks the owner for a replacement session and warms again on it, once, keeping the
 * deadline the first attempt started. An abandonment after media has flowed says something else and is left
 * alone, and a source with no owner to ask keeps re-issuing as before.
 */
function source(over: Record<string, unknown> = {}) {
  const { makeStream, streams } = streamFactory();
  const onSessionUnreachable = vi.fn(() => true);
  const src = new SharedLiveSource({
    makeStream,
    warmRetryMs: 10_000,
    warmTimeoutMs: 10_000,
    onSessionUnreachable,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  });
  return { src, streams, onSessionUnreachable };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a media start the device never acknowledged", () => {
  it("asks the owner for a replacement session instead of re-issuing onto a dead one", async () => {
    const { src, streams, onSessionUnreachable } = source();
    const consumer = src.attach();
    consumer.on("error", () => undefined);

    streams[0]!.emit("unacknowledged");
    await settle();

    expect(onSessionUnreachable).toHaveBeenCalledTimes(1);
  });

  it("warms again on the replacement, so the attempt that asked is the one that streams", async () => {
    const { src, streams, onSessionUnreachable } = source();
    const consumer = src.attach();
    consumer.on("error", () => undefined);
    const frames: unknown[] = [];
    consumer.on("video", (frame) => frames.push(frame));

    streams[0]!.emit("unacknowledged");
    await settle();
    src.rewarm();
    await settle();
    streams.at(-1)!.video(keyframe());

    expect(streams).toHaveLength(2);
    expect(onSessionUnreachable).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
  });

  it("re-issues on one ticker however many times it warms again, and leaves none running once disposed", async () => {
    vi.useFakeTimers();
    try {
      const { src, streams } = source({ warmRetryMs: 20 });
      src.attach().on("error", () => undefined);
      streams[0]!.emit("unacknowledged");
      src.rewarm();
      src.rewarm();

      await vi.advanceTimersByTimeAsync(100);
      expect(streams.at(-1)!.nudged).toBe(5);

      src.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks once, however many starts are abandoned before the replacement arrives", async () => {
    const { src, streams, onSessionUnreachable } = source();
    src.attach().on("error", () => undefined);

    streams[0]!.emit("unacknowledged");
    streams[0]!.emit("unacknowledged");
    streams[0]!.emit("unacknowledged");
    await settle();

    expect(onSessionUnreachable).toHaveBeenCalledTimes(1);
  });

  it("leaves an abandonment alone once media has flowed, that being a different fault", async () => {
    const { src, streams, onSessionUnreachable } = source();
    const consumer = src.attach();
    consumer.on("error", () => undefined);
    consumer.on("video", () => undefined);
    streams[0]!.video(keyframe());
    await settle();

    streams[0]!.emit("unacknowledged");
    await settle();

    expect(onSessionUnreachable).not.toHaveBeenCalled();
  });

  it("keeps re-issuing where there is no owner to ask", async () => {
    const { src, streams } = source({ onSessionUnreachable: undefined, warmRetryMs: 20 });
    src.attach().on("error", () => undefined);

    streams[0]!.emit("unacknowledged");
    await settle(70);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.nudged).toBeGreaterThan(0);
  });
});

/**
 * A reused own session can acknowledge every start and serve nothing: measured, a warm-up and eight forced
 * re-issues each acknowledged within 51 ms, no media datagram for the whole 20 s window, while the next attempt
 * on a fresh session delivered a keyframe 0.4 s after its start. A forced start answered by nothing for a whole
 * interval is therefore the session, and the warm-up asks for a fresh one inside its deadline.
 */
describe("forced starts the device acknowledges and serves nothing for", () => {
  it("asks for a replacement session after a forced start served nothing, and stops forcing onto it", async () => {
    const { src, streams, onSessionUnreachable } = source({ warmRetryMs: 20 });
    src.attach().on("error", () => undefined);

    await settle(70);
    const sent = streams[0]!.nudged;
    await settle(60);

    expect(onSessionUnreachable).toHaveBeenCalledTimes(1);
    expect(sent).toBe(2);
    expect(streams[0]!.nudged).toBe(2);
  });

  it("keeps forcing starts where the owner cannot replace the session", async () => {
    const cannot = vi.fn(() => false);
    const { src, streams } = source({
      warmRetryMs: 20,
      onSessionUnreachable: cannot,
    });
    src.attach().on("error", () => undefined);

    await settle(130);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.nudged).toBeGreaterThan(3);
    expect(cannot).toHaveBeenCalledTimes(1);
  });

  it("leaves a battery camera's forced starts alone, since a cold one is slow rather than deaf", async () => {
    const { src, streams, onSessionUnreachable } = source({ warmRetryMs: 20, powered: "battery" });
    src.attach().on("error", () => undefined);

    await settle(130);

    expect(onSessionUnreachable).not.toHaveBeenCalled();
    expect(streams[0]!.nudged).toBeGreaterThan(3);
  });
});
