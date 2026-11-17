import { createCipheriv } from "node:crypto";
import {
  buildLookupWithKeyPayload,
  buildLookupWithKeyPayload2,
  decodeP2PCloudIPs,
  stationCloudAddresses,
  decryptP2PData,
  p2pCommandEncryptionKey,
  p2pDidToBuffer,
  parseLookupAddr,
  MAGIC_WORD,
} from "../codec.js";

/** Inverse of decodeP2PCloudIPs — encode a plaintext string to an app_conn,
 *  so we can round-trip the decoder with synthetic data (no real account info). */
function encodeP2PCloudIPs(plain: string): string {
  const lookupTable = Buffer.from(
    "4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df",
    "hex",
  );
  const out = Buffer.from(plain, "utf8");
  let s = "";
  for (let i = 0; i < out.length; i++) {
    let z = 0x39;
    for (let j = 0; j < i; j++) z = z ^ out[j];
    const b = (out[i] ^ z ^ lookupTable[i % lookupTable.length]) & 0xff;
    s += String.fromCharCode(65 + (b >> 4)) + String.fromCharCode(65 + (b & 0x0f));
  }
  return s;
}

describe("P2P codec primitives", () => {
  it("round-trips cloud-IP encode → decode (synthetic)", () => {
    const conn = encodeP2PCloudIPs("18.197.1.2,3.69.4.5");
    expect(decodeP2PCloudIPs(conn)).toEqual([
      { host: "18.197.1.2", port: 32100 },
      { host: "3.69.4.5", port: 32100 },
    ]);
  });

  it("reads a station's lookup servers from app_conn as the app does, p2p_conn only where app_conn is absent", () => {
    const app = encodeP2PCloudIPs("192.0.2.1,192.0.2.2,192.0.2.3");
    const p2p = encodeP2PCloudIPs("192.0.2.9");
    const hosts = (raw: Parameters<typeof stationCloudAddresses>[0]) => stationCloudAddresses(raw)?.map((a) => a.host);
    expect(hosts({ app_conn: app, p2p_conn: p2p })).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
    expect(hosts({ app_conn: app, p2p_conn: "" })).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
    expect(hosts({ app_conn: "", p2p_conn: p2p })).toEqual(["192.0.2.9"]);
    expect(stationCloudAddresses({ app_conn: "", p2p_conn: "" })).toBeUndefined();
    expect(stationCloudAddresses(undefined)).toBeUndefined();
  });

  it("derives the 16-byte Level-1 command key from sn + p2p_did", () => {
    const key = p2pCommandEncryptionKey("T8030T0000000000", "EUPRCAM-000000-XXXXX");
    expect(key).toHaveLength(16);
    // last7(sn)="0000000" + did.substring(indexOf('-')=7, 16)="-000000-X"
    expect(key).toBe("0000000-000000-X");
  });

  it("AES-128-ECB decryptP2PData reverses an encrypt", () => {
    const key = Buffer.from("0123456789abcdef".slice(0, 16));
    const plain = Buffer.alloc(32, 7);
    const c = createCipheriv("aes-128-ecb", key, null);
    c.setAutoPadding(false);
    const enc = Buffer.concat([c.update(plain), c.final()]);
    expect(decryptP2PData(enc, key)).toEqual(plain);
  });

  it("p2pDidToBuffer encodes prefix/number/suffix (20 bytes, BE number)", () => {
    const b = p2pDidToBuffer("EUPRCAM-000000-XXXXX");
    expect(b).toHaveLength(20);
    expect(b.subarray(0, 7).toString()).toBe("EUPRCAM");
    expect(b.readUInt32BE(8)).toBe(0);
    expect(b.subarray(12, 17).toString()).toBe("XXXXX");
  });

  it("MAGIC_WORD is XZYH", () => {
    expect(MAGIC_WORD).toBe("XZYH");
  });
});

describe("buildLookupWithKeyPayload (LOOKUP_WITH_KEY, 0xf126 — the remote/WAN connect fix)", () => {
  const DID = "EUPRCAM-000000-XXXXX";
  const SELF_HOST = "192.0.2.1"; // RFC 5737 documentation-range address, not a real device
  const SELF_PORT = 12345;
  const DSK_KEY = "XXXXXXXXXXXXXXXXXXXX"; // synthetic, 20 chars (real keys observed at this length)

  it("lays out [p2pDid:20][selfAddr:16][clientVersion:4][dskKey][0000]", () => {
    const payload = buildLookupWithKeyPayload(DID, SELF_HOST, SELF_PORT, DSK_KEY);
    expect(payload).toHaveLength(20 + 16 + 4 + DSK_KEY.length + 4);

    // p2pDid segment is byte-identical to the existing p2pDidToBuffer encoder.
    expect(payload.subarray(0, 20)).toEqual(p2pDidToBuffer(DID));

    // selfAddr: flags(BE)=0x0002, port(LE), ip reversed, 8 zero-byte pad.
    const selfAddr = payload.subarray(20, 36);
    expect(selfAddr.readUInt16BE(0)).toBe(0x0002);
    expect(selfAddr.readUInt16LE(2)).toBe(SELF_PORT);
    expect(selfAddr.subarray(8, 16)).toEqual(Buffer.alloc(8));

    // clientVersion — constant observed in every capture.
    expect(payload.subarray(36, 40)).toEqual(Buffer.from([0x02, 0x05, 0x01, 0x05]));

    // dskKey ASCII, then a 4-byte zero trailer.
    expect(payload.subarray(40, 40 + DSK_KEY.length).toString("ascii")).toBe(DSK_KEY);
    expect(payload.subarray(payload.length - 4)).toEqual(Buffer.alloc(4));
  });

  it("selfAddr round-trips through parseLookupAddr (same wire shape as a LOOKUP_ADDR response)", () => {
    const payload = buildLookupWithKeyPayload(DID, SELF_HOST, SELF_PORT, DSK_KEY);
    // parseLookupAddr reads port/ip starting at the response's own offset 6/8 (after a 2-byte type +
    // 2-byte length header); the encoded selfAddr block starts with an equivalent 2-byte field before
    // port/ip, so prefixing 4 arbitrary bytes reproduces that layout for the round-trip check.
    const fakeResponse = Buffer.concat([Buffer.alloc(4), payload.subarray(20, 36)]);
    expect(parseLookupAddr(fakeResponse)).toEqual({ host: SELF_HOST, port: SELF_PORT });
  });

  it("differs from buildLookupWithKeyPayload2 only by the inserted selfAddr+version block", () => {
    const p1 = buildLookupWithKeyPayload(DID, SELF_HOST, SELF_PORT, DSK_KEY);
    const p2 = buildLookupWithKeyPayload2(DID, DSK_KEY);
    expect(p1.subarray(0, 20)).toEqual(p2.subarray(0, 20)); // same p2pDid prefix
    expect(p1.subarray(40)).toEqual(p2.subarray(20)); // same dskKey + zero trailer suffix
    expect(p1).toHaveLength(p2.length + 20); // exactly the 20-byte selfAddr+clientVersion block longer
  });
});
