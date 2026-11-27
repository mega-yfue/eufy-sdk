import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { fakeFfmpeg, H264, START_CODE, LIVE_FRAMES } from "./live-source-fixtures.js";
import type { P2PFrame, P2PSession } from "../p2p-session.js";

/**
 * `record` must always settle.
 *
 * Its clip used to end only inside a `video` handler — on the first frame to arrive at or past the wall clock —
 * so a camera that went quiet mid-clip left the promise pending for the life of the process. This module's own
 * history records exactly that: an own-session camera that stopped 13.6 s into a stream with no `stop` and no
 * `error`. The stream's `error` was swallowed by an empty handler on the same path, so an upstream failure was
 * discarded rather than reported.
 *
 * These specs pin the three ways the call now ends: the window elapsing, the session going away under it, and
 * the stream reporting a failure.
 */
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const ffmpeg = fakeFfmpeg(() => ({ stdout: MP4 }));

vi.mock("../../ffmpeg.js", () => ({ spawnFfmpeg: (args: string[]) => ffmpeg.spawnFfmpeg(args) }));

const { recordClip } = await import("../media.js");

/** Minimal fake session: pushes plaintext video frames, and closes the way a real one does. */
class FakeSession extends EventEmitter {
  startLiveMedia() {}
  stopLiveMedia() {}
  push(nals: readonly (readonly number[])[], keyframe: boolean) {
    const hdr = Buffer.alloc(0x16);
    hdr.writeUInt8(keyframe ? 0x01 : 0x00, 0x04);
    hdr.writeInt16LE(1920, 0x0a);
    hdr.writeInt16LE(1080, 0x0c);
    const body = Buffer.concat(nals.flatMap((n) => [START_CODE, Buffer.from(n)]));
    this.emit("data", { commandId: 1300, channel: 0, signCode: 0, data: Buffer.concat([hdr, body]) } as P2PFrame);
  }
  /** A frame with no payload at all — what the stream reports as its own decode failure. */
  pushUndecodable() {
    this.emit("data", { commandId: 1300, channel: 0, signCode: 0, data: undefined } as unknown as P2PFrame);
  }
  close() {
    this.emit("close");
  }
}

/** A ten-second clip whose collection has begun: the skipped first keyframe, then the one it starts at. */
async function clipUnderWay(): Promise<{ session: FakeSession; clip: Promise<Buffer> }> {
  const { session, clip } = await clipAwaitingKeyframe();
  session.push([H264.sps, H264.pps, H264.idr], true); // skipped: a cold stream's first keyframe is often partial
  session.push([H264.idr], true); // the keyframe the clip starts at
  return { session, clip };
}

/** A clip whose stream is live and listening, before any keyframe has arrived. */
async function clipAwaitingKeyframe(timeoutMs = 20_000): Promise<{ session: FakeSession; clip: Promise<Buffer> }> {
  const session = new FakeSession();
  const clip = recordClip(session as unknown as P2PSession, 10, { frames: LIVE_FRAMES, timeoutMs });
  await vi.advanceTimersByTimeAsync(0); // let the collection attach its listeners to the started stream
  return { session, clip };
}

beforeEach(() => {
  ffmpeg.runs.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("recordClip — a clip that always settles", () => {
  it("closes the clip on its own window when the camera goes quiet mid-clip", async () => {
    const { session, clip } = await clipUnderWay();
    session.push([H264.delta], false);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(ffmpeg.runs, "the window has not elapsed yet — nothing muxed").toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(clip).resolves.toEqual(MP4);
    expect(ffmpeg.runs).toHaveLength(1);
  });

  /** No further frame can arrive on a closed session, so waiting the window out would report nothing useful. */
  it("fails a clip whose session closes before its window elapses", async () => {
    const { session, clip } = await clipUnderWay();
    session.push([H264.delta], false);

    session.close();

    await expect(clip).rejects.toThrow(/session closed 2 frame\(s\) into the clip/);
  });

  it("fails a clip whose session closes before the keyframe it starts at", async () => {
    const { session, clip } = await clipAwaitingKeyframe();

    session.close();

    await expect(clip).rejects.toThrow(/session closed before the keyframe/);
  });

  /** The stream's failure was swallowed by an empty handler, so the clip waited on a stream that had given up. */
  it("reports the stream's own failure instead of discarding it", async () => {
    const { session, clip } = await clipUnderWay();

    session.pushUndecodable();

    await expect(clip).rejects.toThrow(/the stream failed during the clip/);
  });

  it("still bounds the wait for the keyframe the clip starts at", async () => {
    const { clip } = await clipAwaitingKeyframe(1_000);
    const settled = expect(clip).rejects.toThrow(/timeout waiting for a clean keyframe/);

    await vi.advanceTimersByTimeAsync(1_500);

    await settled;
  });
});
