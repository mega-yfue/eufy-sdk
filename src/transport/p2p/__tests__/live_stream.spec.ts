import { LiveStream, DEFAULT_KEEPALIVE_MS } from "../live-stream.js";
import { STATION_CHANNEL, type P2PSession } from "../p2p-session.js";
import { FakeP2PSession, START_CODE, p2pAudioFrame, p2pVideoFrame } from "./live-source-fixtures.js";

describe("LiveStream", () => {
  function mk(opts = {}) {
    const session = new FakeP2PSession();
    const live = new LiveStream(session as unknown as P2PSession, opts);
    return { session, live };
  }

  it("starts media on start() and stops on stop()", () => {
    const { session, live } = mk();
    live.start();
    expect(session.started).toBe(1);
    live.stop();
    expect(session.stopped).toBe(1);
  });

  it("ends an active stream when its P2P peer stops answering", () => {
    const { session, live } = mk();
    const stopped = vi.fn();
    live.on("stop", stopped);
    live.start();
    session.emit("pathStale");
    expect(stopped).toHaveBeenCalledOnce();
    expect(session.stopped).toBe(1);
    session.emit("pathStale");
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("emits Annex-B video with the 22-byte header stripped + keyframe flag + resolution", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    session.push(p2pVideoFrame({ keyframe: true, width: 960, height: 540, nal: Buffer.from([0x67, 1, 2, 3]) }));
    session.push(p2pVideoFrame({ keyframe: false, nal: Buffer.from([0x41, 9]) }));
    expect(frames).toHaveLength(2);
    expect(frames[0].keyframe).toBe(true);
    expect(frames[0].width).toBe(960);
    expect(frames[0].height).toBe(540);
    expect(frames[0].data.subarray(0, 4).equals(START_CODE)).toBe(true); // header gone, starts at NAL start code
    expect(frames[0].data[4]).toBe(0x67); // SPS NAL
    expect(frames[1].keyframe).toBe(false);
  });

  it("reports identity-free startup milestones at debug level", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session, live } = mk({ logger });
    live.start();

    session.push(p2pVideoFrame({ keyframe: true, nal: Buffer.from([0x67, 1, 2, 3]) }));

    expect(
      logger.debug.mock.calls.filter(([message]) => message === "[live] start trace").map(([, detail]) => detail),
    ).toEqual([
      { phase: "first-video-command", signCode: 0, accepted: true },
      { phase: "first-video-unit", keyframe: true },
      { phase: "first-keyframe" },
    ]);
  });

  it("sniffs codec on a keyframe and carries it onto following delta frames", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    // keyframe leads with an h265 VPS (0x40 → type 32); the delta after it has no config to sniff
    session.push(p2pVideoFrame({ keyframe: true, nal: Buffer.from([0x40, 0x01, 0x0c]) }));
    session.push(p2pVideoFrame({ keyframe: false, nal: Buffer.from([0x02, 0x01]) }));
    expect(frames[0].codec).toBe("h265");
    expect(frames[1].codec).toBe("h265"); // delta inherits the last-known codec
  });

  it("defaults codec to h264 before any keyframe", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    session.push(p2pVideoFrame({ keyframe: false, nal: Buffer.from([0x21, 0x9a]) }));
    expect(frames[0].codec).toBe("h264");
  });

  it("emits audio with its 16-byte header stripped, carrying the declared codec", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const payload = Buffer.from([10, 11, 12, 13]);
    session.push(p2pAudioFrame(0, payload) as any);
    expect(audio).toHaveLength(1);
    expect(audio[0].codec).toBe("aac-lc");
    expect(audio[0].data.equals(payload)).toBe(true);
  });

  it("maps each codec id the app accepts, and re-reads it on every frame", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const p = Buffer.from([1]);
    session.push(p2pAudioFrame(0, p) as any);
    session.push(p2pAudioFrame(7, p) as any);
    session.push(p2pAudioFrame(2, p) as any);
    expect(audio.map((f) => f.codec)).toEqual(["aac-lc", "aac-eld", "g711a"]);
  });

  it("drops every frame whose codec id the station did not declare", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const p = Buffer.from([1]);
    session.push(p2pAudioFrame(9, p) as any);
    expect(audio).toHaveLength(0);
    session.push(p2pAudioFrame(7, p) as any);
    session.push(p2pAudioFrame(9, p) as any);
    expect(audio.map((f) => f.codec)).toEqual(["aac-eld"]);
  });

  it("starts the requested camera channel", () => {
    const { session, live } = mk({ channel: 3 }); // e.g. T8425
    live.start();
    expect(session.startChannel).toBe(3);
  });

  /**
   * A camera that owns its session numbers its stream for itself: one was measured started on channel 0
   * and tagging its frames channel 1. There is only one camera on that session, so there is nothing to tell
   * apart — and matching the started channel there would drop the entire stream.
   */
  it("takes every frame on an own-session camera, whatever channel the station tags", () => {
    const { session, live } = mk({ channel: 0 });
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();

    session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 1 }));

    expect(frames).toHaveLength(1);
  });

  it("does not emit video it cannot decode (encrypted frame, no key)", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    // 22-byte header then random (no start code) = encrypted body, no ecc key → skipped
    session.push({
      commandId: 1300,
      channel: 0,
      signCode: 2,
      data: Buffer.concat([Buffer.alloc(0x16, 7), Buffer.from([9, 9, 9, 9])]),
    } as any);
    expect(frames).toHaveLength(0);
  });
});

