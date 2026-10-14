import { describe, expect, it } from "vitest";
import { H264Depacketizer, rejectDataSection, h264SpsSize, midOf } from "../call-live.js";

const rtp = (seq: number, payload: number[], marker = false, pt = 99) => {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(9000, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
};

describe("H264Depacketizer", () => {
  it("joins STAP-A and FU-A into one Annex-B access unit on the marker", () => {
    const units: Buffer[] = [];
    const d = new H264Depacketizer((u) => units.push(u));
    d.push(rtp(1, [24, 0, 2, 0x67, 1, 0, 2, 0x68, 2]));
    d.push(rtp(2, [0x7c, 0x85, 9, 9]));
    d.push(rtp(3, [0x7c, 0x45, 8], true));
    expect(units).toHaveLength(1);
    expect(units[0].toString("hex")).toBe("0000000167010000000168020000000165090908");
  });

  it("drops a unit with a sequence gap and ignores RTCP", () => {
    const units: Buffer[] = [];
    const d = new H264Depacketizer((u) => units.push(u));
    d.push(rtp(10, [0x7c, 0x85, 1]));
    d.push(rtp(12, [0x7c, 0x45, 2], true));
    d.push(rtp(0, [0x81, 0xc8], true, 72));
    d.push(rtp(13, [0x61, 5], true));
    expect(units.map((u) => u.toString("hex"))).toEqual(["000000016105"]);
  });
});

describe("helpers", () => {
  it("finds the video mid", () => {
    const sdp = "v=0\r\nm=audio 1 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\nm=video 1 UDP/TLS/RTP/SAVPF 99\r\na=mid:1\r\n";
    expect(midOf(sdp, "video")).toBe("1");
  });
  it("reads the geometry from main and high profile SPS (x264-generated)", () => {
    expect(h264SpsSize(Buffer.from("674d401feca020030d8088000003000800000300f078c18cb0", "hex"))).toEqual({
      width: 1024,
      height: 768,
    });
    expect(h264SpsSize(Buffer.from("6764001facd9405005bb0110000003001000000301e0f1831960", "hex"))).toEqual({
      width: 1280,
      height: 720,
    });
  });
});

describe("rejectDataSection", () => {
  it("disables the data channel and drops it from BUNDLE, leaving media untouched", () => {
    const offer = [
      "v=0",
      "a=group:BUNDLE 0 1 2",
      "m=audio 1 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "m=video 1 UDP/TLS/RTP/SAVPF 99",
      "a=mid:1",
      "m=application 1 UDP/DTLS/SCTP webrtc-datachannel",
      "a=mid:2",
      "a=sctp-port:5000",
      "",
    ].join("\r\n");
    const out = rejectDataSection(offer).split("\r\n");
    expect(out).toContain("a=group:BUNDLE 0 1");
    expect(out).toContain("m=application 0 UDP/DTLS/SCTP webrtc-datachannel");
    expect(out).toContain("m=video 1 UDP/TLS/RTP/SAVPF 99");
  });
});
