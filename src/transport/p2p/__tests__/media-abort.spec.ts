import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * A caller abandons ONE media call and gives back what it had taken.
 *
 * Acquiring media waits for a station to connect, for a level-2 key to be negotiated or given up on, and for
 * a camera to produce a keyframe. Measured past twenty seconds on a battery camera. A caller whose operator
 * navigated away in that window used to have to wait for a result it would discard, and the pull it opened
 * stayed warm for nobody.
 *
 * Abandoning must not disturb a pull somebody else holds: this abandons a call, not a stream.
 */
const STATION_SN = "T8010P0000000000";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const CAMERA = "T8114P0000000000";

function router(hasLevel2Key = true) {
  const session = connectedSession(hasLevel2Key) as FakeP2PSession;
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () =>
      [
        {
          sn: CAMERA,
          stationSn: STATION_SN,
          channel: 0,
          raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
        },
      ] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const built = new P2PCommandRouter(deps);
  const manager = (built as unknown as { manager: { register(sn: string, v: unknown): void } }).manager;
  manager.register(STATION_SN, session);
  return { router: built, session };
}

const sources = (r: P2PCommandRouter) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;

describe("a media call the caller abandons", () => {
  it("rejects with the reason the caller gave, rather than the result it no longer wants", async () => {
    const { router: r } = router();
    const signal = AbortSignal.abort(new Error("the operator navigated away"));

    await expect(r.mediaProviderFor(CAMERA).live({ signal })).rejects.toThrow(/navigated away/);
  });

  it("gives the pull back, so nothing stays warm for a caller that has gone", async () => {
    const { router: r } = router();
    const controller = new AbortController();
    controller.abort(new Error("gone"));

    await expect(r.mediaProviderFor(CAMERA).live({ signal: controller.signal })).rejects.toThrow(/gone/);

    const source = [...sources(r).values()][0] as { consumerCount: number } | undefined;
    expect(source?.consumerCount ?? 0).toBe(0);
  });

  it("leaves a pull another consumer is holding exactly as it was", async () => {
    const { router: r } = router();
    const kept = await r.mediaProviderFor(CAMERA).live();
    const controller = new AbortController();
    controller.abort(new Error("gone"));

    await expect(r.mediaProviderFor(CAMERA).live({ signal: controller.signal })).rejects.toThrow(/gone/);

    const source = [...sources(r).values()][0] as { consumerCount: number };
    expect(source.consumerCount).toBe(1);
    expect(kept).toBeDefined();
  });

  /**
   * The case the signal exists for: the caller changes its mind while the acquisition is still waiting, not
   * before it started. A station that never connects spins the connect window for twenty seconds, and the
   * abort has to land inside it rather than after it.
   */
  it("abandons a wait already in progress, rather than sitting out its window", async () => {
    const { router: r, session } = router();
    session.awaitLevel2Key = vi.fn(() => new Promise<boolean>(() => {})); // a negotiation that never settles
    const controller = new AbortController();
    const started = Date.now();

    const call = r.mediaProviderFor(CAMERA).live({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error("changed my mind")), 100);

    await expect(call).rejects.toThrow(/changed my mind/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is unaffected where the caller passes no signal at all", async () => {
    const { router: r } = router();

    await expect(r.mediaProviderFor(CAMERA).live()).resolves.toBeDefined();
  });
});
