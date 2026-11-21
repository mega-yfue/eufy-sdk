import type { RawDpCodec } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import { pickDpParams, aiotDp } from "./access.js";
import { rawDp } from "../../core/raw-dp-writer.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { isAiotVacuum } from "../device-family.js";

/** DP id for the Omni dock control (StationResponse/StationRequest, DP 173). */
const VACUUM_DOCK_DP = 173 as const;

/**
 * DP id carrying `DeviceInfo` (DP 169) — the robot's own identity, with the dock's nested inside it.
 *
 * Only the dock's slice is read here. The robot's own firmware is already `info.firmwareVersion`, off
 * the cloud device record, and a second spelling of it on this capability would be the same feature
 * under two names.
 */
const VACUUM_DOCK_INFO_DP = 169 as const;

/**
 * Field numbers inside `DeviceInfo` (DP 169) for the dock's slice of it.
 *
 * The vendor notes `station` is present only while the robot is powered on AT the dock, so its absence
 * is normal rather than an error — a robot out on a job simply has nothing to say about the dock here.
 */
const DEVICE_INFO_FIELD = {
  /** `station` — the dock's own info block. */
  STATION: 11,
  /** `software` within a `Station` — its firmware version string, e.g. "1.2.3". */
  SOFTWARE: 1,
} as const;

/**
 * The DP 169 property name the ROBOT's own readings borrow, and the id carrying it.
 *
 * `DeviceInfo` is one message spanning two capabilities: the dock's firmware sits at field 11 and the
 * robot's MAC, SSID and IP sit beside it. The one-owner rule is per product line, so one of the two has
 * to own the id — this capability does, because it claimed it first and because moving it would break a
 * shipped surface. The clean capability names this pair to read the rest. Exported so the far side
 * cites a constant rather than retyping a string and a number that must agree.
 */
export const VACUUM_DOCK_INFO_SOURCE = { property: "dockFirmwareVersion", param: VACUUM_DOCK_INFO_DP } as const;

/**
 * Decode the DOCK's firmware version from `DeviceInfo` (DP 169).
 *
 * `undefined` covers every way it is not stated: no codec, a payload that does not decode, a robot not
 * currently docked (no `station` block), or a dock that reports the block without a version. A
 * length-delimited `string` arrives as bytes, so the value is read back as UTF-8.
 * @internal
 */
export function decodeDockFirmware(raw: ParamValue | undefined, codec: RawDpCodec | undefined): string | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const station = codec.decode(raw)?.find((f) => f.field === DEVICE_INFO_FIELD.STATION);
  if (station?.kind !== "bytes") return undefined;
  const software = codec.nested(station.value)?.find((f) => f.field === DEVICE_INFO_FIELD.SOFTWARE);
  if (software?.kind !== "bytes" || !software.value.length) return undefined;
  return software.value.toString("utf-8");
}

/**
 * Every value {@link DockActivity} can take — the read's declared domain, so the schema a caller reads
 * and the type it compiles against are the same list rather than two that can drift.
 *
 * Published alongside {@link DockActivity} so the members are reachable as data at runtime, not only
 * at compile time.
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
 * Field numbers for the WRITE side of DP 173 — `StationRequest`, a different message from the
 * `StationResponse` the read side decodes on the same data point.
 *
 * The manual commands are a `oneof`, so exactly one of them is set per frame and setting it to `true`
 * IS the command. `go_selfpurifying`(7) is marked deprecated by the vendor and is deliberately absent.
 */
const STATION_REQUEST_FIELD = {
  /** `manual_cmd` within a `StationRequest` — the one-shot commands, as opposed to `auto_cfg`(1). */
  MANUAL_CMD: 2,
  /** `self_maintain` — the full deep self-clean cycle. */
  SELF_MAINTAIN: 1,
  /** `go_dry` — dry the mops. */
  GO_DRY: 2,
  /** `go_collect_dust` — empty the dust bin. */
  GO_COLLECT_DUST: 3,
  /** `go_selfcleaning` — wash the mops. */
  GO_SELFCLEANING: 4,
  /** `go_remove_scale` — run the descaling cycle. */
  GO_REMOVE_SCALE: 5,
  /** `go_cut_hair` — run the hair-cutting cycle. */
  GO_CUT_HAIR: 6,
} as const;