/**
 * A station splits an access unit larger than its chunk size across several `CMD_VIDEO_FRAME` frames.
 * `LiveVideoFrame` is documented as one access unit, and a consumer that reads `keyframe` as "this buffer
 * is independently decodable", switches codec at a keyframe, or counts frames is deciding per access unit;
 * delivering chunks silently makes all three wrong.
 *
 * The wire semantics below are measured on two camera models, not inferred:
 *  - each frame declares only the payload IT carries, so the unit's total is nowhere on the wire — a
 *    70190-byte unit arrived as 64000 then 6190;
 *  - the frames of one unit repeat its header (same timestamp, same sequence field);
 *  - every frame of a split unit is filled to 64000 except the last;
 *  - a frame that starts a unit begins with a start code; a continuation begins mid-NAL.
 */
describe("LiveStream access-unit reassembly", () => {
  const CHUNK = 64000;

  /** The 22-byte plaintext header, as the station repeats it on every frame of one unit. */
  function header(payloadLength: number, opts: { keyframe?: boolean; sequence?: number; timestamp?: number } = {}) {
    const hdr = Buffer.alloc(0x16);
    hdr.writeUInt32LE(payloadLength, 0x00);
    hdr.writeUInt8(opts.keyframe === false ? 0x00 : 0x01, 0x04);
    hdr.writeUInt16LE(opts.sequence ?? 0, 0x06);
    hdr.writeInt16LE(1920, 0x0a);
    hdr.writeInt16LE(1080, 0x0c);
    hdr.writeUInt32LE(opts.timestamp ?? 0x1000, 0x0e);
    return hdr;
  }

  /** One `CMD_VIDEO_FRAME`: its header declares the body it carries, exactly as the station does. */
  function videoChunk(body: Buffer, opts: { keyframe?: boolean; sequence?: number; timestamp?: number } = {}) {
    return {
      commandId: 1300,
      channel: 0,
      signCode: 0,
      data: Buffer.concat([header(body.length, opts), body]),
    };
  }

  /** A frame filled to exactly the split threshold: parameter sets, then the start of an IDR. */
  const idrHead = Buffer.concat([START_CODE, Buffer.from([0x67, 0x42, 0x00]), START_CODE, Buffer.from([0x65, 0x88])]);
  const filled = Buffer.concat([idrHead, Buffer.alloc(CHUNK - idrHead.length, 0x11)]);
  /** The rest of that IDR — mid-NAL, so no start code of its own, and short so it ends the unit. */
  const tail = Buffer.from([0x22, 0x33, 0x44, 0x55, 0x66]);
  /** An ordinary small unit, complete in one frame. */
  const small = Buffer.concat([START_CODE, Buffer.from([0x41, 0x9a, 0x02])]);

  function mk(opts = {}) {
    const session = new FakeP2PSession();
    const frames: any[] = [];
    const live = new LiveStream(session as unknown as P2PSession, opts).start();
    live.on("video", (f) => frames.push(f));
    return { session, live, frames };
  }

  it("delivers a split unit as ONE whole access unit", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));
    session.push(videoChunk(tail));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(Buffer.concat([filled, tail]))).toBe(true);
    expect(frames[0]).toMatchObject({ keyframe: true, width: 1920, height: 1080 });
  });

  it("emits nothing while the unit's latest frame is still full", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));

    expect(frames).toEqual([]);
  });

  /**
   * The continuation repeats the keyframe flag while carrying no parameter sets, so a consumer beginning a
   * decode there has nothing to decode against.
   */
  it("never announces a continuation as a keyframe of its own", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));
    session.push(videoChunk(tail));

    expect(frames.filter((f) => f.keyframe)).toHaveLength(1);
  });

  /** The overwhelming majority of units arrive in one frame below the threshold: no holding, no latency. */
  it("delivers a unit that arrives in one frame immediately", () => {
    const { session, frames } = mk();

    session.push(videoChunk(small, { keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /**
   * The threshold is what a splitting station FILLS to, not a size above which a unit must be split.
   * Stations that never split deliver whole units far bigger than it — measured at 148057 and 231954
   * bytes — and holding those back, then discarding them as truncated, costs the very keyframes a
   * decoder cannot start without.
   */
  it("delivers a single-frame unit larger than the threshold immediately", () => {
    const { session, frames } = mk();
    const big = Buffer.concat([
      START_CODE,
      Buffer.from([0x67, 0x42, 0x00]),
      START_CODE,
      Buffer.from([0x65, 0x88]),
      Buffer.alloc(90_000, 0x11),
    ]);

    session.push(videoChunk(big));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(big)).toBe(true);
  });

  /**
   * Identity and the missing start code are required together. A following unit that opens with a start
   * code can never be absorbed, however the station labelled it — a merge is invisible to a consumer that
   * trusts the contract.
   */
  it("does not absorb a following unit that opens with a start code", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x1000, keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /** Nor one whose header describes a different unit, even where it continues mid-NAL. */
  it("does not absorb a continuation-shaped frame belonging to another unit", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(tail, { timestamp: 0x2000 }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(tail)).toBe(true);
  });

  /**
   * A lost datagram costs the whole frame the P2P layer was reassembling, so a unit whose tail never
   * arrives is ended by the next unit while still full. Handing those bytes to a decoder is what produces
   * `error while decoding MB …, bytestream -28` — it ran off the end of a slice whose header promised more.
   */
  it("drops a unit whose tail never arrived rather than delivering truncated bytes", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x2000, keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /** The loss was previously silent in both directions: no frame, and nothing said so. */
  it("reports a dropped unit instead of losing it silently", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session } = mk({ logger });

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x2000, keyframe: false }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(`${filled.length}`);
  });

  /** One line per stream, not per frame: a camera dropping units steadily must not flood a host's log. */
  it("warns once per stream and keeps the rest at debug level", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session } = mk({ logger });

    for (let i = 1; i <= 3; i++) {
      session.push(videoChunk(filled, { timestamp: i * 0x1000 }));
      session.push(videoChunk(small, { timestamp: i * 0x1000 + 1, keyframe: false }));
    }

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(
      logger.debug.mock.calls.filter(([message]) => String(message).includes("dropped an incomplete")).length,
    ).toBe(2);
  });
});

