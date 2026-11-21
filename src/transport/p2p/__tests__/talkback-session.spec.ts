import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Talkback, type TalkbackSink } from "../talkback.js";
import { P2PCommandRouter } from "../command-router.js";
import { AAC_FRAME_MS } from "../adts.js";
import type { Logger } from "../../../core/logger.js";
import type { LiveAudioFrame } from "../../../core/contracts.js";

/**
 * The pacing layer: frame recovery, playback-rate release, backpressure and the topology arguments
 * it forwards. Timers are faked, so "64 ms per frame" is asserted exactly rather than raced.
 */
function adtsFrame(payloadLen: number, opts: { freqIndex?: number; channels?: number } = {}): Buffer {
  const total = 7 + payloadLen;
  const freqIndex = opts.freqIndex ?? 8;
  const channels = opts.channels ?? 1;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = (1 << 6) | (freqIndex << 2) | ((channels >> 2) & 0x01);
  h[3] = ((channels & 0x03) << 6) | ((total >> 11) & 0x03);
  h[4] = (total >> 3) & 0xff;
  h[5] = ((total & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  return Buffer.concat([h, Buffer.alloc(payloadLen, 0x5a)]);
}

/** One LD-SBR AAC-ELD access unit: 512 samples at 16 kHz. */
const ELD_UNIT_MS = 32;

const eldUnit = (len: number) => Buffer.alloc(len, 0x3c);

/** Synthetic talkback frames: the direct 1005 / 1006 an attached camera opens and closes its speaker with. */
const TALK = {
  start: { cmd: 1005, body: "native", payload: {}, layout: "u32-ch" },
  stop: { cmd: 1006, body: "native", payload: {}, layout: "u32-ch" },
};

function fakeSink(opts: { startOk?: boolean } = {}): TalkbackSink & {
  started: number[];
  stopped: number[];
  frames: Array<[number, Buffer]>;
  emitGap(seq: number): void;
} {
  const gaps = new EventEmitter();
  return {
    started: [],
    stopped: [],
    frames: [],
    sendFrame(frame, channel) {
      if (frame === TALK.start && opts.startOk === false) throw new Error("not connected");
      (frame === TALK.stop ? this.stopped : this.started).push(channel);
    },
    sendAudioFrame(channel, frame) {
      this.frames.push([channel, frame]);
    },
    on: (event, listener) => gaps.on(event, listener),
    off: (event, listener) => gaps.off(event, listener),
    emitGap: (seq) => void gaps.emit("audioGap", seq),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * Let pending `process.nextTick`/microtask work run. Node's Writable invokes `_write` on a later
 * tick, and the PCM path awaits the caller's encoder — neither is a timer, so faking timers does not
 * cover them.
 */
const settle = () => new Promise<void>((r) => process.nextTick(r));

/** A logger that only records warnings — the channel a listener-less `error` degrades to. */
const quietLogger = (warn: (m: string) => void): Logger => ({ debug: () => {}, info: () => {}, error: () => {}, warn });

describe("Talkback lifecycle", () => {
  it("opens the path with its start frame on the channel it was built for", () => {
    const sink = fakeSink();
    new Talkback(sink, { channel: 3, ...TALK }).start("aac-lc");
    expect(sink.started).toEqual([3]);
  });

  it("throws instead of accepting audio nobody would hear when the path will not open", () => {
    const sink = fakeSink({ startOk: false });
    expect(() => new Talkback(sink, { channel: 3, ...TALK }).start("aac-lc")).toThrow(/not connected/);
  });

  it("sends the stop frame and forgets queued audio on stop", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    talk.write(Buffer.concat([adtsFrame(64), adtsFrame(64), adtsFrame(64)]));
    expect(talk.pending).toBe(3);
    await talk.stop();
    expect(sink.stopped).toEqual([0]);
    expect(talk.pending).toBe(0);
    vi.advanceTimersByTime(AAC_FRAME_MS * 5);
    expect(sink.frames).toEqual([]);
  });

  it("is idempotent on stop", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    await talk.stop();
    await talk.stop();
    expect(sink.stopped).toHaveLength(1);
  });

  /**
   * A second `start()` would put another start frame on the wire and leak the first pacing interval,
   * with the handle still reporting one session.
   */
  it("is idempotent on start", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    talk.start("aac-lc");
    talk.start("aac-lc");
    expect(sink.started).toEqual([0]);

    talk.write(adtsFrame(64));
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames).toHaveLength(1);
  });
});

