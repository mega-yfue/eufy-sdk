import type { RawDpCodec, RawDpField } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { asBool } from "../../core/util.js";
import { rawDp, type RawDpWriter } from "../../core/raw-dp-writer.js";
import { isAiotVacuum, isTuyaVacuum } from "../device-family.js";
import { VACUUM_DOCK_INFO_SOURCE } from "./vacuum-dock.js";
import { pickDpParams, aiotDp } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import {
  decodeUsableVacuumSceneCount,
  decodeVacuumSceneCount,
  decodeVacuumScenes,
  type VacuumScene,
} from "../vacuum-scenes.js";
import {
  decodeActiveVacuumScheduleCount,
  decodeVacuumScheduleCount,
  decodeVacuumSchedules,
  type VacuumSchedule,
} from "../vacuum-schedules.js";

/**
 * RoboVac Tuya **DP ids** this capability reads — the "clean" namespace (ids ~150-180, from the cloud
 * `get_product_data_point` schema). Named here so each DP is referenced by meaning rather than a magic
 * number, the same way the P2P capabilities name their feature-command ids (`CAMERA_CMD`, `LIGHT_CMD`).
 * Values confirmed against a live T2351 DP dump.
 */
/**
 * Which protobuf message each Raw DP carries, in each direction — the product catalogue's own
 * `下发`(downlink) / `上报`(uplink) note per data point, transcribed.
 *
 * The single most useful thing the catalogue gives that a DP number alone does not: a DP is Raw, and
 * knowing WHICH message it frames is what makes it decodable. Recorded here rather than rediscovered,
 * and deliberately as data rather than as code — nothing dispatches on it. It is the map a reader
 * needs when they reach a DP this SDK does not decode yet.
 *
 * Two entries are the vendor's own dead ends: DP 150 is marked "预留。不使用。" — reserved, NOT used —
 * and 165/175 are reserved with no message at all. Do not build on them.
 */
export const VACUUM_DP_MESSAGE: Readonly<Record<number, { readonly send?: string; readonly report?: string }>> = {
  150: {}, // `proto` — reserved, explicitly not used
  152: { send: "ModeCtrlRequest", report: "ModeCtrlResponse" },
  153: { report: "WorkStatus" },
  154: { send: "CleanParamRequest", report: "CleanParamResponse" },
  157: { send: "UndisturbedRequest", report: "UndisturbedResponse" },
  162: { send: "LanguageRequest", report: "LanguageResponse" },
  164: { send: "TimerRequest", report: "TimerResponse" },
  165: {}, // reserved
  166: { send: "DebugRequest", report: "DebugResponse" },
  167: { report: "CleanStatistics" },
  168: { send: "ConsumableRequest", report: "ConsumableRuntime" },
  169: { send: "AppInfo", report: "DeviceInfo" },
  170: { send: "MapEditRequest", report: "MapEditResponse" },
  171: { send: "MultiMapsCtrlRequest", report: "MultiMapsCtrlResponse" },
  172: { send: "MultiMapsManageRequest", report: "MultiMapsManageResponse" },
  173: { send: "StationRequest", report: "StationResponse" },
  174: { send: "MediaManagerRequest", report: "MediaManagerResponse" },
  175: {}, // reserved
  177: { send: "ErrorCode", report: "ErrorCode" }, // downlink is a MUTE list, not a fault report
  178: { send: "PromptCode", report: "PromptCode" }, // same: downlink mutes prompts
  179: { send: "AnalysisRequest", report: "AnalysisResponse" },
  180: { send: "SceneRequest", report: "SceneResponse" },
};

export const VACUUM_DP = {
  /** Power on/off (DP 151 power switch, Bool). */
  POWER: 151,
  /** WorkStatus (DP 153 work status, Raw protobuf) — carries the activity in field #2 (see {@link decodeVacuumActivity}). */
  WORK_STATUS: 153,
  /** ModeCtrlRequest (DP 152, Raw protobuf) — carries the mode-control command (start/pause/dock). */
  MODE_CTRL: 152,
  /** CleanParam (DP 154 clean params, Raw protobuf) — carries the cleaning type (see {@link decodeCleanType}). */
  CLEAN_PARAM: 154,
  /** Speaker volume 0-100 (DP 161, Value). */
  VOLUME: 161,
  /**
   * LanguageResponse (DP 162, Raw protobuf) — the VOICE PACK, not a locale (see {@link decodeLanguageField}).
   * Named for the vendor's own `language` code, which is what the catalogue calls it.
   */
  LANGUAGE: 162,
  /** Battery level 0-100 (DP 163, Value) — a clean-namespace DP, NOT the security param 1101. */
  BATTERY: 163,
  /** UndisturbedResponse (DP 157, Raw protobuf) — the do-not-disturb window (see {@link decodeDoNotDisturb}). */
  DO_NOT_DISTURB: 157,
  /** CleanStatistics (DP 167, Raw protobuf) — session and lifetime totals (see {@link decodeCleanStat}). */
  CLEAN_STATS: 167,
  /** Remote-control direction (DP 155, Enum: Brake/Forward/Back/Left/Right). Steering, not a ModeCtrl verb. */
  REMOTE_CTRL: 155,
  /** `pause_job` (DP 156, Bool) — resume an interrupted job after charging. The vendor's 断点续扫. */
  RESUME_CLEAN: 156,
  /** `timing` (DP 164, Raw) — TimerRequest/TimerResponse. THIS is where schedules live. */
  TIMING: 164,
  /** SceneResponse (DP 180, Raw protobuf) — the saved cleaning scenes, and a source of real map ids. */
  SCENES: 180,
  /** ConsumableRuntime (DP 168, Raw protobuf) — hours used per replaceable part (see {@link decodeConsumableHours}). */
  CONSUMABLES: 168,
  /** UnisettingResponse (DP 176, Raw protobuf) — the device-wide setting toggles (see {@link decodeUnisetting}). */
  SETTINGS: 176,
  /** ErrorCode (DP 177 fault alert, Raw protobuf) — the robot's faults and warnings (see {@link decodeVacuumFault}). */
  FAULT_ALERT: 177,
} as const;

/**
 * Tuya DP ids for the `eufy_home_tuya` vacuum category (X8 Pro, X-series, and future Tuya clean-line models).
 *
 * Full schema sourced from `thing.m.device.ref.info.list` v5.4 for product `wahqax6ifjgs1c4n`
 * (schemaInfo.schema, 39 DPs). Only the DPs with confirmed read-side values from a live
 * `thing.m.device.dp.get` call are included here. Write direction for all DPs is unverified —
 * no live publishDps capture has been made yet.
 *
 * **The one table for this line.** A second, older one listed four of these ids again — the same
 * numbers with the same meanings, grounded more weakly — and three entries here carried a note saying
 * which of its keys they duplicated. That is one line spelled twice, which is how two tables come to
 * disagree while each stays individually plausible. DP 103 was a third spelling: named privately by the
 * `locate` capability, absent from any DP table.
 *
 * **Checked against `jeppesens/eufy-clean`'s `LEGACY_DPS_MAP`** and nothing came back to port. Its nine
 * ids — 2, 3, 5, 15, 101, 102, 103, 104, 106 — are all here, all live-confirmed on a real X8 Pro, and
 * all carry their enum value sets, which that map does not. The comparison is recorded so the next
 * reader does not repeat it. Its `SCALAR_DPS` table is a different matter and deliberately untouched:
 * that is a separate device class reusing these numbers for unrelated things (153 is a brush-detangle
 * trigger there and the work status here), so it must be told apart by value SHAPE, never by DP number.
 * @internal
 */
export const TUYA_VACUUM_DP = {
  /** Power on/off (DP 1, Bool). */
  POWER: 1,
  /** Play/pause toggle (DP 2, Bool rw) — true = start, false = pause. */
  PLAY_PAUSE: 2,
  /** Manual direction jog (DP 3, Enum: "forward"|"back"|"left"|"right"). */
  DIRECTION: 3,
  /** Cleaning mode (DP 5, Enum: "auto"|"room"|"zone"|"spot"|"fast_mapping"). Live-confirmed "auto". */
  MODE: 5,
  /** Work status (DP 15, Enum string) — the high-level activity. Live-confirmed "Sleeping". */
  WORK_STATUS: 15,
  /** Return to dock (DP 101, Bool rw). */
  GO_HOME: 101,
  /** Suction/cleaning strength (DP 102, Enum: "Off"|"Quiet"|"Standard"|"Turbo"|"Max"). Live-confirmed "Off". */
  CLEANING_STRENGTH: 102,
  /**
   * Find-robot beep (DP 103, `look_for_sweeper`, Bool). Live-confirmed.
   *
   * Read and written by the `locate` capability, which owns the feature across both clean lines —
   * named here so this table is the one place the Tuya line's ids are spelled.
   */
  LOOK_FOR_SWEEPER: 103,
  /** Battery level 0-100 (DP 104, Value ro). */
  BATTERY_LEVEL: 104,
  /** Mop water flow (DP 105, Enum: "Dry"|"Low"|"Mid"|"High"). Live-confirmed "Mid". */
  MOP_WATER: 105,
  /** Fault code, 0 = ok (DP 106, Value ro). */
  FAULT_REPORT: 106,
  /** Do-not-disturb / forbid mode (DP 107, Bool). Live-confirmed false. */
  FORBID_MODE: 107,
  /** Session cleaning time in seconds (DP 109, Value). Live-confirmed 4200 (= 70 min). */
  CLEAR_TIME: 109,
  /** Session cleaned area in m² (DP 110, Value). Live-confirmed 54. */
  CLEAR_AREA: 110,
  /** Speaker loudness 0-100 (DP 111, Value). Live-confirmed 38. */
  LOUDNESS: 111,
  /** Configured cleaning type (DP 113, Enum: "Sweep"|"SweepMop"|"Mop"). Live-confirmed "Sweep". */
  CLEAN_TYPE: 113,
  /** Total lifetime cleaning time in seconds (DP 119, Value). */
  CLEAR_TOTAL_TIME: 119,
  /** Total lifetime cleaned area in m² (DP 120, Value). */
  CLEAR_TOTAL_AREA: 120,
  /** Water tank attached (DP 127, Bool ro). */
  WATER_TANK_STATUS: 127,
  /** Mop pad attached (DP 129, Bool ro). */
  MOP_STATUS: 129,
  /** WiFi RSSI in dBm (DP 134, Value). */
  RSSI: 134,
} as const;

/**
 * `thing.m.device.ref.info.list` v5.4 `schemaInfo.schema` confirmed values for DP 15 (status).
 *
 * Exported so a caller can offer the set as data; not published — `VacuumActivity` is the
 * union that matters externally.
 * @internal
 */
export const TUYA_WORK_STATUS_VALUES = [
  "standby",
  "Running",
  "Sleeping",
  "Recharge",
  "Charging",
  "completed",
  "Goto",
  "Locating",
  "Collecting",
  "RollAutoCleaning",
  "CC_Recharge",
  "CC_Charging",
] as const;

/**
 * Confirmed values for DP 5 (mode) from schemaInfo.schema.
 * @internal
 */
export const TUYA_WORK_MODES = ["auto", "room", "zone", "spot", "fast_mapping"] as const;
/** @internal */
export type TuyaWorkMode = (typeof TUYA_WORK_MODES)[number];

/**
 * Confirmed values for DP 102 (cleaning_strength) from schemaInfo.schema. Live-confirmed "Off".
 * @internal
 */
export const TUYA_CLEANING_STRENGTHS = ["Off", "Quiet", "Standard", "Turbo", "Max"] as const;
/** @internal */
export type TuyaCleaningStrength = (typeof TUYA_CLEANING_STRENGTHS)[number];

/**
 * Confirmed values for DP 105 (MopWater) from schemaInfo.schema. Live-confirmed "Mid".
 * @internal
 */
export const TUYA_MOP_WATER_LEVELS = ["Dry", "Low", "Mid", "High"] as const;
/** @internal */
export type TuyaMopWaterLevel = (typeof TUYA_MOP_WATER_LEVELS)[number];

/**
 * Confirmed values for DP 113 (CleanType) from schemaInfo.schema. Live-confirmed "Sweep".
 * @internal
 */
export const TUYA_CLEAN_TYPES = ["Sweep", "SweepMop", "Mop"] as const;
/** @internal */
export type TuyaCleanType = (typeof TUYA_CLEAN_TYPES)[number];

/** Field numbers inside `ModeCtrlRequest` (DP 152). Both live-verified on a T2351. */
const MODE_CTRL_FIELD = {
  /** `method` — which verb the robot is being asked to run. */
  METHOD: 1,
  /** `seq` — the request's own sequence number, echoed back in the response. */
  SEQ: 2,
} as const;

/**
 * `ModeCtrlRequest.method` values for DP 152. Live-verified on T2351: START_AUTO_CLEAN → 0
 * (omitted from the wire when zero), START_GOHOME → 6, PAUSE_TASK → 13.
 */
export const ModeCtrlMethod = {
  /** Live-verified on a T2351. Zero, so it is omitted from the wire per the proto3 default rule. */
  START_AUTO_CLEAN: 0,
  /** Live-verified on a T2351. */
  START_GOHOME: 6,
  /** Live-verified on a T2351. */
  PAUSE_TASK: 13,

  // ── Parameterless verbs from the vendor's own `ModeCtrlRequest.Method`, NOT yet captured ────────
  // Same frame as the three above — the two fields every method shares are live-proven, so the only
  // unconfirmed thing about each is its number. That is not a small thing: a wrong number is a
  // different command reaching real hardware, and an AIoT write is fire-and-forget. Every member built
  // on one of these carries `unverified`.
  START_SPOT_CLEAN: 3,
  START_RC_CLEAN: 5,
  START_FAST_MAPPING: 9,
  START_GOWASH: 10,
  STOP_TASK: 12,
  /** Live-verified on a T2351: the app's Resume sends method 14, seq continuing the shared counter. */
  RESUME_TASK: 14,
  STOP_GOHOME: 15,
  STOP_RC_CLEAN: 16,
  STOP_GOWASH: 17,
  STOP_SMART_FOLLOW: 18,
  START_GLOBAL_CRUISE: 20,
} as const;

/**
 * The methods that carry a `Param` oneof — room, zone, goto, schedule, cruise and scene cleans.
 *
 * Deliberately absent from {@link ModeCtrlMethod}. Each needs an argument the caller has to supply and
 * this SDK cannot yet answer: a room or zone id comes from map data, which is not decodable here, and a
 * coordinate is signed centimetres in a frame no capture has pinned. Listing their numbers beside the
 * parameterless ones would invite a caller to send one with an empty payload, which is a valid frame
 * meaning something nobody intended.
 */

/**
 * Encode a `ModeCtrlRequest` protobuf (DP 152) as a DP value: `varint(bodyLen) ++ {method:1, seq:2}`.
 *
 * Built on {@link RawDpWriter} rather than hand-rolled bytes. The frame is unchanged and the existing
 * byte-level test is what proves it — that test was written against a live T2351 capture, so it holds
 * the writer to the wire rather than to this function's own idea of the wire.
 *
 * Method 0 (START_AUTO_CLEAN) is omitted rather than written as an explicit zero, per the proto3
 * default-field rule and confirmed on that same capture. The writer deliberately does not apply that
 * rule for the caller: whether an explicit zero and an absent field mean the same thing is the
 * message's business, not the encoder's.
 * @internal
 */
