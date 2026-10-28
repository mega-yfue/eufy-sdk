import { describe, expect, it } from "vitest";
import { DECODED_MAP_CHANNELS, decodeMapFrame } from "../map-channels.js";
import { BIZ_CHANNEL } from "../../transport/mqtt/biz-stream.js";
import type { BizMapFrame } from "../../transport/mqtt/biz-stream.js";
import { blob, byteCodec, frame, int, sint, str, sub } from "../../model/capabilities/__tests__/proto-bytes.js";

/**
 * The one table where the transport's channel numbering meets the model's decoders.
 *
 * Both sides can move without the other noticing — a channel renamed here, a decoder retired there —
 * and the result would be frames silently going unread rather than anything failing. So the two are
 * pinned against each other, and the routing rules that cannot be seen from either side alone are
 * pinned here too.
 *
 * Each fixture has the top-level field layout a robot's own frame on that channel carries, with
 * synthetic values: one map, id 6, revision 1.
 */

const bizFrame = (channelId: number, payload: string, offset = 0): BizMapFrame => ({
  channelId,
  clearType: 0,
  dataType: 0,
  offset,
  len: 0,
  payload,
});

const point = (field: number, x: number, y: number): number[] => sub(field, [...sint(1, x), ...sint(2, y)]);
const quad = (field: number): number[] =>
  sub(field, [...point(1, 0, 0), ...point(2, 50, 0), ...point(3, 50, 50), ...point(4, 0, 50)]);

/** A `Map` body: pixels, pixel_size, info, name, id, releases, index — the layout channel 2 carries. */
const MAP_CELLS = Buffer.from([0x1b, 0x00, 0xff, 0x55, 0xaa, 0x01, 0x02, 0x03]);
const MAP_BODY = [
  ...blob(4, MAP_CELLS),
  ...int(5, MAP_CELLS.length),
  ...sub(6, [...int(2, 8), ...int(3, 4), ...int(4, 5), ...point(5, -150, -200), ...int(7, 2)]),
  ...str(7, "Ground floor"),
  ...int(8, 6),
  ...int(9, 1),
];

/** A `RoomOutline` body: map_id, releases, width, height, resolution, origin, pixels, pixel_size. */
const OUTLINE_CELLS = Buffer.from([0x04, 0x04, 0x08, 0x08, 0x0c, 0x0c, 0x00, 0x00]);
const OUTLINE_BODY = [
  ...int(1, 6),
  ...int(2, 1),
  ...int(3, 4),
  ...int(4, 2),
  ...int(5, 5),
  ...point(6, -100, -100),
  ...blob(7, OUTLINE_CELLS),
  ...int(8, OUTLINE_CELLS.length),
];

/** A `RoomParams` body: two rooms, map_id, releases. */
const PARAMS_BODY = [
  ...sub(2, [...int(1, 1), ...str(2, "Kitchen")]),
  ...sub(2, [...int(1, 2), ...str(2, "Hall")]),
  ...int(3, 6),
  ...int(4, 1),
];

/** A `RestrictedZone` body: one no-go zone, map_id, releases. */
const ZONES_BODY = [...quad(2), ...int(4, 6), ...int(5, 1)];

/** A `MapDescription` body: name, create_time, last_time, map_id, releases. */
const DESCRIPTION_BODY = [
  ...str(2, "Ground floor"),
  ...int(4, 1700000000),
  ...int(5, 1700000100),
  ...int(6, 6),
  ...int(7, 1),
];

