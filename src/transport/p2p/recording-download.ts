/**
 * Download of a recording held on a HomeBase 2 (T8010), over the station's P2P session.
 *
 * The request is `CMD_DOWNLOAD_VIDEO` (1024) in the string-pair shape
 * ({@link buildStringPairCommandPayload}) on the camera's channel. The station answers on one data type
 * with the recording's `CMD_VIDEO_FRAME` (1300) and `CMD_AUDIO_FRAME` (1301) frames, faster than real time,
 * then `CMD_DOWNLOAD_FINISH` (1304).
 *
 * Frame layouts, confirmed on a T8010 with an eufyCam 2C (T8114):
 *
 * ```
 * video, keyframe (signCode > 0, length = 179 + len):
 *   [0x00:0x16] 22B header: u32@0 = len · u8@4 = 1 (2 on other frames) · u16@6 = frame number ·
 *               u48@0x0e = timestamp (ms)
 *   [0x16:0x97] 129B ECIES envelope wrapping the 32-byte media key under the cipher's ecc_private_key
 *   [0x97:0xa7] 16B GCM tag · [0xa7:0xb3] 12B GCM nonce · [0xb3:] len bytes of AES-256-GCM H.264
 * video, other frames (signCode 0): the same 22B header, then len bytes of plaintext H.264
 * audio: 16B header (u32@0 = len · u8@5 = codec, 0 = AAC-LC), then 16B GCM tag, 12B GCM nonce and len
 *   bytes of AES-256-GCM raw AAC under the media key of the preceding keyframe
 * ```
 *
 * Both GCM bodies authenticate with AAD `"eufy security"`, the same as live video
 * ({@link VideoFrameDecoder}). Measured on one 12.8 s recording: 192 video frames, 13 of them
 * envelope-carrying, and 199 audio frames spanning the same 12.7 s at 64 ms per frame.
 *
 * @module p2p/recording-download
 */
import { createDecipheriv } from "node:crypto";
import { RecordingDownloadError, type RecordingDownload } from "../../core/contracts.js";
import { buildAdtsHeader } from "./adts.js";
import { eciesUnwrap } from "./codec.js";
import { CommandType } from "./commands.js";
import type { P2PFrame, P2PSession } from "./p2p-session.js";

/** Additional authenticated data of every GCM body in a recording. */
const RECORDING_GCM_AAD = Buffer.from("eufy security");
/** Bytes of video frame header; a plaintext frame's H.264 and a keyframe's ECIES envelope start here. */
const VIDEO_HEADER_LEN = 0x16;
/** Start of a keyframe's 16-byte GCM tag, right after the 129-byte envelope. */
const KEYFRAME_TAG_START = 0x97;
/** Start of a keyframe's 12-byte GCM nonce. */
const KEYFRAME_NONCE_START = 0xa7;
/** Start of a keyframe's H.264 ciphertext. */
const KEYFRAME_BODY_START = 0xb3;
/** Bytes of audio frame header; the 16-byte GCM tag starts here. */
const AUDIO_HEADER_LEN = 16;
/** Start of an audio frame's 12-byte GCM nonce. */
const AUDIO_NONCE_START = 32;
/** Start of an audio frame's AAC ciphertext. */
const AUDIO_BODY_START = 44;
/** Audio codec id for AAC-LC in the audio frame header. */
const AUDIO_CODEC_AAC_LC = 0;
/** How long the station may take to send the first frame of a recording. */
const FIRST_FRAME_WAIT_MS = 20_000;
/** Silence after the last frame that ends a transfer whose finish frame never arrived. */
const IDLE_END_MS = 15_000;
/** Longest a transfer may run, whatever arrives. */
const DEFAULT_TRANSFER_MS = 120_000;

/** One recording frame as received, in arrival order. */
export interface RecordingFrame {
  commandId: number;
  signCode: number;
  raw: Buffer;
}

/** A recording's frames and whether the station said it was done. */
export interface RecordingTransfer {
  frames: RecordingFrame[];
  finished: boolean;
}

/**
 * The path a HomeBase 2 stores a camera's recording under: the camera's channel, two digits, and the
 * recording name the event push carries. Answers `undefined` for a name that is not the station's
 * fourteen-digit `yyyyMMddHHmmss` form.
 */
export function homeBase2RecordingPath(channel: number, recording: string): string | undefined {
  if (!/^\d{14}$/.test(recording) || !Number.isInteger(channel) || channel < 0 || channel > 99) return undefined;
  return `/media/mmcblk0p1/Camera${String(channel).padStart(2, "0")}/${recording}.dat`;
}

/**
 * Request one recording and collect its frames until `CMD_DOWNLOAD_FINISH`, a {@link IDLE_END_MS} silence
 * after the last frame, or `timeoutMs`. Only frames on the data type of the first recording frame are kept.
 * Rejects with {@link RecordingDownloadError} `no-data` when nothing arrives within {@link FIRST_FRAME_WAIT_MS},
 * and `refused` when the station answers the request with a negative command result before any frame.
 */
