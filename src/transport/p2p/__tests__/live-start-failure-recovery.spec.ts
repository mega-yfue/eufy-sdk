import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter } from "../command-router.js";

/**
 * The non-recovery this covers: a warm-up timeout fails its consumers but leaves them ATTACHED, and the
 * router only replaced a stopped source when its consumer count had reached zero. A host that keeps its
 * handle after `error` therefore got the same dead source back on every later acquisition, still closing
 * over the session resolved when it was first built — so a camera that stopped delivering frames stayed
 * that way until the client restarted.
 *
 * Two devices: one standalone (its station key is its own serial) and one attached to a HomeBase. Closing
 * a shared HomeBase session would drop every other camera on it, so the recycle is only ever safe for the
 * standalone case, and that asymmetry is the thing most likely to be got wrong.
 */
const STANDALONE = "T8000P0000000000";
const ATTACHED = "T8000P0000000001";
const HOMEBASE = "T8000P0000000002";

function routerFor(sn: string) {
  const closed: string[] = [];
  const resetWhenUnused: string[] = [];
  const opened: string[] = [];
  const router = new P2PCommandRouter({
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
  manager.resetWhenUnused = async (station: string) => void resetWhenUnused.push(station);
  manager.addUser = () => {};
  manager.releaseUser = () => {};

  return { router, closed, resetWhenUnused, opened };
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

  it("resolves the session again for the replacement, rather than reusing the old closure", async () => {
    const { router, opened } = routerFor(STANDALONE);
    const first = await router.sharedLiveSourceFor(STANDALONE);
    stoppedWithConsumerAttached(first);

    await router.sharedLiveSourceFor(STANDALONE);

    expect(opened).toHaveLength(2);
  });

  it("recycles a standalone device's session when its start failed", async () => {
    const { router, closed } = routerFor(STANDALONE);
    const source = await router.sharedLiveSourceFor(STANDALONE);

    failTheStart(source);
    await vi.waitFor(() => expect(closed).toEqual([STANDALONE]));
  });

  it("evicts the dead source when it reports a failed start, so nothing hands it out again", async () => {
    const { router } = routerFor(STANDALONE);
    const first = await router.sharedLiveSourceFor(STANDALONE);
    first.attach();

    failTheStart(first);
    await vi.waitFor(async () => expect(await router.sharedLiveSourceFor(STANDALONE)).not.toBe(first));
  });

  it("never closes a shared HomeBase session — other cameras are streaming on it", async () => {
    const { router, closed, resetWhenUnused } = routerFor(ATTACHED);
    const source = await router.sharedLiveSourceFor(ATTACHED);

    failTheStart(source);
    await vi.waitFor(() => expect(source.state).toBe("stopped"));

    expect(closed).toEqual([]);
    expect(resetWhenUnused).toEqual([]);
  });

  it("still rebuilds an attached camera's stream, which is all that is safe there", async () => {
    const { router } = routerFor(ATTACHED);
    const first = await router.sharedLiveSourceFor(ATTACHED);
    first.attach();

    failTheStart(first);
    await vi.waitFor(async () => expect(await router.sharedLiveSourceFor(ATTACHED)).not.toBe(first));
  });
});
