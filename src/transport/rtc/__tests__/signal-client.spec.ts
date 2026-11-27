import type { Logger } from "../../../core/logger.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket, createSocket } from "node:dgram";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
  RTC_DEFAULT_KEY,
  crc16,
  parseRtcDatagram,
  rtcDecrypt,
  rtcEncrypt,
  rtcHeader,
  rtcKey,
  rtcPacket,
  wrapRtcPacket,
  type RtcPacket,
} from "../packet.js";
import { callBody } from "../call.js";
import { RtcSignalClient, type RtcServer, type RtcToken } from "../signal-client.js";

const SN = "T8000P0000000000";
const DID = "XXXXXXX-000000-XXXXX";
const LIC = "AAAAAA";
const TS = 1_700_000_000;

describe("rtc packet", () => {
  it("CRC-16/XMODEM", () => {
    expect(crc16(Buffer.from("123456789"))).toBe(0x31c3);
  });

  it("derives the key by writing the decimal ts over the key string's tail", () => {
    expect(rtcKey("0123456789abcdef", TS).toString("hex")).toBe("30313233343531373030303030303030");
    expect(rtcKey(RTC_DEFAULT_KEY, TS).toString("hex")).toBe("26232540215f31373030303030303030");
    const sealed = rtcEncrypt(Buffer.from("did:lic"), RTC_DEFAULT_KEY, TS);
    expect(sealed).toHaveLength(16);
    expect(rtcDecrypt(sealed, RTC_DEFAULT_KEY, TS).subarray(0, 7).toString()).toBe("did:lic");
  });

  it("DISCOVER is a bare 60-byte kind-9 header with a valid CRC", () => {
    const p = rtcPacket(rtcHeader({ kind: 9, sn: SN, seq: 1, route: 7, ts: TS }));
    expect(p).toHaveLength(60);
    expect([p.readUInt16LE(0), p.readUInt16LE(4), p.readUInt16LE(6), p[12], p[13], p[40], p[58]]).toEqual([
      3, 9, 0, 7, 6, 20, 3,
    ]);
    expect(p.readUInt16LE(2)).toBe(crc16(p.subarray(4)));
    expect(p.subarray(20, 36).toString("latin1")).toBe(SN);
  });

  it("parses a type-8 wrapped datagram and rejects a bad CRC", () => {
    const p = rtcPacket(rtcHeader({ kind: 1, sn: SN, seq: 2, route: 0, ts: TS }), 6, Buffer.from("body"));
    const w = wrapRtcPacket(p);
    expect(w.readUInt16LE(0)).toBe(8);
    const rx = parseRtcDatagram(w)!;
    expect(rx.header[59]).toBe(2);
    expect(rx.body.toString()).toBe("body");
    expect(rx.header.readUInt16LE(4)).toBe(1);
    const bad = Buffer.from(p);
    bad[30] ^= 1;
    expect(parseRtcDatagram(bad)).toBeUndefined();
  });
});

/** The next token handing out a login other than `aes`. */
function loginToken(client: RtcSignalClient, aes = ""): Promise<RtcToken> {
  return new Promise((r) => client.on("token", (t) => t.aes !== aes && r(t)));
}

