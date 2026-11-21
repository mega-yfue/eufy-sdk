import { describe, expect, it, vi } from "vitest";
import { gatewayInfoRefused } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { traceCollector } from "./session-fixtures.js";

const LOCK_SN = "T8506K0000000000";
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
  (session as unknown as { negotiateLevel2Key(payload: Buffer, version: number): void }).negotiateLevel2Key(payload, 8);
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

describe("a gateway info that brings no key", () => {
  /** Native hands the app's key step `cipher_id` 0 and no body for a reply naming no cipher; it still looks it up. */
  it("looks cipher 0 up and says why no key came", async () => {
    const { logger, traces } = traceCollector();
    const resolveCipherKey = vi.fn(async () => undefined);
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID, logger, resolveCipherKey });
    negotiate(session, gatewayResult());

    await vi.waitFor(() =>
      expect(traces.filter((trace) => trace.phase === "level2-unavailable")).toEqual([
        { phase: "level2-unavailable", reason: "gateway-refused", source: session.traceId },
      ]),
    );
    expect(resolveCipherKey).toHaveBeenCalledWith(0, 8);
    expect(session.hasLevel2Key).toBe(false);
  });

  it("states cipher material the account does not hold, under the cipher the station named", async () => {
    const { logger, traces } = traceCollector();
    const session = new P2PSession({
      stationSn: LOCK_SN,
      p2pDid: P2P_DID,
      logger,
      resolveCipherKey: async () => undefined,
    });
    negotiate(session, cipherGatewayInfo(7));

    await vi.waitFor(() =>
      expect(traces.filter((trace) => trace.phase === "level2-unavailable")).toEqual([
        { phase: "level2-unavailable", reason: "no-cipher-key", cipherId: 7, source: session.traceId },
      ]),
    );
  });

  /**
   * At sign mode 0 the app's sender waits 1.45 s, marks the slot -1 and sends in the clear; the 1350 body is the
   * app's whole envelope whatever the seal (`AndroidP2PClient.p2pSendRequestByCommand`).
   */
  it("sends a set-payload after 1.45 s, in the clear, as the whole envelope", () => {
    vi.useFakeTimers();
    const session = new P2PSession({ stationSn: LOCK_SN, p2pDid: P2P_DID });
    const sent = collectSends(session);

    session.sendSetPayload(1940, { apiCommand: 6018 }, { accountId: ADMIN, channel: 0 });
    session.sendSetPayload(1940, { apiCommand: 6018 }, { accountId: ADMIN, channel: 0 });
    vi.advanceTimersByTime(1_449);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();

    const [first, second] = sent as [Buffer, Buffer];
    expect(first.readUInt16LE(8)).toBe(1350);
    expect([first[14], first[15]]).toEqual([0x01, 0x00]);
    expect([second[14], second[15]]).toEqual([0x01, 0x01]); // byte 11 counts every command
    expect([first[16], first[17]]).toEqual([0, 0]); // channel 0, signCode 0
    expect(JSON.parse(first.subarray(20).toString("utf-8"))).toEqual({
      account_id: ADMIN,
      cmd: 1940,
      mChannel: 0,
      mValue3: 0,
      payload: { apiCommand: 6018 },
    });
  });
});
