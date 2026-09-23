import { asBool, coerceEnumValue } from "../../core/util.js";
import { DeviceType } from "../device-types.js";
import { isIndoorCamera, isIndoorCamMini, isIndoorPanTiltS350 } from "../device-family.js";
import { setScalar, setPayload, setJson, hasCapability } from "./access.js";
import { AUDIO_CMD } from "./audio.js";
import { accepts, method, propertiesOf, provided, type Members, type Surface, type MemberDeps } from "./members.js";
import { BATTERY_PARAM, cameraPowerTier } from "./battery.js";
import type { CapabilityModule, CapabilityActions, CommandContext } from "./types.js";
import { CameraDisabledError, type Command, type MediaProvider } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this camera capability drives (direct-binary switches + `1350`
 * SET_PAYLOAD sub-commands). These are the capability's own wire vocabulary — the transport carries
 * `cmd.param` opaquely and never names them (the full 541-entry id→name catalog lives in the generated
 * `transport/p2p/commands.ts`). Each entry notes its app `CommandType` name.
 */
export const CAMERA_CMD = {
  /** Camera on/off. switch is inverted: camera ON ⇒ 0, OFF ⇒ 1. */
  CAMERA_ENABLE: 1035,
  /**
   * Camera status LED on/off — the "power/recording" indicator. The
   * app JS has a sibling param `1056` (`APP_CMD_LIVEVIEW_LED_SWITCH`) for the SAME UI "Status Light"
   * setting on some other model/generation — confirmed real (a full parser class exists) but tested
   * live with no effect on a T8425 (which uses 1045, shipped here); which model actually uses 1056
   * is unconfirmed. Don't wire 1056 as an alias of this without per-model evidence.
   */
  DEV_LED_SWITCH: 1045,
  /**
   * Rotate the image 180° on/off. Direct param, value 0 = normal, 1 = flipped. The app's constant is
   * `INDOOR_ROTATE_IMAGE`, but it is NOT indoor-only — ✅ verified live on an OUTDOOR floodlight cam
   * (T8425), so we drop the misleading "indoor". App parser: `{cmd:1207, params:{enable:0|1}}`.
   */
  ROTATE_IMAGE: 1207,
  /**
   * On-screen watermark / OSD overlay (app `CMD_SET_DEVS_OSD`). ✅ Wire verified live on T8425 (ch3):
   * a **3-value enum**, not a bool — 0 = off, 1 = timestamp, 2 = timestamp + logo. Direct-binary
   * `[channel][value]`. (Labels/enum in {@link Watermark}.)
   */
  SET_DEVS_OSD: 1214,
  /**
   * Video-doorbell status-LED on/off. Rides the `1350` SET_PAYLOAD envelope
   * (`{account_id,cmd:1716,mChannel,mValue3:1716,payload:{light_enable:0|1}}`),
   * signCode 8. ✅ verified live on Doorbell Dual T8214. Family-specific wire for the same semantic
   * status LED setting ordinary cameras report under 1045.
   */
  DOORBELL_LED: 1716,
  /**
   * Night-vision mode (app `NIGHT_VISION_TYPE`). Enum: 0 = off, 1 = infrared/auto (B&W), 2 = full colour.
   * ✅ All three verified live on T8425: `1350` SET_PAYLOAD, inner cmd 1277, `payload:{channel:<deviceCh>,
   * night_sion:N}`, mChannel 0, mValue3 0. Standalone (SINGLE-connect) uses direct `IC_NIGHT_VISION_TYPE`
   * (1013). (Some models omit full colour; enum in {@link NightVision}.)
   */
  NIGHT_VISION_TYPE: 1277,
  /**
   * Push-notification STYLE — how much a detection push carries: text alone, a thumbnail, or text
   * followed by a thumbnail. App `CMD_INDOOR_PUSH_NOTIFY_TYPE`, and the "indoor" is a misnomer: the
   * wire is confirmed on an OUTDOOR standalone camera (T8171). The app's id→name table carries TWO
   * aliases for this id, `ENTER_OTA` and `INDOOR_PUSH_NOTIFY_TYPE`; the confirmed behaviour is the
   * notification style.
   *
   * Wire verified live on a T8171 (standalone, own channel, reached over the cloud/WAN path): the
   * `1700` CONTROL_PAYLOAD wrapper, signCode 8, plaintext
   * `{"commandType":6020,"data":{"value":N,"transaction":"<epoch ms>"}}`. All three values captured
   * byte-exact, each read back on the cloud param within ~10s. The station answers on the same wrapper
   * ~600ms later with a 4-byte body — the command's int32 result — so this write is not
   * fire-and-forget, unlike the direct-binary switches.
   * (Values in {@link NotificationStyle}.)
   */
  PUSH_NOTIFY_TYPE: 6020,
  /**
   * **Sound detection** switch — whether the camera triggers on what it hears, beside the motion
   * trigger it triggers on what it sees.
   *
   * Wire observed live on an indoor pan-tilt (standalone, mains, own channel): the `1700`
   * CONTROL_PAYLOAD wrapper, plaintext `{"commandType":6043,"data":{"status":0|1}}`. Both directions
   * captured byte-exact and read back on the cloud param, twice each; no other parameter moved.
   */
  SOUND_DETECTION: 6043,
  /**
   * How loud a sound has to be to trigger {@link CAMERA_CMD.SOUND_DETECTION} — the app's three-position
   * control writes `1` lowest, `3` mid, `5` highest.
   *
   * Wire observed live on the same camera: `{"commandType":6044,"data":{"index":N}}` in the `1700`
   * wrapper. The payload field is `index`, NOT the `value` its neighbours use — each of these
   * commands names its field differently, so there is no generic setter for the family.
   */
  SOUND_DETECTION_SENSITIVITY: 6044,
  /**
   * WHICH sounds trigger {@link CAMERA_CMD.SOUND_DETECTION} — all sound, or crying alone.
   *
   * Wire observed live: `{"commandType":6046,"data":{"type":N}}` in the `1700` wrapper, both values
   * captured and read back. (Values in {@link SoundDetectionType}.)
   */
  SOUND_DETECTION_TYPE: 6046,
  /**
   * **Anti-theft detection** switch (app `APP_CMD_EAS_SWITCH`). Despite the "EAS" name the app's own
   * parser maps this id onto `anti_theft_detection_switch`, so the camera member uses that semantic
   * name. The app's "EAS" resource strings mix emergency- and anti-theft-worded copy; the parser is
   * the tiebreak.
   *
   * Wire from the app's own JS: a scalar `params:{value:0|1}`. Emitted with the **adaptive** form so
   * topology picks the level — level-2/direct on a HomeBase-attached device, level-1 on a standalone.
   *
   * ⚠️ Replay + readback confirmed on a **HomeBase-attached** T8425 only (1015 read `0` → write → `1`
   * → restore): the frame is confirmed accepted and persisted, NOT byte-compared to the app's. The
   * **standalone** path is unverified, and newer (v3) devices use a *different* id for the same
   * switch — `APP_CMD_NEW_EAS_SWITCH` (2735) — which has no path here; don't assume 1015 drives them.
   */
  EAS_SWITCH: 1015,
  /**
   * RECORDING quality — what gets stored, not the live view; {@link CAMERA_CMD.STREAMING_QUALITY_SET}
   * below is the live one, and the app's name for this id is `multicamSetRecordQuailty`.
   * Wire confirmed on a T8425 ch3: `1350` SET_PAYLOAD, inner cmd 2731,
   * `payload:{channel:0, mode:0, primary_view:0, quality:N}`, mValue3 0, on the device channel. Tiers
   * 1/2/3, named in {@link RECORDING_QUALITY_TIERS} — no tier 0 on this wire, where streaming has one.
   * That is a fact about 2731 on the cameras it was confirmed on, not about recording everywhere. A
   * doorbell has no recording-quality setting at all, and its live-view quality rides neither 2730 nor
   * 2731 but 1705, on a domain of its own (5 = Auto, 6/7/8 = Low/Medium/High, all four observed).
   */
  RECORDING_QUALITY_SET: 2731,
  /**
   * LIVE-VIEW quality — a separate setting from {@link CAMERA_CMD.RECORDING_QUALITY_SET}, and the app's
   * names for the two invert what they suggest: 2730 is `multicamSetVideoQuailty` and drives the
   * Streaming Quality picker, while 2731 is `multicamSetRecordQuailty` and drives Recording Quality.
   * Changing one leaves the other's parameter untouched, which is how they were told apart.
   *
   * Unlike recording it offers a tier 0, `Auto`. Wire verified live on a T8170 (standalone): the `1350`
   * SET_PAYLOAD envelope, signCode 8, plaintext `{"cmd":2730,"payload":{"transaction":"<epoch ms>",
   * "quality":N,"channel":0,"mode":0,"primary_view":0},"account_id":…}`. All four tiers captured
   * byte-exact and read back on parameter 1020; the station echoes the same payload back as a `1351`
   * NOTIFY_PAYLOAD carrying the same `transaction`.
   */
  STREAMING_QUALITY_SET: 2730,
} as const;

