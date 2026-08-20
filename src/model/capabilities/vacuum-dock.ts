import type { RawDpCodec } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import { pickDpParams } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { isAiotVacuum } from "../device-family.js";

/** DP id for the Omni dock control (StationResponse/StationRequest, DP 173). */
const VACUUM_DOCK_DP = 173 as const;

/**
 * Every value {@link DockActivity} can take — the read's declared domain, so the schema a caller reads
 * and the type it compiles against are the same list rather than two that can drift.
 *
 * Published alongside {@link DockActivity} so a caller can offer the set as data — a picker or a
 * legend needs the members at runtime, not only at compile time.
 */
export const DOCK_ACTIVITIES = [
  "idle",
  "washing",
  "drying",
  "descaling",
  "emptyingDust",
  "addingWater",
  "recyclingWater",
  "makingDisinfectant",
  "cuttingHair",
  "unknown",
] as const;

/**
 * What the dock is doing — what `dev.vacuumDock()?.dockState` reports.
 *
 * A dock services several subsystems, so more than one can be busy at once; this answers the single
 * most specific one — a subsystem that is running beats the mop system's own mode. `"unknown"` covers
 * a state value outside the set the dock's own status message declares.
 */
export type DockActivity = (typeof DOCK_ACTIVITIES)[number];

/**
 * Field numbers inside `StationResponse` and the `StationStatus` it carries.
 *
 * `STATUS` is field #2, NOT field #1 — field #1 is the auto-maintenance CONFIG (how often to wash, how
 * long to dry, whether to auto-empty), which is a different message with the same outward shape: a run
 * of nested sub-messages. Reading it as status is the mistake this layout exists to prevent.
 */
const STATION_FIELD = {
  /** `status` — the live `StationStatus`. */
  STATUS: 2,
} as const;

/**
 * `StationStatus` fields. `STATE` names the mop system's own mode; the rest are independent subsystems
 * that report as plain booleans and can be busy while `STATE` is idle.
 */
const STATION_STATUS_FIELD = {
  /** `state` — the mop system: idle, washing, drying or descaling. */
  STATE: 2,
  /** `collecting_dust` — emptying the robot's bin into the dock. */
  COLLECTING_DUST: 3,
  /** `clear_water_adding` — refilling the robot's clean-water tank. */
  CLEAR_WATER_ADDING: 4,
  /** `waste_water_recycling` — draining the robot's dirty water into the dock. */
  WASTE_WATER_RECYCLING: 5,
  /** `disinfectant_making` — preparing disinfectant. */
  DISINFECTANT_MAKING: 6,
  /** `cutting_hair` — running the hair-cutting module. */
  CUTTING_HAIR: 7,
} as const;

/** `StationStatus.state` → {@link DockActivity}. `IDLE` is the proto3 default, so it is absent on the wire. */
const STATION_STATE_ACTIVITY: Record<number, DockActivity> = {
  0: "idle",
  1: "washing",
  2: "drying",
  3: "descaling",
};

/**
 * The boolean subsystems, in the order they win. Each is independent of `state` and of the others, so a
 * dock can report several at once; the first match is answered because it is the most specific thing
 * the dock is doing, and because the mop `state` is `IDLE` — and therefore absent from the wire —
 * throughout all of them.
 */
const STATION_BUSY: readonly (readonly [number, DockActivity])[] = [
  [STATION_STATUS_FIELD.COLLECTING_DUST, "emptyingDust"],
  [STATION_STATUS_FIELD.CLEAR_WATER_ADDING, "addingWater"],
  [STATION_STATUS_FIELD.WASTE_WATER_RECYCLING, "recyclingWater"],
  [STATION_STATUS_FIELD.DISINFECTANT_MAKING, "makingDisinfectant"],
  [STATION_STATUS_FIELD.CUTTING_HAIR, "cuttingHair"],
];

/**
 * Decode a `StationResponse` (DP 173) Raw-DP value to the {@link DockActivity} the dock reports.
 *
 * Answers `undefined` for every way the dock has not stated an activity — an unbound device (no
 * codec), a payload that does not decode, or one carrying no `status` message at all. That is distinct
 * from `"idle"`, which is the dock actively saying it has nothing running, and from `"unknown"`, which
 * is a state value this does not have a name for.
 * @internal
 */
