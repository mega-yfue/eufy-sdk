import { isAiotVacuum, isTuyaVacuum } from "../device-family.js";
import { TUYA_VACUUM_DP } from "./vacuum-clean.js";
import { pickDpParams, aiotDp } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/** DP id for the locate (find-robot) toggle. */
const LOCATE_DP = 160 as const;
/**
 * DP id for the locate (find-robot) toggle on the Tuya clean line (G-series / X8) — the vendor's
 * `look_for_sweeper`. Taken from the clean capability's own table rather than respelled here, so the
 * Tuya line's ids have one home.
 */
const LEGACY_LOCATE_DP = TUYA_VACUUM_DP.LOOK_FOR_SWEEPER;

/**
 * Every `locate` feature, declared once.
 *
 * `locate()` is a `method` rather than a derived setter because its argument is OPTIONAL — the
 * common call is a bare `locate()` meaning "start beeping" — and a derived setter always takes its
 * value. Dispatches DP 103 (legacy Tuya) or DP 160 (AIoT) based on which DP the device has reported.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LOCATE_MEMBERS = {
  /**
   * The find-robot DP read back. `writtenElsewhere` rather than carrying its own `write`, because the
   * setter is the `locate` method below — its argument is optional, which a derived setter cannot be.
   * Expect this to read `undefined` on most robots: DP 160 is a momentary trigger, so a device that has
   * never been asked to beep has no value to report and the evidence gate skips the getter entirely.
   */
  locating: {
    param: LOCATE_DP,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    writtenElsewhere: true,
    readAliases: [{ paramType: LEGACY_LOCATE_DP, available: isTuyaVacuum }],
    description:
      "Find-robot trigger (DP 160 AIoT / DP 103 Tuya). A momentary write trigger — the device sends it to begin or " +
      "cancel a beep but holds no durable state, so this may never be observed true in practice.",
  },
  /**
   * Writes DP 160 (AIoT) or reported DP 103 (Tuya). Both start and cancel on the
   * Tuya path were physically tested on X8 Pro / T2276 only. The default
   * argument is what makes this a `method`: a bare `locate()` is the call that matters, and a derived
   * setter always demands its value.
   *
   * That default is also why the argument is named here: it is absent from the function's arity, so the
   * description would otherwise derive as taking NO arguments and leave the cancel form undeclared.
   */
  locate: {
    ...method(
      ({ sink, ctx }) =>
        (on = true): Promise<void> =>
          sink.dispatch(aiotDp(isTuyaVacuum(ctx) ? LEGACY_LOCATE_DP : LOCATE_DP, on)),
      "Trigger the find-robot beep; pass false to cancel. Tuya tested only on X8 Pro / T2276.",
      (ctx) => isAiotVacuum(ctx) || (isTuyaVacuum(ctx) && (ctx.paramIds?.has(LEGACY_LOCATE_DP) ?? false)),
    ),
    args: [{ name: "on", kind: "boolean", optional: true, description: "False cancels a beep in progress." }],
  },
} as const satisfies Members;

/**
 * Bound locate reads and controls — the object returned by `dev.locate()`. The `locating` read is
 * present only when the device has reported DP 160; `locate()` is always present on a bound device.
 */
export type LocateActions = Surface<typeof LOCATE_MEMBERS>;

/** `locate` — make the robot beep to find it. */
export const LOCATE: CapabilityModule = {
  capability: "locate",
  line: "clean",
  description: "Locate the device (RoboVac 'find robot' beep).",
  members: LOCATE_MEMBERS,
  properties: propertiesOf(LOCATE_MEMBERS),
  // Locate is a vacuum-codec baseline.
  detection: { codecs: ["vacuum"] },
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [LOCATE_DP, LEGACY_LOCATE_DP]);
    return params ? { params } : null;
  },
};
