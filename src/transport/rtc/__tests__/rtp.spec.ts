import { describe, expect, it } from "vitest";
import { RtpDepacketizer } from "../rtp.js";

const rtp = (seq: number, payload: number[] | Buffer, marker = false, pt = 99) => {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(9000, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
};

describe("RtpDepacketizer h264", () => {
  it("joins STAP-A and FU-A into one Annex-B access unit on the marker", () => {
    const units: Buffer[] = [];
    const d = new RtpDepacketizer("h264", (u) => units.push(u));
    d.push(rtp(1, [24, 0, 2, 0x67, 1, 0, 2, 0x68, 2]));
    d.push(rtp(2, [0x7c, 0x85, 9, 9]));
    d.push(rtp(3, [0x7c, 0x45, 8], true));
    expect(units).toHaveLength(1);
    expect(units[0].toString("hex")).toBe("0000000167010000000168020000000165090908");
  });

  it("drops a unit with a sequence gap and ignores RTCP", () => {
    const units: Buffer[] = [];
    const d = new RtpDepacketizer("h264", (u) => units.push(u));
    d.push(rtp(10, [0x7c, 0x85, 1]));
    d.push(rtp(12, [0x7c, 0x45, 2], true));
    d.push(rtp(0, [0x81, 0xc8], true, 72));
    d.push(rtp(13, [0x61, 5], true));
    expect(units.map((u) => u.toString("hex"))).toEqual(["000000016105"]);
  });
});

describe("RtpDepacketizer h265", () => {
  it("joins an AP (VPS, SPS) and an FU (IDR) into one Annex-B access unit on the marker", () => {
    const units: Buffer[] = [];
    const d = new RtpDepacketizer("h265", (u) => units.push(u));
    d.push(rtp(1, [0x60, 0x01, 0, 3, 0x40, 0x01, 0xaa, 0, 3, 0x42, 0x01, 0xbb], false, 97));
    d.push(rtp(2, [0x62, 0x01, 0x93, 9, 9], false, 97));
    d.push(rtp(3, [0x62, 0x01, 0x53, 8], true, 97));
    expect(units.map((u) => u.toString("hex"))).toEqual(["000000014001aa000000014201bb000000012601090908"]);
  });
});
