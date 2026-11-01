import { StoredSnapshotUnavailableError, type StoredSnapshotUnavailableReason } from "../core/contracts.js";
import type { Logger } from "../core/logger.js";
import { MEDIA_FAILURE_REASONS, type MediaFailureReason } from "./media-failure.js";

const MAX_JPEG_BYTES = 10 * 1024 * 1024;

/**
 * How many candidate URLs per device are remembered as already attempted.
 *
 * The set exists so the same thumbnail is not downloaded twice — one event arrives as several pushes
 * (motion, then a person, then a face) carrying one URL between them. That is a question about the last
 * few seconds, so a bounded window answers it exactly as well as an unbounded one, and unbounded is a
 * leak: a signed media URL is a few hundred bytes, a busy camera produces hundreds a day, and a host
 * that caps an app's memory does not care that each one is small.
 */
const MAX_REMEMBERED_URLS = 64;

/** A 404 is attempted again after each delay; any other failure ends on the first attempt. */
const NOT_YET_PUBLISHED_RETRY_MS = [2_000, 4_000];

type Candidate = {
  deviceKey: string;
  url: string;
  sequence: number;
  observedAt: number;
  generation: number;
  /** Retries already spent on this candidate, see {@link NOT_YET_PUBLISHED_RETRY_MS}. */
  retries: number;
};

type DeviceState = {
  deviceKey: string;
  nextSequence: number;
  seenUrls: Set<string>;
  loggedFailures: Map<StoredSnapshotUnavailableReason, number>;
  queued?: Candidate;
  inFlight?: Candidate;
  /** The timer of a candidate waiting out {@link NOT_YET_PUBLISHED_RETRY_MS} before its next attempt. */
  retrying?: ReturnType<typeof setTimeout>;
  retained?: { sequence: number; image: Buffer };
  reason?: StoredSnapshotUnavailableReason;
  lifecycleError?: unknown;
};

const DIAGNOSTIC_INTERVAL_MS = 60_000;

/** In-memory state for push thumbnails acquired before a caller passively reads them. */
export class StoredImageCache {
  private readonly devices = new Map<string, DeviceState>();
  private readonly activeDevices = new Set<string>();
  private activeDownloads = 0;
  private generation = 0;
  /**
   * Bumped by {@link clearLifecycleErrors}. A lifecycle failure from a download started under an older
   * count is not recorded; the candidate is queued again, unless a newer one is already queued, so the
   * current session fetches it.
   */
  private lifecycle = 0;

  constructor(
    private readonly downloader: (url: string, deviceKey: string) => Promise<Buffer>,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
    private readonly isLifecycleError: (error: unknown) => boolean = () => false,
  ) {}

  /**
   * Observe a normalized thumbnail URL and start acquisition eagerly.
   *
   * A URL already inside this device's window of recent attempts is ignored, so one event arriving as
   * several pushes downloads one thumbnail. The window is a `Set`, which iterates in insertion order,
   * so the entry evicted once it is full is the oldest attempt.
   */
  observe(deviceKey: string, url: string): void {
    let state = this.devices.get(deviceKey);
    if (!state) {
      state = {
        deviceKey,
        nextSequence: 0,
        seenUrls: new Set(),
        loggedFailures: new Map(),
      };
      this.devices.set(deviceKey, state);
    }
    if (state.seenUrls.has(url)) return;
    state.seenUrls.add(url);
    clearTimeout(state.retrying);
    state.retrying = undefined;
    while (state.seenUrls.size > MAX_REMEMBERED_URLS) {
      const oldest = state.seenUrls.values().next();
      if (oldest.done) break;
      state.seenUrls.delete(oldest.value);
    }
    state.queued = {
      deviceKey,
      url,
      sequence: ++state.nextSequence,
      observedAt: this.clock(),
      generation: this.generation,
      retries: 0,
    };
    this.pump();
  }

  /** Return retained bytes without starting or awaiting network work. */
  snapshotStored(deviceKey: string): Promise<Buffer> {
    const state = this.devices.get(deviceKey);
    const reason = state?.queued || state?.inFlight || state?.retrying ? "pending" : (state?.reason ?? "not-observed");
    if (reason !== "pending" && state?.lifecycleError) return Promise.reject(state.lifecycleError);
    if (state?.retained) return Promise.resolve(state.retained.image);
    return Promise.reject(new StoredSnapshotUnavailableError(reason, "No stored snapshot is available"));
  }

  /**
   * Forget every device's recorded lifecycle failure, keeping retained bytes and candidate state.
   *
   * A lifecycle failure describes the session that was current when the download ran, so it no longer
   * holds once a login succeeds again; {@link snapshotStored} then answers from the retained image, or
   * with the reason a stored image is absent. A download in flight across the call cannot record one.
   */
  clearLifecycleErrors(): void {
    this.lifecycle += 1;
    for (const state of this.devices.values()) state.lifecycleError = undefined;
  }

