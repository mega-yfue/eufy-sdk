import { describe, expect, it } from "vitest";
import {
  PORTAL_HEADER_LENGTH,
  PortalLinkType,
  SegmentCounter,
  TWO_INT_BODY_COMMANDS,
  buildPortalHeader,
  buildPortalPacket,
  isPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
} from "../portal-packet.js";

describe("portal packet header", () => {
  it("lays the 16 bytes out exactly as the portal's Gr() does", () => {
    const h = buildPortalHeader(1350, 0x0102, 255, 7, 0, 2);
    expect(h.length).toBe(PORTAL_HEADER_LENGTH);
    expect(h.subarray(0, 4).toString("ascii")).toBe("XZYH");
    expect(h.readUInt16LE(4)).toBe(1350);
    expect(h.readUInt32LE(6)).toBe(0x0102);
    expect([h[10], h[11], h[12], h[13], h[14], h[15]]).toEqual([0, 7, 255, 0, 0, 2]);
    expect(h.toString("hex")).toBe("585a5948" + "4605" + "02010000" + "00" + "07" + "ff" + "00" + "00" + "02");
  });

  it("parses its own output and refuses a foreign buffer", () => {
    const h = buildPortalHeader(1224, 12, 0, 200, 1, 2);
    expect(parsePortalHeader(h)).toEqual({
      commandId: 1224,
      paramLength: 12,
      segment: 200,
      channel: 0,
      isResponse: 1,
      devType: 2,
    });
    expect(parsePortalHeader(Buffer.from("PTCS0000000000000000"))).toBeUndefined();
    expect(parsePortalHeader(Buffer.from("XZYH"))).toBeUndefined();
    expect(isPortalPacket(h)).toBe(true);
    expect(isPortalPacket(Buffer.alloc(3))).toBe(false);
  });
});

describe("portal packet bodies", () => {
  it("sends a SET_PAYLOAD envelope as clear JSON with the header sized to it", () => {
    const payload = { account_id: "abc", cmd: 1224, mValue3: 0, payload: { mode_type: 1 } };
    const pkt = buildPortalPacket({ commandId: 1350, channel: 255, segment: 3, payload });
    const body = JSON.stringify(payload);
    expect(pkt.length).toBe(PORTAL_HEADER_LENGTH + body.length);
    expect(parsePortalHeader(pkt)?.paramLength).toBe(body.length);
    expect(pkt.subarray(PORTAL_HEADER_LENGTH).toString("utf8")).toBe(body);
  });

  it("encodes the portal's two-int commands as the 136-byte struct, account at offset 8", () => {
    expect(TWO_INT_BODY_COMMANDS.has(1400)).toBe(true);
    const pkt = buildPortalPacket({
      commandId: 1400,
      channel: 2,
      segment: 9,
      payload: { value: 1, value1: 0, account_id: "7765c5ef" },
    });
    const body = pkt.subarray(PORTAL_HEADER_LENGTH);
    expect(body.length).toBe(136);
    expect(body.readUInt32LE(0)).toBe(1);
    expect(body.readUInt32LE(4)).toBe(0);
    expect(body.subarray(8, 16).toString("ascii")).toBe("7765c5ef");
    expect(body[16]).toBe(0);
  });

  it("parses a command-channel reply: int32 result code, then optional JSON", () => {
    const ok = Buffer.concat([buildPortalHeader(1350, 4, 255, 3, 1), Buffer.from([0, 0, 0, 0])]);
    expect(parsePortalPacket(ok)).toEqual({
      commandId: 1350,
      segment: 3,
      isResponse: 1,
      linkType: PortalLinkType.COMMAND,
      errCode: 0,
      data: undefined,
    });
    const json = Buffer.from(JSON.stringify({ cmd: 1224, ok: true }), "utf8");
    const refused = Buffer.concat([
      buildPortalHeader(1350, 4 + json.length, 255, 4, 1),
      Buffer.from([0x98, 0xff, 0xff, 0xff]), // -104
      json,
    ]);
    const parsed = parsePortalPacket(refused);
    expect(parsed?.errCode).toBe(-104);
    expect(parsed?.data).toEqual({ cmd: 1224, ok: true });
  });

  it("parses a notify frame as JSON with the nested cmd surfaced", () => {
    const json = Buffer.from(JSON.stringify({ cmd: 1351, payload: { params: [] } }) + "\0", "utf8");
    const pkt = Buffer.concat([buildPortalHeader(1351, json.length, 0, 0, 0), json]);
    const parsed = parsePortalPacket(pkt, PortalLinkType.NOTIFY);
    expect(parsed?.cmd).toBe(1351);
    expect(parsed?.data).toEqual({ cmd: 1351, payload: { params: [] } });
    expect(parsed?.errCode).toBeUndefined();
  });

  it("returns undefined for anything that isn't a portal packet", () => {
    expect(parsePortalPacket(Buffer.from("hello"))).toBeUndefined();
  });
});

describe("segment counter", () => {
  it("counts 1..255 and skips 0 on wrap", () => {
    const c = new SegmentCounter();
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) seen.add(c.next());
    expect(seen.has(0)).toBe(false);
    expect(seen.size).toBe(255);
    expect(c.next()).toBeGreaterThan(0);
  });
});