describe("the channel table", () => {
  it("names only channels BIZ_CHANNEL knows", () => {
    for (const name of DECODED_MAP_CHANNELS) expect(BIZ_CHANNEL[name], name).toBeDefined();
  });

  it("reads each channel as the message its frames carry", () => {
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.MAP_DATA, frame(MAP_BODY)), byteCodec)).toMatchObject({
      kind: "plane",
      value: { mapId: 6, releases: 1, geometry: { width: 8, height: 4, resolution: 5 } },
    });
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.ROOM_OUTLINE, frame(OUTLINE_BODY)), byteCodec)).toMatchObject({
      kind: "outline",
      value: { mapId: 6, releases: 1, width: 4, height: 2 },
    });
    const rooms = decodeMapFrame(bizFrame(BIZ_CHANNEL.ROOM_PARAMS, frame(PARAMS_BODY)), byteCodec);
    expect(rooms).toMatchObject({ kind: "rooms", value: { mapId: 6, releases: 1 } });
    expect(rooms?.kind === "rooms" && rooms.value.rooms.map((r) => r.name)).toEqual(["Kitchen", "Hall"]);
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.RESTRICTED_ZONE, frame(ZONES_BODY)), byteCodec)).toMatchObject({
      kind: "zones",
      value: { mapId: 6, releases: 1, noGoZones: [{}] },
    });
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.MAP_DESCRIPTION, frame(DESCRIPTION_BODY)), byteCodec)).toMatchObject({
      kind: "description",
      value: { mapId: 6, releases: 1, name: "Ground floor" },
    });
  });

  it("reads a whole backup as every part it carries", () => {
    const backup = frame([
      ...sub(1, DESCRIPTION_BODY),
      ...sub(2, MAP_BODY),
      ...sub(3, OUTLINE_BODY),
      ...sub(4, PARAMS_BODY),
      ...sub(5, ZONES_BODY),
    ]);
    const piece = decodeMapFrame(bizFrame(BIZ_CHANNEL.MAP_BACKUP, backup), byteCodec);

    expect(piece).toMatchObject({
      kind: "backup",
      value: {
        description: { mapId: 6 },
        map: { mapId: 6 },
        outline: { mapId: 6, width: 4 },
        rooms: { mapId: 6 },
        zones: { mapId: 6 },
      },
    });
  });

  it("pins the numbering a robot's frames show", () => {
    // A schema-less reader accepts any well-formed message: a room outline read as `RoomParams`
    // answers no rooms under a "map id" that is really the outline's width. The channel id is the only
    // thing that keeps the two apart, so the numbering is pinned here rather than left to drift.
    expect(BIZ_CHANNEL).toEqual({
      SCENES: 0,
      MAP_DATA: 2,
      ROOM_OUTLINE: 4,
      ROOM_PARAMS: 5,
      RESTRICTED_ZONE: 6,
      MAP_DESCRIPTION: 60,
      MAP_BACKUP: 68,
    });
  });

  it("leaves the scene channel and any unlisted channel unread", () => {
    for (const id of [BIZ_CHANNEL.SCENES, 1, 3, 7, 8, 9, 10, 99]) {
      expect(decodeMapFrame(bizFrame(id, frame(ZONES_BODY)), byteCodec), `${id}`).toBeUndefined();
    }
  });
});

describe("fragments", () => {
  it("skips a frame that is not the start of a message", () => {
    // A large map is split across frames and `offset` locates this one. Whatever it counts, a non-zero
    // value means this is not the start — and handing a fragment to a protobuf reader is how a decoder
    // produces a confident wrong answer.
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.RESTRICTED_ZONE, frame(ZONES_BODY), 1), byteCodec)).toBeUndefined();
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.RESTRICTED_ZONE, frame(ZONES_BODY), 4096), byteCodec)).toBeUndefined();
  });

  it("reads the same payload once its offset says it is the start", () => {
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.RESTRICTED_ZONE, frame(ZONES_BODY), 0), byteCodec)).toBeDefined();
  });
});

describe("a payload that is not what its channel promised", () => {
  it("comes back undecoded rather than half-read", () => {
    // A reader meeting a message that lacks what its own message requires answers nothing.
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.MAP_DATA, frame(ZONES_BODY)), byteCodec)).toBeUndefined();
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.ROOM_OUTLINE, frame(PARAMS_BODY)), byteCodec)).toBeUndefined();
  });
});