/**
 * The area-selecting `ModeCtrlRequest` methods, and the `Param` field each one's payload rides in.
 *
 * Kept apart from {@link ModeCtrlMethod} because these are a different kind of thing: a parameterless
 * verb is complete on its own, whereas each of these is meaningless without an argument the caller has
 * to supply. Sending one with an empty payload is a well-formed frame that means something nobody
 * intended, which is exactly why the numbers do not sit beside the others where a caller might reach
 * for them by accident.
 */
export const ModeCtrlParamMethod = {
  /** `START_SELECT_ROOMS_CLEAN` — clean the named rooms of a named map. */
  SELECT_ROOMS: { method: 1, param: 4 },
  /** `START_SELECT_ZONES_CLEAN` — clean the given rectangles of a named map. */
  SELECT_ZONES: { method: 2, param: 5 },
  /** `START_GOTO_CLEAN` — drive to a point and clean around it. */
  GOTO: { method: 4, param: 7 },
  /** `START_SCENE_CLEAN` — run a saved scene by its id. */
  SCENE: { method: 24, param: 14 },
} as const;

/** Field numbers inside `SelectRoomsClean`, and inside the `Room` entries it repeats. */
const SELECT_ROOMS_FIELD = {
  /** `rooms` — repeated, one entry per room. */
  ROOMS: 1,
  /** `clean_times` — how many passes to make. */
  CLEAN_TIMES: 2,
  /** `map_id` — WHICH saved map the room ids belong to. */
  MAP_ID: 3,
  /** `id` within a `Room`. */
  ROOM_ID: 1,
  /** `order` within a `Room` — the sequence to visit them in. */
  ROOM_ORDER: 2,
} as const;

/** Field numbers inside `SelectZonesClean`, its `Zone` entries, and the `Quadrangle` each zone carries. */
const SELECT_ZONES_FIELD = {
  /** `zones` — repeated, one entry per rectangle. */
  ZONES: 1,
  /** `map_id` — which saved map the coordinates belong to. */
  MAP_ID: 2,
  /** `quadrangle` within a `Zone` — its four corners. */
  QUADRANGLE: 1,
  /** `clean_times` within a `Zone`. */
  ZONE_CLEAN_TIMES: 2,
  /** `x` within a `Point`, SIGNED centimetres. */
  POINT_X: 1,
  /** `y` within a `Point`, SIGNED centimetres. */
  POINT_Y: 2,
} as const;

/** `scene_id` within a `SceneClean`. */
const SCENE_CLEAN_ID = 1;

/** One room to clean, and where it falls in the running order. */
export interface VacuumRoomTarget {
  /** The room's id, as the device's own map data names it. */
  readonly id: number;
  /** Where this room falls in the run. Omitted rooms are visited in the order given. */
  readonly order?: number;
}

/** One rectangular zone to clean, as four corners in centimetres. */
export interface VacuumZoneTarget {
  /** The four corners, in centimetres, in the device's own map frame. Exactly four points. */
  readonly corners: readonly { readonly x: number; readonly y: number }[];
  /** How many passes to make over this zone. */
  readonly cleanTimes?: number;
}

/**
 * Build a `ModeCtrlRequest` carrying a `Param` payload — the area-selecting cleans.
 *
 * Shares the outer frame with every other mode-control verb: `method`(1), `seq`(2), and the payload in
 * whichever `Param` field the method names.
 *
 * **Coordinates are `sint32` and go through ZigZag.** Map coordinates are signed centimetres and
 * negative ones are ordinary — the origin sits wherever the robot first mapped from. Written as a plain
 * varint, −1 becomes 18446744073709551615, and the robot drives somewhere real and wrong. That is the
 * single sharpest edge in this whole file, which is why the writer keeps `sint` as its own call rather
 * than inferring it.
 * @internal
 */
function encodeModeCtrlParam(method: number, paramField: number, build: (w: RawDpWriter) => void): string {
  return rawDp((w) => {
    if (method !== 0) w.int(MODE_CTRL_FIELD.METHOD, method);
    w.int(MODE_CTRL_FIELD.SEQ, nextModeCtrlSeq());
    w.sub(paramField, build);
  });
}

/**
 * Build a room-select clean for a named map.
 *
 * `mapId` is required and has no default, deliberately. The obvious shortcut is to assume the map a
 * single-floor home would have; on a two-floor home that silently sends the robot's ids against the
 * wrong floor's map. A caller that cannot name the map cannot safely make this call, and saying so is
 * better than picking for them.
 * @internal
 */
export function encodeSelectRoomsClean(mapId: number, rooms: readonly VacuumRoomTarget[], cleanTimes = 1): string {
  const { method, param } = ModeCtrlParamMethod.SELECT_ROOMS;
  return encodeModeCtrlParam(method, param, (p) => {
    for (const room of rooms) {
      p.sub(SELECT_ROOMS_FIELD.ROOMS, (r) => {
        r.int(SELECT_ROOMS_FIELD.ROOM_ID, room.id);
        if (room.order !== undefined) r.int(SELECT_ROOMS_FIELD.ROOM_ORDER, room.order);
      });
    }
    p.int(SELECT_ROOMS_FIELD.CLEAN_TIMES, cleanTimes);
    p.int(SELECT_ROOMS_FIELD.MAP_ID, mapId);
  });
}

/**
 * Build a zone-select clean for a named map. Same `mapId` reasoning as {@link encodeSelectRoomsClean}.
 * @internal
 */
export function encodeSelectZonesClean(mapId: number, zones: readonly VacuumZoneTarget[]): string {
  const { method, param } = ModeCtrlParamMethod.SELECT_ZONES;
  return encodeModeCtrlParam(method, param, (p) => {
    for (const zone of zones) {
      p.sub(SELECT_ZONES_FIELD.ZONES, (z) => {
        z.sub(SELECT_ZONES_FIELD.QUADRANGLE, (q) => {
          for (const [i, corner] of zone.corners.entries()) {
            // p0..p3 are consecutive fields, each a Point of two signed centimetre values.
            q.sub(i + 1, (pt) => {
              pt.sint(SELECT_ZONES_FIELD.POINT_X, corner.x);
              pt.sint(SELECT_ZONES_FIELD.POINT_Y, corner.y);
            });
          }
        });
        if (zone.cleanTimes !== undefined) z.int(SELECT_ZONES_FIELD.ZONE_CLEAN_TIMES, zone.cleanTimes);
      });
    }
    p.int(SELECT_ZONES_FIELD.MAP_ID, mapId);
  });
}

/** Build a scene clean, which needs only the scene's own id. @internal */
export function encodeSceneClean(sceneId: number): string {
  const { method, param } = ModeCtrlParamMethod.SCENE;
  return encodeModeCtrlParam(method, param, (p) => p.int(SCENE_CLEAN_ID, sceneId));
}

/**
 * The next `ModeCtrlRequest.seq` — ONE counter for every verb on DP 152.
 *
 * Confirmed against a live T2351: the app's start, pause, resume and go-home sent seq 124, 125, 126
 * and 127 — a single sequence advancing across four different verbs, not a counter per verb. That is
 * what `seq` is for, since it identifies a request so its response can be matched to it; per-verb
 * counters would hand two outstanding requests the same number.
 *
 * Each verb used to keep its own `let seq = 111` inside its closure. They now share this.
 */
let modeCtrlSeq = 111;
function nextModeCtrlSeq(): number {
  return ++modeCtrlSeq;
}

export function encodeModeCtrl(method: number, seq: number): string {
  return rawDp((w) => {
    if (method !== 0) w.int(MODE_CTRL_FIELD.METHOD, method);
    w.int(MODE_CTRL_FIELD.SEQ, seq);
  });
}

/**
 * Every value {@link VacuumActivity} can take, as data — the read's declared domain, so the schema a
 * caller reads and the type it compiles against are the same list rather than two that can drift.
 *
 * Exported so a caller can offer the set as data; not published — `VacuumActivity` is the union a
 * reader of the reference needs, and it states the same members.
 * @internal
 */
export const VACUUM_ACTIVITIES = ["idle", "error", "docked", "cleaning", "returning", "paused", "unknown"] as const;

/**
 * The robot's high-level activity — what `dev.vacuumClean()?.activity` reports. `"unknown"` covers a
 * status the SDK can't classify yet. `"cleaning"` is the widest member: it also covers mapping,
 * cruising and manual remote driving, which the wire distinguishes and this union does not.
 */
export type VacuumActivity = (typeof VACUUM_ACTIVITIES)[number];

/**
 * DP 15 wire string → {@link VacuumActivity} for the X8 Pro.
 *
 * Values from schemaInfo.schema (`thing.m.device.ref.info.list` v5.4, product `wahqax6ifjgs1c4n`).
 * Live-confirmed "Sleeping" at rest. The sSchema.statusSchemaList confirms six of these:
 * Sleeping→sleep, Running→cleaning, Recharge→goto_charge, Charging→charging, completed→charge_done,
 * standby→standby. The remaining six (Goto / Locating / Collecting / RollAutoCleaning / CC_Recharge /
 * CC_Charging) are schema-confirmed but not yet live-observed — mapped best-effort.
 */
const X8_STATUS_TO_ACTIVITY: Record<string, VacuumActivity> = {
  Sleeping: "idle", // ✅ live X8 Pro; sSchema: sleep
  standby: "idle", // ✅ sSchema: standby
  Running: "cleaning", // ✅ sSchema: cleaning
  Recharge: "returning", // ✅ sSchema: goto_charge
  Charging: "docked", // ✅ sSchema: charging
  completed: "docked", // ✅ sSchema: charge_done
  Goto: "returning", // ⚠️ schema-only
  Locating: "cleaning", // ⚠️ schema-only
  Collecting: "cleaning", // ⚠️ schema-only
  RollAutoCleaning: "cleaning", // ⚠️ schema-only
  CC_Recharge: "returning", // ⚠️ schema-only
  CC_Charging: "docked", // ⚠️ schema-only
};

/**
 * Decode a DP 15 string to a {@link VacuumActivity} for the X8 Pro. Returns `"unknown"` for any
 * value absent from the confirmed schema set, so every valid raw string from the device yields
 * a typed result rather than `undefined`.
 * @internal
 */
export function decodeTuyaWorkStatus(raw: ParamValue | undefined): VacuumActivity {
  if (typeof raw !== "string") return "unknown";
  return X8_STATUS_TO_ACTIVITY[raw] ?? "unknown";
}

/**
 * `WorkStatus.state` (protobuf field #2) → {@link VacuumActivity}.
 *
 * Three values are **live-verified** on a T2351 — a start→return→charge run reported `5`(cleaning) →
 * `7`(returning) → `3`(docked), matching the physical actions. The rest come from the vendor's own
 * `WorkStatus.State` enumeration, which those three corroborate exactly: it declares `CHARGING = 3`,
 * `CLEANING = 5` and `GO_HOME = 7` at the same positions the device reported them.
 *
 * The vendor's remaining names are narrower than this union can express, so several collapse onto
 * `"cleaning"` — the closest true answer for a robot that is off the dock and driving:
 * `FAST_MAPPING`(4) is mapping a floor, `REMOTE_CTRL`(6) is being driven by hand, `CRUISIING`(8) is
 * patrolling. A caller that needs to tell those apart cannot use this read to do it.
 *
 * The enumeration ends at `8`. An earlier revision carried a `15 → "paused"` entry, which no device
 * can report — pause is a **sub-state** of `5`, resolved by {@link resolveCleaningState} rather than by
 * a state of its own.
 */
const WORK_STATE_ACTIVITY: Record<number, VacuumActivity> = {
  0: "idle", // STANDBY — also every paused-* state; the sub-state carries which
  1: "idle", // SLEEP
  2: "error", // FAULT
  3: "docked", // CHARGING ✅ live T2351
  4: "cleaning", // FAST_MAPPING — driving, no narrower member
  5: "cleaning", // CLEANING ✅ live T2351 — refined by resolveCleaningState
  6: "cleaning", // REMOTE_CTRL — driving, no narrower member
  7: "returning", // GO_HOME ✅ live T2351
  8: "cleaning", // CRUISIING — driving, no narrower member
};

/** The one {@link WORK_STATE_ACTIVITY} entry that is not final on its own — see {@link resolveCleaningState}. */
const WORK_STATE_CLEANING = 5;

/**
 * Field numbers inside `WorkStatus` that refine state `5`, and inside the sub-messages they carry.
 *
 * Each sub-message follows the vendor's stated rule: **an absent message means that sub-state is
 * idle**, so presence is the signal and the fields inside it only narrow further.
 */
const WORK_STATUS_FIELD = {
  /** `state` — the one field read for every other state. */
  STATE: 2,
  /** `cleaning` — carries `state`(1) `DOING`/`PAUSED`. */
  CLEANING: 6,
  /** `go_wash` — carries `mode`(2) `NAVIGATION`/`WASHING`/`DRYING`. */
  GO_WASH: 7,
  /** `station` — carries `washing_drying_system`(3) while the dock runs a mop cycle. */
  STATION: 14,
  /** `charging` — present while the robot is on contacts, carrying `state`(1). */
  CHARGING: 3,
  /** `trigger` — what caused the CURRENT state, carrying `source`(1). */
  TRIGGER: 20,
} as const;

/**
 * `WorkStatus.Charging.state` — whether a charge is running, finished, or faulted.
 *
 * `DOING` is the enum's zero and so is absent from the wire, which is why the CONTAINER's presence is
 * the signal that the robot is on contacts at all: an absent `charging` message means it is not
 * charging, and a present-but-empty one means it is charging normally.
 */
export const CHARGE_STATES = ["charging", "charged", "fault"] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

/**
 * `WorkStatus.Trigger.Source` — who or what caused the state the robot is now in.
 *
 * Worth surfacing rather than inferring: an automation that reacts to "returning to dock" behaves
 * differently when the robot did it because a schedule fired, because someone pressed the button on
 * its lid, or because it ran low on battery. `"unknown"` is the vendor's own zero and is what a robot
 * reports just after boot, so it is a real answer rather than a decode failure.
 */
export const TRIGGER_SOURCES = ["unknown", "app", "button", "schedule", "robot", "remote"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/**
 * Decode the charge state out of a `WorkStatus` (DP 153).
 *
 * `undefined` means the robot is NOT charging — the vendor omits the whole message rather than sending
 * a "not charging" value, so absence is the answer and not a gap. A present message with no `state`
 * reads as `"charging"`, the enum's zero.
 * @internal
 */
export function decodeChargeState(raw: ParamValue | undefined, codec: RawDpCodec | undefined): ChargeState | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const charging = codec.decode(raw)?.find((f) => f.field === WORK_STATUS_FIELD.CHARGING);
  if (charging?.kind !== "bytes") return undefined;
  return CHARGE_STATES[subValue(codec, charging.value, SUB_STATE_FIELD)];
}

/**
 * Decode what triggered the current state out of a `WorkStatus` (DP 153).
 * @internal
 */
