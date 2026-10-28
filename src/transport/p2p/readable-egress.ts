/**
 * Readable egress — mint a `node:stream` Readable over a {@link Consumer} of a {@link SharedLiveSource}.
 *
 * This is the in-process pull surface: the Readable can be piped anywhere a `node:stream` goes, without
 * touching the P2P internals. Backpressure is honored — when the Readable's internal buffer fills, the
 * consumer is paused; the consumer's own bounded queue then applies the V2 drop-to-keyframe policy if
 * the sink stays slow, so one stuck reader never stalls the shared upstream or its peers. Destroying the
 * Readable detaches the consumer (refcount--).
 *
 * Two modes: raw Annex-B **bytes** (default) or **objectMode** {@link LiveVideoFrame}s, which carry the
 * codec/keyframe metadata per access unit.
 *
 * @module p2p/readable-egress
 */
import { Readable } from "node:stream";
import type { Consumer } from "./shared-live-source.js";
import type { LiveVideoFrame, StreamBudgetNotice } from "../../core/contracts.js";

export interface ReadableEgressOptions {
  /** Emit {@link LiveVideoFrame} objects instead of raw Annex-B bytes (default false = bytes). */
  objectMode?: boolean;
  /** Yield ReceivedVideoFrame envelopes with original source-arrival times; ignored in raw mode. */
  arrivalTime?: boolean;
  /** Readable highWaterMark (bytes, or object count in objectMode). */
  highWaterMark?: number;
}

/**
 * Wrap a shared-source {@link Consumer} in a fresh Readable. The consumer is detached when the
 * Readable is destroyed/ended, so callers own the lifetime by owning the stream.
 * Frames arrive through onMedia, preserving their source-arrival metadata. The consumer's battery
 * `budget` notice is re-emitted unchanged as a `budget` event carrying a {@link StreamBudgetNotice};
 * without an `extend()` within its grace the shared source ends the consumer and the Readable reaches EOF.
 */
export function openReadableFromConsumer(consumer: Consumer, opts: ReadableEgressOptions = {}): Readable {
  const objectMode = opts.objectMode ?? false;

  const readable = new Readable({
    objectMode,
    highWaterMark: opts.highWaterMark,
    // Pull-driven: resume the consumer when the sink wants more.
    read() {
      consumer.resume();
    },
    destroy(err, cb) {
      consumer.detach();
      cb(err);
    },
  });

  consumer.onMedia((item) => {
    if (item.kind !== "video") return;
    const value = objectMode
      ? opts.arrivalTime
        ? { frame: item.frame, timestampMs: item.timestampMs }
        : item.frame
      : item.frame.data;
    if (!readable.push(value)) consumer.pause();
  });

  consumer.on("budget", (notice: StreamBudgetNotice) => readable.emit("budget", notice));
  consumer.on("stop", () => readable.push(null)); // upstream ended → EOF
  consumer.on("error", (err: Error) => readable.destroy(err));

  return readable;
}
