import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { P2PSession } from "../../transport/p2p/p2p-session.js";
import { isPrivateIpv4 } from "../../transport/p2p/lan-ip.js";

const STATION_SN = "T8000P0000000000";

describe("station peer selection", () => {
  it("passes the facade's decision through the router to the station session", async () => {
    const acceptP2PPeer = vi.fn((_stationSn: string, peer: { readonly host: string }) => isPrivateIpv4(peer.host));
    const client = new EufyMega({
      email: "account@example.invalid",
      password: "synthetic",
      countryCode: "US",
      acceptP2PPeer,
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
      const { acceptPeer } = (
        session as unknown as {
          cfg: { acceptPeer: (peer: { host: string; port: number }) => boolean };
        }
      ).cfg;
      expect(acceptPeer({ host: "203.0.113.9", port: 4000 })).toBe(false);
      expect(acceptPeer({ host: "192.168.1.50", port: 4000 })).toBe(true);
      expect(acceptP2PPeer).toHaveBeenCalledWith(STATION_SN, { host: "203.0.113.9", port: 4000 });
    } finally {
      await internals.p2p.closeAll();
      connect.mockRestore();
    }
  });
});
