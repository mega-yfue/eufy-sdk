import type { RawDpCodec } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { asBool } from "../../core/util.js";
import { pickDpParams, aiotDp } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";

/**
 * RoboVac Tuya **DP ids** this capability reads — the "clean" namespace (ids ~150-180, from the cloud
 * `get_product_data_point` schema). Named here so each DP is referenced by meaning rather than a magic
 * number, the same way the P2P capabilities name their feature-command ids (`CAMERA_CMD`, `LIGHT_CMD`).
 * Values confirmed against a live T2351 DP dump.
 */
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
  /** Device UI language (DP 162, String rw). Locale code set by the app, e.g. "en", "zh", "de". */
  LANGUAGE: 162,
  /** Battery level 0-100 (DP 163, Value) — a clean-namespace DP, NOT the security param 1101. */
  BATTERY: 163,
} as const;

/**
 * Legacy Tuya DP ids for the G-series / X8 / L-series clean line.
 * DP 101 confirmed (`goHome` → bool). DP 2 type confirmed (bool play/pause).
 * DPs 104 and 106 confirmed as integer read-only values from protocol inspection.
 * @internal
 */
export const LEGACY_VACUUM_DP = {
  /** Play/pause toggle (DP 2, Bool rw) — true = start, false = pause. */
  PLAY_PAUSE: 2,
  /** Go home (DP 101, Bool rw). */
  GO_HOME: 101,
  /** Battery level 0-100 (DP 104, Int ro). */
  BATTERY_LEVEL: 104,
  /** Error code, 0 = ok (DP 106, Int ro). */
  ERROR_CODE: 106,
} as const;

/**
 * Tuya DP ids for the `eufy_home_tuya` vacuum category (X8 Pro, X-series, and future Tuya clean-line models).
 *
 * Full schema sourced from `thing.m.device.ref.info.list` v5.4 for product `wahqax6ifjgs1c4n`
 * (schemaInfo.schema, 39 DPs). Only the DPs with confirmed read-side values from a live
 * `thing.m.device.dp.get` call are included here. Write direction for all DPs is unverified —
 * no live publishDps capture has been made yet.
 * @internal
 */
