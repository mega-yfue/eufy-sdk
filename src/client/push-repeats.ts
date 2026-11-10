import type { PushEvent } from "../transport/push/types.js";

/**
 * How long a push's identity is held to recognise a later delivery of the same detection. It bounds
 * memory, not matching: a `unique_id` names one detection, so a longer window cannot pair two different
 * ones.
 */
export const PUSH_REPEAT_WINDOW_MS = 30_000;

/**
 * Tells a second FCM delivery of one detection from a new detection.
 *
 * The cloud can push one detection more than once to the same token, every copy carrying the detection's
 * `unique_id`. A copy is a repeat when an earlier push named the same device, the same `event_type` and
 * the same `unique_id` within {@link PUSH_REPEAT_WINDOW_MS}.
 *
 * A push missing any of the three is never a repeat: announcing one detection twice is recoverable,
 * suppressing a different detection is not.
 */
export class PushRepeats {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = PUSH_REPEAT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record this push, answering `true` when it repeats one already recorded. */
  repeat(event: PushEvent): boolean {
    const uniqueId = event.payload.unique_id;
    if (!event.deviceSn || event.eventType == null || typeof uniqueId !== "string" || !uniqueId) return false;
    const at = this.now();
    for (const [key, seenAt] of this.seen) if (at - seenAt > this.windowMs) this.seen.delete(key);
    const key = `${event.deviceSn}:${event.eventType}:${uniqueId}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, at);
    return false;
  }
}
