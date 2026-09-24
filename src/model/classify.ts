/**
 * Device classifier — axis **B2** (command-codec family).
 *
 * ## What this module does
 * Given a cloud device record, it answers one question: *which wire-protocol family
 * does this device belong to?* — i.e. its {@link Codec} (`station | camera | sensor |
 * lock | keypad`). It also exposes the baseline {@link Capability} set every member of a
 * codec gets for free (before model rows / inference add device-specific extras).
 *
 * ## Why it is data-driven (no per-SKU table)
 * eufy assigns every product a numeric **DeviceType** at the cloud, and that number — not
 * the marketing model code — is the authoritative family discriminator. So the primary
 * classifier ({@link codecForType}) is a small set of range / membership checks over the
 * DeviceType space, with each group's DeviceType *names* spelled out in comments. A brand
 * new camera SKU that ships with a DeviceType inside the camera range classifies correctly
 * with zero code changes — that is the whole point of keeping this as data, not a wall of
 * per-model predicates.
 *
 * The DeviceType groupings below are distilled from a third-party reverse-engineering
 * project's device enum and its ~70 `isCamera`/`isStation`/`isSensor`/`isLock`/`isKeyPad`
 * predicates, collapsed into a handful of numeric sets. That is a NAME/grouping source only —
 * every behaviour keyed off a group is grounded in the V6 app or our own captures.
 *
 * ## Fallbacks
 * When the cloud record has no DeviceType (older firmware, partial records), we fall back to
 * a conservative regex over the model T-code ({@link codecFromModel}). {@link classify}
 * chains the two and defaults to `"camera"` — the most common eufy-security device and a
 * safe read-only default (a misrouted camera codec degrades to "video-ish" behaviour rather
 * than, say, attempting lock actuation).
 *
 * @module model/classify
 */

import type { Codec, CloudRecord } from "./types.js";
import { DeviceType } from "./device-types.js";
// The printer-category matcher is defined in core/ so the transport-side classifier and this codec
// classifier can't drift on what "a printer" is (sharing is only open in this direction).
import { PRINTER_CATEGORY_RE } from "../core/types.js";

/* -------------------------------------------------------------------------- */
/*  DeviceType groups (numeric ground truth)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stations / hubs — the "station" control codec (arming/guard mode, storage).
 *
 * Note: CAMERA_POE_S4 is *also* grouped as a camera by the third-party catalogue; kept here with its NVR/PoE
 * backbone because it is the station-class endpoint that owns the arming/storage surface
 * (per-channel video still resolves via camera capabilities).
 */
const STATION_TYPES: ReadonlySet<number> = new Set([
  DeviceType.STATION,
  DeviceType.HB3,
  DeviceType.STATION_9000,
  DeviceType.MINIBASE_CHIME,
  DeviceType.HOMEBASE_MINI,
  DeviceType.NVR_S4_MAX,
  DeviceType.CAMERA_POE_S4,
]);

/**
 * Locks & smart safes — the "lock" actuation codec.
 *
 * Deliberately EXCLUDED: LOCK_85V0. Despite the LOCK_ name, eufy ships it as a battery
 * video-doorbell (the third-party catalogue's camera AND doorbell predicates both accept it); it streams video and has
 * no standalone lock codec, so it classifies as a camera below.
 */
const LOCK_TYPES: ReadonlySet<number> = new Set([
  DeviceType.LOCK_BLE,
  DeviceType.LOCK_WIFI,
  DeviceType.LOCK_BLE_NO_FINGER,
  DeviceType.LOCK_WIFI_NO_FINGER,
  DeviceType.LOCK_8503,
  DeviceType.LOCK_8530,
  DeviceType.LOCK_85A3,
  DeviceType.LOCK_8592,
  DeviceType.LOCK_8504,
  DeviceType.LOCK_8502,
  DeviceType.LOCK_8506,
  DeviceType.LOCK_8531,
  DeviceType.LOCK_85L0,
  DeviceType.LOCK_85D0,
  DeviceType.LOCK_85P0,
  DeviceType.SMART_SAFE_7400,
  DeviceType.SMART_SAFE_7401,
  DeviceType.SMART_SAFE_7402,
  DeviceType.SMART_SAFE_7403,
]);

