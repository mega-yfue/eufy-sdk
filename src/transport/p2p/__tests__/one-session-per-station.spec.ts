import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { p2pVideoFrame, LIVE_FRAMES } from "./live-source-fixtures.js";

/**
 * The app holds one connection per station serial: `zx_set_p2p_connect_info` hands back the slot already filed
 * under the serial while its handle is open. So every camera behind a station streams over the station's one
 * session. `P2PSession` itself is faked, so `openSession` and `makeSession` execute for real and "how many
 * connections were opened" has an answer.
 */
const built: FakeSession[] = [];

class FakeSession extends EventEmitter {
  isConnected = false;
  traceId = `trace-${built.length}`;
  opts: Record<string, unknown>;
  constructor(opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    built.push(this);
  }
  async connect() {
    this.isConnected = true;
  }
  sent: unknown[][] = [];
  sendBytes(...frame: unknown[]) {
    this.sent.push(frame);
    return true;
  }
  /** As the real one does, it drops the connection at once and emits `close` only once its END send settles. */
  async close() {
    this.isConnected = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
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
  const record = (sn: string, channel: number, parent?: string) => ({
    sn,
    stationSn: parent ?? sn,
    p2pDid: DID,
    channel: channel,
    raw: { parent_sn: parent, device_channel: channel, p2p_did: DID, member: { admin_user_id: ACCOUNT_ID } },
  });
  return new P2PCommandRouter({
    liveFramesFor: () => LIVE_FRAMES,
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

const openLive = (r: Router, sn: string) =>
  (
    r as unknown as {
      sharedLiveSourceFor(s: string, o: object): Promise<{ attach(): unknown; dispose(): void }>;
    }
  ).sharedLiveSourceFor(sn, {});

const sources = (r: Router) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;

/**
 * A source that ends its own stream ends each consumer first and tears down second, so a Readable reaches
 * EOF and destroys itself after the teardown has released the source's session claim. That late detach
 * must leave the source `stopped`: the router rebuilds only a stopped source. Two endings reach that order — the upstream stopping, and a battery
 * budget expiring unextended, which a Readable never extends.
 */
describe("reacquiring after Readable EOF", () => {
  for (const ending of ["upstream end", "battery budget"] as const)
    for (const sibling of [false, true])
      it(`rebuilds the source on the station's session (${ending}, ${sibling ? "second" : "first"} camera)`, async () => {
        const r = router();
        const manager = (r as unknown as { manager: { get(key: string): FakeSession | undefined } }).manager;
        const target = sibling ? CAM_B : CAM_A;
        const channel = sibling ? 2 : 0;
        const key = `${STATION_SN}:${channel}`;
        const opts = ending === "battery budget" ? { powered: "battery", batteryBudgetMs: 1, budgetGraceMs: 1 } : {};
        if (sibling) (await openLive(r, CAM_A)).attach();
        const reader = await r.mediaProviderFor(target).openReadable!(opts as never);
        const source = sources(r).get(key) as { state: string; consumerCount: number; stream: EventEmitter };
        try {
          reader.resume();
          const closed = once(reader, "close");
          manager
            .get(STATION_SN)!
            .emit("data", p2pVideoFrame({ nal: Buffer.from([0x65, 0x88]), keyframe: true, channel }));
          if (ending === "upstream end") source.stream.emit("stop");
          await closed;
          expect(source.state).toBe("stopped");
          expect(source.consumerCount).toBe(0);
          const opened = built.length;
          const reopened = await r.mediaProviderFor(target).openReadable!();
          try {
            expect(sources(r).get(key)).not.toBe(source);
            expect(built).toHaveLength(opened);
          } finally {
            reopened.destroy();
          }
        } finally {
          reader.destroy();
          await r.closeAll();
        }
      });
});

describe("cameras behind one station", () => {
  it("stream over the station's one connection", async () => {
    const r = router();
    await r.mediaProviderFor(CAM_A).live!({});
    await r.mediaProviderFor(CAM_B).live!({});

    expect(built).toHaveLength(1);
    expect((sources(r).get(`${STATION_SN}:2`) as { stream: { session: FakeSession } }).stream.session).toBe(built[0]);
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
  });

  it("start together on that one connection", async () => {
    const r = router();
    await Promise.all([r.mediaProviderFor(CAM_A).live!({}), r.mediaProviderFor(CAM_B).live!({})]);

    expect(built).toHaveLength(1);
  });

  /** The app sends nothing on a gateway key: its params read rides the device-list refresh. */
  it("send nothing when the session unwraps its gateway key", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    (await openLive(r, CAM_B)).attach();

    built[0].emit("level2Ready", { cipherId: 1 });

    expect(built[0].sent).toEqual([]);
  });

  it("are announced through the station's session", async () => {
    const r = router();
    (await openLive(r, CAM_A)).attach();
    events.length = 0;

    built[0].emit("connect");

    expect(events).toEqual([`connect:${STATION_SN}`]);
  });

  it("share one source per camera however many requests arrive together", async () => {
    const r = router();
    const [first, second] = await Promise.all([openLive(r, CAM_B), openLive(r, CAM_B)]);

    expect(second).toBe(first);
    expect(sources(r).get(`${STATION_SN}:2`)).toBe(first);
  });

  it("all drop their sources when the station's connection closes", async () => {
    const r = router();
    const a = await openLive(r, CAM_A);
    a.attach();
    const b = await openLive(r, CAM_B);
    b.attach();
    const disposedA = vi.spyOn(a, "dispose");
    const disposedB = vi.spyOn(b, "dispose");

    await built[0].close();

    expect(disposedA).toHaveBeenCalledOnce();
    expect(disposedB).toHaveBeenCalledOnce();
    expect(sources(r).size).toBe(0);
  });
});
