import { describe, expect, it } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { decryptP2PData, MAGIC_WORD, p2pCommandEncryptionKey } from "../codec.js";
import { atSignMode1, withGcmKey } from "./session-fixtures.js";

const SN = "T8000P0000000000";
const DID = "XXXXXXX-000000-XXXXX";
const LEVEL1 = Buffer.from(p2pCommandEncryptionKey(SN, DID));

/** A session whose sends are captured as `{channel, signCode, version, body}`. */
function capture(session: P2PSession) {
  const sent: Buffer[] = [];
  Object.assign(session, {
    connectAddress: { host: "127.0.0.1", port: 32100 },
    send: (_a: unknown, _t: unknown, payload: Buffer) => sent.push(payload),
  });
  return () =>
    sent.map((datagram) => {
      const f = datagram.subarray(datagram.indexOf(Buffer.from(MAGIC_WORD)));
      return { version: f[10], channel: f[12], signCode: f[13], body: f.subarray(16, 16 + f.readUInt16LE(6)) };
    });
}

/** The app's legacy sender (`zx_p2p_send_command`). */
describe("the app's seal", () => {
  it("seals 1001 and 1054 AES-128-ECB at sign byte 1 on a version-8 session, on header channel 0xff", () => {
    const session = new P2PSession({ stationSn: SN, p2pDid: DID });
    const frames = capture(session);
    withGcmKey(session, Buffer.alloc(32, 7));
    session.sendRawLevel1Bytes(Buffer.alloc(4), 3, 1054);
    session.sendRawLevel1Bytes(Buffer.alloc(4), 3, 1103);
    expect(frames().map(({ version, channel, signCode }) => [version, channel, signCode])).toEqual([
      [1, 0xff, 1],
      [8, 3, 8],
    ]);
    expect(decryptP2PData(frames()[0]!.body, LEVEL1)).toEqual(Buffer.alloc(16));
  });

  it("encrypts a JSON body with its NUL", () => {
    const session = new P2PSession({ stationSn: SN, p2pDid: DID });
    const frames = capture(session);
    atSignMode1(session);
    const json = JSON.stringify({ a: "x".repeat(24) }); // 32 characters
    session.sendStringPayloadCommand(1700, json, 0);
    const body = frames()[0]!.body;
    expect(body.length).toBe(48);
    expect(decryptP2PData(body, LEVEL1).subarray(0, 33)).toEqual(Buffer.concat([Buffer.from(json), Buffer.alloc(1)]));
  });

  it("marks the slot -2 and sends in the clear when the ECB key is not 16 characters", () => {
    const session = new P2PSession({ stationSn: SN, p2pDid: DID });
    const frames = capture(session);
    Object.assign(session, { signMode: 2, ecbKey: Buffer.concat([Buffer.from("0123456789ab"), Buffer.alloc(4)]) });
    session.sendRawLevel1Bytes(Buffer.from([1, 2, 3, 4]), 0, 1103);
    expect(frames()[0]).toMatchObject({ signCode: 0, body: Buffer.from([1, 2, 3, 4]) });
    expect((session as unknown as { signMode: number }).signMode).toBe(-2);
  });
});
