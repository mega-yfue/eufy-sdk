import dgram from "node:dgram";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RequestMessageType, hasHeader } from "../codec.js";

/**
 * A lookup server named by hostname is resolved once per connect, and every lookup and relay datagram goes to
 * the resolved address. Sending each datagram to the hostname costs one `dns.lookup` per datagram, on the
 * threadpool HTTP requests resolve on too.
 */
const lookup = vi.fn(async (_host: string, _opts: object) => ({ address: "127.0.0.1", family: 4 }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: (host: string, opts: object) => lookup(host, opts),
}));

const { P2PSession } = await import("../p2p-session.js");

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

async function peer(): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return socket;
}

async function elapse(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("lookup servers named by hostname", () => {
  it("are resolved once per connect, and the lookups go to the resolved address", async () => {
    const cloud = await peer();
    let lookups = 0;
    cloud.on("message", (msg) => {
      if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY) || hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2))
        lookups++;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [
        { host: "p2p-lookup.invalid", port: cloud.address().port },
        { host: "127.0.0.1", port: cloud.address().port },
      ],
      noBroadcast: true,
    });
    session.on("error", () => undefined);
    try {
      await session.connect();
      await elapse(5_000);
      expect(lookup.mock.calls.map(([host]) => host)).toEqual(["p2p-lookup.invalid"]);
      expect(lookups).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
    }
  }, 20_000);
});
