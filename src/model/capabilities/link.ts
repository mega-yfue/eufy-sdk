import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `link` feature, declared once: the check-in and signal params a security device reports
 * whatever it is (sensor, keypad, lock), each getter present only where the device reports its param.
 * A capability with a reason to declare one of these properties itself takes precedence, since the
 * first declaration of a property wins and `link` is registered after every device capability.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LINK_MEMBERS = {
  /**
   * Unix seconds at which the device last checked in, as the device itself reports it — beside
   * `deviceState(sn).lastSeenMs`, which the SDK derives from the cloud's own update times. A
   * `timestamp` takes no `unit`: it is an instant, not a duration.
   */
  lastSeen: {
    param: 1551,
    type: "number",
    kind: "timestamp",
    provenance: "verified",
    description: "Last-seen unix timestamp, seconds (verified: param 1551).",
  },
  /** Link quality in dBm as the device measures it, never normalised to a bar count. */
  rssi: {
    param: 1141,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "verified",
    description: "Sub-1G/Wi-Fi signal strength (verified: param 1141 = RSSI).",
  },
} as const satisfies Members;

/** Bound check-in and signal reads — the object returned by `dev.link()`. Read-only. */
export type LinkActions = Surface<typeof LINK_MEMBERS>;

/** `link` — the check-in timestamp and signal strength a security device reports. */
export const LINK: CapabilityModule = {
  capability: "link",
  description: "Check-in timestamp and signal strength, as the device reports them.",
  members: LINK_MEMBERS,
  properties: propertiesOf(LINK_MEMBERS),
  detection: { evidenceParams: [1551, 1141] },
};
