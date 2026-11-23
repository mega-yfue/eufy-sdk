/**
 * The vendor app's native RTC signalling client, up to registration: UDP to the device record's signalling
 * server on port 5062, every datagram in the type-8 wrapper of {@link wrapRtcPacket}.
 *
 * 1. DISCOVER (kind 9, no body) at once and every 20 s until a reply settles it. A 200 reply carries JSON body
 *    kind 2: `server_addr` (`"self"` keeps the server, another address becomes the server), `timestamp`,
 *    `saddrs`; a `server_addr` shorter than 2 leaves it unsettled. Any other status settles it on the current
 *    server. A settled reply sends reg. A received packet flagged re-discover (header byte 19 bit 0x01) unsettles
 *    it and sends DISCOVER at once.
 * 2. reg (kind 1): no body while unregistered; once registered, body kind 6 = contact_id[32] ‖ u16 N ‖
 *    AES(`did:lic`) under the session key.
 * 3. 401 with body kind 3 = default-key AES of the server's RSA modulus as 256 hex chars. The client draws a
 *    16-char `[0-9a-zA-Z]` session key and answers reg2: the 401's header echoed as a request with a new seq,
 *    body kind 4 = RSA(session key) ‖ u16 N ‖ AES(`did:lic`) under the session key and the 401's ts. A second 401
 *    without a reg between is a login failure, which resets the client at once (below).
 * 4. 200 with body kind 6 = the NUL-terminated contact_id; header byte 44 is echoed in later regs.
 *
 * Quick login: with a station's cached {@link RtcToken} no older than 23 h, the client starts registered with the
 * cached session key and contact_id, and sends neither DISCOVER nor reg (the app's work protocol 2 path of
 * `Webrtc_SignalInit` and `rtc_signal_network`); a re-discover flag still sends one DISCOVER. Every first 200 after
 * a key exchange hands out a new token (`onWebrtcToken`).
 *
 * Servers (`rtc_server_manager`): records per (type DNS 0 / DISCOVER 1, protocol UDP 0 / TCP 1), keyed by ip. At start
 * the token's cached list (entries of another signalling domain dropped) is imported, then the cached login's addr
 * is added as DISCOVER UDP and TCP and the device record's host as DNS UDP. The first DISCOVER goes to the best DNS
 * UDP record, a quick login to the best DISCOVER UDP one. A DISCOVER reply's `server_addr` equal to the login
 * address is added silently; another one, with no call up, is added and the client switches to the best DISCOVER UDP
 * record (new socket); `saddrs` (16 at most) are added after. A CALL with none up goes to the best DISCOVER UDP record
 * (the login address when there is none); the client's server becomes that one. Best = {@link score}, highest, ties to
 * the lowest ip in byte order (`generic_map` keys compared with `strncmp`, walked in order).
 * The client's server copy keeps stats: every answer to a DISCOVER, reg, CALL (first send) or INFO of ours stamps
 * last use and folds its round trip into the average over every answer since the last switch. Each added record and,
 * for DISCOVER, reg and CALL answers, the stamped copy goes into the token's list (`onWebrtcServerInfo`).
 *
 * Token refresh: when a PRIV1 or PM call connects while both are connected, a login 12 h old or more (and no check in
 * the last 21 s) sends a bare reg, so the 401 / reg2 / 200 exchange draws a new session key and token
 * (`WebrtcApp_Check_Token_UpdateTime` → `ClientTokenRefresh`).
 *
 * The app's work protocol (2, header byte 15 of reg) starts no login timer: reg goes out once per settled
 * DISCOVER. Until a 200 logs it in, the app's login check (`WebrtcApp_Event_CheckChannelState`) retries every 9 s:
 * first a bare reg, then each time a reset that hangs up every call, reopens the signalling socket and sends a bare
 * reg (`rtc_retry_login` → `ClientRetryLogin`), never within 8 s of the last retry or token refresh. A request the
 * server leaves unanswered for 5 s is not resent otherwise: the app's timeout scan has no caller.
 *
 * 5. CALL (kind 2, header byte 15 = 2, byte 18 = 1, byte 44 = the process-wide call counter from 1) on a UDP socket
 *    of its own per call type, body kind 7 = {@link callBody} of the session uuid and the contact_id, attach = the
 *    call JSON under the session key. The sealed packet goes out again unchanged on {@link nextCallRepeat}.
 * 6. Answers on that socket, by status: 100 Trying = `turn`, once; 200 = `ftv`, `pbsdp` (else `transport_caps`) and
 *    `turn` if no Trying came, then once per session the ack (kind 3, fresh ts and seq, byte 43 echoed, body =
 *    {@link callBodyHead}). Any other status deletes only the session, unless header byte 13 is in 4..8: then 480
 *    hangs the call up, 486 is busy (repeat ends, socket stays). A station kind 3 request is answered 200 with its own header and body head.
 * 7. A station INFO (kind 4) request is answered 200 with its own header: for a session of ours its whole body,
 *    twice 15 ms apart; otherwise the body head, once, on the signalling socket. A PM session reads `sdp` once
 *    (`ice-u`, `ice-p`, `asc`, `vsc`, `sg`, `sgc`) and `candidate`, one per host / srflx / relay.
 *    A PRIV1 session, once its call drew a 100 or 200, reads `file_candidate` with its `file_candidate_num`; an INFO 200
 *    on it whose attach, decrypted then base64-decoded, is `{"file_candidate_num": n}` acks our candidate n.
 *    An INFO of ours (kind 4, byte 15 = 0, byte 18 = 1, byte 44 = 1 for a candidate) goes out once on the call socket,
 *    its attach JSON under the session key. The call's ICE reaching connected ends the CALL repeat.
 * 8. Hang-up of a PRIV1 or PM call sends nothing: the session and its socket close.
 */
