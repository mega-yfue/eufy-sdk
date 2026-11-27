import { describe, expect, it, vi } from "vitest";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { FakeP2PSession, p2pAudioFrame, p2pVideoFrame, LIVE_FRAMES } from "./live-source-fixtures.js";

/**
 * A camera attached to a station receives its own media and nothing else, unconditionally.
 *
 * A station fans several cameras out over one session and tags every media frame with the camera it belongs
 * to, so each stream matches its own channel. That match used to have an escape hatch: after enough frames
 * tagged for another camera with none of its own, a stream concluded the station was tagging wrongly and took
 * every frame from then on.
 *
 * The hatch cannot be made safe here. One session serving one camera at a time keeps serving the previous one
 * while a new start is in flight, so a camera opened after another is routinely handed nothing but its
 * sibling's frames to begin with — and a stream that gave up then adopted that sibling's video and audio for
 * the rest of its life. Every attempt to qualify the condition left a hole: keying it on whether a sibling had
 * a start outstanding failed the moment the sibling's pull was released, because the frames already in flight
 * then belonged to a channel nothing had started.
 *
 * What the hatch protected against was a station that tags an attached camera's frames with a channel other
 * than the one started, which would leave the stream delivering nothing. That is DETECTABLE — the warm-up
 * deadline raises a typed start failure naming it — while serving another camera's picture is silent, and for
 * a security camera it is the worse of the two by a wide margin.
 */
/** A keyframe tagged for `channel`, as the station sends it. */
const ownFrame = (channel: number, nal = Buffer.from([0x65, 0x11])) =>
  p2pVideoFrame({ nal, keyframe: true, width: 1920, height: 1080, channel });

/** An AAC-LC audio frame tagged for `channel`. */
const ownAudio = (channel: number) => p2pAudioFrame(0, Buffer.from([0xff, 0xf1, 0x4c, 0x80]), channel);

function attachedStream(channel: number) {
  const session = new FakeP2PSession();
  const stream = new LiveStream(session as unknown as P2PSession, {
    channel,
    homeBaseAttached: true,
    frames: LIVE_FRAMES,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const video: number[] = [];
  const audio: number[] = [];
  stream.on("video", () => video.push(1));
  stream.on("audio", () => audio.push(1));
  stream.start();
  return { session, stream, video, audio };
}

/** Far more than any tolerance a give-up rule could have used. */
const RELENTLESS = 400;

describe("an attached camera's channel filter", () => {
  it("never delivers another channel's video, however long the station serves it", () => {
    const { session, video } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(ownFrame(3));
    expect(video).toHaveLength(0);
  });

  it("never delivers another channel's audio", () => {
    const { session, audio } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(ownAudio(3));
    expect(audio).toHaveLength(0);
  });

  it("delivers its own media the moment the station switches to it", () => {
    const { session, video } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(ownFrame(3));
    session.push(ownFrame(2));
    expect(video).toHaveLength(1);
  });

  it("keeps filtering after its own media has flowed", () => {
    const { session, video } = attachedStream(2);
    session.push(ownFrame(2));
    for (let i = 0; i < RELENTLESS; i++) session.push(ownFrame(3));
    expect(video).toHaveLength(1);
  });

  it("delivers only its own out of media interleaved from several cameras", () => {
    const { session, video } = attachedStream(2);
    for (const channel of [0, 1, 2, 3, 0, 2, 3, 1, 2]) session.push(ownFrame(channel));
    expect(video).toHaveLength(3);
  });

  /**
   * A camera that owns its session numbers its stream for itself: one was started on channel 0 and tagged its
   * frames channel 1, so matching there would drop the whole stream. Only an attached camera filters.
   */
  it("does not filter a camera that owns its session", () => {
    const session = new FakeP2PSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      homeBaseAttached: false,
      frames: LIVE_FRAMES,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const video: number[] = [];
    stream.on("video", () => video.push(1));
    stream.start();
    session.push(ownFrame(1));
    expect(video).toHaveLength(1);
  });
});
