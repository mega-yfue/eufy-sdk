import { createCipheriv, createDecipheriv } from "node:crypto";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RtcDataChannel, cmdGcm, kcpMulti, readLinkMessage, wrtcLink } from "../data-channel.js";
import { mediaGcm } from "../pm-live.js";
import { Kcp } from "../kcp.js";

const KEY = "0123456789abcdefXYZ";
const AAD = Buffer.from("eufy security");

/** A station-side message: the 20-byte head (length at 8, CRC-32 at 12) over a Wrtc link packet. */
function stationMessage(type: number, data: Buffer, multi: boolean): Buffer {
  const w = wrtcLink(type, data, multi);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(w.length, 8);
  head.writeUInt32LE(crc32(w), 12);
  return Buffer.concat([head, w]);
}

function frame(cmd: number, body: Buffer, version = 1): Buffer {
  const h = Buffer.alloc(16);
  h.write("XZYH");
  h.writeUInt16LE(cmd, 4);
  h.writeUInt32LE(body.length, 6);
  h[10] = version;
  return Buffer.concat([h, body]);
}

const open: RtcDataChannel[] = [];
afterEach(() => open.splice(0).forEach((c) => c.close()));

/**
 * Our channel against a fake station on the other KCP end (conv 1, the app's parameters). `onFrame` answers each
 * Wrtc payload the station receives with station messages; `datagrams` keeps every datagram we sent.
 */
function station(multi: boolean, gcm: boolean, onFrame: (wrtcData: Buffer, type: number) => Buffer[]) {
  const datagrams: Buffer[] = [];
  let channel: RtcDataChannel | undefined;
  const pre = Buffer.alloc(32);
  pre.writeUInt32LE(1, 0);
  pre.writeUInt32LE(1, 4);
  const peer = new Kcp(1, (d) => channel!.input(multi ? Buffer.concat([pre, d]) : d));
  peer.nodelay(1, 2, 2, 1);
  peer.wndsize(512, 512);
  peer.setmtu(1200);
  channel = new RtcDataChannel(
    (d) => {
      datagrams.push(d);
      peer.input(multi ? d.subarray(32) : d);
    },
    { multi, key: KEY, gcm },
  );
  channel.connected = true;
  const timer = setInterval(() => {
    peer.update(Date.now());
    for (let m; (m = peer.recv());) {
      const hdr = m.readUInt16LE(2);
      for (const r of onFrame(m.subarray(hdr), m[multi ? 16 : 12]!)) peer.send(r);
    }
  }, 1);
  channel.once("close", () => clearInterval(timer));
  open.push(channel);
  return { channel, datagrams };
}

describe("Wrtc link framing", () => {
  it("writes the Multi and Single headers of the traced tables", () => {
    const m = wrtcLink(1, Buffer.from("abc"), true);
    const s = wrtcLink(0x62, Buffer.from("abc"), false);
    expect([m.readUInt16LE(0), m.readUInt16LE(2), m.readUInt32LE(4), m[8], m[16]]).toEqual([9, 24, 3, 1, 1]);
    expect(Math.abs(m.readUInt32LE(12) - Date.now() / 1000)).toBeLessThan(2);
    expect([s.readUInt16LE(0), s.readUInt16LE(2), s.readUInt16LE(4), s[6], s[7], s[12]]).toEqual([
      9, 20, 3, 1, 0, 0x62,
    ]);
    expect(s.readUInt32LE(16)).toBe(m.readUInt32LE(20) + 1);
    expect([m.subarray(24).toString(), s.subarray(20).toString()]).toEqual(["abc", "abc"]);
  });

  it("checks the receive head's length and CRC-32", () => {
    const good = stationMessage(3, Buffer.from("notify"), true);
    expect(readLinkMessage(good, true)).toEqual({ type: 3, data: Buffer.from("notify") });
    const bad = Buffer.from(good);
    bad[bad.length - 1]! ^= 1;
    expect(readLinkMessage(bad, true)).toBeUndefined();
  });

  it("prefixes every Multi datagram with conv, 1 and 24 zero bytes", async () => {
    const { channel, datagrams } = station(true, false, () => [stationMessage(1, frame(1350, Buffer.alloc(4)), true)]);
    await channel.command(1350, '{"cmd":1}');
    expect(datagrams[0]!.subarray(0, 32).toString("hex")).toBe(`01000000${"01000000"}${"00".repeat(24)}`);
  });
});

