/**
 * Reader for the `biz/eufy_home/<model>/<sn>/res` leg — the map stream.
 *
 * A clean-line device already subscribes four topics (`topics.ts`), and this is the second of them.
 * The DP leg carries state; this one carries the map: pixel planes, room outlines and names, virtual
 * walls, the live pose. Until now every message on it fell through the DP parsers, which correctly
 * refuse it, and was dropped.
 *
 * **Read from the app, not inferred.** The envelope below is
 * `com.anker.aiot_sdk.device.BaseRobovacServiceImpl.dispatchMessage` and
 * `com.anker.clean_native_bridge.module.manager.aiot.AiotMapManager`, in the disassembled V6 app: the
 * `protocol` discriminator, the six fields a frame must carry, and the special meaning of channel 0
 * are all the app's own rules rather than a shape this SDK guessed from a capture.
 *
 * What this module does NOT do is decode the protobuf inside. It unwraps to a Raw-DP frame — the same
 * `varint(len) ++ message` every DP payload carries, only hex-encoded — and hands it on. Which message
 * the bytes are is the channel's business ({@link BIZ_CHANNEL}).
 *
 * @module transport/mqtt/biz-stream
 */
import { hexToRawDp } from "../../core/raw-dp-hex.js";
import { jsonObject } from "../../core/util.js";

/**
 * The `payload.protocol` discriminator, which says what the whole message is before any field of it is
 * read. Taken from the app's own dispatch, which switches on exactly these two and ignores the rest.
 *
 * `41` is the number the reference integration named its parser after without saying where it came
 * from; it is this field.
 */
export const BIZ_PROTOCOL = {
  /** Map-stream data: the frames this module parses. */
  MAP_DATA: 41,
  /** A live photo from the robot's camera — a different payload entirely, not read here. */
  LIVE_PHOTO: 43,
} as const;

/**
 * The channels a map frame arrives on, by id, as a robot's own frames identify them.
 *
 * Each id is paired with the `stream.proto` message whose field layout its frames carry, which is not
 * the field-number order of `Metadata.ChanIds`: the cell plane (`Map`) arrives on 2, its room outline
 * on 4, the room list on 5, the restricted zones on 6, the map's `MapDescription` on 60 and a whole
 * `MapBackup` on 68. A `Metadata` frame would declare a device's own numbering; none has been seen,
 * so none is read, and this table is the numbering every frame is read by.
 *
 * Only channels whose message is identified are listed. A channel whose frames carry too little to
 * identify — an empty message, or two bare integers — is absent, and so is the robot's pose until a
 * frame carrying one is seen.
 *
 * Channel 0 is not in `ChanIds` at all: the app hard-codes it, routing it to a scene-data event rather
 * than a map one, and asks for the scene list on it by number.
 */
export const BIZ_CHANNEL = {
  /** Scene (room-group) data. Hard-coded in the app, not part of `ChanIds`. */
  SCENES: 0,
  MAP_DATA: 2,
  ROOM_OUTLINE: 4,
  ROOM_PARAMS: 5,
  RESTRICTED_ZONE: 6,
  MAP_DESCRIPTION: 60,
  MAP_BACKUP: 68,
} as const;

/** A channel's name under the {@link BIZ_CHANNEL} numbering. */
export type BizChannel = keyof typeof BIZ_CHANNEL;

const BY_ID = new Map<number, BizChannel>(Object.entries(BIZ_CHANNEL).map(([name, id]) => [id, name as BizChannel]));

/**
 * Name a channel id under the {@link BIZ_CHANNEL} numbering, or `undefined` for an id it does not list.
 * Not a substitute for a device-declared mapping where one exists.
 */
export function bizChannelName(id: number): BizChannel | undefined {
  return BY_ID.get(id);
}

/** One frame off the map stream, unwrapped as far as its bytes but not decoded. */
export interface BizMapFrame {
  /** Which channel the bytes belong to. Compare against {@link BIZ_CHANNEL}. */
  readonly channelId: number;
  /**
   * The vendor's `clear_type`. Forwarded, not interpreted: the app passes it straight through to its
   * own UI layer and nothing observed says what its values mean. A `Map` I-frame is documented to make
   * the device clear the channel's accumulated data first, so this plausibly says so — plausibly is
   * not a decode.
   */
  readonly clearType: number;
  /** The vendor's `data_type`. The app reads this field and then discards it; so does this. */
  readonly dataType: number;
  /**
   * The vendor's `offset` and `len`. A large map is split across frames, and these two locate this
   * one — but which of "offset into the channel buffer" and "length of this chunk" versus "length of
   * the whole" they mean is decided in the app's React Native layer, which ships as Hermes bytecode
   * and was not readable. They are carried verbatim so a reassembler can be written against a capture
   * rather than against a guess.
   */
  readonly offset: number;
  /** See {@link BizMapFrame.offset}. */
  readonly len: number;
  /**
   * The frame's bytes, re-encoded as the base64 a `RawDpCodec` reads. The wire sends hex; the framing
   * underneath is the same `varint(len) ++ protobufMessage` every Raw DP uses.
   */
  readonly payload: string;
}

/** Read an envelope field that must be a non-negative integer, however the JSON spelled it. */
function count(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Parse one message off `biz/…/res` into a map frame, or `undefined` if it is not one.
 *
 * **`undefined` is the common case and not an error.** This runs against every message on a shared
 * connection: DP reports, ACKs on the `biz/…/req` leg, live-photo notifications, and anything else the
 * broker delivers all arrive here and all correctly decline. Nothing is logged and nothing throws.
 *
 * The shape, layer by layer, is the app's:
 *
 * 1. `{ payload }`, where `payload` is an object OR a JSON string holding one — the same
 *    double-encoding the DP path already handles.
 * 2. `payload.protocol === 41`. A `43` here is a live photo and belongs to a different reader.
 * 3. `payload.data` carrying all six of `channel_id`, `clear_type`, `data_type`, `offset`, `data` and
 *    `len`. The app refuses the message outright when any one is missing, and so does this: a frame
 *    missing a field is a frame this code does not understand, and half of it is worth nothing.
 * 4. `data.data`, hex, re-encoded to base64 — and rejected unless it is *clean* hex, because hex
 *    truncates in the one direction the frame's own length prefix cannot catch (see
 *    {@link hexToRawDp}).
 */
export function parseBizMapFrame(raw: unknown): BizMapFrame | undefined {
  const envelope = raw as { payload?: unknown } | undefined;
  const outer = envelope?.payload;
  const payload =
    jsonObject(outer) ??
    (outer && typeof outer === "object" && !Array.isArray(outer) ? (outer as Record<string, unknown>) : undefined);
  if (!payload) return undefined;
  if (count(payload.protocol) !== BIZ_PROTOCOL.MAP_DATA) return undefined;

  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;

  const channelId = count(d.channel_id);
  const clearType = count(d.clear_type);
  const dataType = count(d.data_type);
  const offset = count(d.offset);
  const len = count(d.len);
  if (channelId === undefined || clearType === undefined || dataType === undefined) return undefined;
  if (offset === undefined || len === undefined) return undefined;

  const payloadB64 = typeof d.data === "string" ? hexToRawDp(d.data) : undefined;
  if (payloadB64 === undefined) return undefined;

  return { channelId, clearType, dataType, offset, len, payload: payloadB64 };
}
