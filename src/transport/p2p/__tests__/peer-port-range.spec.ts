import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * A session over a socket whose `send` refuses a port outside 1..65535 by throwing synchronously, as Node's
 * dgram `send` does (`ERR_SOCKET_BAD_PORT`), and records the ports it accepted.
 */
function session() {
  const built = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const ports: number[] = [];
  const internals = built as unknown as {
    socket: { send: (packet: Buffer, port: number) => void };
    connected: boolean;
    onMessage(msg: Buffer, rinfo: object): void;
  };
  internals.socket = {
    send: (_packet, port) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw Object.assign(new RangeError(`Port should be > 0 and < 65536. Received ${port}.`), {
          code: "ERR_SOCKET_BAD_PORT",
        });
      }
      ports.push(port);
    },
  };
  internals.connected = false;
  return { internals, ports };
}

/** A message of type `type` naming 192.0.2.1 (a documentation address) on `port` at byte `at`. */
function addressed(type: number, port: number, at = 4): Buffer {
  const msg = Buffer.alloc(24);
  msg.set([0xf1, type, 0x00, 0x14]);
  msg.writeUInt16LE(port, at + 2);
  msg.set([1, 2, 0, 192], at + 4);
  return msg;
}

const LOOKUP_ADDR = 0x40;
const RLY_TO = 0x82;
const rinfo = { address: "<cam-lan-ip>", port: 32100 };

describe("a peer-reported address on a port Node cannot send to", () => {
  it("punches only the ports of a lookup address's neighbourhood that exist", () => {
    const { internals, ports } = session();
    expect(() => internals.onMessage(addressed(LOOKUP_ADDR, 65534), rinfo)).not.toThrow();
    expect(ports).toEqual([65534, 65531, 65532, 65533, 65535]);
  });

  it("skips a lookup address's port 0 instead of throwing", () => {
    const { internals, ports } = session();
    expect(() => internals.onMessage(addressed(LOOKUP_ADDR, 0), rinfo)).not.toThrow();
    expect(ports).not.toContain(0);
  });

  it("skips a relay named on port 0 instead of throwing", () => {
    const { internals, ports } = session();
    expect(() => internals.onMessage(addressed(RLY_TO, 0), rinfo)).not.toThrow();
    expect(ports).toEqual([]);
  });

  it("still punches a lookup address's port and its three neighbours on each side", () => {
    const { internals, ports } = session();
    internals.onMessage(addressed(LOOKUP_ADDR, 40000), rinfo);
    expect(ports).toEqual([40000, 39997, 39998, 39999, 40001, 40002, 40003]);
  });
});
