import { isChargingState } from "./battery.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `keypad` feature, declared once. `charging` follows the app's own decode of the keypad's charger
 * state.
 *
 * `batteryLow` is `unexposed`: the app maps its param to the same low-battery field the entry and motion
 * sensors feed, but its value decode is absent from the app's parser, so the polarity is not evidenced.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const KEYPAD_MEMBERS = {
  /**
   * `APP_CMD_KEYPAD_BATTERY_CAP_STATE` (1653). The app's sensor parser maps it to `sensor_is_low_power`,
   * the field `APP_CMD_ENTRY_SENSOR_BAT_STATE` and `APP_CMD_MOTION_SENSOR_BAT_STATE` decode as a boolean,
   * yet gives 1653 itself no decode case. `unexposed` until a device confirms which value means low; in
   * the schema for `getProperty`, absent from the typed surface.
   */
  batteryLow: {
    param: 1653,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    unexposed: true,
    description:
      "Keypad low-battery flag (APP_CMD_KEYPAD_BATTERY_CAP_STATE, 1653). UNVERIFIED polarity: the app " +
      "names it its low-battery field but does not decode its value.",
  },
  /**
   * `APP_CMD_KEYPAD_BATTERY_CHARGER_STATE` (1655), decoded the way the app's sensor parser decodes it:
   * `charging = value ∉ {0,2}` ({@link isChargingState}).
   */
  charging: {
    param: 1655,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    coerce: isChargingState,
    description:
      "Keypad charging — derived from APP_CMD_KEYPAD_BATTERY_CHARGER_STATE (1655) as `value ∉ {0,2}`, " +
      "matching the app's own decode.",
  },
} as const satisfies Members;

/** Bound keypad reads — the object returned by `dev.keypad()`. Read-only. */
export type KeypadActions = Surface<typeof KEYPAD_MEMBERS>;

/** `keypad` — security keypad. Charging, battery-low and signal. */
export const KEYPAD: CapabilityModule = {
  capability: "keypad",
  description: "Security keypad battery and signal state.",
  members: KEYPAD_MEMBERS,
  properties: propertiesOf(KEYPAD_MEMBERS),
  detection: { codecs: ["keypad"] },
};