describe("RtcSignalClient", () => {
  let server: Socket;
  let client: RtcSignalClient;
  afterEach(() => {
    vi.useRealTimers();
    client.close();
    server.close();
  });

  /** A fake signalling server: DISCOVER → self, reg → 401, reg2 → checks did:lic, then 200 or a second 401. */
  async function fakeServer(rejectReg2: boolean, dropRegs = 0, logger?: Logger) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const modulus = Buffer.from((publicKey.export({ format: "jwk" }) as { n: string }).n, "base64url").toString("hex");
    const seen: { auth?: string; wrapped: boolean[]; regs: number[] } = { wrapped: [], regs: [] };
    server = createSocket("udp4");
    const reply = (rx: RtcPacket, status: number, kind: number, body: Buffer, to: { port: number }) => {
      const h = Buffer.from(rx.header);
      h[14] = 1;
      h.writeUInt16LE(status, 16);
      h.writeUInt32LE(TS, 8);
      h[44] = 5;
      server.send(wrapRtcPacket(rtcPacket(h, kind, body)), to.port, "127.0.0.1");
    };
    server.on("message", (msg, from) => {
      seen.wrapped.push(msg.readUInt16LE(0) === 8);
      const rx = parseRtcDatagram(msg)!;
      if (rx.header.readUInt16LE(4) === 9)
        return reply(rx, 200, 2, Buffer.from(JSON.stringify({ server_addr: "self", timestamp: 0, saddrs: [] })), from);
      if (rx.header.readUInt16LE(4) !== 1) return;
      if (rx.header[41] === 0 && seen.regs.push(from.port) <= dropRegs) return;
      if (rx.header[41] === 0) return reply(rx, 401, 3, rtcEncrypt(Buffer.from(modulus), RTC_DEFAULT_KEY, TS), from);
      expect(rx.header[41]).toBe(4);
      expect(rx.header.readUInt32LE(8)).toBe(TS);
      const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, rx.body.subarray(0, 128));
      const n = rx.body.readUInt16LE(128);
      seen.auth = rtcDecrypt(rx.body.subarray(130, 130 + n), key.toString(), TS)
        .toString()
        .replace(/\0+$/, "");
      if (rejectReg2) return reply(rx, 401, 3, rtcEncrypt(Buffer.from(modulus), RTC_DEFAULT_KEY, TS), from);
      reply(rx, 200, 6, Buffer.from("c0ffee00c0ffee00\0"), from);
    });
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
    client = new RtcSignalClient({
      sn: SN,
      did: DID,
      lic: LIC,
      host: "127.0.0.1",
      port: server.address().port,
      logger,
    });
    return seen;
  }

  it("discovers, then reg → 401 → reg2 → 200 yields the contact_id", async () => {
    const seen = await fakeServer(false);
    expect(client.heard).toBe("none");
    const login = new Promise<string>((r) => client.once("login", r));
    await client.start();
    expect(await login).toBe("c0ffee00c0ffee00");
    expect(seen.auth).toBe(`${DID}:${LIC}`);
    expect(seen.wrapped).toEqual([true, true, true]);
    expect(client.sessionKey).toMatch(/^[0-9a-zA-Z]{16}$/);
    expect(client.heard).toBe("REG 200");
  });

  it("logs each datagram of the login by kind and status, naming no identity", async () => {
    const lines: string[] = [];
    const logger = { debug: (m: string) => lines.push(m), info() {}, warn() {}, error() {} };
    await fakeServer(false, 0, logger);
    const login = new Promise<string>((r) => client.once("login", r));
    await client.start();
    await login;
    const events = lines.map((l) => l.replace(/ \+\d+ ms$/, ""));
    expect(events).toEqual(
      expect.arrayContaining([
        "[rtc-signal] sent DISCOVER on the signalling socket",
        "[rtc-signal] heard REG 401",
        "[rtc-signal] heard REG 200",
      ]),
    );
    for (const l of lines) for (const id of [SN, DID, LIC]) expect(l).not.toContain(id);
  });

  it("hands out the login as a token, and a fresh one logs in quickly with nothing sent; a 23 h old one does not", async () => {
    const seen = await fakeServer(false);
    const token = loginToken(client);
    await client.start();
    const t = await token;
    expect(t).toMatchObject({ aes: client.sessionKey, contactId: "c0ffee00c0ffee00", addr: "127.0.0.1" });
    expect(Math.abs(t.authTimestamp - Date.now() / 1000)).toBeLessThan(2);
    client.close();
    const port = server.address().port;
    const sent = seen.wrapped.length;
    const quick = new RtcSignalClient({ sn: SN, did: DID, lic: LIC, host: "192.0.2.1", port, token: t });
    const login = new Promise<string>((r) => quick.once("login", r));
    await quick.start();
    expect([await login, quick.sessionKey, quick.host]).toEqual(["c0ffee00c0ffee00", t.aes, "127.0.0.1"]);
    quick.close();
    const old = { ...t, authTimestamp: t.authTimestamp - 82_801 };
    client = new RtcSignalClient({ sn: SN, did: DID, lic: LIC, host: "127.0.0.1", port, token: old });
    const again = new Promise<string>((r) => client.once("login", r));
    await client.start();
    await again;
    expect(seen.wrapped.length).toBe(sent + 3);
  });

  it("refreshes a 12 h old login once a PRIV1 and a PM call are both connected", async () => {
    const seen = await fakeServer(false);
    client.close();
    const port = server.address().port;
    const tokenAt = (age: number) => ({
      aes: "0123456789abcdef",
      contactId: "c0ffee00c0ffee00",
      addr: "127.0.0.1",
      authTimestamp: Math.floor(Date.now() / 1000) - age,
    });
    const connectBoth = async (age: number) => {
      client = new RtcSignalClient({ sn: SN, did: DID, lic: LIC, host: "127.0.0.1", port, token: tokenAt(age) });
      await client.start();
      const [priv1, pm] = [client.call(5), client.call(6)];
      client.connected(priv1.uuid);
      expect(seen.auth).toBeUndefined();
      client.connected(pm.uuid);
    };
    await connectBoth(43_100);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.auth).toBeUndefined();
    client.close();
    await connectBoth(43_201);
    const t = await loginToken(client, "0123456789abcdef");
    expect(seen.auth).toBe(`${DID}:${LIC}`);
    expect(t.aes).not.toBe("0123456789abcdef");
    expect(Math.abs(t.authTimestamp - Date.now() / 1000)).toBeLessThan(2);
  });

  it("a second 401 in a row resets at once: a bare reg from a reopened socket", async () => {
    const seen = await fakeServer(true);
    await client.start();
    await vi.waitFor(() => expect(seen.regs).toHaveLength(2));
    expect(seen.auth).toBe(`${DID}:${LIC}`);
    expect(seen.regs[1]).not.toBe(seen.regs[0]);
    expect(client.contactId).toBe("");
  });

  it("retries an unanswered login every 9 s, first on its socket, then reset, until a 200", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const seen = await fakeServer(false, 2);
    const until = async (f: () => boolean) => {
      while (!f()) await new Promise((r) => setImmediate(r));
    };
    let contact = "";
    client.once("login", (c) => (contact = c));
    await client.start();
    await until(() => seen.regs.length === 1);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(seen.regs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => seen.regs.length === 2);
    expect(seen.regs[1]).toBe(seen.regs[0]);
    await vi.advanceTimersByTimeAsync(9_000);
    await until(() => contact !== "");
    expect(seen.regs[2]).not.toBe(seen.regs[0]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.regs).toHaveLength(3);
  });
});

