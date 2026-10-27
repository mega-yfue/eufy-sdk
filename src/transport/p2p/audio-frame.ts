import { createDecipheriv } from "node:crypto";
import type { AudioCodec } from "../../core/contracts.js";
import { VIDEO_GCM_AAD } from "./video.js";

export const CMD_AUDIO_FRAME = 1301;
/** Length of the audio frame header before the payload. */
export const AUDIO_HEADER_LEN = 0x10;
/** Byte offset of the codec id between the frame-size and frame-number fields. */
export const AUDIO_TYPE_OFFSET = 0x05;

/**
 * Codec ids the station puts at {@link AUDIO_TYPE_OFFSET}, as the v6 app maps them
 * (`AudioReader.AAC_LC = 0`, `G711A = 2`, `AAC_ELD = 7`).
 *
 * The app's `PCM_SILENCE = -1` is absent on purpose: it is not a wire value. The app injects it
 * itself when a stream produces no audio at all, to feed its decoder silence.
 */
export const AUDIO_CODECS: Readonly<Record<number, AudioCodec>> = { 0: "aac-lc", 2: "g711a", 7: "aac-eld" };

/** Start of a sealed audio frame's 12-byte GCM nonce; its 16-byte GCM tag runs from the header to here. */
const AUDIO_NONCE_START = 32;
/** Start of a sealed audio frame's ciphertext. */
const AUDIO_BODY_START = 44;

/**
 * Whether an audio frame is sealed: after its header, a 16-byte GCM tag and a 12-byte nonce precede the
 * `u32@0` bytes its header declares, where a frame in the clear carries those bytes straight after the header.
 * A stream whose keyframes wrap their media key in an ECIES envelope seals its audio this way, measured on
 * HomeBase recordings and on HomeBase 3 live streams answering a P-256 start.
 */
export function isSealedAudio(frame: Buffer): boolean {
  return frame.length >= AUDIO_BODY_START && frame.length >= AUDIO_BODY_START + frame.readUInt32LE(0);
}

/**
 * The payload of a sealed audio frame ({@link isSealedAudio}), opened with AES-256-GCM under `mediaKey`, the
 * media key of the keyframe before it, with the video frames' AAD. Answers `undefined` for a frame that is not
 * sealed or does not authenticate under that key.
 */
export function openSealedAudio(frame: Buffer, mediaKey: Buffer): Buffer | undefined {
  if (!isSealedAudio(frame)) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", mediaKey, frame.subarray(AUDIO_NONCE_START, AUDIO_BODY_START));
    decipher.setAAD(VIDEO_GCM_AAD);
    decipher.setAuthTag(frame.subarray(AUDIO_HEADER_LEN, AUDIO_NONCE_START));
    const body = frame.subarray(AUDIO_BODY_START, AUDIO_BODY_START + frame.readUInt32LE(0));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return undefined;
  }
}
