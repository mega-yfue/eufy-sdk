import { createCipheriv } from "node:crypto";
import { u32be } from "../../core/util.js";

/**
 * Build a minimally-valid `ff09` response frame wrapping `plain` (mirrors `decryptFf09Frame`'s own
 * doc in `transport/ff09.ts`) — pure framing/cipher, no transport-specific variance, so it's shared
 * by every spec (P2P and MQTT alike) that needs to synthesize a fake device GET-settings reply,
 * rather than each maintaining its own copy that can quietly drift out of sync with the real encoder.
 */
export function buildFf09ResponseFrame(
  plain: Buffer,
  keyTime: number,
  adminUserId: string,
  deviceSn: string,
  opcode = 0x35,
): string {
  const key = Buffer.concat([Buffer.from(adminUserId.slice(-12), "ascii"), u32be(keyTime)]);
  const iv = Buffer.alloc(16);
  Buffer.from(deviceSn, "ascii").copy(iv);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x03, 0x00, 0x02]), Buffer.from([0x48, opcode]), ct]);
  const size = 2 + 2 + body.length + 1;
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  const preXor = Buffer.concat([Buffer.from([0xff, 0x09]), sizeBuf, body]);
  let xor = 0;
  for (const b of preXor) xor ^= b;
  return Buffer.concat([preXor, Buffer.from([xor])]).toString("hex");
}
