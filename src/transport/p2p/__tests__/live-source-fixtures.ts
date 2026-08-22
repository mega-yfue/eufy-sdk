import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { splitAnnexbNals } from "../annexb.js";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * Shared fixtures for the shared-live-source specs — a fake upstream stream, the source factory that
 * collects the streams it builds, and Annex-B builders.
 *
 * Every spec around `SharedLiveSource` needs the same three things: something satisfying
 * {@link LiveStreamHandle} that a test can push frames into, a `makeStream` that records what was built
 * (so "one pull for N consumers" and "rebuilt after teardown" are checkable), and a way to synthesize an
 * access unit. Kept here rather than per spec so they cannot drift from each other or from the real
 * shapes — the same reason `ff09-test-fixtures.ts` exists.
 */

/** A fake upstream stream: counts lifecycle calls and lets a spec emit frames on demand. */
export class FakeStream extends EventEmitter implements LiveStreamHandle {
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

  /** Emit one video frame to the source. */
  video(frame: LiveVideoFrame): void {
    this.emit("video", frame);
  }
}

/**
 * A `makeStream` factory plus the array it fills. `streams.length` is the number of PULLS a source has
 * opened, which is what distinguishes sharing one stream from opening several.
 */
export function streamFactory(): { makeStream: () => FakeStream; streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  return {
    streams,
    makeStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };
}

/** The 4-byte Annex-B start code, as a real stream emits it. */
export const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** H.264 NAL bodies by type: SPS 7, PPS 8, IDR 5, non-IDR slice 1. */
export const H264 = {
  sps: [0x67, 0x42, 0x00],
  pps: [0x68, 0xce, 0x01],
  idr: [0x65, 0x88, 0x84],
  delta: [0x41, 0x9a, 0x02],
} as const;

/** H.265 NAL bodies by type: VPS 32, SPS 33, PPS 34, IDR 19. */
export const H265 = {
  vps: [0x40, 0x01, 0x0c],
  sps: [0x42, 0x01, 0x01],
  pps: [0x44, 0x01, 0xc1],
  idr: [0x26, 0x01, 0xaf],
} as const;

/** Build an Annex-B access unit from NAL bodies, each with a start code. */
export function unit(...nals: readonly (readonly number[])[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [START_CODE, Buffer.from(nal)]));
}

/** A video frame carrying `data`. Defaults to a 1920x1080 H.264 keyframe. */
export function videoFrame(data: Buffer, over: Partial<LiveVideoFrame> = {}): LiveVideoFrame {
  return { keyframe: true, width: 1920, height: 1080, codec: "h264", data, ...over };
}

/**
 * The NAL type byte of every NAL in a buffer, in order — the shape assertion for "what did the decoder
 * receive". Reads the stream through {@link splitAnnexbNals}, the module under test's own scan, rather
 * than a second hand-rolled start-code walk per spec.
 */
export function nalTypes(buf: Buffer): number[] {
  return splitAnnexbNals(buf).map((nal) => nal[0]);
}

/** What a faked ffmpeg run should do with the bytes it was given. */
export type FfmpegOutcome = { stdout: Buffer } | { exitCode: number; stderr: string } | { spawnError: string };

/**
 * A `vi.mock` factory body for `../../ffmpeg.js` that records each spawn's argv and stdin, and answers
 * with whatever `outcome()` says at the time it is called.
 *
 * The media specs all need the same thing — the exact bytes handed to ffmpeg, because asserting only the
 * returned image passes even with the code under test removed. `outcome` is a getter rather than a value
 * so a spec can change the answer per case without re-mocking the module.
 */
export function fakeFfmpeg(outcome: () => FfmpegOutcome): {
  spawnFfmpeg: (args: string[]) => unknown;
  runs: { args: string[]; stdin: Buffer }[];
} {
  const runs: { args: string[]; stdin: Buffer }[] = [];
  return {
    runs,
    spawnFfmpeg: (args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      const chunks: Buffer[] = [];
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk as Buffer);
          cb();
        },
        final(cb) {
          runs.push({ args, stdin: Buffer.concat(chunks) });
          const answer = outcome();
          queueMicrotask(() => {
            if ("spawnError" in answer) return child.emit("error", new Error(answer.spawnError));
            if ("stdout" in answer) child.stdout.emit("data", answer.stdout);
            else child.stderr.emit("data", Buffer.from(answer.stderr));
            child.emit("close", "stdout" in answer ? 0 : answer.exitCode);
          });
          cb();
        },
      });
      return child;
    },
  };
}
