import { encryptP2PData, p2pCommandEncryptionKey } from "../codec.js";
import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

/**
 * A control reply with no JSON body is the numeric result of the command just sent. Driven through
 * the private frame handler: the decode is what is under test, not the socket.
 */
const results = (commandId: number, body: Buffer, signCode = 0) => {
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const seen: { code: number; channel: number }[] = [];
  session.on("commandResult", (r) => seen.push(r));
  (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId, channel: 0, signCode, bytesToRead: body.length },
    body,
    0,
  );
  return seen;
};

/** The fixed-size body one lock family answers a `SET_PAYLOAD` write with: the code, then zero padding. */
const padded = (value: number, length = 132) => {
  const b = Buffer.alloc(length);
  b.writeInt32LE(value);
  return b;
};

/** An int32 LE result body, as the station sends one. */
const code = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};

describe("P2P frame — command result", () => {
  it("reads the result of a media command, sent over CMD_SET_PAYLOAD", () => {
    expect(results(1350, code(0))).toEqual([{ code: 0, channel: 0 }]);
  });

  it("reads the result of a device-control command, sent over CMD_CONTROL_PAYLOAD", () => {
    // The two wrappers answer identically, and only 1350 was read: a station refusing a control
    // command reached the caller as silence, which is also what an unanswered send looks like.
    expect(results(1700, code(-108))).toEqual([{ code: -108, channel: 0 }]);
  });

  it("carries a failure code through as it arrives, negative and unmapped", () => {
    expect(results(1350, code(-104))).toEqual([{ code: -104, channel: 0 }]);
  });

  it("reads the result of a direct command, which is no wrapper at all", () => {
    // 1246 is the param id itself carrying a direct-binary body, and it answers with four bytes just
    // as the wrappers do. An allowlist of wrappers would leave exactly the writes that have no other
    // confirmation path reporting nothing.
    expect(results(1246, code(0))).toEqual([{ code: 0, channel: 0 }]);
  });

  it("reports nothing for a media frame, whose body is never control plaintext", () => {
    expect(results(1300, code(0))).toEqual([]);
    expect(results(1301, code(0))).toEqual([]);
  });

  it("reports nothing for a reply that carries a JSON document", () => {
    // A document is the answer itself; only a bodyless reply is a bare result code.
    const body = Buffer.concat([Buffer.from(JSON.stringify({ cmd: 1306, count: 0 }), "utf8"), Buffer.from([0])]);
    expect(results(1700, body)).toEqual([]);
  });

  it("reports nothing for a body too short to hold one", () => {
    expect(results(1700, Buffer.from([0, 1, 2]))).toEqual([]);
  });

  it("reports nothing for a body that is longer than a result code", () => {
    // The body IS the int32, so anything longer is a different kind of frame. Widening the read to
    // the general control wrapper made this reachable: a frame the decrypt could not open stays
    // ciphertext, and a length-only test would report its first word as a result the station never
    // sent. Sixteen bytes, because the level-1 path only decrypts what is block-aligned.
    expect(results(1700, Buffer.alloc(16, 0xa5))).toEqual([]);
  });

  it("reports nothing for non-JSON text that happens to arrive on the control wrapper", () => {
    expect(results(1700, Buffer.from("not a result", "utf8"))).toEqual([]);
  });

  it("reads the result out of the 132-byte SET_PAYLOAD body that pads the code with zeros", () => {
    // The classic Wi-Fi smart lock answers a SET_PAYLOAD write in a fixed-size buffer: the code, then
    // nothing but zero padding. The body is not block-aligned, so the level-1 decrypt skips it and it
    // arrives raw — under a strict four-byte test the lock's own rejection was dropped and read as
    // silence, which is the one answer it never gives.
    expect(results(1350, padded(-110), 1)).toEqual([{ code: -110, channel: 0 }]);
  });

  it("reads a zero-padded success the same way", () => {
    expect(results(1350, padded(0), 1)).toEqual([{ code: 0, channel: 0 }]);
  });

  it("still reports nothing when the padding is not zeros", () => {
    // The tail is what separates a padded answer from ciphertext the decrypt could not open: a
    // plausible first word is not evidence on its own, so only an all-zero tail admits the code.
    const body = Buffer.alloc(132, 0xa5);
    body.writeInt32LE(-110);
    expect(results(1350, body, 1)).toEqual([]);
  });

  it("reports nothing for the padded shape on another wrapper or at another length", () => {
    // The read is pinned to the shape measured, not generalised from it: a zero tail on a body of some
    // other length, or under some other command, is not the answer this device gives.
    expect(results(1700, padded(-110), 1)).toEqual([]);
    expect(results(1350, padded(-110, 64), 1)).toEqual([]);
    expect(results(1350, padded(-110, 148), 1)).toEqual([]);
  });

  it("reports nothing for a body the level-1 decrypt opened, even when its plaintext is a code and zeros", () => {
    // A short level-1 plaintext is zero-padded to its block, so a decrypted reply carrying a four-byte
    // value — or nothing at all — presents the same head-and-zero-tail as the padded answer. Only a
    // body the decrypt skipped is read, so this one stays a frame, not a fabricated result.
    const key = Buffer.from(p2pCommandEncryptionKey(STATION_SN, P2P_DID));
    expect(results(1350, encryptP2PData(padded(0, 16), key), 1)).toEqual([]);
    expect(results(1350, encryptP2PData(padded(-110, 16), key), 1)).toEqual([]);
  });
});
