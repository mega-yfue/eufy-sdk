import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/** A datagram too short for its header's fields is dropped instead of throwing out of the socket listener. */
function session(connected: boolean) {
  const built = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const internals = built as unknown as {
    socket: { send: ReturnType<typeof vi.fn> };
    connected: boolean;
    onMessage(msg: Buffer, rinfo: object): void;
  };
  internals.socket = { send: vi.fn() };
  internals.connected = connected;
  return internals;
}

describe("a short P2P datagram", () => {
  it("is dropped unacknowledged when a DATA datagram ends before its sequence number", () => {
    const internals = session(true);
    expect(() =>
      internals.onMessage(Buffer.from([0xf1, 0xd0, 0x00, 0x02, 0xd1, 0x01]), { address: "<cam-lan-ip>", port: 32100 }),
    ).not.toThrow();
    expect(internals.socket.send).not.toHaveBeenCalled();
  });

  it("is dropped when a LOOKUP_ADDR ends before its address record", () => {
    const internals = session(false);
    expect(() =>
      internals.onMessage(Buffer.from([0xf1, 0x40, 0x00, 0x00]), { address: "<cam-lan-ip>", port: 32100 }),
    ).not.toThrow();
    expect(internals.socket.send).not.toHaveBeenCalled();
  });
});