export function decodeDockActivity(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): DockActivity | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const container = codec.decode(raw)?.find((f) => f.field === STATION_FIELD.STATUS);
  if (container?.kind !== "bytes") return undefined;
  const status = codec.nested(container.value);
  if (!status) return undefined;

  for (const [field, activity] of STATION_BUSY) {
    const flag = status.find((f) => f.field === field);
    if (flag?.kind === "int" && flag.value !== 0n) return activity;
  }

  const state = status.find((f) => f.field === STATION_STATUS_FIELD.STATE);
  if (state === undefined) return "idle";
  return state.kind === "int" ? (STATION_STATE_ACTIVITY[Number(state.value)] ?? "unknown") : "unknown";
}

/**
 * Every `vacuum_dock` feature, declared once.
 *
 * DP 173 is confirmed in the `get_product_data_point` catalog (raw, rw) as `baseStation`. The read
 * side answers a typed {@link DockActivity} through {@link decodeDockActivity}. The write side
 * (`StationRequest`) is a different message on the same DP and is not confirmed on a device — those
 * members carry `unverified` with no `write` field, so no setter is installed and the intent path
 * throws rather than guessing a frame.
 * @internal
 */
export const VACUUM_DOCK_MEMBERS = {
  /**
   * What the dock is doing (DP 173, `StationResponse`) — washing or drying mops, emptying the bin,
   * moving water, or idle.
   *
   * `undefined` means the dock has not stated an activity: the payload carried no `status` message, or
   * the device is not bound to a codec. That is not the same as `"idle"`, which is the dock saying it
   * has nothing running.
   */
  dockState: {
    param: VACUUM_DOCK_DP,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeDockActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: DOCK_ACTIVITIES,
    description:
      "What the dock is currently doing, from StationStatus (DP 173 baseStation, Raw protobuf) — " +
      "mop washing/drying/descaling, dust collection, water transfer, disinfectant or hair cutting.",
  },
  /**
   * Trigger auto-empty of the dust collection bin. Write side of DP 173 (StationRequest). The
   * StationRequest protobuf is not yet reversed — `unverified` with no `write` field: no setter is
   * installed, and the intent path throws rather than guessing a frame.
   */
  emptyDust: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger auto-empty dust collection (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
  /**
   * Trigger mop washing in the dock. Write side of DP 173 (StationRequest). Same unverified
   * standing as {@link emptyDust} — no setter is installed until the frame shape is captured.
   */
  washMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger mop washing in the dock (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
  /**
   * Trigger mop drying in the dock. Write side of DP 173 (StationRequest). Same unverified
   * standing as {@link emptyDust} — no setter is installed until the frame shape is captured.
   */
  dryMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger mop drying in the dock (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
} as const satisfies Members;

/**
 * Bound Omni dock controls — the object returned by `dev.vacuumDock()`.
 *
 * `dockState` reads as a typed {@link DockActivity}. All write members (`emptyDust`, `washMops`,
 * `dryMops`) are `unverified` with no `write` field: the `StationRequest` wire is not confirmed on a
 * device, so no setter appears on the surface until it is. The surface will fill out as writes are
 * confirmed.
 */
export type VacuumDockActions = Surface<typeof VACUUM_DOCK_MEMBERS>;

/** `vacuum_dock` — Omni dock controls (auto-empty, mop wash, mop dry) for the RoboVac X10 Pro Omni (T2351). */
export const VACUUM_DOCK: CapabilityModule = {
  capability: "vacuum_dock",
  line: "clean",
  description: "RoboVac Omni dock controls: auto-empty, mop wash, mop dry (DP 173).",
  members: VACUUM_DOCK_MEMBERS,
  properties: propertiesOf(VACUUM_DOCK_MEMBERS),
  // Detected only when the device reports DP 173 — not a codec baseline; a dock station is
  // equipment the T2351 has and a plain RoboVac does not.
  detection: { evidenceParams: [VACUUM_DOCK_DP] },
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [VACUUM_DOCK_DP]);
    return params ? { params } : null;
  },
};
