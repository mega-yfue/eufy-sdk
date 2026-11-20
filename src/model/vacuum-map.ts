/**
 * The robot's map, as `stream.proto` describes it — the messages that arrive on the `biz/…/res` leg.
 *
 * Six message types carry everything about a map: its size and where it sits in
 * the world, which cell is floor and which is wall, which room each cell belongs to, what those rooms
 * are called and how they are cleaned, and where the user drew a line the robot must not cross. This
 * decodes all six. It does not draw anything: what it hands back is dimensions, coordinates, names and
 * two pixel planes.
 *
 * **Units, once, because every coordinate here shares them.** Distances are centimetres — the vendor
 * writes them as "m × 100" throughout — and `resolution` is the width of one cell in those same
 * centimetres, so a cell at `(col, row)` covers world position `origin + (col, row) × resolution`. An
 * angle is radians × 100. Nothing is converted on the way through: a value the device sent as an
 * integer stays one, because dividing it here would make every caller guess whether it had been.
 *
 * **What is deliberately not read.** `RestrictedZone.suggestion` carries zones the robot has *proposed*
 * and the user has not accepted. Merging them into the real lists would report restrictions the robot
 * is not enforcing, and reporting them as fact is worse than not reporting them at all.
 *
 * @module model/vacuum-map
 */
import type { RawDpCodec, RawDpField } from "../core/contracts.js";
import { lz4BlockDecompress } from "../core/lz4-block.js";
import { bytes, each, flag, int, signed, sub, text } from "./proto-read.js";
import { CLEAN_EXTENTS, MOP_LEVELS, VACUUM_CLEAN_TYPES } from "./capabilities/vacuum-clean.js";
import type { CleanExtent, MopLevel, VacuumCleanType } from "./capabilities/vacuum-clean.js";

// ── Geometry ──────────────────────────────────────────────────────────────────────────────────────

/** A position on the map, in centimetres from the map's own origin. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** A position with a heading. `theta` is radians × 100, as the device sends it. */
export interface MapPose extends MapPoint {
  readonly theta: number;
}

/** A virtual wall: the segment between two points that the robot will not cross. */
export interface MapLine {
  readonly from: MapPoint;
  readonly to: MapPoint;
}

/**
 * A four-cornered zone, corners in the order the device sent them.
 *
 * Not necessarily a rectangle — the vendor's type is `Quadrangle`, and the app lets a zone be rotated
 * — so the corners describe a polygon and not a bounding box.
 */
export interface MapQuad {
  readonly corners: readonly [MapPoint, MapPoint, MapPoint, MapPoint];
}

/** What a dock is: a bare charging base, or a full station with water and dust handling. */
export const DOCK_KINDS = ["charger", "station"] as const;
export type DockKind = (typeof DOCK_KINDS)[number];

/** Where a dock stands, and which kind it is. */
export interface MapDock {
  readonly kind: DockKind;
  readonly pose: MapPose;
}

/**
 * How complete the device considers this map.
 *
 * `"listFull"` is not a quality at all but a notice: the robot has nowhere left to store a new map and
 * is telling the app to replace one or discard this. It shares the field, so it is named here.
 */
export const MAP_QUALITIES = ["incomplete", "rough", "effective", "listFull"] as const;
export type MapQuality = (typeof MAP_QUALITIES)[number];

