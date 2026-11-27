import type { PushEvent } from "../transport/push/types.js";

/** How long a push's identity is held; it bounds memory, since a `unique_id` names one detection. */
const WINDOW_MS = 30_000;

/**
 * A push repeats an earlier one with the same device, `event_type` and `unique_id` within the window,
 * and a push missing any of the three never does.
 */
export class PushRepeats {
  private readonly seen = new Map<string, number>();

  /** Record this push, answering `true` when it repeats one already recorded. */
  repeat(event: PushEvent): boolean {
    const uniqueId = event.payload.unique_id;
    if (!event.deviceSn || event.eventType == null || typeof uniqueId !== "string" || !uniqueId) return false;
    const at = Date.now();
    for (const [key, seenAt] of this.seen) if (at - seenAt > WINDOW_MS) this.seen.delete(key);
    const key = `${event.deviceSn}:${event.eventType}:${uniqueId}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, at);
    return false;
  }
}