/**
 * The audio channel is ordered, so a frame the device never acknowledges is a permanent hole that can
 * stall everything queued behind it. Nothing else observes that: the session evicts the entry, so the
 * in-flight count reads healthy while the speaker has gone quiet.
 */
describe("Talkback and an unacknowledged frame", () => {
  it("reports a gap the session abandoned", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));

    sink.emitGap(41);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/never acknowledged audio frame 41/);
  });

  it("stops listening for gaps once the path is closed", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));

    await talk.stop();
    sink.emitGap(7);

    expect(errors).toEqual([]);
  });
});

describe("Talkback for a camera that plays aac-eld", () => {
  it("paces one access unit per write at 32 ms", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-eld");
    expect(talk.codec).toBe("aac-eld");
    talk.write(eldUnit(120));
    talk.write(eldUnit(121));
    talk.write(eldUnit(122));

    vi.advanceTimersByTime(ELD_UNIT_MS);
    expect(sink.frames).toHaveLength(1);
    vi.advanceTimersByTime(ELD_UNIT_MS * 2);
    expect(sink.frames.map(([, f]) => f.length)).toEqual([120, 121, 122]);
  });

  it("rejects an access unit longer than the device accepts", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-eld");
    const errors: string[] = [];
    talk.on("error", (e) => errors.push(e.message));
    talk.write(eldUnit(641));
    expect(talk.pending).toBe(0);
    expect(errors[0]).toMatch(/640/);
  });

  it("writable is object-mode only for aac-eld", () => {
    const eld = new Talkback(fakeSink(), { channel: 0, ...TALK }).start("aac-eld");
    const lc = new Talkback(fakeSink(), { channel: 0, ...TALK }).start("aac-lc");
    expect(eld.writable().writableObjectMode).toBe(true);
    expect(lc.writable().writableObjectMode).toBe(false);
  });

  it("writable withholds its callback at the high-water mark", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK, highWaterFrames: 2 }).start("aac-eld");
    const w = talk.writable();
    const done = vi.fn();
    w.write(eldUnit(100));
    w.write(eldUnit(100));
    w.write(eldUnit(100), done);
    await settle();
    expect(done).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ELD_UNIT_MS * 2);
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("Talkback pacing", () => {
  it("releases exactly one frame per frame-duration tick", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 2, ...TALK }).start("aac-lc");
    talk.write(Buffer.concat([adtsFrame(64), adtsFrame(64), adtsFrame(64)]));

    expect(sink.frames).toHaveLength(0);
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames).toHaveLength(1);
    vi.advanceTimersByTime(AAC_FRAME_MS * 2);
    expect(sink.frames).toHaveLength(3);
    expect(sink.frames.every(([ch]) => ch === 2)).toBe(true);
  });

  it("does not drain a whole clip at once — the reason pacing exists", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const clip = Buffer.concat(Array.from({ length: 50 }, () => adtsFrame(64)));
    talk.write(clip);
    vi.advanceTimersByTime(AAC_FRAME_MS * 10);
    expect(sink.frames).toHaveLength(10);
    expect(talk.pending).toBe(40);
  });

  /**
   * A tick that runs late must send every frame it owes, not one. `setInterval` reschedules from when
   * the callback RAN, so on a loaded event loop — the normal case here, since talkback attaches to a
   * shared source that is muxing video on the same loop — a one-frame-per-tick pacer loses each late
   * tick permanently and the device sees a feed slower than realtime.
   */
  it("catches up after a late tick instead of losing the frames it owed", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    talk.write(Buffer.concat(Array.from({ length: 20 }, () => adtsFrame(64))));

    vi.advanceTimersByTime(AAC_FRAME_MS * 5);
    expect(sink.frames).toHaveLength(5);

    // One tick's callback lands five frame-durations late; it owes five frames, not one.
    vi.setSystemTime(Date.now() + AAC_FRAME_MS * 5);
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames).toHaveLength(11);
  });

  it("does not owe frames for silence the source itself left", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    talk.write(adtsFrame(64));
    vi.advanceTimersByTime(AAC_FRAME_MS * 20);
    expect(sink.frames).toHaveLength(1);

    talk.write(Buffer.concat([adtsFrame(64), adtsFrame(64), adtsFrame(64)]));
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames).toHaveLength(2);
  });

  it("reassembles frames split across writes", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const frame = adtsFrame(120);
    talk.write(frame.subarray(0, 40));
    expect(talk.pending).toBe(0);
    talk.write(frame.subarray(40));
    expect(talk.pending).toBe(1);
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames[0][1]).toEqual(frame);
  });
});