describe("RtcDataChannel commands", () => {
  it("resolves a 1350 with the station's reply over a fake PRIV1 peer", async () => {
    const seen: Buffer[] = [];
    const reply = Buffer.from([0, 0, 0, 0, 0x6f, 0x6b]);
    const { channel } = station(false, false, (d, type) => {
      seen.push(d);
      return type === 1 ? [stationMessage(1, frame(1350, reply), false)] : [];
    });
    await expect(channel.command(1350, '{"cmd":1103}', 3)).resolves.toEqual(reply);
    const sent = seen[0]!;
    expect([
      sent.toString("latin1", 0, 4),
      sent.readUInt16LE(4),
      sent.readUInt32LE(6),
      sent[10],
      sent[12],
      sent[13],
    ]).toEqual(["XZYH", 1350, 12, 1, 3, 0]);
    expect(sent.subarray(16).toString()).toBe('{"cmd":1103}');
  });

  it("seals the command AES-128-GCM with the traced layout and opens a sealed notify", async () => {
    const key = Buffer.from(KEY.slice(0, 16));
    const seen: Buffer[] = [];
    const { channel } = station(true, true, (d) => {
      seen.push(d);
      const iv = Buffer.alloc(12, 7);
      const c = createCipheriv("aes-128-gcm", key, iv).setAAD(AAD);
      const ct = Buffer.concat([c.update("hello"), c.final()]);
      return [
        stationMessage(1, frame(1350, Buffer.alloc(4)), true),
        stationMessage(3, frame(1700, Buffer.concat([c.getAuthTag(), iv, ct]), 0x0a), true),
      ];
    });
    const notified = new Promise<[number, Buffer]>((resolve) => channel.once("notify", (c, b) => resolve([c, b])));
    await channel.command(1350, '{"cmd":1103}');
    const f = seen[0]!;
    const body = f.subarray(16);
    expect([f[10], f[13], f.readUInt32LE(6), body.readUInt32LE(28)]).toEqual([0x0a, 1, 12 + 32, 0x01020304]);
    const d = createDecipheriv("aes-128-gcm", key, body.subarray(16, 28)).setAAD(AAD);
    d.setAuthTag(body.subarray(0, 16));
    expect(Buffer.concat([d.update(body.subarray(32)), d.final()]).toString()).toBe('{"cmd":1103}');
    await expect(notified).resolves.toEqual([1700, Buffer.from("hello")]);
  });

  it("runs the KCP detect: the bare 1139 every second, closed when the station stays silent for 8 s", async () => {
    vi.useFakeTimers();
    try {
      const beats: Buffer[] = [];
      const silent = station(false, false, (d) => (beats.push(d), []));
      const closed = vi.fn();
      silent.channel.on("close", closed).detect();
      await vi.advanceTimersByTimeAsync(7_990);
      expect(closed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(closed).toHaveBeenCalledOnce();
      expect(beats).toHaveLength(8);
      expect(beats[0]).toEqual(Buffer.from("XZYH\x73\x04" + "\0".repeat(10), "latin1"));

      const heard = station(false, false, () => [stationMessage(1, frame(1139, Buffer.alloc(0)), false)]);
      const kept = vi.fn();
      heard.channel.on("close", kept).detect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(kept).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hangs a heard channel up when neither KCP input nor ack progress came for 10 s, as the app's manager does", async () => {
    vi.useFakeTimers();
    try {
      const peer = new Kcp(1, (d) => dead.input(d));
      peer.nodelay(1, 2, 2, 1);
      const sent: Buffer[] = [];
      const dead = new RtcDataChannel((d) => sent.push(d), { multi: false, key: KEY, gcm: false });
      open.push(dead);
      const closed = vi.fn();
      dead.on("close", closed);
      peer.send(stationMessage(1, frame(1139, Buffer.alloc(0)), false));
      peer.update(Date.now());
      await vi.advanceTimersByTimeAsync(10_000);
      expect([closed.mock.calls.length, sent.length > 0]).toEqual([0, true]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(closed).toHaveBeenCalledOnce();

      const beats: Buffer[] = [];
      const alive = station(false, false, (d) =>
        beats.push(d) === 1 ? [stationMessage(1, frame(1103, Buffer.alloc(0)), false)] : [],
      );
      const kept = vi.fn();
      alive.channel.on("close", kept);
      void alive.channel.command(1103, "{}");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kept).not.toHaveBeenCalled();
      expect(beats.length).toBeGreaterThan(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits 35 s for a 1060's reply and 20 s for any other, as ack_reader_get_ack does", async () => {
    vi.useFakeTimers();
    try {
      const sent: Buffer[] = [];
      const ch = new RtcDataChannel((d) => sent.push(d), { multi: false, key: KEY, gcm: false });
      ch.connected = true;
      open.push(ch);
      const long = vi.fn();
      const short = vi.fn();
      ch.command(1060, "{}").catch(long);
      ch.command(1103, "{}").catch(short);
      await vi.advanceTimersByTimeAsync(20_000);
      expect([long.mock.calls.length, short.mock.calls.length]).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(long).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates the command GCM by model and firmware as the app does", () => {
    expect([cmdGcm("T9000P0000000000", 4099), cmdGcm("T9000P0000000000", 4100)]).toEqual([false, true]);
    expect([cmdGcm("T8N00P0000000000", 1150), cmdGcm("T8N00P0000000000", 1205)]).toEqual([true, false]);
    expect([cmdGcm("T8025P0000000000", 9999), cmdGcm("T8410P0000000000", 1)]).toEqual([false, true]);
  });

  it("splits the media GCM gate from the command one where the app's differ", () => {
    expect([mediaGcm("T8223P0000000000", 1), cmdGcm("T8223P0000000000", 1)]).toEqual([true, false]);
    expect([mediaGcm("T8172P0000000000", 1021), cmdGcm("T8172P0000000000", 1021)]).toEqual([true, false]);
    expect([mediaGcm("T9000P0000000000", 4099), mediaGcm("T9000P0000000000", 4100)]).toEqual([false, true]);
  });

  it("picks the PRIV1 KCP type off the webrtc_sdk_version as file_agent_get_kcp_type does", () => {
    expect([kcpMulti("T9000P0000000000", "9.1.1"), kcpMulti("T9000P0000000000", "0.1.2")]).toEqual([false, true]);
    expect([kcpMulti("T8223P0000000000", "6.1.2"), kcpMulti("T8223P0000000000", "1.2.0")]).toEqual([false, true]);
    expect([kcpMulti("T8030P0000000000", "x"), kcpMulti("T9000P0000000000", "x")]).toEqual([false, true]);
    expect([kcpMulti("T8170P0000000000", "0.0.0"), kcpMulti("T9000P0000000000")]).toEqual([true, true]);
  });
});
