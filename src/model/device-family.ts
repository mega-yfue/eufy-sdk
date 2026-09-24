/**
 * Device-family **classification** — the single home for the one question "what product family is
 * this device?" (indoor cam, mini, S350 pan/tilt, outdoor pan/tilt, floodlight, wired doorbell, …),
 * a set of pure predicates over the vendor `DeviceType`.
 *
 * These predicates are PURE and param-agnostic: they answer family membership only. The per-param
 * *semantics* a family implies — 1035 enable-bit vs disable-bit polarity, the 1400 light-switch
 * frame shape — deliberately do NOT live here; each capability composes those from these predicates
 * (see `capabilities/camera.ts` `isEnableBitPolarity`, `capabilities/light.ts` `lightSwitchWire`).
 * And the P2P encryption LEVEL (L1 vs L2) is not a family trait at all: it is a runtime *topology*
 * fact (standalone vs HomeBase-attached) resolved at send time in the transport. Keeping this file
 * classification-only is what lets one predicate be reused across capabilities without dragging a
 * param id or a wire form along with it.
 *
 * ## Detection is mega-only — no legacy fallback
 * The legacy cloud backend is frozen (a stub) and cannot identify equipment. Classification here
 * keys **exclusively** off the mega-resolved record: the vendor `deviceType` that
 * {@link module:model/capabilities.CommandContext} already carries from the mega `algo_ecdh` device
 * list. When `deviceType` is absent/unknown we DO NOT guess: predicates return `false`, so a
 * capability composing on them falls back to its safe default rather than mis-classifying the device.
 *
 * @module model/device-family
 */
import { DeviceType } from "./device-types.js";

/** The evidence a family decision needs — a structural subset of `CommandContext`. */
export interface FamilyContext {
  /** eufy vendor DeviceType, when known (undefined ⇒ unknown ⇒ don't guess). */
  deviceType?: number;
  /** Model / T-code, when known. */
  model?: string;
  /**
   * API category string — e.g. `"eufy_home"`, `"eufy_home_tuya"`, `"eufy_security"`. Supplied by
   * the mega `get_devs_list` response; absent in unit-test contexts that build a minimal context
   * without a real API record. Used as the PRIMARY transport discriminator for the clean line:
   * `"eufy_home_tuya"` devices are on the ThingClips/Tuya Cloud platform, not Anker AIoT MQTT.
   */
  category?: string;
}

// ── DeviceType sets ─────────────────────────────────────────────────────────────────────────────

/** Indoor cams, incl. indoor pan/tilt + S350/E30/C-series + mini. */
export const INDOOR_CAMERA_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.INDOOR_CAMERA,
  DeviceType.INDOOR_CAMERA_1080,
  DeviceType.INDOOR_PT_CAMERA,
  DeviceType.INDOOR_PT_CAMERA_1080,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P_NO_LIGHT,
  DeviceType.INDOOR_OUTDOOR_CAMERA_2K,
  DeviceType.INDOOR_COST_DOWN_CAMERA,
  DeviceType.INDOOR_PT_CAMERA_S350,
  DeviceType.INDOOR_PT_CAMERA_E30,
  DeviceType.INDOOR_PT_CAMERA_C210,
  DeviceType.INDOOR_PT_CAMERA_C220,
  DeviceType.INDOOR_PT_CAMERA_C220_V2,
]);

/** Indoor pan/tilt S350 family. */
export const INDOOR_PT_S350_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.INDOOR_PT_CAMERA_S350,
  DeviceType.INDOOR_PT_CAMERA_E30,
  DeviceType.INDOOR_PT_CAMERA_C210,
  DeviceType.INDOOR_PT_CAMERA_C220,
  DeviceType.INDOOR_PT_CAMERA_C220_V2,
]);

/** Outdoor pan/tilt + solo-PT. */
export const OUTDOOR_PT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.OUTDOOR_PT_CAMERA,
  DeviceType.SOLO_CAMERA_E30,
  DeviceType.CAMERA_S4,
  DeviceType.SOLOCAM_E42,
  DeviceType.CAMERA_4G_S330,
]);

/** Floodlight cams. */
export const FLOODLIGHT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.FLOODLIGHT,
  DeviceType.FLOODLIGHT_CAMERA_8422,
  DeviceType.FLOODLIGHT_CAMERA_8423,
  DeviceType.FLOODLIGHT_CAMERA_8424,
  DeviceType.FLOODLIGHT_CAMERA_8425,
  DeviceType.FLOODLIGHT_CAMERA_8426,
]);

