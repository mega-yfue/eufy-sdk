import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  PTCS_HEADER_LENGTH,
  PtcsChannel,
  PtcsFramer,
  PtcsReassembler,
  frameIdClock,
  linkTypeForChannel,
  packetize,
  parsePtcsHeader,
} from "../ptcs-framer.js";
import { PortalLinkType } from "../portal-packet.js";

/**
 * Wire vectors recorded from the portal's own packetiser (libsctp V1.0.3) with `maxPacketBytes` 800:
 * the frame pushed in and the packets that came out. `frameId` is the clock value it drew.
 */
interface Vector {
  frameHex: string;
  frameId: number;
  channel: number;
  wire: string[];
}
const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/ptcs-vectors.json", import.meta.url), "utf8")) as Vector[];

describe("PTCS packetize", () => {
  it.each(VECTORS.map((v) => [v.frameHex.length / 2, v] as const))(
    "reproduces the portal's packets byte for byte for a %i-byte frame",
    (_len, v) => {
      const frame = Buffer.from(v.frameHex, "hex");
      const packets = packetize(frame, { frameId: v.frameId, channel: v.channel, payloadBytes: 800 });
      expect(packets.map((p) => p.toString("hex"))).toEqual(v.wire);
    },
  );

  it("parses what it built", () => {
    const [pkt] = packetize(Buffer.alloc(81, 1), {
      frameId: 0xd5248928,
      channel: PtcsChannel.NOTIFY,
      payloadBytes: 800,
    });
    expect(pkt!.length).toBe(PTCS_HEADER_LENGTH + 800);
    expect(parsePtcsHeader(pkt!)).toEqual({
      channel: PtcsChannel.NOTIFY,
      sequence: 0,
      frameId: 0xd5248928,
      frameLength: 81,
      index: 0,
      last: true,
      payloadLength: 81,
    });
    expect(parsePtcsHeader(Buffer.from("XZYH"))).toBeUndefined();
  });

  it("splits at the payload size and flags only the last packet", () => {
    const packets = packetize(Buffer.alloc(1601, 7), { frameId: 1, payloadBytes: 800 });
    expect(packets).toHaveLength(3);
    expect(packets.map((p) => parsePtcsHeader(p)!.last)).toEqual([false, false, true]);
    expect(packets.map((p) => parsePtcsHeader(p)!.payloadLength)).toEqual([800, 800, 1]);
    expect(() => packetize(Buffer.alloc(1), { frameId: 1, payloadBytes: 2000 })).toThrow(RangeError);
  });
});

describe("PTCS reassembly", () => {
  it("rebuilds every recorded frame, on the recorded channel", () => {
    for (const v of VECTORS) {
      const got: Array<[Buffer, number]> = [];
      const r = new PtcsReassembler((f, ch) => got.push([f, ch]));
      for (const w of v.wire) expect(r.push(Buffer.from(w, "hex"))).toBe(true);
      expect(got).toHaveLength(1);
      expect(got[0]![0].toString("hex")).toBe(v.frameHex);
      expect(got[0]![1]).toBe(v.channel);
      expect(r.pending).toBe(0);
    }
  });

  it("accepts packets out of order and keeps frames apart by id", () => {
    const a = packetize(Buffer.alloc(1700, 0xaa), { frameId: 10, payloadBytes: 800 });
    const b = packetize(Buffer.alloc(900, 0xbb), { frameId: 11, payloadBytes: 800 });
    const got: number[] = [];
    const r = new PtcsReassembler((f) => got.push(f.length));
    r.push(a[2]!);
    r.push(b[1]!);
    r.push(a[0]!);
    r.push(b[0]!);
    expect(got).toEqual([900]);
    r.push(a[1]!);
    expect(got).toEqual([900, 1700]);
  });

  it("never delivers a frame with a packet missing, and forgets it once stale", () => {
    let now = 0;
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f), { staleMs: 15_000, now: () => now });
    const pk = packetize(Buffer.alloc(2000, 1), { frameId: 5, payloadBytes: 800 });
    r.push(pk[0]!);
    r.push(pk[2]!);
    expect(got).toEqual([]);
    expect(r.pending).toBe(1);
    now = 20_000;
    expect(r.expire()).toBe(1);
    expect(r.pending).toBe(0);
  });

  it("rejects a frame whose lengths don't add up", () => {
    const pk = packetize(Buffer.alloc(100, 1), { frameId: 9, payloadBytes: 800 });
    pk[0]!.writeUInt32LE(101, 12);
    const got: Buffer[] = [];
    const r = new PtcsReassembler((f) => got.push(f));
    expect(r.push(pk[0]!)).toBe(false);
    expect(got).toEqual([]);
  });
});

