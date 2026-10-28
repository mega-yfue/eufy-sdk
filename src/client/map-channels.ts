/**
 * Which decoder reads which map-stream channel.
 *
 * This table is the one place the transport's channel numbering meets the model's decoders, and it
 * lives here because this is the only layer that may see both: `model/` is barred from importing
 * `transport/`, which is what stops a decoder from growing an opinion about a topic.
 *
 * **The numbering is read off a robot's frames, not declared.** `BIZ_CHANNEL` pairs each channel with
 * the `stream.proto` message its frames' field layout matches. No `Metadata` frame has been observed,
 * and the string `ChanIds` appears nowhere in the decompiled app, so no device-declared numbering
 * overrides it. A device that numbered differently would be decoded wrongly: the plane and outline
 * readers reject a message without the geometry and cells they require, but the room-list and zone
 * readers accept any well-formed message, so the channel id is what keeps those right.
 *
 * @module client/map-channels
 */
import { BIZ_CHANNEL } from "../transport/mqtt/biz-stream.js";
import type { BizChannel, BizMapFrame } from "../transport/mqtt/biz-stream.js";
import {
  decodeVacuumMap,
  decodeVacuumMapBackup,
  decodeVacuumMapDescription,
  decodeVacuumRestrictedZones,
  decodeVacuumRoomOutline,
  decodeVacuumRoomParams,
} from "../model/index.js";
import type { RawDpCodec } from "../core/contracts.js";
import type { VacuumMapPiece } from "../model/index.js";

/** A decoder for one channel, already tagged with the piece kind its result becomes. */
type ChannelReader = (raw: string, codec: RawDpCodec) => VacuumMapPiece | undefined;

const reader =
  <K extends VacuumMapPiece["kind"]>(
    kind: K,
    decode: (raw: unknown, codec: RawDpCodec | undefined) => unknown,
  ): ChannelReader =>
  (raw, codec) => {
    const value = decode(raw, codec);
    return value === undefined ? undefined : ({ kind, value } as VacuumMapPiece);
  };

/**
 * The channels this SDK reads, by their {@link BIZ_CHANNEL} id.
 *
 * `SCENES` is absent because scenes already arrive on DP 180. A frame on a channel without a reader is
 * reported as undecoded rather than half-read by a decoder written for a different message.
 */
const READER_BY_CHANNEL = {
  MAP_DATA: reader("plane", decodeVacuumMap),
  ROOM_OUTLINE: reader("outline", decodeVacuumRoomOutline),
  ROOM_PARAMS: reader("rooms", decodeVacuumRoomParams),
  RESTRICTED_ZONE: reader("zones", decodeVacuumRestrictedZones),
  MAP_DESCRIPTION: reader("description", decodeVacuumMapDescription),
  MAP_BACKUP: reader("backup", decodeVacuumMapBackup),
} satisfies Partial<Record<BizChannel, ChannelReader>>;

/**
 * Which channels are read, named as {@link BIZ_CHANNEL} names them — the key set of
 * {@link READER_BY_CHANNEL}. The `satisfies` on that table constrains every key to a `BizChannel`.
 */
export const DECODED_MAP_CHANNELS: readonly BizChannel[] = Object.keys(READER_BY_CHANNEL) as BizChannel[];

const READERS: ReadonlyMap<number, ChannelReader> = new Map(
  DECODED_MAP_CHANNELS.map((name) => [BIZ_CHANNEL[name], READER_BY_CHANNEL[name as keyof typeof READER_BY_CHANNEL]]),
);

/**
 * Decode one frame off the map stream into the map piece it carries, or `undefined`.
 *
 * `undefined` is the ordinary answer for a channel nothing reads yet, and for a frame that is not a
 * whole message.
 *
 * **A frame with a non-zero `offset` is skipped without being decoded.** A large map is split across
 * frames, and `offset` locates this one within its channel — so whatever it counts, a non-zero value
 * means this is not the start of a message. Handing a fragment to a protobuf reader is how a decoder
 * produces a confident wrong answer. The reader would in fact reject it anyway, because the frame's
 * own length prefix disagrees with a partial body, but relying on that would make correctness an
 * accident of the framing rather than a decision.
 */
export function decodeMapFrame(frame: BizMapFrame, codec: RawDpCodec): VacuumMapPiece | undefined {
  if (frame.offset !== 0) return undefined;
  return READERS.get(frame.channelId)?.(frame.payload, codec);
}
