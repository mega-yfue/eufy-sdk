import { describe, expect, it, vi } from "vitest";
import { decryptP2PData, p2pCommandEncryptionKey } from "../codec.js";
import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const ADDRESS = { host: "127.0.0.1", port: 1 };
/** `[dataType:2][seq:2]["XZYH"][cmd:2]` sits ahead of the string payload's own ten-byte head. */
const HEADER = 10;
const CHANNEL = HEADER + 6;
const ENC_TYPE = HEADER + 7;
const BODY = HEADER + 10;

/**
 * A connected session whose socket send is captured, so the assertions read the exact bytes handed to the
 * socket: the frame's channel and encryption-type bytes, and the body that follows them.
 */
function harness() {
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const send = vi.fn();
  const target = session as unknown as { connectAddress: typeof ADDRESS; send: typeof send };
  target.connectAddress = ADDRESS;
  target.send = send;
  return { session, frame: () => send.mock.calls[0]![2] as Buffer };
}

describe("P2PSession.sendSetPayload — keyed envelope", () => {
  it("carries a keyed envelope in the clear: key first, encryption-type 0, `=` written \\u003d", () => {
    const { session, frame } = harness();
    session.sendSetPayload(1961, "c2VhbGVk==", { accountId: ACCOUNT_ID, channel: 3, key: "00ff" });
    const f = frame();
    expect(f.readUInt16LE(8)).toBe(1350);
    expect(f[CHANNEL]).toBe(3);
    expect(f[ENC_TYPE]).toBe(0x00);
    const text = f.subarray(BODY).toString("utf8");
    expect(f.readUInt16LE(HEADER)).toBe(Buffer.byteLength(text));
    expect(text).not.toContain("=");
    expect(text).toContain("\\u003d");
    const value = JSON.parse(text.replace(/\\u003d/g, "=")) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["key", "account_id", "cmd", "mChannel", "mValue3", "payload"]);
    expect(value).toEqual({
      key: "00ff",
      account_id: ACCOUNT_ID,
      cmd: 1961,
      mChannel: 3,
      mValue3: 0,
      payload: "c2VhbGVk==",
    });
  });

  it("keeps the level-1 encrypted body, with no key field, for an envelope without a key", () => {
    const { session, frame } = harness();
    session.sendSetPayload(1194, {}, { accountId: ACCOUNT_ID, channel: 3 });
    const f = frame();
    expect(f[CHANNEL]).toBe(3);
    expect(f[ENC_TYPE]).toBe(0x01);
    const key = Buffer.from(p2pCommandEncryptionKey(STATION_SN, P2P_DID));
    const value = JSON.parse(decryptP2PData(f.subarray(BODY), key).toString("utf8").replace(/\0+$/, ""));
    expect(value).toEqual({ account_id: ACCOUNT_ID, cmd: 1194, mChannel: 3, mValue3: 0, payload: {} });
  });
});