describe("PtcsFramer", () => {
  it("frames outbound, reassembles inbound, maps channels to link types, and passes bare XZYH through", async () => {
    const wire: Buffer[] = [];
    const frames: Array<[Buffer, number]> = [];
    const f = new PtcsFramer({ nextFrameId: () => 42 });
    await f.init(
      (p) => wire.push(p),
      (frame, lt) => frames.push([frame, lt]),
    );
    const out = Buffer.from("XZYH" + "x".repeat(1100));
    f.sendFrame(out);
    expect(wire).toHaveLength(2);
    expect(parsePtcsHeader(wire[0]!)?.frameId).toBe(42);
    for (const p of packetize(Buffer.from("notify!"), { frameId: 7, channel: PtcsChannel.NOTIFY })) f.recvPacket(p);
    f.recvPacket(Buffer.from("XZYHbare-16-bytes!"));
    expect(frames.map(([b, lt]) => [b.toString(), lt])).toEqual([
      ["notify!", PortalLinkType.NOTIFY],
      ["XZYHbare-16-bytes!", PortalLinkType.COMMAND],
    ]);
    f.destroy();
    expect(f.isReady()).toBe(false);
    expect(() => f.sendFrame(out)).toThrow(/not initialised/);
  });

  it("maps the portal's channels", () => {
    expect(linkTypeForChannel(0)).toBe(PortalLinkType.COMMAND);
    expect(linkTypeForChannel(2)).toBe(PortalLinkType.NOTIFY);
    expect(linkTypeForChannel(3)).toBe(PortalLinkType.FILE);
    expect(linkTypeForChannel(4)).toBe(PortalLinkType.PLAYBACK);
    expect(linkTypeForChannel(5)).toBe(PortalLinkType.LIVE);
    expect(linkTypeForChannel(77)).toBe(PortalLinkType.INNER);
  });

  it("draws ids from a clock and never repeats one", () => {
    const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(99);
    const next = frameIdClock(clock);
    expect([next(), next(), next()]).toEqual([100, 101, 102]);
  });
});

describe("the portal's own packets", () => {
  // Captured live from security.eufy.com on the command channel of a HomeBase S1 Pro: the start-live
  // command it sends, verbatim up to the end of the frame (the rest of the packet is zero padding).
  // The account id is replaced by forty ASCII zeros — same byte count, so every length stays the real
  // one. Everything the framer writes has to match
  // it byte for byte, which is what pins the payload size, the frame counter and the flags.
  const PORTAL_START_LIVE =
    "50544353030019006f0a07d898000000000098440000000000000000585a59484605880000000097ff0000027b226163" +
    "636f756e745f6964223a2230303030303030303030303030303030303030303030303030303030303030303030303030" +
    "303030222c22636d64223a313130332c227061796c6f6164223a7b226368616e6e656c5f696e666f223a7b2261727261" +
    "795f73697a65223a332c226368616e6e656c5f6172726179223a5b312c302c325d7d7d7d";

  it("matches the header the portal put on the wire", () => {
    const captured = Buffer.from(PORTAL_START_LIVE, "hex");
    const header = parsePtcsHeader(captured)!;
    expect(header).toEqual({
      channel: PtcsChannel.COMMAND,
      sequence: 25,
      frameId: 0xd8070a6f,
      frameLength: 152,
      index: 0,
      last: true,
      payloadLength: 152,
    });

    // Rebuilt from the same frame: identical bytes, and the full packet is 1028 — 28 + 1000.
    const frame = captured.subarray(PTCS_HEADER_LENGTH, PTCS_HEADER_LENGTH + header.frameLength);
    const [rebuilt] = packetize(frame, { frameId: header.frameId, sequence: header.sequence });
    expect(rebuilt!.length).toBe(1028);
    expect(rebuilt!.subarray(0, PTCS_HEADER_LENGTH + header.frameLength)).toEqual(captured);
  });

  it("steps the frame counter once per frame, not once per packet", () => {
    const wire: Buffer[] = [];
    const f = new PtcsFramer({ nextFrameId: () => 1, sequence: 25 });
    void f.init(
      (p) => wire.push(p),
      () => {},
    );
    f.sendFrame(Buffer.from("XZYH" + "x".repeat(1500))); // two packets, one frame
    f.sendFrame(Buffer.from("XZYH" + "y".repeat(10))); // one packet, next frame
    expect(wire.map((p) => parsePtcsHeader(p)!.sequence)).toEqual([25, 25, 26]);
    f.destroy();
  });
});
