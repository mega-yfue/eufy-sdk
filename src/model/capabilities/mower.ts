import { pickDpParams } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Robot-mower Tuya **DP ids** — the E15's Tuya product schema (`thing.m.device.ref.info.list` v5.4,
 * `schemaInfo.schema`, product `bvxrcjxom787vnit`), each id also reported by a live E15. The product
 * is built on Tuya's robot-vacuum template, so ids 1-42 carry that template's codes; the mower's own
 * data points are 101-146.
 *
 * Only scalar data points are named here. The Raw ones (`robot_status` 107, `battery_status` 108,
 * `map_info` 113, the `*_control` commands 103-106, …) are protobuf messages whose field layout no
 * source in hand states, and 102 (`device_infomation`) and 142 (`gps_info`) carry the device's network
 * identity and position.
 * @internal
 */
export const MOWER_DP = {
  /** `battery_percentage` — Value ro, 0-100 %. */
  BATTERY: 8,
  /** `volume_set` — Value rw, 0-100 %. */
  VOLUME: 26,
  /** `child_lock` — Bool rw. */
  CHILD_LOCK: 47,
  /** `rain_auto_return` — Bool rw: return to the station when rain is detected. */
  RAIN_AUTO_RETURN: 101,
  /** `wifi_signal_strength` — Value ro, 0-100 %. */
  WIFI_SIGNAL: 109,
  /** `mow_height` — Value rw, 25-75 mm. */
  MOW_HEIGHT: 110,
  /** `save_map_process` — Value ro, 0-100 %. */
  SAVE_MAP_PROGRESS: 118,
  /** `base_station_used_time` — Value rw, minutes. */
  STATION_USED_TIME: 125,
  /** `mow_blade_used_time` — Value rw, minutes. */
  BLADE_USED_TIME: 126,
  /** `edge_trim` — Bool rw. */
  EDGE_TRIM: 128,
  /** `enable_work_angle` — Bool rw. */
  WORK_ANGLE_ENABLED: 130,
  /** `work_angle` — Value rw, -90-90 degrees. */
  WORK_ANGLE: 131,
  /** `enable_smart_forbid_zone` — Bool rw. */
  SMART_NO_GO_ZONES: 132,
  /** `enable_bird_view_capture` — Bool rw. */
  BIRD_VIEW_CAPTURE: 133,
  /** `net_media_type` — Enum ro: `None` / `Wifi` / `Cellular`. */
  NETWORK: 134,
  /** `enable_cellular` — Bool rw. */
  CELLULAR_ENABLED: 137,
  /** `follow_edge_distance` — Value rw, -10000-10000 mm. */
  EDGE_DISTANCE: 139,
  /** `gps_location_check` — Bool rw, the schema's "GPS anti-theft switch". */
  GPS_ANTI_THEFT: 140,
  /** `sparse_lawn_optimization` — Bool rw. */
  SPARSE_LAWN_OPTIMIZATION: 141,
} as const;

/** The `net_media_type` (DP 134) range, as the schema lists it. */
export const MOWER_NETWORKS = ["None", "Wifi", "Cellular"] as const;

/** The mower's network link (DP 134). */
export type MowerNetwork = (typeof MOWER_NETWORKS)[number];

/**
 * Every `mower` read, declared once.
 *
 * All read-only. Several of these data points are `rw` in the schema, but no write has been captured
 * against a mower, and the vendor app drives the mower through named pass-through commands rather than
 * by publishing these DPs, so no setter is installed.
 *
 * Exported but NOT published: each entry states its wire id, which the reference site does not carry.
 * @internal
 */