import { EventEmitter } from "node:events";
import { createSocket, type Socket } from "node:dgram";
import { createHash, randomInt } from "node:crypto";
import { readNullTerminatedString } from "../p2p/codec.js";
import {
  RTC_CALL_BODY_LENGTH,
  RtcCallType,
  callBody,
  callBodyHead,
  callUuid,
  callUuidOf,
  nextCallRepeat,
  pbTransportCaps,
  randomChars,
  sdpInfo,
  type RtcCallSdp,
} from "./call.js";
import {
  RTC_DEFAULT_KEY,
  RTC_HEADER_LENGTH,
  RtcBody,
  RtcKind,
  parseRtcDatagram,
  rsaEncrypt,
  rtcDecrypt,
  rtcEncrypt,
  rtcHeader,
  rtcPacket,
  wrapRtcPacket,
} from "./packet.js";

/** The UDP port of the app's signalling port policy. */
export const RTC_SIGNAL_PORT = 5062;
const DISCOVER_INTERVAL_MS = 20_000;
const WORK_PROTOCOL = 2;
const P2P_TYPE: Record<number, string> = { [RtcCallType.PRIV1]: "priv1", [RtcCallType.PM]: "priv_p2p" };
const SDP_KEYS = ["ice-u", "ice-p", "asc", "vsc", "sg", "sgc"] as const;
let callCount = 1;
export type RtcRemoteSdp = Record<(typeof SDP_KEYS)[number], string>;

/**
 * The device record's inputs: hub serial, `p2p_did`, `p2p_license`, first IPv4 `signaling_servers` host; the
 * account's user id and the client's app id.
 */
export interface RtcSignalOptions {
  sn: string;
  did: string;
  lic: string;
  host: string;
  /** The first host-name `signaling_servers` entry (`domain_server`): cached servers of another one are dropped. */
  domain?: string;
  port?: number;
  userId?: string;
  appId?: string;
  /** The station's cached login, for a quick login. */
  token?: RtcToken;
}

/**
 * A station's signalling cache as the app keeps it: the login (`sp_webrtc`: session key, contact_id, server address,
 * UTC seconds of the 200; empty before the first) and the server list (`sp_webrtc_servers`).
 */
export interface RtcToken {
  aes: string;
  contactId: string;
  addr: string;
  authTimestamp: number;
  servers?: RtcServer[];
}

/** A signalling server record (`RTCServerInfo`): type 0 DNS, 1 DISCOVER; protocol 0 UDP, 1 TCP; last use ms; mean rtt ms. */
export interface RtcServer {
  domain: string;
  type: number;
  ip: string;
  protocol: number;
  lastUsed: number;
  avgRtt: number;
}

