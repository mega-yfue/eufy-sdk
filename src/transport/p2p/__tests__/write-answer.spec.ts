import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandResultError } from "../../../core/contracts.js";
import { buildAckPayload, frameMessage, P2PDataTypeHeader, ResponseMessageType } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { connectedSession, routerWithSession, DEVICE_SN, STATION_SN } from "./session-fixtures.js";

const P2P_DID = "XXXXXXX-000000-XXXXX";

/** The device channel the shared fixture records for `DEVICE_SN`. */
const CHANNEL = 1;
/** A direct-binary setting: the outer command is the param id, and the device answers under it. */
const PARAM = 1035;

/**
 * A keyed station whose device answers each direct-binary send with the next code in `codes`, under the
 * write's command id on its channel. An exhausted list answers nothing.
 */
function station(...codes: number[]) {
  const session = Object.assign(connectedSession(), {
    sendRawLevel2Bytes: vi.fn((_body: Buffer, channel: number, commandId: number) => {
      const code = codes.shift();
      if (code !== undefined) queueMicrotask(() => session.emit("commandResult", { code, channel, commandId }));
      return true;
    }),
  });
  return { session, router: routerWithSession(session) };
}

const write = { kind: "set-param", param: PARAM, value: 1, form: "direct-binary", channel: CHANNEL } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("a level-2 setting write settles on the device's answer", () => {
  it("resolves on success, sent once", async () => {
    const { router, session } = station(0);
    await router.dispatchCommand(DEVICE_SN, write);
    expect(session.sendRawLevel2Bytes).toHaveBeenCalledTimes(1);
  });

  it("rejects a refusal with the device's code", async () => {
    const { router } = station(-108);
    const error = await router.dispatchCommand(DEVICE_SN, write).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandResultError);
    expect(error).toMatchObject({ sn: DEVICE_SN, commandId: PARAM, code: -108 });
  });

  it("does not read another command's answer, or another channel's", async () => {
    const { router, session } = station();
    session.sendRawLevel2Bytes.mockImplementationOnce(() => {
      queueMicrotask(() => {
        session.emit("commandResult", { code: -108, channel: CHANNEL, commandId: 1700 });
        session.emit("commandResult", { code: -108, channel: CHANNEL + 1, commandId: PARAM });
        session.emit("commandResult", { code: 0, channel: CHANNEL, commandId: PARAM });
      });
      return true;
    });
    await expect(router.dispatchCommand(DEVICE_SN, write)).resolves.toBe(true);
  });

  it("does not settle on a frame that carries no code", async () => {
    const { router, session } = station();
    session.sendRawLevel2Bytes.mockImplementationOnce(() => {
      queueMicrotask(() => {
        session.emit("data", { channel: CHANNEL, commandId: PARAM, json: undefined });
        session.emit("commandResult", { code: -108, channel: CHANNEL, commandId: PARAM });
      });
      return true;
    });
    await expect(router.dispatchCommand(DEVICE_SN, write)).rejects.toMatchObject({ code: -108 });
  });

  it("resends once on a code the vendor app retries", async () => {
    const { router, session } = station(5, 0);
    await router.dispatchCommand(DEVICE_SN, write);
    expect(session.sendRawLevel2Bytes).toHaveBeenCalledTimes(2);
  });

  it("does not settle a write on the late answer to the one before it", async () => {
    const { router, session } = station();
    session.sendRawLevel2Bytes.mockImplementation((body: Buffer, channel: number, commandId: number) => {
      const code = body.readUInt32LE(4) === 1 ? 0 : -108;
      setTimeout(() => session.emit("commandResult", { code, channel, commandId }), 300);
      return true;
    });
    const accepted = router.dispatchCommand(DEVICE_SN, write);
    const refused = router.dispatchCommand(DEVICE_SN, { ...write, value: 2 }).catch((e: unknown) => e);
    await accepted;
    expect(await refused).toMatchObject({ code: -108 });
  });

  it("settles a level-1 control write on its answer too", async () => {
    const session = Object.assign(connectedSession(false), {
      sendStringPayloadCommand: vi.fn((commandId: number, _json: string, channel: number) =>
        queueMicrotask(() => session.emit("commandResult", { code: -108, channel, commandId })),
      ),
    });
    const error = await routerWithSession(session)
      .dispatchCommand(DEVICE_SN, { kind: "set-json", param: 6014, data: { value: 0 }, channel: CHANNEL })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ commandId: 1700, code: -108 });
    expect(session.sendStringPayloadCommand).toHaveBeenCalledTimes(1);
  });

  it("sends on a fresh session when the one it resolved closed before the send", async () => {
    const closing = Object.assign(connectedSession(false), {
      isClosed: false,
      close: vi.fn(async () => {}),
      sendStringPayloadCommand: vi.fn(() => {
        throw new Error("P2P session is not connected");
      }),
    });
    closing.awaitLevel2Key.mockImplementation(async () => {
      closing.isClosed = true;
      closing.isConnected = false;
      return false;
    });
    const fresh = Object.assign(connectedSession(false), {
      sendStringPayloadCommand: vi.fn((commandId: number, _json: string, channel: number) =>
        queueMicrotask(() => fresh.emit("commandResult", { code: 0, channel, commandId })),
      ),
    });
    const router = routerWithSession(closing);
    const target = router as unknown as {
      manager: { get(key: string): unknown; register(key: string, session: unknown): void };
      openSession(key: string): Promise<unknown>;
    };
    target.openSession = async (key) => {
      if (!target.manager.get(key)) target.manager.register(key, fresh);
      return target.manager.get(key);
    };
    await router.dispatchCommand(DEVICE_SN, { kind: "set-json", param: 6014, data: { value: 0 }, channel: CHANNEL });
    expect(closing.sendStringPayloadCommand).not.toHaveBeenCalled();
    expect(fresh.sendStringPayloadCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects with no code when the device never answers", async () => {
    vi.useFakeTimers();
    const { router } = station();
    const outcome = router.dispatchCommand(DEVICE_SN, write).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(CommandResultError);
    expect(error).toMatchObject({ commandId: PARAM, code: undefined, timeoutMs: 30_000 });
  });
});

/** A connected session whose socket captures each datagram handed to it. */
function session() {
  const real = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const socket = { send: vi.fn() };
  const target = real as unknown as { connectAddress: unknown; socket: unknown; onAck(m: Buffer): void };
  target.connectAddress = { host: "127.0.0.1", port: 1 };
  target.socket = socket;
  return {
    real,
    sent: () => socket.send.mock.calls.map((c) => c[0] as Buffer),
    acknowledge: (sequence: number) =>
      target.onAck(frameMessage(ResponseMessageType.ACK, buildAckPayload(P2PDataTypeHeader.DATA, sequence))),
  };
}

describe("an acknowledged send", () => {
  it("repeats the same datagram, under its own sequence, until the device acknowledges it", () => {
    vi.useFakeTimers();
    const { real, sent, acknowledge } = session();
    real.sendAcknowledged(() => real.sendRawLevel1Bytes(Buffer.alloc(8), CHANNEL, PARAM));
    vi.advanceTimersByTime(400);
    const [first, ...repeats] = sent();
    expect(repeats.length).toBeGreaterThan(0);
    for (const repeat of repeats) expect(repeat.equals(first!)).toBe(true);
    acknowledge(first!.readUInt16BE(6));
    const count = sent().length;
    vi.advanceTimersByTime(1_000);
    expect(sent()).toHaveLength(count);
  });
});