/**
 * `finished` means the CLIP is done — the input ended and the queue drained — not "the queue is
 * momentarily empty". A realtime producer empties the queue after every single frame, so a completion
 * signal on an empty queue fires immediately and a caller stopping on it plays 64 ms of a 60 s clip.
 */
describe("Talkback completion", () => {
  it("stays quiet while the queue empties but the input is still open", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const finished = vi.fn();
    talk.on("finished", finished);

    for (let i = 0; i < 30; i++) {
      talk.write(adtsFrame(64));
      vi.advanceTimersByTime(AAC_FRAME_MS);
    }

    expect(sink.frames).toHaveLength(30);
    expect(finished).not.toHaveBeenCalled();
  });

  it("fires once the input has ended AND the queue has drained", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const finished = vi.fn();
    talk.on("finished", finished);

    talk.write(Buffer.concat([adtsFrame(64), adtsFrame(64)]));
    talk.end();
    expect(finished).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(finished).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(AAC_FRAME_MS * 10);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("refuses audio written after the input was declared finished", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));

    talk.end();
    await settle();
    talk.write(adtsFrame(64));

    expect(talk.pending).toBe(0);
    expect(errors[0].message).toMatch(/write after end/);
  });

  it("fires on end() when nothing is queued", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const finished = vi.fn();
    talk.on("finished", finished);
    talk.end();
    await settle();
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("ends the input when a piped source finishes, with no explicit end() call", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const finished = vi.fn();
    talk.on("finished", finished);

    const w = talk.writable();
    w.end(Buffer.concat([adtsFrame(64), adtsFrame(64)]));
    await settle();
    await settle();

    vi.advanceTimersByTime(AAC_FRAME_MS * 2);
    expect(finished).toHaveBeenCalledTimes(1);
  });
});

/**
 * `error` on a bare EventEmitter THROWS when nothing is listening, and every emit here happens inside
 * the pacing interval or on a detached encode — where the throw aborts the process instead of reaching
 * a caller. Audio that simply isn't 16 kHz mono is the common case, and the documented example attaches
 * no `error` listener, so this must degrade to a log line.
 */
describe("Talkback error reporting with no listener", () => {
  it("logs instead of throwing when a rejected frame has nobody to report to", () => {
    const warn = vi.fn();
    const talk = new Talkback(fakeSink(), { channel: 0, ...TALK, logger: quietLogger(warn) }).start("aac-lc");
    expect(() => talk.write(adtsFrame(64, { freqIndex: 4 }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/AAC-LC 16000 Hz mono/);
  });

  it("does not throw out of the pacing tick when the sink fails", () => {
    const sink = fakeSink();
    sink.sendAudioFrame = () => {
      throw new Error("socket gone");
    };
    const warn = vi.fn();
    const talk = new Talkback(sink, { channel: 0, ...TALK, logger: quietLogger(warn) }).start("aac-lc");
    talk.write(adtsFrame(64));
    expect(() => vi.advanceTimersByTime(AAC_FRAME_MS)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("socket gone");
  });

  it("logs an encoder failure rather than becoming an unhandled rejection", async () => {
    const warn = vi.fn();
    const encoder = {
      encode: async () => {
        throw new Error("encoder died");
      },
    };
    const talk = new Talkback(fakeSink(), {
      channel: 0,
      ...TALK,
      encoder,
      logger: quietLogger(warn),
    }).start("aac-lc");
    talk.write(Buffer.alloc(2048));
    await settle();
    await settle();
    expect(warn).toHaveBeenCalledWith("encoder died");
  });
});

describe("Talkback input validation", () => {
  it("rejects audio the device cannot play rather than passing it through", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));
    talk.write(adtsFrame(64, { freqIndex: 4 }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/AAC-LC 16000 Hz mono/);
    expect(talk.pending).toBe(0);
  });

  it("rejects a frame longer than the device accepts", () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));
    talk.write(adtsFrame(700));
    expect(errors[0].message).toMatch(/exceeds the device's 640 B limit/);
    expect(talk.pending).toBe(0);
  });

  it("ignores writes after stop", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK }).start("aac-lc");
    await talk.stop();
    talk.write(adtsFrame(64));
    expect(talk.pending).toBe(0);
  });
});