export function decodeTriggerSource(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): TriggerSource | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const trigger = codec.decode(raw)?.find((f) => f.field === WORK_STATUS_FIELD.TRIGGER);
  if (trigger?.kind !== "bytes") return undefined;
  return TRIGGER_SOURCES[subValue(codec, trigger.value, SUB_STATE_FIELD)];
}

/** `Cleaning.state` — the run state of a cleaning job. `DOING` is the proto3 default, so it is absent on the wire. */
const CLEANING_STATE_PAUSED = 1;

/** `GoWash.mode` values that mean the robot is parked ON the dock rather than driving toward it. */
const GO_WASH_ON_DOCK = new Set([1, 2]);

/** `Station.washing_drying_system` — present while the dock is washing or drying mops. */
const STATION_WASHING_DRYING = 3;

/** `mode`'s field number inside `GoWash` — which leg of the wash cycle the robot is in. */
const SUB_MODE_FIELD = 2;

/** `state`'s field number inside `Cleaning` — whether the job is running or paused. */
const SUB_STATE_FIELD = 1;

/**
 * Read one `uint32`-valued field out of a nested sub-message, or `0` when it is absent.
 *
 * Absent is not missing data: proto3 omits a zero-valued field, so an empty sub-message states the
 * enum's zero member — `DOING` for a run state, `NAVIGATION` for a wash mode — and reading it as `0`
 * is what the encoding means.
 */
function subValue(codec: RawDpCodec, body: Buffer, field: number): number {
  const found = codec.nested(body)?.find((f) => f.field === field);
  return found?.kind === "int" ? Number(found.value) : 0;
}

/**
 * Refine `WorkStatus.state == 5` into the activity the robot is actually in.
 *
 * State `5` is not one state. The vendor's own enumeration lists it as covering positioning, global
 * and area cleaning, spot cleaning **and** returning-to-wash / washing mops — and the sub-messages
 * beside it are what separate those. Without this, a paused robot and one parked on its dock running a
 * wash cycle both read as `"cleaning"`, which is the single most visible wrong answer this capability
 * can give.
 *
 * Resolution order matters, and follows the device's own precedence: being **on** the dock beats being
 * paused, because a robot that paused itself to go wash reports both. `go_wash` with a driving mode
 * (`NAVIGATION`) is deliberately NOT docked — it is still en route.
 *
 * Falls through to `"cleaning"` whenever no sub-message claims it, so a frame this does not recognise
 * degrades to the previous behaviour rather than to a worse one.
 *
 * **The station branch is the softest read here, and the one to confirm on-device first.** It takes the
 * PRESENCE of `washing_drying_system` as washing-or-drying and does not read its value, where `go_wash`
 * above reads the actual mode. That follows the schema's own "an absent message is IDLE" rule, and it
 * degrades into the `"cleaning"` fallback rather than into a wrong dock state — but unlike the go_wash
 * and paused branches it is not corroborated by a capture, so a live report of a robot washing at its
 * dock is what would settle whether presence alone is enough.
 */
function resolveCleaningState(fields: readonly RawDpField[], codec: RawDpCodec): VacuumActivity {
  const sub = (field: number): Buffer | undefined => {
    const found = fields.find((f) => f.field === field);
    return found?.kind === "bytes" ? found.value : undefined;
  };

  const goWash = sub(WORK_STATUS_FIELD.GO_WASH);
  if (goWash && GO_WASH_ON_DOCK.has(subValue(codec, goWash, SUB_MODE_FIELD))) return "docked";

  const station = sub(WORK_STATUS_FIELD.STATION);
  if (station && codec.nested(station)?.some((f) => f.field === STATION_WASHING_DRYING)) return "docked";

  const cleaning = sub(WORK_STATUS_FIELD.CLEANING);
  if (cleaning && !goWash && subValue(codec, cleaning, SUB_STATE_FIELD) === CLEANING_STATE_PAUSED) return "paused";

  return "cleaning";
}

/**
 * Every value {@link VacuumCleanType} can take — the read's declared domain, see `VACUUM_ACTIVITIES`.
 *
 * Exported so a caller can offer the set as data; not published, like `VACUUM_ACTIVITIES`.
 * @internal
 */
export const VACUUM_CLEAN_TYPES = ["sweep", "mop", "sweepAndMop", "sweepThenMop"] as const;

/**
 * What the robot is **set** to do with a surface — `dev.vacuumClean()?.cleanType`. This is the setting,
 * not what a job in progress is doing; the two disagree while a change is being applied.
 *
 * `mop` and `sweepAndMop` are verified on a real robot. `sweepThenMop` comes from the vendor's own
 * enumeration and has not been observed on a device yet. `"sweep"` also covers **"no type stated"** —
 * a robot that states none is indistinguishable from one set to sweep-only, so a host that needs to
 * tell those apart cannot use this read to do it.
 */
export type VacuumCleanType = (typeof VACUUM_CLEAN_TYPES)[number];

/** `CleanType.value` → {@link VacuumCleanType}, per the vendor's `CleanType.Value` enum. */
const CLEAN_TYPE: Record<number, VacuumCleanType> = {
  0: "sweep",
  1: "mop", // ✅ live T2351
  2: "sweepAndMop", // ✅ live T2351
  3: "sweepThenMop", // ⚠️ unverified — vendor enum, not yet observed
};

/**
 * Field numbers inside `CleanParamResponse` and its nested `CleanParam`.
 *
 * A T2351 sends all four top-level containers on every report, present-but-empty when they carry
 * nothing — so container presence proves nothing and only the fields INSIDE it do. `CONFIGURED` is the
 * device's setting; `RUNNING` is what the job in progress is actually doing, and the two disagree
 * mid-change. This reads the setting, which is what the app's own screen shows.
 */
const CLEAN_PARAM_FIELD = {
  /** `clean_param` — the configured parameters. */
  CONFIGURED: 1,
  /** `clean_type` within a `CleanParam`. */
  CLEAN_TYPE: 1,
  /** `clean_carpet` — what to do when the robot meets a carpet. */
  CLEAN_CARPET: 2,
  /** `clean_extent` — how far past the mapped edge to go. */
  CLEAN_EXTENT: 3,
  /** `mop_mode` — carries TWO bare scalars: level(1) and corner_clean(2). */
  MOP_MODE: 4,
  /** `level` within a `mop_mode`. */
  MOP_LEVEL: 1,
  /** `corner_clean` within a `mop_mode` — the extra edge pass. */
  MOP_CORNER: 2,
  /** `smart_mode_sw` — the robot's own judgement about a room, on or off. */
  SMART_MODE: 5,
  /**
   * `fan` — the suction level, and the SAME scale DP 158 reports.
   *
   * Deliberately not surfaced as its own read. A live capture showed the two moving together: DP 158
   * went 2 then 0 while `clean_param.fan` went `{value:2}` then absent-for-zero. `suction.level`
   * already publishes that value from DP 158, and a second name for it here would be one feature
   * spelled twice. Named so a reader knows what field 6 is, not so anything reads it.
   */
  FAN: 6,
  /** `clean_times` — how many passes one job makes. */
  CLEAN_TIMES: 7,
  /** `value` within a `CleanType`. */
  VALUE: 1,
} as const;

/**
 * `mop_mode.level` — how much water the mop lays down.
 *
 * Confirmed on a live T2351: setting the app's water level to High reported `mop_mode { level: 2 }`.
 */
export const MOP_LEVELS = ["low", "middle", "high"] as const;
export type MopLevel = (typeof MOP_LEVELS)[number];
const MOP_LEVEL: Record<number, MopLevel> = { 0: "low", 1: "middle", 2: "high" };

/** `clean_carpet.strategy` — what the robot does when it meets a carpet. */
export const CARPET_STRATEGIES = ["autoRaise", "avoid", "ignore"] as const;
export type CarpetStrategy = (typeof CARPET_STRATEGIES)[number];
const CARPET_STRATEGY: Record<number, CarpetStrategy> = { 0: "autoRaise", 1: "avoid", 2: "ignore" };

/**
 * `clean_extent.value` — how far past the mapped edge a job reaches.
 *
 * **Not the app's display order.** The app lists these differently, so a host that renders the index
 * rather than the name will disagree with the phone; the names here follow the wire, which is the only
 * order this SDK can vouch for.
 */
export const CLEAN_EXTENTS = ["normal", "narrow", "quick"] as const;
export type CleanExtent = (typeof CLEAN_EXTENTS)[number];
const CLEAN_EXTENT: Record<number, CleanExtent> = { 0: "normal", 1: "narrow", 2: "quick" };

/**
 * Read one setting out of the CONFIGURED `CleanParam` (DP 154), by its field number.
 *
 * The generalisation of {@link decodeCleanType}, and it reads the same container for the same reason:
 * a report taken mid-change carries a different value in `clean_param`(1) and `running_clean_param`(4),
 * and the SETTING is the stable answer.
 *
 * **How the inner value is found, and why it is not a second field number.** The vendor wraps each
 * setting in its own single-field message — `CleanType{value}`, `CleanCarpet{strategy}`,
 * `CleanExtent{value}` — where the wrapper's name and its field's name differ per setting but the
 * shape does not. Rather than assert a number for each inner field, this takes the FIRST varint the
 * wrapper carries. The 1→1→1 nesting is live-proven for `clean_type`; taking the first scalar is what
 * extends that to its siblings without claiming a number for any of them.
 *
 * The cost is stated rather than hidden: a wrapper that ever carries more than one scalar would read
 * its first, so this is only used for the settings documented as single-valued. `mop_mode`(4) carries
 * both a level and a corner-clean flag and is deliberately NOT read here for that reason.
 *
 * A present-but-empty wrapper answers `0` — proto3 omits a zero, so the enum's zero member and "the
 * wrapper said nothing" are the same bytes. An absent wrapper is `undefined`: the device did not state
 * this setting at all.
 * @internal
 */
export function decodeCleanParamValue(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
  inner?: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const configured = codec.decode(raw)?.find((f) => f.field === CLEAN_PARAM_FIELD.CONFIGURED);
  if (configured?.kind !== "bytes" || !configured.value.length) return undefined;
  const setting = codec.nested(configured.value)?.find((f) => f.field === field);
  if (setting === undefined) return undefined;
  if (setting.kind === "int") return Number(setting.value);
  if (!setting.value.length) return 0;
  const fields = codec.nested(setting.value);
  // A NAMED inner field when the caller knows it, the first varint otherwise. `mop_mode` is why the
  // distinction exists: it carries two scalars side by side — level(1) and corner_clean(2) — so
  // "whatever comes first" would silently read the level as the corner setting.
  const value = inner === undefined ? fields?.find((f) => f.kind === "int") : fields?.find((f) => f.field === inner);
  if (value === undefined) return 0;
  return value.kind === "int" ? Number(value.value) : undefined;
}

/**
 * Decode the cleaning type out of a `CleanParam` (DP 154) Raw-DP value.
 *
 * Reads the CONFIGURED container, not the running one: a report mid-change carries a different type in
 * each, and the setting is the stable answer. Every level is presence-checked rather than defaulted —
 * the vendor wraps each enum in its own single-field message precisely so that a wrapper's presence
 * says "this was stated", and an absent wrapper yields `undefined` rather than a fabricated `"sweep"`.
 *
 * **Known ambiguity, unresolvable on the wire.** The protocol omits zero-valued fields, so an empty
 * `CleanType{}` and an explicit `SWEEP_ONLY` are the same bytes. Both read as `"sweep"`. A robot that
 * states no type therefore looks like a sweeping robot, and nothing in the payload can distinguish
 * them — resolving it needs a capture of one device with a known-non-sweep setting at rest.
 * @internal
 */
export function decodeCleanType(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): VacuumCleanType | TuyaCleanType | undefined {
  if (typeof raw !== "string") return undefined;
  // Tuya X8 DP 113 is a plain string enum — detect by value set membership (no overlap with AIoT).
  if ((TUYA_CLEAN_TYPES as readonly string[]).includes(raw)) return raw as TuyaCleanType;
  if (!codec) return undefined;
  const configured = codec.decode(raw)?.find((f) => f.field === CLEAN_PARAM_FIELD.CONFIGURED);
  if (configured?.kind !== "bytes" || !configured.value.length) return undefined;
  const cleanType = codec.nested(configured.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.CLEAN_TYPE);
  if (cleanType?.kind !== "bytes") return undefined;
  if (!cleanType.value.length) return CLEAN_TYPE[0];
  const value = codec.nested(cleanType.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.VALUE);
  if (!value) return CLEAN_TYPE[0];
  return value.kind === "int" ? CLEAN_TYPE[Number(value.value)] : undefined;
}

/**
 * Field numbers inside the `ErrorCode` message (DP 177).
 *
 * Both lists are `repeated uint32`, which proto3 encodes PACKED by default — one length-delimited run
 * of varints rather than one field per value. {@link firstRepeatedCode} reads either form, because a
 * sender is free to emit the unpacked one and a reader that assumed packing would silently see nothing.
 */
const ERROR_CODE_FIELD = {
  /** `error` — faults that stop the robot. */
  ERROR: 2,
  /** `warn` — conditions the robot reports while continuing. */
  WARN: 3,
} as const;

/** No fault: the message decoded and listed neither an error nor a warning. */
const NO_FAULT = 0;

/**
 * Read the first value of a `repeated uint32`, accepting both encodings.
 *
 * Packed arrives as one length-delimited run of varints, unpacked as a plain varint field repeated —
 * so the first match wins in either case. Returns `undefined` when the field is absent or the packed
 * run is empty, which the caller reads as "this list said nothing" rather than as a zero code.
 *
 * **Assumes a code below 2³¹.** The accumulate uses JavaScript's `<<`, which is a 32-bit signed
 * operation, so a wider varint would wrap. Every documented range is four digits — 1-119 robot,
 * 1010-5112 component, 6010-6311 station, 7000-7055 situational — so this holds today and is stated
 * rather than assumed silently, in case the vendor's table ever grows a wider code.
 */
function firstRepeatedCode(fields: readonly RawDpField[], field: number): number | undefined {
  const found = fields.find((f) => f.field === field);
  if (found === undefined) return undefined;
  if (found.kind === "int") return Number(found.value);

  let value = 0;
  let shift = 0;
  for (const byte of found.value) {
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  return undefined;
}

/**
 * Decode the robot's current fault code from either clean line.
 *
 * The two lines carry the same meaning on different wires, so this discriminates on the value's SHAPE
 * the way {@link decodeCleanType} does: the legacy Tuya line reports DP 106 as a plain integer, the
 * AIoT line reports DP 177 as an `ErrorCode` protobuf.
 *
 * `error` is preferred over `warn`: a fault that stops the robot is the more urgent answer when both
 * are listed. Only the FIRST code of the winning list is answered — the property is one number, and a
 * caller needing the whole set needs a shape this schema cannot express (see the module's members).
 *
 * `0` means the device stated no fault. `undefined` means it did not state one at all — an unbound
 * device, or a payload that does not decode — and the two are deliberately different.
 * @internal
 */
export function decodeVacuumFault(raw: ParamValue | undefined, codec: RawDpCodec | undefined): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields) return undefined;
  return (
    firstRepeatedCode(fields, ERROR_CODE_FIELD.ERROR) ?? firstRepeatedCode(fields, ERROR_CODE_FIELD.WARN) ?? NO_FAULT
  );
}

