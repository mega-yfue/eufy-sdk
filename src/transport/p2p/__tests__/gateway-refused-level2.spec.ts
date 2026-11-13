import { describe, expect, it, vi } from "vitest";
import { StationKeyUnavailableError } from "../../../core/contracts.js";
import { gatewayInfoCipherId, gatewayInfoRefused } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { decryptFf09Frame, LOCK_API_COMMAND } from "../../ff09.js";
import { connectedSession, traceCollector, type FakeP2PSession } from "./session-fixtures.js";

const LOCK_SN = "T8506K0000000000";
const HOMEBASE_SN = "T8010P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADMIN = "0000000000000000000000000000000000000000";

/** A 36-byte `CMD_GATEWAYINFO` refusal: int32 LE `code`, then zeros. */
function gatewayResult(code = -103): Buffer {
  const payload = Buffer.alloc(36);
  payload.writeInt32LE(code, 0);
  return payload;
}

/** A cipher reply whose only read member is the leading `cipher_id`. */
function cipherGatewayInfo(cipherId: number): Buffer {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  return payload;
}

/** Hand a `CMD_GATEWAYINFO` reply to the session's negotiation. */
function negotiate(session: P2PSession, payload: Buffer): void {
  (session as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(payload);
}

/** Give the session an address and collect what it sends there. */
function collectSends(session: P2PSession): Buffer[] {
  const sent: Buffer[] = [];
  const internals = session as unknown as {
    connectAddress: unknown;
    send: (addr: unknown, type: Buffer, payload: Buffer) => void;
  };
  internals.connectAddress = { host: "<cam-lan-ip>", port: 32100 };
  internals.send = (_addr, _type, payload) => void sent.push(payload);
  return sent;
}

describe("gatewayInfoRefused", () => {
  it("reads result -103 as a refusal, not as a cipher", () => {
    const reply = gatewayResult();
    expect(reply.subarray(0, 4).toString("hex")).toBe("99ffffff");
    expect(gatewayInfoRefused(reply)).toBe(true);
    // What the cipher read alone makes of it — the id nobody holds a key for.
    expect(gatewayInfoCipherId(reply)).toBe(65433);
  });

  it("does not read a reply that names a cipher as a refusal", () => {
    expect(gatewayInfoRefused(cipherGatewayInfo(125))).toBe(false);
    expect(gatewayInfoRefused(cipherGatewayInfo(0))).toBe(false);
  });

  it("does not read any other negative result as a refusal", () => {
    expect(gatewayInfoRefused(gatewayResult(-1))).toBe(false);
    expect(gatewayInfoRefused(gatewayResult(-104))).toBe(false);
  });

  it("does not read a reply too short to carry a result as a refusal", () => {
    expect(gatewayInfoRefused(Buffer.from([0x99, 0xff]))).toBe(false);
  });
});

describe("a station that refuses level-2 at gateway info", () => {
  const refusedSession = () => {
    const { logger, traces } = traceCollector();
    const resolveCipherKey = vi.fn(async () => undefined);
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, logger, resolveCipherKey });
    negotiate(session, gatewayResult());
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

  it("settles the one bounded re-ask on the next refusal", async () => {
    const { session } = refusedSession();
    const sent = collectSends(session);

    expect(session.repromptLevel2Key()).toBe(true);
    const wait = session.awaitLevel2Key(60_000, "call");
    negotiate(session, gatewayResult());

    await expect(wait).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(session.refusedLevel2).toBe(true);
    expect(session.repromptLevel2Key()).toBe(false);
  });

  it("is not a refused station when the reply named a cipher", () => {
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, resolveCipherKey: async () => undefined });
    negotiate(session, cipherGatewayInfo(7));

    expect(session.refusedLevel2).toBe(false);
  });

  it("leaves any other negative result on the no-key path", () => {
    const resolveCipherKey = vi.fn(async () => undefined);
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, resolveCipherKey });
    negotiate(session, gatewayResult(-1));

    expect(session.refusedLevel2).toBe(false);
    expect(resolveCipherKey).toHaveBeenCalledOnce();
  });

  it("withdraws the refusal when a later reply names a cipher", () => {
    const { session } = refusedSession();
    negotiate(session, cipherGatewayInfo(7));

    expect(session.refusedLevel2).toBe(false);
  });

  it("is not a refused station once it holds the set-payload key", () => {
    const { session } = refusedSession();
    (session as unknown as { level2EcbKey: Buffer }).level2EcbKey = Buffer.alloc(16);

    expect(session.refusedLevel2).toBe(false);
  });

  it("frames a control payload in the app's clear form: signCode 0, header [01 00], only {cmd, payload}", () => {
    const { session } = refusedSession();
    const sent = collectSends(session);

    expect(session.sendControlLevel2(1940, 0, ADMIN, { apiCommand: 6018 }, 0, true)).toBe(true);
    expect(session.sendControlLevel2(1940, 0, ADMIN, { apiCommand: 6018 }, 0, true)).toBe(true);

    const [first, second] = sent as [Buffer, Buffer];
    expect(first.readUInt16LE(8)).toBe(1350); // CMD_SET_PAYLOAD
    expect([first[14], first[15]]).toEqual([0x01, 0x00]);
    expect([second[14], second[15]]).toEqual([0x01, 0x00]); // not counted per command
    expect([first[16], first[17]]).toEqual([0, 0]); // channel 0, signCode 0
    expect(JSON.parse(first.subarray(20).toString("utf-8"))).toEqual({ cmd: 1940, payload: { apiCommand: 6018 } });
  });

  it("frames nothing with nowhere to send it", () => {
    const { session } = refusedSession();
    expect(session.sendControlLevel2(1940, 0, ADMIN, {}, 0, true)).toBe(false);
  });

  it("frames nothing on a refused session without the opt-in", () => {
    const { session } = refusedSession();
    const sent = collectSends(session);

    expect(session.sendControlLevel2(1940, 0, ADMIN, {}, 0)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("frames nothing in the clear on a keyless session that was not refused", () => {
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, resolveCipherKey: async () => undefined });
    const sent = collectSends(session);

    expect(session.sendControlLevel2(1940, 0, ADMIN, {}, 0, true)).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("an ff09 lock command on a station that refused level-2", () => {
  interface Session extends FakeP2PSession {
    refusedLevel2: boolean;
    sendControlLevel2: ReturnType<typeof vi.fn>;
  }

  const makeRouter = (refused: boolean, { model = "T8506", attached = false } = {}) => {
    const session = connectedSession(!refused) as Session;
    session.refusedLevel2 = refused;
    session.sendControlLevel2 = vi.fn(() => true);
    const parentSn = attached ? HOMEBASE_SN : LOCK_SN;
    const lock = {
      sn: LOCK_SN,
      model,
      stationSn: parentSn,
      channel: 0,
      p2pDid: P2P_DID,
      raw: { device_channel: 0, member: { admin_user_id: ADMIN } },
    };
    const homeBase = { sn: HOMEBASE_SN, model: "T8010", stationSn: HOMEBASE_SN, channel: 0, p2pDid: P2P_DID, raw: {} };
    const deps: P2PRouterDeps = {
      mega: {} as P2PRouterDeps["mega"],
      listDevices: () => (attached ? [homeBase, lock] : [lock]) as never,
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    };
    const router = new P2PCommandRouter(deps);
    (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(parentSn, session);
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

  it("replays the unlock on the lock's channel, as every other unacknowledged command", async () => {
    const { router, session } = makeRouter(true);

    await router.dispatchCommand(LOCK_SN, unlock);

    expect(session.sendControlLevel2).toHaveBeenCalledTimes(5);
    const [cmd, channel, , payload, mValue3, clearOnRefusal] = session.sendControlLevel2.mock.calls[0]!;
    expect([cmd, channel, mValue3, clearOnRefusal]).toEqual([1940, 0, 0, true]);
    expect(payload.apiCommand).toBe(LOCK_API_COMMAND.ON_OFF_LOCK);
    const plain = decryptFf09Frame({
      lockPayload: payload.lock_payload,
      keyTime: payload.time,
      adminUserId: ADMIN,
      deviceSn: LOCK_SN,
    });
    expect(plain.length).toBeGreaterThan(0);
  });

  it.each([
    ["another model", { model: "T8531" }],
    ["a HomeBase-attached lock", { attached: true }],
  ])("still refuses on %s", async (_name, scope) => {
    const { router, session } = makeRouter(true, scope);

    await expect(router.dispatchCommand(LOCK_SN, unlock)).rejects.toBeInstanceOf(StationKeyUnavailableError);

    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });

  it.each([
    ["auto-lock", { kind: "ff09-autolock", adminUserId: ADMIN, deviceSn: LOCK_SN, enabled: true }],
    [
      "setting toggle",
      { kind: "ff09-setting-toggle", adminUserId: ADMIN, deviceSn: LOCK_SN, settingId: 1, value: true },
    ],
  ] as const)("still refuses a %s write, which no real device has confirmed in the clear", async (_name, command) => {
    const { router, session } = makeRouter(true);

    await expect(router.dispatchCommand(LOCK_SN, command)).rejects.toBeInstanceOf(StationKeyUnavailableError);

    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });

  it("still refuses the auto-lock read", async () => {
    const { router, session } = makeRouter(true);

    await expect(router.getAutoLockState(LOCK_SN, { adminUserId: ADMIN, deviceSn: LOCK_SN })).rejects.toBeInstanceOf(
      StationKeyUnavailableError,
    );

    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });
});
