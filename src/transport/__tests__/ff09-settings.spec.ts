import { createCipheriv } from "node:crypto";
import {
  buildFf09QueryFrame,
  buildFf09SettingsFrame,
  decryptFf09Frame,
  parseFf09SettingsResponse,
  readFf09U16LE,
  LOCK_COMMAND_CODE,
} from "../ff09.js";

/**
 * Byte-exact reproduction of a captured T85D0 auto-lock settings GET/SET exchange.
 *
 * Originally decrypted from a live GET query + two live SET (off→on) frames on a real T85D0
 * (2026-07-16) — the real admin_user_id/serial were re-derived to synthetic placeholders
 * (docs/REDACTION.md) and these vectors regenerated from the (unchanged) encoder against the
 * synthetic identity, using the SAME `unixTime`/`nonce`/`seqNum` shape recovered from the capture.
 * Reproducing them byte-for-byte still proves the TLV layout ([A1 time][A2 admin] for GET;
 * [A1 time][A2 admin][A3][A4 enable][A5 delay][A6][A7][A8][A9] for SET), the shared cipher/framing,
 * and the GET_SETTINGS(53)/SET_SETTINGS(52) opcodes are all correct.
 */
describe("ff09 settings GET/SET frame encoders", () => {
  const adminUserId = "0000000000000000000000000000000000000000";
  const deviceSn = "T85D0K0000000000";

  it("buildFf09QueryFrame reproduces the captured GET query byte-for-byte", () => {
    const out = buildFf09QueryFrame({ adminUserId, deviceSn, unixTime: 1700000000, nonce: 1, seqNum: 1700000000 });
    expect(out.lockPayload).toBe(
      "ff094a0003000240359cef86148e5c221493b22cec121e9cbcd5d58666e841d1c8011d5f0c6f73a837053e7b" +
        "610fbb3b291dc3a39d705880b86ef9ba0da09d052d3c9fe89e866ca65017",
    );
    expect(out.time).toBe(1700000001); // 1700000000 | 1
    expect(out.seqNum).toBe(1700000000);
    // cmdEnc = 0x4000 | 53 = 0x4035, right after the 7-byte header (ff09|size2|03 00 02).
    expect(out.lockPayload.slice(14, 18)).toBe("4035");
  });

  it("buildFf09SettingsFrame reproduces the captured SET-off frame byte-for-byte", () => {
    const out = buildFf09SettingsFrame({
      adminUserId,
      deviceSn,
      autoLockEnabled: false,
      autoLockDelaySeconds: 90,
      a7: 23,
      a8: 6,
      unixTime: 1700000000,
      nonce: 1,
      seqNum: 1700000001,
    });
    expect(out.lockPayload).toBe(
      "ff096a0003000240349cef86148e5c221493b22cec121e9cbcd5d58666e841d1c8011d5f0c6f73a837053e7b" +
        "610fbb3b291dc3a39d705880b8a6e985261c988a86107c21ae9cf981e43d5e52f515319fdfa91a33bc9047763" +
        "f8de97573159c0e112a8379bc91a6e70403",
    );
    expect(out.time).toBe(1700000001);
    // cmdEnc = 0x4000 | 52 = 0x4034.
    expect(out.lockPayload.slice(14, 18)).toBe("4034");
  });

  it("buildFf09SettingsFrame reproduces the captured SET-on frame byte-for-byte (differs only in A4)", () => {
    const out = buildFf09SettingsFrame({
      adminUserId,
      deviceSn,
      autoLockEnabled: true,
      autoLockDelaySeconds: 120,
      a7: 23,
      a8: 6,
      unixTime: 1700000010,
      nonce: 1,
      seqNum: 1700000002,
    });
    expect(out.lockPayload).toBe(
      "ff096a000300024034f0fc532c89c47d883968e30bba74d839d53ac7c027405fb1ad7ae2393e7877818b1eac" +
        "e1532416e7d301e3dc3e44557148684227973bf1510ce9561cbda08c3b311d3830d06a27eb38bd800116868a" +
        "45e87c1efffdc852c1f67d2fb55b767d0350",
    );
  });

  it("GET_SETTINGS and SET_SETTINGS opcodes are distinct from ON_OFF_LOCK/OPEN_DOOR", () => {
    expect(LOCK_COMMAND_CODE.GET_SETTINGS).toBe(53);
    expect(LOCK_COMMAND_CODE.SET_SETTINGS).toBe(52);
    expect(LOCK_COMMAND_CODE.GET_SETTINGS).not.toBe(LOCK_COMMAND_CODE.ON_OFF_LOCK);
    expect(LOCK_COMMAND_CODE.SET_SETTINGS).not.toBe(LOCK_COMMAND_CODE.OPEN_DOOR);
  });

  it("rejects missing/short identity loudly on both builders", () => {
    expect(() => buildFf09QueryFrame({ adminUserId: "", deviceSn })).toThrow(/adminUserId/);
    expect(() => buildFf09QueryFrame({ adminUserId, deviceSn: "" })).toThrow(/deviceSn/);
    expect(() =>
      buildFf09SettingsFrame({
        adminUserId: "short",
        deviceSn,
        autoLockEnabled: true,
        autoLockDelaySeconds: 0,
        a7: 0,
        a8: 0,
      }),
    ).toThrow(/too short/);
  });
});

