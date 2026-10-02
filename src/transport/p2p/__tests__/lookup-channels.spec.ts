import dgram from "node:dgram";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { P2PSession, type P2PSessionConfig } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { RequestMessageType, ResponseMessageType, frameMessage, hasHeader } from "../codec.js";

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

  it("counts the cloud channel only where both a key and an address to ask are held, naming the one missing", async () => {
    expect(await channelsTraced({ dskKey: "0".repeat(40) })).toMatchObject({
      cloud: false,
      cloudMissing: "cloud-addresses",
    });
    expect(await channelsTraced({ cloudAddresses: [{ host: "192.0.2.2", port: 32100 }] })).toMatchObject({
      cloud: false,
      cloudMissing: "dsk-key",
    });
    expect(await channelsTraced({})).toMatchObject({ cloud: false, cloudMissing: "dsk-key" });
    const both = await channelsTraced({
      dskKey: "0".repeat(40),
      cloudAddresses: [{ host: "192.0.2.2", port: 32100 }],
    });
    expect(both).toMatchObject({ cloud: true });
    expect(both).not.toHaveProperty("cloudMissing");
  });
});

/** Bind a local UDP peer for the connection test. */
async function peer(port = 0): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  socket.bind(port, "127.0.0.1");
  try {
    await once(socket, "listening");
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

/** A port can be rebound once its lookup socket has closed. */
async function rebind(port: number): Promise<void> {
  const socket = dgram.createSocket("udp4");
  try {
    socket.bind(port, "127.0.0.1");
    await once(socket, "listening");
  } finally {
    socket.close();
  }
}

describe("cloud lookup source ports", () => {
  it.each([1, 2])("connects on registered port %i and releases every losing source port", async (winnerOrdinal) => {
    const cloud = await peer();
    const station = await peer();
    const cloudPort = cloud.address().port;
    const stationPort = station.address().port;
    const lookupPorts = new Set<number>();
    const checkPorts = new Set<number>();
    const payload = Buffer.alloc(8);
    payload.writeUInt16LE(stationPort, 2);
    payload.set([1, 0, 0, 127], 4);
    const candidate = frameMessage(ResponseMessageType.LOOKUP_ADDR, payload);
    const camId = frameMessage(ResponseMessageType.CAM_ID);
    let selectedPort: number | undefined;
    let pingPort: number | undefined;
    const connected = vi.fn();
    /** Occupy the hole-punch neighbourhood so sequential ephemeral ports cannot hit lookup sockets. */
    const neighbours: dgram.Socket[] = [];
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(40),
      cloudAddresses: [{ host: "127.0.0.1", port: cloudPort }],
      localAddress: "192.0.2.1",
      noBroadcast: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    session.on("error", () => undefined);
    session.on("connect", connected);
    cloud.on("message", (msg, remote) => {
      if (!hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY) && !hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2))
        return;
      lookupPorts.add(remote.port);
      if (lookupPorts.size === 8 && selectedPort === undefined) {
        selectedPort = [...lookupPorts][winnerOrdinal - 1];
        cloud.send(candidate, selectedPort, remote.address);
      }
    });
    station.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.CHECK_CAM)) {
        checkPorts.add(remote.port);
        station.send(camId, remote.port, remote.address);
      }
      if (hasHeader(msg, RequestMessageType.PING)) pingPort = remote.port;
    });
    try {
      for (let port = Math.max(1, stationPort - 3); port <= Math.min(65535, stationPort + 3); port++) {
        if (port === stationPort || port === cloudPort) continue;
        try {
          neighbours.push(await peer(port));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        }
      }
      await session.connect();
      await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
      expect(lookupPorts.size).toBe(8);
      expect(checkPorts).toEqual(new Set([selectedPort]));
      await vi.waitFor(() => expect(pingPort).toBe(selectedPort));
      for (const port of lookupPorts) {
        if (port !== selectedPort) await rebind(port);
      }
    } finally {
      await session.close();
      cloud.close();
      station.close();
      for (const socket of neighbours) socket.close();
    }
  });
});
