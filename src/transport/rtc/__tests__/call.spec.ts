import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket } from "node:dgram";
import { createHash } from "node:crypto";
import {
  parseRtcDatagram,
  rtcDecrypt,
  rtcEncrypt,
  rtcHeader,
  rtcPacket,
  wrapRtcPacket,
  type RtcPacket,
} from "../packet.js";
import { callBody, sdpInfo } from "../call.js";
import { RtcSignalClient } from "../signal-client.js";

const SN = "T8000P0000000000";
const DID = "XXXXXXX-000000-XXXXX";
const LIC = "AAAAAA";
const USER = "00000000000000000000000000000000";
const APP = "0123456789abcdef";
const KEY = "0123456789abcdef";
const CONTACT = "c0ffee00c0ffee00";
const TS = 1_700_000_000;

const strip = (b: Buffer) => b.toString("latin1").replace(/\0+$/, "");

describe("sdp_info", () => {
  it("is 86 bytes: flags, ufrag 6, pwd 14, key 38, iv 58, values 78/82", () => {
    const s = sdpInfo(1);
    expect(s.info).toHaveLength(86);
    expect([...s.info.subarray(0, 6)]).toEqual([0, 0, 1, 1, 1, 6]);
    expect(strip(s.info.subarray(6, 14))).toBe(s.ufrag);
    expect(s.ufrag).toMatch(/^[A-Za-z0-9+/]{4}$/);
    expect(strip(s.info.subarray(14, 38))).toBe(s.pwd);
    expect(s.pwd).toMatch(/^[A-Za-z0-9+/]{22}$/);
    expect(strip(s.info.subarray(38, 58))).toBe(s.key);
    expect(s.key).toMatch(/^[0-9a-zA-Z]{16}$/);
    expect(strip(s.info.subarray(58, 78))).toBe(s.iv);
    expect(s.iv).toMatch(/^[0-9a-zA-Z]{12}$/);
    expect([s.info.readUInt32LE(78), s.info.readUInt32LE(82)]).toEqual([s.audio, s.video]);
  });
});

