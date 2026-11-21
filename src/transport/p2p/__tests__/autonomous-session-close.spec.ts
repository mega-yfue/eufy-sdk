import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { P2PCommandRouter } from "../command-router.js";
import { SessionManager } from "../session-manager.js";
import type { P2PSession } from "../p2p-session.js";

/**
 * What happens to a live source when the session under it goes away UNASKED.
 *
 * A `SharedLiveSource` never holds its own session — the router captures one in a cell when the source is
 * built and never re-resolves it. So a source left cached past its session is handed to the next viewer
 * over a dead connection: it answers the retained keyframe and then fails on the warm-up deadline, which
 * is indistinguishable from a camera that has stopped working.
 *
 * The session's own `close` handler drops the source, but it is guarded on the session still being the
 * station's registered one — and the manager discards the entry BEFORE awaiting the teardown, so on every
 * close the manager itself initiated the guard is already false and the handler does nothing. That is the
 * gap: an idle-detach and a deferred reset are closes with no caller to clean up after them.
 *
 * The router therefore also tears down on {@link SessionManagerOpts.onAutoClose}. A close a CALLER made is
 * deliberately NOT routed there, because `closeAll` disposes its own sources.
 */
const STATION = "T8000P0000000000";

function fakeSession(): P2PSession {
  return { on: () => {}, off: () => {}, close: vi.fn().mockResolvedValue(undefined) } as unknown as P2PSession;
}

function routerFor() {
  const closedStations: string[] = [];
  const router = new P2PCommandRouter({
    mega: {} as never,
    listDevices: () => [{ sn: STATION, stationSn: STATION, raw: {} }] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: (sn) => void closedStations.push(sn),
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
    poweredFor: () => "battery",
    sessionIdle: { batteryIdleMs: 1000 },
  });
  const manager = (router as unknown as { manager: SessionManager }).manager;
  const sources = (router as unknown as { liveSources: Map<string, { dispose: () => void }> }).liveSources;
  const talkbacks = (router as unknown as { talkbacks: Map<string, { stop: () => Promise<void> }> }).talkbacks;
  return { manager, sources, talkbacks, closedStations };
}

/** Seed a cached live source + talkback on the station, as a warm stream would have left behind. */
function seedRiders(
  sources: Map<string, { dispose: () => void }>,
  talkbacks: Map<string, { stop: () => Promise<void> }>,
) {
  const dispose = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  sources.set(`${STATION}:0`, { dispose });
  talkbacks.set(`${STATION}:0`, { stop });
  return { dispose, stop };
}

describe("a station's session closing without a caller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the riders and reports it closed when the idle window elapses", async () => {
    const { manager, sources, talkbacks, closedStations } = routerFor();
    manager.register(STATION, fakeSession());
    const { dispose, stop } = seedRiders(sources, talkbacks);

    manager.retain(STATION);
    manager.release(STATION);
    await vi.advanceTimersByTimeAsync(1000);

    expect(dispose, "a source kept past its session is handed to the next viewer over a dead one").toHaveBeenCalled();
    expect(sources.has(`${STATION}:0`)).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(talkbacks.has(`${STATION}:0`)).toBe(false);
    expect(closedStations, "an open with no matching close makes the pair useless").toEqual([STATION]);
  });

  it("drops them when a deferred reset falls due instead, which fires inside the linger window", async () => {
    const { manager, sources, talkbacks, closedStations } = routerFor();
    manager.register(STATION, fakeSession());
    const { dispose } = seedRiders(sources, talkbacks);

    manager.retain(STATION);
    const reset = manager.resetWhenUnused(STATION);
    manager.release(STATION);
    await reset;

    expect(dispose).toHaveBeenCalled();
    expect(closedStations).toEqual([STATION]);
  });

  it("drops them when a reset finds only expiring holds left, which its caller never cleans up after", async () => {
    const { manager, sources, talkbacks, closedStations } = routerFor();
    manager.register(STATION, fakeSession());
    const { dispose } = seedRiders(sources, talkbacks);

    manager.bumpCommand(STATION, STATION);
    await manager.resetWhenUnused(STATION);

    expect(dispose, "a source lingering with no viewer survives over the dead session otherwise").toHaveBeenCalled();
    expect(closedStations).toEqual([STATION]);
  });

  it("says nothing about a station that never opened, so a close is never reported without an open", async () => {
    const { manager, sources, talkbacks, closedStations } = routerFor();
    seedRiders(sources, talkbacks);

    manager.hold(STATION, 100, STATION);
    await vi.advanceTimersByTimeAsync(100 + 1000);

    expect(closedStations).toEqual([]);
  });

  it("leaves a caller's own close alone", async () => {
    const { manager, sources, talkbacks, closedStations } = routerFor();
    const { dispose, stop } = seedRiders(sources, talkbacks);

    manager.register(STATION, fakeSession());
    await manager.close(STATION);
    manager.register(STATION, fakeSession());
    await manager.closeAll();

    expect(dispose).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(closedStations).toEqual([]);
  });
});
