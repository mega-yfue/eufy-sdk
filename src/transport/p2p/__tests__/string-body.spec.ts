import { buildStringBody } from "../write-commands.js";

describe("buildStringBody (SET_TIME_ZONE 1215, SET_HUB_NAME 1216, SET_DEVICE_NAME 1217)", () => {
  it("packs [u32=0][u8 channel][name pad128][account pad128] — verified layout", () => {
    const acct = "0000000000000000000000000000000000000000";
    const body = buildStringBody(3, "Camera A", acct);
    expect(body.length).toBe(261);
    expect(body.readUInt32LE(0)).toBe(0);
    expect(body.readUInt8(4)).toBe(3); // device channel
    expect(body.subarray(5, 5 + "Camera A".length).toString("ascii")).toBe("Camera A");
    expect(body.readUInt8(5 + "Camera A".length)).toBe(0); // null-terminated
    expect(body.subarray(133, 133 + acct.length).toString("ascii")).toBe(acct);
  });

  it("truncates an over-long name and requires an account_id", () => {
    const nameField = buildStringBody(0, "x".repeat(200), "a").subarray(5, 133).toString("ascii");
    expect(nameField.replace(/\0+$/, "").length).toBe(127);
    expect(() => buildStringBody(0, "n", "")).toThrow(/account_id/);
  });

  it("encodes a non-ASCII name as UTF-8 (matching the app), not lossy ascii", () => {
    const body = buildStringBody(0, "Café", "a");
    const utf8 = Buffer.from("Café", "utf8"); // 'é' = 2 bytes
    expect(body.subarray(5, 5 + utf8.length).equals(utf8)).toBe(true);
    expect(body.readUInt8(5 + utf8.length)).toBe(0); // null-terminated after the multi-byte char
  });

  it("truncates a multi-byte name on a code-point boundary (never a partial sequence)", () => {
    const body = buildStringBody(0, "é".repeat(100), "a"); // 200 UTF-8 bytes
    const field = body.subarray(5, 133);
    const used = field.subarray(0, field.indexOf(0) === -1 ? 128 : field.indexOf(0));
    expect(used.length).toBeLessThanOrEqual(127);
    expect(used.length % 2).toBe(0); // whole 2-byte 'é' chars only — no split codepoint
    expect(used.toString("utf8")).toBe("é".repeat(used.length / 2));
  });
});