/**
 * `decryptFf09Frame` / `parseFf09SettingsResponse` — the response side has no matching encoder in
 * this codebase (only the device builds a response), so this hand-assembles a frame with the SAME
 * cipher/framing documented in `transport/ff09.ts` (a mechanical mirror of `decryptFf09Frame`'s own
 * doc, not a copy of any captured bytes) and asserts the decoder recovers it. Field values are
 * arbitrary synthetic placeholders, not tied to any capture.
 */
function buildSyntheticResponseFrame(
  plain: Buffer,
  adminUserId: string,
  deviceSn: string,
  keyTime: number,
  cmdEnc: number,
): string {
  const key = Buffer.concat([Buffer.from(adminUserId.slice(-12), "ascii"), Buffer.alloc(4)]);
  key.writeUInt32BE(keyTime >>> 0, 12);
  const iv = Buffer.alloc(16);
  Buffer.from(deviceSn, "ascii").copy(iv);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x03, 0x00, 0x02]), Buffer.from([(cmdEnc >> 8) & 0xff, cmdEnc & 0xff]), ct]);
  const size = 2 + 2 + body.length + 1;
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  const preXor = Buffer.concat([Buffer.from([0xff, 0x09]), sizeBuf, body]);
  let xor = 0;
  for (const b of preXor) xor ^= b;
  return Buffer.concat([preXor, Buffer.from([xor])]).toString("hex");
}

describe("ff09 settings response decrypt/parse", () => {
  const adminUserId = "0000000000000000000000000000000000000000";
  const deviceSn = "T85D0K0000000000";
  const keyTime = 1700000001;

  // Leading 0x00 status byte, then a1..ad TLV fields — same shape as the real GET response, synthetic
  // values. a2 = delay(LE u16), a4 = the A7 readback, a5 = the A8 readback (per the module doc).
  const plain = Buffer.from(
    "00" + // status
      "a10101" + // a1: 1 byte = 01
      "a2025a00" + // a2: 2 bytes LE = 90 (delay)
      "a30100" + // a3: 1 byte = 00
      "a4021700" + // a4: 2 bytes LE = 23 (readback of A7)
      "a5020600" + // a5: 2 bytes LE = 6 (readback of A8)
      "a60101" + // a6: 1 byte = 01 (enable)
      "a70101" + // a7
      "a80101" + // a8
      "a9010500", // a9 (odd-length trimmed below)
    "hex",
  );

  it("decrypts + parses a synthetic response frame, recovering the delay + A7/A8 readback fields", () => {
    const hex = buildSyntheticResponseFrame(plain, adminUserId, deviceSn, keyTime, 0x4835);
    const decrypted = decryptFf09Frame({ lockPayload: hex, keyTime, adminUserId, deviceSn });
    expect(decrypted.subarray(0, plain.length)).toEqual(plain);

    const parsed = parseFf09SettingsResponse(decrypted);
    expect(parsed.status).toBe(0);
    expect(readFf09U16LE(parsed.fields.get(0xa2), "a2")).toBe(90);
    expect(readFf09U16LE(parsed.fields.get(0xa4), "a4")).toBe(23);
    expect(readFf09U16LE(parsed.fields.get(0xa5), "a5")).toBe(6);
    expect(parsed.fields.get(0xa6)?.[0]).toBe(1);
  });

  it("returns the body as sent when the opcode carries no 0x4000, as the app decrypts only an encrypted one", () => {
    const body = Buffer.concat([Buffer.from([0xff, 0x09, 0, 0, 0x03, 0x00, 0x02, 0x08, 0x35]), plain]);
    const frame = Buffer.concat([body, Buffer.alloc(1)]);
    frame.writeUInt16LE(frame.length, 2);
    frame[frame.length - 1] = [...frame.subarray(0, -1)].reduce((x, v) => x ^ v, 0);
    expect(decryptFf09Frame({ lockPayload: frame.toString("hex"), keyTime, adminUserId, deviceSn })).toEqual(plain);
  });

  it("rejects a response frame with a bad magic / checksum / size", () => {
    const hex = buildSyntheticResponseFrame(plain, adminUserId, deviceSn, keyTime, 0x4835);
    const badMagic = "0000" + hex.slice(4);
    expect(() => decryptFf09Frame({ lockPayload: badMagic, keyTime, adminUserId, deviceSn })).toThrow(/magic/);

    const buf = Buffer.from(hex, "hex");
    buf[buf.length - 1] = (buf[buf.length - 1]! ^ 0xff) & 0xff; // corrupt the trailing xor checksum
    expect(() => decryptFf09Frame({ lockPayload: buf.toString("hex"), keyTime, adminUserId, deviceSn })).toThrow(
      /checksum/,
    );
  });

  it("parseFf09SettingsResponse rejects an empty buffer (missing status byte)", () => {
    expect(() => parseFf09SettingsResponse(Buffer.alloc(0))).toThrow(/status byte/);
  });

  it("readFf09U16LE throws on a missing/short field instead of silently returning garbage", () => {
    expect(() => readFf09U16LE(undefined, "a2")).toThrow(/a2/);
    expect(() => readFf09U16LE(Buffer.from([0x01]), "a2")).toThrow(/a2/);
  });
});
