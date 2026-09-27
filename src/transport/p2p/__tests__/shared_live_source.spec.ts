import { EventEmitter } from "node:events";
import { SharedLiveSource, type SharedLiveSourceOptions } from "../shared-live-source.js";
import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/** Fake LiveStream: counts start/stop/nudge, lets a test push video/audio + emit stop/error. */
class FakeStream extends EventEmitter implements LiveStreamHandle {
  started = 0;
  stopped = 0;
  nudged = 0;
  start(): this {
    this.started++;
    return this;
  }
  stop(): void {
    this.stopped++;
  }
  nudge(): void {
    this.nudged++;
  }
  video(frame: LiveVideoFrame) {
    this.emit("video", frame);
  }
  audio(frame: LiveAudioFrame) {
    this.emit("audio", frame);
  }
}

function frame(keyframe: boolean, byte = keyframe ? 0x67 : 0x41): LiveVideoFrame {
  return { keyframe, width: 960, height: 540, codec: "h264", data: Buffer.from([0, 0, 0, 1, byte]) };
}

/** Build a source + capture the streams it makes so a test can drive the upstream. */
function mk(opts: Partial<Omit<SharedLiveSourceOptions, "makeStream">> = {}) {
  const streams: FakeStream[] = [];
  const source = new SharedLiveSource({
    makeStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    lingerMs: 5000,
    ...opts,
  });
  return { source, streams, last: () => streams[streams.length - 1] };
}