/** Size, placement and quality of a map — the vendor's `MapInfo`. */
export interface VacuumMapGeometry {
  /** Cells across and down. Both are non-zero: a plane without dimensions cannot be indexed. */
  readonly width: number;
  readonly height: number;
  /**
   * The width of one cell in centimetres, or `undefined` when the device omitted it.
   *
   * No default is invented for the absent case. The reference integration substitutes 5 without saying
   * why, and a guessed scale silently misplaces every zone and every room label on the map.
   */
  readonly resolution: number | undefined;
  /** Where cell `(0, 0)` sits, in centimetres. Signed, and routinely negative. */
  readonly origin: MapPoint;
  /** Clockwise rotation the app applies when drawing, in degrees. */
  readonly angle: number;
  readonly quality: MapQuality;
  /** Every dock the device knows about. Empty until the robot has seen one. */
  readonly docks: readonly MapDock[];
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────────

/** Whether a map frame replaces what came before it, or amends it. */
export const MAP_FRAME_KINDS = ["full", "incremental"] as const;
export type MapFrameKind = (typeof MAP_FRAME_KINDS)[number];

/**
 * What one cell of {@link VacuumMapPlane.cells} means, by its two-bit value.
 *
 * Indexed by the value itself, so `MAP_CELL_VALUES[2]` is `"free"`.
 */
export const MAP_CELL_VALUES = ["unknown", "obstacle", "free", "carpet"] as const;
export type MapCellValue = (typeof MAP_CELL_VALUES)[number];

/** A map frame — the vendor's `Map`, with its pixel plane decompressed. */
export interface VacuumMapPlane {
  /**
   * Whether this frame is the whole map or an amendment to the last one.
   *
   * **How an `"incremental"` frame is applied is not known.** Nothing states whether it replaces a
   * region, carries its own origin, or assumes the previous frame's geometry. A stale-but-correct map
   * beats one assembled by a guessed rule.
   */
  readonly frame: MapFrameKind;
  /** The device's id for this map. `undefined` when it sent none. */
  readonly mapId: number | undefined;
  /** The map's name, as the user set it. `undefined` when unnamed. */
  readonly name: string | undefined;
  /** The map's revision counter. It advances whenever the map is edited. */
  readonly releases: number;
  /** The frame's position in a sequence, as the device counts it. Zero on a lone frame. */
  readonly index: number;
  readonly geometry: VacuumMapGeometry;
  /**
   * The cell plane, decompressed: **four cells per byte, two bits each, low bits first**, in one run
   * with no row padding. The cell at `(col, row)` is at bit `(i & 3) * 2` of byte `i >> 2`, where
   * `i = row * width + col`, and its value indexes {@link MAP_CELL_VALUES}.
   *
   * Handed over packed rather than expanded. A large map is a megabyte once every cell is its own
   * byte.
   */
  readonly cells: Buffer;
}

/** Which room each cell belongs to — the vendor's `RoomOutline`, with its plane decompressed. */
export interface VacuumRoomOutline {
  readonly mapId: number | undefined;
  readonly releases: number;
  readonly width: number;
  readonly height: number;
  readonly resolution: number | undefined;
  /**
   * Where this plane's cell `(0, 0)` sits, in centimetres.
   *
   * **Its own origin, not the map's.** The two planes are not guaranteed to start at the same world
   * position, so a room lookup under a map cell must convert through world coordinates rather than
   * reusing the index.
   */
  readonly origin: MapPoint;
  /**
   * The room plane: **one byte per cell**, `row * width + col`, no padding — a different packing from
   * {@link VacuumMapPlane.cells}, which the vendor states separately for each.
   *
   * The byte is not the room id on its own. Its low two bits carry a sub-type and the id is the
   * remaining bits, so the room at a cell is `cells[i] >> 2`.
   */
  readonly cells: Buffer;
}

/** What kind of floor a room has, by the vendor's `Floor.Type`. */
export const FLOOR_TYPES = ["unknown", "carpet", "wood", "tile"] as const;
export type FloorType = (typeof FLOOR_TYPES)[number];

/** What kind of room this is, by the vendor's `RoomScene.Type`. */
export const ROOM_SCENES = [
  "unknown",
  "study",
  "bedroom",
  "bathroom",
  "kitchen",
  "livingRoom",
  "diningRoom",
  "corridor",
] as const;
export type RoomScene = (typeof ROOM_SCENES)[number];

/**
 * Suction, on the scale the vendor declares for a room's `Fan.suction`.
 *
 * **Not the `SuctionLevel` scale DP 158 uses, and the two must not be unified.** DP 158 reports suction on a six-value
 * scale where 4 is BoostIQ and 5 is Max Pro; `clean_param.proto` declares this field's enum with five
 * values ending at `MAX_PLUS = 4`. They agree from 0 to 3 and disagree at 4, so naming a room's
 * `Fan.suction` through the DP scale would report "BoostIQ" for a room the user set to Max+.
 *
 * The clean-parameter read treats DP 158 and `clean_param.fan` as one scale, which holds only from 0
 * to 3. The divergence above is declared by the vendor, so this follows the proto the field is
 * actually declared in.
 */
export const ROOM_SUCTIONS = ["quiet", "standard", "turbo", "max", "maxPlus"] as const;
export type RoomSuction = (typeof ROOM_SUCTIONS)[number];

/** The per-room clean settings, when the user has set any. */
export interface VacuumRoomSettings {
  readonly cleanType: VacuumCleanType | undefined;
  readonly suction: RoomSuction | undefined;
  readonly mopLevel: MopLevel | undefined;
  readonly cleanExtent: CleanExtent | undefined;
  /** How many passes this room gets. `undefined` for the vendor's zero, which means "not set". */
  readonly cleanTimes: number | undefined;
}

/** One room on the map. */
export interface VacuumRoom {
  /** The room's id — what the byte in {@link VacuumRoomOutline.cells} resolves to, and what a room-select frame names. */
  readonly id: number;
  /**
   * The name the user gave this room, or `undefined`.
   *
   * `undefined` is common and is not a decode failure: the vendor's own comment says an unnamed room
   * is labelled by the app from {@link VacuumRoom.scene} and {@link VacuumRoom.sceneIndex} — "Kitchen 1",
   * "Bedroom 2" — in the user's language. A host wanting the same label builds it the same way, which
   * it can only do if the absence is reported rather than papered over.
   */
  readonly name: string | undefined;
  readonly scene: RoomScene;
  /** Which room of its kind this is, counting from 1. Pairs with {@link VacuumRoom.scene} to name it. */
  readonly sceneIndex: number;
  readonly floor: FloorType;
  /** Where the room sits in the order the app lists them. */
  readonly order: number;
  /** This room's own clean settings. Only in force while {@link VacuumRoomParams.customEnabled}. */
  readonly settings: VacuumRoomSettings;
}

/** The room list for a map — the vendor's `RoomParams`. */
export interface VacuumRoomParams {
  readonly mapId: number | undefined;
  readonly releases: number;
  /**
   * Whether the per-room settings are in force.
   *
   * When `false` the device cleans every room with the global parameters and each room's
   * {@link VacuumRoom.settings} is inert. The settings are still reported, because they are what the
   * user last chose and what turning this on would restore.
   */
  readonly customEnabled: boolean;
  /** The device's "smart mode" switch, which it reports alongside the rooms. */
  readonly smartMode: boolean;
  readonly rooms: readonly VacuumRoom[];
}

/** Everywhere the user has told the robot not to go — the vendor's `RestrictedZone`. */
export interface VacuumRestrictedZones {
  readonly mapId: number | undefined;
  readonly releases: number;
  /** Lines the robot will not cross. */
  readonly virtualWalls: readonly MapLine[];
  /** Areas the robot will not enter at all. */
  readonly noGoZones: readonly MapQuad[];
  /** Areas the robot may sweep but will not mop. */
  readonly noMopZones: readonly MapQuad[];
}

/** A map's identity, without its pixels — the vendor's `MapDescription`. */
export interface VacuumMapDescription {
  readonly mapId: number | undefined;
  readonly releases: number;
  readonly name: string | undefined;
  /**
   * Why the map exists, as the device's own code. Not translated to names: the vendor ships this as a
   * bare `uint32` with no enum beside it, so any name here would be invented.
   */
  readonly createCause: number;
  /**
   * When the map was made, and when it was last used, as the device sent them.
   *
   * **The unit is not stated.** The field is a `uint64` and could be seconds or milliseconds; both are
   * used elsewhere on this line. A consumer can tell them apart by magnitude far more safely than this
   * decoder can assume one. `undefined` for the vendor's zero, which is "never".
   */
  readonly createdAt: number | undefined;
  /** See {@link VacuumMapDescription.createdAt}. */
  readonly lastUsedAt: number | undefined;
}

/**
 * A whole map in one message — the vendor's `MapBackup`, sent when a map is switched or edited.
 *
 * Every part is optional because the device sends what changed. A backup with only `description` set
 * is a rename, and reading its absent `map` as an empty one would erase a map already held.
 */
export interface VacuumMapBackup {
  readonly description: VacuumMapDescription | undefined;
  readonly map: VacuumMapPlane | undefined;
  readonly outline: VacuumRoomOutline | undefined;
  readonly rooms: VacuumRoomParams | undefined;
  readonly zones: VacuumRestrictedZones | undefined;
}

// ── Field numbers ─────────────────────────────────────────────────────────────────────────────────

const POINT = { X: 1, Y: 2, THETA: 3 } as const;
const LINE = { P0: 1, P1: 2 } as const;
const QUAD = { P0: 1, P1: 2, P2: 3, P3: 4 } as const;
const WRAPPED = { VALUE: 1 } as const;

const MAP_INFO = {
  WIDTH: 2,
  HEIGHT: 3,
  RESOLUTION: 4,
  ORIGIN: 5,
  DOCKS: 6,
  TYPE: 7,
  ANGLE: 9,
  DOCKS_V2: 10,
} as const;
const DOCK = { TYPE: 1, POSE: 2 } as const;

const MAP = { FRAME: 3, PIXELS: 4, PIXEL_SIZE: 5, INFO: 6, NAME: 7, ID: 8, RELEASES: 9, INDEX: 10 } as const;

const OUTLINE = {
  MAP_ID: 1,
  RELEASES: 2,
  WIDTH: 3,
  HEIGHT: 4,
  RESOLUTION: 5,
  ORIGIN: 6,
  PIXELS: 7,
  PIXEL_SIZE: 8,
} as const;

const ROOM_PARAMS = { CUSTOM_ENABLE: 1, ROOMS: 2, MAP_ID: 3, RELEASES: 4, SMART_MODE: 6 } as const;
const ROOM = { ID: 1, NAME: 2, FLOOR: 3, SCENE: 4, ORDER: 6, CUSTOM: 7 } as const;
const ROOM_SCENE = { TYPE: 1, INDEX: 2 } as const;
const ROOM_CUSTOM = { CLEAN_TYPE: 1, FAN: 2, MOP_MODE: 3, CLEAN_EXTENT: 4, CLEAN_TIMES: 5 } as const;

const ZONES = { VIRTUAL_WALLS: 1, FORBIDDEN: 2, BAN_MOP: 3, MAP_ID: 4, RELEASES: 5 } as const;

const DESCRIPTION = { NAME: 2, CREATE_CAUSE: 3, CREATE_TIME: 4, LAST_TIME: 5, MAP_ID: 6, RELEASES: 7 } as const;

const BACKUP = { DESC: 1, MAP: 2, ROOMS: 3, ROOM_PARAMS: 4, RESTRICTED_ZONE: 5 } as const;

const DYNAMIC = { CUR_POSE: 1 } as const;

// ── Readers ───────────────────────────────────────────────────────────────────────────────────────

type Fields = readonly RawDpField[] | undefined;

/** A map id of zero is the proto3 default, which is "the device said nothing" — never map number 0. */
function mapIdOf(fields: Fields, field: number): number | undefined {
  const id = int(fields, field);
  return id === 0 ? undefined : id;
}

/** A `Point` or the `Pose` that extends it. Absent reads as the origin, which is what proto3 omitted. */
function pointOf(codec: RawDpCodec, fields: Fields, field: number): MapPoint {
  const p = sub(codec, fields, field);
  return { x: signed(p, POINT.X), y: signed(p, POINT.Y) };
}

function poseOf(pose: Fields): MapPose {
  return { x: signed(pose, POINT.X), y: signed(pose, POINT.Y), theta: signed(pose, POINT.THETA) };
}

function lineOf(codec: RawDpCodec, line: Fields): MapLine {
  return { from: pointOf(codec, line, LINE.P0), to: pointOf(codec, line, LINE.P1) };
}

function quadOf(codec: RawDpCodec, quad: Fields): MapQuad {
  return {
    corners: [
      pointOf(codec, quad, QUAD.P0),
      pointOf(codec, quad, QUAD.P1),
      pointOf(codec, quad, QUAD.P2),
      pointOf(codec, quad, QUAD.P3),
    ],
  };
}

/**
 * Every dock, preferring the newer list.
 *
 * The vendor added `docks_v2` beside the original `docks` to carry a kind alongside each pose, and a
 * device that sends the new list sends the old one too. Reading both would report every dock twice, so
 * the newer wins outright; the older is read only when the newer is absent, and everything in it is a
 * plain charger, which is all the old field could express.
 */
function docksOf(codec: RawDpCodec, info: Fields): readonly MapDock[] {
  const v2 = each(codec, info, MAP_INFO.DOCKS_V2).map((d) => ({
    kind: DOCK_KINDS[int(d, DOCK.TYPE)] ?? "charger",
    pose: poseOf(sub(codec, d, DOCK.POSE)),
  }));
  if (v2.length > 0) return v2;
  return each(codec, info, MAP_INFO.DOCKS).map((p) => ({ kind: "charger" as const, pose: poseOf(p) }));
}

/**
 * A `MapInfo`, or `undefined` when it carries no usable dimensions.
 *
 * Width and height are the one thing a plane cannot do without: every offset into the pixel bytes is
 * computed from them, and proto3 makes "zero" and "absent" the same bytes, so a zero here means there
 * is nothing to index. Reporting geometry a caller cannot use would push that discovery downstream.
 */
function geometryOf(codec: RawDpCodec, info: Fields): VacuumMapGeometry | undefined {
  const width = int(info, MAP_INFO.WIDTH);
  const height = int(info, MAP_INFO.HEIGHT);
  if (width === 0 || height === 0) return undefined;
  const resolution = int(info, MAP_INFO.RESOLUTION);

  return {
    width,
    height,
    resolution: resolution === 0 ? undefined : resolution,
    origin: pointOf(codec, info, MAP_INFO.ORIGIN),
    angle: int(info, MAP_INFO.ANGLE),
    quality: MAP_QUALITIES[int(info, MAP_INFO.TYPE)] ?? "incomplete",
    docks: docksOf(codec, info),
  };
}

/**
 * A pixel plane, decompressed if it needs to be and checked against the dimensions that describe it.
 *
 * **Compression has no flag.** The message carries the bytes and a `pixel_size`, and the two disagreeing
 * IS the signal: a plane that compressed to nothing useful is sent verbatim with the two equal. So the
 * comparison below is the whole test, and there is nothing else to consult.
 *
 * `needed` is the smallest plane the geometry could be satisfied by. The check is `>=` and not `===`
 * on purpose: a plane longer than the grid is padding and harmless, while a plane SHORTER than the
 * grid cannot answer a lookup near its end — and would answer it anyway, out of whatever bytes
 * happened to follow. That is the failure worth a rejection.
 */
function planeOf(fields: Fields, pixels: number, size: number, needed: number): Buffer | undefined {
  const raw = bytes(fields, pixels);
  if (!raw) return undefined;
  const expected = int(fields, size);

  const plane = raw.length === expected ? raw : lz4BlockDecompress(raw, expected);
  return plane && plane.length >= needed ? plane : undefined;
}

// ── Decoders ──────────────────────────────────────────────────────────────────────────────────────

/** Read a payload to its top-level fields, or `undefined` on anything that is not one. */
function open(raw: unknown, codec: RawDpCodec | undefined): Fields {
  if (typeof raw !== "string" || !codec) return undefined;
  return codec.decode(raw);
}

/** Decode a `MapInfo` message — size, placement and docks, with no pixels attached. */
export function decodeVacuumMapGeometry(raw: unknown, codec: RawDpCodec | undefined): VacuumMapGeometry | undefined {
  const fields = open(raw, codec);
  return fields && codec ? geometryOf(codec, fields) : undefined;
}

/** Decode a `DynamicData` message — where the robot is, right now. */
export function decodeVacuumPose(raw: unknown, codec: RawDpCodec | undefined): MapPose | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;
  const pose = sub(codec, fields, DYNAMIC.CUR_POSE);
  return pose ? poseOf(pose) : undefined;
}

