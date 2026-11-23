import { vi } from "vitest";
import type { P2PRouterDeps } from "../command-router.js";
import { buildDirectBinaryBody } from "../write-commands.js";
import { connectedSession, onFakeTime, routerWithSession, DEVICE_SN, STATION_SN } from "./session-fixtures.js";

/**
 * The app has two P2P senders, each with its own envelope account id. esiotkit's `p2pRequest` (bundle frames, live
 * view, talkback) quotes the TARGET record's stated `admin_user_id`, else the user's own id; the legacy `ZmediaUtil`
 * senders (station restart, the quick-response and lock-status queries, the ESL lock, recording download) quote
 * `AccountDelegate.m(station)`, the station's member rule. Synthetic ids: a camera owned by DEVICE_ADMIN on a station
 * shared with ME by STATION_ADMIN.
 */
const DEVICE_ADMIN = "1".repeat(40);
const STATION_ADMIN = "2".repeat(40);
const ME = "3".repeat(40);

function harness() {
  const session = Object.assign(connectedSession(), {
    sendSetPayload: vi.fn(),
    sendBytes: vi.fn(() => true),
  });
  const deps: Partial<P2PRouterDeps> = {
    mega: { auth: { userId: ME } } as unknown as P2PRouterDeps["mega"],
    listDevices: () =>
      [
        {
          sn: DEVICE_SN,
          stationSn: STATION_SN,
          model: "T8114",
          channel: 1,
          raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: DEVICE_ADMIN } },
        },
        {
          sn: STATION_SN,
          stationSn: STATION_SN,
          p2pDid: "",
          model: "T8010",
          raw: { member: { admin_user_id: STATION_ADMIN, member_user_id: ME, member_type: 1 } },
        },
      ] as never,
  };
  return { session, router: routerWithSession(session, { deps }) };
}

describe("the P2P envelope account id, per app sender", () => {
  it("is the target record's stated admin on a bundle frame (esiotkit p2pRequest)", async () => {
    const { session, router } = harness();
    await onFakeTime(() =>
      router.dispatchCommand(DEVICE_SN, { kind: "set-payload", cmd: 6201, payload: {}, channel: 1, mValue3: 0 }),
    ).catch(() => {});
    expect(session.sendSetPayload.mock.calls[0]![2]).toMatchObject({ accountId: DEVICE_ADMIN });
  });

  it("is the station's member rule on a ZmediaUtil query and restart", async () => {
    const { session, router } = harness();
    await onFakeTime(() => router.p2pQuery(DEVICE_SN, 6237)).catch(() => {});
    await onFakeTime(() => router.rebootStation(STATION_SN));
    expect(session.sendSetPayload.mock.calls[0]![2]).toMatchObject({ accountId: STATION_ADMIN });
    expect(session.sendBytes).toHaveBeenCalledWith(buildDirectBinaryBody(0, STATION_ADMIN), 255, 1034);
  });
});