describe("SharedLiveSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("warms exactly ONE stream for two attaches", () => {
    const { source, streams } = mk();
    source.attach();
    source.attach();
    expect(streams).toHaveLength(1);
    expect(streams[0].started).toBe(1);
    expect(source.consumerCount).toBe(2);
  });

  it("delivers the source-captured arrival time with live media", () => {
    const { source, last } = mk();
    const consumer = source.attach();
    const timestamps: number[] = [];
    consumer.onMedia((item) => timestamps.push(item.timestampMs));
    vi.setSystemTime(1234);
    last().video(frame(true));
    expect(timestamps).toEqual([1234]);
  });

  it("lingers then stops when the last consumer detaches", () => {
    const { source, last } = mk();
    const a = source.attach();
    const b = source.attach();
    a.detach();
    expect(last().stopped).toBe(0); // still one consumer
    b.detach();
    expect(source.state).toBe("lingering");
    expect(last().stopped).toBe(0); // linger grace not elapsed
    vi.advanceTimersByTime(5000);
    expect(last().stopped).toBe(1);
    expect(source.state).toBe("stopped");
  });

  it("re-attach inside the linger window reuses the warm stream (no new start/stop)", () => {
    const { source, streams, last } = mk();
    const a = source.attach();
    a.detach();
    expect(source.state).toBe("lingering");
    vi.advanceTimersByTime(2000);
    source.attach(); // re-attach before linger fires
    vi.advanceTimersByTime(5000);
    expect(streams).toHaveLength(1);
    expect(last().stopped).toBe(0);
  });

  it("keyframe-primes a late joiner with the cached IDR when it subscribes", async () => {
    const { source, last } = mk();
    source.attach();
    last().video(frame(true)); // caches the keyframe
    const b = source.attach();
    expect(b.primed).toBe(true);
    const got: LiveVideoFrame[] = [];
    b.on("video", (f) => got.push(f)); // subscribing triggers the staged prime
    await Promise.resolve(); // let the queued microtask deliver the primed keyframe
    expect(got).toHaveLength(1);
    expect(got[0].keyframe).toBe(true);
  });

  it("delivers the prime even when the listener attaches a full tick after attach() (async join)", async () => {
    const { source, last } = mk();
    source.attach();
    last().video(frame(true));
    const b = source.attach();
    // Simulate the real async live() gap: several ticks pass before the caller subscribes.
    await Promise.resolve();
    await Promise.resolve();
    const got: LiveVideoFrame[] = [];
    b.on("video", (f) => got.push(f));
    await Promise.resolve();
    expect(got[0]?.keyframe).toBe(true); // the cached IDR was NOT lost to a premature microtask
  });

  it("fans one upstream frame to every consumer", () => {
    const { source, last } = mk();
    const a = source.attach();
    const b = source.attach();
    const ga: LiveVideoFrame[] = [];
    const gb: LiveVideoFrame[] = [];
    a.on("video", (f) => ga.push(f));
    b.on("video", (f) => gb.push(f));
    last().video(frame(true));
    expect(ga).toHaveLength(1);
    expect(gb).toHaveLength(1);
  });

  it("drops-to-keyframe on a slow (paused) consumer without stalling peers", () => {
    const { source, last } = mk({ maxQueue: 3 });
    const slow = source.attach();
    const fast = source.attach();
    const sg: LiveVideoFrame[] = [];
    const fg: LiveVideoFrame[] = [];
    slow.on("video", (f) => sg.push(f));
    fast.on("video", (f) => fg.push(f));
    slow.pause();
    last().video(frame(true));
    for (let i = 0; i < 6; i++) last().video(frame(false)); // overflow the slow queue
    expect(fg.length).toBe(7); // fast peer unaffected
    expect(slow.awaitingKeyframe).toBe(true); // slow consumer resyncing
    // slow consumer drops deltas until the next keyframe, even after resume
    slow.resume();
    last().video(frame(false));
    const before = sg.length;
    last().video(frame(true)); // resync point
    last().video(frame(false));
    expect(sg.length).toBeGreaterThan(before);
    expect(sg[sg.length - 2].keyframe).toBe(true);
  });

  it("keeps the backlog queued when the sink re-pauses inside its own drain", () => {
    const { source, last } = mk({ maxQueue: 10 });
    const consumer = source.attach();
    const got: LiveVideoFrame[] = [];
    consumer.on("video", (f) => {
      got.push(f);
      consumer.pause();
    });
    consumer.pause();
    last().video(frame(true));
    for (let i = 0; i < 4; i++) last().video(frame(false));

    consumer.resume();

    expect(got).toHaveLength(1);
    consumer.resume();
    expect(got).toHaveLength(2);
  });

  it("drops a re-paused sink's stale backlog to the next keyframe instead of replaying it", () => {
    const { source, last } = mk({ maxQueue: 3 });
    const consumer = source.attach();
    const got: LiveVideoFrame[] = [];
    consumer.on("video", (f) => {
      got.push(f);
      consumer.pause();
    });
    consumer.pause();
    last().video(frame(true));
    for (let i = 0; i < 2; i++) last().video(frame(false));

    consumer.resume();
    expect(got).toHaveLength(1);
    for (let i = 0; i < 3; i++) last().video(frame(false));
    expect(consumer.awaitingKeyframe).toBe(true);

    consumer.resume();
    last().video(frame(false));
    expect(got).toHaveLength(1);
    last().video(frame(true));
    expect(got).toHaveLength(2);
    expect(got[1].keyframe).toBe(true);
  });

  it("warm-retry nudges the stream until a frame arrives, then stops", () => {
    const { source, last } = mk({ warmRetryMs: 2000, warmTimeoutMs: 20000 });
    source.attach();
    expect(last().started).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(last().nudged).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(last().nudged).toBe(2);
    last().video(frame(true));
    const at = last().nudged;
    vi.advanceTimersByTime(6000);
    expect(last().nudged).toBe(at);
  });

  it("stalls: emits error to consumers and tears down when no keyframe arrives in the warm window", () => {
    const { source, last } = mk({ warmRetryMs: 2000, warmTimeoutMs: 6000 });
    const c = source.attach();
    let err: Error | undefined;
    c.on("error", (e) => (err = e));
    vi.advanceTimersByTime(6000);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/failed to start/);
    expect(last().stopped).toBe(1);
    expect(source.state).toBe("stopped");
  });

  it("wired source never emits a budget notice and streams unbounded", () => {
    const { source, last } = mk({ powered: "wired", batteryBudgetMs: 5000 });
    const c = source.attach();
    let budgeted = false;
    c.on("budget", () => (budgeted = true));
    last().video(frame(true)); // warmed
    vi.advanceTimersByTime(60000);
    expect(budgeted).toBe(false);
    expect(last().stopped).toBe(0); // still streaming
  });

  it("starts a budget when an already-live source changes from always-on to battery", () => {
    const { source, last } = mk({ powered: "wired", batteryBudgetMs: 5000, budgetGraceMs: 1000 });
    const consumer = source.attach();
    let notices = 0;
    consumer.on("budget", () => notices++);
    last().video(frame(true));
    vi.advanceTimersByTime(5000);
    expect(notices).toBe(0);
    source.setPowerTier("battery");
    vi.advanceTimersByTime(4999);
    expect(notices).toBe(0);
    vi.advanceTimersByTime(1);
    expect(notices).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(last().stopped).toBe(1);
  });

  it("cancels a pending battery stop when an active source becomes always-on", () => {
    const { source, last } = mk({ powered: "battery", batteryBudgetMs: 5000, budgetGraceMs: 1000 });
    const consumer = source.attach();
    let notice: { extend: (ms?: number) => void } | undefined;
    consumer.on("budget", (next) => (notice = next));
    last().video(frame(true));
    vi.advanceTimersByTime(5000);
    expect(notice).toBeDefined();
    source.setPowerTier("wired");
    notice?.extend();
    vi.advanceTimersByTime(20000);
    expect(last().stopped).toBe(0);
  });

  it("battery source emits a budget notice after the budget, then auto-stops without extend", () => {
    const { source, last } = mk({ powered: "battery", batteryBudgetMs: 45000, budgetGraceMs: 10000 });
    const c = source.attach();
    let notice: any;
    let ended = false;
    c.on("budget", (n) => (notice = n));
    c.on("stop", () => (ended = true));
    last().video(frame(true)); // warmed → budget armed
    vi.advanceTimersByTime(45000);
    expect(notice).toBeDefined();
    expect(notice.graceMs).toBe(10000);
    expect(ended).toBe(false); // grace still open
    vi.advanceTimersByTime(10000); // no extend → auto-stop
    expect(ended).toBe(true);
    expect(last().stopped).toBe(1);
    expect(source.state).toBe("stopped");
  });

  it("extend() re-pushes the battery budget and cancels the auto-stop", () => {
    const { source, last } = mk({ powered: "battery", batteryBudgetMs: 45000, budgetGraceMs: 10000 });
    const c = source.attach();
    let extendCount = 0;
    c.on("budget", (n) => {
      if (extendCount++ === 0) n.extend(); // extend the first budget only
    });
    last().video(frame(true));
    vi.advanceTimersByTime(45000); // budget fires → extend() in handler
    vi.advanceTimersByTime(10000); // grace would have elapsed, but extend cancelled it
    expect(last().stopped).toBe(0); // still streaming
    expect(source.state).toBe("live");
    vi.advanceTimersByTime(45000); // budget fires again (re-pushed) — no extend now
    vi.advanceTimersByTime(10000); // grace → auto-stop
    expect(last().stopped).toBe(1);
    expect(extendCount).toBe(2);
  });

  it("dispose stops the stream and ends consumers", () => {
    const { source, last } = mk();
    const a = source.attach();
    let ended = false;
    a.on("stop", () => (ended = true));
    source.dispose();
    expect(last().stopped).toBe(1);
    expect(ended).toBe(true);
    expect(source.state).toBe("stopped");
  });

  it("surfaces an upstream stop to consumers and tears down", () => {
    const { source, last } = mk();
    const a = source.attach();
    let ended = false;
    a.on("stop", () => (ended = true));
    last().video(frame(true));
    last().emit("stop");
    expect(ended).toBe(true);
    expect(source.state).toBe("stopped");
  });
});

