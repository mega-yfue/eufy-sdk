/**
 * The media ICE of the vendor app's PrivMedia (PM) call, which its WebRTC peer runs as the answerer of the offer the
 * app builds for the station: full ICE, role controlled, BUNDLE and rtcp-mux on one UDP component, the app's own
 * `sdp_info` ufrag and pwd as the local credentials, and the call's TURN server as the only ICE server.
 *
 * {@link IceAgent} owns one UDP socket. It offers a host candidate per IPv4 interface and, with a TURN server, a relay
 * candidate from an Allocate under the long-term credential (401 or 438 retried with the server's realm and nonce),
 * refreshed 60 s before its lifetime ends. A remote candidate is paired with the host socket and with the relay, the
 * relay first asking a permission for its address (renewed every 4 min) and then carrying the checks as Send
 * indications, the peer's datagrams arriving as Data indications. Checks go out round robin every 50 ms, `remote:local`
 * USERNAME, PRIORITY, ICE-CONTROLLED, MESSAGE-INTEGRITY under the remote pwd, FINGERPRINT. A check from the station
 * is answered with its XOR-MAPPED-ADDRESS and triggers a check back. The first answered check is the selected pair:
 * `connected`, then a check on it every 2.5 s. Every other datagram from a peer is `data`.
 *
 * With `juice` it is instead the PRIV1 data channel's libjuice agent: role controlling (ICE-CONTROLLING, the selected
 * pair nominated at once with USE-CANDIDATE), server-reflexive candidates from a Binding to {@link JUICE_STUN} and from
 * the Allocate's mapped address besides host and relay, one candidate per address, written as libjuice does:
 * `a=candidate:<n> 1 UDP <priority> <ip> <port> typ <type>`, srflx and relay followed by ` raddr 0.0.0.0 rport 0`,
 * `n` the candidate's place in the local description from 1, the priority `((pref << 16 | 0x7fff) − (n − 1)) << 8 |
 * 255` with pref host 126, srflx 100, relay 0.
 */
import { EventEmitter } from "node:events";
import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { crc32 } from "node:zlib";
import { B64, randomChars, type RtcCallSdp } from "./call.js";
import type { RtcSignalClient } from "./signal-client.js";
import {
  Attr,
  Stun,
  decodeStun,
  encodeStun,
  longTermKey,
  readXorAddress,
  stunError,
  stunIntegrity,
  u32,
  xorAddress,
  type Address,
  type StunMessage,
} from "./stun.js";

/** The call's `turn` object: `turn_addr`, `turn_port`, `turn_user`, `turn_password`. */
export interface TurnServer {
  host: string;
  port: number;
  user: string;
  password: string;
}

interface Pair {
  remote: Address;
  relay: boolean;
}

export interface IceEvents {
  /** A local candidate line, `candidate:…` as the peer reports it. */
  candidate: [line: string];
  connected: [];
  data: [datagram: Buffer];
  close: [];
}

const PRFLX_PRIORITY = ((110 << 24) | (0xffff << 8) | 255) >>> 0;
/** The STUN server libjuice is configured with on the app's PRIV1 data channel, whatever the call says. */
export const JUICE_STUN = { host: "stun.l.google.com", port: 19302 };
const JUICE_PREF = { host: 126, srflx: 100, relay: 0 };

export class IceAgent extends EventEmitter<IceEvents> {
  turn?: TurnServer;
  private readonly socket: Socket = createSocket("udp4");
  private readonly tie = randomBytes(8);
  private readonly pairs: Pair[] = [];
  private readonly checks = new Map<string, Pair>();
  private readonly pending = new Map<string, (m: StunMessage) => void>();
  private readonly permitted = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private remote = { ufrag: "", pwd: "" };
  private turnIp = "";
  private relay?: Address;
  private auth?: { realm: Buffer; nonce: Buffer; key: Buffer };
  private selected?: Pair;
  private ticks = 0;
  private closed = false;
  private readonly offered = new Set<string>();

  constructor(
    private readonly ufrag: string,
    private readonly pwd: string,
    private readonly juice = false,
  ) {
    super();
    this.socket.on("message", (msg, from) => this.onDatagram(msg, from));
  }

