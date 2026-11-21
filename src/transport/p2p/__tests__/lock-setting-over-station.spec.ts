import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { decryptFf09Frame } from "../../ff09.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const LOCK_SN = "T8531P0000000000";
const STATION_SN = "T8010P0000000000";
const ADMIN = "0000000000000000000000000000000000000000";

/** `handleV2Payload` (`lock-over-station.md` §3): the 1350/1940 params a v2 lock setting replaces, on the station's session. */
describe("a v2 lock setting over its station", () => {
  it("sends {lock_payload, seq_num, apiCommand, time} on the lock's channel, the ff09 frame of its fields", async () => {
    const session = connectedSession(true) as FakeP2PSession & { sendSetPayload: ReturnType<typeof vi.fn> };
    session.sendSetPayload = vi.fn(() => true);
    const record = (sn: string, channel: number, parent?: string) => ({
      sn,
      stationSn: parent ?? sn,
      channel,
      p2pDid: "XXXXXXX-000000-XXXXX",
      raw: { device_channel: channel, parent_sn: parent, member: { admin_user_id: ADMIN } },
    });
    const router = new P2PCommandRouter({
      mega: {} as P2PRouterDeps["mega"],
      listDevices: () => [record(STATION_SN, 0), record(LOCK_SN, 3, STATION_SN)] as never,
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    });
    (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(
      STATION_SN,
      session,
    );
    const lock = {
      cmdCode: 52,
      apiCommand: 6015,
      fields: [
        { tag: 0xa3, value: Buffer.from([7]) },
        { tag: 0xa4, value: Buffer.from([1]) },
      ],
      subVersion: 3,
      functionType: 2,
      encrypt: true,
    };
    const send = () =>
      router.dispatchCommand(LOCK_SN, { kind: "set-payload", cmd: 1940, payload: {}, channel: 3, mValue3: 0, lock });
    void send();
    await vi.waitFor(() => expect(session.sendSetPayload).toHaveBeenCalledTimes(1));

    const [cmd, params, opts] = session.sendSetPayload.mock.calls[0]!;
    expect([cmd, opts.channel, opts.accountId]).toEqual([1940, 3, ADMIN]);
    expect(Object.keys(params)).toEqual(["lock_payload", "seq_num", "apiCommand", "time"]);
    expect(params.apiCommand).toBe(6015);
    const tlv = decryptFf09Frame({
      lockPayload: params.lock_payload,
      keyTime: params.time,
      adminUserId: ADMIN,
      deviceSn: LOCK_SN,
    });
    expect(tlv.toString("hex")).toContain("a30107a40101");
  });
});