/** How long the app takes a cached login: `auth_timestamp` + 82800 s (`rtc_signal_set_quick_login_info`). */
const TOKEN_TTL_S = 82_800;
/** `WebrtcApp_Check_Token_UpdateTime`: refresh a login this old, at most once per 21 s. */
const TOKEN_REFRESH_S = 43_200;
const TOKEN_CHECK_S = 21;
/** The app's login check period while logged out, and `rtc_retry_login`'s gate shared with the token refresh. */
const RETRY_LOGIN_MS = 9_000;
const RETRY_GATE_S = 8;

interface RtcCall {
  type: number;
  packet: Buffer;
  start: number;
  timer?: NodeJS.Timeout;
  /** The signalling session; an error answer deletes it while the channel keeps its repeat. */
  session: boolean;
  trying?: boolean;
  acked?: boolean;
  sdp?: boolean;
  up?: boolean;
  candidates: Set<string>;
}

export interface RtcSignalEvents {
  /** Registered: a quick login at start, or the first 200 after a key exchange. */
  login: [contactId: string];
  /** The cache changed: the first 200 after a key exchange, or the server list. */
  token: [token: RtcToken];
  /** The station's first 100 (or a 200 without one): its `turn` object. */
  trying: [uuid: string, turn: unknown];
  /** The station's 200, once per session. */
  answer: [uuid: string, answer: { ftv?: number; transportCaps?: number }];
  busy: [uuid: string];
  hangup: [uuid: string];
  /** A PM session's remote description lines, once. */
  sdp: [uuid: string, sdp: RtcRemoteSdp];
  candidate: [uuid: string, candidate: string];
  /** A PRIV1 session's remote candidate line and its slot number. */
  fileCandidate: [uuid: string, candidate: string, num: number];
  /** The station acked our PRIV1 candidate `num`. */
  fileCandidateAck: [uuid: string, num: number];
}

export class RtcSignalClient extends EventEmitter<RtcSignalEvents> {
  /** The server the client speaks to; DISCOVER may switch it. */
  host: string;
  /** The server calls go to, while one is up. */
  private callHost = "";
  /** The client's server (`endpoint+56`); a reset reopens the socket to it. */
  private endpoint!: RtcServer;
  /** The timeout manager's copy of the server, its stats, and its answer count. */
  private tm!: { s: RtcServer; n: number };
  /** The login address (`m_addr`). */
  private mAddr: string;
  /** The server records, keyed `type protocol ip`. */
  private readonly map = new Map<string, RtcServer>();
  /** Send time (ms) of each request awaiting its answer, keyed kind << 8 | seq. */
  private readonly sent = new Map<number, number>();
  private readonly cache: RtcToken;
  /** The cached list as imported: {@link start} hands it out only when the start's adds changed it. */
  private readonly imported: RtcServer[];
  contactId = "";
  sessionKey = "";
  private socket = this.signalSocket();
  private readonly route = randomInt(256);
  private seq = 0;
  private discovered = false;
  private registered = false;
  private unauthorized = 0;
  private b44 = 0;
  private discoverTimer?: NodeJS.Timeout;
  private authTimestamp = 0;
  private tokenCheck = 0;
  private retried = 0;
  private retryTimer?: NodeJS.Timeout;
  private readonly calls = new Map<string, RtcCall>();
  private readonly callSockets = new Map<number, Socket>();

  /** `Webrtc_SignalInit`: import the cached servers, add the cached login's and the device record's, pick the server. */
  constructor(private readonly opts: RtcSignalOptions) {
    super();
    this.host = this.mAddr = opts.host;
    const t = opts.token;
    const domain = this.domain.toLowerCase();
    const servers = (t?.servers ?? []).filter((s) => !domain || s.domain.toLowerCase() === domain);
    this.cache = { aes: "", contactId: "", addr: "", authTimestamp: 0, ...t, servers };
    this.imported = servers;
    for (const s of servers) this.map.set(this.slot(s.type, s.protocol, s.ip), { ...s, domain: this.domain });
    if (t?.aes && t.contactId && t.addr && t.authTimestamp) [0, 1].forEach((p) => this.add(1, p, t.addr));
    this.add(0, 0, opts.host);
    if (t?.aes && t.contactId && t.addr && t.authTimestamp + TOKEN_TTL_S >= Date.now() / 1000) {
      [this.sessionKey, this.contactId, this.authTimestamp] = [t.aes, t.contactId, t.authTimestamp];
      this.discovered = this.registered = true;
    }
    this.use(this.choose(this.registered ? 1 : 0)!);
  }

