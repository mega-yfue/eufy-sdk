import { kindRoutable, method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";

/** The P2P feature-command id this capability drives. */
export const TREAT_CMD = {
  /**
   * Toss a treat: inner command of a `SET_PAYLOAD` (1350) envelope, `payload.value` = the distance. Taken from
   * the eufy Pet app's dog-camera live view, which builds this request when the toss gesture is released.
   * ✅ Verified live on a T7200 (firmware 1.0.8.8): one envelope per toss at each of the three distances
   * gave one launch each, short, middle and long.
   */
  TOSS: 7001,
} as const;

/** The state param this capability reads. */
export const TREAT_PARAM = {
  /**
   * Time of the last toss, unix seconds. ✅ Observed on a T7200: it moved to the toss time on every toss,
   * from the app and from the SDK, within 1-3 s of the command, and at no other time.
   */
  LAST_TOSS: 8103,
} as const;

/**
 * The three toss distances, by name, and the `payload.value` each is sent as. The app picks one per toss;
 * the device stores no distance setting.
 */
export const TOSS_DISTANCES = { near: 1, middle: 2, far: 3 } as const;

/** A toss distance, by name. */
export type TossDistance = keyof typeof TOSS_DISTANCES;

/** The DeviceType the vendor app opens its dog-camera live view (and so its toss control) for. */
const DOG_CAMERA_TYPE = 72;

/**
 * The models the toss write is confirmed on. A sibling dog camera (T7203) shares the device type but has not
 * been tried, so it is not offered the write until someone who owns one confirms it.
 */
const TOSS_VERIFIED_MODELS: ReadonlySet<string> = new Set(["T7200"]);

/**
 * Offered where the toss is confirmed: a verified model on its own station. The once-only send it needs is
 * confirmed on a device's own keyless session only, so a camera attached to a HomeBase is not offered it.
 */
const tossVerified = (ctx: CommandContext): boolean =>
  ctx.model !== undefined &&
  TOSS_VERIFIED_MODELS.has(ctx.model) &&
  ctx.homeBaseAttached !== true &&
  kindRoutable("set-payload", ctx);

/** The value the device takes for a distance name, or `undefined` for anything else. */
function tossValue(distance: unknown): number | undefined {
  return typeof distance === "string" && Object.hasOwn(TOSS_DISTANCES, distance)
    ? TOSS_DISTANCES[distance as TossDistance]
    : undefined;
}

/**
 * Every `treat` feature, declared once.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on, which the
 * reference site does not carry.
 * @internal
 */
export const TREAT_MEMBERS = {
  /** When the launcher last tossed, unix seconds. Two tosses between reads show as one change. */
  lastTossAt: {
    param: TREAT_PARAM.LAST_TOSS,
    type: "number",
    kind: "timestamp",
    provenance: "verified",
    description:
      "Time of the last treat toss, unix seconds (param 8103). Moves on every toss, whoever sent it; it cannot " +
      "count tosses closer together than one read.",
  },
  /**
   * Toss one treat. A `method` because the distance is an argument of the toss itself, not a stored setting.
   *
   * A launch is not idempotent, so the envelope is a `set-payload` marked `once`: one sequence, repeated only until
   * the device acknowledges it, never replayed as separate frames and never resent after a timeout or a result
   * code. The device returned no command result in testing, so the promise settles at the handoff to the local
   * transport, not when the treat lands; `lastTossAt` is the confirmation. A toss that cannot go out soon after it
   * is requested is not sent at all.
   */
  toss: {
    ...method(
      ({ ctx, sink }) =>
        (distance: TossDistance): Promise<void> => {
          const value = tossValue(distance);
          if (value === undefined) {
            return Promise.reject(
              new Error(`toss: ${String(distance)} is not one of ${Object.keys(TOSS_DISTANCES).join(", ")}`),
            );
          }
          return sink.dispatch({
            kind: "set-payload",
            cmd: TREAT_CMD.TOSS,
            payload: { value },
            channel: ctx.channel,
            once: true,
          });
        },
      "Toss one treat at the given distance: one toss request, never replayed or resent. Settles when handed to the " +
        "local transport; lastTossAt confirms the toss.",
      tossVerified,
    ),
    args: [
      {
        name: "distance",
        kind: "enum",
        values: Object.keys(TOSS_DISTANCES),
        description: "How far to toss: near, middle or far.",
      },
    ],
  },
} as const satisfies Members;

/** Bound treat launcher reads and controls — the object returned by `dev.treat()`. */
export type TreatActions = Surface<typeof TREAT_MEMBERS>;

/** `treat` — a dog camera's treat launcher. */
export const TREAT: CapabilityModule = {
  capability: "treat",
  description: "Treat launcher on a dog camera: toss a treat at a chosen distance; time of the last toss.",
  members: TREAT_MEMBERS,
  properties: propertiesOf(TREAT_MEMBERS),
  // The last-toss param is the launcher reporting itself, and only a T7200 has been seen reporting it. The
  // device type is the vendor app's own dog-camera gate, kept for a camera that has never tossed and so may not
  // report 8103 yet. On a model without a verified toss (T7203) that leaves `treat()` with only what it reports.
  detection: { evidenceParams: [TREAT_PARAM.LAST_TOSS], deviceTypes: [DOG_CAMERA_TYPE] },
};
