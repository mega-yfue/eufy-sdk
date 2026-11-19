import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StationKeyUnavailableError } from "../../../core/contracts.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { buildDoorlockPassThrough, encodeLockOnOff, lockKey } from "../doorlock-pass-through.js";
import { serialIv } from "../keyed-payload.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const LOCK_SN = "T8510P0000000000";
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADMIN = "0000000000000000000000000000000000000000";

const frame = {
  adminUserId: ADMIN,
  shortUserId: 4,
  nickname: "someone",
  stationSn: STATION_SN,
  channel: 0,
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
});

describe("a door-lock pass-through actuation", () => {
  const makeRouter = (hasKey: boolean) => {
    const session = connectedSession(hasKey) as FakeP2PSession & { sendControlLevel2: ReturnType<typeof vi.fn> };
    session.sendControlLevel2 = vi.fn(() => true);
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
      raw: { member: { admin_user_id: ADMIN, short_user_id: "0004", nick_name: "someone" } },
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
    shortUserId: "4",
    deviceSn: LOCK_SN,
  } as const;

  it("sends one pass-through at level-2 on the lock's channel, sealed to its station", async () => {
    const { router, session } = makeRouter(true);

    await router.dispatchCommand(LOCK_SN, lockCmd);

    expect(session.sendControlLevel2).toHaveBeenCalledTimes(1);
    const [cmd, channel, account, payload, mValue3] = session.sendControlLevel2.mock.calls[0]!;
    expect([cmd, channel, account, mValue3]).toEqual([1911, 42, ADMIN, 0]);
    const decipher = createDecipheriv("aes-128-cbc", lockKey(ADMIN, STATION_SN), serialIv(STATION_SN));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.payload, "base64")), decipher.final()]);
    const inner = JSON.parse(plain.toString("utf-8").replace(/\0+$/, ""));
    expect(inner).toMatchObject({ channel: 42, lock_cmd: 8 });
    expect(Buffer.from(inner.lock_payload, "base64").subarray(0, 7).toString("hex")).toBe("a1020004a20101");
  });

  it("refuses without a level-2 key", async () => {
    const { router, session } = makeRouter(false);

    await expect(router.dispatchCommand(LOCK_SN, lockCmd)).rejects.toBeInstanceOf(StationKeyUnavailableError);

    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });
});
