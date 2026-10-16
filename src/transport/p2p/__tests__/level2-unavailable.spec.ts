import { describe, expect, it } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { traceCollector } from "./session-fixtures.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

/** A gateway-info payload whose only read member is the leading `cipher_id`. */
function gatewayInfo(cipherId: number): Buffer {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  return payload;
}

/**
 * Every ending of a level-2 wait states why the key is not coming.
 *
 * A refused operation whose only wire is level-2 is refused for one of several reasons that call for
 * different next steps — this account's cipher material, the station, or the connection — and the refusal
 * itself carries none of them. A wait that ran out is the ordinary case: the station is prompted once on
 * connect and a station that never replies leaves the wait to expire, which is exactly the ending a reader
 * has no other record of.
 */
describe("why a level-2 key is not coming", () => {
  const session = (resolveEccKey?: (cipherId: number) => Promise<string | undefined>) => {
    const { logger, traces } = traceCollector();
    const built = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      logger,
      ...(resolveEccKey
        ? { resolveCipherKeys: async (cipherId: number) => ({ ecc: await resolveEccKey(cipherId) }) }
        : {}),
    });
    return { session: built, traces };
  };

  it("states a wait that ran out, with how long it waited", async () => {
    const { session: target, traces } = session(() => new Promise(() => {}));
    (target as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(gatewayInfo(3));

    await expect(target.awaitLevel2Key(20)).resolves.toBe(false);

    expect(traces.filter((trace) => trace.phase === "level2-unavailable")).toEqual([
      { phase: "level2-unavailable", reason: "grace-elapsed", waitedMs: expect.any(Number), source: target.traceId },
    ]);
  });

  /** A station that answered and produced nothing states the cipher it asked for; the reason is not a timeout. */
  it("states cipher material the account does not hold, under the cipher the station named", async () => {
    const { session: target, traces } = session(async () => undefined);
    (target as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(gatewayInfo(7));

    await expect(target.awaitLevel2Key(1_000)).resolves.toBe(false);

    expect(traces.filter((trace) => trace.phase === "level2-unavailable")).toEqual([
      { phase: "level2-unavailable", reason: "no-cipher-key", cipherId: 7, source: target.traceId },
    ]);
  });

  /** Nothing to negotiate with is not the same as a negotiation that failed, and is answered without waiting. */
  it("states a session that is not negotiating at all", async () => {
    const { session: target, traces } = session();

    await expect(target.awaitLevel2Key(1_000)).resolves.toBe(false);

    expect(traces).toMatchObject([{ phase: "level2-unavailable", reason: "not-negotiating" }]);
  });
});