/**
 * Build a `StationRequest` carrying one manual dock command.
 *
 * Every one of these is the same two-level frame with a different inner field, so one builder serves
 * them all and each member names only its command.
 *
 * **Reversed from the vendor's `station.proto`, NOT confirmed on a device.** Every member built on this
 * carries `unverified`, so no setter is installed and the frame ships as documentation rather than as a
 * callable control. An AIoT DP write is not refused by a router guard — it reaches the robot — and a
 * fire-and-forget write that is wrong looks exactly like success, so the frame being plausible is not
 * the bar. One `publishDps` capture per verb is what flips it.
 * @internal
 */
export function encodeStationCommand(command: number): string {
  return rawDp((w) => w.sub(STATION_REQUEST_FIELD.MANUAL_CMD, (cmd) => cmd.bool(command, true)));
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
   * The DOCK's firmware version (DP 169, `DeviceInfo.station.software`) — distinct from
   * `info.firmwareVersion`, which is the robot's and comes off the cloud device record.
   *
   * `undefined` while the robot is not docked: the vendor only fills the station block when the robot
   * is powered on at the dock, so an absent value is normal rather than a fault.
   */
  dockFirmwareVersion: {
    param: VACUUM_DOCK_INFO_DP,
    type: "string",
    kind: "text",
    decode: (raw, codec) => decodeDockFirmware(raw as ParamValue | undefined, codec),
    decodedKind: "text",
    description:
      "Dock firmware version from DeviceInfo.station.software (DP 169 appAndDevice, Raw protobuf). " +
      "The robot's own firmware is info.firmwareVersion, not this.",
  },
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
    decode: (raw, codec) => decodeDockActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: DOCK_ACTIVITIES,
    description:
      "What the dock is currently doing, from StationStatus (DP 173 baseStation, Raw protobuf) — " +
      "mop washing/drying/descaling, dust collection, water transfer, disinfectant or hair cutting.",
  },
  /**
   * Empty the dust bin into the dock. Write side of DP 173 — `StationRequest.manual_cmd.go_collect_dust`.
   *
   * The frame is built and reviewable; the member stays `unverified`, so no setter is installed and
   * the intent path refuses it. What is missing is a capture, not the message shape.
   */
  emptyDust: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.GO_COLLECT_DUST)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Empty the dust bin (DP 173 StationRequest.manual_cmd.go_collect_dust). Frame reversed from the vendor proto; unverified until captured on a device.",
  },
  /**
   * Wash the mops in the dock — `StationRequest.manual_cmd.go_selfcleaning`. Same standing as
   * {@link VACUUM_DOCK_MEMBERS.emptyDust}: frame built, not yet captured, so no setter is installed.
   */
  washMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.GO_SELFCLEANING)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Wash the mops (DP 173 StationRequest.manual_cmd.go_selfcleaning). Frame reversed from the vendor proto; unverified until captured on a device.",
  },
  /**
   * Dry the mops in the dock — `StationRequest.manual_cmd.go_dry`. Frame built, not yet captured.
   */
  dryMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.GO_DRY)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Dry the mops (DP 173 StationRequest.manual_cmd.go_dry). Frame reversed from the vendor proto; unverified until captured on a device.",
  },
  /**
   * Run the dock's full deep self-clean cycle — `StationRequest.manual_cmd.self_maintain`.
   *
   * The longest-running of these — it occupies the dock for a while.
   */
  selfMaintain: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.SELF_MAINTAIN)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Run the dock's full self-maintenance cycle (DP 173 StationRequest.manual_cmd.self_maintain). Frame reversed from the vendor proto; unverified until captured on a device.",
  },
  /**
   * Run the descaling cycle — `StationRequest.manual_cmd.go_remove_scale`. Only docks that make their
   * own cleaning solution have this; the `available` gate is family-wide, so a device without it will
   * simply ignore the frame.
   */
  removeScale: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.GO_REMOVE_SCALE)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Run the descaling cycle (DP 173 StationRequest.manual_cmd.go_remove_scale). Frame reversed from the vendor proto; unverified until captured on a device.",
  },
  /**
   * Run the hair-cutting cycle on the brush — `StationRequest.manual_cmd.go_cut_hair`.
   */
  cutHair: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    write: () => aiotDp(VACUUM_DOCK_DP, encodeStationCommand(STATION_REQUEST_FIELD.GO_CUT_HAIR)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Run the hair-cutting cycle (DP 173 StationRequest.manual_cmd.go_cut_hair). Frame reversed from the vendor proto; unverified until captured on a device.",
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
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [
      VACUUM_DOCK_DP,
      VACUUM_DOCK_INFO_DP,
    ]);
    return params ? { params } : null;
  },
};
