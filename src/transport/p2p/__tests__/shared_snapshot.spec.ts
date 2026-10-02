import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { fakeFfmpeg } from "./live-source-fixtures.js";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

class FakeStream extends EventEmitter implements LiveStreamHandle {
  started = 0;
  stopped = 0;
  start(): this {
    this.started++;
    return this;
  }
  stop(): void {
    this.stopped++;
  }
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

const ffmpeg = fakeFfmpeg(() => ({ stderr: "synthetic decode failure", exitCode: 1 }));
let holdDecode = false;
let finishDecode: (() => void) | undefined;

vi.mock("../../ffmpeg.js", () => ({
  spawnFfmpeg: (args: string[]) => {
    const child = ffmpeg.spawnFfmpeg(args) as EventEmitter;
    if (holdDecode) {
      const emit = child.emit.bind(child);
      child.emit = (event, ...values) => {
        if (event === "close") {
          finishDecode = () => {
            emit(event, ...values);
          };
          return true;
        }
        return emit(event, ...values);
      };
    }
    return child;
  },
}));

const { captureSnapshotFromShared } = await import("../media.js");
const { SharedLiveSource } = await import("../shared-live-source.js");

function frame(): LiveVideoFrame {
  // a bogus keyframe — enough to prime; the ffmpeg decode is expected to fail (unit env)
  return { keyframe: true, width: 8, height: 8, codec: "h264", data: Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]) };
}

describe("captureSnapshotFromShared (V6 snapshot as consumer)", () => {
  it("rides a warm, primed source with NO second pull and cleans up its consumer", async () => {
    const streams: FakeStream[] = [];
    const source = new SharedLiveSource({
      makeStream: () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      },
    });
    const watcher = source.attach(); // an existing viewer warms the single pull
    streams[0].video(frame()); // cache a keyframe (V2 prime)
    expect(streams[0].started).toBe(1);

    // Snapshot attaches as a consumer; the primed IDR decodes (ffmpeg fails in unit env → rejects),
    // but the point under test is transport behaviour: no extra pull, consumer released after.
    await expect(captureSnapshotFromShared(source, { timeoutMs: 1000 })).rejects.toBeInstanceOf(Error);

    expect(streams).toHaveLength(1); // ONE pull total — snapshot rode the warm source
    expect(source.consumerCount).toBe(1); // only the original watcher remains
    watcher.detach();
  });

  it("detaches an abandoned capture at once instead of holding the channel to its timeout", async () => {
    const source = new SharedLiveSource({ makeStream: () => new FakeStream() });
    const abandonment = new AbortController();
    const capture = captureSnapshotFromShared(source, { timeoutMs: 60_000, signal: abandonment.signal });
    expect(source.consumerCount).toBe(1);

    const reason = new Error("a live view took the station");
    abandonment.abort(reason);

    await expect(capture).rejects.toBe(reason);
    expect(source.consumerCount).toBe(0);
  });

  /**
   * The station is free before the decode, not after it.
   *
   * A decode works on bytes already collected, so a still that kept its pull attached across it would hold a
   * session that serves one camera at a time — and a still never opens one of its own — for the length of an
   * FFmpeg run — which is a live request refused
   * for a still that had already taken everything it needed.
   */
  it("releases the station as soon as it has collected, without waiting for the decode", async () => {
    const streams: FakeStream[] = [];
    const source = new SharedLiveSource({
      makeStream: () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      },
    });
    const watcher = source.attach();
    streams[0].video(frame());
    const held = source.consumerCount;

    holdDecode = true;
    try {
      let settled = false;
      const capture = captureSnapshotFromShared(source, { timeoutMs: 1000 });
      const failed = expect(
        capture.finally(() => {
          settled = true;
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(source.consumerCount).toBe(held + 1);
      await vi.waitFor(() => expect(finishDecode).toBeDefined());
      expect(settled).toBe(false);
      expect(source.consumerCount, "the station is free while the decode is still running").toBe(held);
      finishDecode!();
      await failed;
    } finally {
      holdDecode = false;
      finishDecode = undefined;
      watcher.detach();
    }
  });

  it("attaches nothing for a capture already abandoned before it starts", async () => {
    const source = new SharedLiveSource({ makeStream: () => new FakeStream() });
    const abandonment = new AbortController();
    abandonment.abort(new Error("a live view took the station"));

    await expect(captureSnapshotFromShared(source, { signal: abandonment.signal })).rejects.toThrow(
      "a live view took the station",
    );
    expect(source.consumerCount).toBe(0);
  });
});