/**
 * Sensors — entry/contact, motion, environmental (water/freeze, smoke, siren). NO baseline
 * capability here; the *specific* sensor kind is attached by detection/registry, since the
 * DeviceType alone doesn't always disambiguate (e.g. generic SENSOR).
 */
const SENSOR_TYPES: ReadonlySet<number> = new Set([
  DeviceType.SENSOR,
  DeviceType.MOTION_SENSOR,
  DeviceType.WATER_FREEZE_SENSOR_8920,
  DeviceType.SIREN_SENSOR,
  DeviceType.SMOKE_SENSOR,
  DeviceType.SIREN_SENSOR_E20,
  DeviceType.ENTRY_SENSOR_E20,
  DeviceType.PIR_SENSOR_E20,
]);

/** Keypad — its own tiny codec. */
const KEYPAD_TYPES: ReadonlySet<number> = new Set([DeviceType.KEYPAD]);

/* -------------------------------------------------------------------------- */
/*  Primary classifier: DeviceType number -> Codec                            */
/* -------------------------------------------------------------------------- */

/**
 * Map eufy's numeric **DeviceType** to a command {@link Codec}.
 *
 * Resolution order (first match wins): station → lock → sensor → keypad → camera. Anything
 * that is a recognised security endpoint but not in the station/lock/sensor/keypad sets is
 * treated as a **camera** (cameras, doorbells, floodlight/wall-light cams, garage cams,
 * solocams, eufyCams, smart-drop, the LOCK_85V0 video-doorbell, etc.) — this is the large,
 * fast-growing family, so it is the residual bucket rather than an explicit list.
 *
 * @param deviceType eufy DeviceType integer (e.g. `9` = CAMERA2, `54` = LOCK_8503 / R10).
 * @returns the codec, or `undefined` for a genuinely unknown / non-finite input.
 */
export function codecForType(deviceType: number): Codec | undefined {
  // NaN / Infinity / non-integer guard — never throw, just decline to classify.
  if (!Number.isFinite(deviceType)) return undefined;

  if (STATION_TYPES.has(deviceType)) return "station";
  if (LOCK_TYPES.has(deviceType)) return "lock";
  if (SENSOR_TYPES.has(deviceType)) return "sensor";
  if (KEYPAD_TYPES.has(deviceType)) return "keypad";

  // Residual: any other known security device is a camera-family endpoint.
  // We treat the whole "rest of the eufy_security DeviceType space" as camera, since
  // that is where every camera/doorbell/floodlight/solocam/garage/smartdrop SKU lives,
  // including future numbers eufy has not minted yet.
  if (isKnownSecurityType(deviceType)) return "camera";

  return undefined;
}

/**
 * Heuristic membership test for "is this a recognised eufy security DeviceType at all?".
 * Used to decide whether an otherwise-unmatched number should fall into the camera bucket
 * (known device) or return `undefined` (truly unknown).
 *
 * The eufy_security DeviceType space is two clusters:
 *  - the dense legacy/native range `0..~210` (cameras, doorbells, floodlights, locks,
 *    sensors, solocams, garage cams, smart-drop, smart-safe, etc.), and
 *  - the NVR/PoE range `300..301`, and
 *  - the "v2 / cost-down" high range `10000..~10100` (WALL_LIGHT_CAM_81A0=10005,
 *    INDOOR_PT_CAMERA_C220=10008..C220_V3=10011, CAMERA_C35=10035).
 *
 * Anything outside these ranges is considered unknown. We exclude the SMART_TRACK_*
 * tracker tags (157/159) which are not part of any codec here.
 */
