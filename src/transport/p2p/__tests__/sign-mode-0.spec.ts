import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { MAGIC_WORD } from "../codec.js";

const ACCOUNT_ID = "0000000000000000000000000000000000000000";

/**
 * A session whose gateway info names no cipher (`cipher_id` 0, or a refusal on a serial that is not a station) stays
 * at sign mode 0. The app's sender then re-reads the mode for 1.45 s, marks the slot -1 and sends in the clear; later
 * sends no longer wait. Header byte 11 counts every command on the connection.
 */
function session(): { session: P2PSession; sent: Buffer[] } {
  const built = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    resolveCipherKey: async () => undefined,
  });
  const sent: Buffer[] = [];
  const internals = built as unknown as { socket: { send: (buf: Buffer) => void }; connectAddress: object };
  internals.socket = { send: vi.fn((buf: Buffer) => void sent.push(Buffer.from(buf))) };
  internals.connectAddress = { host: "<cam-lan-ip>", port: 32100 };
  return { session: built, sent };
}

/** Feed the session a gateway-info reply whose only read member is the leading int32. */
function negotiate(target: P2PSession, cipherId: number): void {
  const payload = Buffer.alloc(64);
  payload.writeInt32LE(cipherId, 0);
  (target as unknown as { negotiateLevel2Key(payload: Buffer, version: number): void }).negotiateLevel2Key(payload, 8);
}

/** The command frame of a sent datagram: its header fields and body. */
function commandOf(datagram: Buffer) {
  const f = datagram.subarray(datagram.indexOf(Buffer.from(MAGIC_WORD)));
  return {
    command: f.readUInt16LE(4),
    counter: [f[10], f[11]],
    channel: f[12],
    signCode: f[13],
    body: f.subarray(16, 16 + f.readUInt16LE(6)),
  };
}

describe("a session at sign mode 0", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  for (const cipherId of [0, -103]) {
    it(`waits 1.45 s, then sends in the clear and no longer waits (cipher_id ${cipherId})`, () => {
      const { session: s, sent } = session();
      negotiate(s, cipherId);
      s.queryDatabase("history_record_info", { accountId: ACCOUNT_ID, innerCmd: 10013, channel: 0 });
      vi.advanceTimersByTime(1_449);
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(1);
      s.sendFrame({ cmd: 1004, body: "native", payload: {}, layout: "u32-ch" }, 0, ACCOUNT_ID);

      expect(sent.map(commandOf).map(({ command, counter, signCode }) => ({ command, counter, signCode }))).toEqual([
        { command: 1350, counter: [1, 0], signCode: 0 },
        { command: 1004, counter: [1, 1], signCode: 0 },
      ]);
      expect(JSON.parse(commandOf(sent[0]!).body.toString("utf-8"))).toMatchObject({ cmd: 1306, mValue3: 0 });
      expect(commandOf(sent[1]!).body).toEqual(Buffer.from([0, 0, 0, 0]));
    });
  }

  it("seals what is still waiting once a gateway info names a cipher", () => {
    const { session: s, sent } = session();
    s.queryDatabase("history_record_info", { accountId: ACCOUNT_ID, innerCmd: 10013, channel: 0 });
    vi.advanceTimersByTime(500);
    negotiate(s, 3);
    vi.advanceTimersByTime(50);
    expect(commandOf(sent[0]!)).toMatchObject({ command: 1350, counter: [8, 0], signCode: 1 });
  });

  it("passes a reply sent in the clear on as its text", () => {
    const { session: s } = session();
    const chunks: string[] = [];
    s.on("dbChunk", ({ text }: { text: string }) => chunks.push(text));
    const body = Buffer.from(JSON.stringify({ data: [{ event_count: 1 }], cmd: 10013, mIntRet: 0 }), "utf-8");
    (s as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
      { commandId: 1306, channel: 0, signCode: 0, bytesToRead: body.length },
      body,
      0,
    );
    expect(chunks).toEqual([body.toString("latin1")]);
  });
});
