import { describe, expect, it, vi } from "vitest";
import { LIVE_FRAMES } from "./live-source-fixtures.js";

/**
 * What the router hands each media egress, and why an omission there is never cosmetic.
 *
 * A media call is only as correct as the context it is given: the `ffmpegPath` a host configured (a host
 * with no `ffmpeg` on `PATH` is the case that option exists for, so a leg that keeps the bare name makes
 * that egress unavailable), and the session TOPOLOGY (`homeBaseAttached`), which decides both how a
 * stream is started and whether it may trust the station's per-camera frame tag. `../media.js` is mocked
 * to capture what the router hands each call.
 */
const snapshotOpts: Record<string, unknown>[] = [];
const recordOpts: Record<string, unknown>[] = [];

vi.mock("../media.js", () => ({
  captureSnapshotFromShared: vi.fn(async (_source: unknown, opts: Record<string, unknown>) => {
    snapshotOpts.push(opts);
    return { jpeg: Buffer.alloc(0), width: 0, height: 0 };
  }),
  recordClip: vi.fn(async (_session: unknown, _seconds: number, opts: Record<string, unknown>) => {
    recordOpts.push(opts);
    return Buffer.alloc(0);
  }),
  openLiveStream: vi.fn(),
}));

const { P2PCommandRouter } = await import("../command-router.js");

const SN = "T8000P0000000000";
const CAMERA_CHANNEL = 2;

function routerWith(ffmpegPath?: string, homeBaseAttached = false) {
  const router = new P2PCommandRouter({
    liveFramesFor: () => LIVE_FRAMES,
    mega: {} as never,
    ffmpegPath,
    listDevices: () => [],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });
  (router as unknown as { resolveSession: unknown }).resolveSession = async () => ({
    session: { on: () => {}, off: () => {} },
    parentSn: SN,
    channel: homeBaseAttached ? CAMERA_CHANNEL : 0,
    accountId: "",
    homeBaseAttached,
  });
  return router;
}

describe("host-provided ffmpeg binary reaches the media egresses", () => {
  it("forwards the configured executable to the live-snapshot decode", async () => {
    snapshotOpts.length = 0;
    await routerWith("/opt/host/bin/ffmpeg").mediaProviderFor(SN).snapshotLive!({});
    expect(snapshotOpts[0].ffmpegPath).toBe("/opt/host/bin/ffmpeg");
  });

  it("forwards the configured executable to the clip mux", async () => {
    recordOpts.length = 0;
    await routerWith("/opt/host/bin/ffmpeg").mediaProviderFor(SN).record!(1, {});
    expect(recordOpts[0].ffmpegPath).toBe("/opt/host/bin/ffmpeg");
  });

  it("passes nothing when the host configured nothing, leaving the PATH lookup in place", async () => {
    snapshotOpts.length = 0;
    await routerWith().mediaProviderFor(SN).snapshotLive!({});
    expect(snapshotOpts[0].ffmpegPath).toBeUndefined();
  });
});

/**
 * The one-shot clip opens its OWN stream rather than joining the shared source, so it is the one media
 * egress that does not inherit the topology through `sharedLiveSourceFor` — and both things that depend
 * on it fail silently when it is missing.
 *
 * Undefined reads as "own-session camera": the start goes out on the `1700`/`cmd 1000` path instead of the
 * level-2 `1003` payload an attached camera needs, and the stream cannot trust the station's per-camera
 * frame tag, so it takes every warm camera's frames on that session and the assembler joins two encoders'
 * units into one clip. Neither failure raises anything — the clip is simply wrong, or never starts.
 */
describe("the clip path receives the session topology it cannot infer", () => {
  it("tells the clip its camera rides a HomeBase session, with the camera's own channel", async () => {
    recordOpts.length = 0;
    await routerWith(undefined, true).mediaProviderFor(SN).record!(1, {});
    expect(recordOpts[0].homeBaseAttached).toBe(true);
    expect(recordOpts[0].channel).toBe(CAMERA_CHANNEL);
  });

  it("tells the clip a camera owns its session, so the start is not sent as a HomeBase payload", async () => {
    recordOpts.length = 0;
    await routerWith().mediaProviderFor(SN).record!(1, {});
    expect(recordOpts[0].homeBaseAttached).toBe(false);
  });
});

/**
 * The option the contract is written against is the CLIENT one — `new EufyMega({ ffmpegPath })`. The
 * router legs above prove the media calls honour what they are handed; this proves the client hands it
 * over at all, which is the single line joining the two and otherwise the easiest thing to omit.
 */
describe("the client-level option reaches the router that owns the media paths", () => {
  it("hands the configured executable to the P2P router", async () => {
    const { EufyMega } = await import("../../../client/eufy-mega.js");
    const eufy = new EufyMega({ email: "user@example.invalid", password: "x", ffmpegPath: "/opt/host/bin/ffmpeg" });
    const deps = (eufy as unknown as { p2p: { deps: { ffmpegPath?: string } } }).p2p.deps;
    expect(deps.ffmpegPath).toBe("/opt/host/bin/ffmpeg");
  });

  it("hands over nothing when unconfigured, so the default PATH lookup stands", async () => {
    const { EufyMega } = await import("../../../client/eufy-mega.js");
    const eufy = new EufyMega({ email: "user@example.invalid", password: "x" });
    const deps = (eufy as unknown as { p2p: { deps: { ffmpegPath?: string } } }).p2p.deps;
    expect(deps.ffmpegPath).toBeUndefined();
  });
});