describe("Talkback PCM input", () => {
  it("routes writes through a caller-supplied encoder", async () => {
    const sink = fakeSink();
    const encoded = adtsFrame(64);
    const encoder = { encode: vi.fn(async () => [encoded]) };
    const talk = new Talkback(sink, { channel: 0, ...TALK, encoder }).start("aac-lc");
    talk.write(Buffer.alloc(2048));
    await settle();
    expect(talk.pending).toBe(1);
    expect(encoder.encode).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(sink.frames[0][1]).toEqual(encoded);
  });

  it("surfaces an encoder failure as an error rather than a silent gap", async () => {
    const sink = fakeSink();
    const encoder = {
      encode: vi.fn(async () => {
        throw new Error("encoder died");
      }),
    };
    const talk = new Talkback(sink, { channel: 0, ...TALK, encoder }).start("aac-lc");
    const errors: Error[] = [];
    talk.on("error", (e) => errors.push(e));
    talk.write(Buffer.alloc(2048));
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("encoder died");
  });

  it("closes the encoder on stop", async () => {
    const sink = fakeSink();
    const encoder = { encode: async () => [], close: vi.fn() };
    const talk = new Talkback(sink, { channel: 0, ...TALK, encoder }).start("aac-lc");
    await talk.stop();
    expect(encoder.close).toHaveBeenCalled();
  });

  /**
   * An async encoder's calls can settle out of order, and both push into a STATEFUL frame reader — so
   * unserialized encodes scramble the audio. Only a caller-supplied encoder can trigger this, which is
   * the entire point of the encoder contract.
   */
  it("keeps frames in written order when the encoder settles out of order", async () => {
    const sink = fakeSink();
    const marks = [0x11, 0x22, 0x33];
    let call = 0;
    const encoder = {
      encode: async () => {
        // First call settles LAST — the ordering hazard, made deterministic.
        const n = call++;
        const delay = n === 0 ? 3 : 1;
        await new Promise<void>((r) => setTimeout(r, delay));
        const f = adtsFrame(8);
        f[7] = marks[n];
        return [f];
      },
    };
    const talk = new Talkback(sink, { channel: 0, ...TALK, encoder }).start("aac-lc");

    talk.write(Buffer.alloc(4));
    talk.write(Buffer.alloc(4));
    talk.write(Buffer.alloc(4));
    await vi.advanceTimersByTimeAsync(20);
    vi.advanceTimersByTime(AAC_FRAME_MS * 3);

    expect(sink.frames.map(([, f]) => f[7])).toEqual(marks);
  });

  it("flushes the encoder's tail behind the last pending encode, not ahead of it", async () => {
    const sink = fakeSink();
    const encoder = {
      encode: async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        const f = adtsFrame(8);
        f[7] = 0xaa;
        return [f];
      },
      flush: async () => {
        const f = adtsFrame(8);
        f[7] = 0xbb;
        return [f];
      },
    };
    const talk = new Talkback(sink, { channel: 0, ...TALK, encoder }).start("aac-lc");

    talk.write(Buffer.alloc(4));
    talk.end();
    await vi.advanceTimersByTimeAsync(20);
    vi.advanceTimersByTime(AAC_FRAME_MS * 2);

    expect(sink.frames.map(([, f]) => f[7])).toEqual([0xaa, 0xbb]);
  });
});

describe("Talkback writable()", () => {
  it("withholds its callback while the queue is at the high-water mark", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK, highWaterFrames: 2 }).start("aac-lc");
    const w = talk.writable();

    const done = vi.fn();
    w.write(Buffer.concat([adtsFrame(64), adtsFrame(64), adtsFrame(64)]), done);
    await settle();
    expect(done).not.toHaveBeenCalled();

    // Three queued against a mark of two: one tick still leaves the queue at the mark, the second
    // opens a slot and releases the writer.
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AAC_FRAME_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("lets a write through immediately while there is room", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK, highWaterFrames: 10 }).start("aac-lc");
    const done = vi.fn();
    talk.writable().write(adtsFrame(64), done);
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("releases a withheld writer on stop so a pipe cannot hang", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, { channel: 0, ...TALK, highWaterFrames: 1 }).start("aac-lc");
    const done = vi.fn();
    talk.writable().write(Buffer.concat([adtsFrame(64), adtsFrame(64)]), done);
    await settle();
    expect(done).not.toHaveBeenCalled();
    await talk.stop();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/**
 * Talkback holds a media session open, so it inherits the same power bounding a live stream gets.
 * Without this a battery camera talked to (with no stream already running) would stream unbounded:
 * `SharedLiveSource` defaults `powered` to `"wired"`, and only the model knows the device's tier.
 */
