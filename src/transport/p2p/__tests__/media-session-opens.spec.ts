import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * A camera that finds the station's own session claimed opens a SECOND connection, and that connection
 * carries media alone.
 *
 * The sibling spec seeds both sessions into the manager, so `acquire` answers from its registry and the
 * factory never runs — which leaves the claim in this feature's title resting on bookkeeping. Here
 * `P2PSession` itself is faked, so `openSession` and `makeSession` execute for real and the question
 * "was another connection actually opened" has an answer: two constructions, two distinct instances.
 *
 * It also pins what that second connection must NOT do. A station announces its state to every client
 * that connects, so an announced second connection reports every event twice; and its idle-close must
 * reach the source it carries rather than the station, which has other cameras and its own control
 * traffic riding on it.
 */
const built: FakeSession[] = [];

/** Set before an open to make the NEXT session connect without ever getting a level-2 key. */
let nextSessionHasNoKey = false;

class FakeSession extends EventEmitter {
  isConnected = false;
  traceId = `trace-${built.length}`;
  opts: Record<string, unknown>;
  hasKey: boolean;
  constructor(opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    this.hasKey = !nextSessionHasNoKey;
    nextSessionHasNoKey = false;
    built.push(this);
  }
  async connect() {
    this.isConnected = true;
  }
  async awaitLevel2Key() {
    return this.hasKey;
  }
  repromptLevel2Key() {
    return false;
  }
  async close() {
    this.emit("close");
  }
}

vi.mock("../p2p-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../p2p-session.js")>()),
  P2PSession: FakeSession,
}));

const { P2PCommandRouter } = await import("../command-router.js");
type Router = InstanceType<typeof P2PCommandRouter>;

const STATION_SN = "T8010P0000000000";
const CAM_A = "T8114P0000000000";
const CAM_B = "T8210P0000000002";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const DID = "XXXXXXX-000000-XXXXX";

const events: string[] = [];

function router() {
  built.length = 0;
  events.length = 0;
  nextSessionHasNoKey = false;
  const record = (sn: string, channel: number, parent?: string) => ({
    sn,
    stationSn: parent ?? sn,
    p2pDid: DID,
    raw: { parent_sn: parent, device_channel: channel, p2p_did: DID, member: { admin_user_id: ACCOUNT_ID } },
  });
  return new P2PCommandRouter({
    mega: { getDskKeys: async () => ({}), auth: { userId: ACCOUNT_ID } } as never,
    listDevices: () => [record(STATION_SN, 0), record(CAM_A, 0, STATION_SN), record(CAM_B, 2, STATION_SN)] as never,
    ensureDevices: async () => {},
    onConnect: (sn: string) => events.push(`connect:${sn}`),
    onClose: (sn: string) => events.push(`close:${sn}`),
    onError: () => {},
    onLevel2Ready: (sn: string) => events.push(`level2:${sn}`),
    onFrame: (sn: string) => events.push(`frame:${sn}`),
  });
}

/** The live egress is the only one allowed a connection of its own, so drive the router as `live()` does. */
const openLive = (r: Router, sn: string) =>
  (
    r as unknown as {
      sharedLiveSourceFor(s: string, o: object, m: boolean): Promise<{ attach(): unknown; dispose(): void }>;
    }
  ).sharedLiveSourceFor(sn, {}, true);

const sessionKeys = (r: Router) => (r as unknown as { liveSessionKeys: Map<string, string> }).liveSessionKeys;
const sources = (r: Router) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;

describe("a second live camera on a claimed station session", () => {
  it("really opens another connection, rather than only recording that it would", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    expect(built).toHaveLength(1);

    (await openLive(r, CAM_B)).attach();

    expect(built).toHaveLength(2);
    expect(built[1]).not.toBe(built[0]);
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);
  });

  it("leaves the second connection unannounced, so no event is reported twice", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    (await openLive(r, CAM_B)).attach();
    events.length = 0;

    built[1].emit("connect");
    built[1].emit("data", { commandId: 1300 });
    built[1].emit("level2Ready", { cipherId: 1 });

    expect(events).toEqual([]);
  });

  it("announces the station's own session, which is the one that carries its events", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    events.length = 0;

    built[0].emit("connect");

    expect(events).toEqual([`connect:${STATION_SN}`]);
  });

  /**
   * `onAutoClose` hands over a session KEY. Routing a media key into the station teardown orphans the
   * source it carries — the station sweep looks for a different prefix and matches nothing — and reports
   * a `p2pClose` for something that is not a station serial.
   */
  it("tears down only its own source when the manager idle-closes it, and reports no station close", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    (await openLive(r, CAM_B)).attach();
    events.length = 0;

    const onAutoClose = (r as unknown as { manager: { opts: { onAutoClose(k: string): void } } }).manager.opts
      .onAutoClose;
    onAutoClose(`${STATION_SN}#live:2`);

    expect(sources(r).has(`${STATION_SN}:2`)).toBe(false);
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(events).toEqual([]);
  });

  /**
   * An attached camera's media start has no level-1 form, so a connection without the level-2 key cannot
   * carry it: the start is dropped and the stream shows nothing until a keepalive tick happens to find the
   * key. The station's own session waits for that key before it is handed out; this one has to as well, or
   * the second camera's first start is silently thrown away.
   */
  it("refuses a media session that connects without a level-2 key, rather than returning a mute one", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();

    nextSessionHasNoKey = true;
    await expect(openLive(r, CAM_B)).rejects.toMatchObject({ name: "StationKeyUnavailableError" });
  });

  /**
   * The linger sweep relieves contention over ONE session. A sibling lingering on a connection of its own is
   * not competing for the one being started on, so dropping it would close a socket and throw away the cheap
   * re-attach the linger exists for, to settle a competition that is not happening.
   */
  it("leaves a sibling lingering on its own connection alone, having nothing to contend with", async () => {
    const r = router();
    const a = (await openLive(r, CAM_A)).attach() as { detach(): void };
    const b = await openLive(r, CAM_B);
    const bConsumer = b.attach() as { detach(): void };
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);

    bConsumer.detach();
    a.detach();
    (await openLive(r, CAM_A)).attach();

    expect(sources(r).has(`${STATION_SN}:2`)).toBe(true);
    expect(built).toHaveLength(2);
  });

  /**
   * A wired station's idle window is infinite by design, so a media session left retained by a stopped
   * source is never reclaimed by the lifecycle: its socket and 5 s heartbeat stay up until that same
   * camera is asked for again, a sibling opens, or the station goes. The connection exists for one pull
   * and must go when the pull does.
   */
  it("closes its connection when the pull stops, which a wired station would never reclaim", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    const b = await openLive(r, CAM_B);
    b.attach();
    expect(sessionKeys(r).get(`${STATION_SN}:2`)).toBe(`${STATION_SN}#live:2`);

    b.dispose();

    expect(sessionKeys(r).has(`${STATION_SN}:2`)).toBe(false);
  });

  /**
   * Consumers attach only after the call returns, so two cameras opened together cannot see each other
   * through consumer counts. Both would take the shared connection and contend — the exact stutter this
   * feature removes, in the four-tile case it exists for.
   */
  it("gives simultaneous starts one connection each", async () => {
    const r = router();
    const [a, b] = await Promise.all([openLive(r, CAM_A), openLive(r, CAM_B)]);
    a.attach();
    b.attach();

    const keys = [...sessionKeys(r).values()];
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(STATION_SN);
    expect(built).toHaveLength(2);
  });
});