/**
 * Field numbers inside `UndisturbedResponse` (DP 157) and the messages it nests.
 *
 * `ACTIVE` is deliberately NOT read: it reports whether the window is open right now, which is a
 * different question from whether the feature is switched on, and the latter is what the property means.
 */
const UNDISTURBED_FIELD = {
  /** `active` — the live in-window flag, beside the configured window rather than inside it. */
  ACTIVE: 1,
  /** `undisturbed` — the configured window. */
  UNDISTURBED: 2,
  /** `sw` within an `Undisturbed` — the enable switch. */
  SWITCH: 1,
  /** `value` within a `Switch`. */
  VALUE: 1,
  /** `begin` within an `Undisturbed` — when quiet hours start. */
  BEGIN: 2,
  /** `end` within an `Undisturbed` — when they stop. */
  END: 3,
  /** `hour` within a `TimePoint`. */
  HOUR: 1,
  /** `minute` within a `TimePoint`. */
  MINUTE: 2,
} as const;

/**
 * Decode one end of the do-not-disturb window as `"HH:MM"`, or `undefined`.
 *
 * One string rather than two numbers per end: four properties for one window is four things a host has
 * to reassemble, and the pieces are meaningless apart. `undefined` means no window is configured at
 * all — distinct from `"00:00"`, which is midnight and a real setting.
 *
 * The times are the ROBOT's own clock, with no zone attached. The vendor sends none here, unlike a
 * schedule, which carries the phone's UTC offset per timer.
 * @internal
 */
export function decodeDoNotDisturbTime(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): string | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const window = codec.decode(raw)?.find((f) => f.field === UNDISTURBED_FIELD.UNDISTURBED);
  if (window?.kind !== "bytes") return undefined;
  const point = codec.nested(window.value)?.find((f) => f.field === field);
  if (point?.kind !== "bytes") return undefined;
  const parts = codec.nested(point.value);
  if (!parts) return undefined;
  const at = (n: number): number => {
    const hit = parts.find((f) => f.field === n);
    return hit?.kind === "int" ? Number(hit.value) : 0;
  };
  return `${String(at(UNDISTURBED_FIELD.HOUR)).padStart(2, "0")}:${String(at(UNDISTURBED_FIELD.MINUTE)).padStart(2, "0")}`;
}

/**
 * Decode the do-not-disturb switch from either clean line.
 *
 * Discriminates on the value's SHAPE, as {@link decodeCleanType} and {@link decodeVacuumFault} do: the
 * Tuya line reports DP 107 as a plain bool, the AIoT line reports DP 157 as an `UndisturbedResponse`.
 *
 * A present-but-empty `Switch` reads as `false` rather than as missing — proto3 omits a zero-valued
 * field, so "switched off" and "said nothing about the switch" are the same bytes once the container
 * around them is there. An absent CONTAINER is still `undefined`: that is the device not answering.
 * @internal
 */
export function decodeDoNotDisturb(raw: ParamValue | undefined, codec: RawDpCodec | undefined): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw === "0" || raw === "1") return raw === "1";
  if (!codec) return undefined;

  const window = codec.decode(raw)?.find((f) => f.field === UNDISTURBED_FIELD.UNDISTURBED);
  if (window?.kind !== "bytes") return undefined;
  const sw = codec.nested(window.value)?.find((f) => f.field === UNDISTURBED_FIELD.SWITCH);
  if (sw === undefined) return false;
  if (sw.kind !== "bytes") return undefined;
  const value = codec.nested(sw.value)?.find((f) => f.field === UNDISTURBED_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Decode the live in-window flag from an `UndisturbedResponse` (DP 157).
 *
 * The companion to {@link decodeDoNotDisturb}, which reports whether the feature is switched ON. This
 * one reports whether the quiet window is open RIGHT NOW — two different questions the same DP answers,
 * which is why this member reads its sibling's payload instead of claiming a wire of its own.
 *
 * **`active` is `Switch`-wrapped** — confirmed on a live T2351, which inside its quiet window reports
 * `active { value: 1 }` beside `undisturbed { sw { value: 1 }, begin { hour: 9 }, end { hour: 23 } }`.
 * The bare-varint branch is kept regardless: it costs one comparison, and a reader that accepts both
 * cannot be broken by a firmware that changes its mind.
 *
 * The AIoT line only. On the Tuya line DP 107 is a plain bool carrying the SWITCH, and no wire there
 * states the window — so a non-protobuf value answers `undefined` rather than borrowing the switch.
 *
 * An absent `active` beside a present `undisturbed` reads as `false`: proto3 omits a zero, so "the
 * window is not open" and "said nothing about it" are the same bytes once the message is recognisable.
 * An absent `undisturbed` is `undefined` — the payload is not one of these at all.
 * @internal
 */
export function decodeDoNotDisturbActive(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): boolean | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields?.some((f) => f.field === UNDISTURBED_FIELD.UNDISTURBED)) return undefined;
  const active = fields.find((f) => f.field === UNDISTURBED_FIELD.ACTIVE);
  if (active === undefined) return false;
  if (active.kind === "int") return active.value !== 0n;
  const value = codec.nested(active.value)?.find((f) => f.field === UNDISTURBED_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Field numbers inside `CleanStatistics` (DP 167) — three accumulators, one shape.
 *
 * `single` is the run in progress. Two lifetime accumulators sit beside it: `total`(2), which survives
 * a factory reset, and `user_total`(3), which does not. The USER total is the one read here, because it
 * is the figure the app shows and the one a user recognises — a lifetime that resets when they reset the
 * robot. `total`(2) is left unread rather than unknown.
 *
 * All three carry their fields at the same inner numbers, which is the trap: reading the right field of
 * the wrong container silently reports a lifetime figure as the current run.
 */
const CLEAN_STATS_FIELD = {
  /** `single` — statistics for the current run. */
  SINGLE: 1,
  /** `user_total` — the lifetime accumulator that a factory reset clears. */
  USER_TOTAL: 3,
  /** `clean_duration` within any of them, in seconds. */
  DURATION: 1,
  /** `clean_area` within any of them, in m². */
  AREA: 2,
  /** `clean_count` — completed runs. Only `user_total` carries it. */
  COUNT: 3,
} as const;

/**
 * Read one figure out of a `CleanStatistics` (DP 167), or take a plain number as it stands.
 *
 * Both clean lines answer through this. The legacy Tuya line puts each figure on its own DP as a bare
 * integer; the AIoT line buries all of them in one message. The value's SHAPE says which arrived — the
 * same discrimination {@link decodeCleanType} and {@link decodeVacuumFault} use to span the two lines on
 * one property, and the reason these figures need only one name each rather than one per platform.
 *
 * A present-but-empty container reads as `0`: a robot that has just started a run has cleaned no area,
 * and proto3 omits the zero. An absent container is `undefined` — this device does not report it.
 *
 * **The plain-number passthrough belongs to a member that owns its own Tuya DP**, where that DP carries
 * exactly the figure being asked for. A member with no wire of its own must not use it: its owner may
 * have been installed by a read ALIAS, and it would then be handed another figure entirely — the Tuya
 * DP 109 session duration reported as a lifetime run count. Such a member screens the value first; see
 * `lifetimeCleanCount`.
 * @internal
 */
export function decodeCleanStat(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  container: number,
  field: number,
): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!codec) return undefined;

  const group = codec.decode(raw)?.find((f) => f.field === container);
  if (group?.kind !== "bytes") return undefined;
  const value = codec.nested(group.value)?.find((f) => f.field === field);
  if (value === undefined) return 0;
  return value.kind === "int" ? Number(value.value) : undefined;
}

/**
 * Field numbers inside `UnisettingResponse` (DP 176).
 *
 * The message carries fifteen toggles; only the child lock is read, because the property schema allows
 * one property per data point. **Its REQUEST counterpart numbers the same settings differently** — only
 * `children_lock` sits at 1 in both — so a reader and a writer of this DP can never share a table.
 */
const UNISETTING_FIELD = {
  /** `children_lock` — the one field that shares a number with the request. */
  CHILDREN_LOCK: 1,
  /** `cruise_continue_sw` — resume a cruise after charging. */
  CRUISE_CONTINUE: 2,
  /** `multi_map_sw` — keep more than one saved map. */
  MULTI_MAP: 3,
  /** `ai_see` — the obstacle camera. */
  AI_SEE: 4,
  /** `water_level_sw` — request 5, response 5 differ in the REQUEST; this is the response number. */
  WATER_LEVEL: 5,
  /** `suggest_restricted` — offer restricted-area suggestions. */
  SUGGEST_RESTRICTED: 6,
  /** `deep_mop_corner_sw` — extra corner passes while mopping. */
  DEEP_MOP_CORNER: 7,
  /** `dust_full_remind` — warn when the dust bag is full. */
  DUST_FULL_REMIND: 8,
  /** `live_photo_sw` — capture stills while cleaning. */
  LIVE_PHOTO: 9,
  /** `smart_follow_sw` — the response numbers this 13, the request 12. */
  SMART_FOLLOW: 13,
  /** `poop_avoidance_sw` — steer around pet mess rather than through it. */
  POOP_AVOIDANCE: 14,
  /** `pet_mode_sw` — the pet-owner profile. */
  PET_MODE: 15,
  /**
   * `ap_signal_strength` — a BARE `uint32` at the top level, 0-100, not a `Switch` wrapper.
   *
   * The one field of this message that is not a sub-message, which is why it needs its own reader.
   */
  AP_SIGNAL: 11,
  /** `unistate` — a sub-message of device state, not toggles. Its own fields are numbered below. */
  UNISTATE: 10,
  /** `value` within a `Switch`. */
  VALUE: 1,
} as const;

/**
 * Decode one `Switch`-wrapped toggle out of a `UnisettingResponse` (DP 176).
 *
 * Every toggle in this message is the same two-level shape — a single-field `Switch` wrapper whose
 * `value` is the bool — so one reader serves all of them and each member only names its field number.
 *
 * **Response numbers only.** The REQUEST counterpart numbers the same settings differently and only
 * `children_lock` sits at 1 in both, so {@link UNISETTING_FIELD} is a read-side table and a writer of
 * this DP must never borrow it. That is the trap this whole message carries; see the constant's doc.
 *
 * A present-but-empty `Switch` reads as `false`: proto3 omits a zero, so "off" and "said nothing about
 * this toggle" are the same bytes once the wrapper is there. An absent wrapper is `undefined` — the
 * device did not report the setting at all.
 * @internal
 */
export function decodeUnisetting(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): boolean | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const toggle = codec.decode(raw)?.find((f) => f.field === field);
  if (toggle?.kind !== "bytes") return undefined;
  const value = codec.nested(toggle.value)?.find((f) => f.field === UNISETTING_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Field numbers inside `DeviceInfo` (DP 169) — the ROBOT's half of it.
 *
 * The dock's firmware sits at field 11 of this same message and belongs to `vacuum_dock`, which owns
 * the id; these are the fields beside it. Reported once when the robot comes online, and again when its
 * IP or the account using it changes — so a value here can be stale in the way any cached fact is, and
 * absent entirely on a robot that has not reconnected since binding.
 *
 * **`last_user_id` (8) and `video_sn` (2) are deliberately unread.** The first is an account id and the
 * second a serial the caller already has by another name; neither is a value to hand out for the sake
 * of completeness. Same reasoning as `TimerInfo.Addition` in the schedules read.
 */
const ROBOT_INFO_FIELD = {
  PRODUCT_NAME: 1,
  DEVICE_MAC: 3,
  SOFTWARE: 4,
  HARDWARE: 5,
  WIFI_NAME: 6,
  WIFI_IP: 7,
} as const;

/**
 * Read one top-level `string` field out of a `DeviceInfo` (DP 169).
 *
 * An absent or empty field answers `undefined`: proto3 omits an empty string, so "this robot did not
 * say" and "it said nothing" are the same bytes, and an empty SSID is not a network name.
 * @internal
 */
export function decodeRobotInfoText(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): string | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const hit = codec.decode(raw)?.find((f) => f.field === field);
  return hit?.kind === "bytes" && hit.value.length > 0 ? hit.value.toString("utf-8") : undefined;
}

/**
 * Read the robot's hardware revision out of a `DeviceInfo` (DP 169) — a plain integer, unlike every
 * other field of this message.
 * @internal
 */
export function decodeRobotHardware(raw: ParamValue | undefined, codec: RawDpCodec | undefined): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields) return undefined;
  const hit = fields.find((f) => f.field === ROBOT_INFO_FIELD.HARDWARE);
  if (hit === undefined) return 0;
  return hit.kind === "int" ? Number(hit.value) : undefined;
}

/**
 * Field numbers inside `LanguageResponse` (DP 162).
 *
 * The DP the plan's §2 called out: it is a voice-pack descriptor, not a locale. Nothing here is a
 * language tag — `current_id` names one of the vendor's numbered voice packs, and what that pack
 * SOUNDS like is a table the vendor ships and this SDK does not have.
 */
const LANGUAGE_FIELD = { DEFAULT_ID: 1, CURRENT_ID: 2, VERSION: 3, SET_ID: 4, STATE: 5 } as const;

/** `LanguageResponse.State` — where a voice-pack download has got to. */
export const VOICE_PACK_STATES = ["idle", "updating", "success", "failure"] as const;
export type VoicePackState = (typeof VOICE_PACK_STATES)[number];

/**
 * Read one varint field out of a `LanguageResponse` (DP 162).
 *
 * A flat message, so one level rather than the two the consumables and settings reports need. A field
 * absent from a payload that DID parse reads as `0`, the proto3 default — for `current_id` that is the
 * vendor's own way of saying the robot is on the pack it shipped with. An unparseable payload is
 * `undefined`: the device said nothing this can be read from.
 * @internal
 */
export function decodeLanguageField(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields) return undefined;
  const hit = fields.find((f) => f.field === field);
  if (hit === undefined) return 0;
  return hit.kind === "int" ? Number(hit.value) : undefined;
}

/**
 * Read a `Numerical`-wrapped value out of a `UnisettingResponse` (DP 176) as the NUMBER it is.
 *
 * `Numerical { uint32 value = 1 }` and `Switch { bool value = 1 }` are the same two bytes on the wire.
 * That is why `dust_full_remind` read as a boolean for as long as it did: {@link decodeUnisetting}
 * accepted it without complaint and reported "30 minutes" as `true`. Nothing errored, nothing looked
 * wrong, and the number was gone.
 *
 * A present-but-empty wrapper reads as `0`, which for a duration means the feature is off.
 * @internal
 */
export function decodeUnisettingNumber(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const wrapped = codec.decode(raw)?.find((f) => f.field === field);
  if (wrapped?.kind !== "bytes") return undefined;
  const value = codec.nested(wrapped.value)?.find((f) => f.field === UNISETTING_FIELD.VALUE);
  if (value === undefined) return 0;
  return value.kind === "int" ? Number(value.value) : undefined;
}