/**
 * A HomeBase fans several cameras out over ONE session, so every stream on it reads the same inbound feed.
 * The station says which camera a media frame belongs to — measured with two cameras of different geometry
 * warm at once, the frame's channel field partitioned them exactly (1920x1080 on the started channel 0,
 * 640x480 on channel 2, video and audio alike) while each handle was delivered both cameras' frames.
 */
describe("LiveStream channel isolation on a HomeBase", () => {
  function attached(channel: number, logger?: unknown) {
    const session = new FakeP2PSession();
    const frames: any[] = [];
    const audio: any[] = [];
    const live = new LiveStream(session as unknown as P2PSession, {
      channel,
      homeBaseAttached: true,
      logger: logger as never,
    }).start();
    live.on("video", (f) => frames.push(f));
    live.on("audio", (f) => audio.push(f));
    return { session, frames, audio };
  }

  it("takes the frames the station tagged for its own camera", () => {
    const { session, frames } = attached(2);

    session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 2 }));

    expect(frames).toHaveLength(1);
  });

  it("drops another camera's video, which used to interleave into this stream", () => {
    const { session, frames } = attached(2);

    session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 2 }));
    session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames).toHaveLength(1);
  });

  /** Audio is tagged the same way — a doorbell's audio in another camera's stream is the same defect. */
  it("drops another camera's audio too", () => {
    const { session, audio } = attached(2);

    session.push({ ...p2pAudioFrame(0, Buffer.from([1, 2])), channel: 2 } as any);
    session.push({ ...p2pAudioFrame(0, Buffer.from([1, 2])), channel: 0 } as any);

    expect(audio).toHaveLength(1);
  });

  /**
   * The filter never gives up, however long a station serves another camera instead of this one.
   *
   * It used to, after a bounded run of foreign frames, on the theory that such a station tags differently and
   * the stream would otherwise deliver nothing. Over one session serving one camera at a time that run is what
   * an ordinary handover produces, so the stream adopted its sibling's picture for the rest of its life. A stream
   * receiving none of its own media instead hits the warm-up deadline and reports a typed start failure, which
   * is the same information without ever showing the wrong camera.
   */
  it("never stops filtering, however long only another channel's frames arrive", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session, frames } = attached(2, logger);

    for (let i = 0; i < 400; i++) session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /** Its own tag still delivers, which is what makes the filter a filter rather than a mute. */
  it("keeps filtering once its own camera's tag has been seen", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session, frames } = attached(2, logger);

    session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 2 }));
    for (let i = 0; i < 40; i++) session.push(p2pVideoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * The keepalive is ON by default. A battery camera stops sending ~8s after the last media start with
 * nothing holding it (measured live: video ceased at 8s and 10s on two battery cameras, with no stop
 * and no error), while a mains camera streamed unprompted for 25s. The nudge is idempotent, so a
 * camera that does not need it is unaffected.
 */
describe("LiveStream keepalive default", () => {
  it("re-issues the media start without the caller asking", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeP2PSession();
      const stream = new LiveStream(session as unknown as P2PSession, { channel: 0 }).start();
      expect(session.started).toBe(1);
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 3 + 10);
      expect(session.started).toBeGreaterThanOrEqual(4);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * On an attached camera the nudge is not a ping — it re-sends the full media start, which over one session
   * serving one camera at a time re-asserts this camera's channel against whatever else is warm on it.
   * Measured on a real base, two attached streams sharing one session each restarted every 3 s and fought for
   * it continuously.
   *
   * Once the station has delivered a frame of this camera's own channel it has proven it is serving this one,
   * so re-asserting buys nothing and costs the contention. The SDK's own measurement agrees the nudge is
   * unnecessary there: both attached cameras held a 40 s stream with it disabled, while the own-session camera
   * that needs it went quiet at 13.6 s without it.
   *
   * It holds while that media KEEPS arriving. Silence says the station is serving something else, and the
   * re-assert is what recovers it — see `attached-keepalive-stall.spec.ts`.
   */
  it("stops re-issuing the start on an attached camera while its own media keeps arriving", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeP2PSession();
      const stream = new LiveStream(session as unknown as P2PSession, {
        channel: 2,
        homeBaseAttached: true,
      }).start();
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 2 + 10);
      const beforeMedia = session.started;
      expect(beforeMedia).toBeGreaterThan(1);

      for (let tick = 0; tick < 5; tick++) {
        session.push(p2pVideoFrame({ nal: Buffer.from([0x65, 1]), channel: 2 }));
        vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS);
      }

      expect(session.started).toBe(beforeMedia);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps re-issuing the start on an own-session camera, which goes quiet without it", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeP2PSession();
      const stream = new LiveStream(session as unknown as P2PSession, {
        channel: 0,
        homeBaseAttached: false,
      }).start();
      session.push(p2pVideoFrame({ nal: Buffer.from([0x65, 1]), channel: 0 }));
      const afterMedia = session.started;
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 3 + 10);

      expect(session.started).toBeGreaterThan(afterMedia);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A frame for another camera proves nothing about this one, so the nudge must survive it. */
  it("keeps re-issuing while only another camera's media arrives", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeP2PSession();
      const stream = new LiveStream(session as unknown as P2PSession, {
        channel: 2,
        homeBaseAttached: true,
      }).start();
      session.push(p2pVideoFrame({ nal: Buffer.from([0x65, 1]), channel: 3 }));
      const afterForeign = session.started;
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 3 + 10);

      expect(session.started).toBeGreaterThan(afterForeign);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours an explicit 0 as off", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeP2PSession();
      const stream = new LiveStream(session as unknown as P2PSession, { channel: 0, keepAliveMs: 0 }).start();
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 5);
      expect(session.started).toBe(1);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A stream forwards the abandonment of its OWN media start, and nothing else.
 *
 * The session records the channel it RESOLVED — {@link STATION_CHANNEL} where the caller named none — and
 * reports that channel back. A stream re-deriving the default differently never matches its own
 * abandonment, which leaves the session-replacement recovery behind it unreachable.
 */