/**
 * Decode a `Map` message — a frame of the cell plane with the geometry that places it.
 *
 * `undefined` when the frame cannot be used rather than when it cannot be parsed: no geometry, no
 * pixels, a plane that failed to decompress, or one too short for the grid it claims. Each of those
 * yields a map that would draw, and draw wrongly.
 */
export function decodeVacuumMap(raw: unknown, codec: RawDpCodec | undefined): VacuumMapPlane | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  const geometry = geometryOf(codec, sub(codec, fields, MAP.INFO));
  if (!geometry) return undefined;

  // Four cells to the byte, and the last byte is partial when the grid does not divide by four.
  const needed = Math.ceil((geometry.width * geometry.height) / 4);
  const cells = planeOf(fields, MAP.PIXELS, MAP.PIXEL_SIZE, needed);
  if (!cells) return undefined;

  return {
    frame: MAP_FRAME_KINDS[int(fields, MAP.FRAME)] ?? "full",
    mapId: mapIdOf(fields, MAP.ID),
    name: text(fields, MAP.NAME),
    releases: int(fields, MAP.RELEASES),
    index: int(sub(codec, fields, MAP.INDEX), WRAPPED.VALUE),
    geometry,
    cells,
  };
}

/** Decode a `RoomOutline` message — one byte per cell saying which room it belongs to. */
export function decodeVacuumRoomOutline(raw: unknown, codec: RawDpCodec | undefined): VacuumRoomOutline | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  const width = int(fields, OUTLINE.WIDTH);
  const height = int(fields, OUTLINE.HEIGHT);
  if (width === 0 || height === 0) return undefined;

  const cells = planeOf(fields, OUTLINE.PIXELS, OUTLINE.PIXEL_SIZE, width * height);
  if (!cells) return undefined;

  const resolution = int(fields, OUTLINE.RESOLUTION);
  return {
    mapId: mapIdOf(fields, OUTLINE.MAP_ID),
    releases: int(fields, OUTLINE.RELEASES),
    width,
    height,
    resolution: resolution === 0 ? undefined : resolution,
    origin: pointOf(codec, fields, OUTLINE.ORIGIN),
    cells,
  };
}