/** Wall-light cams. */
export const WALL_LIGHT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.WALL_LIGHT_CAM,
  DeviceType.WALL_LIGHT_CAM_81A0,
]);

/**
 * HomeBase-family hubs — the station-class devices with a built-in **speaker + alarm siren**, so
 * they own the hub-audio surface (alarm / voice-prompt volume). A deliberate SUBSET of the `station`
 * codec that EXCLUDES the NVRs (S4 Max, PoE NVR): those resolve to `station` for arming/storage but
 * have no speaker, so they must NOT expose the hub-audio controls (they'd fire at nothing). The
 * alarm/prompt wire is verified on HomeBase 3 (HB3); the other hubs, T9000 (`STATION_9000`) included,
 * share the hub hardware.
 */
export const HOMEBASE_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.STATION,
  DeviceType.HB3,
  DeviceType.STATION_9000,
  DeviceType.MINIBASE_CHIME,
  DeviceType.HOMEBASE_MINI,
]);

// ── Family predicates ───────────────────────────────────────────────────────────────────────────

const has = (set: ReadonlySet<number>, t: number | undefined): boolean => t !== undefined && set.has(t);

/** Indoor camera (any indoor variant). */
export const isIndoorCamera = (ctx: FamilyContext): boolean => has(INDOOR_CAMERA_TYPES, ctx.deviceType);
/** Indoor cost-down "mini" cam. */
export const isIndoorCamMini = (ctx: FamilyContext): boolean => ctx.deviceType === DeviceType.INDOOR_COST_DOWN_CAMERA;
/** Indoor pan/tilt S350 family. */
export const isIndoorPanTiltS350 = (ctx: FamilyContext): boolean => has(INDOOR_PT_S350_TYPES, ctx.deviceType);
/** Outdoor pan/tilt (+ solo-PT) family. */
export const isOutdoorPanTilt = (ctx: FamilyContext): boolean => has(OUTDOOR_PT_TYPES, ctx.deviceType);
/** Floodlight cam family. */
export const isFloodLight = (ctx: FamilyContext): boolean => has(FLOODLIGHT_TYPES, ctx.deviceType);
/** HomeBase-family hub (has a speaker/alarm) — a station EXCLUDING the NVRs, per `HOMEBASE_TYPES`. */
export const isHomeBase = (ctx: FamilyContext): boolean => has(HOMEBASE_TYPES, ctx.deviceType);
/** Wired doorbell (DeviceType.DOORBELL). */
export const isWiredDoorbell = (ctx: FamilyContext): boolean => ctx.deviceType === DeviceType.DOORBELL;

/**
 * Whether a vacuum uses the **Anker AIoT MQTT** transport (modern DP 150–180 protobuf scheme).
 *
 * A **negative exclusion**: returns `false` only for the one confirmed non-AIoT platform
 * (`"eufy_home_tuya"` — ThingClips/Tuya Cloud). Any absent, unknown, or unrecognised category
 * defaults to `true`, matching the polarity of `routeCommand` which sends `aiot-dp` to MQTT
 * unless `category === "eufy_home_tuya"`. The two gates agree: an unknown-category AIoT
 * vacuum both routes to MQTT *and* has its setters installed.
 *
 * | `category`          | platform                           | returns |
 * | ------------------- | ---------------------------------- | ------- |
 * | `"eufy_home"`       | Anker AIoT MQTT ✅ confirmed       | `true`  |
 * | `"eufy_home_tuya"`  | ThingClips/Tuya Cloud ✅ confirmed  | `false` |
 * | absent / any other  | unknown — default to AIoT          | `true`  |
 *
 * Live-confirmed categories sourced from `get_devs_list` dumps: `"eufy_home_tuya"` from a T2266
 * X8 Pro (2026-08-04). Additional category strings are added here as devices are captured.
 */
export const isAiotVacuum = (ctx: FamilyContext): boolean => ctx.category !== "eufy_home_tuya";

/**
 * Whether a vacuum is on the **ThingClips/Tuya Cloud** platform (`"eufy_home_tuya"` category).
 *
 * The positive complement of the negative-exclusion {@link isAiotVacuum}: returns `true` only for
 * the one confirmed non-AIoT platform. Used to extend capability `available` guards so Tuya
 * vacuums receive the same write actions as AIoT ones, routed by the facade's `routeCommand`.
 */
export const isTuyaVacuum = (ctx: FamilyContext): boolean => ctx.category === "eufy_home_tuya";