describe("an abandoned media start", () => {
  const abandon = (session: FakeP2PSession, channel: number) => session.emit("liveStartUnacknowledged", channel);

  it("reaches a stream that named no channel, which starts on the station channel", () => {
    const session = new FakeP2PSession();
    const stream = new LiveStream(session as unknown as P2PSession, { keepAliveMs: 0 }).start();
    const seen = vi.fn();
    stream.on("unacknowledged", seen);

    expect(session.startChannel).toBeUndefined();
    abandon(session, STATION_CHANNEL);

    expect(seen).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it("reaches a stream on its own channel", () => {
    const session = new FakeP2PSession();
    const stream = new LiveStream(session as unknown as P2PSession, { channel: 2, keepAliveMs: 0 }).start();
    const seen = vi.fn();
    stream.on("unacknowledged", seen);

    abandon(session, 2);

    expect(seen).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it("never reaches a sibling's stream on the same station session", () => {
    const session = new FakeP2PSession();
    const stream = new LiveStream(session as unknown as P2PSession, { channel: 2, keepAliveMs: 0 }).start();
    const seen = vi.fn();
    stream.on("unacknowledged", seen);

    abandon(session, 0);
    abandon(session, STATION_CHANNEL);

    expect(seen).not.toHaveBeenCalled();
    stream.stop();
  });
});
