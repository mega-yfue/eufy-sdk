import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

describe("P2P CAM_ADDR", () => {
  it("does not trace the device's address record as UNHANDLED, and still traces an unmodelled type", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX", logger });
    const internals = session as unknown as { socket: unknown; onMessage(msg: Buffer, rinfo: object): void };
    internals.socket = { send: vi.fn() };
    internals.onMessage(Buffer.from([0xf1, 0x43, 0x00, 0x00]), { address: "<cam-lan-ip>", port: 32100 });
    internals.onMessage(Buffer.from([0xf1, 0x99, 0x00, 0x00]), { address: "<cam-lan-ip>", port: 32100 });
    const unhandled = logger.debug.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("UNHANDLED"));
    expect(unhandled).toEqual([expect.stringContaining("f1990000")]);
  });
});
