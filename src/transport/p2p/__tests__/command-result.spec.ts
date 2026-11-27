import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

/**
 * A control reply with no JSON body is the numeric result of the command just sent. Driven through
 * the private frame handler: the decode is what is under test, not the socket.
 */
const results = (commandId: number, body: Buffer, signCode = 0) => {
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const seen: { code: number; channel: number; commandId: number }[] = [];
  session.on("commandResult", (r) => seen.push(r));
  (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId, channel: 0, signCode, bytesToRead: body.length },
    body,
    0,
  );
  return seen;
};

/**
 * The fixed-size body one lock family answers a `SET_PAYLOAD` write with: the code, then whatever its reply
 * buffer held — zeros by default here, or the `tail` given.
 */
const padded = (value: number, length = 132, tail?: Buffer) => {
  const b = Buffer.alloc(length);
  b.writeInt32LE(value);
  tail?.copy(b, 4, 0, length - 4);
  return b;
};

/** A stale-buffer tail of the kind measured once: a fragment of the device's own HTTP traffic. */
const STALE_TAIL = Buffer.from("devs_list HTTP/1.1\r\nHost: example.invalid\r\nX-Random-Number: 4096\r\n", "latin1");

/** An int32 LE result body, as the station sends one. */
const code = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};

describe("P2P frame — command result", () => {
  it("reads the result of a media command, sent over CMD_SET_PAYLOAD", () => {
    expect(results(1350, code(0))).toEqual([{ code: 0, channel: 0, commandId: 1350 }]);
  });

  it("reads the result of a device-control command, sent over CMD_CONTROL_PAYLOAD", () => {
    // The two wrappers answer identically, and only 1350 was read: a station refusing a control
    // command reached the caller as silence, which is also what an unanswered send looks like.
    expect(results(1700, code(-108))).toEqual([{ code: -108, channel: 0, commandId: 1700 }]);
  });

  it("carries a failure code through as it arrives, negative and unmapped", () => {
    expect(results(1350, code(-104))).toEqual([{ code: -104, channel: 0, commandId: 1350 }]);
  });

  it("reads the result of a direct command, which is no wrapper at all", () => {
    // 1246 is the param id itself carrying a direct-binary body, and it answers with four bytes just
    // as the wrappers do. An allowlist of wrappers would leave exactly the writes that have no other
    // confirmation path reporting nothing.
    expect(results(1246, code(0))).toEqual([{ code: 0, channel: 0, commandId: 1246 }]);
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

  it("reads the result out of the 132-byte SET_PAYLOAD body the classic Wi-Fi lock answers with", () => {
    // The lock answers a SET_PAYLOAD write in a fixed-size buffer on a sign-code-0 frame: the code, then
    // whatever the buffer held. Under a strict four-byte test the lock's own rejection was dropped and
    // read as silence, which is the one answer it never gives.
    expect(results(1350, padded(-110))).toEqual([{ code: -110, channel: 0, commandId: 1350 }]);
  });

  it("reads a success the same way", () => {
    expect(results(1350, padded(0))).toEqual([{ code: 0, channel: 0, commandId: 1350 }]);
  });

  it("reads the code whatever the rest of the buffer holds", () => {
    // The bytes after the code are stale buffer content — all zero on most answers measured, a fragment
    // of the device's own HTTP traffic on one — so they are no part of the shape. A gate on an all-zero
    // tail dropped every answer whose buffer was not clean, success and refusal alike.
    expect(results(1350, padded(-151, 132, STALE_TAIL))).toEqual([{ code: -151, channel: 0, commandId: 1350 }]);
    expect(results(1350, padded(0, 132, STALE_TAIL))).toEqual([{ code: 0, channel: 0, commandId: 1350 }]);
    expect(results(1350, padded(0, 132, Buffer.alloc(128, 0xa5)))).toEqual([{ code: 0, channel: 0, commandId: 1350 }]);
  });

  it("reports nothing for the same body on an encrypted frame", () => {
    // Sign code 0 is what admits the read: that body is plaintext as sent. On a sign-code 1 or 8 frame a
    // 132-byte body is ciphertext the decrypt could not open, and its first word is not a result.
    expect(results(1350, padded(-110), 1)).toEqual([]);
    expect(results(1350, padded(-110), 8)).toEqual([]);
  });

  it("reads the clear 132-byte answer a standalone camera gives a CONTROL_PAYLOAD write", () => {
    // Captured from the vendor app: the camera answers level-1 and level-2 1700 writes alike with a
    // sign-code-0 132-byte body, the code first and stale buffer content after it.
    expect(results(1700, padded(-108, 132, STALE_TAIL))).toEqual([{ code: -108, channel: 0, commandId: 1700 }]);
  });

  it("reports nothing for the padded shape on another command or at another length", () => {
    // The read is pinned to the shape measured, not generalised from it: that body under some other
    // command, or at some other length, is not the answer this device gives.
    expect(results(1246, padded(-110))).toEqual([]);
    expect(results(1350, padded(-110, 64))).toEqual([]);
    expect(results(1350, padded(-110, 148))).toEqual([]);
  });
});
