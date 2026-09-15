import { describe, expect, it, vi } from "vitest";
import { P2PSession, type P2PSessionConfig } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";

/**
 * A connect states which lookup channels it can ask on, before it asks.
 *
 * A station is asked for locally and in the cloud, and the cloud ask needs a key for the station plus an
 * address to send it to — neither of which the session obtains itself. Where they are absent the connect falls
 * back to the local ask alone, silently, and its expiry is then indistinguishable from a station that is
 * switched off: both end as an unanswered lookup after the same wait, and one is a network to look at while
 * the other is an account that never supplied the key.
 *
 * Configuration, so it is known before the first datagram and stated once per connect rather than per retry.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

async function channelsTraced(cfg: Partial<P2PSessionConfig>) {
  const debug = vi.fn();
  const session = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    noBroadcast: true,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...cfg,
  });
  session.on("error", () => undefined);
  await session.connect();
  await session.close();
  return debug.mock.calls
    .filter(([message]) => message === LIVE_TRACE_MESSAGE)
    .map(([, trace]) => trace)
    .find((trace) => trace.phase === "lookup-channels");
}

describe("the lookup channels a connect can ask on", () => {
  it("states that neither channel is available, which no later phase does", async () => {
    expect(await channelsTraced({})).toMatchObject({ local: false, cloud: false });
  });

  it("counts a known LAN address as the local channel where the broadcast is suppressed", async () => {
    expect(await channelsTraced({ localAddress: "192.0.2.1" })).toMatchObject({ local: true, cloud: false });
  });

  it("counts the cloud channel only where both a key and an address to ask are held", async () => {
    expect(await channelsTraced({ dskKey: "0".repeat(40) })).toMatchObject({ cloud: false });
    expect(await channelsTraced({ cloudAddresses: [{ host: "192.0.2.2", port: 32100 }] })).toMatchObject({
      cloud: false,
    });
    expect(
      await channelsTraced({ dskKey: "0".repeat(40), cloudAddresses: [{ host: "192.0.2.2", port: 32100 }] }),
    ).toMatchObject({ cloud: true });
  });
});