  /** Bind, offer the host candidates, start the checks, then allocate the relay. */
  async start(remoteUfrag: string, remotePwd: string): Promise<void> {
    this.remote = { ufrag: remoteUfrag, pwd: remotePwd };
    await new Promise<void>((resolve) => this.socket.bind(0, resolve));
    const { port } = this.socket.address();
    for (const i of Object.values(networkInterfaces()).flat())
      if (i?.family === "IPv4" && !i.internal) this.offer("host", { address: i.address, port });
    this.timers.push(setInterval(() => this.tick(), 50));
    await Promise.all([this.turn && this.allocate(this.turn), this.juice && this.reflexive()]);
  }

  /** Whether a pair is selected. */
  get connected(): boolean {
    return this.selected !== undefined;
  }

  /** A datagram to the selected pair; nothing before one is selected. */
  write(data: Buffer): void {
    if (this.selected) this.sendVia(this.selected, data);
  }

  /** A station candidate line (`candidate:` or `a=candidate:`): component 1, UDP, IPv4. */
  addRemoteCandidate(line: string): void {
    const m = /candidate:\S+ 1 udp \d+ ([\d.]+) (\d+) typ /i.exec(line);
    if (!m) return;
    const remote = { address: m[1]!, port: Number(m[2]) };
    this.pairs.push({ remote, relay: false });
    if (this.relay) this.relayPair(remote);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.socket.close();
    this.emit("close");
  }

  private tick(): void {
    if (this.selected) return void (++this.ticks % 50 || this.check(this.selected));
    if (this.pairs.length) this.check(this.pairs[this.ticks++ % this.pairs.length]!);
  }

  private check(pair: Pair): void {
    const id = randomBytes(12);
    this.checks.set(id.toString("hex"), pair);
    const attrs: [number, Buffer][] = [
      [Attr.USERNAME, Buffer.from(`${this.remote.ufrag}:${this.ufrag}`)],
      [Attr.PRIORITY, u32(PRFLX_PRIORITY)],
      [this.juice ? Attr.CONTROLLING : Attr.CONTROLLED, this.tie],
    ];
    if (this.juice && pair === this.selected) attrs.push([Attr.USE_CANDIDATE, Buffer.alloc(0)]);
    this.sendVia(pair, encodeStun(Stun.BINDING, id, attrs, Buffer.from(this.remote.pwd), true));
  }

  private sendVia(pair: Pair, data: Buffer): void {
    if (!pair.relay) return this.send(data, pair.remote);
    const ind = encodeStun(Stun.SEND, randomBytes(12), [
      [Attr.PEER, xorAddress(pair.remote)],
      [Attr.DATA, data],
    ]);
    this.send(ind, { address: this.turnIp, port: this.turn!.port });
  }

  private send(data: Buffer, to: Address): void {
    if (!this.closed) this.socket.send(data, to.port, to.address);
  }

  private onDatagram(msg: Buffer, from: Address): void {
    const m = decodeStun(msg);
    const done = m && this.pending.get(m.id.toString("hex"));
    if (done) return done(m);
    if (this.turn && from.address === this.turnIp && from.port === this.turn.port) {
      if (m?.type !== Stun.DATA) return;
      const peer = readXorAddress(m.attrs.get(Attr.PEER));
      const data = m.attrs.get(Attr.DATA);
      if (peer && data) this.onPeer(data, { remote: peer, relay: true });
    } else this.onPeer(msg, { remote: { address: from.address, port: from.port }, relay: false });
  }

  private onPeer(msg: Buffer, via: Pair): void {
    const m = decodeStun(msg);
    if (!m) return void this.emit("data", msg);
    if (m.type === Stun.BINDING) {
      const user = m.attrs.get(Attr.USERNAME)?.toString() ?? "";
      if (!user.startsWith(`${this.ufrag}:`) || !stunIntegrity(m, Buffer.from(this.pwd))) return;
      const ok = encodeStun(
        Stun.BINDING_OK,
        m.id,
        [[Attr.MAPPED, xorAddress(via.remote)]],
        Buffer.from(this.pwd),
        true,
      );
      this.sendVia(via, ok);
      let pair = this.pairs.find((p) => p.relay === via.relay && same(p.remote, via.remote));
      if (!pair) this.pairs.push((pair = via));
      if (!this.selected) this.check(pair);
    } else if (m.type === Stun.BINDING_OK) {
      const key = m.id.toString("hex");
      const pair = this.checks.get(key);
      if (!pair || pair.relay !== via.relay || !same(pair.remote, via.remote)) return;
      if (!stunIntegrity(m, Buffer.from(this.remote.pwd))) return;
      this.checks.delete(key);
      if (this.selected) return;
      this.selected = pair;
      this.checks.clear();
      if (this.juice) this.check(pair);
      this.emit("connected");
    }
  }

