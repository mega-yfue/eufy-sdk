/**
 * Download of a recording held on a HomeBase, over the station's P2P session. {@link RECORDING_STATIONS}
 * holds every way the station models differ; the rest is shared.
 *
 * The request is `CMD_DOWNLOAD_VIDEO` (1024) in the string-pair shape
 * ({@link buildStringPairCommandPayload}) on the camera's channel. The station answers on
 * {@link RECORDING_DATA_TYPE}, tagged with that channel, with the recording's `CMD_VIDEO_FRAME` (1300) and
 * `CMD_AUDIO_FRAME` (1301) frames, faster than real time, then `CMD_DOWNLOAD_FINISH` (1304) on the control
 * data type, tagged with the station's {@link RecordingStation.finishChannel} whatever the camera's channel.
 *
 * Frame layouts on a station that seals its recordings (HomeBase 2):
 *
 * ```
 * video, keyframe: the live E2E layout ({@link VideoFrameDecoder}), length = 179 + len exactly
 * video, other frames: the same 22B header (u32@0 = len · u16@6 = frame number · u48@0x0e = stamp in ms),
 *   then len bytes of plaintext H.264
 * audio: 16B header (u32@0 = len · u8@5 = codec, 0 = AAC-LC), then 16B GCM tag, 12B GCM nonce and len
 *   bytes of AES-256-GCM AAC under the media key of the preceding keyframe, AAD as live video; the
 *   plaintext is a whole ADTS frame, header included
 * ```
 *
 * Frame layouts on a station that stores them in the clear (HomeBase 3):
 *
 * ```
 * video, every frame: the same 22B header, then len bytes of Annex-B H.264 or H.265, length = 22 + len
 * audio: the same 16B header, then len bytes of ADTS AAC
 * ```
 *
 * @module p2p/recording-download
 */
import { RecordingDownloadError, type RecordingDownload, type VideoCodec } from "../../core/contracts.js";
import { sniffAnnexbCodec } from "./annexb.js";
import { CommandType } from "./commands.js";
import { STATION_CHANNEL, type P2PFrame, type P2PSession } from "./p2p-session.js";
import {
  AccessUnitAssembler,
  STATION_CHUNK_BYTES,
  VideoFrameDecoder,
  parseVideoFrameHeader,
  type VideoFrameHeader,
} from "./video.js";
import { AUDIO_HEADER_LEN, openSealedAudio } from "./audio-frame.js";

/** Data type a station sends a recording's frames on: the binary channel (`0xd1 0x03`), not live video's. */
export const RECORDING_DATA_TYPE = 3;
/** Bytes of video frame header; a plaintext frame's payload starts here. */
const VIDEO_HEADER_LEN = 0x16;
/** Audio codec id for AAC-LC in the audio frame header. */
const AUDIO_CODEC_AAC_LC = 0;
/** How long the station may take to send the first frame of a recording. */
const FIRST_FRAME_WAIT_MS = 20_000;
/**
 * Silence after the last frame that ends a transfer whose finish frame never arrived. Not covered: a station
 * that pauses longer than this mid-transfer and then resumes. The listener has stopped by then, so the rest of
 * that recording, its finish frame included, would reach the next download of the same camera.
 * `CMD_DOWNLOAD_CANCEL` would close that gap once its wire is captured.
 */
const IDLE_END_MS = 15_000;
/** Longest a transfer may run, whatever arrives. */
const DEFAULT_TRANSFER_MS = 120_000;
/**
 * Most frame bytes a transfer holds. The station sends faster than real time, so the time bounds alone do
 * not bound memory; an event recording is far below this.
 */
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

/** One recording frame as received, in arrival order. */
export interface RecordingFrame {
  commandId: number;
  signCode: number;
  raw: Buffer;
}

/**
 * How one station model stores its attached cameras' recordings and serves them over `CMD_DOWNLOAD_VIDEO`
 * (1024): where a recording lives, whether it is sealed, which channel the finish frame is tagged with, and
 * where a split picture continues. A model without an entry in {@link RECORDING_STATIONS} offers no download.
 */
export interface RecordingStation {
  /**
   * The path the station stores the recording named `recording` of the camera on station channel `channel`
   * under. Answers `undefined` for a name the station could not hold. The SDK builds every path from these two
   * values, so a request never reaches outside the camera's own folder.
   */
  readonly path: (channel: number, recording: string) => string | undefined;
  /**
   * Whether the station stores a recording sealed under its event's cipher, which opens with that cipher's ECC
   * private key, or in the clear, which reads no key. The frame layouts of each are in this module's
   * documentation.
   */
  readonly sealed: boolean;
  /** The channel the station tags `CMD_DOWNLOAD_FINISH` (1304) with. The camera's own channel is taken too. */
  readonly finishChannel: number;
  /**
   * The payload size the station fills a `CMD_VIDEO_FRAME` to when an access unit continues in the next frame
   * ({@link AccessUnitAssembler}).
   */
  readonly chunkBytes: number;
  /**
   * The result code that opens the station's `CMD_DOWNLOAD_VIDEO` reply on the camera's channel when it holds no
   * recording at the path, after which it sends nothing. Absent on a station whose reply is unconfirmed.
   */
  readonly missingCode?: number;
}

