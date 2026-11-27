import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/** The smoke alarm's last smoke event (`APP_CMD_SMOKE_SENSOR_LAST_SMOKE_EVT`, identifier `sensor_smoke_status`). */
const SMOKE_PARAM = 1823;

/**
 * Every `smoke` feature, declared once. No smoke alarm has been read yet, so the getter is present only
 * where an alarm reports its param.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const SMOKE_MEMBERS = {
  /**
   * Smoke is detected: bit 0 of the event bitfield, as the T90S0 and T8931 settings bundles read it
   * (`alarm: 0 != (1 & value)`). The other bits are testing, battery, trouble, muting and end of life.
   */
  smokeDetected: {
    param: SMOKE_PARAM,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    coerce: (raw) => (Number(raw) & 1) !== 0,
    description: "Smoke detected: bit 0 of 1823 (sensor_smoke_status).",
  },
} as const satisfies Members;

/** Bound smoke-detector reads — the object returned by `dev.smoke()`. Read-only. */
export type SmokeActions = Surface<typeof SMOKE_MEMBERS>;

/** `smoke` — smoke alarm (T90S0, T8931). */
export const SMOKE: CapabilityModule = {
  capability: "smoke",
  description: "Smoke detector alarm state.",
  members: SMOKE_MEMBERS,
  properties: propertiesOf(SMOKE_MEMBERS),
  /**
   * A reported smoke event param (1823) proves a smoke alarm, as does a product description listing
   * `sensor_smoke_status` — the app's own definition of one, which holds before the alarm has reported.
   * Never the device's name: that is what its owner typed.
   */
  detection: {
    evidenceParams: [SMOKE_PARAM],
    detect: (rec) => rec.things !== undefined && "sensor_smoke_status" in rec.things.properties,
  },
};
