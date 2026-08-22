import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fakeFfmpeg,
  H264,
  nalTypes,
  streamFactory,
  unit,
  videoFrame,
  type FfmpegOutcome,
} from "./live-source-fixtures.js";

/**
 * `snapshotLive` must hand the decoder a burst it can decode alone. A decoder given slices whose SPS/PPS
 * were announced earlier in the stream refuses them with `non-existing PPS 0 referenced`, and a collected
 * burst routinely starts after the only announcement — the first keyframe is skipped by default, and a
 * consumer joining a warm source never saw it.
 *
 * `../ffmpeg.js` is mocked so the exact bytes handed to the decoder are observable. Asserting only the
 * resolved image would not pin this: a burst that happens to carry its own parameter sets decodes with or
 * without priming, so the property under test is the bytes, not the outcome.
 */
const { sps: SPS, pps: PPS, idr: IDR } = H264;

/** A minimal JPEG: the SOI marker is all the decode path validates. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let outcome: FfmpegOutcome = { stdout: JPEG };
const ffmpeg = fakeFfmpeg(() => outcome);

vi.mock("../../ffmpeg.js", () => ({ spawnFfmpeg: (args: string[]) => ffmpeg.spawnFfmpeg(args) }));

const { captureSnapshotFromShared } = await import("../media.js");
const { SharedLiveSource } = await import("../shared-live-source.js");
const { LiveSnapshotUnavailableError } = await import("../../../core/contracts.js");

const frame = (data: Buffer, over = {}) => videoFrame(data, over);

/** A source already warm with a watcher, as a snapshot normally finds it. */
function warmSource() {
  const { makeStream, streams } = streamFactory();
  const source = new SharedLiveSource({ makeStream });
  const watcher = source.attach();
  return { source, stream: streams[0], watcher };
}

/** The bytes the decoder was handed on run `n`. */
const decodedAt = (n: number) => ffmpeg.runs[n].stdin;
const argvAt = (n: number) => ffmpeg.runs[n].args;

describe("captureSnapshotFromShared — decoder priming", () => {
  beforeEach(() => {
    ffmpeg.runs.length = 0;
    outcome = { stdout: JPEG };
  });

  it("primes a burst whose parameter sets were announced before it with those sets", async () => {
    const { source, stream, watcher } = warmSource();
    const announcement = frame(unit(SPS, PPS, IDR));
    const bareIdr = frame(unit(IDR));
    stream.video(announcement);
    stream.video(bareIdr);

    const snapshot = await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(snapshot.jpeg).toEqual(JPEG);
    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("primes a burst that carries only an SPS — the literal missing-PPS case", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));
    const spsOnly = frame(unit(SPS, IDR));
    stream.video(spsOnly);

    await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x67, 0x65]);
    watcher.detach();
  });

  it("re-announces sets a self-contained burst already carried, which a decoder ignores", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("never substitutes another codec's parameter sets for the burst's own", async () => {
    const { source, stream, watcher } = warmSource();
    const h264Announcement = frame(unit(SPS, PPS, IDR));
    const h265BareIdr = {
      keyframe: true,
      width: 1920,
      height: 1080,
      codec: "h265" as const,
      data: unit([0x26, 0x01, 0xaf]),
    };
    stream.video(h264Announcement);
    stream.video(h265BareIdr);

    await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(nalTypes(decodedAt(0))).toEqual([0x26]);
    watcher.detach();
  });

  it("pins the JPEG-range pixel format, which the encoder requires regardless of negotiation", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    await captureSnapshotFromShared(source, { timeoutMs: 1000 });

    expect(argvAt(0)).toContain("yuvj420p");
    expect(argvAt(0).indexOf("-pix_fmt")).toBe(argvAt(0).indexOf("yuvj420p") - 1);
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
    ffmpeg.runs.length = 0;
    outcome = { stdout: JPEG };
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
    const { source, watcher } = warmSource();

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