/** Whether a model-side record or bound context reports the camera-owned legacy EAS switch. */
export function hasReportedEasSwitch(source: {
  params?: Record<number, string>;
  paramIds?: ReadonlySet<number>;
}): boolean {
  return (
    source.paramIds?.has(CAMERA_CMD.EAS_SWITCH) === true || Object.hasOwn(source.params ?? {}, CAMERA_CMD.EAS_SWITCH)
  );
}

/**
 * On-screen watermark / OSD overlay options. The value is the UI radio index. Use
 * `Watermark.TimestampAndLogo` etc. with `setWatermark` / `setProperty(sn,"watermark",…)`.
 */
// Deliberately NOT JSDoc: `Watermark` is re-exported publicly, and TypeDoc publishes a JSDoc block
// verbatim — the publication guard rejects wire detail on the generated page. The wire itself is
// documented on CAMERA_CMD.SET_DEVS_OSD, which stays internal.
// Wire: CMD_SET_DEVS_OSD 1214 — verified live (T8425).
export const Watermark = {
  /** No timestamp or logo. */
  Off: 0,
  /** Timestamp only. */
  Timestamp: 1,
  /** Timestamp + eufy logo. */
  TimestampAndLogo: 2,
} as const;
/** A watermark option — the value side of {@link Watermark}. */
export type WatermarkValue = (typeof Watermark)[keyof typeof Watermark];

// Deliberately NOT JSDoc: `NotificationStyle` is re-exported publicly, and TypeDoc publishes a JSDoc
// block verbatim — the publication guard rejects wire detail on the generated page. The wire itself is
// documented on CAMERA_CMD.PUSH_NOTIFY_TYPE, which stays internal.
// Wire: CMD_INDOOR_PUSH_NOTIFY_TYPE 6020 — all three values verified live (T8171 standalone).
export const NotificationStyle = {
  /** The push carries text alone. */
  TextOnly: 1,
  /** The push carries a thumbnail of the detection. */
  IncludedThumbnail: 2,
  /** The push arrives as text, then updates with a thumbnail. */
  TextFirstThenThumbnail: 3,
} as const;
/** A notification style — the value side of {@link NotificationStyle}. */
export type NotificationStyleValue = (typeof NotificationStyle)[keyof typeof NotificationStyle];

// Wire: CMD_INDOOR_DET_SET_SOUND_DETECT_TYPE 6046 — both values observed live on an indoor pan-tilt,
// each read back on the cloud param. `Crying` is the value the camera shipped configured with.
export const SoundDetectionType = {
  /** Crying alone triggers a detection. */
  Crying: 1,
  /** Any sound loud enough for the sensitivity triggers a detection. */
  AllSound: 2,
} as const;
/** A sound-detection type — the value side of {@link SoundDetectionType}. */
export type SoundDetectionTypeValue = (typeof SoundDetectionType)[keyof typeof SoundDetectionType];

