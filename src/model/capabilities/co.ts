import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `co` feature, declared once — the property schema and the evidence-gated getters derive from here.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const CO_MEMBERS = {
  /**
   * The alarm flag itself — and the reason this capability is detected by model name rather than by a
   * reported param. 1562 is a `guessed` placeholder: nothing captured from a CO detector confirms the id
   * or which value means alarming, so the evidence gate installs this getter only on a device that
   * happens to report 1562. Promote it once a capture pins the id, not before.
   */
  coDetected: {
    param: 1562,
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    description: "Carbon-monoxide detected. UNVERIFIED: placeholder id pending capture verification.",
  },
} as const satisfies Members;

/** Bound CO-detector reads — the object returned by `dev.co()`. Read-only. */
export type CoActions = Surface<typeof CO_MEMBERS>;

/** `co` — carbon-monoxide detector. Alarm flag is a placeholder pending verification. */
export const CO: CapabilityModule = {
  capability: "co",
  description: "Carbon-monoxide (CO) detector alarm state.",
  members: CO_MEMBERS,
  properties: propertiesOf(CO_MEMBERS),
  // CO detectors expose no stable state param; the model/name (co/carbon) is the signal.
  detection: { modelHints: [/co\b|carbon/i] },
};
