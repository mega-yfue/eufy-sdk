import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { frameMessage, RequestMessageType, ResponseMessageType } from "../../transport/p2p/codec.js";
import { P2PSession } from "../../transport/p2p/p2p-session.js";

const STATION_SN = "T8000P0000000000";

describe("station peer restriction", () => {
  it("passes the facade option through the router before punching a cloud candidate", async () => {
    const lanOnly = vi.fn(() => true);
    const client = new EufyMega({
      email: "account@example.invalid",
      password: "synthetic",
      countryCode: "US",
      lanOnly,
    });
    const internals = client as unknown as {
      registry: { list: () => unknown[] };
      mega: { getDskKeys: () => Promise<unknown> };
      p2p: { prewarm: (stationSn: string, ms: number) => Promise<void>; closeAll: () => Promise<void> };
    };
    vi.spyOn(internals.registry, "list").mockReturnValue([
      { sn: STATION_SN, stationSn: STATION_SN, p2pDid: "XXXXXXX-000000-XXXXX", raw: {} },
    ]);
    vi.spyOn(internals.mega, "getDskKeys").mockResolvedValue({});
    const connect = vi.spyOn(P2PSession.prototype, "connect").mockResolvedValue();

    try {
      await internals.p2p.prewarm(STATION_SN, 60_000);
      const session = client.getP2pSessions().get(STATION_SN);
      expect(session).toBeDefined();
      expect(lanOnly).toHaveBeenCalledWith(STATION_SN);
      const sent: Buffer[] = [];
      const target = session as unknown as {
        onMessage: (message: Buffer, info: { address: string; port: number }) => void;
        send: (address: { host: string; port: number }, type: Buffer) => void;
      };
      target.send = (_address, type) => sent.push(type);
      const candidate = Buffer.alloc(8);
      candidate.writeUInt16LE(4000, 2);
      candidate.set([9, 113, 0, 203], 4);
      target.onMessage(frameMessage(ResponseMessageType.LOOKUP_ADDR, candidate), {
        address: "203.0.113.1",
        port: 32100,
      });

      expect(sent.some((type) => type.equals(RequestMessageType.CHECK_CAM))).toBe(false);
    } finally {
      await internals.p2p.closeAll();
      connect.mockRestore();
    }
  });
});