export const MOWER_MEMBERS = {
  /** Charge percentage (DP 8, `battery_percentage`). */
  battery: {
    param: MOWER_DP.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Battery level 0-100 (DP 8, battery_percentage). Read-only.",
  },
  /** Speaker volume (DP 26, `volume_set`). */
  volume: {
    param: MOWER_DP.VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker volume 0-100 (DP 26, volume_set). Read-only: no write captured.",
  },
  /** Whether the child lock is on (DP 47, `child_lock`). */
  childLock: {
    param: MOWER_DP.CHILD_LOCK,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Child lock on (DP 47, child_lock). Read-only: no write captured.",
  },
  /** Whether the mower returns to its station when it detects rain (DP 101, `rain_auto_return`). */
  rainAutoReturn: {
    param: MOWER_DP.RAIN_AUTO_RETURN,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Return to the station when rain is detected (DP 101, rain_auto_return). Read-only.",
  },
  /** Wi-Fi signal strength as a percentage (DP 109, `wifi_signal_strength`), not a dBm reading. */
  wifiSignal: {
    param: MOWER_DP.WIFI_SIGNAL,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Wi-Fi signal strength 0-100 % (DP 109, wifi_signal_strength). Read-only.",
  },
  /** Cutting height in millimetres (DP 110, `mow_height`), 25-75. */
  cutHeight: {
    param: MOWER_DP.MOW_HEIGHT,
    type: "number",
    unit: "mm",
    kind: "millimetres",
    min: 25,
    max: 75,
    provenance: "mega",
    description: "Cutting height 25-75 mm (DP 110, mow_height). Read-only: no write captured.",
  },
  /** Progress of saving the map (DP 118, `save_map_process`). */
  mapSaveProgress: {
    param: MOWER_DP.SAVE_MAP_PROGRESS,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Map-save progress 0-100 % (DP 118, save_map_process). Read-only.",
  },
  /** Total base-station use in minutes (DP 125, `base_station_used_time`). */
  stationUsedTime: {
    param: MOWER_DP.STATION_USED_TIME,
    type: "number",
    unit: "min",
    kind: "minutes",
    provenance: "mega",
    description: "Base-station use in minutes (DP 125, base_station_used_time). Read-only.",
  },
  /** Total cutting-blade use in minutes (DP 126, `mow_blade_used_time`). */
  bladeUsedTime: {
    param: MOWER_DP.BLADE_USED_TIME,
    type: "number",
    unit: "min",
    kind: "minutes",
    provenance: "mega",
    description: "Cutting-blade use in minutes (DP 126, mow_blade_used_time). Read-only.",
  },
  /** Whether edge trimming is on (DP 128, `edge_trim`). */
  edgeTrim: {
    param: MOWER_DP.EDGE_TRIM,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Edge trimming on (DP 128, edge_trim). Read-only: no write captured.",
  },
  /** Whether a fixed mowing angle is in use (DP 130, `enable_work_angle`); the angle is `workAngle`. */
  workAngleEnabled: {
    param: MOWER_DP.WORK_ANGLE_ENABLED,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Fixed mowing angle in use (DP 130, enable_work_angle). Read-only.",
  },
  /** The mowing angle in degrees, -90 to 90 (DP 131, `work_angle`). */
  workAngle: {
    param: MOWER_DP.WORK_ANGLE,
    type: "number",
    unit: "°",
    kind: "degrees",
    min: -90,
    max: 90,
    provenance: "mega",
    description: "Mowing angle -90 to 90 degrees (DP 131, work_angle). Read-only.",
  },
  /** Whether smart no-go zones are on (DP 132, `enable_smart_forbid_zone`). */
  smartNoGoZones: {
    param: MOWER_DP.SMART_NO_GO_ZONES,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Smart no-go zones on (DP 132, enable_smart_forbid_zone). Read-only.",
  },
  /** Whether bird's-eye-view capture is on (DP 133, `enable_bird_view_capture`). */
  birdViewCapture: {
    param: MOWER_DP.BIRD_VIEW_CAPTURE,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Bird's-eye-view capture on (DP 133, enable_bird_view_capture). Read-only.",
  },
  /**
   * The network link in use (DP 134, `net_media_type`). Answers `undefined` for a value outside the
   * schema's range.
   */
  network: {
    param: MOWER_DP.NETWORK,
    type: "string",
    provenance: "mega",
    decode: (raw): MowerNetwork | undefined =>
      typeof raw === "string" && (MOWER_NETWORKS as readonly string[]).includes(raw)
        ? (raw as MowerNetwork)
        : undefined,
    decodedKind: "enum",
    decodedValues: MOWER_NETWORKS,
    description: "Network link: None, Wifi or Cellular (DP 134, net_media_type). Read-only.",
  },
  /** Whether the cellular link is enabled (DP 137, `enable_cellular`). */
  cellularEnabled: {
    param: MOWER_DP.CELLULAR_ENABLED,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Cellular link enabled (DP 137, enable_cellular). Read-only.",
  },
  /** Edge-following distance in millimetres (DP 139, `follow_edge_distance`), signed. */
  edgeDistance: {
    param: MOWER_DP.EDGE_DISTANCE,
    type: "number",
    unit: "mm",
    kind: "millimetres",
    min: -10000,
    max: 10000,
    provenance: "mega",
    description: "Edge-following distance in mm, signed (DP 139, follow_edge_distance). Read-only.",
  },
  /** Whether GPS anti-theft is on (DP 140, `gps_location_check`). */
  gpsAntiTheft: {
    param: MOWER_DP.GPS_ANTI_THEFT,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "GPS anti-theft on (DP 140, gps_location_check). Read-only.",
  },
  /** Whether sparse-lawn optimisation is on (DP 141, `sparse_lawn_optimization`). */
  sparseLawnOptimization: {
    param: MOWER_DP.SPARSE_LAWN_OPTIMIZATION,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Sparse-lawn optimisation on (DP 141, sparse_lawn_optimization). Read-only.",
  },
} as const satisfies Members;

/**
 * Bound mower reads — the object returned by `dev.mower()`. Each getter is present only once the
 * mower has reported its data point.
 */
export type MowerActions = Surface<typeof MOWER_MEMBERS>;

/** The DP ids this capability keeps from an inbound report. */
const MOWER_DP_IDS: readonly number[] = Object.values(MOWER_DP);

/** `mower` — robot-mower state from its Tuya data points. */
export const MOWER: CapabilityModule = {
  capability: "mower",
  line: "clean",
  description: "Robot-mower state: battery, cutting height, settings and wear timers (read-only).",
  members: MOWER_MEMBERS,
  properties: propertiesOf(MOWER_MEMBERS),
  detection: { codecs: ["mower"] },
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, MOWER_DP_IDS);
    return params ? { params } : null;
  },
};
