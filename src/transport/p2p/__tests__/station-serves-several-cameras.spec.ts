import { describe, expect, it } from "vitest";
import { LIVE_FRAMES } from "./live-source-fixtures.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * Several cameras behind one station, all on the station's one session (the app holds one connection per serial).
 * Each gets its own source; a pull lingering for a camera nobody watches is released when another starts.
 */
const STATION_SN = "T8010P0000000000";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const DOORBELL = "T8210P0000000002";
const SIBLING = "T8114P0000000000";
const SOLO_A = "T8400P0000000000";
const SOLO_B = "T8410P0000000000";

function router() {
  const session = connectedSession(true) as FakeP2PSession;
  const deps: P2PRouterDeps = {
    liveFramesFor: () => LIVE_FRAMES,
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () =>
      [
        {
          sn: DOORBELL,
          stationSn: STATION_SN,
          channel: 2,
          raw: { parent_sn: STATION_SN, device_channel: 2, member: { admin_user_id: ACCOUNT_ID } },
        },
        {
          sn: SIBLING,
          stationSn: STATION_SN,
          channel: 0,
          raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
        },
        {
          sn: SOLO_A,
          stationSn: SOLO_A,
          channel: 0,
          raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
        },
        {
          sn: SOLO_B,
          stationSn: SOLO_B,
          channel: 0,
          raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
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
  const manager = (built as unknown as { manager: Manager }).manager;
  for (const sn of [STATION_SN, SOLO_A, SOLO_B]) manager.register(sn, session);
  return built;
}

interface Manager {
  register(key: string, session: unknown): void;
}

const live = (r: P2PCommandRouter, sn: string) => r.sharedLiveSourceFor(sn, {});

const sources = (r: P2PCommandRouter) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;

describe("a second camera on a station already serving one", () => {
  it("is admitted beside it", async () => {
    const r = router();
    const held = await live(r, SIBLING);
    held.attach();

    const second = await live(r, DOORBELL);

    expect(second).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(sources(r).has(`${STATION_SN}:2`)).toBe(true);
  });

  /**
   * The case a motion notification produces: something records a camera, the operator taps that camera's tile,
   * and both want the SAME channel. One pull serves them, so there is no second camera and nothing to refuse.
   */
  it("does not apply to the same camera, which shares one pull however many hold it", async () => {
    const r = router();
    const opened = await live(r, DOORBELL);
    opened.attach();

    const joined = await live(r, DOORBELL);

    expect(joined).toBe(opened);
    joined.attach();
    expect(joined.consumerCount).toBe(2);
    expect(sources(r).size).toBe(1);
  });

  /**
   * A pull whose viewers have all left is a linger nobody asked to keep. It is released rather than counted,
   * because it keeps the station's one session on a camera nobody is using.
   */
  it("releases a sibling pull whose viewers have left", async () => {
    const r = router();
    const consumer = (await live(r, SIBLING)).attach();
    consumer.detach();

    expect(await live(r, DOORBELL)).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  /**
   * A source that has never been attached to is NOT that: it is a start already handed to a caller who has
   * not attached yet, and two cameras opened together are in exactly that state when they look at each
   * other. Releasing it would dispose a source someone is holding.
   */
  it("does not release a sibling that has never been attached to", async () => {
    const r = router();
    const neverAttached = await live(r, SIBLING);
    expect(neverAttached.consumerCount).toBe(0);

    expect(await live(r, DOORBELL)).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
  });

  /**
   * A failed start fails its consumers without detaching them, so a caller holding a dead handle leaves the
   * count non-zero; that pull is dead and must not stand in the way.
   */
  it("does not let a stopped sibling hold the station, even with consumers still attached", async () => {
    const r = router();
    const dead = await live(r, SIBLING);
    dead.attach();
    dead.dispose();
    expect(dead.state).toBe("stopped");

    expect(await live(r, DOORBELL)).toBeDefined();
  });

  it("hands a live view the still's source already on the station's own session", async () => {
    const r = router();
    const still = await r.sharedLiveSourceFor(DOORBELL);
    still.attach().detach();

    expect(await live(r, DOORBELL)).toBe(still);
  });
});

/**
 * Arbitration belongs to a station, and a standalone camera is its own. Nothing scopes this to attached
 * cameras by accident: the map is keyed by station and channel, so a standalone camera has no sibling to
 * contend with, and the refusal is gated on the attachment fact as well.
 */
describe("a standalone camera", () => {
  it("is never refused for another standalone camera, having no station to share", async () => {
    const r = router();
    const other = await live(r, SOLO_B);
    other.attach();

    expect(await live(r, SOLO_A)).toBeDefined();
    expect(sources(r).has(`${SOLO_B}:0`)).toBe(true);
  });
});
