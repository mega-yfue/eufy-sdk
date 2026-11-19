import type { CapabilityModule } from "./types.js";
import { propertiesOf, type Members, type Surface } from "./members.js";

/**
 * `display` — a eufy Smart Display's charge.
 *
 * One typed read, and the smallness is the finding rather than a gap. The captured unit (a T87A0,
 * 2026-09-04) connects over secure MQTT with no `p2p_did`, so it speaks no P2P at all, and it reported
 * six params in an id range no other line uses. Only one of them tells a caller something it could not
 * get another way:
 *
 *  - 8005 and 8006 restate the model's retail name and code, which `info` already answers from the
 *    curated registry and the cloud record. Their evidence IS that agreement, so a getter beside `info`
 *    would offer a caller a second spelling of what it just read. They are named in the display param
 *    dictionary, which is what makes them readable off `getProperties()`.
 *  - 8003 is version-shaped and nothing confirms what it means, so it is `unexposed`: in the schema with
 *    its type, reachable through `getProperty`, no typed getter.
 *
 * Nothing is writable. No capture pins a write for any display param, and an AIoT write is
 * fire-and-forget, so a wrong frame to a device that acknowledges nothing looks exactly like success. A
 * screen, a volume, an assistant: the device plainly has all three and reports none of them in anything
 * captured, which means the reads have to arrive before a control can be honest about what it moves.
 *
 * @module model/capabilities/display
 */

/** Smart Display param ids this capability reads. The rest of the range is named in the dictionary. */
export const DISPLAY_PARAM = { BATTERY: 8001, SOFTWARE_VERSION: 8003 } as const;

/**
 * The `display` reads. Read-only; see the module note for why there is no write.
 *
 * Exported but NOT published: the entries state their wire ids and what each claim rests on, which the
 * reference site does not carry.
 * @internal
 */
export const DISPLAY_MEMBERS = {
  /**
   * Battery level, 0-100.
   *
   * **On this capability rather than on `battery`, and that is the line partition doing its job.** The
   * security-line `battery` capability reads param 1101 and a Smart Display's charge is 8001 in its own
   * id space — two wires that happen to mean the same thing. One capability reading both would be a claim
   * that the two ecosystems share a param space, so a consumer reads a display's charge through
   * `dev.display()` and a camera's through `dev.battery()`.
   *
   * The id is in the device's cloud record; the NAME comes from the hardware's owner rather than the
   * cloud data-point list, and `"100"` fits brightness, volume or charge equally.
   *
   * The scale is `percent` on the reading itself, not on convention alone: a full charge reads `255` on a
   * 0-255 scale and `1000` on a 0-1000 one, so `"100"` on a charged unit is positive evidence for 0-100
   * rather than merely consistent with it. What nobody has done is watch it MOVE, which is why a value
   * frozen at 100 would not yet be distinguishable from a healthy one.
   */
  battery: {
    param: DISPLAY_PARAM.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    description: "Battery level, 0-100 (param 8001).",
  },
  /**
   * Version-shaped, and that shape is the whole of the evidence, hence no typed getter.
   *
   * `unexposed` rather than absent, so the schema still carries its type and
   * `getProperty("softwareVersion")` still answers. `dev.info()?.firmwareVersion` is the field to trust
   * where the cloud record carries one; on this display it does not, which is the only reason 8003 is
   * named at all.
   */
  softwareVersion: {
    param: DISPLAY_PARAM.SOFTWARE_VERSION,
    type: "string",
    kind: "text",
    unexposed: true,
    description: "Version-shaped string (param 8003), meaning unconfirmed — prefer `info.firmwareVersion`.",
  },
} as const satisfies Members;

/** `display` — a eufy Smart Display (T87Ax). Read-only; no display write is captured. */
export const DISPLAY: CapabilityModule = {
  capability: "display",
  line: "display",
  description: "Smart Display battery level (param 8001, display namespace).",
  members: DISPLAY_MEMBERS,
  properties: propertiesOf(DISPLAY_MEMBERS),
  /**
   * Claimed by CODEC, not by an evidence param.
   *
   * 8001 is in the device's cloud record, so the ordinary evidence gate would install the getter anyway
   * — but the capability should attach to a Smart Display that has reported nothing yet too, because a
   * device on this line has no other capability to carry it. The line partition keeps this off
   * everything else: `display` is the only codec in the `display` line.
   */
  detection: { codecs: ["display"] },
};

/** Bound Smart Display reads — the object returned by `dev.display()`. Read-only. */
export type DisplayActions = Surface<typeof DISPLAY_MEMBERS>;
