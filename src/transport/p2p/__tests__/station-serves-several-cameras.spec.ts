import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * A station serves several cameras at once, one connection each.
 *
 * ONE session serves one camera: a station answers the most recent start on a session, so two cameras sharing
 * one take it from each other in turn — measured on a base carrying three attached cameras, all three
 * receiving their media in bursts. What that measures is the tunnel, not the hardware. Given a session each,
 * the same base holds every camera at full rate: measured on two attached cameras, one at 3840x2160, both at
 * ~15 fps for the length of the run, where the same pair down one session could only take turns.
 *
 * A station can also keep serving the camera it last served on a session: one went on sending a previous
 * camera's channel down its own session after that pull had moved away, and the next camera started there
 * received none of its own. So every continuous pull of an attached camera is admitted on a connection of its
 * own, and the cases below pin which camera lands where. The station's own session stays the one that carries
 * its control traffic, its events and its stills, because a station announces those to every client that
 * connects and a second announced connection would report all of them twice.
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
  for (const channel of [0, 2]) manager.register(`${STATION_SN}#live:${channel}`, session, STATION_SN);
  return built;
}

/**
 * The fixture seeds connected sessions rather than dialling: a media session is seeded under the key the
 * router files it by, so a source routed onto one finds it already open exactly as it would in flight.
 */
interface Manager {
  register(key: string, session: unknown, station?: string): void;
  get(key: string): unknown;
}

/** The live egress is the only one allowed a connection of its own; a still deliberately is not. */
const live = (r: P2PCommandRouter, sn: string) => r.sharedLiveSourceFor(sn, {}, true);

const sources = (r: P2PCommandRouter) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;
const sessionKeys = (r: P2PCommandRouter) => (r as unknown as { liveSessionKeys: Map<string, string> }).liveSessionKeys;

describe("an attached camera's continuous pull", () => {
  it("is admitted, on a connection of its own", async () => {
    const r = router();
    const held = await live(r, SIBLING);
    held.attach();

    const second = await live(r, DOORBELL);

    expect(second).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(sources(r).has(`${STATION_SN}:2`)).toBe(true);
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);
  });

  it("gets a connection of its own even when the station is serving nobody", async () => {
    const r = router();
    (await live(r, DOORBELL)).attach();

    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);
  });

  /**
   * A media session belongs to the one source it was opened for. Nothing else can reach it, so leaving it
   * open would hold a socket and a station keepalive for a camera nobody is pulling.
   */
  it("closes the extra connection when its camera is dropped", async () => {
    const r = router();
    (await live(r, SIBLING)).attach();
    await live(r, DOORBELL);
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);

    (r as unknown as { dropLiveSource(k: string): void }).dropLiveSource(`${STATION_SN}:2`);

    expect(sessionKeys(r).has(`${STATION_SN}:2`)).toBe(false);
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
   * A still nobody is watching on the station's session is a linger nobody asked to keep, so a live view of
   * another camera releases it.
   */
  it("releases a sibling's still whose viewers have left", async () => {
    const r = router();
    (await r.sharedLiveSourceFor(SIBLING)).attach().detach();

    expect(await live(r, DOORBELL)).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  /**
   * A still that has never been attached to is NOT that: it is a start already handed to a caller who has
   * not attached yet. Releasing it would dispose a source someone is holding.
   */
  it("does not release a sibling's still that has never been attached to", async () => {
    const r = router();
    const neverAttached = await r.sharedLiveSourceFor(SIBLING);
    expect(neverAttached.consumerCount).toBe(0);

    expect(await live(r, DOORBELL)).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
  });

  it("does not take over a still's unwatched source on the station's session", async () => {
    const r = router();
    const still = await r.sharedLiveSourceFor(DOORBELL);
    still.attach().detach();
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(STATION_SN);

    const view = await live(r, DOORBELL);

    expect(view).not.toBe(still);
    expect(still.state).toBe("stopped");
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);
  });

  it("puts a fragment recording on a connection of its own", async () => {
    const r = router();
    const recording = r.mediaProviderFor(DOORBELL).recordFragments!();

    await vi.waitFor(() => expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`));
    recording.stop();
  });

  it("still sends a still down the station's own session", async () => {
    const r = router();
    await r.sharedLiveSourceFor(DOORBELL);

    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(STATION_SN);
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