/**
 * Field numbers inside `UnisettingResponse.unistate`(10) — device STATE, where the rest of the message
 * is user toggles.
 *
 * **Three fields of this sub-message are deliberately not read.** `mop_holder_state_l`(1),
 * `mop_holder_state_r`(2) and `mop_state`(5) each carry a bool the vendor annotates
 * "已安装或已取出" — *installed or removed* — without saying which boolean is which. The decompile has
 * the fields (`mopHolderStateL`, `mopHolderStateR` on the UI model) but only as data, with no branch
 * that would settle it. A bool whose polarity is a coin flip is the most guess-shaped thing this SDK
 * could publish: getting it backwards tells a user their mop is fitted while it sits on the bench. One
 * capture settles all three — pop a pad off and watch the bit — so they wait for that rather than for
 * a better guess. `custom_clean_mode`(3) is the same shape and the same problem.
 */
const UNISTATE_FIELD = {
  /** `map_valid` — an `Active`, and unambiguous: the device holds at least one map with room outlines. */
  MAP_VALID: 4,
  /** `live_map` — a wrapper whose `state_bits`(1) says which layers the live map has. */
  LIVE_MAP: 6,
  /** `clean_strategy_version` — a bare `uint32`. */
  CLEAN_STRATEGY_VERSION: 7,
  /** `state_bits` within a `LiveMap`. */
  STATE_BITS: 1,
} as const;

/**
 * Which layers the robot's live map carries, by bit position — the vendor's `LiveMap.StateBit`.
 *
 * A bitmask rather than an enum: the vendor's own comment says the values combine, so a map with a
 * base layer and room outlines reports both bits at once. Published so a caller can name a bit rather
 * than hard-coding a shift.
 */
export const LIVE_MAP_BITS = { base: 0, rooms: 1, kitchen: 2, pet: 3 } as const;

/**
 * Read a `Switch`- or `Active`-wrapped bool out of `UnisettingResponse.unistate` (DP 176).
 *
 * Two levels down rather than one: the toggles sit at the top of the message and these sit inside
 * `unistate`, so the ordinary toggle reader finds nothing here.
 * @internal
 */
export function decodeUnistateFlag(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): boolean | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const state = codec.decode(raw)?.find((f) => f.field === UNISETTING_FIELD.UNISTATE);
  if (state?.kind !== "bytes") return undefined;
  const wrapped = codec.nested(state.value)?.find((f) => f.field === field);
  if (wrapped?.kind !== "bytes") return undefined;
  const value = codec.nested(wrapped.value)?.find((f) => f.field === UNISETTING_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Read a bare `uint32` out of `UnisettingResponse.unistate` (DP 176), or one nested a further level
 * inside a wrapper there — `live_map.state_bits` is the only field that needs the second step.
 * @internal
 */
export function decodeUnistateNumber(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
  inner?: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const state = codec.decode(raw)?.find((f) => f.field === UNISETTING_FIELD.UNISTATE);
  if (state?.kind !== "bytes") return undefined;
  const fields = codec.nested(state.value);
  if (!fields) return undefined;
  const hit = fields.find((f) => f.field === field);
  if (inner === undefined) {
    if (hit === undefined) return 0;
    return hit.kind === "int" ? Number(hit.value) : undefined;
  }
  if (hit?.kind !== "bytes") return undefined;
  const nested = codec.nested(hit.value)?.find((f) => f.field === inner);
  if (nested === undefined) return 0;
  return nested.kind === "int" ? Number(nested.value) : undefined;
}

/**
 * Read a BARE `uint32` off the top level of a `UnisettingResponse` (DP 176).
 *
 * `ap_signal_strength` is the one field of this message that is not wrapped in anything, so neither of
 * the two readers above reaches it: both step into a sub-message that is not there.
 * @internal
 */
export function decodeUnisettingTopLevel(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields) return undefined;
  const hit = fields.find((f) => f.field === field);
  if (hit === undefined) return 0;
  return hit.kind === "int" ? Number(hit.value) : undefined;
}

/**
 * Field numbers inside `ConsumableRuntime` (DP 168) — one per replaceable part.
 *
 * **8 and 9 are deliberately unused by the vendor.** Do not renumber around the gap: the parts after it
 * really do sit at 10 and 11, and closing the hole would silently read the wrong counter.
 *
 * Each part is a `Duration { uint32 duration = 1 }` carrying HOURS USED, counting up. The vendor does
 * not send a percentage remaining and this does not invent one — a life expectancy per part is a
 * calibration, not something the device reports, so a host that wants a percentage owns that choice.
 */
const CONSUMABLE_FIELD = {
  /**
   * The `ConsumableRuntime` block, which the report WRAPS at field 1 rather than sending bare.
   *
   * Confirmed against a live T2351 report. Reading the parts at the top level — as this decode first
   * did — finds the wrapper where a part should be and answers `undefined` for every counter.
   */
  RUNTIME: 1,
  SIDE_BRUSH: 1,
  ROLLING_BRUSH: 2,
  FILTER_MESH: 3,
  SCRAPE: 4,
  SENSOR: 5,
  MOP: 6,
  DUSTBAG: 7,
  DIRTY_WATERTANK: 10,
  DIRTY_WATERFILTER: 11,
  /** `duration` within a `Duration`, in hours. */
  DURATION: 1,
} as const;

/**
 * `ConsumableRequest.Type` — which part a reset clears, in the vendor's REQUEST numbering.
 *
 * **These are not the response's field numbers and must never be swapped for them.** The report puts
 * the side brush at field 1 and the dirty-water tank at 10; the request enumerates from ZERO with no
 * gap, so the side brush is 0 and the dirty-water tank is 7. Nine parts, two numbering schemes, one
 * message pair — the same trap `UNISETTING_FIELD` carries, and the reason a reader's table is never a
 * writer's.
 */
/** The replaceable parts a caller can ask the robot to treat as new. */
export const CONSUMABLE_PARTS = [
  "sideBrush",
  "rollingBrush",
  "filter",
  "scraper",
  "sensors",
  "mop",
  "dustBag",
  "dirtyWaterTank",
  "dirtyWaterFilter",
] as const;
export type ConsumablePart = (typeof CONSUMABLE_PARTS)[number];

/** Part name to the vendor's `ConsumableRequest.Type`, in one table so no index arithmetic can drift. */
export const CONSUMABLE_RESET_TYPE: Readonly<Record<ConsumablePart, number>> = {
  sideBrush: 0,
  rollingBrush: 1,
  filter: 2,
  scraper: 3,
  sensors: 4,
  mop: 5,
  dustBag: 6,
  dirtyWaterTank: 7,
  dirtyWaterFilter: 8,
};

/** `reset_types` — the repeated field naming which parts to clear. */
const CONSUMABLE_RESET_FIELD = 1;

/**
 * Build a `ConsumableRequest` (DP 168) clearing the hours on one part.
 *
 * `reset_types` is REPEATED, so the wire shape allows clearing several at once. Only one is offered:
 * a caller replacing two parts can send two frames, and a single-part call is the one that cannot be
 * half-right — an accidental multi-reset silently discards service history the device never
 * recomputes.
 *
 * **Unverified.** The message and its enum are the vendor's own, and the app has the feature
 * (`resetAccessory(deviceId, accessory, callback)` → `resetAccessories`, taking exactly this kind of
 * integer part id), but no capture has shown the frame accepted — so no setter is installed.
 * @internal
 */
export function encodeConsumableReset(part: ConsumablePart): string {
  return rawDp((w) => w.int(CONSUMABLE_RESET_FIELD, CONSUMABLE_RESET_TYPE[part]));
}

/**
 * Decode one part's hours-used out of a `ConsumableRuntime` (DP 168).
 *
 * Same two-level shape for every part, so one reader serves all nine and each member names its field.
 *
 * A present-but-empty `Duration` reads as `0`, not as missing: a part fitted and never run has no hours
 * on it, and proto3 omits the zero. An absent `Duration` is `undefined` — this robot does not track
 * that part, which is a real answer for a model that does not have one.
 * @internal
 */
export function decodeConsumableHours(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  // The parts sit one level DOWN, inside the report's field 1 — not at the top level, which an
  // earlier revision assumed and which made every counter answer `undefined` on a real robot.
  const runtime = codec.decode(raw)?.find((f) => f.field === CONSUMABLE_FIELD.RUNTIME);
  if (runtime?.kind !== "bytes") return undefined;
  const part = codec.nested(runtime.value)?.find((f) => f.field === field);
  if (part?.kind !== "bytes") return undefined;
  const duration = codec.nested(part.value)?.find((f) => f.field === CONSUMABLE_FIELD.DURATION);
  if (duration === undefined) return 0;
  return duration.kind === "int" ? Number(duration.value) : undefined;
}

/**
 * Decode a `WorkStatus` (DP 153) Raw-DP value to a {@link VacuumActivity}. That DP carries a whole
 * protobuf message rather than a scalar, so the payload is read through the injected {@link RawDpCodec}:
 * the codec owns the structure, this owns which field number carries which meaning. `"unknown"` covers
 * every way the answer can be absent — an unbound device (no codec), a malformed payload, no
 * `state` field, or a state value missing from {@link WORK_STATE_ACTIVITY}.
 *
 * `CLEANING` is the one state that is not final on its own; {@link resolveCleaningState} reads the
 * sub-messages beside it to separate cleaning from paused and from a mop cycle on the dock.
 * @internal
 */
export function decodeVacuumActivity(raw: ParamValue | undefined, codec: RawDpCodec | undefined): VacuumActivity {
  if (typeof raw !== "string" || !codec) return "unknown";
  const fields = codec.decode(raw);
  const state = fields?.find((f) => f.field === WORK_STATUS_FIELD.STATE);
  if (!fields || state?.kind !== "int") return "unknown";
  const activity = WORK_STATE_ACTIVITY[Number(state.value)];
  if (activity === undefined) return "unknown";
  return activity === "cleaning" && Number(state.value) === WORK_STATE_CLEANING
    ? resolveCleaningState(fields, codec)
    : activity;
}

/**
 * Bound RoboVac reads and controls — the object returned by `dev.vacuumClean()`.
 *
 * All reads, `setPower`, and the three mode-control verbs are DERIVED from `VACUUM_CLEAN_MEMBERS`.
 * Each getter is present only when the device reports the backing DP. `setPower` and the three
 * mode-control verbs are AIoT-only: no Tuya clean-line write has been confirmed on a device, so none
 * is dispatched.
 *
 * Tuya clean-line read members (`lifetimeCleanTime`, `lifetimeCleanArea`, `waterTank`, `mopPad`)
 * are populated only once the device has reported those DPs over MQTT or the initial Tuya DP poll.
 */
export type VacuumCleanActions = Surface<typeof VACUUM_CLEAN_MEMBERS>;