describe("RtcSignalClient call", () => {
  let client: RtcSignalClient;
  let sent: { socket: Socket; p: RtcPacket }[];

  beforeEach(() => {
    sent = [];
    vi.spyOn(Socket.prototype, "send").mockImplementation(function (this: Socket, msg: unknown) {
      sent.push({ socket: this, p: parseRtcDatagram(msg as Buffer)! });
    } as never);
    client = new RtcSignalClient({ sn: SN, did: DID, lic: LIC, host: "127.0.0.1", userId: USER, appId: APP });
    client.sessionKey = KEY;
    client.contactId = CONTACT;
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A station packet of `kind` on the call body of `uuid`, its attach JSON under the session key. */
  function station(socket: Socket, kind: number, status: number, uuid: string, json?: object, b13 = 6) {
    const h = rtcHeader({ kind, sn: SN, seq: 42, route: 9, ts: TS });
    h[13] = b13;
    h[14] = status ? 1 : 0;
    h.writeUInt16LE(status, 16);
    h[18] = 1;
    const attach = json ? rtcEncrypt(Buffer.from(JSON.stringify(json)), KEY, TS) : undefined;
    const body = callBody(uuid, "station", attach);
    socket.emit("message", wrapRtcPacket(rtcPacket(h, 7, body)));
    return body;
  }

  it("sends the PM CALL: header, uuid, contact, the attach JSON in the app's key order", () => {
    const r = client.call(6);
    const { header, body } = sent[0]!.p;
    expect([header.readUInt16LE(4), header[15], header[18], header[41]]).toEqual([2, 2, 1, 7]);
    expect(header[44]).toBeGreaterThan(0);
    expect(r.uuid).toMatch(/^FF006[0-9a-f]{31}$/);
    expect(strip(body.subarray(6, 42))).toBe(r.uuid);
    expect(strip(body.subarray(42, 74))).toBe(CONTACT);
    const ts = header.readUInt32LE(8);
    const n = body.readUInt16LE(4);
    expect(body).toHaveLength(76 + n);
    const json = JSON.parse(strip(rtcDecrypt(body.subarray(76), KEY, ts))) as Record<string, string>;
    expect(Object.keys(json)).toEqual([
      "account",
      "ftv",
      "call_type",
      "eufy_p2p_type",
      "sdp_info",
      "to",
      "eufy_from_contact",
      "eufy_video_format",
      "eufy_network_type",
      "eufy_app_id",
      "token",
    ]);
    expect(json.account).toBe(createHash("md5").update(`0${USER}${ts}`).digest("hex"));
    expect([json.call_type, json.eufy_p2p_type, json.to, json.eufy_app_id]).toEqual([
      "scall",
      "priv_p2p",
      "device",
      APP,
    ]);
    const info = Buffer.from(json.sdp_info!, "base64");
    expect(strip(info.subarray(6, 14))).toBe(r.ufrag);
    expect(strip(rtcDecrypt(Buffer.from(json.token!, "base64"), KEY, ts))).toBe(`${DID}:${LIC}`);
  });

  it("100 Trying surfaces its turn once; 200 is answered once by the kind-3 ack", () => {
    const { uuid } = client.call(6);
    const socket = sent[0]!.socket;
    const trying = vi.fn();
    const answer = vi.fn();
    client.on("trying", trying).on("answer", answer);
    const turn = { turn_addr: "192.0.2.1", turn_port: 3478, turn_user: "u", turn_password: "p" };
    station(socket, 2, 100, uuid, { turn });
    station(socket, 2, 100, uuid, { turn });
    expect(trying.mock.calls).toEqual([[uuid, turn]]);
    // pbsdp: field 3 { field 16: 3 }
    const pbsdp = Buffer.from([0x1a, 3, 0x80, 0x01, 3]).toString("base64");
    const body = station(socket, 2, 200, uuid, { ftv: 20, pbsdp });
    station(socket, 2, 200, uuid, { ftv: 20, pbsdp });
    expect(answer.mock.calls).toEqual([[uuid, { ftv: 20, transportCaps: 3 }]]);
    const acks = sent.filter((s) => s.p.header.readUInt16LE(4) === 3);
    expect(acks).toHaveLength(1);
    const ack = acks[0]!;
    expect(ack.socket).toBe(socket);
    const h = ack.p.header;
    expect([h[14], h.readUInt16LE(16), h[18], h[41], h[43]]).toEqual([0, 0, 0, 7, 9]);
    const head = Buffer.from(body.subarray(0, 76));
    head.writeUInt16LE(0, 4);
    expect(ack.p.body).toEqual(head);
  });

  it("answers a station INFO 200 and reads the PM sdp and one candidate per type", async () => {
    const { uuid } = client.call(6);
    const socket = sent[0]!.socket;
    const sdp = vi.fn();
    const candidate = vi.fn();
    client.on("sdp", sdp).on("candidate", candidate);
    const host = "candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host";
    const lines = { "ice-u": "a=ice-ufrag:abcd", "ice-p": "a=ice-pwd:0123456789012345678901" };
    const body = station(socket, 4, 0, uuid, { sdp: JSON.stringify(lines), candidate: host });
    station(socket, 4, 0, uuid, { candidate: host.replace("50000", "50001") });
    expect(sdp.mock.calls).toEqual([[uuid, { ...lines, asc: "", vsc: "", sg: "", sgc: "" }]]);
    expect(candidate.mock.calls).toEqual([[uuid, host]]);
    await new Promise((r) => setTimeout(r, 20));
    const oks = sent.filter((s) => s.p.header.readUInt16LE(4) === 4);
    expect(oks).toHaveLength(4);
    const ok = oks[0]!;
    expect(ok.socket).toBe(socket);
    expect([ok.p.header[14], ok.p.header.readUInt16LE(16), ok.p.header[42]]).toEqual([1, 200, 42]);
    expect(ok.p.body).toEqual(body);
  });

  it("486 is busy and ends the repeat, socket open; 480 hangs up; byte 13 outside 4..8 deletes only the session", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(TS * 1000);
    const busy = vi.fn();
    const hangup = vi.fn();
    const trying = vi.fn();
    client.on("busy", busy).on("hangup", hangup).on("trying", trying);
    const count = (socket: Socket) => sent.filter((s) => s.socket === socket).length;

    const a = client.call(6).uuid;
    const pm = sent.at(-1)!.socket;
    const close = vi.spyOn(pm, "close");
    station(pm, 2, 486, a);
    vi.advanceTimersByTime(5000);
    expect([busy.mock.calls, count(pm), close.mock.calls.length]).toEqual([[[a]], 1, 0]);

    const b = client.call(5).uuid;
    const priv1 = sent.at(-1)!.socket;
    station(priv1, 2, 480, b);
    vi.advanceTimersByTime(5000);
    expect([hangup.mock.calls, count(priv1)]).toEqual([[[b]], 1]);

    const c = client.call(6).uuid;
    const before = count(pm);
    station(pm, 2, 486, c, undefined, 0);
    station(pm, 2, 100, c, {});
    vi.advanceTimersByTime(5000);
    expect([busy.mock.calls.length, trying.mock.calls.length, count(pm) - before > 5]).toEqual([1, 0, true]);
  });

  it("repeats the CALL unchanged every 500 ms in its first second, then every second, until 14 s, Trying or not", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(TS * 1000);
    const { uuid } = client.call(6);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(3);
    station(sent[0]!.socket, 2, 100, uuid, {});
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(17);
    expect(new Set(sent.map((s) => s.p.body.toString("hex"))).size).toBe(1);
  });
});
