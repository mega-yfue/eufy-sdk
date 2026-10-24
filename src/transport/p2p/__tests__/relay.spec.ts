import dgram from "node:dgram";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS, P2PSession } from "../p2p-session.js";
import {
  RequestMessageType,
  ResponseMessageType,
  frameMessage,
  hasHeader,
  p2pDidToBuffer,
  parseRelayList,
  parseRelayPortAck,
  parseRelayTo,
} from "../codec.js";

/**
 * A station a direct path cannot reach is connected through a PPCS relay, in the vendor client's order:
 * ListReq_DSK → LIST_REQ_ACK → RLY_HELLO → RLY_HELLO_ACK → RLY_PORT → RLY_PORT_ACK → RLY_REQ → RLY_RDY,
 * starting once the lookup server has acknowledged the P2P request for more than 24 lookup rounds.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

async function peer(): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return socket;
}

/** Let fake time pass in 100 ms steps, yielding to real socket I/O between them. */
async function elapse(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Answer every cloud lookup a peer receives with an accepting P2P_REQ_ACK. */
function acksLookups(cloud: dgram.Socket, msg: Buffer, remote: dgram.RemoteInfo): void {
  if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY) || hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2))
    cloud.send(frameMessage(ResponseMessageType.P2P_REQ_ACK, Buffer.alloc(4)), remote.port, remote.address);
}

/** A 16-byte address record for 127.0.0.1 on `port`. */
function loopbackRecord(port: number): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0x0002, 0);
  record.writeUInt16LE(port, 2);
  record.set([1, 0, 0, 127], 4);
  return record;
}

describe("PPCS relay fallback", () => {
  it("connects through the relay a cloud lookup server lists, with the relay as the peer, after the acknowledged rounds", async () => {
    const cloud = await peer();
    const relay = await peer();
    const relayed = await peer();
    const MARK = 0x01020304;
    let requested: Buffer | undefined;
    let hellos = 0;
    let pingPort: number | undefined;
    const connected = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", () => undefined);
    session.on("connect", connected);
    cloud.on("message", (msg, remote) => {
      acksLookups(cloud, msg, remote);
      if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2)) {
        const list = Buffer.concat([Buffer.from([1, 0, 0, 0]), loopbackRecord(relay.address().port)]);
        cloud.send(frameMessage(ResponseMessageType.LIST_REQ_ACK, list), remote.port, remote.address);
      } else if (hasHeader(msg, RequestMessageType.RLY_REQ) && !requested) {
        requested = msg;
        cloud.send(frameMessage(ResponseMessageType.RLY_REQ_ACK, Buffer.alloc(4)), remote.port, remote.address);
        relayed.send(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer(P2P_DID)), remote.port, remote.address);
      }
    });
    relay.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.RLY_HELLO)) {
        hellos++;
        relay.send(frameMessage(ResponseMessageType.RLY_HELLO_ACK), remote.port, remote.address);
      }
      if (hasHeader(msg, RequestMessageType.RLY_PORT)) {
        const ack = Buffer.alloc(8);
        ack.writeUInt32BE(MARK, 0);
        ack.writeUInt16BE(relayed.address().port, 4);
        relay.send(frameMessage(ResponseMessageType.RLY_PORT_ACK, ack), remote.port, remote.address);
      }
    });
    relayed.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.PING)) pingPort = remote.port;
    });
    try {
      await session.connect();
      await elapse(23_000);
      expect(hellos).toBe(0);
      await elapse(4_000);
      expect(connected).toHaveBeenCalledOnce();
      expect(requested!.subarray(4, 24)).toEqual(p2pDidToBuffer(P2P_DID));
      expect(requested!.subarray(24, 40)).toEqual(loopbackRecord(relayed.address().port));
      expect(requested!.readUInt32BE(40)).toBe(MARK);
      await elapse(200);
      expect(pingPort).toBeDefined();
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
      relay.close();
      relayed.close();
    }
  }, 20_000);

  /**
   * A relay that is slow to answer RLY_HELLO still connects: the relay starts about 25 s in, and the connect
   * budget leaves its handshake room past 30 s.
   */
  it("connects through a relay whose handshake finishes after 30 s, inside the connect budget", async () => {
    const cloud = await peer();
    const relay = await peer();
    const relayed = await peer();
    const IGNORED_HELLOS = 7;
    let hellos = 0;
    const connected = vi.fn();
    const errors: Error[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", (error: Error) => errors.push(error));
    session.on("connect", connected);
    cloud.on("message", (msg, remote) => {
      acksLookups(cloud, msg, remote);
      if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2)) {
        const list = Buffer.concat([Buffer.from([1, 0, 0, 0]), loopbackRecord(relay.address().port)]);
        cloud.send(frameMessage(ResponseMessageType.LIST_REQ_ACK, list), remote.port, remote.address);
      } else if (hasHeader(msg, RequestMessageType.RLY_REQ)) {
        cloud.send(frameMessage(ResponseMessageType.RLY_REQ_ACK, Buffer.alloc(4)), remote.port, remote.address);
        relayed.send(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer(P2P_DID)), remote.port, remote.address);
      }
    });
    relay.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.RLY_HELLO) && ++hellos > IGNORED_HELLOS)
        relay.send(frameMessage(ResponseMessageType.RLY_HELLO_ACK), remote.port, remote.address);
      if (hasHeader(msg, RequestMessageType.RLY_PORT)) {
        const ack = Buffer.alloc(8);
        ack.writeUInt16BE(relayed.address().port, 4);
        relay.send(frameMessage(ResponseMessageType.RLY_PORT_ACK, ack), remote.port, remote.address);
      }
    });
    try {
      await session.connect();
      await elapse(30_000);
      expect(connected).not.toHaveBeenCalled();
      await elapse(5_000);
      expect(connected).toHaveBeenCalledOnce();
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
      relay.close();
      relayed.close();
    }
  }, 20_000);

  it("takes the port only from a relay the list named", () => {
    const send = vi.fn();
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "192.0.2.2", port: 32100 }],
    });
    const internals = session as unknown as {
      socket: unknown;
      cloudLookup: unknown;
      relay: { step: string; relays: { host: string; port: number }[] };
      onMessage(msg: Buffer, rinfo: object, socket?: unknown): void;
    };
    const socket = { send };
    internals.socket = socket;
    internals.cloudLookup = { key: "0".repeat(20), addresses: [{ host: "192.0.2.2", port: 32100 }] };
    internals.relay = { step: "hello", relays: [{ host: "192.0.2.7", port: 32100 }] };
    internals.onMessage(frameMessage(ResponseMessageType.RLY_HELLO_ACK), { address: "192.0.2.8", port: 32100 }, socket);
    expect(internals.relay.step).toBe("hello");
    internals.onMessage(frameMessage(ResponseMessageType.RLY_HELLO_ACK), { address: "192.0.2.7", port: 32100 }, socket);
    expect(internals.relay.step).toBe("port");
    void session.close().catch(() => undefined);
  });

  it("registers with a RLY_TO endpoint instead of hole-punching it, and connects only on its own device's RLY_RDY", () => {
    const send = vi.fn();
    const connected = vi.fn();
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
    session.on("connect", connected);
    const internals = session as unknown as {
      socket: unknown;
      onMessage(msg: Buffer, rinfo: object, socket?: unknown): void;
    };
    const socket = { send, removeAllListeners: vi.fn(), on: vi.fn(), setRecvBufferSize: vi.fn() };
    internals.socket = socket;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(0xcafe0001, 0);
    internals.onMessage(frameMessage(ResponseMessageType.RLY_TO, Buffer.concat([loopbackRecord(40000), handle])), {
      address: "192.0.2.9",
      port: 32100,
    });
    const sent = send.mock.calls.map(([packet, port, host]) => ({ packet: packet as Buffer, port, host }));
    expect(sent).toHaveLength(4);
    for (const { packet, port, host } of sent) {
      expect([host, port]).toEqual(["127.0.0.1", 40000]);
      expect(hasHeader(packet, RequestMessageType.RLY_PKT)).toBe(true);
      expect(packet.subarray(4)).toEqual(Buffer.concat([handle, p2pDidToBuffer(P2P_DID), Buffer.alloc(4)]));
    }
    send.mockClear();
    internals.onMessage(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer("XXXXXXX-000001-XXXXX")), {
      address: "127.0.0.1",
      port: 40000,
    });
    expect(connected).not.toHaveBeenCalled();
    internals.onMessage(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer(P2P_DID)), {
      address: "127.0.0.1",
      port: 40000,
    });
    expect(connected).toHaveBeenCalledOnce();
    void session.close().catch(() => undefined);
  });
});

