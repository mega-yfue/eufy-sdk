import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * `spawnFfmpeg` binary resolution — `node:child_process` is mocked so no ffmpeg is needed (and none is
 * assumed to exist: the whole point of the option is hosts that have no `ffmpeg` on `PATH`). The spy
 * records the executable and argv of every spawn so the resolution precedence is asserted directly.
 */
type FakeChild = EventEmitter & { stderr: EventEmitter };

const spawnCalls: { file: string; args: string[] }[] = [];
const spawnSyncCalls: { file: string; args: string[] }[] = [];
let spawnSyncStatus = 0;

vi.mock("node:child_process", () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    const child = new EventEmitter() as FakeChild;
    child.stderr = new EventEmitter();
    return child;
  }),
  spawnSync: vi.fn((file: string, args: string[]) => {
    spawnSyncCalls.push({ file, args });
    return { status: spawnSyncStatus };
  }),
}));

const { spawnFfmpeg, ffmpegAvailable } = await import("../ffmpeg.js");

describe("spawnFfmpeg — host-provided binary", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("spawns the bare name when no path is supplied", () => {
    spawnFfmpeg(["-i", "pipe:0"]);
    expect(spawnCalls[0].file).toBe("ffmpeg");
  });

  it("spawns the executable the host supplied", () => {
    spawnFfmpeg(["-i", "pipe:0"], { path: "/opt/host/bin/ffmpeg" });
    expect(spawnCalls[0].file).toBe("/opt/host/bin/ffmpeg");
  });

  it("leaves the argv untouched by the binary choice", () => {
    spawnFfmpeg(["-i", "pipe:0"], { path: "/opt/host/bin/ffmpeg", level: "warning" });
    expect(spawnCalls[0].args).toEqual(["-hide_banner", "-loglevel", "warning", "-i", "pipe:0"]);
  });

  it("falls back to the bare name for an empty or whitespace path", () => {
    spawnFfmpeg([], { path: "" });
    spawnFfmpeg([], { path: "   " });
    expect(spawnCalls.map((c) => c.file)).toEqual(["ffmpeg", "ffmpeg"]);
  });

  it("trims a padded path rather than spawning a name that cannot exist", () => {
    spawnFfmpeg([], { path: "  /opt/host/bin/ffmpeg  " });
    expect(spawnCalls[0].file).toBe("/opt/host/bin/ffmpeg");
  });
});

/**
 * The availability probe has to resolve the SAME executable the spawn will use. Probing the bare name
 * while the mux runs a host-supplied path is how a caller gets told ffmpeg is missing on a host that
 * ships one — and a container egress gated on that answer silently degrades instead of muxing.
 */
describe("ffmpegAvailable", () => {
  beforeEach(() => {
    spawnSyncCalls.length = 0;
    spawnSyncStatus = 0;
  });

  it("probes the bare name when no path is supplied", () => {
    expect(ffmpegAvailable()).toBe(true);
    expect(spawnSyncCalls[0]).toEqual({ file: "ffmpeg", args: ["-version"] });
  });

  it("probes the executable the host supplied", () => {
    expect(ffmpegAvailable("/opt/host/bin/ffmpeg")).toBe(true);
    expect(spawnSyncCalls[0].file).toBe("/opt/host/bin/ffmpeg");
  });

  it("reports unavailable when the probe exits non-zero", () => {
    spawnSyncStatus = 127;
    expect(ffmpegAvailable("/opt/host/bin/ffmpeg")).toBe(false);
  });
});
