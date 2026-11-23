import { buildDirectBinaryBody } from "../write-commands.js";

/**
 * The packed "direct" control-command body. Two shapes from one builder, differing only by the
 * optional leading channel word:
 *   device form  (with channel): [u32 channel][u32 value][account_id @8]  = 136 bytes
 *   station form (no channel):   [u32 value][account_id @4]               = 132 bytes
 */
describe("buildDirectBinaryBody", () => {
  it("device form: lays out [u32 channel][u32 value][account_id @8] in 136 bytes", () => {
    const b = buildDirectBinaryBody(77, "abc123", 4);
    expect(b.length).toBe(136);
    expect(b.readUInt32LE(0)).toBe(4);
    expect(b.readUInt32LE(4)).toBe(77);
    expect(b.subarray(8, 8 + 6).toString("ascii")).toBe("abc123");
    // rest of the account field is zero-padded
    expect(b.subarray(14).every((x) => x === 0)).toBe(true);
  });

  it("station form: omitting channel lays out [u32 value][account_id @4] in 132 bytes", () => {
    const b = buildDirectBinaryBody(80, "abc123");
    expect(b.length).toBe(132);
    expect(b.readUInt32LE(0)).toBe(80);
    expect(b.subarray(4, 4 + 6).toString("ascii")).toBe("abc123");
    expect(b.subarray(10).every((x) => x === 0)).toBe(true);
  });

  it("slices an over-long account_id to 128 bytes (no overflow past the buffer)", () => {
    const long = "x".repeat(200);
    const b = buildDirectBinaryBody(1, long, 0);
    expect(b.length).toBe(136);
    // exactly 128 bytes written at offset 8 (8 + 128 = 136)
    expect(b.subarray(8).toString("ascii")).toBe("x".repeat(128));
  });

  it("sends an empty account_id as the all-zero field, as the app does", () => {
    expect(buildDirectBinaryBody(1, "", 4).subarray(8).equals(Buffer.alloc(128))).toBe(true);
  });
});
