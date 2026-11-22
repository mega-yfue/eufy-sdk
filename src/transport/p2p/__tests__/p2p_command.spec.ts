import { randomBytes } from "node:crypto";
import { encryptP2PData, paddingP2PData, decryptP2PData } from "../codec.js";

describe("P2P AES-128-ECB", () => {
  const key = randomBytes(16);
  const value = JSON.stringify({ cmd: 1308, payload: [{ file: "/userdata/push/x.jpg" }] });

  it("encryptP2PData/paddingP2PData round-trip", () => {
    const padded = paddingP2PData(Buffer.from(value));
    expect(padded.length % 16).toBe(0);
    expect(decryptP2PData(encryptP2PData(padded, key), key).equals(padded)).toBe(true);
  });

  /**
   * The app's `aes_decrypt` runs over every block up to `ceil(len / 16)` of a zero-filled buffer: the whole blocks of
   * a 133-byte body open, and the result keeps the body's length.
   */
  it("opens a body that is not a whole number of blocks over zero fill, keeping its length", () => {
    const plain = randomBytes(128);
    const body = Buffer.concat([encryptP2PData(plain, key), Buffer.from([1, 2, 3, 4, 5])]);
    const opened = decryptP2PData(body, key);
    expect(opened.length).toBe(133);
    expect(opened.subarray(0, 128)).toEqual(plain);
    const tail = Buffer.concat([body.subarray(128), Buffer.alloc(11)]);
    expect(opened.subarray(128)).toEqual(decryptP2PData(tail, key).subarray(0, 5));
  });
});