/**
 * The folder a HomeBase names after a camera's station channel: `Camera` and the channel as two digits.
 * Answers `undefined` for a channel outside `0`–`99` or one that is not an integer.
 */
function cameraFolder(channel: number): string | undefined {
  if (!Number.isInteger(channel) || channel < 0 || channel > 99) return undefined;
  return `Camera${String(channel).padStart(2, "0")}`;
}

/**
 * The path a HomeBase 2 stores a camera's recording under: its {@link cameraFolder}, then the recording's name
 * as `yyyyMMddHHmmss` or `h265_yyyyMMddHHmmss`. Answers `undefined` for any other name, and for a channel
 * {@link cameraFolder} refuses. Both forms are digits behind one fixed prefix, so the anchored test lets no
 * `..`, slash or other character that could reach another path on the station through.
 */
export function homeBase2RecordingPath(channel: number, recording: string): string | undefined {
  const folder = cameraFolder(channel);
  if (!folder || !/^(?:h265_)?\d{14}$/.test(recording)) return undefined;
  return `/media/mmcblk0p1/${folder}/${recording}.dat`;
}

/**
 * The path a HomeBase 3 stores a camera's recording under:
 * `/zx/emmcdata/<cameraFolder>/<yyyyMM>/<name>/<name>.zxvideo`, where the name is the recording's start as
 * `yyyyMMddHHmmss`, whatever the codec, and `<yyyyMM>` is its first six digits. Answers `undefined` for any
 * other name (a codec prefix, an extension or a path included), and for a channel {@link cameraFolder}
 * refuses. The anchored test lets no character but digits through.
 */
export function homeBase3RecordingPath(channel: number, recording: string): string | undefined {
  const folder = cameraFolder(channel);
  if (!folder || !/^\d{14}$/.test(recording)) return undefined;
  return `/zx/emmcdata/${folder}/${recording.slice(0, 6)}/${recording}/${recording}.zxvideo`;
}

/**
 * The stations whose recording download is confirmed, by station model.
 *
 * `T8010`, HomeBase 2: `/media/mmcblk0p1/CameraNN/<name>.dat`, sealed under the event's cipher, finish tagged
 * with channel 0, split pictures filled to {@link STATION_CHUNK_BYTES}.
 *
 * `T8030`, HomeBase 3: `/zx/emmcdata/CameraNN/<yyyyMM>/<name>/<name>.zxvideo`, in the clear, finish tagged
 * with {@link STATION_CHANNEL}, a keyframe over 400000 bytes split at exactly 400000, a missing recording
 * answered with -111.
 */
export const RECORDING_STATIONS: ReadonlyMap<string, RecordingStation> = new Map<string, RecordingStation>([
  ["T8010", { path: homeBase2RecordingPath, sealed: true, finishChannel: 0, chunkBytes: STATION_CHUNK_BYTES }],
  [
    "T8030",
    {
      path: homeBase3RecordingPath,
      sealed: false,
      finishChannel: STATION_CHANNEL,
      chunkBytes: 400_000,
      missingCode: -111,
    },
  ],
]);

/** One recording transfer on a station session. */
export interface RecordingTransfer {
  /** The recording's frames, in arrival order. Rejects as {@link receiveRecording} describes. */
  frames: Promise<RecordingFrame[]>;
  /** Resolves once the station has stopped sending this recording, which can be after `frames` rejected. */
  drained: Promise<void>;
}

/**
 * Request one recording and collect its frames until `CMD_DOWNLOAD_FINISH`. Only frames on
 * {@link RECORDING_DATA_TYPE} tagged with the camera's channel belong to it, so a live stream open on the same
 * station is never mixed in. The finish frame is taken on the camera's channel or on `finishChannel`
 * ({@link RecordingStation.finishChannel}).
 *
 * `frames` rejects with {@link RecordingDownloadError}: `no-data` when the station's reply on the camera's
 * channel carries `missingCode` ({@link RecordingStation.missingCode}) before any of the recording's frames, which
 * also ends the transfer, or when nothing arrives within
 * {@link FIRST_FRAME_WAIT_MS}, and `incomplete` when the transfer ends without its finish frame, on a
 * {@link IDLE_END_MS} silence, on `timeoutMs` or on {@link MAX_TRANSFER_BYTES}. An abort rejects it at once
 * with the signal's reason. After a time bound, the byte ceiling or an abort, the transfer stops collecting
 * but keeps listening until the station finishes or goes quiet, and only then resolves `drained`.
 */
