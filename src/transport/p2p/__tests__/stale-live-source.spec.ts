import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter } from "../command-router.js";
import type { P2PSession } from "../p2p-session.js";
import { connectedSession } from "./session-fixtures.js";

const STATION = "T8000P0000000000";
const CAMERA = "T8000P0000000001";

/** A connected session that can reveal which connection received a media start. */
function session() {
  return Object.assign(connectedSession(true), {
    pathAnswering: true,
    startLiveMedia: vi.fn(),
    stopLiveMedia: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

/** Two connections to one station, with the second available after the first is closed. */
function setup() {
  const first = session();
  const replacement = session();
  const camera = { sn: CAMERA, stationSn: STATION, raw: { parent_sn: STATION, device_channel: 1 } };
  const station = { sn: STATION, stationSn: STATION, raw: {} };
  const router = new P2PCommandRouter({
    mega: {} as never,
    listDevices: () => [camera, station] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });
  const manager = (
    router as unknown as {
      manager: { get: (key: string) => P2PSession | undefined; register: (key: string, value: P2PSession) => void };
    }
  ).manager;
  manager.register(STATION, first as unknown as P2PSession);
  (router as unknown as { deviceFor: (sn: string) => Promise<unknown> }).deviceFor = async () => {
    if (!manager.get(STATION)) manager.register(STATION, replacement as unknown as P2PSession);
    return camera;
  };
  return { router, first, replacement };
}

describe("a cached pull when its P2P path is replaced", () => {
  it("does not hand a lingered source bound to the closed session back to a caller", async () => {
    const { router, first, replacement } = setup();
    const oldSource = await router.sharedLiveSourceFor(CAMERA);
    const oldConsumer = oldSource.attach();
    oldConsumer.detach();
    expect(first.startLiveMedia).toHaveBeenCalledOnce();
    const siblingKey = `${STATION}:2`;
    const sibling = { dispose: vi.fn(), state: "live", consumerCount: 1 };
    const internals = router as unknown as {
      liveSources: Map<string, typeof sibling>;
      liveSessionKeys: Map<string, string>;
    };
    internals.liveSources.set(siblingKey, sibling);
    internals.liveSessionKeys.set(siblingKey, `${STATION}#live:2`);

    first.pathAnswering = false;
    const newSource = await router.sharedLiveSourceFor(CAMERA);

    expect(first.close).toHaveBeenCalledOnce();
    expect(newSource).not.toBe(oldSource);
    expect(() => oldSource.attach()).toThrow(/disposed/);
    expect(sibling.dispose).not.toHaveBeenCalled();
    expect(internals.liveSources.get(siblingKey)).toBe(sibling);
    const newConsumer = newSource.attach();
    expect(replacement.startLiveMedia).toHaveBeenCalledOnce();
    newConsumer.detach();
    newSource.dispose();
  });
});
