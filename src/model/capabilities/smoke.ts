import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `smoke` feature, declared once — the property schema and the evidence-gated getters derive from here.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const SMOKE_MEMBERS = {
  /**
   * The alarm flag itself — and the reason this capability is detected by model name rather than by a
   * reported param. 1561 is a `guessed` placeholder: nothing captured from a smoke detector confirms the
   * id or which value means alarming, so the evidence gate installs this getter only on a device that
   * happens to report 1561. Promote it once a capture pins the id, not before.
   */
  smokeDetected: {
    param: 1561,
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    description: "Smoke detected. UNVERIFIED: placeholder id pending capture verification.",
  },
} as const satisfies Members;

/** Bound smoke-detector reads — the object returned by `dev.smoke()`. Read-only. */
export type SmokeActions = Surface<typeof SMOKE_MEMBERS>;

/** `smoke` — smoke detector. Alarm flag is a placeholder pending verification. */
export const SMOKE: CapabilityModule = {
  capability: "smoke",
  description: "Smoke detector alarm state.",
  members: SMOKE_MEMBERS,
  properties: propertiesOf(SMOKE_MEMBERS),
  // Smoke detectors expose no stable state param; the model/name is the reliable signal.
  detection: { modelHints: [/smoke/i] },
};
