import { describe, expect, it } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { decryptP2PData, p2pCommandEncryptionKey } from "../codec.js";

/**
 * The set-payload envelope fields a settings bundle may state: the payload's keys at the top level
 * (`unzipParams`), and header byte 14 carrying the session counter, which cycles 10..251. Synthetic identity.
 */
const SN = "T8000P0000000000";
const DID = "XXXXXXX-000000-XXXXX";

function session() {
  const s = new P2PSession({ stationSn: SN, p2pDid: DID });
  const sent: Buffer[] = [];
  Object.assign(s, {
    connectAddress: { host: "127.0.0.1", port: 32100 },
    send: (_a: unknown, _t: unknown, payload: Buffer) => sent.push(payload),
  });
  const frame = (i: number) => sent[i]!.subarray(4);
  const json = (i: number) =>
    JSON.parse(
      decryptP2PData(frame(i).subarray(16), Buffer.from(p2pCommandEncryptionKey(SN, DID)))
        .toString("utf8")
        .replace(/\0+$/, ""),
    );
  return { s, frame, json };
}

describe("a level-1 set-payload envelope", () => {
  it("puts an unzipped payload's keys at the top level", () => {
    const { s, json } = session();
    s.sendSetPayload(1961, { version: "3", a: 1 }, { accountId: "acct", channel: 2, unzip: true });
    expect(json(0)).toEqual({ account_id: "acct", cmd: 1961, mChannel: 2, mValue3: 0, version: "3", a: 1 });
  });

  it("sends a list payload as it is", () => {
    const { s, json } = session();
    s.sendSetPayload(1308, [{ a: 1 }], { accountId: "acct", channel: 0 });
    expect(json(0).payload).toEqual([{ a: 1 }]);
  });

  it("writes header byte 14 from the session counter: bumped from 10, held by current, 0 otherwise", () => {
    const { s, frame } = session();
    s.sendSetPayload(1025, {}, { counter: "bump" });
    s.sendSetPayload(1025, {}, { counter: "bump" });
    s.sendSetPayload(1025, {}, { counter: "current" });
    s.sendSetPayload(1025, {});
    expect([0, 1, 2, 3].map((i) => frame(i)[14])).toEqual([10, 11, 11, 0]);
    Object.assign(s, { byte14: 251 });
    s.sendSetPayload(1025, {}, { counter: "bump" });
    expect(frame(4)[14], "wraps back to 10").toBe(10);
  });
});