  private relayPair(remote: Address): void {
    this.pairs.push({ remote, relay: true });
    if (this.permitted.has(remote.address)) return;
    this.permitted.add(remote.address);
    void this.permit(remote.address);
  }

  private permit(address: string): Promise<StunMessage | undefined> {
    return this.turnRequest(Stun.CREATE_PERMISSION, [[Attr.PEER, xorAddress({ address, port: 0 })]]);
  }

  private async allocate(turn: TurnServer): Promise<void> {
    this.turnIp = await lookup(turn.host, { family: 4 }).then(
      (r) => r.address,
      () => "",
    );
    if (!this.turnIp) return;
    const r = await this.turnRequest(Stun.ALLOCATE, [[Attr.TRANSPORT, Buffer.from([17, 0, 0, 0])]]);
    const relay = r && readXorAddress(r.attrs.get(Attr.RELAYED));
    if (!r || !relay || this.closed) return;
    this.relay = relay;
    const lifetime = r.attrs.get(Attr.LIFETIME)?.readUInt32BE() ?? 600;
    const mapped = readXorAddress(r.attrs.get(Attr.MAPPED));
    if (this.juice && mapped) this.offer("srflx", mapped);
    this.offer("relay", relay, mapped);
    for (const p of this.pairs.filter((q) => !q.relay)) this.relayPair(p.remote);
    this.timers.push(
      setInterval(() => void this.turnRequest(Stun.REFRESH, []), Math.max(lifetime - 60, 60) * 1000),
      setInterval(() => this.permitted.forEach((a) => void this.permit(a)), 240_000),
    );
  }

  /** A TURN request, retried once with the realm and nonce of a 401 or 438; the success answer or `undefined`. */
  private async turnRequest(method: number, attrs: [number, Buffer][]): Promise<StunMessage | undefined> {
    const turn = this.turn!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = this.auth;
      const id = randomBytes(12);
      const all: [number, Buffer][] = a
        ? [...attrs, [Attr.USERNAME, Buffer.from(turn.user)], [Attr.REALM, a.realm], [Attr.NONCE, a.nonce]]
        : attrs;
      const r = await this.transact(id, encodeStun(method, id, all, a?.key), { address: this.turnIp, port: turn.port });
      if (!r) return undefined;
      if ((r.type & Stun.CLASS) === Stun.SUCCESS) return a && r.integrity && !stunIntegrity(r, a.key) ? undefined : r;
      const realm = r.attrs.get(Attr.REALM) ?? a?.realm;
      const nonce = r.attrs.get(Attr.NONCE);
      if (![401, 438].includes(stunError(r)) || !realm || !nonce) return undefined;
      this.auth = { realm, nonce, key: longTermKey(turn.user, realm.toString(), turn.password) };
    }
    return undefined;
  }

  /** The server-reflexive candidate: a Binding to {@link JUICE_STUN}, its XOR-MAPPED-ADDRESS. */
  private async reflexive(): Promise<void> {
    const address = await lookup(JUICE_STUN.host, { family: 4 }).then(
      (r) => r.address,
      () => "",
    );
    const id = randomBytes(12);
    const r =
      address && (await this.transact(id, encodeStun(Stun.BINDING, id, []), { address, port: JUICE_STUN.port }));
    const mapped = r && readXorAddress(r.attrs.get(Attr.MAPPED));
    if (mapped && !this.closed) this.offer("srflx", mapped);
  }

  private offer(type: "host" | "srflx" | "relay", a: Address, raddr?: Address): void {
    if (!this.juice) return void this.emit("candidate", candidate(type as "host" | "relay", a, raddr));
    const key = `${a.address}:${a.port}`;
    if (this.offered.has(key)) return;
    this.offered.add(key);
    const n = this.offered.size;
    const priority = ((((JUICE_PREF[type] << 16) | 0x7fff) - (n - 1)) * 256 + 255) >>> 0;
    const related = type === "host" ? "" : " raddr 0.0.0.0 rport 0";
    this.emit("candidate", `a=candidate:${n} 1 UDP ${priority} ${a.address} ${a.port} typ ${type}${related}`);
  }

  /** One STUN transaction to a server: sent at 0, then 250 ms doubling, seven sends in all. */
  private transact(id: Buffer, msg: Buffer, to: Address): Promise<StunMessage | undefined> {
    const key = id.toString("hex");
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let rto = 250;
      let sends = 0;
      const done = (m?: StunMessage) => {
        clearTimeout(timer);
        this.pending.delete(key);
        resolve(m);
      };
      const send = () => {
        if (this.closed || sends++ === 7) return done();
        this.send(msg, to);
        timer = setTimeout(send, rto);
        rto *= 2;
      };
      this.pending.set(key, done);
      send();
    });
  }
}

