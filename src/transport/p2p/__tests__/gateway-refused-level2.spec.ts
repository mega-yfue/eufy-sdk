import { describe, expect, it, vi } from "vitest";
import { gatewayInfoCipherId, gatewayInfoRefusal } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { decryptFf09Frame, LOCK_API_COMMAND } from "../../ff09.js";
import { connectedSession, traceCollector, type FakeP2PSession } from "./session-fixtures.js";

const LOCK_SN = "T8506K0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADMIN = "0000000000000000000000000000000000000000";

/** The 36-byte `CMD_GATEWAYINFO` reply a Smart Lock C220 sends in the clear: int32 LE -103, then zeros. */
function refusedGatewayInfo(): Buffer {
  const payload = Buffer.alloc(36);
  payload.writeInt32LE(-103, 0);
  return payload;
}

/** A cipher reply whose only read member is the leading `cipher_id`. */
function cipherGatewayInfo(cipherId: number): Buffer {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  return payload;
}

describe("gatewayInfoRefusal", () => {
  it("reads the C220's reply as result -103, not as a cipher", () => {
    const reply = refusedGatewayInfo();
    expect(reply.subarray(0, 4).toString("hex")).toBe("99ffffff");
    expect(gatewayInfoRefusal(reply)).toBe(-103);
    // What the cipher read alone makes of it — the id nobody holds a key for.
    expect(gatewayInfoCipherId(reply)).toBe(65433);
  });

  it("answers undefined for a reply that names a cipher", () => {
    expect(gatewayInfoRefusal(cipherGatewayInfo(125))).toBeUndefined();
    expect(gatewayInfoRefusal(cipherGatewayInfo(0))).toBeUndefined();
  });

  it("answers undefined for a reply too short to carry a result", () => {
    expect(gatewayInfoRefusal(Buffer.from([0x99, 0xff]))).toBeUndefined();
  });
});

describe("a station that refuses level-2 at gateway info", () => {
  const refusedSession = () => {
    const { logger, traces } = traceCollector();
    const resolveCipherKey = vi.fn(async () => undefined);
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, logger, resolveCipherKey });
    (session as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(refusedGatewayInfo());
    return { session, traces, resolveCipherKey };
  };

  it("settles at once without a cloud cipher lookup, and says why", async () => {
    const { session, traces, resolveCipherKey } = refusedSession();

    await expect(session.awaitLevel2Key(1_000)).resolves.toBe(false);

    expect(resolveCipherKey).not.toHaveBeenCalled();
    expect(session.refusedLevel2).toBe(true);
    // The refusal is stated where it happened; a wait begun after it settled answers as any settled wait does.
    expect(traces.filter((trace) => trace.phase === "level2-unavailable")[0]).toEqual({
      phase: "level2-unavailable",
      reason: "gateway-refused",
      source: session.traceId,
    });
  });

  it("is not asked a second time", () => {
    const { session } = refusedSession();
    (session as unknown as { connectAddress: unknown }).connectAddress = { host: "192.168.1.2", port: 1 };

    expect(session.repromptLevel2Key()).toBe(false);
  });

  it("is not a refused station when the reply named a cipher", () => {
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, resolveCipherKey: async () => undefined });
    (session as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(cipherGatewayInfo(7));

    expect(session.refusedLevel2).toBe(false);
  });

  it("frames a set-payload in the clear: signCode 0, header [01 n], the JSON as plaintext", () => {
    const { session } = refusedSession();
    const sent: Buffer[] = [];
    const internals = session as unknown as {
      connectAddress: unknown;
      send: (addr: unknown, type: Buffer, payload: Buffer) => void;
    };
    internals.connectAddress = { host: "192.168.1.2", port: 1 };
    internals.send = (_addr, _type, payload) => void sent.push(payload);

    expect(session.sendSetPayloadInTheClear(1940, 0, ADMIN, { apiCommand: 6018 }, 0)).toBe(true);
    expect(session.sendSetPayloadInTheClear(1940, 0, ADMIN, { apiCommand: 6018 }, 0)).toBe(true);

    const [first, second] = sent as [Buffer, Buffer];
    expect(first.readUInt16LE(8)).toBe(1350); // CMD_SET_PAYLOAD
    expect([first[14], first[15]]).toEqual([0x01, 0x01]); // first command in the clear on this connection
    expect([second[14], second[15]]).toEqual([0x01, 0x02]); // counted per command
    expect([first[16], first[17]]).toEqual([0, 0]); // channel 0, signCode 0
    expect(JSON.parse(first.subarray(20).toString("utf-8"))).toEqual({
      account_id: ADMIN,
      cmd: 1940,
      mChannel: 0,
      mValue3: 0,
      payload: { apiCommand: 6018 },
    });
  });

  it("refuses to frame anything with nowhere to send it", () => {
    const { session } = refusedSession();
    expect(session.sendSetPayloadInTheClear(1940, 0, ADMIN, {}, 0)).toBe(false);
  });
});

describe("an ff09 lock command on a station that refused level-2", () => {
  interface Session extends FakeP2PSession {
    refusedLevel2: boolean;
    sendControlLevel2: ReturnType<typeof vi.fn>;
    sendSetPayloadInTheClear: ReturnType<typeof vi.fn>;
  }

  const makeRouter = (refused: boolean) => {
    const session = connectedSession(!refused) as Session;
    session.refusedLevel2 = refused;
    session.sendControlLevel2 = vi.fn(() => true);
    session.sendSetPayloadInTheClear = vi.fn(() => true);
    const deps: P2PRouterDeps = {
      mega: {} as P2PRouterDeps["mega"],
      listDevices: () =>
        [
          {
            sn: LOCK_SN,
            stationSn: LOCK_SN,
            channel: 0,
            p2pDid: P2P_DID,
            raw: { device_channel: 0, member: { admin_user_id: ADMIN } },
          },
        ] as never,
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    };
    const router = new P2PCommandRouter(deps);
    (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(LOCK_SN, session);
    return { router, session };
  };

  const unlock = {
    kind: "ff09-actuate",
    engage: false,
    adminUserId: ADMIN,
    username: "someone",
    shortUserId: "00000000",
    deviceSn: LOCK_SN,
  } as const;

  it("sends the unlock once, in the clear, on the lock's channel", async () => {
    const { router, session } = makeRouter(true);

    await router.dispatchCommand(LOCK_SN, unlock);

    expect(session.sendControlLevel2).not.toHaveBeenCalled();
    expect(session.sendSetPayloadInTheClear).toHaveBeenCalledTimes(1);
    const [cmd, channel, , payload, mValue3] = session.sendSetPayloadInTheClear.mock.calls[0]!;
    expect([cmd, channel, mValue3]).toEqual([1940, 0, 0]);
    expect(payload.apiCommand).toBe(LOCK_API_COMMAND.ON_OFF_LOCK);
    const plain = decryptFf09Frame({
      lockPayload: payload.lock_payload,
      keyTime: payload.time,
      adminUserId: ADMIN,
      deviceSn: LOCK_SN,
    });
    expect(plain.length).toBeGreaterThan(0);
  });

  it("still seals the command level-2 on a station that holds a key", async () => {
    const { router, session } = makeRouter(false);

    await router.dispatchCommand(LOCK_SN, unlock);

    expect(session.sendSetPayloadInTheClear).not.toHaveBeenCalled();
    expect(session.sendControlLevel2).toHaveBeenCalled();
  });
});
