import { buildFf09Frame, buildFf09TlvFrame, LOCK_API_COMMAND } from "../ff09.js";

/**
 * Byte-exact reproduction of a captured T8531 video-lock command.
 *
 * Originally a real ON_OFF_LOCK **unlock** frame decrypted from a live P2P capture (the `lock_payload`
 * + its cleartext `time`/`seq_num` from the 1940 envelope) — the real admin_user_id/serial were
 * re-derived to synthetic placeholders (docs/REDACTION.md) and this vector regenerated from the
 * (unchanged) encoder against the synthetic identity. Reproducing it byte-for-byte from the decoded
 * identity fields still proves the encoder's frame layout, TLV, zero-pad-to-16, AES-128-CBC key
 * (`admin_user_id[-12:] ‖ uint32_BE(time)`) + IV (`deviceSn`), and the XOR checksum are all correct.
 */
describe("ff09 frame encoder", () => {
  // Synthetic identity (see docs/REDACTION.md) — originally decoded from the captured frame.
  const adminUserId = "0000000000000000000000000000000000000000";
  const username = "someone+tag";
  const shortUserId = "0003";
  const deviceSn = "T8531K0000000000";
  // Captured envelope: time (key nonce) = unixTime | 1; seq_num is the monotonic counter.
  const unixTime = 1783612332;
  const nonce = 1; // keyTime = 1783612332 | 1 = 1783612333
  const seqNum = 1783612326;
  const capturedLockPayload =
    "ff096a0003000240230c1fa86e364a2a504c67567748f93d3bfff5318a8baadadddbf6909827400b12525531a0" +
    "5628097cf1c49e9928b5a0f2d9e11648e42aabc55432c799248c26d4ab2339a65c622e5119f4689982b80b95b0c" +
    "5554d07385bc3064b8a5f2cbb87b387";

  it("reproduces the captured unlock frame byte-for-byte", () => {
    const cmd = buildFf09Frame({
      engage: false, // unlock
      adminUserId,
      username,
      shortUserId,
      deviceSn,
      unixTime,
      nonce,
      seqNum,
    });
    expect(cmd.lockPayload).toBe(capturedLockPayload);
    expect(cmd.time).toBe(1783612333);
    expect(cmd.seqNum).toBe(seqNum);
    // The builder returns the envelope apiCommand for this frame — the transport carries it through
    // without knowing the pairing (see Ff09Frame.apiCommand).
    expect(cmd.apiCommand).toBe(LOCK_API_COMMAND.ON_OFF_LOCK);
  });

  it("encodes lock vs unlock with the A3 lock byte (0 vs 1) and re-derives the key per time", () => {
    const base = {
      adminUserId,
      username,
      shortUserId,
      deviceSn,
      unixTime,
      nonce,
    };
    const lock = buildFf09Frame({ ...base, engage: true });
    const unlock = buildFf09Frame({ ...base, engage: false });
    // Same key/IV/time, only the lockByte differs → the frames differ.
    expect(lock.lockPayload).not.toBe(unlock.lockPayload);
    // cmdEnc = 0x4000 | 35 = 0x4023, right after the 7-byte header (ff09|size2|03 00 02) = hex offset 14.
    expect(lock.lockPayload.slice(14, 18)).toBe("4023");
  });

  it("frames carry the ff09 magic, a self-consistent size, and a valid XOR checksum", () => {
    const { lockPayload } = buildFf09Frame({
      engage: true,
      adminUserId,
      username,
      shortUserId,
      deviceSn,
    });
    const buf = Buffer.from(lockPayload, "hex");
    expect(buf.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(buf.readUInt16LE(2)).toBe(buf.length); // size = total frame length
    let xor = 0;
    for (const b of buf.subarray(0, buf.length - 1)) xor ^= b;
    expect(buf[buf.length - 1]).toBe(xor); // trailing checksum
  });

  it("rejects missing identity loudly (fire-and-forget wire can't surface a bad frame)", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId: "",
        username,
        shortUserId,
        deviceSn,
      }),
    ).toThrow(/adminUserId/);
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username,
        shortUserId,
        deviceSn: "",
      }),
    ).toThrow(/deviceSn/);
  });

  it("rejects a deviceSn too long for the 16-byte IV instead of silently truncating it", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username,
        shortUserId,
        deviceSn: "T8531K00000000001", // 17 chars — one over the IV size
      }),
    ).toThrow(/deviceSn too long/);
  });

  it("rejects a TLV field over 255 bytes instead of silently wrapping the 1-byte length", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username: "x".repeat(256), // the A4 field — over a single length byte's range
        shortUserId,
        deviceSn,
      }),
    ).toThrow(/TLV field too long/);
  });

  it("rejects a shortUserId that isn't even-length hex instead of silently mangling it", () => {
    // Buffer.from(str, "hex") drops a trailing odd character and returns an EMPTY buffer on non-hex
    // input, rather than throwing — both would otherwise fail silent on this fire-and-forget wire.
    // (An empty shortUserId is caught earlier by the "required unless omitUserFields" guard instead.)
    for (const bad of ["003", "zz03"]) {
      expect(() =>
        buildFf09Frame({
          engage: true,
          adminUserId,
          username,
          shortUserId: bad,
          deviceSn,
        }),
      ).toThrow(/shortUserId must be an even-length hex string/);
    }
  });
});

/** The app derives the key from the admin id alone and uses it only to seal: an unsealed frame needs none. */
describe("ff09 TLV frame without an admin id", () => {
  const input = { cmdCode: 0x23, fields: [], userId: "1".repeat(40), adminUserId: "", deviceSn: "T8531Q0000000000" };
  const frame = { ...input, subVersion: 3, functionType: 2, unixTime: 1, nonce: 0 };
  it("goes out unsealed, A2 the user id", () => {
    const out = Buffer.from(buildFf09TlvFrame({ ...frame, encrypt: false }).lockPayload, "hex");
    expect(out.includes(Buffer.from([0xa2, 40, ...Buffer.from(input.userId)]))).toBe(true);
  });
  it("is refused sealed", () => {
    expect(() => buildFf09TlvFrame({ ...frame, encrypt: true })).toThrow(/adminUserId/);
  });
});