export function receiveRecording(
  session: P2PSession,
  request: { path: string; accountId: string; channel: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<RecordingTransfer> {
  return new Promise((resolve, reject) => {
    const frames: RecordingFrame[] = [];
    const started = Date.now();
    let lastFrameAt = started;
    let dataType: number | undefined;
    let settled = false;
    const finish = (error?: Error, finished = false) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      session.off("data", onData);
      session.off("commandResult", onResult);
      request.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ frames, finished });
    };
    const onData = (frame: P2PFrame) => {
      if (frame.commandId === CommandType.CMD_DOWNLOAD_FINISH) return finish(undefined, true);
      if (frame.commandId !== CommandType.CMD_VIDEO_FRAME && frame.commandId !== CommandType.CMD_AUDIO_FRAME) return;
      dataType ??= frame.dataType;
      if (frame.dataType !== dataType) return;
      lastFrameAt = Date.now();
      frames.push({ commandId: frame.commandId, signCode: frame.signCode, raw: Buffer.from(frame.raw) });
    };
    const onResult = (result: { code: number; channel?: number }) => {
      if (frames.length || result.code >= 0 || (result.channel !== undefined && result.channel !== request.channel)) {
        return;
      }
      finish(new RecordingDownloadError("refused", `the station refused the recording (code ${result.code})`));
    };
    const onAbort = () =>
      finish(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
    const tick = setInterval(() => {
      const now = Date.now();
      if (!frames.length && now - started > FIRST_FRAME_WAIT_MS) {
        finish(new RecordingDownloadError("no-data", `the station sent nothing within ${FIRST_FRAME_WAIT_MS} ms`));
      } else if (frames.length && now - lastFrameAt > IDLE_END_MS) {
        finish();
      } else if (now - started > (request.timeoutMs ?? DEFAULT_TRANSFER_MS)) {
        finish();
      }
    }, 250);
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    session.on("data", onData);
    session.on("commandResult", onResult);
    try {
      session.sendStringPairCommand(CommandType.CMD_DOWNLOAD_VIDEO, request.path, request.accountId, request.channel);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Open one AES-256-GCM body; `undefined` when it does not authenticate. */
function openGcm(key: Buffer, nonce: Buffer, tag: Buffer, body: Buffer): Buffer | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(RECORDING_GCM_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return undefined;
  }
}

/**
 * Decode a recording's frames, in arrival order, into elementary streams. A keyframe whose envelope does not
 * open under `eccPrivateKeyHex`, and every audio frame before the first media key, are dropped. Rejects with
 * {@link RecordingDownloadError} `undecodable` when no video frame decodes.
 */
export function decodeRecording(frames: readonly RecordingFrame[], eccPrivateKeyHex: string): RecordingDownload {
  let mediaKey: Buffer | undefined;
  const video: Buffer[] = [];
  const audio: Buffer[] = [];
  const numbers = new Set<number>();
  let firstStamp: number | undefined;
  let lastStamp: number | undefined;
  for (const { commandId, signCode, raw } of frames) {
    if (commandId === CommandType.CMD_VIDEO_FRAME) {
      if (raw.length < VIDEO_HEADER_LEN) continue;
      const len = raw.readUInt32LE(0);
      let h264: Buffer | undefined;
      if (signCode > 0 && raw.length >= KEYFRAME_BODY_START + len) {
        const envelope = raw.subarray(VIDEO_HEADER_LEN, KEYFRAME_TAG_START);
        const key = eciesUnwrap(envelope, eccPrivateKeyHex, { verifyHmac: true, pkcs7: true });
        if (key?.length === 32) {
          mediaKey = key;
          h264 = openGcm(
            key,
            raw.subarray(KEYFRAME_NONCE_START, KEYFRAME_BODY_START),
            raw.subarray(KEYFRAME_TAG_START, KEYFRAME_NONCE_START),
            raw.subarray(KEYFRAME_BODY_START, KEYFRAME_BODY_START + len),
          );
        }
      } else if (signCode === 0 && raw.length >= VIDEO_HEADER_LEN + len) {
        h264 = raw.subarray(VIDEO_HEADER_LEN, VIDEO_HEADER_LEN + len);
      }
      if (!h264?.length) continue;
      video.push(h264);
      numbers.add(raw.readUInt16LE(6));
      const stamp = raw.readUIntLE(0x0e, 6);
      firstStamp ??= stamp;
      lastStamp = stamp;
    } else if (commandId === CommandType.CMD_AUDIO_FRAME && mediaKey) {
      if (raw.length < AUDIO_BODY_START || raw[5] !== AUDIO_CODEC_AAC_LC) continue;
      const len = raw.readUInt32LE(0);
      if (raw.length < AUDIO_BODY_START + len) continue;
      const aac = openGcm(
        mediaKey,
        raw.subarray(AUDIO_NONCE_START, AUDIO_BODY_START),
        raw.subarray(AUDIO_HEADER_LEN, AUDIO_NONCE_START),
        raw.subarray(AUDIO_BODY_START, AUDIO_BODY_START + len),
      );
      if (aac?.length) audio.push(buildAdtsHeader(aac.length), aac);
    }
  }
  if (!video.length) throw new RecordingDownloadError("undecodable", "no video frame of the recording decoded");
  const ordered = [...numbers];
  let missingFrames = 0;
  for (let i = 1; i < ordered.length; i++) {
    const step = (ordered[i]! - ordered[i - 1]!) & 0xffff;
    if (step > 1 && step < 0x8000) missingFrames += step - 1;
  }
  const span = ordered.length > 1 ? (ordered[ordered.length - 1]! - ordered[0]!) & 0xffff : 0;
  const durationMs = (lastStamp ?? 0) - (firstStamp ?? 0);
  return {
    video: Buffer.concat(video),
    ...(audio.length ? { audio: Buffer.concat(audio) } : {}),
    frames: ordered.length,
    missingFrames,
    durationMs,
    fps: durationMs > 0 && span > 0 ? Math.round((span * 100_000) / durationMs) / 100 : 0,
  };
}