describe("RtcSignalClient servers", () => {
  const server = (type: number, ip: string, protocol = 0, avgRtt = 0, domain = "sig.example.com"): RtcServer => ({
    domain,
    type,
    ip,
    protocol,
    lastUsed: 0,
    avgRtt,
  });
  const expired = { aes: "A".repeat(16), contactId: "synthetic-contact", addr: "192.0.2.7", authTimestamp: 1 };
  let sent: { socket: Socket; host: string; kind: number }[];
  let client: RtcSignalClient;
  beforeEach(() => {
    sent = [];
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    vi.spyOn(Socket.prototype, "send").mockImplementation(function (
      this: Socket,
      msg: unknown,
      _p: unknown,
      host: unknown,
    ) {
      sent.push({ socket: this, host: host as string, kind: parseRtcDatagram(msg as Buffer)!.header.readUInt16LE(4) });
    } as never);
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restarts on the cached servers: ties go to the lowest ip, DISCOVER switches, a CALL takes a backup", async () => {
    const cached = [server(0, "192.0.2.1"), server(0, "192.0.2.0", 0, 0, "other.example.com")];
    client = new RtcSignalClient({
      sn: SN,
      did: DID,
      lic: LIC,
      host: "192.0.2.9",
      domain: "sig.example.com",
      token: { ...expired, servers: cached },
    });
    const tokens: RtcToken[] = [];
    client.on("token", (t) => tokens.push(t));
    await client.start();
    expect(sent[0]).toMatchObject({ host: "192.0.2.1", kind: 9 });
    expect(tokens[0]!.servers!.map((s) => `${s.type}${s.protocol} ${s.ip}`)).toEqual([
      "00 192.0.2.9",
      "11 192.0.2.7",
      "10 192.0.2.7",
      "00 192.0.2.1",
    ]);
    vi.setSystemTime(Date.now() + 40);
    const h = rtcHeader({ kind: 9, sn: SN, seq: 1, route: 0, ts: TS });
    [h[14], h[41]] = [1, 2];
    h.writeUInt16LE(200, 16);
    const reply = JSON.stringify({ server_addr: "192.0.2.5", timestamp: 0, saddrs: ["192.0.2.3"] });
    sent[0]!.socket.emit("message", wrapRtcPacket(rtcPacket(h, 2, Buffer.from(reply))));
    expect(sent[1]).toMatchObject({ host: "192.0.2.5", kind: 1 });
    expect(sent[1]!.socket).not.toBe(sent[0]!.socket);
    client.call(6);
    expect(sent[2]).toMatchObject({ host: "192.0.2.3", kind: 2 });
    expect(tokens.at(-1)!.servers!.map((s) => `${s.type}${s.protocol} ${s.ip} ${s.avgRtt}`)).toEqual([
      "10 192.0.2.3 0",
      "11 192.0.2.3 0",
      "10 192.0.2.5 0",
      "11 192.0.2.5 0",
      "00 192.0.2.1 40",
      "00 192.0.2.9 0",
      "11 192.0.2.7 0",
      "10 192.0.2.7 0",
    ]);
    expect(tokens.at(-1)).toMatchObject(expired);
  });

  /** A quick-logged-in client on DISCOVER UDP .3, .5 and the login's .7, DNS .9; its hung-up calls. */
  async function failover(): Promise<string[]> {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1_700_000_000_000 });
    const fresh = {
      ...expired,
      authTimestamp: 1_700_000_000 - 60,
      servers: [server(1, "192.0.2.3"), server(1, "192.0.2.5")],
    };
    client = new RtcSignalClient({
      sn: SN,
      did: DID,
      lic: LIC,
      host: "192.0.2.9",
      domain: "sig.example.com",
      token: fresh,
    });
    await client.start();
    const hangups: string[] = [];
    client.on("hangup", (uuid) => hangups.push(uuid));
    return hangups;
  }
  /** Place a PM call and let `ms` pass without an answer; what went out on the signalling socket meanwhile. */
  function unanswered(ms: number) {
    const uuid = client.call(6).uuid;
    const call = sent.at(-1)!;
    const n = sent.length;
    vi.advanceTimersByTime(ms);
    return { uuid, call, signalling: sent.slice(n).filter((s) => s.socket !== call.socket) };
  }

  it("a CALL without Trying hangs up after 5 s, then 10 s, each time logging in on the best other server", async () => {
    const hangups = await failover();
    const a = unanswered(4_999);
    expect([a.call.host, hangups]).toEqual(["192.0.2.3", []]);
    vi.advanceTimersByTime(1);
    expect(hangups).toEqual([a.uuid]);
    const b = unanswered(9_999);
    expect(b.call.host).toBe("192.0.2.5");
    expect(b.signalling).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hangups).toEqual([a.uuid, b.uuid]);
    const regs = sent.filter((s) => s.kind === 1);
    expect(regs.map((s) => s.host)).toEqual(["192.0.2.5", "192.0.2.7"]);
    expect(regs[1]!.socket).not.toBe(regs[0]!.socket);
  });

  it("30 s of CALLs without Trying since the last login rediscover from the DNS server", async () => {
    await failover();
    unanswered(5_000);
    unanswered(10_000);
    const c = unanswered(20_000);
    expect(c.signalling.map((s) => `${s.kind} ${s.host}`)).toEqual(["9 192.0.2.9"]);
  });

  it("during a fail run, a DISCOVER reply that adds servers switches to the best other one", async () => {
    await failover();
    unanswered(8_000);
    const h = rtcHeader({ kind: 9, sn: SN, seq: 1, route: 0, ts: TS });
    [h[14], h[41]] = [1, 2];
    h.writeUInt16LE(200, 16);
    const reply = JSON.stringify({ server_addr: "self", timestamp: 0, saddrs: ["192.0.2.1"] });
    sent.at(-1)!.socket.emit("message", wrapRtcPacket(rtcPacket(h, 2, Buffer.from(reply))));
    expect(sent.filter((s) => s.kind === 1).map((s) => s.host)).toEqual(["192.0.2.5", "192.0.2.5", "192.0.2.1"]);
  });

  it("a Trying ends the rounds: the next CALL waits 5 s again", async () => {
    const hangups = await failover();
    unanswered(5_000);
    const { uuid } = client.call(6);
    const h = rtcHeader({ kind: 2, sn: SN, seq: 1, route: 0, ts: TS });
    [h[13], h[14]] = [6, 1];
    h.writeUInt16LE(100, 16);
    sent.at(-1)!.socket.emit("message", wrapRtcPacket(rtcPacket(h, 7, callBody(uuid, "station"))));
    client.hangup(uuid);
    const c = unanswered(5_000);
    expect(hangups.at(-1)).toBe(c.uuid);
  });

  it("keeps 8 of a type and protocol: a 9th drops the last of that type with the highest mean rtt", async () => {
    const cached = [30, 0, 30, 10, 0, 0, 0, 0].map((rtt, i) => server(1, `192.0.2.${10 + i}`, 0, rtt));
    client = new RtcSignalClient({
      sn: SN,
      did: DID,
      lic: LIC,
      host: "192.0.2.9",
      token: { ...expired, servers: cached },
    });
    const token = new Promise<RtcToken>((r) => client.once("token", r));
    await client.start();
    const ips = (await token).servers!.map((s) => s.ip);
    expect(ips.slice(0, 3)).toEqual(["192.0.2.9", "192.0.2.7", "192.0.2.7"]);
    expect(ips.filter((ip) => ip.endsWith(".10") || ip.endsWith(".12"))).toEqual(["192.0.2.10"]);
  });
});
