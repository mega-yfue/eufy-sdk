import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * `snapshotLive` intermittently failed with `non-existing PPS 0 referenced` on cameras whose live burst
 * otherwise works: the collected burst began after the stream's parameter sets, so the decoder had no
 * SPS/PPS for its first slices. Whether it happens on a given attempt is pure framing luck, which is
 * why the same camera alternates between a still and a failure.
 *
 * `../ffmpeg.js` is mocked so the exact bytes handed to the decoder are observable — a spec that only
 * asserts the resolved image would pass with the priming dropped, because a burst that HAPPENS to carry
 * its own parameter sets decodes either way. That is the defect itself.
 */
const START = Buffer.from([0, 0, 0, 1]);
const SPS = [0x67, 0x42, 0x00];
const PPS = [0x68, 0xce, 0x01];
const IDR = [0x65, 0x88, 0x84];

function unit(...nals: number[][]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [START, Buffer.from(n)]));
}

/** A minimal JPEG: the SOI marker is all the decode path validates. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

type Outcome = { jpeg: Buffer } | { exitCode: number; stderr: string } | { spawnError: string };
let outcome: Outcome = { jpeg: JPEG };
const decoded: Buffer[] = [];

vi.mock("../../ffmpeg.js", () => ({
  spawnFfmpeg: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    const chunks: Buffer[] = [];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
      final(cb) {
        decoded.push(Buffer.concat(chunks));
        queueMicrotask(() => {
          if ("spawnError" in outcome) return child.emit("error", new Error(outcome.spawnError));
          if ("jpeg" in outcome) child.stdout.emit("data", outcome.jpeg);
          else child.stderr.emit("data", Buffer.from(outcome.stderr));
          child.emit("close", "jpeg" in outcome ? 0 : outcome.exitCode);
        });
        cb();
      },
    });
    return child;
  }),
}));

const { captureSnapshotFromShared } = await import("../media.js");
const { SharedLiveSource } = await import("../shared-live-source.js");
const { LiveSnapshotUnavailableError } = await import("../../../core/contracts.js");

class FakeStream extends EventEmitter implements LiveStreamHandle {
  start(): this {
    return this;
  }
  stop(): void {}
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

function frame(data: Buffer, keyframe = true): LiveVideoFrame {
  return { keyframe, width: 1920, height: 1080, codec: "h264", data };
}

/** A source already warm with a watcher, as a snapshot normally finds it. */
function warmSource() {
  const streams: FakeStream[] = [];
  const source = new SharedLiveSource({
    makeStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
  });
  const watcher = source.attach();
  return { source, stream: streams[0], watcher };
}

/** The NAL type byte of each NAL, so the decoder's input can be asserted by shape. */
function nalTypes(buf: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) types.push(buf[i + 4]);
  }
  return types;
}

describe("captureSnapshotFromShared — decoder priming", () => {
  beforeEach(() => {
    decoded.length = 0;
    outcome = { jpeg: JPEG };
  });

  it("primes a burst whose parameter sets were announced before it with those sets", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR))); // stream start announces the sets, then they never repeat
    stream.video(frame(unit(IDR))); // the cached prime a joining snapshot receives: a BARE IDR

    const snapshot = await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(snapshot.jpeg).toEqual(JPEG);
    expect(nalTypes(decoded[0])).toEqual([0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("leaves a self-contained burst exactly as collected", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(nalTypes(decoded[0])).toEqual([0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("reports the still's dimensions from the frame, not the primed bytes", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));
    stream.video(frame(unit(IDR)));

    const snapshot = await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(snapshot).toMatchObject({ width: 1920, height: 1080 });
    watcher.detach();
  });
});

describe("captureSnapshotFromShared — typed reasons", () => {
  beforeEach(() => {
    decoded.length = 0;
    outcome = { jpeg: JPEG };
  });

  it("calls a burst the decoder refused retryable, so a rate-limited caller tries again", async () => {
    outcome = { exitCode: 69, stderr: "[h264 @ 0x0] non-existing PPS 0 referenced" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const error = await captureSnapshotFromShared(source, { timeoutMs: 1000 }).catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("undecodable-burst");
    expect(error.retryable).toBe(true);
    watcher.detach();
  });

  it("calls an unrunnable decoder NOT retryable — no burst will ever fix a missing binary", async () => {
    outcome = { spawnError: "spawn ffmpeg ENOENT" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const error = await captureSnapshotFromShared(source, { timeoutMs: 1000 }).catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("decoder-unavailable");
    expect(error.retryable).toBe(false);
    watcher.detach();
  });

  it("calls a burst that never arrived retryable, and names that as the reason", async () => {
    const { source, watcher } = warmSource(); // no frames at all

    const error = await captureSnapshotFromShared(source, { timeoutMs: 20 }).catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("no-keyframe");
    expect(error.retryable).toBe(true);
    watcher.detach();
  });

  it("keeps the decoder's own diagnostics on the error, so the cause is not swallowed", async () => {
    outcome = { exitCode: 69, stderr: "[h264 @ 0x0] non-existing PPS 0 referenced" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const error = await captureSnapshotFromShared(source, { timeoutMs: 1000 }).catch((e) => e);

    expect(error.message).toContain("non-existing PPS 0 referenced");
    watcher.detach();
  });
});
