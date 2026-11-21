import type dgram from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { ResponseMessageType, frameMessage } from "../codec.js";

/**
 * The app's CS2 alive (`cs2p2p_PPPP_thread_recv_DRW`): an ALIVE after each second nothing arrived from the peer,
 * the session closed as timed out once more than six go unanswered, anything received resetting the count.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function session() {
  const debug = vi.fn();
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const internals = built as unknown as {
    connectAddress?: { host: string; port: number };
    lastPeerAt?: number;
    connected: boolean;
    socket: dgram.Socket;
    lastPongData?: Buffer;
  };
  internals.connectAddress = { host: "203.0.113.1", port: 32100 };
  internals.connected = true;
  internals.socket = { send: vi.fn() } as unknown as dgram.Socket;
  return { built, internals, debug };
}

/** Deliver a framed packet without binding a UDP port. */
function receive(built: P2PSession, type: Buffer, address: string, port = 32100, payload?: Buffer): void {
  const target = built as unknown as {
    socket: dgram.Socket;
    onMessage: (msg: Buffer, remote: { address: string; port: number }, socket: dgram.Socket) => void;
  };
  target.onMessage(frameMessage(type, payload), { address, port }, target.socket);
}

describe("a session's liveness, as the app's CS2 alive", () => {
  it("sends an ALIVE after a second of silence and closes after more than six go unanswered", async () => {
    vi.useFakeTimers();
    try {
      const { built, internals } = session();
      const close = vi.spyOn(built, "close").mockResolvedValue(undefined);
      internals.connected = false;
      (built as unknown as { onConnected(a: object, s: dgram.Socket): void }).onConnected(
        internals.connectAddress!,
        internals.socket,
      );
      const alives = () =>
        vi
          .mocked(internals.socket.send)
          .mock.calls.filter(
            ([b]) => Buffer.isBuffer(b) && (b as Buffer).subarray(0, 2).equals(Buffer.from([0xf1, 0xe0])),
          ).length;
      const before = alives();
      await vi.advanceTimersByTimeAsync(3_000);
      receive(built, ResponseMessageType.PONG, "203.0.113.1");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(close).not.toHaveBeenCalled();
      expect(alives() - before).toBe(9);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces each selected-peer answer with the time it was heard", () => {
    const { built, internals } = session();
    const heard: number[] = [];
    built.on("peerAnswer", (atMs: number) => heard.push(atMs));
    const handlers = built as unknown as { onAck: () => void };
    handlers.onAck = vi.fn();
    receive(built, ResponseMessageType.PONG, "203.0.113.1");
    receive(built, ResponseMessageType.ACK, "203.0.113.1");
    receive(built, ResponseMessageType.PONG, "203.0.113.2");
    expect(heard).toHaveLength(2);
    expect(heard[1]).toBe(internals.lastPeerAt);
  });
});