function isKnownSecurityType(deviceType: number): boolean {
  if (deviceType === DeviceType.SMART_TRACK_LINK || deviceType === DeviceType.SMART_TRACK_CARD) return false; // trackers — not a codec target
  if (deviceType >= 0 && deviceType <= 210) return true;
  if (deviceType >= 300 && deviceType <= 301) return true;
  if (deviceType >= 10000 && deviceType <= 10100) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Fallback classifier: model T-code -> Codec                                */
/* -------------------------------------------------------------------------- */

/**
 * Fallback classifier used when {@link CloudRecord.deviceType} is absent. Matches eufy
 * product **T-codes** by family prefix. Deliberately conservative — it only claims a codec
 * when the T-code range is a strong, unambiguous family signal; otherwise it returns
 * `undefined` and lets {@link classify} apply the camera default.
 *
 * Known T-code families (case-insensitive):
 *  - `T85xx` / `T852x` / `T850x` → **lock** (Smart Lock R-series, video lock, etc.),
 *    EXCEPT `T8520`-prefixed which can be lock variants — still lock.
 *  - `T74xx` → **lock** (SmartSafe 7400-series).
 *  - `T80xx` / `T8001` / `T8002` / `T8010` / `T8030` / `T8023` / `T8025` → **station**
 *    (HomeBase / HomeBase 2 / 3 / Mini), `T9000` (the app's own model registry files it as family
 *    `STATION_9000`, the one station family outside the T8 band), and `T8N00` (NVR) / `T8E00` (PoE
 *    NVR) → station.
 *  - `T89xx` (entry/motion/water/siren sensors, e.g. T8900/T8910/T8920) → **sensor**.
 *  - `T87xx` keypad (`T8960`) → **keypad**.
 *  - any other `T8…` security T-code → **camera** (the default security family).
 *
 * @param model product/model code (T-code), e.g. `"T8423"`. `undefined`/empty → `undefined`.
 * @returns the inferred codec, or `undefined` when the code is unrecognised.
 */
export function codecFromModel(model: string | undefined): Codec | undefined {
  if (!model) return undefined;
  const m = model.trim().toUpperCase();
  if (m.length === 0) return undefined;

  // Robot mowers (Clean line, but a distinct product family) — the app's `TuyaP2PMower` set, decided
  // before the generic T2 vacuum rule so a mower isn't mislabelled a vacuum. Codes from the V6 app's
  // `ProductTypeUtils` predicates: C15 = T280B, E15 = T2880/T2880B, E18 = T2801/T2801B (the `…B`
  // hardware variants included — the anchored form dropped them to the vacuum rule). T2881 is in the
  // clean catalog but has NO mower predicate in the app, so it is deliberately left to the vacuum rule.
  if (/^T2(80B|880B?|801B?)$/.test(m)) return "mower";

  // RoboVac / clean line: T2xxx product codes (Tuya-DP transport, separate param namespace).
  if (/^T2/.test(m)) return "vacuum";

  // Legacy RoboVac codes with a T1xxx prefix (pre-T2 numbering, e.g. T1250 RoboVac 35C).
  if (/^T1/.test(m)) return "vacuum";

  // Stations / hubs / NVRs.
  //  HomeBase family: T8001/T8002/T8010/T8023/T8025/T8030 ; NVR: T8N00 ; PoE NVR: T8E00.
  if (/^T8(00[0-9]|010|023|025|030)/.test(m)) return "station";
  if (/^T8N0/.test(m) || /^T8E0/.test(m)) return "station";
  if (/^T9000/.test(m)) return "station";

  // SmartSafe (T74xx) — lock-family actuation.
  if (/^T74/.test(m)) return "lock";

  // Locks (Smart Lock R10/R20, video lock, etc.): T850x / T8520 / T853x / T859x / T85xx.
  if (/^T85/.test(m)) return "lock";

  // Keypad (T8960) — must be tested before the generic sensor/camera T89 rule.
  if (/^T8960/.test(m)) return "keypad";

  // Sensors: entry / motion / water-freeze / siren live in the T89xx band.
  if (/^T89/.test(m)) return "sensor";

  // eufy_life smart lighting: the whole T8L0x line (Permanent Outdoor Lights, string/spot/pathway
  // lights, floor lamp, …) — secure-MQTT DP wire, not the security stack. Matched by prefix so
  // suffixed variants (T8L02X, T8L023E1, …) resolve too, not just the registry-listed codes; must
  // precede the generic T8 camera residual below.
  if (/^T8L/.test(m)) return "light";

  // eufy_mega Smart Display line — the T87Ax model prefix (only T87A0 observed so far). The model
  // code, not the cloud `category` ("eufy_mega"), is the one thing genuinely specific to this
  // product: `category` is echoed verbatim by `classifyDevice()` in core/types.ts as the residual
  // bucket for anything that isn't `eufy_security` and has no `p2p_did`, so it may be a broader
  // Anker-side grouping shared with other, unrelated appliance types this SDK hasn't seen yet.
  if (/^T87A/.test(m)) return "display";

  // Any remaining eufy security T-code is a camera/doorbell/floodlight/etc.
  if (/^T8/.test(m)) return "camera";

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Combined classifier                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a {@link CloudRecord} to its command {@link Codec}.
 *
 * Strategy: trust the cloud-provided numeric DeviceType first ({@link codecForType}); if
 * that is absent/unknown, fall back to the model T-code ({@link codecFromModel}); if both
 * fail, default to `"camera"` — the most common eufy-security device and a safe read-only
 * default. **Always** returns a concrete codec.
 *
 * @param rec the minimal cloud record slice (deviceType + model are what matter here).
 * @returns the resolved codec (never `undefined`).
 */
export function classify(rec: CloudRecord): Codec {
  // Computed once, referenced by every branch below (`codecFromModel` is a pure function of one
  // argument) — mower/vacuum/light/display all decide off it before device_type gets a say, and the
  // final fallback reuses the same value rather than recomputing it.
  const byModel = codecFromModel(rec.model);

  // Vacuum/clean is a SEPARATE ecosystem (Tuya DP, not the security DeviceType space). Decide it
  // FIRST from category/model — otherwise `codecForType`'s camera-residual bucket could swallow a
  // RoboVac whose `device_type` happens to fall in the security range. (`device_type` is not a
  // reliable vacuum signal; category + the T2 model code are.)
  // 3D printers are their own ecosystem (ankermake cloud) — decided from the device `category`, before
  // the security DeviceType bucket below could swallow one. Category is the CANDIDATE signal, pending a
  // bound printer: no printer was on the account during the capture, so these strings are inferred (from
  // the ankermake brand/hosts), not an observed device category — a better inference than a model code,
  // not a confirmed one. A wrong guess here costs a misclassification, never a bad frame.
  if (rec.category && PRINTER_CATEGORY_RE.test(rec.category)) return "printer";

  // Mowers are their own family — decide from the (globally-unique) model code first, before the
  // clean/vacuum category rule right after it could claim them. Can't join the light/display set below:
  // the category rule has to run between this and the model-based vacuum check.
  if (byModel === "mower") return "mower";
  if (rec.category && /clean|vacuum|robovac/i.test(rec.category)) return "vacuum";
  if (byModel === "vacuum") return "vacuum";

  // eufy_life smart lighting (its `device_type` is namespaced per product line and can collide with a
  // security type) and the Smart Display (T87A0 — confirmed live 2026-09-04 to connect over secure
  // MQTT with no `p2p_did`, never P2P, yet its `device_type` 1 falls inside `isKnownSecurityType`'s
  // residual range) are each decided from the globally-unique model code, not the cloud `category` —
  // otherwise `codecForType`'s camera bucket could swallow either below. Nothing sits between them
  // (unlike mower/vacuum above), so one check covers both.
  if (byModel === "light" || byModel === "display") return byModel;

  if (rec.deviceType !== undefined) {
    const byType = codecForType(rec.deviceType);
    if (byType !== undefined) return byType;
  }
  if (byModel !== undefined) return byModel;
  return "camera";
}

// Per-codec baseline capabilities live in the capability files themselves — each module declares
// `detection.codecs` for the families it's a baseline of — and `codecBaseline()` is derived from those
// modules in `capabilities/index.ts`. This file keeps only codec *routing* (device_type/model → which
// wire protocol), the transport axis.
