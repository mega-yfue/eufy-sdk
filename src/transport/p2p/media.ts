/**
 * Camera **media** operations over P2P — live snapshot, live stream, clip recording.
 *
 * These are the bodies that used to live on `EufyMega`; they take an already-resolved
 * {@link P2PSession} (the client owns session/channel resolution) and return data. They speak only
 * P2P + ffmpeg — no dependency on the client class — so the client stays thin and this stays the
 * single home for the media protocol. Surfaced to consumers via `device.camera()`.
 *
 * `snapshotLive` / `record` shell out to ffmpeg. The binary is whatever {@link spawnFfmpeg} resolves —
 * the bare name on `PATH` by default, or the executable the caller named (`ffmpegPath`).
 *
 * @module p2p/media
 */
import { P2PSession } from "./p2p-session.js";
import { LiveStream, type LiveStreamOptions } from "./live-stream.js";
import { sniffAnnexbCodec } from "./annexb.js";
import { spawnFfmpeg, type FfmpegLevel } from "../ffmpeg.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { SharedLiveSource } from "./shared-live-source.js";
import type { LiveVideoFrame } from "../../core/contracts.js";

/**
 * ffmpeg's `-f` demuxer name for an Annex-B buffer. Sniffs via the shared {@link sniffAnnexbCodec}
 * (the single NAL-scan source of truth) and maps the contract's `"h265"` to ffmpeg's `"hevc"`;
 * defaults to `"h264"` when the buffer carries no config NAL to sniff.
 */
function annexbFfmpegFormat(buf: Buffer): "hevc" | "h264" {
  return sniffAnnexbCodec(buf) === "h265" ? "hevc" : "h264";
}

/**
 * Open a managed **live stream** on an already-connected session. Returns the {@link LiveStream}
 * already `start()`ed; call `.stop()` when done. (Session/channel/level-2-key resolution is the
 * caller's job — see `EufyMega.resolveSession`.)
 */
export async function openLiveStream(session: P2PSession, opts: LiveStreamOptions = {}): Promise<LiveStream> {
  return new LiveStream(session, opts).start();
}

/**
 * **Live snapshot off a SHARED source** (V6) — snapshot as just another consumer of the shared live
 * pull. If the source is already warm and has a cached keyframe (V2 keyframe-prime), the joining
 * consumer receives that IDR immediately and we decode it with **no extra pull** — a snapshot while
 * someone else watches costs nothing on the wire. Otherwise we warm the source and wait for a clean
 * keyframe (the first IDR after a cold start is frequently partial, so skip it by default). Requires
 * `ffmpeg` for the Annex-B → JPEG decode.
 */
export async function captureSnapshotFromShared(
  source: SharedLiveSource,
  opts: {
    timeoutMs?: number;
    collectMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
    ffmpegPath?: string;
  } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const collectMs = opts.collectMs ?? 1500;
  const skip = opts.skipKeyframes ?? 1;
  const consumer = source.attach();
  // A primed consumer gets the cached IDR first — a single decodable keyframe: take it and decode at
  // once (no skip, no collect window). A cold consumer skips the (often partial) first IDR.
  const primed = consumer.primed;
  try {
    const { h264, width, height } = await new Promise<{ h264: Buffer; width: number; height: number }>(
      (resolve, reject) => {
        const bufs: Buffer[] = [];
        let keyCount = 0,
          capturing = false,
          w = 0,
          h = 0,
          settle: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("timeout waiting for a clean keyframe"));
        }, timeoutMs);
        const onVideo = (fr: LiveVideoFrame) => {
          if (fr.keyframe) keyCount++;
          if (!capturing) {
            const threshold = primed ? 0 : skip; // primed: accept the cached IDR immediately
            if (!fr.keyframe || keyCount <= threshold) return;
            capturing = true;
            w = fr.width;
            h = fr.height;
          }
          bufs.push(fr.data);
          if (!settle)
            settle = setTimeout(
              () => {
                cleanup();
                resolve({ h264: Buffer.concat(bufs), width: w, height: h });
              },
              primed ? 0 : collectMs,
            );
        };
        const cleanup = () => {
          clearTimeout(timer);
          if (settle) clearTimeout(settle);
          consumer.off("video", onVideo);
        };
        consumer.on("video", onVideo);
        consumer.on("error", () => {});
      },
    );
    const jpeg = await annexbToJpeg(h264, opts.logger ?? noopLogger, opts.ffmpegLevel, opts.ffmpegPath);
    return { jpeg, width, height };
  } finally {
    consumer.detach();
  }
}

/**
 * **Record** a clip — collect the live H.264/H.265 stream for `seconds` and mux it to a fragmented
 * MP4 (same source as {@link captureSnapshotFromShared}, kept running and written to a container).
 * Recording starts at the first complete keyframe so the clip is seekable. Requires `ffmpeg`.
 */
export async function recordClip(
  session: P2PSession,
  seconds: number,
  opts: {
    timeoutMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
    ffmpegPath?: string;
  } & LiveStreamOptions = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const skip = opts.skipKeyframes ?? 1;
  const stream = await openLiveStream(session, opts);
  let h264: Buffer;
  try {
    h264 = await new Promise<Buffer>((resolve, reject) => {
      const bufs: Buffer[] = [];
      let keyCount = 0,
        capturing = false,
        stopAt = 0;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for a clean keyframe"));
      }, timeoutMs);
      const onVideo = (fr: LiveVideoFrame) => {
        if (fr.keyframe) keyCount++;
        if (!capturing) {
          if (!fr.keyframe || keyCount <= skip) return; // start the clip at the first COMPLETE keyframe
          capturing = true;
          clearTimeout(timer);
          stopAt = Date.now() + seconds * 1000;
        }
        bufs.push(fr.data);
        if (Date.now() >= stopAt) {
          cleanup();
          resolve(Buffer.concat(bufs));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        stream.off("video", onVideo);
      };
      stream.on("video", onVideo);
      stream.on("error", () => {});
    });
  } finally {
    stream.stop();
  }
  // mux the elementary stream (codec auto-detected) into a fragmented MP4
  const codec = annexbFfmpegFormat(h264);
  return new Promise<Buffer>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { logger: opts.logger, level: opts.ffmpegLevel, path: opts.ffmpegPath },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) => reject(new Error(`ffmpeg not runnable: ${e instanceof Error ? e.message : e}`)));
    ff.on("close", (code) => {
      const mp4 = Buffer.concat(out);
      if (mp4.length) resolve(mp4);
      else reject(new Error(`ffmpeg mux failed (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(h264);
    ff.stdin!.end();
  });
}

/** Decode an Annex-B buffer (H.264 or H.265, starting at a keyframe) to a single JPEG via ffmpeg. */
function annexbToJpeg(
  annexb: Buffer,
  logger: Logger = noopLogger,
  level?: FfmpegLevel,
  path?: string,
): Promise<Buffer> {
  const codec = annexbFfmpegFormat(annexb);
  return new Promise<Buffer>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { logger, level, path },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) =>
      reject(new Error(`ffmpeg not runnable (is it installed?): ${e instanceof Error ? e.message : e}`)),
    );
    ff.on("close", (code) => {
      const jpeg = Buffer.concat(out);
      if (jpeg.length >= 3 && jpeg.subarray(0, 3).toString("hex") === "ffd8ff") resolve(jpeg);
      else
        reject(new Error(`ffmpeg JPEG decode failed (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(annexb);
    ff.stdin!.end();
  });
}
