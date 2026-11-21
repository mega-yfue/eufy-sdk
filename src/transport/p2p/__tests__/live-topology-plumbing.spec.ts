import { describe, expect, it, vi } from "vitest";
import { LIVE_FRAMES } from "./live-source-fixtures.js";

/**
 * The live leg must hand `LiveStream` the resolved channel AND the topology, because together they are
 * what arms the per-camera frame filter.
 *
 * `LiveStream` sets its `mediaChannel` — the tag inbound media must match — only when BOTH
 * `homeBaseAttached` is true and `channel` is defined. Lose either on the way from `resolveSession` to
 * the constructor and the filter silently disarms: every handle on the session then takes every
 * camera's frames, and a caller asking for one camera is handed another's picture with no error and no
 * gap in the feed. That is the failure `live-sibling-channel.spec.ts` exists to prevent — but that spec
 * constructs `LiveStream` directly with an explicit channel, so it cannot see a value lost upstream of
 * it. Observed on real hardware: two cameras on one station, 54 frames tagged channel 0 and 3 tagged
 * channel 4, and both handles delivered all 57.
 *
 * `record` already has this cover in `media-opts-plumbing.spec.ts`. The live leg did not, which is the
 * leg where the filter lives.
 */
const liveStreamOpts: Record<string, unknown>[] = [];

vi.mock("../live-stream.js", () => ({
  LiveStream: class {
    constructor(_session: unknown, opts: Record<string, unknown>) {
      liveStreamOpts.push(opts);
    }
    on() {
      return this;
    }
    off() {
      return this;
    }
    start() {
      return this;
    }
    stop() {}
    removeAllListeners() {}
  },
}));

const { P2PCommandRouter } = await import("../command-router.js");

const SN = "T8000P0000000000";
const STATION_SN = "T8000P0000000001";
const CAMERA_CHANNEL = 4;

/** A router whose session resolution is stubbed to the topology under test. */
function routerWith(homeBaseAttached: boolean, channel: number) {
  const router = new P2PCommandRouter({
    liveFramesFor: () => LIVE_FRAMES,
    mega: {} as never,
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
    parentSn: homeBaseAttached ? STATION_SN : SN,
    channel,
    accountId: "",
    homeBaseAttached,
  });
  return router;
}

/** Build the shared source and warm it, so the `makeStream` factory actually runs. */
async function optsForLiveStream(homeBaseAttached: boolean, channel: number) {
  liveStreamOpts.length = 0;
  const source = await routerWith(homeBaseAttached, channel).sharedLiveSourceFor(SN, {});
  source.attach();
  return liveStreamOpts[0];
}

describe("the live leg arms the per-camera filter", () => {
  it("hands an attached camera both its channel and its topology", async () => {
    const opts = await optsForLiveStream(true, CAMERA_CHANNEL);
    expect(opts?.homeBaseAttached).toBe(true);
    expect(opts?.channel).toBe(CAMERA_CHANNEL);
  });

  it("hands an own-session camera its topology, so the filter stays off where the tag is unreliable", async () => {
    const opts = await optsForLiveStream(false, 0);
    expect(opts?.homeBaseAttached).toBe(false);
  });

  it("never drops the channel to undefined, which would disarm the filter on an attached camera", async () => {
    const opts = await optsForLiveStream(true, 0);
    expect(opts?.channel).toBeDefined();
    expect(opts?.channel).toBe(0);
  });
});