export function receiveRecording(
  session: P2PSession,
  request: {
    path: string;
    accountId: string;
    channel: number;
    finishChannel: number;
    missingCode?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): RecordingTransfer {
  let resolveFrames!: (frames: RecordingFrame[]) => void;
  let rejectFrames!: (error: Error) => void;
  const frames = new Promise<RecordingFrame[]>((resolve, reject) => {
    resolveFrames = resolve;
    rejectFrames = reject;
  });
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => (resolveDrained = resolve));
  const limitMs = request.timeoutMs ?? DEFAULT_TRANSFER_MS;
  let collected: RecordingFrame[] = [];
  const started = Date.now();
  let lastFrameAt = started;
  let received = false;
  let bytes = 0;
  let draining: string | undefined;
  let delivered = false;
  let listening = true;
  const deliver = (error?: Error) => {
    if (delivered) return;
    delivered = true;
    request.signal?.removeEventListener("abort", onAbort);
    if (error) rejectFrames(error);
    else resolveFrames(collected);
  };
  const stop = () => {
    if (!listening) return;
    listening = false;
    clearInterval(tick);
    session.off("data", onData);
    resolveDrained();
  };
  const incomplete = (why: string) =>
    deliver(new RecordingDownloadError("incomplete", `the recording transfer ${why} before its finish frame`));
  const drain = (why: string) => {
    draining ??= why;
    collected = [];
  };
  const onData = (frame: P2PFrame) => {
    if (frame.commandId === CommandType.CMD_DOWNLOAD_VIDEO) {
      if (frame.channel !== request.channel || frame.dataType !== 0 || received || draining) return;
      if (frame.data.length < 4 || frame.data.readInt32LE(0) !== request.missingCode) return;
      deliver(new RecordingDownloadError("no-data", `the station holds no recording at ${request.path}`));
      return stop();
    }
    if (frame.commandId === CommandType.CMD_DOWNLOAD_FINISH) {
      if (frame.channel !== request.channel && frame.channel !== request.finishChannel) return;
      if (draining) incomplete(draining);
      else deliver();
      return stop();
    }
    if (frame.channel !== request.channel) return;
    if (frame.commandId !== CommandType.CMD_VIDEO_FRAME && frame.commandId !== CommandType.CMD_AUDIO_FRAME) return;
    if (frame.dataType !== RECORDING_DATA_TYPE) return;
    received = true;
    lastFrameAt = Date.now();
    if (draining) return;
    collected.push({ commandId: frame.commandId, signCode: frame.signCode, raw: Buffer.from(frame.raw) });
    bytes += frame.raw.length;
    if (bytes >= MAX_TRANSFER_BYTES) drain(`reached ${MAX_TRANSFER_BYTES} bytes`);
  };
  const onAbort = () => {
    deliver(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
    drain("was aborted");
  };
  const tick = setInterval(() => {
    const now = Date.now();
    if (!received && now - started > FIRST_FRAME_WAIT_MS) {
      deliver(new RecordingDownloadError("no-data", `the station sent nothing within ${FIRST_FRAME_WAIT_MS} ms`));
      stop();
    } else if (received && now - lastFrameAt > IDLE_END_MS) {
      incomplete(draining ?? `went quiet for ${IDLE_END_MS} ms`);
      stop();
    } else if (now - started > 2 * limitMs && draining) {
      incomplete(draining);
      stop();
    } else if (now - started > limitMs) {
      drain(`ran past ${limitMs} ms`);
    }
  }, 250);
  if (request.signal?.aborted) {
    onAbort();
    stop();
    return { frames, drained };
  }
  request.signal?.addEventListener("abort", onAbort, { once: true });
  session.on("data", onData);
  try {
    session.sendStringPairCommand(CommandType.CMD_DOWNLOAD_VIDEO, request.path, request.accountId, request.channel);
  } catch (error) {
    deliver(error instanceof Error ? error : new Error(String(error)));
    stop();
  }
  return { frames, drained };
}

/**
 * The bytes a video frame carries in the clear: `header.payloadLength` bytes after the 22-byte header, or
 * `undefined` for a frame shorter than its header declares.
 */
function clearVideoPayload(raw: Buffer, header: VideoFrameHeader): Buffer | undefined {
  const end = VIDEO_HEADER_LEN + header.payloadLength;
  return raw.length >= end ? raw.subarray(VIDEO_HEADER_LEN, end) : undefined;
}

/**
 * Decode a recording's frames, in arrival order, into elementary streams. `station` sets where a split
 * picture continues ({@link RecordingStation.chunkBytes}) and whether the frames are sealed
 * ({@link RecordingStation.sealed}). On a sealed station a keyframe goes through one {@link VideoFrameDecoder}
 * under `eccPrivateKeyHex`, and audio opens under that decoder's current media key; a keyframe that does not
 * open, and audio before the first media key, are dropped. On a station in the clear every video payload is read
 * as it is, and audio is everything after its 16-byte header; a keyframe that is in fact sealed begins with an
 * ECIES point rather than a start code, so the assembler drops it. Split pictures are assembled before they
 * enter the output, and an orphan continuation cannot become its own picture. Audio frames whose codec byte is
 * not AAC-LC are dropped.
 *
 * Frame numbers are compared only within one frame size: a keyframe whose width or height differs from the last
 * frame that states a size is counted as the frame after the one before it, and the frames after it follow on
 * from there. A frame whose header states no size is passed over.
 *
 * Rejects with {@link RecordingDownloadError} `undecodable` when no video frame decodes, and on a sealed
 * station whose key is absent or not a P-256 key.
 */
export function decodeRecording(
  frames: readonly RecordingFrame[],
  station: Pick<RecordingStation, "sealed" | "chunkBytes">,
  eccPrivateKeyHex?: string,
): RecordingDownload {
  const eccPrivateKey = station.sealed ? Buffer.from(eccPrivateKeyHex ?? "", "hex") : undefined;
  if (eccPrivateKey && eccPrivateKey.length !== 32) {
    throw new RecordingDownloadError("undecodable", "the cipher key is not a P-256 key");
  }
  const decoder = eccPrivateKey && new VideoFrameDecoder(eccPrivateKey);
  const assembler = new AccessUnitAssembler(undefined, station.chunkBytes);
  const video: Buffer[] = [];
  let codec: VideoCodec | undefined;
  const audio: Buffer[] = [];
  const numbers = new Set<number>();
  const receivedNumbers = new Set<number>();
  let firstStamp: number | undefined;
  let lastStamp: number | undefined;
  let frameSize: string | undefined;
  let shift = 0;
  let sequence = 0;
  for (const { commandId, raw } of frames) {
    if (commandId === CommandType.CMD_VIDEO_FRAME) {
      const header = parseVideoFrameHeader(raw);
      if (!header) continue;
      const size = header.width && header.height ? `${header.width}x${header.height}` : undefined;
      if (header.keyframe && size && frameSize !== undefined && size !== frameSize) {
        shift = (sequence + 1 - header.sequence) & 0xffff;
      }
      if (size) frameSize = size;
      sequence = (header.sequence + shift) & 0xffff;
      receivedNumbers.add(sequence);
      const units = assembler.push(raw, (payload) =>
        decoder && header.keyframe ? decoder.decodeFrame(payload)?.h264 : clearVideoPayload(payload, header),
      );
      for (const unit of units) {
        video.push(unit.data);
        if (unit.keyframe) codec ??= sniffAnnexbCodec(unit.data);
        numbers.add(sequence);
        const stamp = raw.readUIntLE(0x0e, 6);
        firstStamp ??= stamp;
        lastStamp = stamp;
      }
    } else if (commandId === CommandType.CMD_AUDIO_FRAME) {
      if (raw[5] !== AUDIO_CODEC_AAC_LC) continue;
      const mediaKey = decoder?.currentMediaKey;
      const aac = decoder ? mediaKey && openSealedAudio(raw, mediaKey) : raw.subarray(AUDIO_HEADER_LEN);
      if (aac?.length) audio.push(aac);
    }
  }
  if (!video.length) throw new RecordingDownloadError("undecodable", "no video frame of the recording decoded");
  const ordered = [...numbers];
  const received = [...receivedNumbers];
  let missingFrames = receivedNumbers.size - numbers.size;
  for (let i = 1; i < received.length; i++) {
    const step = (received[i]! - received[i - 1]!) & 0xffff;
    if (step > 1 && step < 0x8000) missingFrames += step - 1;
  }
  const span = ordered.length > 1 ? (ordered[ordered.length - 1]! - ordered[0]!) & 0xffff : 0;
  const durationMs = (lastStamp ?? 0) - (firstStamp ?? 0);
  return {
    video: Buffer.concat(video),
    ...(codec ? { codec } : {}),
    ...(audio.length ? { audio: Buffer.concat(audio) } : {}),
    frames: ordered.length,
    missingFrames,
    durationMs,
    fps: durationMs > 0 && span > 0 ? Math.round((span * 100_000) / durationMs) / 100 : 0,
  };
}