/** `candidate:<crc32 foundation> 1 udp <priority> <ip> <port> typ <type>`, relay with its mapped `raddr`/`rport`. */
function candidate(type: "host" | "relay", a: Address, raddr?: Address): string {
  const priority = (((type === "host" ? 126 : 2) << 24) | (0xffff << 8) | 255) >>> 0;
  const related = raddr ? ` raddr ${raddr.address} rport ${raddr.port}` : "";
  return `candidate:${crc32(`${type}${a.address}udp`)} 1 udp ${priority} ${a.address} ${a.port} typ ${type}${related}`;
}

function same(a: Address, b: Address): boolean {
  return a.address === b.address && a.port === b.port;
}

/**
 * The app's answer as its peer wrapper sends it: the answer SDP's `a=ice-ufrag:`, `a=ice-pwd:` and `a=ssrc:… cname:`
 * lines, each keeping the CR its split on LF leaves, in a Java `HashMap` (iteration order `ice-ufrag`, `ice-pwd`,
 * `ssrc-cname`) serialised by Gson, which writes `=` as `\u003d`. The ufrag, pwd and audio SSRC are the call's own
 * `sdp_info` values; the cname is 16 random base64-alphabet characters.
 */
function pmAnswer(ufrag: string, pwd: string, ssrc: number): string {
  return JSON.stringify({
    "ice-ufrag": `a=ice-ufrag:${ufrag}\r`,
    "ice-pwd": `a=ice-pwd:${pwd}\r`,
    "ssrc-cname": `a=ssrc:${ssrc} cname:${randomChars(16, B64)}\r`,
  }).replaceAll("=", "\\u003d");
}

/**
 * The call's `turn` (an object or its JSON text) as a server, `undefined` without an address, or without a port when
 * no `port` stands in for a missing or zero one (libjuice takes 3478).
 */
export function turnServer(turn: unknown, port?: number): TurnServer | undefined {
  let t = turn;
  try {
    if (typeof t === "string") t = JSON.parse(t);
  } catch {
    return undefined;
  }
  const o = (t ?? {}) as Record<string, unknown>;
  const p = port && !o.turn_port ? port : o.turn_port;
  if (typeof o.turn_addr !== "string" || !o.turn_addr || typeof p !== "number") return undefined;
  return {
    host: o.turn_addr,
    port: p,
    user: String(o.turn_user ?? ""),
    password: String(o.turn_password ?? ""),
  };
}

/**
 * The PM call's media ICE wired to its signalling as the app wires its peer: the station's 100 Trying `turn` is the
 * ICE server; its INFO `sdp` (`ice-u` / `ice-p` lines) is the remote description, answered at once by an INFO `sdp`
 * of {@link pmAnswer}, then gathering starts; each local candidate goes out as an INFO `candidate` (byte 44 = 1) and
 * each station candidate is added; connected ends the CALL repeat.
 */
export function pmIce(signal: RtcSignalClient, call: { uuid: string } & RtcCallSdp): IceAgent {
  const agent = new IceAgent(call.ufrag, call.pwd);
  const value = (line = "") => line.slice(line.indexOf(":") + 1).trim();
  const onTrying = (uuid: string, turn: unknown) => {
    if (uuid === call.uuid) agent.turn = turnServer(turn);
  };
  const onSdp = (uuid: string, sdp: Record<string, string>) => {
    if (uuid !== call.uuid) return;
    signal.info(uuid, { sdp: pmAnswer(call.ufrag, call.pwd, call.audio) });
    void agent.start(value(sdp["ice-u"]), value(sdp["ice-p"]));
  };
  const onCandidate = (uuid: string, line: string) => {
    if (uuid === call.uuid) agent.addRemoteCandidate(line);
  };
  const onHangup = (uuid: string) => uuid === call.uuid && agent.close();
  signal.on("trying", onTrying).on("sdp", onSdp).on("candidate", onCandidate).on("hangup", onHangup);
  agent.on("candidate", (line) => signal.info(call.uuid, { candidate: line }, 1));
  agent.once("connected", () => signal.connected(call.uuid));
  agent.once("close", () =>
    signal.off("trying", onTrying).off("sdp", onSdp).off("candidate", onCandidate).off("hangup", onHangup),
  );
  return agent;
}
