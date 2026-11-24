import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { decryptFf09Frame } from "../../ff09.js";
import { createDecipheriv } from "node:crypto";
import { lockKey } from "../doorlock-pass-through.js";
import { serialIv } from "../keyed-payload.js";
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
      mega: { auth: { userId: ADMIN } } as unknown as P2PRouterDeps["mega"],
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

/** `createPayloadForZhixingStationBle` (v4): `{payload}` = the station-sealed `{channel, lock_cmd, lock_payload, seq_num}`. */
describe("a v4 lock setting over its station", () => {
  const tlv = Buffer.from("a1021964a20101", "hex");
  const send = (member: { admin_user_id: string } | undefined) => {
    const session = connectedSession(true) as FakeP2PSession & { sendSetPayload: ReturnType<typeof vi.fn> };
    session.sendSetPayload = vi.fn(() => true);
    const record = (sn: string, channel: number, parent?: string) => ({
      sn,
      stationSn: parent ?? sn,
      channel,
      p2pDid: "XXXXXXX-000000-XXXXX",
      raw: { device_channel: channel, parent_sn: parent, member },
    });
    const router = new P2PCommandRouter({
      mega: { auth: { userId: ADMIN } } as unknown as P2PRouterDeps["mega"],
      listDevices: () => [record(STATION_SN, 0), record("T8500P0000000000", 3, STATION_SN)] as never,
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
    const sent = router.dispatchCommand("T8500P0000000000", {
      kind: "set-payload",
      cmd: 1911,
      payload: {},
      channel: 3,
      mValue3: 0,
      lock: { version: 4, bleCommand: 0x22, payload: tlv },
    });
    return { session, sent };
  };

  it("sends {payload}, the TLV sealed under the station key with the lock's next seq_num", async () => {
    const { session } = send({ admin_user_id: ADMIN });
    await vi.waitFor(() => expect(session.sendSetPayload).toHaveBeenCalledTimes(1));

    const [cmd, params] = session.sendSetPayload.mock.calls[0]!;
    expect(cmd).toBe(1911);
    const decipher = createDecipheriv("aes-128-cbc", lockKey(ADMIN, STATION_SN), serialIv(STATION_SN));
    const plain = Buffer.concat([decipher.update(Buffer.from(params.payload, "base64")), decipher.final()]);
    const inner = JSON.parse(plain.toString("utf-8").replace(/\0+$/, ""));
    expect(inner).toMatchObject({ channel: 0, lock_cmd: 0x22, lock_payload: tlv.toString("base64") });
    expect(typeof inner.seq_num).toBe("number");
  });

  it('has no key on a lock record stating no admin_user_id, as generateStationAesKey keys from "", not the user\'s id', async () => {
    const { session, sent } = send(undefined);
    await expect(sent).rejects.toThrow(/40-character admin id/);
    expect(session.sendSetPayload).not.toHaveBeenCalled();
  });
});

/** A setting sent over the device's last answer (`toSetLockParam` of the cached 1959 read): its fields, the payload's over them. */
describe("a set-payload over the device's answer", () => {
  it("sends each base field from the payload, else the answer, else its default", async () => {
    const session = connectedSession(true) as FakeP2PSession & { sendSetPayload: ReturnType<typeof vi.fn> };
    session.sendSetPayload = vi.fn(() => true);
    const lockSn = "T8530P0000000000";
    const record = (sn: string, channel: number, parent?: string) => ({
      sn,
      stationSn: parent ?? sn,
      channel,
      p2pDid: "XXXXXXX-000000-XXXXX",
      raw: { device_channel: channel, parent_sn: parent, member: { admin_user_id: ADMIN } },
    });
    const router = new P2PCommandRouter({
      mega: { auth: { userId: ADMIN } } as unknown as P2PRouterDeps["mega"],
      listDevices: () => [record(STATION_SN, 0), record(lockSn, 3, STATION_SN)] as never,
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
    const query = vi.spyOn(router, "p2pQuery").mockResolvedValue({ isAutoLock: 1, lockVolume: 1, rainMode: 1 });
    void router.dispatchCommand(lockSn, {
      kind: "set-payload",
      cmd: 1958,
      payload: { paramType: 6505, lockVolume: 2 },
      channel: 3,
      mValue3: 0,
      base: { query: 1959, fields: { paramType: 0, isAutoLock: 0, lockVolume: 0, privacyModel: 1 } },
    });
    await vi.waitFor(() => expect(session.sendSetPayload).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledWith(lockSn, 1959);
    expect(session.sendSetPayload.mock.calls[0]![1]).toEqual({
      paramType: 6505,
      isAutoLock: 1,
      lockVolume: 2,
      privacyModel: 1,
    });
  });
});