  /** Bind, hand out the server list if the start changed it, and log in quickly or start discovering. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.bind(0, resolve));
    if (this.cache.servers !== this.imported) this.emit("token", { ...this.cache });
    if (this.registered) return void this.emit("login", this.contactId);
    this.discover();
    this.discoverTimer = setInterval(() => this.discovered || this.discover(), DISCOVER_INTERVAL_MS);
    this.retryTimer = setTimeout(() => this.retryLogin(false), RETRY_LOGIN_MS);
  }

  close(): void {
    clearInterval(this.discoverTimer);
    clearTimeout(this.retryTimer);
    for (const uuid of this.calls.keys()) this.hangup(uuid);
    this.socket.close();
  }

  /** Call the station on a PRIV1 or PM channel; `flag` is `sdp_info` byte 2. */
  call(type: number, flag = 1): { uuid: string } & RtcCallSdp {
    const { sn, did, lic, userId = "", appId = "" } = this.opts;
    const uuid = callUuid(type, sn, appId, did, lic);
    const s = this.calls.size
      ? this.endpoint
      : (this.choose(1) ?? (this.add(1, 0, this.mAddr, false), this.choose(1)!));
    if (s.ip !== this.endpoint.ip) [this.endpoint, this.tm.s] = [s, { ...s }];
    this.callHost = s.ip;
    const header = this.request(RtcKind.CALL, 2, callCount++ & 0xff);
    header[18] = 1;
    const ts = header.readUInt32LE(8);
    const { info, ...sdp } = sdpInfo(flag);
    const json = JSON.stringify({
      account: createHash("md5")
        .update(`0${userId}${ts | 0}`)
        .digest("hex"),
      ftv: 20,
      call_type: "scall",
      eufy_p2p_type: P2P_TYPE[type],
      sdp_info: info.toString("base64"),
      to: "device",
      eufy_from_contact: this.contactId,
      eufy_video_format: 0,
      eufy_network_type: 1,
      eufy_app_id: appId,
      token: rtcEncrypt(this.didLic(), this.sessionKey, ts).toString("base64"),
    });
    const attach = rtcEncrypt(Buffer.from(json), this.sessionKey, ts);
    const packet = rtcPacket(header, RtcBody.CALL, callBody(uuid, this.contactId, attach));
    const c: RtcCall = { type, packet, start: Math.floor(Date.now() / 1000), session: true, candidates: new Set() };
    this.calls.set(uuid, c);
    this.track(header);
    this.repeatCall(c, Date.now());
    return { uuid, ...sdp };
  }

  /**
   * An INFO request (kind 4, byte 18 = 1, byte 44 = `flag`, 1 marking a candidate) on the call's socket, attach =
   * `json` under the session key; nothing once the session is deleted.
   */
  info(uuid: string, json: object, flag = 0): void {
    const c = this.calls.get(uuid);
    if (!c?.session) return;
    const header = this.request(RtcKind.INFO, 0, flag);
    header[18] = 1;
    const attach = rtcEncrypt(Buffer.from(JSON.stringify(json)), this.sessionKey, header.readUInt32LE(8));
    this.track(header);
    this.send(rtcPacket(header, RtcBody.CALL, callBody(uuid, this.contactId, attach)), this.callSocket(c.type));
  }

  /**
   * The call's ICE reached the app's state 2 (connected): a PM call's CALL repeat ends. With a PRIV1 and a PM call
   * both connected, a login {@link TOKEN_REFRESH_S} old is refreshed.
   */
  connected(uuid: string): void {
    const c = this.calls.get(uuid);
    if (!c) return;
    c.up = true;
    if (c.type === RtcCallType.PM) clearTimeout(c.timer);
    const now = Date.now() / 1000;
    const up = (type: number) => [...this.calls.values()].some((x) => x.up && x.type === type);
    if (!up(RtcCallType.PRIV1) || !up(RtcCallType.PM) || now < this.authTimestamp + TOKEN_REFRESH_S) return;
    if (now - this.tokenCheck < TOKEN_CHECK_S) return;
    this.tokenCheck = now;
    if (this.gate()) this.login(true);
  }

