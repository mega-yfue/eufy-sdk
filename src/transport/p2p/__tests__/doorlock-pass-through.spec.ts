import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { buildDoorlockPassThrough, encodeLockOnOff, lockKey } from "../doorlock-pass-through.js";
import { serialIv } from "../keyed-payload.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const LOCK_SN = "T8510P0000000000";
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADMIN = "0000000000000000000000000000000000000000";
const STATION_ADMIN = "1111111111111111111111111111111111111111";

const frame = {
  adminUserId: ADMIN,
  shortUserId: 4,
  nickname: "someone",
  stationSn: STATION_SN,
  seqNum: 1795125601,
  nowSec: 1795125600,
};

describe("the door-lock pass-through blob", () => {
  it.each([
    [
      "lock",
      true,
      "W1cTgnL98bNA+cucZYuLgy3LbvtEwDuw15PWz+N7axlVaZ2o0IruZRKYnNIiaiWIKJyOqUrm56z7ZNKE4qO2UU4UlwcIoKTm+DuYs9VhiL7NEr9Hz5MkqNFtfwbTR2ISPWzchnrLCLANtRP6rxmw2Fv2a8sAYEeQTxo4lXZYPBk=",
    ],
    [
      "unlock",
      false,
      "W1cTgnL98bNA+cucZYuLgy3LbvtEwDuw15PWz+N7axlVaZ2o0IruZRKYnNIiaiWIBN3OIfXqUEFz1f2K1JAtkfH0Lea5xUXb6frXt19qVkBm6pTafOWZV1F2BC/UvK667oXx8dJSG6dbUkYWL/jQgkAs6fAFhpW4dFIwIrxz+Eo=",
    ],
  ])("seals a %s", (_name, engage, expected) => {
    expect(buildDoorlockPassThrough({ ...frame, engage })).toBe(expected);
  });

  it("encodes the on/off TLV", () => {
    expect(encodeLockOnOff(4, "someone", true, 1795125600).toString("hex")).toBe(
      "a1020004a20101a3046071ff6aa407736f6d656f6e65",
    );
  });

  it("caps the nickname at the one-byte length field", () => {
    const tlv = encodeLockOnOff(4, "x".repeat(300), true, 1795125600);
    expect(tlv[14]).toBe(0xff);
    expect(tlv.length).toBe(15 + 0xff);
  });

  it("refuses an admin id or station serial of the wrong length rather than derive a wrong key", () => {
    expect(() => lockKey(ADMIN.slice(1), STATION_SN)).toThrow(/40-character admin id/);
    expect(() => lockKey(ADMIN, STATION_SN.slice(1))).toThrow(/16-character station serial/);
  });
});

describe("a door-lock pass-through actuation", () => {
  const makeRouter = (hasKey: boolean) => {
    const session = connectedSession(hasKey) as FakeP2PSession & { sendSetPayload: ReturnType<typeof vi.fn> };
    session.sendSetPayload = vi.fn(() => true);
    const lock = {
      sn: LOCK_SN,
      model: "T8510",
      stationSn: STATION_SN,
      channel: 42,
      p2pDid: P2P_DID,
      raw: { device_channel: 42, parent_sn: STATION_SN, member: { admin_user_id: ADMIN } },
    };
    const station = {
      sn: STATION_SN,
      model: "T8000",
      stationSn: STATION_SN,
      channel: 0,
      p2pDid: P2P_DID,
      // The station's own member is someone else: only the envelope's account id may come from it.
      raw: { member: { admin_user_id: STATION_ADMIN, short_user_id: "0099", nick_name: "member-nick" } },
    };
    const deps: P2PRouterDeps = {
      mega: {} as P2PRouterDeps["mega"],
      listDevices: () => [station, lock] as never,
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    };
    const router = new P2PCommandRouter(deps);
    (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(
      STATION_SN,
      session,
    );
    return { router, session };
  };

  const lockCmd = {
    kind: "doorlock-pass-through-actuate",
    engage: true,
    adminUserId: ADMIN,
    username: "someone",
    shortUserId: "0004",
    deviceSn: LOCK_SN,
  } as const;

  it("sends one pass-through on the lock's channel, keyed and attributed to the lock's member, enveloped as the station's", async () => {
    const { router, session } = makeRouter(true);

    await router.dispatchCommand(LOCK_SN, lockCmd);

    expect(session.sendSetPayload).toHaveBeenCalledTimes(1);
    const [cmd, payload, opts] = session.sendSetPayload.mock.calls[0]!;
    expect([cmd, opts.channel, opts.accountId, opts.mValue3]).toEqual([1911, 42, STATION_ADMIN, 0]);
    const decipher = createDecipheriv("aes-128-cbc", lockKey(ADMIN, STATION_SN), serialIv(STATION_SN));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.payload, "base64")), decipher.final()]);
    const inner = JSON.parse(plain.toString("utf-8").replace(/\0+$/, ""));
    expect(inner).toMatchObject({ channel: 0, lock_cmd: 8 });
    const tlv = Buffer.from(inner.lock_payload, "base64");
    expect(tlv.subarray(0, 7).toString("hex")).toBe("a1020004a20101");
    // The A4 name is the account's (the app's AccountDelegate.i()), not the station member's nick_name.
    expect(tlv.subarray(13).toString("hex")).toBe(
      Buffer.concat([Buffer.from([0xa4, 7]), Buffer.from("someone")]).toString("hex"),
    );
  });

  const userField = (payload: { payload: string }): string => {
    const decipher = createDecipheriv("aes-128-cbc", lockKey(ADMIN, STATION_SN), serialIv(STATION_SN));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.payload, "base64")), decipher.final()]);
    const inner = JSON.parse(plain.toString("utf-8").replace(/\0+$/, ""));
    return Buffer.from(inner.lock_payload, "base64").subarray(0, 4).toString("hex");
  };

  it.each([
    ["0010", "a1020010"],
    ["000a", "a102000a"],
    ["00FF", "a10200ff"],
  ])("writes short_user_id %s as hex, not decimal", async (id, field) => {
    const { router, session } = makeRouter(true);

    await router.dispatchCommand(LOCK_SN, { ...lockCmd, shortUserId: id });

    expect(userField(session.sendSetPayload.mock.calls[0]![1])).toBe(field);
  });

  it.each(["4", "00004", "00g4", ""])(
    "refuses a short_user_id of %j rather than writing the wrong user",
    async (id) => {
      const { router, session } = makeRouter(true);

      await expect(router.dispatchCommand(LOCK_SN, { ...lockCmd, shortUserId: id })).rejects.toThrow(
        /4-digit hex short_user_id/,
      );

      expect(session.sendSetPayload).not.toHaveBeenCalled();
    },
  );
});
