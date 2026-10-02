import type dgram from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { frameMessage, ResponseMessageType, RequestMessageType } from "../codec.js";
import { isPrivateIpv4 } from "../lan-ip.js";
import { CONNECT_TIMEOUT_MS, P2PSession, type P2PSessionConfig } from "../p2p-session.js";

/**
 * An RFC-1918 restriction rejects a public cloud candidate before CHECK_CAM and refuses an unsolicited
 * public CAM_ID before connecting.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

const privatePeer: NonNullable<P2PSessionConfig["acceptPeer"]> = (peer) => isPrivateIpv4(peer.host);

function harness(acceptPeer?: P2PSessionConfig["acceptPeer"], cloudAddress?: string) {
  const warn = vi.fn();
  const debug = vi.fn();
  const session = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    acceptPeer,
    dskKey: cloudAddress ? "0".repeat(40) : undefined,
    cloudAddresses: cloudAddress ? [{ host: cloudAddress, port: 32100 }] : undefined,
    logger: { debug, info: vi.fn(), warn, error: vi.fn() },
  });
  session.on("error", () => undefined);
  const sent: { addr: { host: string; port: number }; type: Buffer; socket?: dgram.Socket }[] = [];
  const target = session as unknown as {
    onMessage: (message: Buffer, info: { address: string; port: number }, socket?: dgram.Socket) => void;
    send: (addr: { host: string; port: number }, type: Buffer, payload?: Buffer, socket?: dgram.Socket) => void;
  };
  target.send = (addr, type, _payload, socket) => sent.push({ addr, type, socket });
  return {
    session,
    sent,
    warn,
    debug,
    lookupAddress: (host: string, port = 4000) => {
      const payload = Buffer.alloc(8);
      payload.writeUInt16LE(port, 2);
      payload.set(host.split(".").map(Number).reverse(), 4);
      target.onMessage(frameMessage(ResponseMessageType.LOOKUP_ADDR, payload), { address: "203.0.113.1", port: 32100 });
    },
    /** A station answering our CHECK_CAM from `host` — the moment a peer would be kept. */
    answerFrom: (host: string, port = 4000, socket?: dgram.Socket) =>
      target.onMessage(frameMessage(ResponseMessageType.CAM_ID), { address: host, port }, socket),
  };
}