/**
 * Night-vision mode: 0=Off, 1=Infrared (the app shows "B&W Auto"), 2=FullColor ("Color"). Use
 * `NightVision.FullColor` etc. with `setNightVision` / `setProperty(sn,"nightVision",…)`. Some models
 * omit `FullColor`.
 */
export const NightVision = {
  /** Off — never use infrared. */
  Off: 0,
  /** Infrared / "B&W Auto" — black-and-white night vision. */
  Infrared: 1,
  /** Full colour night vision (models with a spotlight / starlight sensor). */
  FullColor: 2,
} as const;
/** A night-vision mode — the value side of {@link NightVision}. */
export type NightVisionValue = (typeof NightVision)[keyof typeof NightVision];

/**
 * Video record-quality names. The stored value is a quality TIER; the two lower tiers are the same
 * resolution on every camera confirmed so far, and the top tier is whatever the camera's sensor gives —
 * 2K on a T8171, 3K on a T8170 and a T8425 — so it is named for its RANK, not for a resolution.
 *
 * Naming it "3K HD" would be a claim the SDK cannot ground: a camera does not report its top
 * resolution (the cloud record's `product` is null and no parameter carries it), and the app's own model
 * registry spells a resolution into only some older families, neither of the confirmed ones among them.
 * A resolution label is presentation, and one that cannot be derived is presentation the SDK would get
 * wrong; `Max` is a fact about the tier.
 */
export const RecordingQuality = {
  HD720: "HD (720P)",
  FullHD1080: "Full HD (1080P)",
  Max: "Max",
} as const;
/** A video-quality name — the value side of {@link RecordingQuality}. */
export type RecordingQualityName = (typeof RecordingQuality)[keyof typeof RecordingQuality];

/**
 * Quality tier → name. Tiers confirmed on real devices: 1 = 720P, 2 = 1080P, 3 = the sensor's maximum
 * (observed as 2K on a T8171 and 3K on a T8170 and a T8425, hence the rank rather than a resolution).
 * The vendor names by rank itself where a resolution would not travel: a doorbell's live-view picker
 * reads Auto/Low/Medium/High.
 */
export const RECORDING_QUALITY_TIERS: Readonly<Record<number, string>> = {
  1: "HD (720P)",
  2: "Full HD (1080P)",
  3: "Max",
};

/**
 * Live-view quality names — the recording tiers plus `Auto`, which 2730 offers and 2731 does not: the
 * camera picks a tier from the link instead of being pinned to one.
 */
export const StreamingQuality = {
  Auto: "Auto",
  ...RecordingQuality,
} as const;
/** A live-view quality name — the value side of {@link StreamingQuality}. */
export type StreamingQualityName = (typeof StreamingQuality)[keyof typeof StreamingQuality];

/**
 * Live-view quality tier → name. Tier 0 is `Auto`; 1, 2 and 3 are the recording tiers, confirmed to
 * carry the same names on a T8170 and a T8171.
 */
export const STREAMING_QUALITY_TIERS: Readonly<Record<number, string>> = {
  0: "Auto",
  ...RECORDING_QUALITY_TIERS,
};

/** Resolve a live-view quality tier to its name — or `undefined` if it is not a tier. */
export function resolveStreamingQuality(value: number): string | undefined {
  return STREAMING_QUALITY_TIERS[value];
}

/**
 * Resolve a `setStreamingQuality` argument — a name ({@link StreamingQuality}) or a raw tier — to a
 * valid tier, else `undefined`. `Auto` is tier 0 here, so unlike the recording resolver a 0 is
 * accepted; anything outside the tier set is still refused rather than sent.
 */
export function resolveStreamingQualityTier(value: number | string | boolean): number | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    const hit = Object.entries(STREAMING_QUALITY_TIERS).find(
      ([, label]) => label.toLowerCase() === value.trim().toLowerCase(),
    );
    return hit ? Number(hit[0]) : undefined;
  }
  const tier = Number(value);
  return Number.isInteger(tier) && STREAMING_QUALITY_TIERS[tier] != null ? tier : undefined;
}

/** Resolve a raw `quality` tier value to its resolution label — or `undefined`. */
export function resolveRecordingQuality(value: number): string | undefined {
  return RECORDING_QUALITY_TIERS[value];
}

/** Inverse: the raw `quality` tier value for a resolution NAME — or `undefined` if not a known tier. */
export function resolveRecordingQualityValue(name: string): number | undefined {
  const hit = Object.entries(RECORDING_QUALITY_TIERS).find(
    ([, label]) => label.toLowerCase() === name.trim().toLowerCase(),
  );
  return hit ? Number(hit[0]) : undefined;
}

/**
 * Resolve a `setRecordingQuality` argument — a resolution NAME ({@link RecordingQuality}) OR a raw tier — to a
 * valid tier value, else `undefined`. Unlike a bare `Number()`, this rejects a value that isn't a real
 * tier (0, negative, out of range): the write is fire-and-forget, so an out-of-range quality value
 * would look like it worked while doing nothing. A numeric string ("2") is a raw tier; a non-numeric
 * string is looked up as a resolution name; a boolean is not a tier.
 */
export function resolveRecordingQualityTier(value: number | string | boolean): number | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return resolveRecordingQualityValue(value);
  const tier = Number(value);
  return Number.isInteger(tier) && RECORDING_QUALITY_TIERS[tier] != null ? tier : undefined;
}

