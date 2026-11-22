import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import { callBody } from "../call.js";
import { IceAgent, pmIce } from "../ice.js";
import {
  parseRtcDatagram,
  rtcDecrypt,
  rtcEncrypt,
  rtcHeader,
  rtcPacket,
  wrapRtcPacket,
  type RtcPacket,
} from "../packet.js";
import { RtcSignalClient } from "../signal-client.js";
import {
  Attr,
  Stun,
  decodeStun,
  encodeStun,
  longTermKey,
  readXorAddress,
  stunIntegrity,
  u32,
  xorAddress,
} from "../stun.js";

vi.mock("node:os", async (orig) => ({
  ...(await orig<typeof import("node:os")>()),
  networkInterfaces: () => ({ lo: [{ family: "IPv4", internal: false, address: "127.0.0.1" }] }),
}));

const SN = "T8000P0000000000";
const KEY = "0123456789abcdef";
const TS = 1_700_000_000;
const strip = (b: Buffer) => b.toString("latin1").replace(/\0+$/, "");
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  vi.restoreAllMocks();
});

describe("IceAgent TURN", () => {
  it("answers 401 with an authenticated Allocate, offers the relay, asks a permission, reads a Data indication", async () => {
    const server = createSocket("udp4");
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const key = longTermKey("user", "realm", "pass");
    const seen: number[] = [];
    server.on("message", (msg, from) => {
      const m = decodeStun(msg)!;
      const reply = (type: number, attrs: [number, Buffer][], k?: Buffer) =>
        server.send(encodeStun(type, m.id, attrs, k), from.port, from.address);
      if (!m.integrity) {
        seen.push(401);
        return reply(Stun.ALLOCATE | 0x110, [
          [Attr.ERROR, Buffer.from([0, 0, 4, 1])],
          [Attr.REALM, Buffer.from("realm")],
          [Attr.NONCE, Buffer.from("n1")],
        ]);
      }
      expect(m.attrs.get(Attr.USERNAME)!.toString()).toBe("user");
      expect(stunIntegrity(m, key)).toBe(true);
      seen.push(m.type);
      if (m.type === Stun.ALLOCATE)
        reply(
          Stun.ALLOCATE | Stun.SUCCESS,
          [
            [Attr.RELAYED, xorAddress({ address: "192.0.2.50", port: 49152 })],
            [Attr.MAPPED, xorAddress({ address: "192.0.2.60", port: 40000 })],
            [Attr.LIFETIME, u32(600)],
          ],
          key,
        );
      else if (m.type === Stun.CREATE_PERMISSION) {
        expect(readXorAddress(m.attrs.get(Attr.PEER))?.address).toBe("192.0.2.70");
        reply(Stun.CREATE_PERMISSION | Stun.SUCCESS, [], key);
        const rtp = Buffer.from([0x80, 0x61, 0, 1]);
        const peer = xorAddress({ address: "192.0.2.70", port: 5000 });
        server.send(
          encodeStun(Stun.DATA, m.id, [
            [Attr.PEER, peer],
            [Attr.DATA, rtp],
          ]),
          from.port,
          from.address,
        );
      }
    });
    const agent = new IceAgent("abcd", "0123456789012345678901");
    closers.push(() => agent.close());
    agent.turn = { host: "127.0.0.1", port: server.address().port, user: "user", password: "pass" };
    const candidates: string[] = [];
    agent.on("candidate", (c) => candidates.push(c));
    await agent.start("peer", "p".repeat(22));
    expect(candidates.at(-1)).toMatch(/ 192\.0\.2\.50 49152 typ relay raddr 192\.0\.2\.60 rport 40000$/);
    const data = once(agent, "data");
    agent.addRemoteCandidate("candidate:1 1 udp 2122260223 192.0.2.70 5000 typ host");
    expect((await data)[0]).toEqual(Buffer.from([0x80, 0x61, 0, 1]));
    expect(seen).toEqual([401, Stun.ALLOCATE, Stun.CREATE_PERMISSION]);
  });
});

describe("pmIce", () => {
  it("answers the station sdp, trades candidates by INFO, connects to a loopback peer and ends the CALL repeat", async () => {
    const sent: { socket: Socket; p: RtcPacket }[] = [];
    const send = Socket.prototype.send;
    vi.spyOn(Socket.prototype, "send").mockImplementation(function (this: Socket, msg: unknown, ...rest: unknown[]) {
      const p = parseRtcDatagram(msg as Buffer);
      if (p) sent.push({ socket: this, p });
      else (send as (...a: unknown[]) => void).apply(this, [msg, ...rest]);
    } as never);
    const client = new RtcSignalClient({ sn: SN, did: "XXXXXXX-000000-XXXXX", lic: "AAAAAA", host: "127.0.0.1" });
    client.sessionKey = KEY;
    closers.push(() => client.close());
    const call = client.call(6);
    const agent = pmIce(client, call);
    const peer = new IceAgent("peer", "q".repeat(22));
    closers.push(
      () => agent.close(),
      () => peer.close(),
    );

    const station = (json: object) => {
      const h = rtcHeader({ kind: 4, sn: SN, seq: 42, route: 9, ts: TS });
      h[18] = 1;
      const body = callBody(call.uuid, "station", rtcEncrypt(Buffer.from(JSON.stringify(json)), KEY, TS));
      sent[0]!.socket.emit("message", wrapRtcPacket(rtcPacket(h, 7, body)));
    };
    const infos = () =>
      sent
        .filter((s) => s.p.header.readUInt16LE(4) === 4 && s.p.header[14] === 0)
        .map(({ p }) => ({
          b44: p.header[44],
          json: JSON.parse(strip(rtcDecrypt(p.body.subarray(76), KEY, p.header.readUInt32LE(8)))) as Record<
            string,
            string
          >,
        }));

    peer.on("candidate", (c) => station({ candidate: c }));
    station({ sdp: JSON.stringify({ "ice-u": "a=ice-ufrag:peer", "ice-p": `a=ice-pwd:${"q".repeat(22)}` }) });
    const connected = once(agent, "connected");
    await vi.waitFor(() => expect(infos().length).toBeGreaterThan(1));
    const [answer, cand] = infos();
    const lines = JSON.parse(answer!.json.sdp!) as Record<string, string>;
    expect([answer!.b44, Object.keys(lines)]).toEqual([0, ["ice-ufrag", "ice-pwd", "ssrc-cname"]]);
    expect([lines["ice-ufrag"], lines["ice-pwd"]]).toEqual([`a=ice-ufrag:${call.ufrag}\r`, `a=ice-pwd:${call.pwd}\r`]);
    expect(lines["ssrc-cname"]).toMatch(new RegExp(`^a=ssrc:${call.audio} cname:[A-Za-z0-9+/]{16}\\r$`));
    expect(cand!.b44).toBe(1);
    expect(cand!.json.candidate).toMatch(/^candidate:\d+ 1 udp \d+ 127\.0\.0\.1 \d+ typ host$/);
    peer.addRemoteCandidate(cand!.json.candidate!);
    await peer.start(call.ufrag, call.pwd);
    await connected;
    const calls = () => sent.filter((s) => s.p.header.readUInt16LE(4) === 2).length;
    const before = calls();
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls()).toBe(before);
    expect(before).toBeLessThan(10);
  });
});
