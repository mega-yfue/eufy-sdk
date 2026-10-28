/**
 * Bounded, identity-free records of the device notifications a station sends over P2P.
 *
 * A record is logged for two kinds of inbound frame: one that volunteers device params, and a
 * notification no capability decoded into state or an event. The second is where a state change the
 * SDK has no decoder for yet arrives, so the records are what a decoder for it is written from.
 *
 * Every field is a device type, a channel, a command or sign code, a size, or a redacted payload. A
 * string is carried only when it is a short run of digits — a param value or a mode — and otherwise
 * as its length, so no serial, P2P identifier, account id, address, name or path reaches a log.
 *
 * @module client/notify-trace
 */
import type { P2PFrame } from "../transport/p2p/p2p-session.js";

/** The message every notify record is logged under. */
export const NOTIFY_TRACE_MESSAGE = "[p2p] device notify";

/** One inbound notification, redacted. */
export interface NotifyTrace {
  /** The cloud `device_type` of the device the frame resolved to, when it resolved to one. */
  deviceType?: number;
  /** The station channel the frame was addressed to. */
  channel: number;
  commandId: number;
  signCode: number;
  /** Whether the payload decrypted and parsed as JSON. */
  decoded: boolean;
  /** The payload length, for a frame whose payload did not parse. */
  bytes?: number;
  /** The parsed JSON document, redacted. */
  json?: unknown;
  /** The params the frame volunteered, `param_type → value`, values redacted. */
  params?: Record<number, unknown>;
}

/** Nesting below which an object or array is reduced to its size. */
const MAX_DEPTH = 3;

/** Entries kept from one object or array; a longer one is reduced to its size. */
const MAX_ENTRIES = 16;

/** A string carried verbatim: a short run of digits, optionally signed. */
const DIGITS = /^-?\d{1,6}$/;

/**
 * A value with every string that is not a short run of digits replaced by `<string:length>`, and every
 * container past {@link MAX_DEPTH} or {@link MAX_ENTRIES} replaced by `<array:length>` or `<object:keys>`.
 */
export function redactNotifyValue(value: unknown, depth = MAX_DEPTH): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return DIGITS.test(value) ? value : `<string:${value.length}>`;
  if (Array.isArray(value)) {
    if (depth === 0 || value.length > MAX_ENTRIES) return `<array:${value.length}>`;
    return value.map((v) => redactNotifyValue(v, depth - 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth === 0 || entries.length > MAX_ENTRIES) return `<object:${entries.length}>`;
    return Object.fromEntries(entries.map(([k, v]) => [k, redactNotifyValue(v, depth - 1)]));
  }
  return `<${typeof value}>`;
}

/**
 * The record for one inbound frame, or `undefined` when the frame is not one to record.
 *
 * Recorded: a frame carrying params, and a notification that `claimed` says no capability decoded —
 * a parsed JSON document, or a `CMD_NOTIFY_PAYLOAD` whose payload did not parse. Media and other
 * binary frames carry neither and are never recorded.
 *
 * @param claimed whether a capability decoded the frame into state or an event
 */
export function notifyTrace(f: P2PFrame, deviceType: number | undefined, claimed: boolean): NotifyTrace | undefined {
  const notification = f.json !== undefined || f.commandName === "CMD_NOTIFY_PAYLOAD";
  if (!f.params && (claimed || !notification)) return undefined;
  const trace: NotifyTrace = {
    ...(deviceType === undefined ? {} : { deviceType }),
    channel: f.channel,
    commandId: f.commandId,
    signCode: f.signCode,
    decoded: f.json !== undefined,
  };
  if (f.json === undefined) trace.bytes = f.data.length;
  else trace.json = redactNotifyValue(f.json);
  if (f.params) {
    trace.params = Object.fromEntries(Object.entries(f.params).map(([id, v]) => [Number(id), redactNotifyValue(v)]));
  }
  return trace;
}
