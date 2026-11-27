import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * The water sensor's own param ids, each the app's own (`APP_CMD_*` in the product's settings bundle,
 * the same number in every bundle that defines it).
 */
export const LEAK_PARAM = {
  /** Water detected (`APP_CMD_WATER_SENSOR_WATER_STATE`, identifier `sensor_water_status`). */
  WATER: 1820,
  /** Temperature below the threshold (`APP_CMD_WATER_SENSOR_TEMPERATE_LOW`, `sensor_temperature_low_status`). */
  LOW_TEMPERATURE: 1822,
  /** Low-temperature alarm threshold, °F (`APP_CMD_WATER_SENSOR_TEMPERATURE_ALARM`). */
  LOW_TEMPERATURE_THRESHOLD: 1873,
} as const;

/**
 * Every `leak` feature, declared once. The params are read as the app's settings bundle reads them
 * (`asBoolean` for the two states, `asInt` for the threshold); no water sensor has been read yet, so
 * each getter is present only where a sensor reports its param.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LEAK_MEMBERS = {
  /**
   * Water is detected. The app's own `event_sensor_water_detected_notify` is this param changing, so
   * the state and the alert are one fact.
   */
  leakDetected: {
    param: LEAK_PARAM.WATER,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Water detected (1820, sensor_water_status).",
  },
  /** The temperature is below {@link LEAK_MEMBERS.lowTemperatureThreshold}: the freeze alarm. */
  lowTemperature: {
    param: LEAK_PARAM.LOW_TEMPERATURE,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Temperature below the alarm threshold (1822, sensor_temperature_low_status).",
  },
  /**
   * The temperature, in °F, below which the freeze alarm fires: one of 32, 33, 35, 37 or 40 as the
   * product's description lists them. The write is the bundle's `1350` SET_PAYLOAD on 1873, not yet run
   * on a device, so no setter is installed.
   */
  lowTemperatureThreshold: {
    param: LEAK_PARAM.LOW_TEMPERATURE_THRESHOLD,
    type: "number",
    kind: "enum",
    enumValues: { 32: "32°F", 33: "33°F", 35: "35°F", 37: "37°F", 40: "40°F" },
    thing: ["sensor_low_temperature_alarm_threshold"],
    provenance: "apk",
    unverified: true,
    description: "Freeze alarm threshold, °F: 32, 33, 35, 37 or 40 (1873, sensor_low_temperature_alarm_threshold).",
  },
} as const satisfies Members;

/** Bound water-sensor reads — the object returned by `dev.leak()`. Read-only. */
export type LeakActions = Surface<typeof LEAK_MEMBERS>;

/** `leak` — water and freeze sensor (T8920, T90F0). */
export const LEAK: CapabilityModule = {
  capability: "leak",
  description: "Water-leak and freeze sensor: water and low-temperature state, and the freeze threshold.",
  members: LEAK_MEMBERS,
  properties: propertiesOf(LEAK_MEMBERS),
  /**
   * A reported water-state param (1820) proves a water sensor, as does a product description listing
   * `sensor_water_status` — the app's own definition of one, which holds before the sensor has reported.
   * Never the device's name: that is what its owner typed.
   */
  detection: {
    evidenceParams: [LEAK_PARAM.WATER],
    detect: (rec) => rec.things !== undefined && "sensor_water_status" in rec.things.properties,
  },
};
