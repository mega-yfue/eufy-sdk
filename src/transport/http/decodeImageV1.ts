/**
 * V1 `eufysecurity:` push-thumbnail decoder.
 *
 * Wire format: `eufysecurity:<SERIAL(16)>:<CODE(10)>:<DATA>`. V1 encrypts the first 256 bytes of
 * `DATA` with AES-128-ECB and leaves the remaining JPEG bytes in plaintext. The key is derived from
 * the camera serial, station `p2p_did`, and per-image code.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { decodeImageV2, isV2Image } from "./decodeImageV2.js";

export const V1_PREFIX = "eufysecurity";

const md5 = (s: string) => createHash("md5").update(s, "utf-8").digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/** Derive the numeric id-suffix from the station `p2p_did` — a digit-mixing seed used by the key derivation. */
export function getIdSuffix(p2pDid: string): number {
  let result = 0;
  const match = p2pDid.match(/^[A-Z]+-(\d+)-[A-Z]+$/);
  if (match?.length === 2) {
    const num1 = Number.parseInt(match[1][0]);
    const num2 = Number.parseInt(match[1][1]);
    const num3 = Number.parseInt(match[1][3]);
    const num4 = Number.parseInt(match[1][5]);
    result = num1 + num2 + num3;
    if (num3 < 5) result = result + num3;
    result = result + num4;
  }
  return result;
}

/** Derive the image "base code" from the camera serial + `p2p_did` — first input to {@link getImageKey}. */
export function getImageBaseCode(serialNumber: string, p2pDid: string): string {
  let nr = Number.parseInt(`0x${serialNumber[serialNumber.length - 1]}`);
  nr = (nr + 10) % 10;
  const base = serialNumber.substring(nr);
  return `${base}${getIdSuffix(p2pDid)}`;
}

/** Derive the per-image seed from the `p2p_did` + the image's own code — second input to {@link getImageKey}. */
export function getImageSeed(p2pDid: string, code: string): string {
  const nCode = Number.parseInt(code.substring(2));
  const prefix = 1000 - getIdSuffix(p2pDid);
  return md5(`${prefix}${nCode}`).toUpperCase();
}

/** Derive the AES-128-ECB key for a v1 thumbnail: SHA-256 over the base code + seed, rotated by a hash byte. */
export function getImageKey(serialNumber: string, p2pDid: string, code: string): string {
  const baseCode = getImageBaseCode(serialNumber, p2pDid);
  const seed = getImageSeed(p2pDid, code);
  const hashBytes = [...Buffer.from(sha256(`01${baseCode}${seed}`), "hex")];
  const startByte = hashBytes[10];
  for (let i = 0; i < 32; i++) {
    const byte = hashBytes[i];
    let fixed_byte = startByte;
    if (i < 31) fixed_byte = hashBytes[i + 1];
    if (i === 31 || (i & 1) !== 0) {
      hashBytes[10] = fixed_byte;
      if (126 < byte || 126 < hashBytes[10]) {
        if (byte < hashBytes[10] || byte - hashBytes[10] === 0) hashBytes[i] = hashBytes[10] - byte;
        else hashBytes[i] = byte - hashBytes[10];
      }
    } else if (byte < 125 || fixed_byte < 125) {
      hashBytes[i] = fixed_byte + byte;
    }
  }
  return Buffer.from(hashBytes.slice(16)).toString("hex").toUpperCase();
}

/** True if the blob is a legacy v1 `eufysecurity:` image (NOT the v2 variant). */
export function isV1Image(data: Buffer): boolean {
  return (
    data.length >= 41 &&
    data.subarray(0, 12).toString("latin1") === V1_PREFIX &&
    data.subarray(0, 3).toString("latin1") !== "v2_"
  );
}

/**
 * Decode a v1 `eufysecurity:` blob to a plain JPEG buffer using the station's
 * `p2p_did`. Returns null if the blob isn't v1. Mirrors the legacy decode: parse
 * SERIAL + CODE, derive the key, AES-128-ECB-decrypt the first 256 bytes, splice
 * the decrypted head back in front of the plaintext tail.
 */
export function decodeImageV1(data: Buffer, p2pDid: string): Buffer | null {
  if (!isV1Image(data)) return null;
  const serialNumber = data.subarray(13, 29).toString("latin1");
  const code = data.subarray(30, 40).toString("latin1");
  const otherData = Buffer.from(data.subarray(41));
  const encryptedData = otherData.subarray(0, 256);
  const imageKey = getImageKey(serialNumber, p2pDid, code);
  const cipher = createDecipheriv("aes-128-ecb", Buffer.from(imageKey, "utf-8").subarray(0, 16), null);
  cipher.setAutoPadding(false);
  const decrypted = Buffer.concat([cipher.update(encryptedData), cipher.final()]);
  decrypted.copy(otherData, 0);
  return otherData;
}

/** Decode a recognized v1 (device-key) or v2 (keyless) wrapper; leave other media unchanged. */
export function normalizePushImage(data: Buffer, p2pDid?: string): Buffer {
  if (isV2Image(data)) return decodeImageV2(data) ?? data;
  if (!p2pDid || !isV1Image(data)) return data;
  return decodeImageV1(data, p2pDid) ?? data;
}
