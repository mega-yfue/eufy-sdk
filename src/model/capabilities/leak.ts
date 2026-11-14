import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `leak` feature, declared once — the property schema and the evidence-gated getters derive from here.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LEAK_MEMBERS = {
  /**
   * The alarm flag, modelled as state even though the sensor announces a leak as a PUSH EVENT rather
   * than by holding a param — so 1560 is a `guessed` placeholder and the evidence gate will normally
   * leave this getter uninstalled. The push event is the reliable channel for a leak; this read is
   * here so the flag has a home once a capture pins a real id.
   */
  leakDetected: {
    param: 1560,
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    description:
      "Water-leak detected. UNVERIFIED: actually delivered as a push event, not a state param; " +
      "placeholder id pending capture verification.",
  },
} as const satisfies Members;

/** Bound leak-sensor reads — the object returned by `dev.leak()`. Read-only. */
export type LeakActions = Surface<typeof LEAK_MEMBERS>;

/**
 * `leak` — water/leak (and freeze) sensor. Alarm flag is a placeholder — the T8920 Water & Freeze
 * sensor reports leak via a push event, not a stable param id.
 */
export const LEAK: CapabilityModule = {
  capability: "leak",
  description: "Water-leak / freeze sensor alarm state.",
  members: LEAK_MEMBERS,
  properties: propertiesOf(LEAK_MEMBERS),
  // Leak sensors expose no stable state param; the model/name (water/leak/freeze) is the signal.
  detection: { modelHints: [/water|leak|freeze/i] },
};