  /** Invalidate all retained and candidate state. */
  clear(): void {
    this.generation += 1;
    this.devices.clear();
  }

  private pump(): void {
    while (this.activeDownloads < 2) {
      const state = [...this.devices.values()].find(
        (candidateState) => candidateState.queued && !this.activeDevices.has(candidateState.deviceKey),
      );
      if (!state?.queued) return;
      const candidate = state.queued;
      state.queued = undefined;
      state.inFlight = candidate;
      this.activeDownloads += 1;
      this.activeDevices.add(candidate.deviceKey);
      const lifecycle = this.lifecycle;
      void this.downloader(candidate.url, candidate.deviceKey).then(
        (image) => this.complete(candidate, lifecycle, image),
        (error: unknown) => this.complete(candidate, lifecycle, undefined, error),
      );
    }
  }

  private complete(candidate: Candidate, lifecycle: number, image: Buffer | undefined, error?: unknown): void {
    this.activeDownloads -= 1;
    this.activeDevices.delete(candidate.deviceKey);
    const state = this.devices.get(candidate.deviceKey);
    if (candidate.generation === this.generation && state?.inFlight === candidate) {
      state.inFlight = undefined;
      if (error !== undefined && this.isLifecycleError(error)) {
        if (lifecycle === this.lifecycle) {
          state.lifecycleError = error;
          state.reason = undefined;
        } else {
          state.queued ??= candidate;
        }
      } else if (image === undefined && this.retryLater(state, candidate, error)) {
        state.lifecycleError = undefined;
      } else if (image === undefined) {
        state.lifecycleError = undefined;
        state.reason = "download-failed";
        this.diagnose(state, candidate, "download-failed", error);
      } else if (!this.isValidJpeg(image)) {
        state.lifecycleError = undefined;
        state.reason = "invalid-image";
        this.diagnose(state, candidate, "invalid-image");
      } else if (!state.retained || candidate.sequence > state.retained.sequence) {
        state.retained = { sequence: candidate.sequence, image };
        state.lifecycleError = undefined;
        state.reason = undefined;
      }
    }
    this.pump();
  }

  /** Schedule the next attempt after a 404; answers whether one was scheduled. */
  private retryLater(state: DeviceState, candidate: Candidate, error: unknown): boolean {
    const delay = NOT_YET_PUBLISHED_RETRY_MS[candidate.retries];
    const tag = mediaFailureTag(error);
    if (delay === undefined || tag.cause !== "http-status" || tag.status !== 404 || state.queued) return false;
    const timer = setTimeout(() => {
      state.retrying = undefined;
      state.queued = { ...candidate, retries: candidate.retries + 1 };
      this.pump();
    }, delay);
    timer.unref?.();
    state.retrying = timer;
    return true;
  }

  private isValidJpeg(image: Buffer): boolean {
    return (
      Buffer.isBuffer(image) &&
      image.length > 0 &&
      image.length <= MAX_JPEG_BYTES &&
      image.length >= 5 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff &&
      image[image.length - 2] === 0xff &&
      image[image.length - 1] === 0xd9
    );
  }

  private diagnose(
    state: DeviceState,
    candidate: Candidate,
    failure: "download-failed" | "invalid-image",
    error?: unknown,
  ): void {
    const now = this.clock();
    const last = state.loggedFailures.get(failure);
    if (last !== undefined && now - last < DIAGNOSTIC_INTERVAL_MS) return;
    state.loggedFailures.set(failure, now);
    this.logger.warn("[stored-snapshot-cache] candidate failed", {
      class: failure,
      ...mediaFailureTag(error),
      observedAt: candidate.observedAt,
      retained: state.retained !== undefined,
    });
  }
}

/**
 * The closed-vocabulary failure tag an error carries, if it carries one this file recognises.
 *
 * Read off an unknown error and checked against {@link MEDIA_FAILURE_REASONS} rather than trusted: the
 * downloader is injected, so its errors are whatever the caller's implementation throws, and the one
 * thing that must never reach a log line here is a message someone else wrote — a media URL is signed,
 * and a failure often quotes the response. A term this SDK defines is safe by construction; anything
 * else is dropped, leaving the log exactly as uninformative as it was before.
 */
function mediaFailureTag(error: unknown): { cause?: MediaFailureReason; status?: number } {
  if (typeof error !== "object" || error === null) return {};
  const { mediaFailure, status } = error as { mediaFailure?: unknown; status?: unknown };
  if (typeof mediaFailure !== "string") return {};
  const cause = MEDIA_FAILURE_REASONS.find((reason) => reason === mediaFailure);
  if (!cause) return {};
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599
    ? { cause, status: status as number }
    : { cause };
}