  /** `rtc_retry_login` and `rtc_token_refresh_login`: at most one in 8 s. */
  private gate(): boolean {
    const now = Date.now() / 1000;
    if (now <= this.retried + RETRY_GATE_S) return false;
    this.retried = now;
    return true;
  }

  /** The app's login check while logged out: a bare reg, after a `reset` that hangs every call up and reopens the socket. */
  private retryLogin(reset: boolean): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.retryLogin(true), RETRY_LOGIN_MS);
    if (reset)
      for (const uuid of [...this.calls.keys()]) {
        this.hangup(uuid);
        this.emit("hangup", uuid);
      }
    if (!this.gate()) return;
    this.registered = false;
    this.contactId = "";
    if (reset) this.reset(this.endpoint);
    this.login(true);
  }

  private signalSocket(): Socket {
    return createSocket("udp4").on("message", (msg) => this.onDatagram(msg));
  }

  /** End a call: a PRIV1 or PM hang-up sends nothing, the session and its socket close. */
  hangup(uuid: string): void {
    const c = this.calls.get(uuid);
    if (!c) return;
    clearTimeout(c.timer);
    this.calls.delete(uuid);
    this.callSockets.get(c.type)?.close();
    this.callSockets.delete(c.type);
  }

  private repeatCall(c: RtcCall, now: number): void {
    this.send(c.packet, this.callSocket(c.type));
    const at = nextCallRepeat(c.start, now);
    if (at !== undefined) c.timer = setTimeout(() => this.repeatCall(c, at), at - Date.now());
  }

  private callSocket(type: number): Socket {
    let s = this.callSockets.get(type);
    if (!s) this.callSockets.set(type, (s = createSocket("udp4").on("message", (msg) => this.onDatagram(msg))));
    return s;
  }

  private nextSeq(): number {
    const s = Math.max(this.seq, 1);
    this.seq = (s + 1) & 0xff;
    return s;
  }

  private send(packet: Buffer, socket = this.socket): void {
    socket.send(
      wrapRtcPacket(packet),
      this.opts.port ?? RTC_SIGNAL_PORT,
      socket === this.socket ? this.host : this.callHost,
    );
  }

  private get domain(): string {
    return this.opts.domain ?? "";
  }

  private key(type: number, protocol: number, ip: string): string {
    return `${type} ${protocol} ${ip}`;
  }

  /** The key a record of that type, protocol and ip lands on: one the ip prefixes (`strncmp` over its length), or its own. */
  private slot(type: number, protocol: number, ip: string): string {
    const key = this.key(type, protocol, ip);
    return [...this.map.keys()].find((k) => k.startsWith(key)) ?? key;
  }

  /** `rtc_server_manager_add`: a new record unless its key is taken; `emit` stores it as `rtc_signal_add_server` does. */
  private add(type: number, protocol: number, ip: string, emit = true): void {
    const key = this.slot(type, protocol, ip);
    if (this.map.has(key)) return;
    const s: RtcServer = { domain: this.domain, type, ip, protocol, lastUsed: 0, avgRtt: 0 };
    this.map.set(key, s);
    if (emit) this.store(s);
  }

  /** `rtc_server_manager_choose` over the UDP records of `type`: the first highest {@link score} in key order. */
  private choose(type: number): RtcServer | undefined {
    let best: RtcServer | undefined;
    let top = -1;
    for (const [k, s] of [...this.map].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const v = score(s, Date.now());
      if (k.startsWith(this.key(type, 0, "")) && v > top) [best, top] = [s, v];
    }
    return best;
  }

  /** The client's server becomes `s`, with a fresh timeout manager (`EndpointInitNetwork`). */
  private use(s: RtcServer): void {
    [this.endpoint, this.host, this.tm] = [s, s.ip, { s: { ...s }, n: 0 }];
    this.sent.clear();
  }

  /** `EndpointResetCommonNetwork`: a new socket to `s`. */
  private reset(s: RtcServer): void {
    this.use(s);
    this.socket.close();
    this.socket = this.signalSocket();
  }

  /** `signal_timeout_manager_send_req`: await the answer to this request. */
  private track(header: Buffer): void {
    this.sent.set((header.readUInt16LE(4) << 8) | header[42]!, Date.now());
  }

  /**
   * `signal_timeout_manager_recv_resp`: an answer to a tracked request stamps the server copy (u32 running mean over
   * the manager's answers); a DISCOVER, reg or CALL answer stores the copy.
   */
  private answered(kind: number, seq: number): void {
    const at = this.sent.get((kind << 8) | seq);
    if (at === undefined) return;
    this.sent.delete((kind << 8) | seq);
    const now = Date.now();
    const s = this.tm.s;
    s.avgRtt = Math.floor(((this.tm.n * s.avgRtt + ((now - at) >>> 0)) >>> 0) / ++this.tm.n);
    s.lastUsed = now;
    if (kind === RtcKind.REG || kind === RtcKind.CALL || kind === RtcKind.DISCOVER) this.store({ ...s });
  }

  /**
   * `RTCSdkClient.onWebrtcServerInfo` with one record: it replaces the entry of its type, ip and protocol at the head;
   * over 8 of its type and protocol, the last entry of its type with the highest mean rtt goes.
   */
  private store(s: RtcServer): void {
    const list = [
      s,
      ...this.cache.servers!.filter((o) => o.type !== s.type || o.ip !== s.ip || o.protocol !== s.protocol),
    ];
    if (list.filter((o) => o.type === s.type && o.protocol === s.protocol).length > 8) {
      let drop = -1;
      list.forEach((o, i) => o.type === s.type && o.avgRtt >= (list[drop]?.avgRtt ?? 0) && (drop = i));
      if (drop >= 0) list.splice(drop, 1);
    }
    this.cache.servers = list;
    this.emit("token", { ...this.cache });
  }

  private request(kind: number, extra = 0, b44 = 0) {
    return rtcHeader({ kind, sn: this.opts.sn, seq: this.nextSeq(), route: this.route, extra, b44 });
  }

  private discover(): void {
    const header = this.request(RtcKind.DISCOVER);
    this.track(header);
    this.send(rtcPacket(header));
  }

  /** reg; `refresh` sends it bare whatever the login state, as `ClientTokenRefresh` does. */
  private login(refresh = false): void {
    const header = this.request(RtcKind.REG, WORK_PROTOCOL, this.b44);
    this.track(header);
    if (!refresh && this.registered && this.contactId) {
      const contact = Buffer.alloc(32);
      contact.write(this.contactId, "latin1");
      const auth = rtcEncrypt(this.didLic(), this.sessionKey, header.readUInt32LE(8));
      this.send(rtcPacket(header, RtcBody.KEEP_ALIVE, Buffer.concat([contact, u16(auth.length), auth])));
    } else this.send(rtcPacket(header));
    this.unauthorized = 0;
  }

  private didLic(): Buffer {
    return Buffer.from(`${this.opts.did}:${this.opts.lic}`, "latin1");
  }

  private onDatagram(msg: Buffer): void {
    const p = parseRtcDatagram(msg);
    if (!p) return;
    const kind = p.header.readUInt16LE(4);
    if (p.header[14]) this.answered(kind, p.header[42]!);
    if (kind !== RtcKind.DISCOVER && p.header[19]! & 0x01) {
      this.discovered = false;
      this.discover();
    }
    if (readNullTerminatedString(p.header.subarray(20, 36), "latin1") !== this.opts.sn) return;
    const response = p.header[14] === 1;
    if (kind === RtcKind.DISCOVER && response) this.onDiscover(p.header, p.body);
    else if (kind === RtcKind.REG && response) this.onLogin(p.header, p.body);
    else if (p.body.length < RTC_CALL_BODY_LENGTH) return;
    else if (kind === RtcKind.CALL && response) this.onCallAnswer(p.header, p.body);
    else if (kind === RtcKind.ACK && !response) this.send(reply200(p.header, callBodyHead(p.body)));
    else if (kind === RtcKind.INFO && !response) this.onInfo(p.header, p.body);
    else if (kind === RtcKind.INFO && p.header.readUInt16LE(16) === 200) this.onInfoAck(p.header, p.body);
  }

  /** The decrypted attach JSON of a call body (base64 text first when `base64`), `{}` when absent or unreadable. */
  private attach(header: Buffer, body: Buffer, base64 = false): Record<string, unknown> {
    const n = body.readUInt16LE(4);
    let a = body.subarray(RTC_CALL_BODY_LENGTH, RTC_CALL_BODY_LENGTH + n);
    try {
      if (header[18] === 1 && n) a = rtcDecrypt(a, this.sessionKey, header.readUInt32LE(8));
    } catch {
      return {};
    }
    const text = readNullTerminatedString(a);
    return jsonObject(base64 ? Buffer.from(text, "base64").toString() : text) ?? {};
  }

  private onCallAnswer(header: Buffer, body: Buffer): void {
    const uuid = callUuidOf(body);
    const c = this.calls.get(uuid);
    if (!c?.session) return;
    const status = header.readUInt16LE(16);
    if (status !== 100 && status !== 200) {
      c.session = false;
      if (header[13]! < 4 || header[13]! > 8) return;
      if (status === 480) {
        this.hangup(uuid);
        this.emit("hangup", uuid);
      } else if (status === 486) {
        clearTimeout(c.timer);
        this.emit("busy", uuid);
      }
      return;
    }
    const a = this.attach(header, body);
    if (!c.trying) {
      c.trying = true;
      this.emit("trying", uuid, a.turn);
    }
    if (status !== 200 || c.acked) return;
    c.acked = true;
    const caps = typeof a.pbsdp === "string" ? pbTransportCaps(a.pbsdp) : a.transport_caps;
    this.emit("answer", uuid, {
      ftv: typeof a.ftv === "number" ? a.ftv : undefined,
      transportCaps: typeof caps === "number" ? caps : undefined,
    });
    const ack = rtcHeader({ kind: RtcKind.ACK, sn: this.opts.sn, seq: this.nextSeq(), route: header[43]! });
    this.send(rtcPacket(ack, RtcBody.CALL, callBodyHead(body)), this.callSocket(c.type));
  }

  private onInfo(header: Buffer, body: Buffer): void {
    const uuid = callUuidOf(body);
    const c = this.calls.get(uuid);
    if (!c?.session) return this.send(reply200(header, callBodyHead(body)));
    const socket = this.callSocket(c.type);
    const ok = reply200(header, body);
    this.send(ok, socket);
    setTimeout(() => this.calls.has(uuid) && this.send(ok, socket), 15);
    const a = this.attach(header, body);
    if (c.type === RtcCallType.PRIV1) {
      const { file_candidate: line, file_candidate_num: num } = a;
      if (c.trying && typeof line === "string" && typeof num === "number") this.emit("fileCandidate", uuid, line, num);
      return;
    }
    if (typeof a.sdp === "string" && a.sdp && !c.sdp) {
      c.sdp = true;
      const o = jsonObject(a.sdp);
      if (o)
        this.emit(
          "sdp",
          uuid,
          Object.fromEntries(SDP_KEYS.map((k) => [k, typeof o[k] === "string" ? o[k] : ""])) as RtcRemoteSdp,
        );
    }
    const cand = typeof a.candidate === "string" ? a.candidate : "";
    const kind = ["host", "srflx", "relay"].find((t) => cand.includes(t));
    if (kind && !c.candidates.has(kind)) {
      c.candidates.add(kind);
      this.emit("candidate", uuid, cand);
    }
  }

  private onInfoAck(header: Buffer, body: Buffer): void {
    const uuid = callUuidOf(body);
    if (this.calls.get(uuid)?.type !== RtcCallType.PRIV1) return;
    const num = this.attach(header, body, true).file_candidate_num;
    if (typeof num === "number") this.emit("fileCandidateAck", uuid, num);
  }

  private onDiscover(header: Buffer, body: Buffer): void {
    if (header.readUInt16LE(16) !== 200) {
      this.discovered = true;
      return;
    }
    if (header[41] !== RtcBody.JSON) return;
    const o = jsonObject(readNullTerminatedString(body));
    const addr = o?.server_addr;
    if (typeof addr === "string" && addr.length >= 2) {
      if (addr === "self" || addr === this.mAddr) {
        if (addr === this.mAddr) [1, 0].forEach((p) => this.add(1, p, addr, false));
        this.discovered = true;
      } else if (!this.calls.size) {
        [1, 0].forEach((p) => this.add(1, p, addr));
        const s = this.choose(1)!;
        this.reset(s);
        this.mAddr = s.ip.slice(0, 31);
        this.discovered = true;
      }
      this.login();
    }
    const saddrs = Array.isArray(o?.saddrs) ? (o.saddrs as unknown[]).slice(0, 16) : [];
    for (const a of saddrs) if (typeof a === "string" && a) [1, 0].forEach((p) => this.add(1, p, a));
  }

  private onLogin(header: Buffer, body: Buffer): void {
    const status = header.readUInt16LE(16);
    if (status === 401 && header[41] === RtcBody.PUBKEY && body.length && this.opts.did && this.opts.lic) {
      if (++this.unauthorized >= 2) return this.retryLogin(true);
      this.registered = false;
      this.contactId = "";
      const ts = header.readUInt32LE(8);
      const modulus = readNullTerminatedString(rtcDecrypt(body, RTC_DEFAULT_KEY, ts), "latin1");
      if (modulus.length !== 256) return;
      this.sessionKey = randomChars(16);
      const rsa = rsaEncrypt(Buffer.from(this.sessionKey, "latin1"), modulus);
      const auth = rtcEncrypt(this.didLic(), this.sessionKey, ts);
      this.send(
        rtcPacket(echo(header, this.nextSeq()), RtcBody.SESSION_KEY, Buffer.concat([rsa, u16(auth.length), auth])),
      );
    } else if (status === 200) {
      this.unauthorized = 0;
      this.b44 = header[44]!;
      if (body.length && header[41] === RtcBody.KEEP_ALIVE) this.contactId = readNullTerminatedString(body, "latin1");
      if (this.registered) return;
      this.registered = true;
      clearTimeout(this.retryTimer);
      this.emit("login", this.contactId);
      this.authTimestamp = Math.floor(Date.now() / 1000);
      const { sessionKey: aes, contactId, host: addr, authTimestamp } = this;
      Object.assign(this.cache, { aes, contactId, addr, authTimestamp });
      this.emit("token", { ...this.cache });
    }
  }
}

