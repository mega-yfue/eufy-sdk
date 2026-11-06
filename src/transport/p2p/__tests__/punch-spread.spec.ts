import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

const socket = { send: vi.fn(), address: () => ({ port: 5000 }) };

function punch(punchSpread: number | undefined, host = "203.0.113.7", port = 40000): number[] {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX", punchSpread });
  const internals = session as unknown as {
    send(addr: { port: number }): void;
    beginCheckCam(addr: object, socket: object): void;
  };
  const ports: number[] = [];
  internals.send = (addr) => ports.push(addr.port);
  internals.beginCheckCam({ host, port }, socket);
  return ports.sort((a, b) => a - b);
}

describe("P2P punch spread", () => {
  afterEach(() => vi.useRealTimers());

  it("covers the reported port +/-3 by default", () => {
    expect(punch(undefined)).toEqual([39997, 39998, 39999, 40000, 40001, 40002, 40003]);
  });

  it("covers every port up to the spread on a public address", () => {
    const ports = punch(10);
    expect(ports).toHaveLength(21);
    expect(ports[0]).toBe(39990);
    expect(ports.at(-1)).toBe(40010);
  });

  it("leaves a private address to the neighbourhood", () => {
    expect(punch(10, "192.168.1.20")).toHaveLength(7);
  });

  it("stays inside the valid port range", () => {
    expect(punch(10, "203.0.113.7", 65530).every((port) => port < 65536)).toBe(true);
    expect(punch(10, "203.0.113.7", 4).every((port) => port > 0)).toBe(true);
  });

  it("sweeps once a second per address and socket", () => {
    vi.useFakeTimers();
    const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX", punchSpread: 10 });
    const internals = session as unknown as {
      send(addr: { port: number }): void;
      beginCheckCam(addr: object, socket: object): void;
    };
    let sent = 0;
    internals.send = () => (sent += 1);
    const addr = { host: "203.0.113.7", port: 40000 };
    internals.beginCheckCam(addr, socket);
    internals.beginCheckCam(addr, socket);
    expect(sent).toBe(21 + 7);
    vi.advanceTimersByTime(1000);
    internals.beginCheckCam(addr, socket);
    expect(sent).toBe(21 + 7 + 21);
  });
});
