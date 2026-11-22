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
 *    without a reg between is a login failure.
 * 4. 200 with body kind 6 = the NUL-terminated contact_id; header byte 44 is echoed in later regs.
 *
 * The app's work protocol (2, header byte 15 of reg) starts no login timer: reg goes out once per settled
 * DISCOVER, and nothing resends it.
 */
import { EventEmitter } from "node:events";
import { createSocket, type Socket } from "node:dgram";
import { randomInt } from "node:crypto";
import { readNullTerminatedString } from "../p2p/codec.js";
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
const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The device record's inputs: hub serial, `p2p_did`, `p2p_license`, first IPv4 `signaling_servers` host. */
export interface RtcSignalOptions {
  sn: string;
  did: string;
  lic: string;
  host: string;
  port?: number;
}

export interface RtcSignalEvents {
  /** First 200 after a key exchange: the contact_id. */
  login: [contactId: string];
  /** A second 401 in a row. */
  failure: [];
}

export class RtcSignalClient extends EventEmitter<RtcSignalEvents> {
  /** The server the client speaks to; DISCOVER may switch it. */
  host: string;
  contactId = "";
  sessionKey = "";
  private readonly socket: Socket = createSocket("udp4");
  private readonly route = randomInt(256);
  private seq = 0;
  private discovered = false;
  private registered = false;
  private unauthorized = 0;
  private b44 = 0;
  private discoverTimer?: NodeJS.Timeout;

  constructor(private readonly opts: RtcSignalOptions) {
    super();
    this.host = opts.host;
    this.socket.on("message", (msg) => this.onDatagram(msg));
  }

  /** Bind and start discovering. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.bind(0, resolve));
    this.discover();
    this.discoverTimer = setInterval(() => this.discovered || this.discover(), DISCOVER_INTERVAL_MS);
  }

  close(): void {
    clearInterval(this.discoverTimer);
    this.socket.close();
  }

  private nextSeq(): number {
    const s = Math.max(this.seq, 1);
    this.seq = (s + 1) & 0xff;
    return s;
  }

  private send(packet: Buffer): void {
    this.socket.send(wrapRtcPacket(packet), this.opts.port ?? RTC_SIGNAL_PORT, this.host);
  }

  private request(kind: number, extra = 0, b44 = 0) {
    return rtcHeader({ kind, sn: this.opts.sn, seq: this.nextSeq(), route: this.route, extra, b44 });
  }

  private discover(): void {
    this.send(rtcPacket(this.request(RtcKind.DISCOVER)));
  }

  private login(): void {
    const header = this.request(RtcKind.REG, WORK_PROTOCOL, this.b44);
    if (this.registered && this.contactId) {
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
    if (kind !== RtcKind.DISCOVER && p.header[19]! & 0x01) {
      this.discovered = false;
      this.discover();
    }
    if (p.header[14] !== 1 || readNullTerminatedString(p.header.subarray(20, 36), "latin1") !== this.opts.sn) return;
    if (kind === RtcKind.DISCOVER) this.onDiscover(p.header, p.body);
    else if (kind === RtcKind.REG) this.onLogin(p.header, p.body);
  }

  private onDiscover(header: Buffer, body: Buffer): void {
    if (header.readUInt16LE(16) !== 200) {
      this.discovered = true;
      return;
    }
    if (header[41] !== RtcBody.JSON) return;
    let addr: unknown;
    try {
      addr = (JSON.parse(readNullTerminatedString(body)) as { server_addr?: unknown }).server_addr;
    } catch {
      return;
    }
    if (typeof addr !== "string" || addr.length < 2) return;
    if (addr !== "self") this.host = addr;
    this.discovered = true;
    this.login();
  }

  private onLogin(header: Buffer, body: Buffer): void {
    const status = header.readUInt16LE(16);
    if (status === 401 && header[41] === RtcBody.PUBKEY && body.length && this.opts.did && this.opts.lic) {
      if (++this.unauthorized >= 2) {
        this.registered = false;
        this.emit("failure");
        return;
      }
      this.registered = false;
      this.contactId = "";
      const ts = header.readUInt32LE(8);
      const modulus = readNullTerminatedString(rtcDecrypt(body, RTC_DEFAULT_KEY, ts), "latin1");
      if (modulus.length !== 256) return;
      this.sessionKey = Array.from({ length: 16 }, () => ALNUM[randomInt(ALNUM.length)]).join("");
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
      this.emit("login", this.contactId);
    }
  }
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
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
