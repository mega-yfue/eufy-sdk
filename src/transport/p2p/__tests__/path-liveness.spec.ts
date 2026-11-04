import type dgram from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { ResponseMessageType, frameMessage } from "../codec.js";

/**
 * A measured wired-camera run had an 18 s idle interval, twenty unacknowledged retransmits on resume,
 * and an immediately streaming rebuilt session.
 *
 * PONG and ACK on the selected peer path refresh outbound liveness. Three silent heartbeat periods signal a
 * stale path once a reply has arrived; a path with no post-connect reply remains unknown.
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

const traces = (debug: ReturnType<typeof vi.fn>) =>
  debug.mock.calls.filter(([message]) => message === LIVE_TRACE_MESSAGE).map(([, trace]) => trace);

/** Deliver a framed packet without binding a UDP port. */
function receive(built: P2PSession, type: Buffer, address: string, port = 32100, payload?: Buffer): void {
  const target = built as unknown as {
    socket: dgram.Socket;
    onMessage: (msg: Buffer, remote: { address: string; port: number }, socket: dgram.Socket) => void;
  };
  target.onMessage(frameMessage(type, payload), { address, port }, target.socket);
}

describe("a session's path liveness", () => {
  it("is unknown until the selected peer answers after connection", () => {
    const { built } = session();
    expect(built.pathSilentMs).toBeUndefined();
  });

  it("is measured from the last selected-peer reply once one has arrived", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 12_000;
    expect(built.pathSilentMs).toBeGreaterThanOrEqual(12_000);
  });

  it("answers that a path which has answered recently is alive", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 1_000;
    expect(built.pathAnswering).toBe(true);
  });

  it("answers that a path silent past three heartbeats is not", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    expect(built.pathAnswering).toBe(false);
  });

  it("keeps a path alive on a selected-peer ACK even without a PONG", () => {
    vi.useFakeTimers();
    try {
      const { built } = session();
      const handlers = built as unknown as { onAck: () => void };
      handlers.onAck = vi.fn();
      receive(built, ResponseMessageType.PONG, "203.0.113.1");
      vi.advanceTimersByTime(16_000);
      expect(built.pathAnswering).toBe(false);
      receive(built, ResponseMessageType.ACK, "203.0.113.1");
      expect(built.pathAnswering).toBe(true);
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

  it("does not count another endpoint as the selected peer", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    receive(built, ResponseMessageType.PONG, "203.0.113.2");
    receive(built, ResponseMessageType.PONG, "203.0.113.1", 32101);
    expect(built.pathAnswering).toBe(false);
  });

  it("retains PONG cookies without counting a pre-connect or other endpoint as path evidence", () => {
    const { built, internals } = session();
    const cookie = Buffer.from("synthetic-cookie");
    internals.connected = false;
    receive(built, ResponseMessageType.PONG, "203.0.113.1", 32100, cookie);
    expect(built.pathSilentMs).toBeUndefined();
    internals.connected = true;
    expect(internals.lastPongData).toEqual(cookie);
    const nextCookie = Buffer.from("another-synthetic-cookie");
    receive(built, ResponseMessageType.PONG, "203.0.113.2", 32100, nextCookie);
    expect(internals.lastPongData).toEqual(nextCookie);
    expect(built.pathSilentMs).toBeUndefined();
  });

  it("answers that a path with no post-connect reply is not known to be dead", () => {
    const { built } = session();
    expect(built.pathAnswering).toBe(true);
  });

  it("states the silence once, rather than on every heartbeat", () => {
    const { built, internals, debug } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    void built.pathAnswering;
    void built.pathAnswering;
    const stale = traces(debug).filter((t) => (t as { phase: string }).phase === "path-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ phase: "path-stale" });
  });
});
