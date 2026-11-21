import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

/**
 * A command's answer as the app's `zx_p2p_get_exec_result` reads it: a frame on channel 0 (DRW data type 0) under
 * the command's id, never decrypted — an empty body is code 0, a body of 1 to 132 bytes its first int32 LE, a longer
 * one its length. Driven through the private frame handler.
 */
const results = (commandId: number, body: Buffer, dataType = 0, signCode = 0) => {
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const seen: { code: number; channel: number; commandId: number }[] = [];
  session.on("commandResult", (r) => seen.push(r));
  (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId, channel: 3, signCode, bytesToRead: body.length },
    body,
    dataType,
  );
  return seen.map(({ code }) => code);
};

const int32 = (value: number, length = 4) => {
  const b = Buffer.alloc(length, 0x5a);
  b.writeInt32LE(value);
  return b;
};

describe("P2P frame — command result", () => {
  it("reads an empty answer as 0", () => {
    expect(results(1350, Buffer.alloc(0))).toEqual([0]);
  });

  it("reads the first int32 of a body of 1 to 132 bytes, whatever follows it and whatever its sign byte", () => {
    expect(results(1700, int32(-108))).toEqual([-108]);
    expect(results(1350, int32(-104, 132))).toEqual([-104]);
    expect(results(1013, int32(7, 36), 0, 8)).toEqual([7]);
  });

  it("reads a body longer than 132 bytes as its length", () => {
    expect(results(1350, Buffer.alloc(133))).toEqual([133]);
  });

  it("reads no answer from any other channel", () => {
    expect(results(1350, int32(0), 2)).toEqual([]);
    expect(results(1300, int32(0), 1)).toEqual([]);
  });
});
