import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { RequestMessageType } from "../codec.js";
import { withGcmKey } from "./session-fixtures.js";

const cleanup: dgram.Socket[] = [];
async function bound() {
  const socket = dgram.createSocket("udp4");
  cleanup.push(socket);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return socket;
}
function sessionWith(socket: dgram.Socket, port?: number) {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  Object.assign(session, {
    socket,
    connected: true,
    ...(port === undefined ? {} : { connectAddress: { host: "127.0.0.1", port } }),
  });
  withGcmKey(session, Buffer.alloc(32, 1));
  return session;
}
afterEach(() => {
  for (const socket of cleanup.splice(0)) {
    try {
      socket.close();
    } catch {}
  }
});

describe("P2P session close", () => {
  it("delivers queued attached STOP and END through the same real UDP socket", async () => {
    const receiver = await bound();
    const sender = await bound();
    const port = (receiver.address() as { port: number }).port;
    const seen: Buffer[] = [];
    const remotePorts: number[] = [];
    let finish!: () => void;
    const delivered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const guard = setTimeout(finish, 1_000);
    receiver.on("message", (packet, remote) => {
      seen.push(packet);
      remotePorts.push(remote.port);
      if (seen.length === 2) finish();
    });
    try {
      const senderPort = (sender.address() as { port: number }).port;
      const session = sessionWith(sender, port);
      session.sendFrame(
        { cmd: 1350, body: "json1350", subCmd: 1004, payload: { channel: "$channel" } },
        2,
        "0".repeat(40),
      );
      await session.close();
      await delivered;
      expect(seen).toHaveLength(2);
      expect(seen[0]!.subarray(0, 2)).toEqual(RequestMessageType.DATA);
      expect(seen[0]!.readUInt16LE(12)).toBe(1350);
      expect(seen[0]![20]).toBe(2);
      expect(seen[1]!.subarray(0, 2)).toEqual(RequestMessageType.END);
      expect(remotePorts).toEqual([senderPort, senderPort]);
    } finally {
      clearTimeout(guard);
    }
  });

  it("waits for the END callback and still closes when it reports an error", async () => {
    const socket = await bound();
    const session = sessionWith(socket, 1234);
    let sent!: (error: Error) => void;
    vi.spyOn(socket, "send").mockImplementation((...args: unknown[]) => {
      sent = args.at(-1) as typeof sent;
      return undefined as never;
    });
    const closing = session.close();
    expect(() => socket.address()).not.toThrow();
    sent(new Error("simulated send failure"));
    await closing;
    await session.close();
    expect(() => socket.address()).toThrow();

    const noPeerSocket = await bound();
    const noPeerSession = sessionWith(noPeerSocket);
    await noPeerSession.close();
    await noPeerSession.close();
    expect(() => noPeerSocket.address()).toThrow();
  });
});