describe("Talkback media-session lifetime", () => {
  it("releases the media session it was holding, exactly once", async () => {
    const sink = fakeSink();
    const releaseMedia = vi.fn();
    const talk = new Talkback(sink, { channel: 0, ...TALK, releaseMedia }).start("aac-lc");
    await talk.stop();
    await talk.stop();
    expect(releaseMedia).toHaveBeenCalledTimes(1);
  });

  it("releases the media session even when no audio was ever written", async () => {
    const sink = fakeSink();
    const releaseMedia = vi.fn();
    await new Talkback(sink, { channel: 0, ...TALK, releaseMedia }).start("aac-lc").stop();
    expect(releaseMedia).toHaveBeenCalled();
  });

  /**
   * The idempotence guard latches before the teardown runs, so a release skipped by a throw can never
   * be retried — the shared consumer would stay attached and hold the P2P pull open for the life of the
   * process. Everything between the guard and the release is caller-supplied and can throw.
   */
  it("releases the media session even when the session's stop frame throws", async () => {
    const sink = fakeSink();
    const releaseMedia = vi.fn();
    const talk = new Talkback(sink, { channel: 0, ...TALK, releaseMedia }).start("aac-lc");
    sink.sendFrame = () => {
      throw new Error("session gone");
    };
    await expect(talk.stop()).rejects.toThrow("session gone");
    expect(releaseMedia).toHaveBeenCalledTimes(1);
  });

  it("releases the media session even when the encoder's close throws", async () => {
    const encoder = {
      encode: async () => [],
      close: () => {
        throw new Error("encoder wedged");
      },
    };
    const releaseMedia = vi.fn();
    const talk = new Talkback(fakeSink(), { channel: 0, ...TALK, encoder, releaseMedia }).start("aac-lc");
    await expect(talk.stop()).rejects.toThrow("encoder wedged");
    expect(releaseMedia).toHaveBeenCalledTimes(1);
  });

  /**
   * A handle nobody stops holds a repeating timer and a shared-source consumer, and no budget reaps it
   * on a wired camera. The idle stop is what bounds a dropped handle.
   */
  it("stops itself after the idle window when nothing is written", async () => {
    const sink = fakeSink();
    const releaseMedia = vi.fn();
    new Talkback(sink, {
      channel: 0,
      ...TALK,
      releaseMedia,
      idleTimeoutMs: 5000,
    }).start("aac-lc");

    vi.advanceTimersByTime(4000);
    expect(sink.stopped).toEqual([]);

    vi.advanceTimersByTime(1500);
    await settle();
    expect(sink.stopped).toEqual([0]);
    expect(releaseMedia).toHaveBeenCalledTimes(1);
  });

  it("does not idle-stop a talkback that is still being written to", async () => {
    const sink = fakeSink();
    const talk = new Talkback(sink, {
      channel: 0,
      ...TALK,
      idleTimeoutMs: 5000,
    }).start("aac-lc");

    for (let i = 0; i < 12; i++) {
      talk.write(adtsFrame(64));
      vi.advanceTimersByTime(1000);
    }
    await settle();
    expect(sink.stopped).toEqual([]);
  });
});

/**
 * The wiring the ROUTER installs between a media consumer and a talkback — driven through the public
 * `mediaProviderFor(...).talkback()` rather than by calling `Talkback.stop()` directly, because a test
 * that stops the talkback itself passes whether or not the router wired anything at all.
 *
 * The battery budget lives on the SHARED source, not on one consumer: a live stream and a talkback
 * attached to the same camera are two consumers of one pull, so a single `extend()` covers both. When
 * nobody extends, the source ends every consumer and tears down — and talkback must go with it.
 */