/** One room's own clean settings, from its `Custom` sub-message. */
function settingsOf(codec: RawDpCodec, room: Fields): VacuumRoomSettings {
  const custom = sub(codec, room, ROOM.CUSTOM);
  // Every setting is a wrapper message holding one enum, so an absent wrapper is "not set" while a
  // present one holding nothing is the enum's zero — the one place these two can be told apart.
  const wrapped = (field: number): number | undefined => {
    const inner = sub(codec, custom, field);
    return inner === undefined ? undefined : int(inner, WRAPPED.VALUE);
  };
  const times = int(custom, ROOM_CUSTOM.CLEAN_TIMES);

  return {
    cleanType: VACUUM_CLEAN_TYPES[wrapped(ROOM_CUSTOM.CLEAN_TYPE) ?? -1],
    suction: ROOM_SUCTIONS[wrapped(ROOM_CUSTOM.FAN) ?? -1],
    mopLevel: MOP_LEVELS[wrapped(ROOM_CUSTOM.MOP_MODE) ?? -1],
    cleanExtent: CLEAN_EXTENTS[wrapped(ROOM_CUSTOM.CLEAN_EXTENT) ?? -1],
    cleanTimes: times === 0 ? undefined : times,
  };
}

/** Decode a `RoomParams` message — the room list, their names, and how each is cleaned. */
export function decodeVacuumRoomParams(raw: unknown, codec: RawDpCodec | undefined): VacuumRoomParams | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  const rooms = each(codec, fields, ROOM_PARAMS.ROOMS).map((room): VacuumRoom => {
    const scene = sub(codec, room, ROOM.SCENE);
    return {
      id: int(room, ROOM.ID),
      name: text(room, ROOM.NAME),
      scene: ROOM_SCENES[int(scene, ROOM_SCENE.TYPE)] ?? "unknown",
      sceneIndex: int(sub(codec, scene, ROOM_SCENE.INDEX), WRAPPED.VALUE),
      floor: FLOOR_TYPES[int(sub(codec, room, ROOM.FLOOR), WRAPPED.VALUE)] ?? "unknown",
      order: int(sub(codec, room, ROOM.ORDER), WRAPPED.VALUE),
      settings: settingsOf(codec, room),
    };
  });

  return {
    mapId: mapIdOf(fields, ROOM_PARAMS.MAP_ID),
    releases: int(fields, ROOM_PARAMS.RELEASES),
    customEnabled: flag(fields, ROOM_PARAMS.CUSTOM_ENABLE),
    smartMode: flag(sub(codec, fields, ROOM_PARAMS.SMART_MODE), WRAPPED.VALUE),
    rooms,
  };
}