/**
 * Lift the ACTIVE tier out of the quality config the device reports.
 *
 * 2731 is not a scalar: a T8170 reports `{cur_mode:0, mode_0:{quality:3}, mode_1:{quality:3}}` — one
 * entry per capture mode, with `cur_mode` selecting which is live. Read as a bare number it would
 * coerce to a non-numeric string and the getter would answer the whole object, typed as though it were
 * a tier.
 *
 * A device that reports a plain tier is still read (some models may); anything else — an unknown shape,
 * a mode with no entry, a tier not in {@link RECORDING_QUALITY_TIERS} — is `undefined` rather than a guess.
 */
function decodeRecordingQualityTier(raw: unknown): number | undefined {
  if (typeof raw === "number" || typeof raw === "string") return resolveRecordingQualityTier(raw);
  if (typeof raw !== "object" || raw === null) return undefined;
  const cfg = raw as Record<string, unknown>;
  const mode = cfg[`mode_${Number(cfg.cur_mode) || 0}`];
  const quality = typeof mode === "object" && mode !== null ? (mode as Record<string, unknown>).quality : undefined;
  return typeof quality === "number" ? resolveRecordingQualityTier(quality) : undefined;
}

/**
 * Bound camera controls — the object returned by `dev.camera()`.
 *
 * The reads, their setters and the media methods are all DERIVED from `CAMERA_MEMBERS`: one
 * declaration per feature gives the getter, the setter, its argument type and its description, and a
 * media method takes its signature from {@link MediaProvider} itself. The media half lands optional
 * because it exists only on a device bound to a provider. Only the no-argument power verbs — which
 * carry no value, so no member can hold them — are written out below.
 */
export type CameraActions = Surface<typeof CAMERA_MEMBERS> & {
  /** Power the camera on. */
  on(): Promise<void>;
  /** Power the camera off. */
  off(): Promise<void>;
};

/**
 * `camera` — camera power (on/off) and privacy mode. The composable "is this thing recording?"
 * surface every security camera has. Distinct from the `camera` *codec* (which is about wire
 * framing); this is the feature.
 *
 * ## Command variance (absorbed here)
 * - **on/off** = `CAMERA_SWITCH` (1035). This module owns only the *semantic* part — the value
 *   polarity, which is family-dependent (enable-bit ON ⇒ 1 for indoor cams + the 8422/8424
 *   floodlight-cams, disable-bit ON ⇒ 0 for battery/solo). The WIRE (level-1 int-string vs level-2
 *   direct-binary) is NOT decided here: it emits a `"auto"` scalar intent and the transport resolver
 *   picks the level by session (standalone ⇒ L1, HomeBase ⇒ L2).
 * - **privacy** = a multi-frame burst (`PRIVACY_MODE` 6250) — see the `p2p-privacy-burst` command;
 *   the sink plays the exact frame sequence.
 */

/**
 * True when this device's `CMD_DEVS_SWITCH` (1035) is an *enable* bit (ON ⇒ 1), not the default
 * *disable* bit (ON ⇒ 0). A per-family SEMANTIC fact of camera power — it lives here, in the camera
 * capability, not in the shared family classifier: it is composed from the classifier's *pure*
 * predicates (`isIndoorCamera` etc.) but the 1035 polarity meaning belongs to `camera`.
 *
 * NOTE: this is polarity only (which value = ON). The WIRE LEVEL is NOT decided here nor by family — it
 * is resolved at send time from the session, so power is emitted `"auto"` and the transport picks.
 *
 * ✅ Polarity confirmed against the current app's own frames: it wrote `1` to turn a camera on and `0` to
 * turn it off, on cameras of two device types whose enable-bit convention this returns.
 */
function isEnableBitPolarity(ctx: CommandContext): boolean {
  const t = ctx.deviceType;
  if (t === undefined) return false;
  if (isIndoorCamera(ctx) && !isIndoorCamMini(ctx) && !isIndoorPanTiltS350(ctx)) return true;
  return ENABLE_BIT_FLOODLIGHT_TYPES.has(t);
}

/**
 * The floodlight-cam models whose 1035 is an enable bit (ON ⇒ 1). A wire-confirmed SUBSET of
 * {@link FLOODLIGHT_TYPES} — the others' polarity is unconfirmed, so this is its own named set rather
 * than the whole family (extend it as each model is captured).
 */
const ENABLE_BIT_FLOODLIGHT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.FLOODLIGHT_CAMERA_8422,
  DeviceType.FLOODLIGHT_CAMERA_8424,
]);

/** Raw 1035 value for a desired power state, honouring the family polarity. */
function powerValue(on: boolean, ctx: CommandContext): number {
  return isEnableBitPolarity(ctx) ? (on ? 1 : 0) : on ? 0 : 1;
}

/**
 * Camera power on/off: ONE wire for every family — `CMD_DEVS_SWITCH` (1035), the capability supplying the
 * param and the polarity-resolved value while `"auto"` lets the transport seal it per session.
 *
 * ✅ Confirmed against the current app's own frames. Across six cameras of four device types and both
 * topologies, every on/off the app sent was `1035` carrying the same body — `[u32 channel][u32 value]
 * [account_id]`, the channel selecting an attached camera — sealed at level-2 or level-1 exactly as the
 * session's key allowed. The capture contains no `6250` frame at all.
 *
 * No family is routed to the privacy envelope (6250). Beyond the app not using it, that envelope has no
 * level-1 form, so it cannot be sent at all on a session whose key negotiation concluded without a key —
 * and it is not the param this member reads, so a write there cannot be confirmed by a readback.
 */
function powerCommand(on: boolean, ctx: CommandContext): Command {
  return setScalar(CAMERA_CMD.CAMERA_ENABLE, powerValue(on, ctx), ctx, "auto");
}

/** Privacy mode: the multi-frame burst the sink plays. */
function privacyCommand(enabled: boolean, channel: number): Command {
  return { kind: "p2p-privacy-burst", enabled, channel };
}

