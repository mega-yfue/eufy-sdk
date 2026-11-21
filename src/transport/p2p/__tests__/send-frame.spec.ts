import { describe, expect, it, vi } from "vitest";
import type { SessionFrame } from "../../../core/contracts.js";
import { MAGIC_WORD } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { openSentGcm, withGcmKey } from "./session-fixtures.js";

/**
 * A bundle frame goes out as the app's sender builds it (synthetic frames shaped as `bundle-wires.generated.json`
 * writes them): the body per its kind, header byte 14 from its counter, and the media key the app's `getCrypto`
 * picks.
 */
function connected() {
  const session = new P2PSession({ stationSn: "T8010P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const sent: Buffer[] = [];
  const internals = session as unknown as { socket: { send: (b: Buffer) => void }; connectAddress: object };
  internals.socket = { send: vi.fn((b: Buffer) => void sent.push(Buffer.from(b))) };
  internals.connectAddress = { host: "127.0.0.1", port: 32100 };
  withGcmKey(session, Buffer.alloc(32, 7));
  const frame = () => {
    const f = sent.at(-1)!;
    const x = f.subarray(f.indexOf(Buffer.from(MAGIC_WORD)));
    return { cmd: x.readUInt16LE(4), channel: x[12], counter: x[14], plain: openSentGcm(session, x.subarray(16))! };
  };
  return { session, frame };
}

const START_1003: SessionFrame = {
  cmd: 1003,
  body: "native",
  payload: { cryptoKey: "$key" },
  layout: "0x2db020",
  counter: "bump",
};
const START_1700: SessionFrame = {
  cmd: 1700,
  body: "json1700",
  subCmd: 1000,
  payload: { cmd: 1000, mChannel: "$channel", account_id: "$userId", encryptkey: "$key", transaction: "$now" },
};
const START_1350: SessionFrame = {
  cmd: 1350,
  body: "json",
  payload: { cmd: 1003, mChannel: "$channel", account_id: "$userId", mValue3: 1003, payload: { key: "$key" } },
  counter: "bump",
};
const STOP_1350: SessionFrame = {
  cmd: 1350,
  body: "json1350",
  subCmd: 1004,
  mValue3: 0,
  payload: { channel: "$channel", transaction: "$now" },
};

describe("sendFrame", () => {
  it("sends a direct 1003 as [u32 channel][256-char RSA modulus][NUL] with a bumped counter", () => {
    const { session, frame } = connected();
    session.sendFrame(START_1003, 3, "user");
    const f = frame();
    expect([f.cmd, f.channel, f.plain.length]).toEqual([1003, 3, 261]);
    expect(f.plain.readUInt32LE(0)).toBe(3);
    expect(f.plain.subarray(4, 260).toString("latin1")).toMatch(/^[0-9a-f]{256}$/);
    expect(f.counter).toBeGreaterThanOrEqual(10);
  });

  it("offers the P-256 point once a gateway info came as version 8, whatever its cipher, and the 1003 shrinks to [u32]", () => {
    const { session, frame } = connected();
    (session as unknown as { negotiateLevel2Key(b: Buffer, v: number): void }).negotiateLevel2Key(Buffer.alloc(4), 8);
    session.sendFrame(START_1003, 3, "user");
    expect(frame().plain).toEqual(Buffer.from([3, 0, 0, 0]));
    expect(session.mediaEccPrivateKey).toHaveLength(32);
  });

  it("offers the P-256 point for an ability of 128 up, else the RSA modulus", () => {
    const { session, frame } = connected();
    session.sendFrame(START_1700, 0, "user", 127);
    expect(JSON.parse(frame().plain.toString().replace(/\0+$/, "")).data.encryptkey).toHaveLength(256);
    session.sendFrame(START_1700, 0, "user", 128);
    expect(JSON.parse(frame().plain.toString().replace(/\0+$/, "")).data.encryptkey).toHaveLength(128);
  });

  it("wraps a 1700 as {commandType, data} with byte 14 at 0 when the frame carries no counter", () => {
    const { session, frame } = connected();
    session.sendFrame(START_1700, 2, "user");
    const f = frame();
    expect([f.cmd, f.channel, f.counter]).toEqual([1700, 2, 0]);
    expect(JSON.parse(f.plain.toString().replace(/\0+$/, ""))).toMatchObject({
      commandType: 1000,
      data: { cmd: 1000, mChannel: 2, account_id: "user" },
    });
  });

  it("sends a 1350 params-as-body as the payload itself on its mChannel, counter bumped", () => {
    const { session, frame } = connected();
    session.sendFrame(START_1350, 5, "user");
    const f = frame();
    expect([f.cmd, f.channel]).toEqual([1350, 5]);
    expect(f.counter).toBeGreaterThanOrEqual(10);
    const body = JSON.parse(f.plain.toString().replace(/\0+$/, ""));
    expect(Object.keys(body)).toEqual(["cmd", "mChannel", "account_id", "mValue3", "payload"]);
    expect(body).toMatchObject({ cmd: 1003, mChannel: 5, account_id: "user", mValue3: 1003 });
  });

  it("envelopes a json1350 stop as {account_id, cmd, mChannel, mValue3, payload}", () => {
    const { session, frame } = connected();
    session.sendFrame(STOP_1350, 5, "user");
    const f = frame();
    expect(f.counter).toBe(0);
    expect(JSON.parse(f.plain.toString().replace(/\0+$/, ""))).toMatchObject({
      account_id: "user",
      cmd: 1004,
      mChannel: 5,
      mValue3: 0,
      payload: { channel: 5 },
    });
  });

  it("sends a u32-ch body as the channel alone, retained until acknowledged", () => {
    const { session, frame } = connected();
    session.sendFrame({ cmd: 1004, body: "native", payload: {}, layout: "u32-ch" }, 4);
    expect(frame().plain).toEqual(Buffer.from([4, 0, 0, 0]));
    expect((session as unknown as { unackedCommands: Map<number, Buffer> }).unackedCommands.size).toBe(1);
  });
});