export const TUYA_VACUUM_DP = {
  /** Power on/off (DP 1, Bool). */
  POWER: 1,
  /** Play/pause toggle (DP 2, Bool rw) — true = start, false = pause. Shared with {@link LEGACY_VACUUM_DP.PLAY_PAUSE}. */
  PLAY_PAUSE: 2,
  /** Manual direction jog (DP 3, Enum: "forward"|"back"|"left"|"right"). */
  DIRECTION: 3,
  /** Cleaning mode (DP 5, Enum: "auto"|"room"|"zone"|"spot"|"fast_mapping"). Live-confirmed "auto". */
  MODE: 5,
  /** Work status (DP 15, Enum string) — the high-level activity. Live-confirmed "Sleeping". */
  WORK_STATUS: 15,
  /** Return to dock (DP 101, Bool rw). Shared with {@link LEGACY_VACUUM_DP.GO_HOME}. */
  GO_HOME: 101,
  /** Suction/cleaning strength (DP 102, Enum: "Off"|"Quiet"|"Standard"|"Turbo"|"Max"). Live-confirmed "Off". */
  CLEANING_STRENGTH: 102,
  /** Battery level 0-100 (DP 104, Value ro). Shared with {@link LEGACY_VACUUM_DP.BATTERY_LEVEL}. */
  BATTERY_LEVEL: 104,
  /** Mop water flow (DP 105, Enum: "Dry"|"Low"|"Mid"|"High"). Live-confirmed "Mid". */
  MOP_WATER: 105,
  /** Fault code, 0 = ok (DP 106, Value ro). Shared with {@link LEGACY_VACUUM_DP.ERROR_CODE}. */
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

/**
 * `ModeCtrlRequest.method` values for DP 152. Live-verified on T2351: START_AUTO_CLEAN → 0
 * (omitted from the wire when zero), START_GOHOME → 6, PAUSE_TASK → 13.
 */
export const ModeCtrlMethod = {
  START_AUTO_CLEAN: 0,
  START_GOHOME: 6,
  PAUSE_TASK: 13,
} as const;

/**
 * Encode a `ModeCtrlRequest` protobuf (DP 152) as a base64 string: `varint(bodyLen) ++ body`
 * where `body = {field#1:method, field#2:seq}`.
 *
 * Uses a hand-rolled varint rather than importing protobufjs — the model layer may not import
 * transport deps and the field count is small enough to inline. Method 0 (START_AUTO_CLEAN) is
 * omitted from the wire per the proto3 default-field rule (confirmed on a live T2351 capture).
 * @internal
 */
export function encodeModeCtrl(method: number, seq: number): string {
  const writeVarint = (buf: number[], n: number): void => {
    let v = n;
    while (v > 0x7f) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v);
  };
  const body: number[] = [];
  if (method !== 0) {
    body.push(0x08); // field 1, wire type 0 (varint)
    writeVarint(body, method);
  }
  body.push(0x10); // field 2, wire type 0 (varint)
  writeVarint(body, seq);
  const out: number[] = [];
  writeVarint(out, body.length);
  return Buffer.from([...out, ...body]).toString("base64");
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
 * status the SDK can't classify yet. Several finer states collapse into `"cleaning"` today.
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
 * Only three values are **live-verified** on a T2351 — a start→return→charge run reported `5`(cleaning)
 * → `7`(returning) → `3`(docked), matching the physical actions. Every other value is carried from the
 * legacy `eufy-clean` `control.proto` enum and is **UNVERIFIED** (flagged inline, the same way the
 * arming module marks its unconfirmed mode ids); each is best-effort until captured on-device.
 *
 * Known gap — `state == 5` is not final; it carries a sub-state this decoder does not read (it only
 * reads field #2). The reversed `WorkStatus` shows the same `5` also means **paused**
 * (`cleaning.state == 1`) or **parked at the dock running its wash/dry cycle** (`go_wash.mode ∈ {1,2}`
 * / `station` washing-drying), not just actively cleaning. So a paused robot AND one washing/drying on
 * the dock both currently read as `"cleaning"`, and the standalone `15` (paused) value may be
 * unreachable in practice. Resolving it needs those sub-fields decoded; they are not guessed here.
 */
const WORK_STATE_ACTIVITY: Record<number, VacuumActivity> = {
  0: "idle", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  1: "idle", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  2: "error", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  3: "docked", // ✅ live T2351
  4: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  5: "cleaning", // ✅ live T2351
  6: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  7: "returning", // ✅ live T2351
  8: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  15: "paused", // ⚠️ unverified — legacy eufy-clean enum; may be unreachable, see "Known gap" above
};

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
  /** `value` within a `CleanType`. */
  VALUE: 1,
} as const;

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

/** `state`'s field number inside the `WorkStatus` message — the one field of DP 153 read today. */
const WORK_STATUS_STATE_FIELD = 2;

/**
 * Decode a `WorkStatus` (DP 153) Raw-DP value to a {@link VacuumActivity}. That DP carries a whole
 * protobuf message rather than a scalar, so the payload is read through the injected {@link RawDpCodec}:
 * the codec owns the structure, this owns which field number carries which meaning. `"unknown"` covers
 * every way the answer can be absent — an unbound device (no codec), a malformed payload, no field
 * {@link WORK_STATUS_STATE_FIELD}, or a state value missing from {@link WORK_STATE_ACTIVITY}.
 * @internal
 */
export function decodeVacuumActivity(raw: ParamValue | undefined, codec: RawDpCodec | undefined): VacuumActivity {
  if (typeof raw !== "string" || !codec) return "unknown";
  const state = codec.decode(raw)?.find((f) => f.field === WORK_STATUS_STATE_FIELD);
  if (state?.kind !== "int") return "unknown";
  return WORK_STATE_ACTIVITY[Number(state.value)] ?? "unknown";
}

/**
 * Bound RoboVac reads and controls — the object returned by `dev.vacuumClean()`.
 *
 * All reads, `setPower`, and the three mode-control verbs are DERIVED from `VACUUM_CLEAN_MEMBERS`.
 * Each getter is present only when the device reports the backing DP. `setPower` is absent on
 * `eufy_home_tuya` devices (no confirmed power DP). The three mode-control verbs are present on
 * both AIoT and Tuya devices — they dispatch different DP shapes per platform.
 *
 * X8 Pro read members (`lifetimeCleanTime`, `lifetimeCleanArea`, `waterTank`, `mopPad`)
 * are populated only once the device has reported those DPs over MQTT or the initial Tuya DP poll.
 */
export type VacuumCleanActions = Surface<typeof VACUUM_CLEAN_MEMBERS>;

/**
 * Every `vacuum_clean` read plus the writes and mode-control verbs.
 *
 * `power` (DP 151) write is gated by `paramIds.has(151)` — present on AIoT T2xxx clean-line devices
 * that report DP 151; absent on the legacy Tuya clean line (no confirmed power DP). The three
 * mode-control verbs (`startCleaning`, `returnToDock`, `pauseCleaning`) are gated by the presence of
 * DP 2/101 (Tuya path) or DP 152 (AIoT path) in `paramIds` and dispatch different DP shapes per
 * platform: legacy Tuya dispatches DP 2 (bool, start=true/pause=false) / DP 101 (bool, return=true),
 * AIoT dispatches DP 152 (ModeCtrlRequest protobuf). Each
 * AIoT mode-control verb carries its own `seq` counter per bind (the T2351 accepts per-closure
 * counters — two separately-obtained action objects both starting at 112 do not cause the device to
 * complain, so the seq is not enforced as globally monotonic).
 *
 * DP-gated additions: `doNotDisturb` (DP 107, Bool rw, suppresses voice prompts), `rssi` (DP 134,
 * WiFi signal strength) — present only when the device has reported those DPs. The `locate` action
 * (DP 103 / DP 160) is owned by the `locate` capability module.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const VACUUM_CLEAN_MEMBERS = {
  /**
   * The robot's power switch, and NOT a way to start a job — `startCleaning` is that.
   * DP 151 on the AIoT clean-line schema; absent on the Tuya clean line (no confirmed power DP).
   * Available when the device has reported DP 151 (i.e. it is an AIoT device).
   */
  power: {
    param: VACUUM_DP.POWER,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Power on/off (DP 151 power switch, cloud get_product_data_point).",
    write: (v, _ctx) => aiotDp(VACUUM_DP.POWER, asBool(v)),
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.POWER) ?? false,
  },
  /** Stored as the raw structured payload; the activity is decoded out of it at read time. */
  activity: {
    param: VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description: "High-level activity from WorkStatus.state (DP 153 work status, Raw protobuf).",
  },
  /**
   * The robot's own speaker loudness — its spoken prompts and chimes, nothing to do with suction noise.
   * Read-only: DP 161 is confirmed as a reported value but no write has been captured for it. Reaches
   * the getters only via `decodeState`, since the robot's cloud record carries no DPs at all.
   */
  volume: {
    param: VACUUM_DP.VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker volume 0-100 (DP 161, Value).",
  },
  /**
   * Charge percentage — DP 163 for the AIoT clean line; DP 104 for the legacy Tuya (G-series/X8)
   * via a `readAliases` entry gated on `isTuyaVacuum`. Deliberately NOT the security param 1101
   * the `battery` capability reads, so a robot's charge is here rather than on `dev.battery()`.
   * Read-only, populated only once a realtime report lands.
   */
  battery: {
    param: VACUUM_DP.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    readAliases: [{ paramType: LEGACY_VACUUM_DP.BATTERY_LEVEL }],
    description: "Battery level 0-100 (DP 163 AIoT / DP 104 Tuya). NOTE: clean namespace — not param 1101.",
  },
  /**
   * Device UI language — the locale the robot uses for its voice prompts (DP 162, String rw).
   * AIoT clean line only; the Tuya X8 Pro has no confirmed language DP in its 1–134 schema.
   * Write direction confirmed from `get_product_data_point` (`writable: true`); locale format is
   * an open string (no live report observed for a closed set of values yet).
   */
  language: {
    param: VACUUM_DP.LANGUAGE,
    type: "string",
    kind: "text",
    provenance: "mega",
    description: "Device UI language locale code (DP 162, String rw). AIoT clean line.",
    write: (v) => aiotDp(VACUUM_DP.LANGUAGE, v as string),
    writeAs: "setLanguage",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
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
    readAliases: [{ paramType: TUYA_VACUUM_DP.CLEAN_TYPE }],
    description: "Configured cleaning type from CleanParam.clean_type (DP 154 AIoT protobuf) or DP 113 Tuya Enum.",
  },
  /**
   * Error code from the legacy Tuya clean line (DP 106, Int ro). 0 = ok; non-zero is a device fault.
   * Exact fault code semantics have not been captured live.
   */
  errorCode: {
    param: LEGACY_VACUUM_DP.ERROR_CODE,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    description: "Error code, 0 = ok (DP 106, Int ro). Legacy Tuya G-series/X8 clean line.",
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
    param: TUYA_VACUUM_DP.CLEAR_TIME,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    description:
      "Session cleaning duration in seconds from DP 109 (ClearTime). X8 Pro Tuya clean line. Live-confirmed.",
  },
  /**
   * Session cleaned area in m² (DP 110, Value). Live-confirmed 54 at rest. Read-only.
   */
  clearArea: {
    param: TUYA_VACUUM_DP.CLEAR_AREA,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    description: "Session cleaned area in m² from DP 110 (ClearArea). X8 Pro Tuya clean line. Live-confirmed.",
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
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    description:
      "Lifetime total cleaning time in seconds from DP 119 (ClearTotalTime). X8 Pro Tuya clean line. Schema-confirmed.",
  },
  /**
   * Lifetime total cleaned area in m² (DP 120, Value). Counts across all sessions.
   * Confirmed from `thing.m.device.ref.info.list` v5.4 schemaInfo.schema (X8 Pro,
   * product `wahqax6ifjgs1c4n`). Read-only accumulator — no write expected.
   */
  lifetimeCleanArea: {
    param: TUYA_VACUUM_DP.CLEAR_TOTAL_AREA,
    type: "number",
    kind: "scalar",
    provenance: "mega",
    description:
      "Lifetime total cleaned area in m² from DP 120 (ClearTotalArea). X8 Pro Tuya clean line. Schema-confirmed.",
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
   * Do-not-disturb mode (DP 107, Bool rw). When `true` the robot suppresses voice announcements;
   * the app allows toggling this from its settings screen. Tuya clean line only — no equivalent
   * DP confirmed on AIoT. Schema-confirmed from `thing.m.device.ref.info.list` v5.4 (forbid_mode).
   */
  doNotDisturb: {
    param: TUYA_VACUUM_DP.FORBID_MODE,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Do-not-disturb mode (DP 107, Bool rw). X8 Pro Tuya clean line. Live-confirmed.",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(TUYA_VACUUM_DP.FORBID_MODE) ?? false,
    write: (v: unknown) => aiotDp(TUYA_VACUUM_DP.FORBID_MODE, asBool(v)),
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
   * Start an auto-clean run.
   * Tuya (DP 2 reported): DP 2 = true (PLAY_PAUSE bool).
   * AIoT (DP 152 reported): ModeCtrlRequest method 0 over DP 152.
   */
  startCleaning: method(
    ({ sink, ctx }) => {
      if (ctx.paramIds?.has(LEGACY_VACUUM_DP.PLAY_PAUSE)) {
        return (): Promise<void> => sink.dispatch(aiotDp(LEGACY_VACUUM_DP.PLAY_PAUSE, true));
      }
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, ++seq)));
    },
    "Start an auto-clean run (DP 2 = true for Tuya; DP 152 ModeCtrlRequest for AIoT).",
    (ctx) => (ctx.paramIds?.has(LEGACY_VACUUM_DP.PLAY_PAUSE) || ctx.paramIds?.has(VACUUM_DP.MODE_CTRL)) ?? false,
  ),
  /**
   * Return to the dock.
   * Tuya (DP 101 reported): DP 101 = true (GO_HOME bool).
   * AIoT (DP 152 reported): ModeCtrlRequest method 6 over DP 152.
   */
  returnToDock: method(
    ({ sink, ctx }) => {
      if (ctx.paramIds?.has(LEGACY_VACUUM_DP.GO_HOME)) {
        return (): Promise<void> => sink.dispatch(aiotDp(LEGACY_VACUUM_DP.GO_HOME, true));
      }
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GOHOME, ++seq)));
    },
    "Return to the dock (DP 101 bool for Tuya; DP 152 ModeCtrlRequest for AIoT).",
    (ctx) => (ctx.paramIds?.has(LEGACY_VACUUM_DP.GO_HOME) || ctx.paramIds?.has(VACUUM_DP.MODE_CTRL)) ?? false,
  ),
  /**
   * Pause the current cleaning task.
   * Tuya (DP 2 reported): DP 2 = false (PLAY_PAUSE bool).
   * AIoT (DP 152 reported): ModeCtrlRequest method 13 over DP 152.
   */
  pauseCleaning: method(
    ({ sink, ctx }) => {
      if (ctx.paramIds?.has(LEGACY_VACUUM_DP.PLAY_PAUSE)) {
        return (): Promise<void> => sink.dispatch(aiotDp(LEGACY_VACUUM_DP.PLAY_PAUSE, false));
      }
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, ++seq)));
    },
    "Pause the current cleaning task (DP 2 = false for Tuya; DP 152 ModeCtrlRequest for AIoT).",
    (ctx) => (ctx.paramIds?.has(LEGACY_VACUUM_DP.PLAY_PAUSE) || ctx.paramIds?.has(VACUUM_DP.MODE_CTRL)) ?? false,
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
      ...Object.values(LEGACY_VACUUM_DP),
      ...Object.values(TUYA_VACUUM_DP),
    ]);
    return params ? { params } : null;
  },
};