describe("SharedLiveSource ring buffer (V5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retains a keyframe-aligned window and drains decodable", () => {
    const { source, last } = mk({ preBufferSeconds: 10 });
    source.attach();
    last().video(frame(true));
    last().video(frame(false));
    last().video(frame(false));
    const drained = source.ringBuffer(10);
    expect(drained[0].keyframe).toBe(true); // opens on a keyframe
    expect(drained.length).toBe(3);
  });

  it("is empty when pre-buffer is off", () => {
    const { source, last } = mk();
    source.attach();
    last().video(frame(true));
    expect(source.ringBuffer(10)).toHaveLength(0);
  });

  it("atomically attaches with timestamped audio and keyframe-aligned video", async () => {
    const { source, last } = mk({ preBufferSeconds: 10 });
    source.attach();
    vi.setSystemTime(1000);
    last().video(frame(true, 0x67));
    vi.setSystemTime(1064);
    last().audio({ codec: "aac-lc", data: Buffer.from([0xff, 0xf1]) });
    vi.setSystemTime(1128);
    last().video(frame(false, 0x41));

    const { consumer, buffered } = source.attachWithPrebuffer(10);
    expect(buffered.map((item) => [item.kind, item.timestampMs])).toEqual([
      ["video", 1000],
      ["audio", 1064],
      ["video", 1128],
    ]);

    const live: LiveVideoFrame[] = [];
    consumer.on("video", (item) => live.push(item));
    await Promise.resolve();
    expect(live).toHaveLength(0);
  });
});