/**
 * Status LED — family-variant, like camera power above. A **Video Doorbell**'s user-facing LED (the
 * button ring) is `DOORBELL_LED` (1716) carried in the `SET_PAYLOAD` (1350) envelope
 * `{light_enable}` — ✅ verified live on T8214; the firmware ignores the generic camera LED there.
 * Every other camera uses `DEV_LED_SWITCH` (1045), level-1 int+string, value 0/1. The doorbell is a
 * `camera`-codec device, so its LED belongs to this one `setStatusLed` surface (swap the wire by
 * family) rather than a duplicate action on the doorbell capability.
 *
 * The doorbell branch stays level-2 only: it carries the envelope's default `mValue3` (the sub-command),
 * which the level-1 form writes as 0 — so `"auto"` here would send an uncaptured object rather than the
 * same one under a different seal. See `setPayload`'s two conditions.
 */
function statusLedCommand(on: boolean, ctx: CommandContext): Command {
  if (hasCapability(ctx, "doorbell")) return setPayload(CAMERA_CMD.DOORBELL_LED, { light_enable: on ? 1 : 0 }, ctx);
  return setScalar(CAMERA_CMD.DEV_LED_SWITCH, on ? 1 : 0, ctx, "int-string");
}

/**
 * How this camera is powered, as every media egress needs to be told: a battery device is streamed
 * under a budget, a wired one unbounded. The model and latest raw charge status refine the resolved
 * battery capability. Every egress gets the same current tier because any can create the shared source.
 */
function poweredOf(ctx: CommandContext, readRaw?: MemberDeps["readRaw"]): "wired" | "battery" {
  return cameraPowerTier(ctx.model, ctx.capabilities ?? new Set(), readRaw?.(BATTERY_PARAM.BATTERY_STATUS));
}

/**
 * The param an enablement write will be reflected under on THIS device, and the raw value to expect there.
 *
 * Written wire and reported wire are not the same one. Every family is written on
 * {@link CAMERA_CMD.CAMERA_ENABLE}, but the standalone indoor/outdoor cameras report their state under the
 * `2001` read alias and never the param that was written — measured on one account, 5 cameras report the
 * enablement param and never `2001`, 3 report `2001` and never the enablement param, and none reported both.
 * So the readback follows the reported param, chosen from the evidence the device gave, and each carries its
 * own convention: `2001` is direct, the enablement param takes the family polarity its write uses.
 *
 * `undefined` where no readback can confirm the write: a device that reported neither param has nothing to
 * read, and on the families whose power rides the privacy envelope the write lands on a wire the read never
 * observes — the disagreement that puts `enabled` in `unreflectedMembers`. Claiming observability there would
 * time out on every write instead of dispatching it.
 */
function enablementReflection(
  on: boolean,
  ctx: CommandContext,
): { param: number; expected: boolean | number; observed: boolean } | undefined {
  const alias = CAMERA_MEMBERS.enabled.readAliases[0].paramType;
  if (ctx.paramIds.has(alias)) return { param: alias, expected: on, observed: on };
  if (ctx.paramIds.has(CAMERA_CMD.CAMERA_ENABLE)) {
    return { param: CAMERA_CMD.CAMERA_ENABLE, expected: powerValue(on, ctx), observed: on };
  }
  return undefined;
}

/**
 * Refuse a media pull where the `enabled` reading is false.
 *
 * `undefined` is permissive: a camera that never reported its state is not a camera known to be off.
 */
function refuseWhenDisabled(ctx: CommandContext, read: (name: string) => { value: unknown } | undefined): void {
  if (read("enabled")?.value === false) throw new CameraDisabledError(ctx.name ?? ctx.serial);
}