/** Decode a `RestrictedZone` message — virtual walls, no-go zones and no-mop zones. */
export function decodeVacuumRestrictedZones(
  raw: unknown,
  codec: RawDpCodec | undefined,
): VacuumRestrictedZones | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  return {
    mapId: mapIdOf(fields, ZONES.MAP_ID),
    releases: int(fields, ZONES.RELEASES),
    virtualWalls: each(codec, fields, ZONES.VIRTUAL_WALLS).map((l) => lineOf(codec, l)),
    noGoZones: each(codec, fields, ZONES.FORBIDDEN).map((q) => quadOf(codec, q)),
    noMopZones: each(codec, fields, ZONES.BAN_MOP).map((q) => quadOf(codec, q)),
  };
}

/** Decode a `MapDescription` message — a map's identity, without its pixels. */
export function decodeVacuumMapDescription(
  raw: unknown,
  codec: RawDpCodec | undefined,
): VacuumMapDescription | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  const created = int(fields, DESCRIPTION.CREATE_TIME);
  const used = int(fields, DESCRIPTION.LAST_TIME);
  return {
    mapId: mapIdOf(fields, DESCRIPTION.MAP_ID),
    releases: int(fields, DESCRIPTION.RELEASES),
    name: text(fields, DESCRIPTION.NAME),
    createCause: int(fields, DESCRIPTION.CREATE_CAUSE),
    createdAt: created === 0 ? undefined : created,
    lastUsedAt: used === 0 ? undefined : used,
  };
}

