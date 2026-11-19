/**
 * `eufy_life` DP param space — the tag ids a T8L0x smart light reports on its own realtime wire.
 *
 * These are **DP tag numbers, not cloud param ids**, and they live in their own namespace because the
 * numbers collide: tag `0xa3` = 163 means strip length here and battery level in the vacuum DP space.
 * The read-side meanings are also unrelated to the write-side tags that share the same numbers on the
 * outbound leg (`0xa1` is a timestamp there, power here) — device→app and app→device are two separate
 * mappings over one tag range.
 *
 * CONFIRMED two ways (2026-07-28): decoded live off a real T8L02's status reports, matching the app's
 * own `deviceInfoPayloadDataParse` transcription field for field. Each entry's DP tag and the app's
 * field name for it are noted beside it.
 *
 * Names match the `PropertySpec.name`s in `capabilities/smart-light.ts` so a value resolves to the same
 * property whether it arrives through this dictionary or the capability's own spec table.
 *
 * @module model/life-params
 */
import type { ParamDef } from "./param-dictionary.js";

/** Tag ids a `eufy_life` light reports. Only fields whose meaning is evidenced appear here. */
export const LIFE_PARAMS: Record<number, ParamDef> = {
  /** DP tag `0xa1` `spotlight_switch`. */
  161: { name: "lightPower", type: "bool" },
  /** DP tag `0xa2` `device_light_brightness`, 0-100. */
  162: { name: "lightBrightness", type: "number" },
  /** DP tag `0xa3` `light_length` (segment count). */
  163: { name: "lightLength", type: "number" },
  /** DP tag `0xa4` `light_effect_id`, u32LE. */
  164: { name: "lightEffectId", type: "number" },
  /** DP tag `0xa5` `color_gradient_switch`. */
  165: { name: "lightColorGradient", type: "bool" },
  /** DP tag `0xa6` `cloud_light_effect_id` — the ACTIVE effect, 0 when off. */
  166: { name: "lightCloudEffectId", type: "number" },
  /** DP tag `0xa7` `light_effect_mode` on a status report; the value space is not evidenced. */
  167: { name: "lightEffectMode", type: "number" },
};