/**
 * Every `camera` feature, declared once. The property schema, the typed getters, the derived setters,
 * the intent routes, the media methods and the descriptions all come out of this table.
 *
 * The enum members publish no option set of their own beyond `enumValues` — a second copy of a set
 * could only drift from it — and each refusal message is generated from that same set.
 *
 * No `reboot`: it is a STATION operation with an unproven wire, shipped as the device-level
 * `EufyMega.reboot(sn)` (wire-confirmed station-scalar RESTART_HUB) rather than guessed at here.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const CAMERA_MEMBERS = {
  /** Current live-media power tier, including an externally powered battery device. */
  powerTier: method(
    ({ ctx, readRaw }) =>
      () =>
        poweredOf(ctx, readRaw),
    "Current power tier for live media: wired or battery-budgeted.",
  ),
  /**
   * The READ is the *disable*-bit convention (1035 "0" ⇒ ON, 2001 direct); the WRITE polarity is
   * family-dependent — see `powerValue` / `isEnableBitPolarity`. Battery/solo cams report the state under
   * 1035, standalone indoor/outdoor cams under 2001 OPEN_DEVICE with direct polarity, so 2001 is a
   * read-alias. Both verified live, and the write polarity is confirmed against the app's own frames.
   *
   * The read and the setter observe the SAME wire on every family — see `powerCommand` — which is what
   * makes this value track what it is told, and what lets `enablementReflection` confirm a write.
   *
   * The privacy param (6250) is reported by the outdoor-PT family and by no other camera measured, and both
   * of its polarities are observed. It is deliberately NOT aliased here: it moved in the same step as 1035, so
   * the reading cannot say whether power and privacy are one state or two, and the app drives 1035 — so
   * aliasing a second param could only fold two possible states into one getter for no gain.
   */
  enabled: {
    param: CAMERA_CMD.CAMERA_ENABLE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    invert: true,
    readAliases: [{ paramType: 2001, invert: false }],
    description:
      "Camera enabled. Family-dependent wire param: 1035 CMD_DEVS_SWITCH (disable bit, battery/" +
      "solo cams) or 2001 OPEN_DEVICE (standalone indoor/outdoor). Reliable on/off status source " +
      "(a live-stream probe is not).",
    observation: {
      event: "cameraEnabledChanged",
      reflects: (value, ctx) => enablementReflection(asBool(value), ctx),
      timeoutMs: 20_000,
    },
    write: (v, ctx) => powerCommand(asBool(v), ctx),
    aliases: { on: true, off: false },
  },
  /**
   * A 180° rotation for a ceiling or upside-down mount, not a mirror — the app's own constant calls it
   * `INDOOR_ROTATE_IMAGE` but it is not indoor-only. `apk` provenance: the wire is read out of the app
   * parser and the write has not been driven on hardware, so treat a silent no-op as possible and
   * confirm by re-reading rather than by trusting the dispatch.
   */
  imageFlipped: {
    param: CAMERA_CMD.ROTATE_IMAGE,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description:
      "Rotate the image 180° (ROTATE_IMAGE 1207): false = normal, true = flipped. " +
      "For ceiling/upside-down mounts. Write is a direct param; wire from the app parser (unverified live).",
    write: (v, ctx) => setScalar(CAMERA_CMD.ROTATE_IMAGE, asBool(v) ? 1 : 0, ctx, "auto"),
  },
  /**
   * A THREE-VALUE enum, not the boolean the name suggests — the middle option is timestamp without the
   * logo, so a plain switch cannot express every state the device has. `coerceEnumValue` refuses
   * anything outside {@link Watermark} instead of coercing it: on a fire-and-forget write a bogus index
   * would dispatch and look like it worked. The labels are the app's radio order.
   */
  watermark: {
    param: CAMERA_CMD.SET_DEVS_OSD,
    type: "enum",
    kind: "enum",
    enumValues: { 0: "Off", 1: "Timestamp", 2: "Timestamp + Logo" },
    provenance: "verified",
    description:
      "On-screen watermark/OSD overlay (CMD_SET_DEVS_OSD 1214). ✅ wire verified live (T8425 ch3): " +
      "direct-binary [ch][value 0/1/2] — a 3-value enum, not a bool. Enum labels are best-guess.",
    write: (v, ctx) => {
      const w = coerceEnumValue(Watermark, v);
      return w == null ? undefined : setScalar(CAMERA_CMD.SET_DEVS_OSD, w, ctx, "auto");
    },
  },
  /**
   * Whether the camera triggers on what it HEARS — the sound counterpart to motion detection, which the
   * app presents beside it. The camera keeps the sensitivity and the type it was last given, so
   * switching this off and on again restores the previous configuration rather than resetting it.
   */
  soundDetection: {
    param: CAMERA_CMD.SOUND_DETECTION,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "Trigger on sound as well as motion (SOUND_DETECTION 6043). ✅ Write confirmed live on a T8410 " +
      "(mains, standalone, own channel): both directions sent through this member and read back on " +
      "the cloud param, and the app's own frame captured byte-exact for the same body.",
    write: (v, ctx) => setJson(CAMERA_CMD.SOUND_DETECTION, { status: asBool(v) ? 1 : 0 }, ctx),
  },
  /**
   * How loud a sound must be to trigger: `1` lowest, `3` mid, `5` highest, on the app's own
   * three-position control. A `scalar` rather than an enum — the endpoints and the midpoint are
   * observed, so 2 and 4 are a prediction of the scale's shape rather than values the wire is known to
   * take. Independent of {@link CAMERA_MEMBERS.soundDetection}: the camera stores it whether sound
   * detection is on or off.
   */
  soundDetectionSensitivity: {
    param: CAMERA_CMD.SOUND_DETECTION_SENSITIVITY,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    description:
      "Sound-detection sensitivity: 1 = lowest, 3 = mid, 5 = highest (SOUND_DETECTION_SENSITIVITY " +
      "6044). ✅ Write confirmed live on a T8410: 1 and 5 sent consecutively through this member and " +
      "read back on the cloud param. 2 and 4 are the scale's shape, not observed values.",
    write: (v, ctx) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
      return setJson(CAMERA_CMD.SOUND_DETECTION_SENSITIVITY, { index: n }, ctx);
    },
  },
  /**
   * WHICH sounds count — any sound, or crying alone. `coerceEnumValue` refuses anything outside
   * {@link SoundDetectionType} rather than coercing it: both neighbouring values are real types, so a
   * coerced one arms the wrong trigger and reports success.
   */
  soundDetectionType: {
    param: CAMERA_CMD.SOUND_DETECTION_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: { 1: "Crying", 2: "All Sound" },
    provenance: "verified",
    description:
      "Which sounds trigger a detection: crying alone, or any sound (SOUND_DETECTION_TYPE 6046). ✅ " +
      "Write confirmed live on a T8410: both values sent consecutively through this member and read " +
      "back on the cloud param.",
    write: (v, ctx) => {
      const type = coerceEnumValue(SoundDetectionType, v);
      return type == null ? undefined : setJson(CAMERA_CMD.SOUND_DETECTION_TYPE, { type }, ctx);
    },
  },
  /**
   * `coerceEnumValue` refuses anything outside {@link NotificationStyle} instead of coercing it: every
   * neighbouring value is itself a real style, so a coerced one selects the wrong notification and
   * reports success.
   *
   * `transaction` is part of the verified frame — a decimal epoch-in-milliseconds string, fresh per
   * command.
   */
  notificationStyle: {
    param: CAMERA_CMD.PUSH_NOTIFY_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: { 1: "Text Only", 2: "Included Thumbnail", 3: "Text First, Then Thumbnail" },
    provenance: "verified",
    description:
      "How much a detection push carries: text only, a thumbnail, or text then a thumbnail " +
      "(CMD_INDOOR_PUSH_NOTIFY_TYPE 6020). All three values wire-verified live on a standalone " +
      "T8171 over the cloud/WAN path — the 1700 control-payload wrapper, each one read back on the " +
      "cloud param. A value outside the enum is REJECTED, not clamped: every neighbouring value is a " +
      "real style, so a bad one would silently select the wrong notification.",
    write: (v, ctx) => {
      const style = coerceEnumValue(NotificationStyle, v);
      return style == null
        ? undefined
        : setJson(CAMERA_CMD.PUSH_NOTIFY_TYPE, { value: style, transaction: String(Date.now()) }, ctx);
    },
  },
  /**
   * Three modes, and `FullColor` is the conditional one: a model without a spotlight or starlight
   * sensor omits it, and the wire accepts the value regardless — the device's own reported set is the
   * only statement of which of the three it has. `coerceEnumValue` rejects a value outside
   * {@link NightVision} rather than coercing it. The payload key on the wire is `night_sion`.
   */
  nightVision: {
    param: CAMERA_CMD.NIGHT_VISION_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: { 0: "Off", 1: "Infrared", 2: "Full Color" },
    provenance: "verified",
    description:
      "Night-vision mode (NIGHT_VISION_TYPE 1277): 0 = off, 1 = infrared (B&W), 2 = full colour. " +
      "✅ wire verified live (T8425 ch3): 1350 SET_PAYLOAD, mChannel 0, {channel:N, night_sion:mode}. " +
      "Enum labels are best-guess. Some models omit full colour.",
    write: (v, ctx) => {
      const nv = coerceEnumValue(NightVision, v);
      return nv == null
        ? undefined
        : setPayload(CAMERA_CMD.NIGHT_VISION_TYPE, { channel: ctx.channel, night_sion: nv }, ctx, 0, 0, "auto");
    },
  },
  /**
   * Live-view quality, the pair to {@link CAMERA_MEMBERS.recordingQuality} and a different setting on a
   * different wire: changing one leaves the other's parameter untouched.
   *
   * The READ is 1020, which reports the resolved tier as a plain integer. 1020 is also the name the
   * param dictionary already gives that id, and `Device` keys state by NAME — a member claiming 2730
   * under this name would collide with it on a device reporting both.
   *
   * `unverified: true` with no `write`: the app's 2730 frame is captured byte-exact, but replaying it
   * from this SDK produced no observable change on a standalone T8171, where the recording sibling's
   * 2731 write on the same envelope and the same session does land. The one difference the capture
   * shows is that the app's frame carries no `mChannel`/`mValue3`, which this envelope always emits.
   * Until a send is confirmed, the setter is absent — a control that silently does nothing is worse
   * than none — and the read ships ahead of it, which verification per direction allows.
   */
  streamingQuality: {
    param: 1020,
    type: "number",
    kind: "enum",
    enumValues: STREAMING_QUALITY_TIERS,
    provenance: "verified",
    unverified: true,
    description:
      "Live-view quality as a tier, 0 = Auto (1020). Distinct from recordingQuality, which is what gets " +
      "stored. All four tiers confirmed on a T8170 and a T8171. The WRITE (2730) is unconfirmed from " +
      "this SDK, so no setter is offered rather than one that reports success without acting — see " +
      "CAMERA_CMD.STREAMING_QUALITY_SET.",
  },
  /**
   * `type` is how the value is STORED, and 2731 stores the whole config — the ACTIVE tier is lifted out
   * of it by `decode`, so the getter answers a tier while the schema stays honest. The setter
   * takes a resolution NAME as well as the tier the getter answers.
   */
  recordingQuality: {
    param: CAMERA_CMD.RECORDING_QUALITY_SET,
    type: "string",
    provenance: "verified",
    decode: (raw) => decodeRecordingQualityTier(raw),
    decodedKind: "enum",
    decodedValues: Object.keys(RECORDING_QUALITY_TIERS).map(Number),
    // Label the decoded tiers so a host can render this as a labelled choice (a dropdown) rather than
    // a bare number — same shape as `suction` and the sibling `streamingQuality`. `decode` still owns
    // the value (a tier); these are only the tier→label map, keyed to match `decodedValues`.
    enumValues: RECORDING_QUALITY_TIERS,
    description:
      "RECORDING quality as a tier (2731) — distinct from streamingQuality, which is the live view. " +
      "The device reports the whole config — " +
      "`{cur_mode, mode_<n>:{quality}}`, read live off a T8170 — and the ACTIVE mode's tier is lifted out " +
      "of it on read. ✅ write wire verified live (T8425): 1350 SET_PAYLOAD " +
      "{channel:0, mode:0, primary_view:0, quality:N}. Tier→label in RECORDING_QUALITY_TIERS / resolveRecordingQuality " +
      "(verified on T8425; add a per-model map if a model's tiers ever diverge).",
    args: [{ name: "quality", kind: "enum", description: "A tier; the resolution name it maps to is accepted too." }],
    ...accepts<RecordingQualityName>(),
    write: (v, ctx) => {
      const q = resolveRecordingQualityTier(v);
      return q == null
        ? undefined
        : setPayload(
            CAMERA_CMD.RECORDING_QUALITY_SET,
            { channel: 0, mode: 0, primary_view: 0, quality: q },
            ctx,
            0,
            undefined,
            "auto",
          );
    },
  },
  /**
   * Not every model has the feature, and one without it accepts the frame without acting on it — so the
   * write is offered only where the device reports 1015, the same param the read is gated on.
   */
  antiTheftDetection: {
    param: CAMERA_CMD.EAS_SWITCH,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description:
      "Anti-theft detection on/off (1015 APP_CMD_EAS_SWITCH; the app parses it as " +
      "anti_theft_detection_switch). Adaptive scalar {value:0|1}. ⚠️ Replay+readback confirmed on a " +
      "HomeBase-attached T8425 only; standalone unverified and v3 devices use id 2735 — see " +
      "CAMERA_CMD.EAS_SWITCH.",
    requires: [CAMERA_CMD.EAS_SWITCH],
    write: (v, ctx) => setScalar(CAMERA_CMD.EAS_SWITCH, asBool(v) ? 1 : 0, ctx, "auto"),
  },

  /**
   * Privacy mode — the multi-frame burst. Nothing reports it back, so it is a setter with no getter, and
   * it declares no param: the id the burst is built from is the transport's, not this capability's.
   *
   * Being write-only, it is named by `unobservableMembers(dev.camera())`, which distinguishes "this camera
   * is not in privacy mode" from "this camera cannot say" rather than leaving both as `undefined`. That
   * distinction matters most on the families whose power rides this same envelope — see {@link enabled}.
   */
  privacy: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    provenance: "verified",
    description: "Privacy mode (PRIVACY_MODE 6250) — the multi-frame burst the sink plays.",
    write: (v, ctx) => privacyCommand(asBool(v), ctx.channel),
  },
  /**
   * The same status LED is reported under 1045 on ordinary cameras and 1716 on video doorbells. The
   * alias is the same semantic value on a family-specific wire. The parameter valid for the resolved
   * family is sufficient evidence to install both the getter and family-aware setter.
   */
  statusLed: {
    param: CAMERA_CMD.DEV_LED_SWITCH,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    readAvailable: (ctx) => !hasCapability(ctx, "doorbell"),
    readAliases: [{ paramType: CAMERA_CMD.DOORBELL_LED, available: (ctx) => hasCapability(ctx, "doorbell") }],
    requiresRead: true,
    description: "Camera status LED. Video doorbells report the same state under their button-ring LED parameter.",
    write: (v, ctx) => statusLedCommand(asBool(v), ctx),
  },

  /**
   * Media is not a property: it returns DATA rather than moving state, its options are richer than a
   * value, and it exists only on a device bound to a provider. Each is declared once, with its
   * signature taken FROM {@link MediaProvider} — so a change there is a compile error here, not a drift.
   *
   * Every pull is refused where {@link CAMERA_MEMBERS.enabled} reads false, with {@link CameraDisabledError} —
   * `live`, `snapshotLive`, `record`, `openReadable` and `recordFragments` alike, since each opens media on a
   * camera that serves none. That reading is the on/off source; a live probe is not one, since a disabled
   * camera answers a start with audio and never a video frame.
   *
   * {@link CAMERA_MEMBERS.snapshotStored} is exempt — a retained push thumbnail is not a pull. A reading of
   * `undefined` refuses nothing: families reporting neither wire param leave the state unknown, and unknown is
   * not known-off.
   *
   * The refusal REJECTS on the four that answer with a promise, and THROWS on
   * {@link CAMERA_MEMBERS.recordFragments}, which answers with a handle.
   */
  snapshotStored: provided(
    "media",
    (m) => m.snapshotStored && (() => m.snapshotStored!()),
    "Latest validated push thumbnail retained in memory.",
    ["snapshot"],
  ),
  snapshotLive: provided(
    "media",
    (m, { ctx, read, readRaw }) =>
      async (opts?: Parameters<MediaProvider["snapshotLive"]>[0]) => {
        refuseWhenDisabled(ctx, read);
        return m.snapshotLive({ powered: poweredOf(ctx, readRaw), ...opts });
      },
    "Fresh still decoded from a short live burst.",
  ),
  live: provided(
    "media",
    (m, { ctx, read, readRaw }) =>
      async (opts?: Parameters<MediaProvider["live"]>[0]) => {
        refuseWhenDisabled(ctx, read);
        return m.live({ powered: poweredOf(ctx, readRaw), ...opts });
      },
    "Open a managed live stream.",
  ),
  record: provided(
    "media",
    (m, { ctx, read }) =>
      async (...args: Parameters<MediaProvider["record"]>) => {
        refuseWhenDisabled(ctx, read);
        return m.record(...args);
      },
    "Record N seconds → an mp4/h264 buffer.",
  ),
  openReadable: provided(
    "media",
    (m, { ctx, read, readRaw }) =>
      m.openReadable &&
      (async (opts?: Parameters<NonNullable<MediaProvider["openReadable"]>>[0]) => {
        refuseWhenDisabled(ctx, read);
        return m.openReadable!({ powered: poweredOf(ctx, readRaw), ...opts });
      }),
    "Open a node:stream Readable of the live feed.",
  ),
  recordFragments: provided(
    "media",
    (m, { ctx, read, readRaw }) =>
      m.recordFragments &&
      ((opts?: Parameters<NonNullable<MediaProvider["recordFragments"]>>[0]) => {
        refuseWhenDisabled(ctx, read);
        return m.recordFragments!({ powered: poweredOf(ctx, readRaw), ...opts });
      }),
    "Continuous fragmented-MP4 (CMAF) recording.",
  ),
  /**
   * Push audio from the host to this camera's speaker. Gated on the **speaker** param specifically —
   * not the `audio` capability, which resolves on a microphone alone and would advertise a speaker the
   * device never reported. Talkback holds a media session open for its duration, so it carries the same
   * power hint `live` does; without it a battery camera talked to with no stream running would stream
   * unbounded.
   */
  talkback: provided(
    "media",
    (m, { ctx, readRaw }) =>
      m.talkback &&
      ctx.paramIds.has(AUDIO_CMD.AUDIO_SPEAKER) &&
      ((opts?: Parameters<NonNullable<MediaProvider["talkback"]>>[0]) =>
        m.talkback!({ powered: poweredOf(ctx, readRaw), ...opts })),
    "Push audio from the host to the camera's speaker.",
  ),
} as const satisfies Members;

export const CAMERA: CapabilityModule = {
  capability: "camera",
  description: "Camera power (on/off, CAMERA_SWITCH 1035) and privacy mode (PRIVACY_MODE 6250).",
  members: CAMERA_MEMBERS,
  properties: propertiesOf(CAMERA_MEMBERS),
  /** Every camera-codec device has the power/privacy surface. */
  detection: { codecs: ["camera"] },
  /** Only the no-argument power verbs, which carry no value for a member to hold. */
  actions({ ctx, sink }: MemberDeps): CapabilityActions {
    return {
      on: () => sink.dispatch(powerCommand(true, ctx)),
      off: () => sink.dispatch(powerCommand(false, ctx)),
    };
  },
};