/**
 * Every `vacuum_clean` read plus the writes and mode-control verbs.
 *
 * Every write here is AIoT-only, gated on `isAiotVacuum`: `power` (DP 151) and the three mode-control
 * verbs (`startCleaning`, `returnToDock`, `pauseCleaning`, all DP 152 `ModeCtrlRequest`). DP 151 and
 * DP 152 belong to the shared AIoT product schema rather than to a device's reported param set, so
 * gating them on a reported DP would hide them on real hardware. No legacy Tuya clean-line write is
 * dispatched at all — that direction has no live `publishDps` capture behind it.
 *
 * Each AIoT mode-control verb carries its own `seq` counter per bind (the T2351 accepts per-closure
 * counters — two separately-obtained action objects both starting at 112 do not cause the device to
 * complain, so the seq is not enforced as globally monotonic).
 *
 * DP-gated READS: `doNotDisturb` (DP 107, Bool ro) and `rssi` (DP 134, WiFi signal strength) are
 * installed only when the device has reported those DPs. The `locate` action (DP 160) is owned by the
 * `locate` capability module.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const VACUUM_CLEAN_MEMBERS = {
  /**
   * The robot's power switch, and NOT a way to start a job — `startCleaning` is that.
   * DP 151 belongs to the shared AIoT product DP schema every clean-line device speaks, so the write
   * is gated on the confirmed AIoT platform (category-based via `isAiotVacuum`) rather than on a
   * reported DP — no equivalent power DP is confirmed on the legacy Tuya clean line.
   */
  power: {
    param: VACUUM_DP.POWER,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Power on/off (DP 151 power switch, cloud get_product_data_point).",
    write: (v, _ctx) => aiotDp(VACUUM_DP.POWER, asBool(v)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /** Stored as the raw structured payload; the activity is decoded out of it at read time. */
  activity: {
    param: VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description:
      "High-level activity from WorkStatus (DP 153 work status, Raw protobuf). Reads the state field, " +
      "then the sub-messages that separate cleaning from paused and from a mop cycle on the dock.",
  },
  /**
   * The robot's own speaker loudness — its spoken prompts and chimes, nothing to do with suction noise.
   * Confirmed writable via `get_product_data_point` (`writable: true`); no live publishDps capture yet.
   * Reaches the getters only via `decodeState`, since the robot's cloud record carries no DPs at all.
   */
  volume: {
    param: VACUUM_DP.VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker volume 0-100 (DP 161, Value ro). AIoT clean line.",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * Charge percentage — DP 163 for the AIoT clean line; DP 104 for the legacy Tuya (G-series/X8)
   * via a `readAliases` entry gated on {@link isTuyaVacuum}. Deliberately NOT the security param 1101
   * the `battery` capability reads, so a robot's charge is here rather than on `dev.battery()`.
   * Read-only, populated only once a realtime report lands.
   */
  battery: {
    param: VACUUM_DP.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.BATTERY_LEVEL, available: isTuyaVacuum }],
    description: "Battery level 0-100 (DP 163 AIoT / DP 104 Tuya). NOTE: clean namespace — not param 1101.",
  },
  /**
   * Which voice pack the robot is speaking — the vendor's own numbered id, not a locale.
   *
   * Replaces a `language` read that answered a locale code. It never could: DP 162 carries a
   * `LanguageResponse`, so what that property published was the base64 of a protobuf message typed as
   * text. The plan's §2 called this out from the schema and the product catalogue confirmed it — the DP
   * is Raw in both directions.
   *
   * The id alone is what the device reports; which voice it corresponds to is a vendor table keyed by
   * firmware, and this SDK does not carry one. A host that wants names owns that mapping — which is
   * also why there is no setter here: selecting a pack means sending a `LanguageRequest.Desc` carrying
   * a CDN url and an md5 the device verifies, and a descriptor is not something a caller can be asked
   * to invent.
   */
  voicePack: {
    param: VACUUM_DP.LANGUAGE,
    type: "number",
    kind: "identifier",
    provenance: "mega",
    decode: (raw, codec) => decodeLanguageField(raw as ParamValue | undefined, codec, LANGUAGE_FIELD.CURRENT_ID),
    decodedKind: "identifier",
    description: "The voice pack in use — LanguageResponse.current_id (DP 162, Raw protobuf). AIoT clean line.",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * The voice pack the robot fell back to, which is the one its firmware shipped with. Differs from
   * {@link VACUUM_CLEAN_MEMBERS.voicePack} exactly when someone has chosen another.
   */
  defaultVoicePack: {
    readsFrom: "voicePack",
    type: "number",
    kind: "identifier",
    provenance: "mega",
    decode: (raw, codec) => decodeLanguageField(raw as ParamValue | undefined, codec, LANGUAGE_FIELD.DEFAULT_ID),
    decodedKind: "identifier",
    description: "The firmware's own voice pack — LanguageResponse.default_id (DP 162, Raw protobuf).",
  },
  /**
   * How a voice-pack change is going. A pack is downloaded from a CDN and md5-checked by the device, so
   * a selection is not instant and can fail — this is the field that says which happened.
   */
  voicePackState: {
    readsFrom: "voicePack",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeLanguageField(raw as ParamValue | undefined, codec, LANGUAGE_FIELD.STATE);
      return v === undefined ? undefined : VOICE_PACK_STATES[v];
    },
    decodedKind: "enum",
    decodedValues: VOICE_PACK_STATES as readonly string[],
    description: "Voice-pack download state — LanguageResponse.state (DP 162, Raw protobuf).",
  },
  /**
   * The installed voice pack's version, as the device counts it. Useful only against the vendor's own
   * catalogue for the same pack id; on its own it is a number that changes when a pack is updated.
   */
  voicePackVersion: {
    readsFrom: "voicePack",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeLanguageField(raw as ParamValue | undefined, codec, LANGUAGE_FIELD.VERSION),
    decodedKind: "scalar",
    description: "Installed voice-pack version — LanguageResponse.version (DP 162, Raw protobuf).",
  },
  /**
   * The SETTING for what to do with a surface, not what a running job is doing — the two disagree while
   * a change is being applied. Stored as the raw structured payload (`type: "string"`), with the field
   * lifted out by `decode`: the injected codec turns the DP into a field tree and this capability names
   * which field means what, which is why the transport never has to know DP 154. The decode's own
   * return type wins on the surface, so the getter answers the named `VacuumCleanType` union.
   * For Tuya devices, DP 113 (Enum: "Sweep"|"SweepMop"|"Mop") is read via a `readAliases` entry.
   */
  cleanType: {
    param: VACUUM_DP.CLEAN_PARAM,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeCleanType(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: [...VACUUM_CLEAN_TYPES, ...TUYA_CLEAN_TYPES] as readonly string[],
    readAliases: [{ paramType: TUYA_VACUUM_DP.CLEAN_TYPE, available: isTuyaVacuum }],
    description: "Configured cleaning type from CleanParam.clean_type (DP 154 AIoT protobuf) or DP 113 Tuya Enum.",
  },
  /**
   * What the robot does when it meets a carpet — raise the mop, drive around, or carry on over it.
   *
   * Reads its sibling's DP 154 payload: `clean_carpet` sits beside `clean_type` in the one `CleanParam`
   * the device reports, so there is one param and several readings of it.
   */
  carpetStrategy: {
    readsFrom: "cleanType",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_CARPET);
      return v === undefined ? undefined : CARPET_STRATEGY[v];
    },
    decodedKind: "enum",
    decodedValues: CARPET_STRATEGIES as readonly string[],
    description: "Carpet strategy from CleanParam.clean_carpet (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * How far past the mapped edge a job reaches.
   *
   * The index order is the WIRE's, not the app's display order — a host that shows the raw number will
   * disagree with the phone. Surface the name.
   */
  cleanExtent: {
    readsFrom: "cleanType",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_EXTENT);
      return v === undefined ? undefined : CLEAN_EXTENT[v];
    },
    decodedKind: "enum",
    decodedValues: CLEAN_EXTENTS as readonly string[],
    description: "Clean extent from CleanParam.clean_extent (DP 154 AIoT, Raw protobuf). Wire order, not app order.",
  },
  /**
   * Whether the robot is left to its own judgement about a room — suction and water chosen per surface
   * rather than held at what the user set.
   */
  smartMode: {
    readsFrom: "cleanType",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.SMART_MODE);
      return v === undefined ? undefined : v !== 0;
    },
    decodedKind: "boolean",
    description: "Smart mode from CleanParam.smart_mode_sw (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * How much water the mop lays down — the AIoT line's own scale.
   *
   * Distinct from `mopWater`, which is the Tuya line's DP 105 and reports `Dry`/`Low`/`Mid`/`High`.
   * The two are NOT merged under one name: this scale has three members and that one has four, so any
   * mapping between them would be invented rather than read. A host that wants one field checks
   * whichever its device reports.
   */
  mopLevel: {
    readsFrom: "cleanType",
    type: "string",
    provenance: "verified",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(
        raw as ParamValue | undefined,
        codec,
        CLEAN_PARAM_FIELD.MOP_MODE,
        CLEAN_PARAM_FIELD.MOP_LEVEL,
      );
      return v === undefined ? undefined : MOP_LEVEL[v];
    },
    decodedKind: "enum",
    decodedValues: MOP_LEVELS as readonly string[],
    description: "Mop water level from CleanParam.mop_mode.level (DP 154 AIoT). Captured on a live T2351.",
  },
  /**
   * Whether the robot makes an extra pass along edges while mopping — the app calls it edge-hug
   * mopping. Sits beside {@link VACUUM_CLEAN_MEMBERS.mopLevel} in the same `mop_mode`, which is why
   * this read names its inner field rather than taking the first scalar it finds.
   */
  mopCornerClean: {
    readsFrom: "cleanType",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(
        raw as ParamValue | undefined,
        codec,
        CLEAN_PARAM_FIELD.MOP_MODE,
        CLEAN_PARAM_FIELD.MOP_CORNER,
      );
      return v === undefined ? undefined : v !== 0;
    },
    decodedKind: "boolean",
    description: "Edge-hug mopping from CleanParam.mop_mode.corner_clean (DP 154 AIoT). Captured on a live T2351.",
  },
  /**
   * How many passes one job makes over the same floor. `0` is the device stating no repeat rather than
   * a robot that will not clean.
   */
  cleanTimes: {
    readsFrom: "cleanType",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_TIMES),
    decodedKind: "scalar",
    description: "Passes per job from CleanParam.clean_times (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * The robot's current fault, as a numeric code. `0` is no fault; `undefined` is a device that has not
   * said, which is not the same thing.
   *
   * One number for both clean lines: the AIoT line reports an `ErrorCode` message on DP 177 carrying a
   * list of faults and a list of warnings, and the legacy Tuya line reports a plain integer on DP 106.
   * {@link decodeVacuumFault} answers the first fault, or the first warning when there is no fault.
   *
   * The code's MEANING is the vendor's own table and is not interpreted here — a host that wants text
   * maps the number itself.
   *
   * The DP 106 alias is DELIBERATELY ungated, unlike `battery` and `cleanType` which gate their
   * legacy aliases on `isTuyaVacuum`. A fault is the one reading worth surfacing even when the
   * family classification is wrong or absent, and {@link decodeVacuumFault} discriminates on the
   * value's SHAPE rather than on the family — so a device carrying DP 106 decodes sanely whichever
   * line it turns out to be on. The asymmetry is the point, not an oversight.
   */
  errorCode: {
    param: VACUUM_DP.FAULT_ALERT,
    type: "number",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.FAULT_REPORT }],
    decode: (raw, codec) => decodeVacuumFault(raw as ParamValue | undefined, codec),
    decodedKind: "scalar",
    description:
      "Current fault code, 0 = none. ErrorCode.error[0] (DP 177 faultAlert, Raw protobuf) falling " +
      "back to ErrorCode.warn[0], or the plain DP 106 integer on the legacy Tuya clean line.",
  },
  /**
   * High-level activity for the X8 Pro Tuya clean line (DP 15, Enum string). Decoded from the device's
   * `status` string to a {@link VacuumActivity} via `decodeTuyaWorkStatus`. Live-confirmed "Sleeping"
   * at rest. `"unknown"` covers any value absent from the schema-confirmed set.
   *
   * Distinct from {@link activity} (DP 153, protobuf), which the AIoT T2351 reports instead.
   */
  workStatus: {
    param: TUYA_VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw) => decodeTuyaWorkStatus(raw as ParamValue | undefined),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description: "High-level activity from DP 15 (status, Enum). X8 Pro Tuya clean line. Live-confirmed Sleeping.",
  },
  /**
   * Cleaning mode (DP 5, Enum string). Live-confirmed "auto". Distinct from the AIoT suction/mode
   * controls. Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_WORK_MODES`.
   */
  workMode: {
    param: TUYA_VACUUM_DP.MODE,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaWorkMode | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_WORK_MODES as readonly string[]).includes(s) ? (s as TuyaWorkMode) : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_WORK_MODES,
    description: "Cleaning mode from DP 5 (mode, Enum). X8 Pro Tuya clean line. Live-confirmed auto. Write unverified.",
  },
  /**
   * Suction / cleaning strength (DP 102, Enum string). Live-confirmed "Off" at rest.
   * Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_CLEANING_STRENGTHS`.
   */
  cleaningStrength: {
    param: TUYA_VACUUM_DP.CLEANING_STRENGTH,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaCleaningStrength | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_CLEANING_STRENGTHS as readonly string[]).includes(s)
        ? (s as TuyaCleaningStrength)
        : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_CLEANING_STRENGTHS,
    description:
      "Suction/cleaning strength from DP 102 (cleaning_strength, Enum). X8 Pro Tuya clean line. Live-confirmed Off. Write unverified.",
  },
  /**
   * Mop water flow level (DP 105, Enum string). Live-confirmed "Mid" at rest.
   * Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_MOP_WATER_LEVELS`.
   */
  mopWater: {
    param: TUYA_VACUUM_DP.MOP_WATER,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaMopWaterLevel | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_MOP_WATER_LEVELS as readonly string[]).includes(s)
        ? (s as TuyaMopWaterLevel)
        : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_MOP_WATER_LEVELS,
    description:
      "Mop water flow level from DP 105 (MopWater, Enum). X8 Pro Tuya clean line. Live-confirmed Mid. Write unverified.",
  },
  /**
   * Session cleaning duration in seconds (DP 109, Value). Live-confirmed 4200 (= 70 min) at rest.
   * Read-only — no write is expected for a session counter.
   */
  clearTime: {
    param: VACUUM_DP.CLEAN_STATS,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.CLEAR_TIME, available: isTuyaVacuum }],
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.SINGLE, CLEAN_STATS_FIELD.DURATION),
    decodedKind: "seconds",
    description:
      "Session cleaning duration in seconds — CleanStatistics.single.clean_duration (DP 167 AIoT, Raw " +
      "protobuf) or the plain DP 109 integer on the Tuya clean line.",
  },
  /**
   * Session cleaned area in m² (DP 110, Value). Live-confirmed 54 at rest. Read-only.
   */
  clearArea: {
    param: TUYA_VACUUM_DP.CLEAR_AREA,
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.SINGLE, CLEAN_STATS_FIELD.AREA),
    decodedKind: "scalar",
    description:
      "Session cleaned area in m² — the plain DP 110 integer on the Tuya clean line, or " +
      "CleanStatistics.single.clean_area (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * Speaker loudness 0-100 (DP 111, Value). Live-confirmed 38.
   * Distinct from {@link volume} (DP 161), which the AIoT T2351 reports.
   */
  loudness: {
    param: TUYA_VACUUM_DP.LOUDNESS,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker loudness 0-100 from DP 111 (Loudness). X8 Pro Tuya clean line. Live-confirmed.",
  },
  /**
   * Lifetime total cleaning time in seconds (DP 119, Value). Counts across all sessions.
   * Confirmed from `thing.m.device.ref.info.list` v5.4 schemaInfo.schema (X8 Pro,
   * product `wahqax6ifjgs1c4n`). Read-only accumulator — no write expected.
   */
  lifetimeCleanTime: {
    param: TUYA_VACUUM_DP.CLEAR_TOTAL_TIME,
    readsFrom: "clearTime",
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.DURATION),
    decodedKind: "seconds",
    description:
      "Lifetime cleaning time in seconds — the plain DP 119 integer on the Tuya clean line, or " +
      "CleanStatistics.user_total.clean_duration (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * Lifetime total cleaned area in m² (DP 120, Value). Counts across all sessions.
   * Confirmed from `thing.m.device.ref.info.list` v5.4 schemaInfo.schema (X8 Pro,
   * product `wahqax6ifjgs1c4n`). Read-only accumulator — no write expected.
   */
  lifetimeCleanArea: {
    param: TUYA_VACUUM_DP.CLEAR_TOTAL_AREA,
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.AREA),
    decodedKind: "scalar",
    description:
      "Lifetime cleaned area in m² — the plain DP 120 integer on the Tuya clean line, or " +
      "CleanStatistics.user_total.clean_area (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * How many runs the robot has completed in its lifetime.
   *
   * AIoT only — it rides inside the same `CleanStatistics` the two figures above read, and the Tuya
   * clean line has no DP for it. So this one borrows without a wire of its own, where its siblings keep
   * theirs and only fall back to the payload.
   */
  lifetimeCleanCount: {
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    // Refuses a bare number outright. Its owner also answers from a Tuya DP via a read alias, and that
    // DP carries a session DURATION — passing it through would report seconds as a run count. A member
    // with no wire of its own can only be answered by the protobuf, so anything else is `undefined`.
    decode: (raw, codec) =>
      typeof raw === "string" && !/^\d+$/.test(raw)
        ? decodeCleanStat(raw, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.COUNT)
        : undefined,
    decodedKind: "scalar",
    description: "Completed runs in the robot's lifetime — CleanStatistics.user_total.clean_count (DP 167 AIoT).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.CLEAN_STATS) ?? false,
  },
  /**
   * Water tank attached (DP 127, Bool ro). Confirmed from `thing.m.device.ref.info.list` v5.4.
   * `true` when the water tank is mounted; `false` when removed. Read-only sensor — the device
   * reports this, the app does not write it.
   */
  waterTank: {
    param: TUYA_VACUUM_DP.WATER_TANK_STATUS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Water tank attached (DP 127, Bool ro). X8 Pro Tuya clean line. Schema-confirmed.",
  },
  /**
   * Mop pad attached (DP 129, Bool ro). Confirmed from `thing.m.device.ref.info.list` v5.4.
   * `true` when the mop pad is mounted; `false` when removed. Read-only sensor.
   */
  mopPad: {
    param: TUYA_VACUUM_DP.MOP_STATUS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Mop pad attached (DP 129, Bool ro). X8 Pro Tuya clean line. Schema-confirmed.",
  },
  /**
   * Child lock — when on, the robot ignores its physical buttons.
   *
   * AIoT clean line only; no equivalent is confirmed on the Tuya schema, so there is no read alias.
   */
  childLock: {
    param: VACUUM_DP.SETTINGS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.CHILDREN_LOCK),
    decodedKind: "boolean",
    description: "Child lock from UnisettingResponse.children_lock (DP 176 commonSettings, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.SETTINGS) ?? false,
  },
  /**
   * Whether a cruise resumes by itself after the robot has charged, rather than ending at the dock.
   */
  cruiseContinue: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.CRUISE_CONTINUE),
    decodedKind: "boolean",
    description: "Resume a cruise after charging — UnisettingResponse.cruise_continue_sw (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot keeps more than one saved map — a house with more than one floor needs this on.
   */
  multiMap: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.MULTI_MAP),
    decodedKind: "boolean",
    description: "Multi-map storage — UnisettingResponse.multi_map_sw (DP 176, Raw protobuf).",
  },
  /**
   * The obstacle-recognition camera. Off means the robot navigates without it, not that it is broken.
   */
  aiSee: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.AI_SEE),
    decodedKind: "boolean",
    description: "Obstacle-recognition camera — UnisettingResponse.ai_see (DP 176, Raw protobuf).",
  },
  /**
   * The vendor's `water_level_sw`. Named after the wire rather than given a friendlier name: what it
   * switches is not stated anywhere this SDK can point at, and a guessed name would be a claim.
   */
  waterLevelSwitch: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.WATER_LEVEL),
    decodedKind: "boolean",
    description:
      "UnisettingResponse.water_level_sw (DP 176, Raw protobuf). Vendor name kept — its meaning is unconfirmed.",
  },
  /**
   * Whether the robot offers restricted-area suggestions after a run — the prompts that ask to fence
   * off a spot it got stuck in.
   */
  suggestRestricted: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.SUGGEST_RESTRICTED),
    decodedKind: "boolean",
    description: "Restricted-area suggestions — UnisettingResponse.suggest_restricted (DP 176, Raw protobuf).",
  },
  /**
   * Extra corner passes while mopping. Slower runs, cleaner corners.
   */
  deepMopCorner: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.DEEP_MOP_CORNER),
    decodedKind: "boolean",
    description: "Deep corner mopping — UnisettingResponse.deep_mop_corner_sw (DP 176, Raw protobuf).",
  },
  /**
   * How long the robot waits before warning that its dust bag is full, in MINUTES.
   *
   * Read as a boolean until this revision, and wrongly: `dust_full_remind` is a `Numerical`, not a
   * `Switch`, and the two are the same two bytes on the wire — `{ value = 1 }` either way. So a
   * thirty-minute setting reported as `true`, nothing errored, and the number was gone. `0` means the
   * reminder is off, which is the only part the boolean ever got right.
   */
  dustFullRemindMinutes: {
    readsFrom: "childLock",
    type: "number",
    unit: "min",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeUnisettingNumber(raw as ParamValue | undefined, codec, UNISETTING_FIELD.DUST_FULL_REMIND),
    decodedKind: "scalar",
    description:
      "Dust-bag-full reminder delay in minutes, 0 = off — UnisettingResponse.dust_full_remind " +
      "(DP 176, Raw protobuf). A Numerical, not a switch.",
  },
  /**
   * Whether the robot steers around pet mess rather than through it.
   */
  poopAvoidance: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.POOP_AVOIDANCE),
    decodedKind: "boolean",
    description: "Pet-mess avoidance — UnisettingResponse.poop_avoidance_sw (DP 176, Raw protobuf).",
  },
  /**
   * The pet-owner profile, which changes how the robot treats obstacles and how often it cleans.
   */
  petMode: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.PET_MODE),
    decodedKind: "boolean",
    description: "Pet mode — UnisettingResponse.pet_mode_sw (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot holds a map it can actually clean from — at least one with room outlines.
   *
   * The precondition for every area-select frame: a room or zone clean sent at a robot with no valid
   * map is a request it cannot honour, and this is the device's own answer rather than an inference
   * from whether a scene happens to name one.
   */
  hasValidMap: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnistateFlag(raw as ParamValue | undefined, codec, UNISTATE_FIELD.MAP_VALID),
    decodedKind: "boolean",
    description: "Whether a usable map exists — UnisettingResponse.unistate.map_valid (DP 176, Raw protobuf).",
  },
  /**
   * Which layers the live map carries, as the vendor's own bitmask — see {@link LIVE_MAP_BITS}.
   *
   * A bitfield rather than an enum because the vendor says so outright: the values combine, and a map
   * with a base layer and room outlines reports both at once.
   */
  mapLayers: {
    readsFrom: "childLock",
    type: "number",
    kind: "bitfield",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeUnistateNumber(raw as ParamValue | undefined, codec, UNISTATE_FIELD.LIVE_MAP, UNISTATE_FIELD.STATE_BITS),
    decodedKind: "bitfield",
    description:
      "Live-map layers as a bitmask — UnisettingResponse.unistate.live_map.state_bits (DP 176, Raw protobuf).",
  },
  /**
   * The cleaning-strategy version the robot is running. A bare number the vendor gives no scale for —
   * diagnostic, and useful only against another reading of the same robot.
   */
  cleanStrategyVersion: {
    readsFrom: "childLock",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeUnistateNumber(raw as ParamValue | undefined, codec, UNISTATE_FIELD.CLEAN_STRATEGY_VERSION),
    decodedKind: "scalar",
    description:
      "Cleaning-strategy version — UnisettingResponse.unistate.clean_strategy_version (DP 176, Raw protobuf).",
  },
  /**
   * WiFi signal strength as a PERCENTAGE, 0-100 — the AIoT line's own reading.
   *
   * Distinct from `rssi`, which is the Tuya line's DP 134 in dBm and absent on this hardware, so until
   * now an X10 reported no signal at all. Reported as the vendor states it: eufy-clean converts this to
   * a dBm-looking number with `(value / 2) - 100`, which is a plausible-looking figure with no basis in
   * anything the device sends.
   */
  wifiSignal: {
    readsFrom: "childLock",
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisettingTopLevel(raw as ParamValue | undefined, codec, UNISETTING_FIELD.AP_SIGNAL),
    decodedKind: "percent",
    description: "WiFi signal strength 0-100% — UnisettingResponse.ap_signal_strength (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot captures stills while cleaning.
   */
  livePhoto: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.LIVE_PHOTO),
    decodedKind: "boolean",
    description: "Capture stills while cleaning — UnisettingResponse.live_photo_sw (DP 176, Raw protobuf).",
  },
  /**
   * Smart-follow mode. Numbered 13 in the response and 12 in the request — the widest gap in a message
   * whose two directions disagree about almost every field.
   */
  smartFollow: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.SMART_FOLLOW),
    decodedKind: "boolean",
    description: "Smart-follow mode — UnisettingResponse.smart_follow_sw (DP 176, Raw protobuf).",
  },
  /**
   * Hours run on the current side brush.
   *
   * The owner of DP 168 — the other eight counters read their own field out of this same payload, which
   * is why they declare `readsFrom` rather than a wire of their own. Hours USED, counting up: the
   * vendor sends no life expectancy, so a percentage remaining is the host's calibration to make, not
   * a number this SDK can invent.
   */
  sideBrushHours: {
    param: VACUUM_DP.CONSUMABLES,
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SIDE_BRUSH),
    decodedKind: "hours",
    description: "Side-brush hours used — ConsumableRuntime.side_brush (DP 168 consumables, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.CONSUMABLES) ?? false,
  },
  /**
   * Hours run on the current rolling brush.
   */
  rollingBrushHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.ROLLING_BRUSH),
    decodedKind: "hours",
    description: "Rolling-brush hours used — ConsumableRuntime.rolling_brush (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current filter mesh.
   */
  filterHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.FILTER_MESH),
    decodedKind: "hours",
    description: "Filter-mesh hours used — ConsumableRuntime.filter_mesh (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current scraper.
   */
  scraperHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SCRAPE),
    decodedKind: "hours",
    description: "Scraper hours used — ConsumableRuntime.scrape (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the sensors were last cleaned.
   */
  sensorHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SENSOR),
    decodedKind: "hours",
    description: "Hours since the sensors were cleaned — ConsumableRuntime.sensor (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current mop pad.
   */
  mopHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.MOP),
    decodedKind: "hours",
    description: "Mop-pad hours used — ConsumableRuntime.mop (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the dust bag was last changed.
   */
  dustBagHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DUSTBAG),
    decodedKind: "hours",
    description: "Dust-bag hours used — ConsumableRuntime.dustbag (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the waste-water tank was last emptied. Field 10, not 8 — the vendor leaves 8 and 9
   * unused and closing that gap would read the wrong counter.
   */
  dirtyWaterTankHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DIRTY_WATERTANK),
    decodedKind: "hours",
    description: "Waste-water-tank hours — ConsumableRuntime.dirty_watertank (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the waste-water filter.
   */
  dirtyWaterFilterHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DIRTY_WATERFILTER),
    decodedKind: "hours",
    description: "Waste-water-filter hours — ConsumableRuntime.dirty_waterfilter (DP 168, Raw protobuf).",
  },
  /**
   * Do-not-disturb — when on, the robot suppresses its voice announcements.
   *
   * Reports whether the feature is SWITCHED ON, not whether the quiet window happens to be open right
   * now; `UndisturbedResponse` carries that as a separate `active` flag which this deliberately skips.
   */
  doNotDisturb: {
    param: VACUUM_DP.DO_NOT_DISTURB,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.FORBID_MODE, available: isTuyaVacuum }],
    decode: (raw, codec) => decodeDoNotDisturb(raw as ParamValue | undefined, codec),
    decodedKind: "boolean",
    description:
      "Do-not-disturb switch — Undisturbed.sw (DP 157 AIoT, Raw protobuf) or the plain DP 107 bool on " +
      "the Tuya clean line. Whether the feature is ON, not whether the window is open right now.",
    available: (ctx: AvailabilityContext) =>
      (ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false) ||
      (ctx.paramIds?.has(TUYA_VACUUM_DP.FORBID_MODE) ?? false),
  },
  /**
   * Whether the do-not-disturb window is open RIGHT NOW — the live flag, not the switch beside it.
   *
   * A caller showing "quiet hours" as a schedule wants `doNotDisturb`; one
   * asking why the robot just declined to speak wants this. The two disagree for most of the day.
   *
   * Reads its sibling's payload rather than a wire of its own: `active` and `sw` are two fields of the
   * one `UndisturbedResponse` the device reports on DP 157, so there is one param and two readings of
   * it. AIoT only — the Tuya line's DP 107 carries the switch and says nothing about the window.
   */
  doNotDisturbActive: {
    readsFrom: "doNotDisturb",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeDoNotDisturbActive(raw as ParamValue | undefined, codec),
    decodedKind: "boolean",
    description: "Whether the do-not-disturb window is open now — Undisturbed.active (DP 157 AIoT, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false,
  },
  /**
   * When quiet hours start, as `"HH:MM"` on the robot's own clock.
   *
   * The window itself, which neither `doNotDisturb` (the switch) nor `doNotDisturbActive` (the live
   * flag) states — so a host could say quiet hours were ON and in force without ever being able to
   * show when they run. `undefined` means no window is configured; `"00:00"` is midnight and real.
   */
  doNotDisturbStart: {
    readsFrom: "doNotDisturb",
    type: "string",
    kind: "text",
    provenance: "mega",
    decode: (raw, codec) => decodeDoNotDisturbTime(raw as ParamValue | undefined, codec, UNDISTURBED_FIELD.BEGIN),
    decodedKind: "text",
    description: "Quiet hours start, HH:MM — Undisturbed.begin (DP 157 AIoT, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false,
  },
  /** When quiet hours end, as `"HH:MM"` on the robot's own clock. */
  doNotDisturbEnd: {
    readsFrom: "doNotDisturb",
    type: "string",
    kind: "text",
    provenance: "mega",
    decode: (raw, codec) => decodeDoNotDisturbTime(raw as ParamValue | undefined, codec, UNDISTURBED_FIELD.END),
    decodedKind: "text",
    description: "Quiet hours end, HH:MM — Undisturbed.end (DP 157 AIoT, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false,
  },
  /**
   * Whether the robot is taking a charge, and how that is going.
   *
   * `undefined` is the answer for a robot that is not charging: the vendor omits the whole `charging`
   * message rather than sending a "no" value, so absence IS the reading. `"fault"` is the vendor's
   * `ABNORMAL` — contacts touching but no charge flowing, which is the state a user needs told about
   * and which `activity` alone reports as a contented `"docked"`.
   */
  chargeState: {
    readsFrom: "activity",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeChargeState(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: CHARGE_STATES as readonly string[],
    description: "Charge state — WorkStatus.charging (DP 153, Raw protobuf). Absent while not charging.",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * What put the robot in the state it is in — an app, the button on its lid, a schedule, its own
   * judgement, or the remote.
   *
   * The difference between "it went home" and "it went home because the battery ran low", which the
   * activity alone cannot express. `"unknown"` is the vendor's own zero and what a robot reports just
   * after boot, so it is an answer rather than a gap.
   */
  triggerSource: {
    readsFrom: "activity",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeTriggerSource(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: TRIGGER_SOURCES as readonly string[],
    description: "What caused the current state — WorkStatus.trigger.source (DP 153, Raw protobuf).",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * How many schedules the robot holds — the owner of DP 164.
   *
   * The device reports its timers in full on every change, so a count is a real reading of that report
   * rather than a summary of one: zero means no schedules are set, and `undefined` means this robot has
   * not reported the DP at all. The schedules themselves are a list, which no property can be, so they
   * are read through {@link VACUUM_CLEAN_MEMBERS.schedules} beside this.
   */
  scheduleCount: {
    param: VACUUM_DP.TIMING,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumScheduleCount(raw, codec),
    decodedKind: "scalar",
    description: "How many schedules the robot holds — TimerResponse.timers (DP 164, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.TIMING) ?? false,
  },
  /**
   * How many of those schedules will actually fire — switched on, and still pointing at something that
   * exists.
   *
   * A timer whose scene or map was deleted is kept and reported `valid: false` rather than removed, so
   * "three schedules" and "three schedules that work" are genuinely different numbers, and a host
   * showing the first without the second explains nothing when a run does not happen.
   */
  activeScheduleCount: {
    readsFrom: "scheduleCount",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeActiveVacuumScheduleCount(raw, codec),
    decodedKind: "scalar",
    description: "How many schedules are on and usable — TimerInfo.status (DP 164, Raw protobuf).",
  },
  /**
   * The schedules themselves, decoded from the same DP 164 report the two counts above read.
   *
   * A query rather than a property: its value is a list, and the property schema holds scalars. It
   * answers from state already received — the robot pushes its whole timer list on boot and after any
   * change — so this sends nothing and cannot fail against a device that is merely asleep.
   */
  schedules: {
    ...method(
      ({ read, rawDp: codec }) =>
        (): readonly VacuumSchedule[] | undefined =>
          decodeVacuumSchedules(read("scheduleCount")?.value, codec),
      "The robot's schedules, decoded from its last TimerResponse (DP 164, Raw protobuf).",
      (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.TIMING) ?? false,
    ),
    answers: true,
  },
  /**
   * How many cleaning scenes the robot holds — the owner of DP 180.
   *
   * A scene is a saved routine over rooms or zones. The robot reports the LIST here; the tasks inside
   * a scene are only ever sent to it, never reported back, so this counts what the device publishes.
   */
  sceneCount: {
    param: VACUUM_DP.SCENES,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumSceneCount(raw, codec),
    decodedKind: "scalar",
    description: "How many cleaning scenes the robot holds — SceneResponse.infos (DP 180, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.SCENES) ?? false,
  },
  /**
   * How many of those scenes can still run. A scene whose map was deleted or no longer matches is kept
   * and reported invalid rather than removed, so the two counts differ for a real reason a host can
   * show — and `scenes()` says which reason, per scene.
   */
  usableSceneCount: {
    readsFrom: "sceneCount",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeUsableVacuumSceneCount(raw, codec),
    decodedKind: "scalar",
    description: "How many scenes can still run — SceneInfo.valid (DP 180, Raw protobuf).",
  },
  /**
   * The scenes themselves, decoded from the same DP 180 report the two counts read.
   *
   * Answers from state already received, like `schedules` — the robot pushes its whole scene list on
   * boot and after any change, so this sends nothing.
   *
   * **Where a caller gets a real map id.** Each scene names the map its rooms belong to, and so does a
   * scheduled rooms-clean. The plan expected that from B3, multi-map management on DP 172; the vendor's
   * own `multi_maps.proto` rules it out, sending a map list over p2p rather than the data point.
   */
  scenes: {
    ...method(
      ({ read, rawDp: codec }) =>
        (): readonly VacuumScene[] | undefined =>
          decodeVacuumScenes(read("sceneCount")?.value, codec),
      "The robot's saved cleaning scenes, decoded from its last SceneResponse (DP 180, Raw protobuf).",
      (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.SCENES) ?? false,
    ),
    answers: true,
  },
  /**
   * The network name the robot is joined to — `DeviceInfo.wifi_name` (DP 169).
   *
   * Reads a payload the DOCK capability owns. `DeviceInfo` is one message carrying the robot's network
   * facts beside the dock's firmware version, and the one-owner rule is per product line, so DP 169 has
   * a single owner — `vacuumDock().dockFirmwareVersion` — and these four members borrow it by name.
   * Putting them on the dock object instead would have filed the robot's IP under the wrong thing.
   *
   * Reported when the robot comes online and again when its IP changes, so it is as current as the last
   * such report and absent on a robot that has not reconnected since binding.
   */
  wifiSsid: {
    readsFrom: VACUUM_DOCK_INFO_SOURCE,
    type: "string",
    kind: "text",
    provenance: "mega",
    decode: (raw, codec) => decodeRobotInfoText(raw as ParamValue | undefined, codec, ROBOT_INFO_FIELD.WIFI_NAME),
    decodedKind: "text",
    description: "The WiFi network the robot is on — DeviceInfo.wifi_name (DP 169, Raw protobuf).",
  },
  /** The robot's address on that network — `DeviceInfo.wifi_ip` (DP 169). */
  wifiIp: {
    readsFrom: VACUUM_DOCK_INFO_SOURCE,
    type: "string",
    kind: "text",
    provenance: "mega",
    decode: (raw, codec) => decodeRobotInfoText(raw as ParamValue | undefined, codec, ROBOT_INFO_FIELD.WIFI_IP),
    decodedKind: "text",
    description: "The robot's IP on its WiFi network — DeviceInfo.wifi_ip (DP 169, Raw protobuf).",
  },
  /** The robot's MAC address — `DeviceInfo.device_mac` (DP 169). */
  macAddress: {
    readsFrom: VACUUM_DOCK_INFO_SOURCE,
    type: "string",
    kind: "identifier",
    provenance: "mega",
    decode: (raw, codec) => decodeRobotInfoText(raw as ParamValue | undefined, codec, ROBOT_INFO_FIELD.DEVICE_MAC),
    decodedKind: "identifier",
    description: "The robot's MAC address — DeviceInfo.device_mac (DP 169, Raw protobuf).",
  },
  /**
   * The robot's hardware revision — `DeviceInfo.hardware` (DP 169). A bare integer the vendor gives no
   * scale for; useful for telling two builds of one model apart, not for comparing models.
   */
  hardwareVersion: {
    readsFrom: VACUUM_DOCK_INFO_SOURCE,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeRobotHardware(raw as ParamValue | undefined, codec),
    decodedKind: "scalar",
    description: "The robot's hardware revision — DeviceInfo.hardware (DP 169, Raw protobuf).",
  },
  /**
   * WiFi RSSI in dBm (DP 134, Value ro). Schema-confirmed from `thing.m.device.ref.info.list` v5.4.
   * Negative integer; closer to zero is stronger. Useful for diagnostics.
   */
  rssi: {
    param: TUYA_VACUUM_DP.RSSI,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "mega",
    description: "WiFi RSSI in dBm (DP 134, Value ro). Schema-confirmed.",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(TUYA_VACUUM_DP.RSSI) ?? false,
  },
  /**
   * The ModeCtrl verbs whose METHOD NUMBER is not yet captured.
   *
   * Each shares its frame with the verified verbs above — same message, same two fields, same encoder
   * — so what is unconfirmed is the number alone. That still keeps them `unverified`: a wrong number
   * is a different command arriving at real hardware, and an AIoT DP write is fire-and-forget, so a
   * mistake looks exactly like success. They are declared so the capability documents what the robot
   * accepts.
   *
   * **For most of them one capture is all that stands in the way. For
   * {@link VACUUM_CLEAN_MEMBERS.stopCleaning} nothing
   * does, and nothing will** — see its own note. A verb the phone has no button for cannot be
   * captured from the phone, which is a different kind of blocked from the rest of this block and is
   * worth not confusing with it.
   */
  /**
   * Tell the robot a replaceable part is new, clearing its hours.
   *
   * The other half of the consumables feature: nine counters are read, and until now nothing could
   * reset one, so a host could show "side brush: 180 hours" forever after the brush was changed.
   *
   * **Unverified, so no setter is installed.** The message, the field and the enum are the vendor's
   * own, and the app has the feature — `resetAccessory(deviceId, accessory, callback)` calling
   * through to `resetAccessories`, taking exactly this kind of integer part id. What is missing is a
   * capture showing the frame accepted, and an AIoT DP write is fire-and-forget, so a wrong one would
   * look like success while quietly discarding service history the device never recomputes.
   *
   * **And the enum may be short.** The app tracks each part on TWO independent countdowns under
   * separate tabs — *Maintain* ("clean it") and *Replace* ("swap it") — each with its own Reset. A
   * side brush is in both, at 30 hours and 180 hours respectively. It also lists parts this enum has
   * no member for at all: sensors, swivel wheel, cleaning tray, brush guard. Thirteen reset targets
   * on the screen against nine values here.
   *
   * Which means one of two things, and nothing yet decides between them: either a reset clears both
   * counters for a part and the extra rows are computed app-side, or `ConsumableRequest` carries
   * something this encoder does not write. Two taps settle it — Reset the same part from each tab and
   * compare the frames — and until they do, an installed setter could silently clear the wrong
   * countdown. That is a second reason to keep this unverified, independent of the first.
   *
   * **A related correction, recorded here because it has nowhere better to live.** The plan filed the
   * per-part maximum lifetimes as another integration's calibration, not vendor data, and kept them
   * out. The app disagrees: it prints "16 hours left/30 hours" outright, and `AccessoryInfoByJson` in
   * the decompile is a server-delivered model keyed by product code carrying `count_time` alongside
   * `accessory_sku`, `reset_btn_status`, `purchase_btn_status` and a how-to `video_link` — every one
   * of which is visible on that screen. So the hours ARE the vendor's, delivered per product. The
   * endpoint that serves them has not been found (the call lives in the app's React Native bundle),
   * so nothing is built on this yet; it is written down so the next reader starts from the model
   * rather than from the wrong conclusion.
   */
  resetConsumable: {
    type: "string",
    kind: "enum",
    enumValues: Object.fromEntries(CONSUMABLE_PARTS.map((p, i) => [i, p])),
    writeOnly: true,
    unverified: true,
    write: (value) => aiotDp(VACUUM_DP.CONSUMABLES, encodeConsumableReset(value as ConsumablePart)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Clear the hours on one replaceable part (ConsumableRequest.reset_types over DP 168). " +
      "Frame not captured — unverified.",
  },
  /**
   * End the current job outright, as opposed to {@link VACUUM_CLEAN_MEMBERS.pauseCleaning}, which
   * leaves it resumable.
   *
   * **Unverified, and not pending a capture — there is nothing to capture.** The eufy app offers no
   * stop: a run can be paused, resumed, or sent home, and that is the whole vocabulary. A live capture
   * of "ending a clean" recorded method 6, `START_GOHOME`, which was not the app disagreeing with the
   * vendor enum — it was the only affordance there is, answering the only question that could be
   * asked. `STOP_TASK` is a verb the phone never sends, so no amount of driving the app will ever
   * confirm it.
   *
   * Kept declared rather than deleted, because the enum entry is the vendor's own and the reason it
   * cannot be confirmed is worth more written down than discovered again. It would take evidence from
   * something other than the app — another client observed sending it, or a firmware trace.
   *
   * **What a caller wants instead is {@link VACUUM_CLEAN_MEMBERS.returnToDock}**, which is what the
   * app's own end-a-clean button does and which is verified and shipping.
   */
  stopCleaning: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.STOP_TASK, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Stop the current job (ModeCtrlRequest method 12 over DP 152). The app has no stop button — it " +
      "offers pause, resume and go-home — so this cannot be captured from it and stays unverified. " +
      "Use returnToDock, which is what the app's end-a-clean button sends.",
  },
  /**
   * Carry on with a paused job rather than starting a new one — the counterpart the pause verb has
   * been missing.
   */
  resumeCleaning: method(
    ({ sink }) =>
      (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.RESUME_TASK, nextModeCtrlSeq()))),
    "Resume a paused job (ModeCtrlRequest method 14 over DP 152). Captured on a live T2351.",
    isAiotVacuum,
  ),
  /**
   * Send the robot to the dock to wash its mops. Distinct from the dock's own `washMops`, which asks
   * the STATION to run its cycle: this one moves the robot there first.
   */
  startWashingMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GOWASH, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Go and wash the mops (ModeCtrlRequest method 10 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Call off a mop-wash trip in progress.
   */
  stopWashingMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.STOP_GOWASH, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Stop washing the mops (ModeCtrlRequest method 17 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Call off a return-to-dock in progress, leaving the robot where it is.
   */
  stopReturnToDock: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.STOP_GOHOME, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Stop returning to the dock (ModeCtrlRequest method 15 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Clean the robot's immediate surroundings. Takes no target — the spot is wherever it is standing,
   * which is why this one needs no `Param` and its area-selecting cousins do.
   */
  startSpotClean: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_SPOT_CLEAN, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Spot-clean where the robot stands (ModeCtrlRequest method 3 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Run a fast mapping pass without cleaning — how a robot learns a floor it has not seen.
   */
  startMapping: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_FAST_MAPPING, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Run a fast mapping pass (ModeCtrlRequest method 9 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Patrol the whole map without cleaning — the camera-equipped models use this to look around.
   */
  startCruise: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GLOBAL_CRUISE, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Start a global cruise (ModeCtrlRequest method 20 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Enter remote-control cleaning, where the app drives. The SDK offers no steering wire, so this is
   * only half a feature until one exists — declared for completeness of the vocabulary.
   */
  startRemoteControl: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_RC_CLEAN, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Enter remote-control cleaning (ModeCtrlRequest method 5 over DP 152). Method number not captured — unverified.",
  },
  /**
   * Leave remote-control mode.
   *
   * **Uses `STOP_TASK`, not `STOP_RC_CLEAN`.** The product catalogue's own note on DP 155 spells the
   * flow out: enter with `START_RC_CLEAN` or any direction, leave with
   * `ModeCtrlRequest.method.STOP_TASK`. `STOP_RC_CLEAN`(16) exists in the enum but is not what the app
   * sends to exit — an earlier revision of this member assumed it was, on nothing but the name.
   */
  stopRemoteControl: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.STOP_TASK, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Leave remote-control mode (ModeCtrlRequest method 12 STOP_TASK over DP 152, per the DP 155 " +
      "catalogue note). Not captured on a device — unverified.",
  },
  /**
   * Steer the robot while it is in remote-control mode — DP 155, an enum of directions rather than a
   * `ModeCtrlRequest`.
   *
   * `brake` stops the current movement without leaving remote-control mode; the catalogue's note says
   * the app sends it on key-release. Leaving the mode entirely is
   * {@link VACUUM_CLEAN_MEMBERS.stopRemoteControl}.
   *
   * Sending any direction also ENTERS remote control, so a caller does not have to start it first.
   */
  remoteControlDirection: {
    param: VACUUM_DP.REMOTE_CTRL,
    type: "string",
    kind: "enum",
    writeOnly: true,
    unverified: true,
    enumValues: { 0: "Brake", 1: "Forward", 2: "Back", 3: "Left", 4: "Right" },
    write: (v) => aiotDp(VACUUM_DP.REMOTE_CTRL, String(v)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Remote-control direction (DP 155 Enum: Brake/Forward/Back/Left/Right). Values from the product " +
      "catalogue; the wire is not captured — unverified.",
  },
  /**
   * Whether the robot resumes an interrupted job after charging, rather than treating the next start
   * as a fresh run. The vendor calls this 断点续扫 — "resume from the break point".
   */
  resumeClean: {
    param: VACUUM_DP.RESUME_CLEAN,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Resume an interrupted job after charging (DP 156 pause_job, Bool).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.RESUME_CLEAN) ?? false,
  },
  /**
   * Stop smart-follow mode. There is no start verb in the vendor's parameterless set — the mode is
   * switched on through `smartFollow` in the DP 176 settings, and only stopped from here.
   */
  stopSmartFollow: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.STOP_SMART_FOLLOW, nextModeCtrlSeq())),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Stop smart-follow mode (ModeCtrlRequest method 18 over DP 152). Method number not captured — unverified.",
  },
  /** Start an auto-clean run via ModeCtrlRequest method 0 (DP 152). AIoT only — Tuya write unverified. */
  startCleaning: method(
    ({ sink }) =>
      (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, nextModeCtrlSeq()))),
    "Start an auto-clean run (ModeCtrlRequest method 0 over DP 152).",
    isAiotVacuum,
  ),
  /** Return to the dock via ModeCtrlRequest method 6 (DP 152). AIoT only — Tuya write unverified. */
  returnToDock: method(
    ({ sink }) =>
      (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GOHOME, nextModeCtrlSeq()))),
    "Return to the dock (ModeCtrlRequest method 6 over DP 152).",
    isAiotVacuum,
  ),
  /** Pause the current cleaning task via ModeCtrlRequest method 13 (DP 152). AIoT only — Tuya write unverified. */
  pauseCleaning: method(
    ({ sink }) =>
      (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, nextModeCtrlSeq()))),
    "Pause the current cleaning task (ModeCtrlRequest method 13 over DP 152).",
    isAiotVacuum,
  ),
} as const satisfies Members;

/** `vacuum_clean` — core RoboVac scalar state + decoded activity: power, activity, volume, battery. */
export const VACUUM_CLEAN: CapabilityModule = {
  capability: "vacuum_clean",
  line: "clean",
  description: "RoboVac core state: power, activity (WorkStatus), volume and battery (Tuya DP).",
  members: VACUUM_CLEAN_MEMBERS,
  properties: propertiesOf(VACUUM_CLEAN_MEMBERS),
  /** Core RoboVac control is the vacuum-codec baseline. */
  detection: { codecs: ["vacuum"] },
  /**
   * Land this capability's data points from a realtime report. The robot's cloud record does NOT carry
   * them — it reports state only over its realtime feed — so without this the evidence gate sees no
   * backing param and installs no getter at all. Values are stored as sent; `activity` stays the raw
   * structured payload until {@link decodeVacuumActivity} unpacks it at read time.
   */
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [
      ...Object.values(VACUUM_DP),
      ...Object.values(TUYA_VACUUM_DP),
    ]);
    return params ? { params } : null;
  },
};