describe("selecting a P2P peer by host decision", () => {
  it("asks a public cloud broker while punching only a private candidate", async () => {
    const broker = "192.0.2.2";
    const { session, lookupAddress, sent } = harness(privatePeer, broker);
    try {
      await session.connect();
      expect(
        sent.some(
          ({ addr, type }) =>
            addr.host === broker &&
            (type.equals(RequestMessageType.LOOKUP_WITH_KEY) || type.equals(RequestMessageType.LOOKUP_WITH_KEY2)),
        ),
      ).toBe(true);

      lookupAddress("203.0.113.9");
      expect(
        sent.some(({ addr, type }) => addr.host === "203.0.113.9" && type.equals(RequestMessageType.CHECK_CAM)),
      ).toBe(false);

      lookupAddress("192.168.1.50");
      expect(
        sent.some(({ addr, type }) => addr.host === "192.168.1.50" && type.equals(RequestMessageType.CHECK_CAM)),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("refuses a peer outside it, and tells the station to drop the session it opened", async () => {
    const { session, sent, answerFrom } = harness(privatePeer);
    try {
      await session.connect();
      answerFrom("203.0.113.9");
      expect(session.isConnected).toBe(false);
      expect(sent.some(({ addr, type }) => addr.host === "203.0.113.9" && type.equals(RequestMessageType.END))).toBe(
        true,
      );
    } finally {
      await session.close();
    }
  });

  it("still settles on a local peer that answers after one was refused", async () => {
    const { session, answerFrom } = harness(privatePeer);
    try {
      await session.connect();
      answerFrom("203.0.113.9");
      answerFrom("192.168.1.50");
      expect(session.isConnected).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("keeps a probe socket available after refusing a public peer on it", async () => {
    const { session, sent, answerFrom } = harness(privatePeer, "192.0.2.2");
    try {
      await session.connect();
      const probe = (session as unknown as { probeSockets: dgram.Socket[] }).probeSockets[0]!;
      answerFrom("203.0.113.9", 4000, probe);
      expect(session.isConnected).toBe(false);
      expect(sent.some(({ type, socket }) => type.equals(RequestMessageType.END) && socket === probe)).toBe(true);
      answerFrom("192.168.1.50", 4000, probe);
      expect(session.isConnected).toBe(true);
      expect((session as unknown as { socket: dgram.Socket }).socket).toBe(probe);
    } finally {
      await session.close();
    }
  });

  it("warns at each refusal while keeping peer addresses out of the timeout error", async () => {
    vi.useFakeTimers();
    const { session, lookupAddress, answerFrom, warn } = harness(privatePeer);
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));
    try {
      await session.connect();
      lookupAddress("203.0.113.9");
      answerFrom("198.51.100.10");
      vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(`P2P connect timeout for ${STATION_SN}`);
      expect(warn).toHaveBeenCalledWith(`[p2p] ${STATION_SN} refusing peer 203.0.113.9:4000`);
      expect(warn).toHaveBeenCalledWith(`[p2p] ${STATION_SN} refusing peer 198.51.100.10:4000`);
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  it("warns once per refused endpoint even when lookup sockets report it repeatedly", async () => {
    const { session, lookupAddress, answerFrom, warn, debug } = harness(privatePeer);
    const message = `[p2p] ${STATION_SN} refusing peer 203.0.113.9:4000`;
    try {
      await session.connect();
      lookupAddress("203.0.113.9");
      lookupAddress("203.0.113.9");
      answerFrom("203.0.113.9");
      expect(warn.mock.calls.filter(([logged]) => logged === message)).toHaveLength(1);
      expect(debug.mock.calls.filter(([logged]) => logged === message)).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it("refuses a peer when host policy throws and still accepts a later candidate", async () => {
    const acceptPeer = vi.fn((peer: { readonly host: string }) => {
      if (peer.host === "203.0.113.9") throw new Error("host decision failed");
      return true;
    });
    const { session, lookupAddress, answerFrom, sent, warn, debug } = harness(acceptPeer);
    try {
      await session.connect();
      lookupAddress("203.0.113.9");
      expect(
        sent.some(({ addr, type }) => addr.host === "203.0.113.9" && type.equals(RequestMessageType.CHECK_CAM)),
      ).toBe(false);
      answerFrom("203.0.113.9");
      expect(session.isConnected).toBe(false);
      answerFrom("192.168.1.50");
      expect(session.isConnected).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        `[p2p] ${STATION_SN} refusing peer 203.0.113.9:4000: peer callback threw: host decision failed`,
      );
      expect(debug).toHaveBeenCalledWith(
        `[p2p] ${STATION_SN} refusing peer 203.0.113.9:4000: peer callback threw: host decision failed`,
      );
    } finally {
      await session.close();
    }
  });

  it("keeps whichever peer answers first when unrestricted", async () => {
    const { session, answerFrom } = harness();
    try {
      await session.connect();
      answerFrom("203.0.113.9");
      expect(session.isConnected).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("accepts a public peer when the host chooses that exact candidate", async () => {
    const accepted = vi.fn((peer: { readonly host: string }) => peer.host === "203.0.113.9");
    const { session, answerFrom } = harness(accepted);
    try {
      await session.connect();
      answerFrom("192.168.1.50");
      expect(session.isConnected).toBe(false);
      answerFrom("203.0.113.9");
      expect(session.isConnected).toBe(true);
      expect(accepted).toHaveBeenCalledWith({ host: "203.0.113.9", port: 4000 });
    } finally {
      await session.close();
    }
  });
});
