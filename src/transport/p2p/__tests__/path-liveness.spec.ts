import type dgram from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { ResponseMessageType, frameMessage } from "../codec.js";

/**
 * A connected peer's CAM_ID, PONG, PING, ACK or DATA establishes path liveness.
 *
 * The heartbeat checks for an answer after three heartbeat periods and signals a stale path. Traffic from the
 * connected peer keeps the path alive even when an individual PONG is lost. A session that has not yet received
 * any peer answer has no basis for declaring its path stale.
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
    heartbeat: () => void;
    socket: dgram.Socket;
  };
  internals.connectAddress = { host: "203.0.113.1", port: 32100 };
  internals.connected = true;
  internals.socket = { send: vi.fn() } as unknown as dgram.Socket;
  return { built, internals, debug };
}

const traces = (debug: ReturnType<typeof vi.fn>) =>
  debug.mock.calls.filter(([message]) => message === LIVE_TRACE_MESSAGE).map(([, trace]) => trace);

/** Deliver a framed peer packet without binding a UDP port. */
function receive(built: P2PSession, type: Buffer, address: string, port = 32100, socket?: dgram.Socket): void {
  const target = built as unknown as {
    socket: dgram.Socket;
    onMessage: (msg: Buffer, remote: { address: string; port: number }, socket: dgram.Socket) => void;
  };
  target.onMessage(frameMessage(type), { address, port }, socket ?? target.socket);
}

describe("a session's path liveness", () => {
  it("is unknown until the peer has answered, so silence proves nothing yet", () => {
    const { built } = session();
    expect(built.pathSilentMs).toBeUndefined();
  });

  it("is measured from the last answer once one has arrived", () => {
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

  it("counts traffic from the connected peer even when no PONG arrives", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    receive(built, ResponseMessageType.PING, "203.0.113.1");
    expect(built.pathAnswering).toBe(true);
  });

  it("accepts a peer PING as path evidence but ignores one from another endpoint", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    receive(built, ResponseMessageType.PING, "203.0.113.2");
    receive(built, ResponseMessageType.PONG, "203.0.113.1", 32101);
    expect(built.pathAnswering).toBe(false);
    receive(built, ResponseMessageType.PING, "203.0.113.1");
    expect(built.pathAnswering).toBe(true);
  });

  it("ignores traffic from the same endpoint on a socket that lost the handshake", () => {
    const { built, internals } = session();
    internals.lastPeerAt = Date.now() - 16_000;
    const losingSocket = { send: vi.fn() } as unknown as dgram.Socket;
    receive(built, ResponseMessageType.PING, "203.0.113.1", 32100, losingSocket);
    expect(built.pathAnswering).toBe(false);
    receive(built, ResponseMessageType.PING, "203.0.113.1");
    expect(built.pathAnswering).toBe(true);
  });

  it("signals a previously answering path that remains silent at a heartbeat", () => {
    const { built, internals } = session();
    const stale = vi.fn();
    built.on("pathStale", stale);
    internals.lastPeerAt = Date.now() - 16_000;
    internals.heartbeat();
    expect(stale).toHaveBeenCalledOnce();
    internals.lastPeerAt = Date.now();
    internals.heartbeat();
    expect(stale).toHaveBeenCalledOnce();
  });

  it("answers that a path which never answered is not known to be dead", () => {
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
