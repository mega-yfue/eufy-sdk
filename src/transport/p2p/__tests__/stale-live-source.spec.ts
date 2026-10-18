import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter } from "../command-router.js";
import type { P2PSession } from "../p2p-session.js";
import { connectedSession } from "./session-fixtures.js";
import { p2pVideoFrame } from "./live-source-fixtures.js";

const STATION = "T8000P0000000000";
const CAMERA = "T8000P0000000001";

/** A connected session that can reveal which connection received a media start. */
function session() {
  const fake = connectedSession(true);
  return Object.assign(fake, {
    pathAnswering: true,
    startLiveMedia: vi.fn(),
    stopLiveMedia: vi.fn(),
    close: vi.fn(async () => {
      fake.emit("close");
    }),
  });
}

/** Two connections to one station, with the second available after the first is closed. */
function setup() {
  const first = session();
  const replacement = session();
  const camera = { sn: CAMERA, stationSn: STATION, channel: 1, raw: { parent_sn: STATION, device_channel: 1 } };
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

describe("a cached pull after bounded channel recovery", () => {
  it("replaces a retired source on acquisition while keeping the answering station session", async () => {
    vi.useFakeTimers();
    const { router, first } = setup();
    try {
      const oldSource = await router.sharedLiveSourceFor(CAMERA);
      const consumer = oldSource.attach();
      const stopped = vi.fn();
      consumer.on("stop", stopped);
      first.emit(
        "data",
        p2pVideoFrame({ nal: Buffer.from([0x65, 0x11]), keyframe: true, width: 1920, height: 1080, channel: 1 }),
      );
      expect(oldSource.state).toBe("live");
      await vi.advanceTimersByTimeAsync(35_000);
      expect(stopped).toHaveBeenCalledOnce();
      const newSource = await router.sharedLiveSourceFor(CAMERA);
      expect(newSource).not.toBe(oldSource);
      newSource.attach();
      expect(newSource.state).toBe("warming");
      expect(first.close).not.toHaveBeenCalled();
      expect(first.startLiveMedia.mock.calls.length).toBeGreaterThan(2);
    } finally {
      await router.closeAll();
      vi.useRealTimers();
    }
  });
});