describe("Talkback wiring installed by the router", () => {
  const LC_AUDIO: LiveAudioFrame = { codec: "aac-lc", data: adtsFrame(16) };
  const ELD_AUDIO: LiveAudioFrame = {
    codec: "aac-eld",
    data: Buffer.alloc(40, 1),
    config: Buffer.from("f8f03000", "hex"),
  };

  function routerWithFakeSource(
    opts: {
      warm?: Promise<void>;
      audio?: LiveAudioFrame | null;
      model?: string | null;
      parentSn?: string;
    } = {},
  ) {
    const sink = fakeSink();
    const consumer = new EventEmitter() as EventEmitter & { stop: ReturnType<typeof vi.fn> };
    consumer.stop = vi.fn();
    const records = opts.model === null ? [] : [{ sn: "T8000P0000000000", model: opts.model ?? "T8410C" } as never];
    const router = new P2PCommandRouter({
      mega: {} as never,
      logger: { warn: vi.fn() } as never,
      liveFramesFor: () => ({
        start: TALK.start,
        stop: TALK.stop,
        talkStart: TALK.start,
        talkStop: TALK.stop,
        ability: 0,
      }),
      listDevices: () => records,
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    });
    const stub = router as unknown as { resolveSession: unknown; sharedLiveSourceFor: unknown };
    stub.resolveSession = async () => ({
      session: sink,
      parentSn: opts.parentSn ?? "T8000P0000000000",
      channel: 0,
      accountId: "",
      homeBaseAttached: false,
    });
    stub.sharedLiveSourceFor = async () => {
      await opts.warm;
      return {
        attach: () => {
          const frame = opts.audio === undefined ? LC_AUDIO : opts.audio;
          if (frame) queueMicrotask(() => consumer.emit("audio", frame));
          return consumer;
        },
      };
    };
    return { router, sink, consumer };
  }

  /** A gate a spec opens by hand, standing in for the media source's warm-up round-trip. */
  function warmGate(): { warm: Promise<void>; warmed: () => void } {
    let warmed!: () => void;
    const warm = new Promise<void>((resolve) => {
      warmed = resolve;
    });
    return { warm, warmed };
  }

  it("ends the talkback when the media session it rides inside ends", async () => {
    const { router, sink, consumer } = routerWithFakeSource();
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    talk.write(Buffer.concat([adtsFrame(64), adtsFrame(64), adtsFrame(64)]));

    consumer.emit("stop");
    await settle();

    expect(sink.stopped).toEqual([0]);
    const before = sink.frames.length;
    vi.advanceTimersByTime(AAC_FRAME_MS * 10);
    expect(sink.frames).toHaveLength(before);
  });

  it("forwards the source's budget notice to the talkback's caller", async () => {
    const { router, consumer } = routerWithFakeSource();
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    const seen: unknown[] = [];
    talk.on("budget", (n) => seen.push(n));

    const notice = { extend: vi.fn(), graceMs: 10_000 };
    consumer.emit("budget", notice);

    expect(seen).toEqual([notice]);
  });

  /**
   * The device plays one audio stream and the session carries one audio sequence, so two handles would
   * interleave into noise and whichever stopped first would close the path under the other.
   */
  it("refuses a second talkback while one is open, then allows one after it stops", async () => {
    const { router, consumer } = routerWithFakeSource();
    const provider = router.mediaProviderFor("T8000P0000000000");
    const talk = await provider.talkback!();

    await expect(provider.talkback!()).rejects.toThrow(/already talking/);

    await talk.stop();
    await expect(provider.talkback!()).resolves.toBeDefined();
    expect(consumer.stop).toHaveBeenCalled();
  });

  /**
   * Warming the media source is a round-trip, so a check made before it and a claim made after it are two
   * different moments: two callers arriving together both found the map empty, both started, and both paced
   * onto the session's single audio sequence — with the first handle overwritten in the map and no longer
   * reachable by `closeAll`. One start frame on the sink is the proof only one of them opened the path.
   */
  it("refuses a second talkback that arrives while the first one's media session is warming", async () => {
    const { warm, warmed } = warmGate();
    const { router, sink } = routerWithFakeSource({ warm });
    const provider = router.mediaProviderFor("T8000P0000000000");

    const first = provider.talkback!();
    const second = provider.talkback!();
    warmed();

    await expect(second).rejects.toThrow(/already talking/);
    await expect(first).resolves.toBeDefined();
    expect(sink.started).toEqual([0]);
  });

  /** The mirror case: the claim is gone because everything was closed, so pacing would talk into a dead session. */
  it("does not start a talkback that was closed while its media session was warming", async () => {
    const { warm, warmed } = warmGate();
    const { router, sink } = routerWithFakeSource({ warm });

    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await vi.advanceTimersByTimeAsync(0); // the camera is claimed, and its media source is warming
    await router.closeAll();
    warmed();

    await expect(opening).rejects.toThrow(/closed while its media session was warming/);
    expect(sink.started).toEqual([]);
  });

  it("opens an aac-eld talkback for a camera that sends aac-eld", async () => {
    const { router, sink } = routerWithFakeSource({ audio: ELD_AUDIO });
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-eld");
    talk.write(eldUnit(120));
    vi.advanceTimersByTime(ELD_UNIT_MS);
    expect(sink.frames).toHaveLength(1);
  });

  it("keeps aac-lc for a model with no aac-eld talkback evidence that sends aac-eld", async () => {
    const { router } = routerWithFakeSource({ audio: ELD_AUDIO, model: "T8400" });
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-lc");
  });

  it("keeps aac-lc for a model with no aac-eld talkback evidence, without reading the stream", async () => {
    const { router, sink } = routerWithFakeSource({ audio: null, model: "T8400" });
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-lc");
    expect(sink.started).toEqual([0]);
  });

  it("opens aac-lc for a device with no loaded record", async () => {
    const { router } = routerWithFakeSource({ audio: ELD_AUDIO, model: null });
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-lc");
  });

  it("reads the camera's own model, not its station's", async () => {
    const { router } = routerWithFakeSource({ audio: ELD_AUDIO, parentSn: "T8010P0000000000" });
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-eld");
  });

  it("opens aac-lc for a camera that sends aac-lc", async () => {
    const { router } = routerWithFakeSource();
    const talk = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(talk.codec).toBe("aac-lc");
  });

  it("starts the codec wait on the first frame, so a cold source's late aac-eld audio is still read", async () => {
    const { router, consumer } = routerWithFakeSource({ audio: null });
    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await vi.advanceTimersByTimeAsync(5000);
    consumer.emit("video", { data: Buffer.alloc(8), keyframe: true });
    await vi.advanceTimersByTimeAsync(1000);
    consumer.emit("audio", ELD_AUDIO);
    const talk = await opening;
    expect(talk.codec).toBe("aac-eld");
  });

  it("refuses a talkback whose source ends before any frame", async () => {
    const { router, sink, consumer } = routerWithFakeSource({ audio: null });
    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await vi.advanceTimersByTimeAsync(20_000);
    consumer.emit("stop");
    await expect(opening).rejects.toThrow(/closed while/);
    expect(sink.started).toEqual([]);
  });

  it("opens aac-lc when the stream carries no audio within the wait", async () => {
    const { router, sink, consumer } = routerWithFakeSource({ audio: null });
    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await vi.advanceTimersByTimeAsync(0);
    consumer.emit("video", { data: Buffer.alloc(8), keyframe: true });
    await vi.advanceTimersByTimeAsync(3000);
    const talk = await opening;
    expect(talk.codec).toBe("aac-lc");
    expect(sink.started).toEqual([0]);
  });

  it("refuses a talkback whose media session ends while the codec is read", async () => {
    const { router, sink, consumer } = routerWithFakeSource({ audio: null });
    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await settle();
    consumer.emit("stop");
    await expect(opening).rejects.toThrow(/closed while/);
    expect(sink.started).toEqual([]);
    expect(consumer.stop).toHaveBeenCalled();
  });

  it("refuses a talkback closed while the codec is read before any frame arrives", async () => {
    const { router, sink } = routerWithFakeSource({ audio: null });
    const opening = router.mediaProviderFor("T8000P0000000000").talkback!();
    await vi.advanceTimersByTimeAsync(0);
    router.closeAll();
    await expect(opening).rejects.toThrow(/closed while/);
    expect(sink.started).toEqual([]);
  });

  it("refuses an AacEncoder on a camera that plays aac-eld, before the speaker path opens", async () => {
    const { router, sink, consumer } = routerWithFakeSource({ audio: ELD_AUDIO });
    await expect(
      router.mediaProviderFor("T8000P0000000000").talkback!({ encoder: { encode: async () => [] } }),
    ).rejects.toThrow(/AacEncoder produces aac-lc/);
    expect(sink.started).toEqual([]);
    expect(consumer.stop).toHaveBeenCalled();

    const again = await router.mediaProviderFor("T8000P0000000000").talkback!();
    expect(again.codec).toBe("aac-eld");
  });
});
