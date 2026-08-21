import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SharedLiveSource } from "../shared-live-source.js";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * A live start that never delivers a frame is reported to consumers and the stream is torn down, but the
 * source is rebuildable in place — so the next attach builds another stream over the SAME underlying
 * session. When it is that session (or its per-device state) that has gone bad, every later attempt fails
 * the same way and only a client restart clears it. The source cannot fix that itself: it holds a stream
 * factory, not a session. It has to say that a start failed, so whoever owns the session can act.
 */
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
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

function frame(): LiveVideoFrame {
  return { keyframe: true, width: 8, height: 8, codec: "h264", data: Buffer.from([0, 0, 0, 1, 0x67]) };
}

function mk(opts: Record<string, unknown> = {}) {
  const streams: FakeStream[] = [];
  const onStartFailed = vi.fn();
  const onIdle = vi.fn();
  const onActive = vi.fn();
  const source = new SharedLiveSource({
    makeStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    warmRetryMs: 2000,
    warmTimeoutMs: 6000,
    lingerMs: 5000,
    onStartFailed,
    onActive,
    onIdle,
    ...opts,
  });
  return { source, streams, onStartFailed, onActive, onIdle };
}

describe("SharedLiveSource — reporting a failed start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a failed start once the warm window elapses with no frame", () => {
    const { source, onStartFailed } = mk();
    const consumer = source.attach();
    const errors: Error[] = [];
    consumer.on("error", (e) => errors.push(e));

    vi.advanceTimersByTime(6000);

    expect(errors).toHaveLength(1);
    expect(onStartFailed).toHaveBeenCalledTimes(1);
    expect(source.state).toBe("stopped");
  });

  it("tells consumers before reporting it, so the report can dispose the source", () => {
    const order: string[] = [];
    const { source } = mk({ onStartFailed: () => order.push("reported") });
    source.attach().on("error", () => order.push("consumer"));

    vi.advanceTimersByTime(6000);

    expect(order).toEqual(["consumer", "reported"]);
  });

  it("does NOT report an ordinary linger teardown — nothing failed there", () => {
    const { source, onStartFailed, streams } = mk();
    const consumer = source.attach();
    streams[0].video(frame());
    consumer.detach();

    vi.advanceTimersByTime(5000);

    expect(source.state).toBe("stopped");
    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("does NOT report an upstream stop after a healthy start", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach();
    streams[0].video(frame());

    streams[0].emit("stop");

    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("does NOT report a caller's own dispose", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach();
    streams[0].video(frame());

    source.dispose();

    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("releases the session user when disposed while consumers are still attached", () => {
    const { source, onActive, onIdle, streams } = mk();
    source.attach();
    streams[0].video(frame());
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(onIdle).not.toHaveBeenCalled();

    source.dispose();

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not release a session user it never took", () => {
    const { source, onIdle } = mk();
    source.dispose();
    expect(onIdle).not.toHaveBeenCalled();
  });
});