/** `_rtc_server_compare`'s rtt term below 101 ms: 20 under 11 ms, one less per step. */
const RTT_STEPS = [11, 21, 31, 41, 51, 101].map((below, i) => [below, 20 - i] as const);

/**
 * `_rtc_server_compare` in f32: 100 for the never-written last failure, half the seconds/10 since last use (both capped at
 * 100, a stamp ahead of now counts as 100), a quarter of the rtt term plus 20 for the never-written retransmissions.
 */
function score(s: RtcServer, now: number): number {
  const f = Math.fround;
  const idle = now - s.lastUsed;
  const b = idle < 0 ? 100 : Math.min(f(f(idle) / 10_000), 100);
  const x = s.avgRtt;
  const rtt =
    RTT_STEPS.find(([below]) => x < below)?.[1] ??
    (x <= 150
      ? f(((x - 100) * -3) / 50 + 15)
      : x <= 200
        ? f((2 * (x - 150)) / -50 + 12)
        : x > 500
          ? 0
          : f(((x - 200) * -5) / 300 + 10));
  return f(100 + 0.5 * b + 0.25 * f(rtt + 20));
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const o: unknown = JSON.parse(text);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A received request's header answered 200, seq kept, over `body`. */
function reply200(rx: Buffer, body: Buffer): Buffer {
  const h = echo(rx, rx[42]!);
  h[14] = 1;
  h.writeUInt16LE(200, 16);
  return rtcPacket(h, RtcBody.CALL, body);
}

/** A received header copied as a request (the app's `NewRTCProtocolByHead`): flags and bytes 37..39 cleared. */
function echo(rx: Buffer, seq: number): Buffer {
  const h = Buffer.alloc(RTC_HEADER_LENGTH);
  for (const [from, to] of [
    [4, 6],
    [8, 19],
    [20, 37],
    [42, 57],
  ] as const)
    rx.copy(h, from, from, to);
  h[14] = 0;
  h.writeUInt16LE(0, 16);
  h[42] = seq;
  return h;
}
