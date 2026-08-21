import { describe, expect, it, vi } from "vitest";

/**
 * The `ffmpegPath` a host configures has to reach the actual spawn, through every media egress that
 * shells out. A host with no `ffmpeg` on `PATH` is the case the option exists for, so a leg that
 * silently keeps the bare name is not a cosmetic gap — that egress is simply unavailable on that host.
 * `../media.js` is mocked to capture what the router hands each media call.
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

function routerWith(ffmpegPath?: string) {
  const router = new P2PCommandRouter({
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
    channel: 0,
    accountId: "",
    homeBaseAttached: false,
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
