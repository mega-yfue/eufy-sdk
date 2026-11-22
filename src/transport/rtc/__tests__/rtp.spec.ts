import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { RTC_SRTP_KEY, RtpDepacketizer, SrtpReceiver, aesCm, srtpKey } from "../rtp.js";

const hex = (s: string) => Buffer.from(s, "hex");
const rtp = (seq: number, payload: number[] | Buffer, marker = false, pt = 99) => {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(9000, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
};

describe("SRTP (RFC 3711 Appendix B)", () => {
  it("B.2: AES-CM keystream", () => {
    const ks = aesCm(
      hex("2B7E151628AED2A6ABF7158809CF4F3C"),
      hex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD"),
      0,
      0,
      Buffer.alloc(48),
    );
    expect(ks.toString("hex").toUpperCase()).toBe(
      "E03EAD0935C95E80E166B16DD92B4EB4D23513162B02D0F72A43A2FE4A5F97AB41E95B3BB0A2E8DD477901E4FCA894C0",
    );
  });

  it("B.3: key derivation", () => {
    const [key, salt] = [hex("E1F97A0D3E018BE0D64FA32C06DE4139"), hex("0EC675AD498AFEEBB6960B3AABE6")];
    expect(srtpKey(key, salt, 0, 16).toString("hex").toUpperCase()).toBe("C61E7A93744F39EE10734AFE3FF7A087");
    expect(srtpKey(key, salt, 2, 14).toString("hex").toUpperCase()).toBe("30CBBC08863D8C85D49DB34A9AE1");
    expect(srtpKey(key, salt, 1, 20).toString("hex").toUpperCase()).toBe("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4");
  });

  it("unprotects a station SRTP packet under the SDES constant and drops a bad tag", () => {
    const [m, s] = [RTC_SRTP_KEY.subarray(0, 16), RTC_SRTP_KEY.subarray(16)];
    const header = rtp(70000 & 0xffff, []);
    header.writeUInt32BE(0x01020304, 8);
    const enc = aesCm(srtpKey(m, s, 0, 16), srtpKey(m, s, 2, 14), 0x01020304, 70000 & 0xffff, Buffer.from("hello"));
    const body = Buffer.concat([header, enc]);
    const tag = createHmac("sha1", srtpKey(m, s, 1, 20))
      .update(body)
      .update(Buffer.alloc(4))
      .digest()
      .subarray(0, 10);
    const rx = new SrtpReceiver();
    expect(
      rx
        .unprotect(Buffer.concat([body, tag]))
        ?.subarray(12)
        .toString(),
    ).toBe("hello");
    tag[0]! ^= 1;
    expect(rx.unprotect(Buffer.concat([body, tag]))).toBeUndefined();
  });
});

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
