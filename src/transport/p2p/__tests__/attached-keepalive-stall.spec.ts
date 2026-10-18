import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStream } from "../live-stream.js";
import { SharedLiveSource } from "../shared-live-source.js";
import type { P2PSession } from "../p2p-session.js";
import { FakeP2PSession, p2pVideoFrame } from "./live-source-fixtures.js";

/**
 * An attached stream the station stopped serving re-asserts its channel, once its media has actually stopped.
 *
 * The 3 s re-assert is settled by the first own-channel frame, because one session serving one camera at a
 * time is re-tasked by every re-assert: two attached streams sharing one and doing it continuously contend
 * forever — measured as a
 * full start every 3 s from each, and settling it is what let both hold a 40 s stream.
 *
 * Settling it for the stream's whole life left nothing to recover a stream the station later gave to a
 * sibling: frames stop, no error is raised, no `stop` is emitted, and the consumer starves for as long as it
 * waits. The warm-up watch that would have caught it was cleared by the first frame.
 *
 * So the settle holds only while media keeps arriving. Silence for the stall window re-arms the re-assert, and
 * the next own-channel frame settles it again — the contention is avoided exactly while it would be harmful.
 */
/** A keyframe tagged for `channel`, as the station sends it. */
const ownFrame = (channel: number) =>
  p2pVideoFrame({ nal: Buffer.from([0x65, 0x11]), keyframe: true, width: 1920, height: 1080, channel });

function attached(stallMs: number, reassertWanted?: () => boolean) {
  const session = new FakeP2PSession();
  const debug = vi.fn();
  const stream = new LiveStream(session as unknown as P2PSession, {
    channel: 2,
    homeBaseAttached: true,
    keepAliveMs: 20,
    stallMs,
    reassertWanted,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  stream.on("video", () => undefined);
  stream.start();
  return { session, stream, traces: () => debug.mock.calls.flatMap(([, trace]) => (trace ? [trace] : [])) };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an attached stream whose station stopped serving it", () => {
  it("stops re-asserting while its own media arrives", async () => {
    const { session, stream } = attached(200);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(70);

    expect(session.starts.length).toBe(settled);
    stream.stop();
  });

  it("re-asserts again after its media has been silent for the stall window", async () => {
    const { session, stream } = attached(50);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(140);

    expect(session.starts.length).toBeGreaterThan(settled);
    stream.stop();
  });

  it("settles again on the next frame, so recovery does not become the contention it replaced", async () => {
    const { session, stream } = attached(50);
    session.push(ownFrame(2));
    await settle(140);
    session.push(ownFrame(2));
    const resettled = session.starts.length;
    await settle(40);

    expect(session.starts.length).toBe(resettled);
    stream.stop();
  });

  /**
   * The silence and what was done about it are traced, because a picture that stopped advancing while nothing
   * here fires stopped for a reason the station's attention cannot repair.
   */
  it("states the silence it acted on, and that it re-asserted", async () => {
    const { session, stream, traces } = attached(50);
    session.push(ownFrame(2));
    await settle(140);

    expect(traces()).toContainEqual(
      expect.objectContaining({ phase: "channel-silent", silentMs: 50, outcome: "reasserted" }),
    );
    stream.stop();
  });

  it("re-asserts nothing once stopped", async () => {
    const { session, stream } = attached(40);
    session.push(ownFrame(2));
    stream.stop();
    const atStop = session.starts.length;
    await settle(120);

    expect(session.starts.length).toBe(atStop);
  });
});

/**
 * A re-assert takes the station from whichever camera it was serving, so a pull nothing is attached to
 * must not issue one. The owner answers whether anyone is attached; the stream only asks.
 */
describe("an attached stream nothing is attached to", () => {
  it("stays quiet through the stall window instead of taking the station", async () => {
    const { session, stream } = attached(50, () => false);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(200);

    expect(session.starts.length).toBe(settled);
    stream.stop();
  });

  it("states that it declined the channel rather than saying nothing at all", async () => {
    const { session, stream, traces } = attached(50, () => false);
    session.push(ownFrame(2));
    await settle(140);

    expect(traces()).toContainEqual(
      expect.objectContaining({ phase: "channel-silent", silentMs: 50, outcome: "declined" }),
    );
    stream.stop();
  });

  it("re-asserts at the next window once a consumer arrives, rather than staying silent for good", async () => {
    let watched = false;
    const { session, stream } = attached(50, () => watched);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(200);
    expect(session.starts.length).toBe(settled);

    watched = true;
    await settle(140);

    expect(session.starts.length).toBeGreaterThan(settled);
    stream.stop();
  });
});

describe("bounded recovery after an attached channel delivered video", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ends an attached consumer when re-asserts never restore video, without ending a delivering sibling", () => {
    const { session, stream, traces } = attached(50);
    const onStopped = vi.fn();
    const source = new SharedLiveSource({ makeStream: () => stream, onStopped });
    const consumer = source.attach();
    const ended = vi.fn();
    consumer.on("stop", ended);
    session.push(ownFrame(2));
    const sibling = new LiveStream(session as unknown as P2PSession, {
      channel: 3,
      homeBaseAttached: true,
      keepAliveMs: 20,
      stallMs: 200,
    }).start();
    const siblingVideo = vi.fn();
    sibling.on("video", siblingVideo);
    session.push(ownFrame(3));
    const traffic = setInterval(() => {
      session.push(ownFrame(3));
      session.push({ commandId: 1301, channel: 2, data: Buffer.alloc(24) });
    }, 100);
    vi.advanceTimersByTime(34_999);
    expect(source.state).toBe("live");
    expect(ended).not.toHaveBeenCalled();
    expect(session.starts.filter((channel) => channel === 2).length).toBeGreaterThan(2);
    vi.advanceTimersByTime(1);
    expect(source.state).toBe("stopped");
    expect(ended).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(session.stops).toEqual([2]);
    expect(traces()).toContainEqual(
      expect.objectContaining({ phase: "channel-silent", silentMs: 35000, outcome: "retired" }),
    );
    const delivered = siblingVideo.mock.calls.length;
    session.push(ownFrame(3));
    expect(siblingVideo).toHaveBeenCalledTimes(delivered + 1);
    clearInterval(traffic);
    const starts = session.starts.length;
    sibling.stop();
    vi.advanceTimersByTime(60_000);
    expect(session.starts).toHaveLength(starts);
  });

  it("cancels retirement when video returns and gives a later silence its own recovery window", () => {
    const { session, stream } = attached(50);
    const stopped = vi.fn();
    stream.on("stop", stopped);
    session.push(ownFrame(2));
    vi.advanceTimersByTime(30_000);
    session.push(ownFrame(2));
    vi.advanceTimersByTime(34_999);
    expect(stopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("leaves cold-start deadlines to the shared source until video has actually arrived", () => {
    const { session, stream } = attached(50);
    const stopped = vi.fn();
    stream.on("stop", stopped);
    vi.advanceTimersByTime(60_000);
    expect(stopped).not.toHaveBeenCalled();
    expect(session.starts.length).toBeGreaterThan(2);
    stream.stop();
  });

  it("does not start a retirement deadline while the owner declines re-assertion", () => {
    const { session, stream } = attached(50, () => false);
    const stopped = vi.fn();
    stream.on("stop", stopped);
    session.push(ownFrame(2));
    vi.advanceTimersByTime(60_000);
    expect(stopped).not.toHaveBeenCalled();
    expect(session.starts).toHaveLength(1);
    stream.stop();
  });
});
