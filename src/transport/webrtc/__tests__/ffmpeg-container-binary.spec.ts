import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The container mux is selected by an availability probe, so the probe has to be asked about the SAME
 * binary the mux will run. Probing the bare name while the mux runs a host-supplied path is not a
 * cosmetic mismatch: the gate answers "no ffmpeg", `makeWriter` silently writes a raw elementary
 * stream, and the caller gets a file that is not the container it asked for. `../../ffmpeg.js` is
 * mocked so the probe's argument is observable and no real binary is needed.
 */
type FakeChild = EventEmitter & {
  stdin: { on: () => void; destroyed: boolean; write: () => void; end: () => void };
};

const probedWith: (string | undefined)[] = [];
const spawnedWith: { executable?: string }[] = [];
let probeAnswer = true;

vi.mock("../../ffmpeg.js", () => ({
  ffmpegAvailable: vi.fn((executable?: string) => {
    probedWith.push(executable);
    return probeAnswer;
  }),
  spawnFfmpeg: vi.fn((_args: string[], opts: { executable?: string }) => {
    spawnedWith.push({ executable: opts.executable });
    const child = new EventEmitter() as FakeChild;
    child.stdin = {
      on: () => {},
      destroyed: false,
      write: () => {},
      end: () => queueMicrotask(() => child.emit("close")),
    };
    return child;
  }),
}));

const { createWebRtcPeer } = await import("../peer.js");

/** `makeWriter` is the private seam the gate lives on; the returned handle is the concrete peer. */
async function writerFor(opts: Record<string, unknown>) {
  const peer = await createWebRtcPeer(opts);
  try {
    (peer as unknown as { makeWriter: (kind: string, codec: string) => unknown }).makeWriter("video", "h264");
  } finally {
    await peer.close();
  }
}

describe("WebRTC container mux — binary resolution", () => {
  beforeEach(() => {
    probedWith.length = 0;
    spawnedWith.length = 0;
    probeAnswer = true;
  });

  it("probes the executable the caller supplied, not the bare name", async () => {
    await writerFor({ outputPath: "/tmp/out.mp4", ffmpegPath: "/opt/host/bin/ffmpeg" });
    expect(probedWith).toEqual(["/opt/host/bin/ffmpeg"]);
  });

  it("muxes with the same executable it probed", async () => {
    await writerFor({ outputPath: "/tmp/out.mp4", ffmpegPath: "/opt/host/bin/ffmpeg" });
    expect(spawnedWith[0].executable).toBe("/opt/host/bin/ffmpeg");
  });

  it("probes nothing in particular when the caller supplied nothing", async () => {
    await writerFor({ outputPath: "/tmp/out.mp4" });
    expect(probedWith).toEqual([undefined]);
  });

  it("still falls back to the raw stream when that executable is not runnable", async () => {
    probeAnswer = false;
    await writerFor({ outputPath: "/tmp/out.mp4", ffmpegPath: "/opt/host/bin/ffmpeg" });
    expect(spawnedWith).toEqual([]);
  });
});
