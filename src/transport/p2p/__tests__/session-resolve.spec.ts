import { describe, expect, it, vi } from "vitest";
import { LIVE_FRAMES } from "./live-source-fixtures.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const DEVICE_SN = "T8000P0000000000";
const STATION_SN = "T8000P0000000001";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";

interface FakeSession extends FakeP2PSession {
  sendSetPayload: ReturnType<typeof vi.fn>;
}

function setup(hasLevel2Key: boolean, attached = true) {
  const session = connectedSession(hasLevel2Key) as FakeSession;
  session.sendSetPayload = vi.fn();
  const deps: P2PRouterDeps = {
    liveFramesFor: () => LIVE_FRAMES,
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [
      {
        sn: DEVICE_SN,
        stationSn: attached ? STATION_SN : DEVICE_SN,
        channel: 1,
        raw: {
          ...(attached ? { parent_sn: STATION_SN } : {}),
          device_channel: 1,
          member: { admin_user_id: ACCOUNT_ID },
        },
      } as never,
    ],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
    attached ? STATION_SN : DEVICE_SN,
    session,
  );
  return { router, session };
}

/** The app's sender seals with what the session holds; nothing waits for a key (`zx_p2p_send_command`). */
describe("a write on a session holding no key", () => {
  it("goes at once, for an attached and an own-session device", async () => {
    for (const attached of [true, false]) {
      const { router, session } = setup(false, attached);
      void router
        .dispatchCommand(DEVICE_SN, { kind: "set-payload", cmd: 1224, payload: { mode_type: 1 }, channel: 1 })
        .catch(() => undefined);
      await vi.waitFor(() => expect(session.sendSetPayload).toHaveBeenCalledOnce());
    }
  });
});

/** A session that closed itself (the app's ALIVE timeout) but is still filed is replaced before use. */
describe("resolving a session that closed itself", () => {
  it("rebuilds it rather than handing a caller a closed session", async () => {
    const { router, session } = setup(true);
    (session as unknown as { isClosed: boolean }).isClosed = true;
    const manager = (router as unknown as { manager: { close: (sn: string) => Promise<void> } }).manager;
    const closed: string[] = [];
    manager.close = async (sn) => void closed.push(sn);

    await router.sharedLiveSourceFor(DEVICE_SN).catch(() => undefined);

    expect(closed).toContain(STATION_SN);
  });
});
