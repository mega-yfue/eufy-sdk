import type { AvailabilityContext, CapabilityModule, CapabilityActions } from "./types.js";
import { asBool, enumLabels } from "../../core/util.js";
import { pickDpParams, aiotDp } from "./access.js";
import { propertiesOf, type Members, type Surface, type MemberDeps } from "./members.js";
import { isAiotVacuum } from "../device-family.js";

/**
 * RoboVac suction Tuya **DP ids** — this capability's own wire vocabulary (clean namespace, from the
 * cloud `get_product_data_point` schema). Named like the P2P feature-command consts so a DP is
 * referenced by meaning rather than a magic number.
 */
export const SUCTION_DP = {
  /** Suction level (DP 158, Enum). */
  SUCTION: 158,
  /** BoostIQ auto-suction on/off (DP 159, Bool). */
  BOOST_IQ: 159,
} as const;

/**
 * Suction levels — the app's `SuctionEnum` (`getSuctionEnumByValue`). This is a **fixed** value→label
 * map with **no model argument**: a given int means the same thing on every RoboVac. What varies per
 * model is only **availability** — a device's `get_product_data_point` range may expose a narrower
 * subset (the T2351 catalog lists 0-3) — so the `suction` property stays a raw int rather than being
 * constrained per device, and {@link suctionLevelName} names a reported level.
 *
 * `BoostIQ` (4) is a real suction level in this scale. The separate `boostIq`
 * boolean (DP 159) is the independent auto-suction toggle — a device may report both, and they don't
 * contradict.
 */
export const SuctionLevel = {
  Quiet: 0,
  Standard: 1,
  Turbo: 2,
  Max: 3,
  BoostIQ: 4,
  MaxPro: 5,
} as const;
export type SuctionLevelValue = (typeof SuctionLevel)[keyof typeof SuctionLevel];

/** The `suction` property's `enumValues`, derived from {@link SuctionLevel} so the scale is named once. */
const SUCTION_LABEL: Record<number, string> = enumLabels(SuctionLevel);

/** All six levels — the fallback when the catalog is absent or doesn't cover DP 158. */
const ALL_SUCTION_LEVELS: readonly SuctionLevelValue[] = [0, 1, 2, 3, 4, 5];

/**
 * The {@link SuctionLevel} a catalog range member stands for: a level name (`"Quiet"`) or its numeric
 * string (`"0"`). `undefined` for a member outside the known scale.
 */
function levelFromCatalog(member: string): SuctionLevelValue | undefined {
  if (Object.hasOwn(SuctionLevel, member)) return SuctionLevel[member as keyof typeof SuctionLevel];
  const n = Number(member);
  return Number.isInteger(n) && n in SUCTION_LABEL ? (n as SuctionLevelValue) : undefined;
}

/**
 * The label for a raw suction int, per the app's `SuctionEnum`, or `undefined` for a value outside the
 * known scale. The mapping is global (not per-model) — see {@link SuctionLevel}.
 */
export function suctionLevelName(value: number): string | undefined {
  return SUCTION_LABEL[value];
}

/**
 * Bound suction reads and controls — the object returned by `dev.suction()`.
 *
 * `setSuctionLevel` is DERIVED from the `level` member entry; `supportedLevels` is the only addition
 * from `actions()` — it names the per-SKU DP 158 range but is not itself a device param.
 */
export type SuctionActions = Surface<typeof SUCTION_MEMBERS> & {
  /**
   * The suction levels this device supports, sourced from the per-SKU `get_product_data_point` catalog
   * range for DP 158. Narrower than the full six {@link SuctionLevel} values on many models — a T2351's
   * catalog lists `Quiet`, `Standard`, `Turbo` and `Max`, which answers `[0, 1, 2, 3]`.
   *
   * `undefined` when the catalog is absent or does not cover DP 158. Only meaningful on devices where
   * `setSuctionLevel` is installed (AIoT vacuums).
   */
  readonly supportedLevels?: readonly SuctionLevelValue[];
};

/**
 * Every `suction` read and write — `setSuctionLevel` (DP 158, via `writeAs`) and `setBoostIq`
 * (DP 159) are both derived from this table.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const SUCTION_MEMBERS = {
  /**
   * Narrowed to the known scale, which is NARROWER THAN THE WIRE: the level
   * arrives as a plain integer and a firmware reporting a value outside {@link SuctionLevel} would be
   * typed as one of these regardless. {@link suctionLevelName} stays total for that reason — it answers
   * `undefined` for an int it does not recognise, so an unexpected level surfaces as unnamed rather than
   * mislabelled.
   */
  level: {
    param: SUCTION_DP.SUCTION,
    property: "suction",
    type: "number",
    kind: "enum",
    enumValues: SUCTION_LABEL,
    provenance: "mega",
    decode: (raw) => (typeof raw === "number" ? (raw as SuctionLevelValue) : undefined),
    decodedKind: "enum",
    decodedValues: ALL_SUCTION_LEVELS,
    write: (v) => aiotDp(SUCTION_DP.SUCTION, v as number),
    writeAs: "setSuctionLevel",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    description:
      "Suction level (DP 158, raw int per the fixed SuctionEnum). The labels name the WHOLE scale, " +
      "not this robot's menu: the SuctionEnum meaning is global (see SuctionLevel) while WHICH levels " +
      "a model offers varies, so a value is named correctly even on a robot that cannot select it, " +
      "and an int outside the scale stays unnamed. BoostIQ (4) is a level here; the boostIq bool is " +
      "the separate auto-suction toggle.",
  },
  /**
   * The auto-suction toggle — an independent boolean, NOT the `BoostIQ` entry in the suction scale. A
   * robot may report both at once without contradicting itself: `level` says which power the robot is
   * fixed at, this says whether it may raise it by itself on carpet. Writable straight from the table
   * because DP 159 is a plain bool with no per-model range to validate against, unlike `level`.
   */
  boostIq: {
    param: SUCTION_DP.BOOST_IQ,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "BoostIQ auto-suction (DP 159, Bool).",
    write: (v) => aiotDp(SUCTION_DP.BOOST_IQ, asBool(v)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
} as const satisfies Members;

/** `suction` — vacuum suction power level (RoboVac). */
export const SUCTION: CapabilityModule = {
  capability: "suction",
  line: "clean",
  description: "Vacuum suction power level (Tuya DP).",
  members: SUCTION_MEMBERS,
  properties: propertiesOf(SUCTION_MEMBERS),
  detection: { codecs: ["vacuum"] },
  /**
   * Land this capability's data points from a realtime report — the robot's cloud record does not carry
   * them, so without this the evidence gate installs neither getter. Only the two ids this capability
   * owns are taken; the rest of a report belongs to the other clean modules.
   */
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, Object.values(SUCTION_DP));
    return params ? { params } : null;
  },
  /**
   * The per-model level range — sourced from the SKU's `get_product_data_point` catalog for DP 158
   * when available. `undefined` when no catalog entry exists for DP 158. `setSuctionLevel` is only
   * installed on AIoT devices (gated by `available: isAiotVacuum` on the `level` entry), so
   * `supportedLevels` is harmless data on a non-AIoT device.
   */
  actions({ ctx }: MemberDeps): CapabilityActions {
    const catalogRange = ctx.dpCatalog?.enumRanges.get(SUCTION_DP.SUCTION);
    const supportedLevels = catalogRange?.map(levelFromCatalog).filter((v): v is SuctionLevelValue => v !== undefined);
    return { supportedLevels } as unknown as CapabilityActions;
  },
};
