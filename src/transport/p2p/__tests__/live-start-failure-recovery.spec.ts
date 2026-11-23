import { describe, expect, it, vi } from "vitest";
import { LIVE_FRAMES } from "./live-source-fixtures.js";
import { P2PCommandRouter } from "../command-router.js";

/**
 * The non-recovery this covers: a warm-up timeout fails its consumers but leaves them ATTACHED, and the
 * router only replaced a stopped source when its consumer count had reached zero. A host that keeps its
 * handle after `error` therefore got the same dead source back on every later acquisition, still closing
 * over the session resolved when it was first built — so a camera that stopped delivering frames stayed
 * that way until the client restarted.
 *
 * Two devices: one standalone (its station key is its own serial) and one attached to a HomeBase.
 */
const STANDALONE = "T8000P0000000000";
const ATTACHED = "T8000P0000000001";
const HOMEBASE = "T8000P0000000002";

function routerFor(sn: string) {
  const closed: string[] = [];
  const opened: string[] = [];
  const router = new P2PCommandRouter({
    liveFramesFor: () => LIVE_FRAMES,
    mega: {} as never,
    listDevices: () =>
      [
        { sn: STANDALONE, stationSn: STANDALONE, raw: {} },
        { sn: ATTACHED, stationSn: HOMEBASE, raw: { parent_sn: HOMEBASE } },
      ] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });

  const parentSn = sn === STANDALONE ? STANDALONE : HOMEBASE;
  (router as unknown as { resolveSession: unknown }).resolveSession = async () => {
    opened.push(parentSn);
    return {
      session: { on: () => {}, off: () => {} },
      parentSn,
      channel: 0,
      accountId: "",
      homeBaseAttached: sn !== STANDALONE,
    };
  };
  const manager = (router as unknown as { manager: Record<string, unknown> }).manager;
  manager.close = async (station: string) => void closed.push(station);
  manager.retain = () => {};
  manager.release = () => {};

  return { router, closed, opened };
}

/** Drive the source's own start-failure path, as a warm-up timeout does. */
function failTheStart(source: unknown) {
  (source as { opts: { onStartFailed?: () => void } }).opts.onStartFailed?.();
}

/** Put a source in the state a warm-up timeout leaves it in: stopped, with a consumer still attached. */
function stoppedWithConsumerAttached(source: { attach: () => unknown }) {
  source.attach();
  (source as unknown as { _state: string })._state = "stopped";
}

describe("recovering a camera whose live start failed", () => {
  it("replaces a stopped source even while a consumer is still attached to it", async () => {
    const { router } = routerFor(STANDALONE);
    const first = await router.sharedLiveSourceFor(STANDALONE);
    stoppedWithConsumerAttached(first);
    expect(first.consumerCount).toBe(1);

    const second = await router.sharedLiveSourceFor(STANDALONE);

    expect(second).not.toBe(first);
  });

  it("hands back a source that can actually be attached to, and disposes the one it replaced", async () => {
    const { router } = routerFor(STANDALONE);
    const first = await router.sharedLiveSourceFor(STANDALONE);
    stoppedWithConsumerAttached(first);

    const second = await router.sharedLiveSourceFor(STANDALONE);

    expect(() => second.attach()).not.toThrow();
    expect(() => first.attach()).toThrow(/disposed/);
  });

  it("evicts the dead source when it reports a failed start, so nothing hands it out again", async () => {
    const { router } = routerFor(STANDALONE);
    const first = await router.sharedLiveSourceFor(STANDALONE);
    first.attach();

    failTheStart(first);
    await vi.waitFor(async () => expect(await router.sharedLiveSourceFor(STANDALONE)).not.toBe(first));
  });

  /** The app's player fails on its timeout and leaves the P2P connection to `P2PClient`; nothing closes it. */
  it("fails at the deadline and closes no session, standalone or attached, then re-serves", async () => {
    for (const sn of [STANDALONE, ATTACHED]) {
      vi.useFakeTimers();
      try {
        const { router, closed } = routerFor(sn);
        const source = await router.sharedLiveSourceFor(sn);
        source.attach().on("error", () => {});

        await vi.advanceTimersByTimeAsync(25000);

        expect(source.state).toBe("stopped");
        expect(closed).toEqual([]);
        await vi.runAllTimersAsync();
        expect(await router.sharedLiveSourceFor(sn)).not.toBe(source);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("still rebuilds an attached camera's stream, which is all that is safe there", async () => {
    const { router } = routerFor(ATTACHED);
    const first = await router.sharedLiveSourceFor(ATTACHED);
    first.attach();

    failTheStart(first);
    await vi.waitFor(async () => expect(await router.sharedLiveSourceFor(ATTACHED)).not.toBe(first));
  });
});
