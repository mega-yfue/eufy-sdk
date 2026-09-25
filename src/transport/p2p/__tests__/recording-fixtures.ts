import { createCipheriv, createECDH, randomBytes } from "node:crypto";
import type { RecordingFrame } from "../recording-download.js";
import { AAD, sealBody, wrapEnvelope } from "./ecies-fixtures.js";

/** A synthetic camera: its ECC private key as hex, and the public key the station wraps media keys for. */
export function camera(): { eccHex: string; publicKey: Buffer } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  const priv32 = priv.length === 32 ? priv : Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { eccHex: priv32.toString("hex"), publicKey: ecdh.getPublicKey() };
}

/** The 22-byte video frame header: length, key flag, frame number, timestamp. */
export function videoHeader(len: number, keyframe: boolean, frameNumber: number, stampMs: number): Buffer {
  const header = Buffer.alloc(0x16);
  header.writeUInt32LE(len, 0);
  header.writeUInt8(keyframe ? 1 : 2, 4);
  header.writeUInt16LE(frameNumber, 6);
  header.writeUIntLE(stampMs, 0x0e, 6);
  return header;
}

export function keyframe(mediaKey: Buffer, publicKey: Buffer, h264: Buffer, frameNumber: number, stampMs: number) {
  const { nonce, tag, ct } = sealBody(mediaKey, h264);
  return {
    commandId: 1300,
    signCode: 1,
    raw: Buffer.concat([
      videoHeader(h264.length, true, frameNumber, stampMs),
      wrapEnvelope(mediaKey, publicKey),
      tag,
      nonce,
      ct,
    ]),
  } satisfies RecordingFrame;
}

export function plainFrame(h264: Buffer, frameNumber: number, stampMs: number): RecordingFrame {
  const padding = Buffer.alloc((4 - ((0x16 + h264.length) % 4)) % 4);
  return {
    commandId: 1300,
    signCode: 0,
    raw: Buffer.concat([videoHeader(h264.length, false, frameNumber, stampMs), h264, padding]),
  };
}

export function audioFrame(mediaKey: Buffer, aac: Buffer, codec = 0): RecordingFrame {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mediaKey, nonce);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(aac), cipher.final()]);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(aac.length, 0);
  header.writeUInt8(codec, 5);
  return {
    commandId: 1301,
    signCode: 0,
    raw: Buffer.concat([header, cipher.getAuthTag(), nonce, ct, Buffer.alloc(2)]),
  };
}

export const IDR = Buffer.from("0000000167640028aced0000000168ee3c800000000165b800", "hex");
export const slice = (n: number) => Buffer.concat([Buffer.from("0000000121", "hex"), Buffer.alloc(40, n)]);