/**
 * Decode a `MapBackup` message — the five-part snapshot sent when a map is switched or edited.
 *
 * Each part is decoded from its own bytes through the same decoder that reads it standing alone, so a
 * backup and a live frame cannot drift apart. A part the device did not send stays `undefined` rather
 * than becoming an empty one: an absent `map` in a rename is not a map with no cells.
 */
export function decodeVacuumMapBackup(raw: unknown, codec: RawDpCodec | undefined): VacuumMapBackup | undefined {
  const fields = open(raw, codec);
  if (!fields || !codec) return undefined;

  /** Re-frame one part as its own payload so the standalone decoder can read it unchanged. */
  const part = <T>(field: number, decode: (r: unknown, c: RawDpCodec) => T | undefined): T | undefined => {
    const inner = bytes(fields, field);
    return inner ? decode(reframe(inner), codec) : undefined;
  };

  return {
    description: part(BACKUP.DESC, decodeVacuumMapDescription),
    map: part(BACKUP.MAP, decodeVacuumMap),
    outline: part(BACKUP.ROOMS, decodeVacuumRoomOutline),
    rooms: part(BACKUP.ROOM_PARAMS, decodeVacuumRoomParams),
    zones: part(BACKUP.RESTRICTED_ZONE, decodeVacuumRestrictedZones),
  };
}

/**
 * Wrap a nested message's bytes back into the `varint(len) ++ body` envelope its decoder expects.
 *
 * The decoders take a payload rather than a field list because that is what every caller has — one
 * message off the wire. A `MapBackup` holds five of those as sub-messages, already unwrapped, so this
 * puts the envelope back rather than giving each decoder a second entry point that could disagree with
 * the first.
 */
function reframe(body: Buffer): string {
  const prefix: number[] = [];
  let n = body.length;
  while (n > 0x7f) {
    prefix.push((n % 0x80) + 0x80);
    n = Math.floor(n / 0x80);
  }
  prefix.push(n);
  return Buffer.concat([Buffer.from(prefix), body]).toString("base64");
}
