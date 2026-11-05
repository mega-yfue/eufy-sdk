/**
 * The bound a caller waits for the level-2 negotiation to SETTLE, measured from connect.
 *
 * For a caller that picks its seal once from `P2PSession.hasLevel2Key` and has no second chance. A media
 * start reads the key on every send and is re-issued by the warm-up, so it needs no wait; a property write
 * framed level-1 to a family that only accepts level-2 is ignored, and nothing re-frames it. Session-scoped,
 * so a station that offers no key does not charge this to every later command.
 */
export const LEVEL2_SETTLE_MS = 8_000;