describe("a connect that times out", () => {
  it("names the relay step it was waiting on", async () => {
    const cloud = await peer();
    cloud.on("message", (msg, remote) => acksLookups(cloud, msg, remote));
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const errors: Error[] = [];
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", (error: Error) => errors.push(error));
    try {
      await session.connect();
      await elapse(CONNECT_TIMEOUT_MS);
      expect(errors.map((e) => e.message)).toEqual([`P2P connect timeout for ${STATION_SN} (relay: list)`]);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
    }
  });

  it("never asks for a relay when no lookup server acknowledges the P2P request", async () => {
    const cloud = await peer();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const errors: Error[] = [];
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", (error: Error) => errors.push(error));
    try {
      await session.connect();
      await elapse(CONNECT_TIMEOUT_MS);
      expect(errors.map((e) => e.message)).toEqual([`P2P connect timeout for ${STATION_SN} (relay: not started)`]);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
    }
  });

  it("says the relay was not available without a cloud lookup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const errors: Error[] = [];
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, noBroadcast: true });
    session.on("error", (error: Error) => errors.push(error));
    try {
      await session.connect();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      expect(errors.map((e) => e.message)).toEqual([`P2P connect timeout for ${STATION_SN} (relay: no cloud lookup)`]);
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });
});

describe("relay message parsing", () => {
  it("reads a relay list in order, without the unspecified address or records past the end", () => {
    const zero = Buffer.alloc(16);
    const msg = frameMessage(
      ResponseMessageType.LIST_REQ_ACK,
      Buffer.concat([Buffer.from([4, 0, 0, 0]), loopbackRecord(1), loopbackRecord(1), zero, loopbackRecord(2)]),
    );
    expect(parseRelayList(msg)).toEqual([
      { host: "127.0.0.1", port: 1 },
      { host: "127.0.0.1", port: 1 },
      { host: "127.0.0.1", port: 2 },
    ]);
    expect(parseRelayList(msg.subarray(0, 8 + 16))).toEqual([{ host: "127.0.0.1", port: 1 }]);
  });

  it("reads a port acknowledgement's mark and port, and a RLY_TO's endpoint and handle", () => {
    const ack = Buffer.from([0xf1, 0x73, 0, 8, 0, 0, 0, 7, 0x9c, 0x40, 0, 0]);
    expect(parseRelayPortAck(ack)).toEqual({ mark: 7, port: 40000 });
    expect(parseRelayPortAck(ack.subarray(0, 9))).toBeUndefined();
    const to = frameMessage(ResponseMessageType.RLY_TO, Buffer.concat([loopbackRecord(5), Buffer.from([0, 0, 0, 9])]));
    expect(parseRelayTo(to)).toEqual({ address: { host: "127.0.0.1", port: 5 }, handle: 9 });
  });
});
