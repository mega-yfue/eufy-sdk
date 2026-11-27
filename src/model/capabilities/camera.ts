import { asBool, coerceEnumValue } from "../../core/util.js";
import { DeviceType } from "../device-types.js";
import { IndoorPushEvent } from "../push-events.js";
import {
  isUntriedDoorbell,
  isIndoorCamera,
  isIndoorCamMini,
  isIndoorPanTiltS350,
  isVideoSmartLock,
} from "../device-family.js";
import { setScalar, setPayload, setJson, isCameraCodec, hasCapability } from "./access.js";
import { described } from "./thing-description.js";
import { AUDIO_CMD } from "./audio.js";
import { cameraPowerTier } from "./battery.js";
import { accepts, propertiesOf, provided, type Members, type Surface, type MemberDeps } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CapabilityActions, CommandContext } from "./types.js";
import {
  CameraDisabledError,
  type Command,
  type MediaProvider,
  type MediaSourceSelection,
} from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this camera capability drives (direct-binary switches + `1350`
 * SET_PAYLOAD sub-commands). These are the capability's own wire vocabulary — the transport carries
 * `cmd.param` opaquely and never names them (the full 541-entry id→name catalog lives in the generated
 * `transport/p2p/commands.ts`). Each entry notes its app `CommandType` name.
 */
export const CAMERA_CMD = {
  /** Camera-reported Wi-Fi signal (app `CMD_GET_WIFI_RSSI`). */
  WIFI_RSSI: 1142,
  /** Camera on/off. Read and write polarity depend on the family and topology. */
  CAMERA_ENABLE: 1035,
  /** Camera power as privacy mode in the `1350` envelope, `{switch}` 1 = privacy on (app `COMMAND_APP_PRIVACY`). */
  PRIVACY_MODE: 6250,
  /** Standalone power as privacy mode in the `1700` wrapper, `{value}` 1 = privacy on (app `COMMAND_INDOOR_PRIVACY_MODE_STATUS`). */
  PRIVACY_MODE_STATUS: 6090,
  /** Standalone status LED in the `1700` wrapper, `{value:0|1}` (app `IC_LED_STATUS`). */
  IC_LED_STATUS: 6014,
  /** Wired-doorbell status LED in the `1700` wrapper, `{status:0|1}` (app `DOORBELL_COMMAND_LED_NIGHT_OPEN`). */
  DOORBELL_LED_NIGHT: 1026,
  /** Station-attached notification style in the `1350` envelope, `{notification_style}` (app `SET_PUSH_EFFECT`). */
  PUSH_EFFECT: 1289,
  /** Live-view quality tier in the `1700` wrapper, `{quality}` (app `STREAMING_QUALITY`). */
  STREAMING_QUALITY: 1020,
  /** Recording quality tier in the `1700` wrapper, `{quality}` (app `COMMAND_VIDEO_RECORD_QUALITY`). */
  VIDEO_RECORD_QUALITY: 1023,
  /** Recording quality tier in the `1350` envelope, `{record_quality}` (app `APP_CMD_SET_RECORD_QUALITY`). */
  SET_RECORD_QUALITY: 1286,
  /** Anti-theft switch in the `1350` envelope, `{value:0|1}` (app `APP_CMD_NEW_EAS_SWITCH`). */
  NEW_EAS_SWITCH: 2735,
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
  /** Night vision on a device reporting 2002: direct level-1 [channel][value]. */
  IC_NIGHT_VISION_TYPE: 1013,
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
 * Night-vision mode: 0=Off, 1=Infrared (the app shows "B&W Auto"), 2=FullColor ("Color"), 3=InfraredOn.
 * Use `NightVision.FullColor` etc. with `setNightVision` / `setProperty(sn,"nightVision",…)`. Each model
 * offers a subset.
 */
export const NightVision = {
  /** Off — never use infrared. */
  Off: 0,
  /** Infrared / "B&W Auto" — black-and-white night vision, switched on when it gets dark. */
  Infrared: 1,
  /** Full colour night vision (models with a spotlight / starlight sensor). */
  FullColor: 2,
  /** Infrared held on — black-and-white night vision, not switched by the light level. */
  InfraredOn: 3,
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
  return optionOf(value, STREAMING_QUALITY_TIERS);
}

/** The option a value names: one of the option values, or a label in any case. Never a boolean. */
function optionOf(value: number | string | boolean, options: Readonly<Record<number, string>>): number | undefined {
  if (typeof value === "boolean") return undefined;
  const v = String(value).trim().toLowerCase();
  const hit = Object.entries(options).find(([option, label]) => option === v || label.toLowerCase() === v);
  return hit ? Number(hit[0]) : undefined;
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
  return optionOf(value, RECORDING_QUALITY_TIERS);
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
 * a mode with no entry, a tier not among `options` — is `undefined` rather than a guess.
 */
function decodeRecordingQualityTier(raw: unknown, options: Readonly<Record<number, string>>): number | undefined {
  if (typeof raw === "number" || typeof raw === "string") return optionOf(raw, options);
  if (typeof raw !== "object" || raw === null) return undefined;
  const cfg = raw as Record<string, unknown>;
  const mode = cfg[`mode_${Number(cfg.cur_mode) || 0}`];
  const quality = typeof mode === "object" && mode !== null ? (mode as Record<string, unknown>).quality : undefined;
  return typeof quality === "number" ? optionOf(quality, options) : undefined;
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
 * - **on/off** = `CAMERA_SWITCH` (1035), or the privacy wire {@link POWER_WIRE} picks. This
 *   module owns the *semantic* part — the value
 *   polarity, which is family-dependent (enable-bit ON ⇒ 1 for indoor cams + the 8422/8424
 *   floodlight-cams, disable-bit ON ⇒ 0 for battery/solo and for an indoor camera (type 30) that
 *   reports 1035 itself — see `isEnableBitPolarity`). The WIRE (level-1 int-string vs level-2
 *   direct-binary) is NOT decided here: it emits a `"auto"` scalar intent and the transport resolver
 *   picks the level by session (standalone ⇒ L1, HomeBase ⇒ L2).
 * - **privacy** = power inverted, on the privacy wire {@link POWER_WIRE} picks (6250 / 6090).
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
 *
 * An indoor camera (type 30) that reports its state under 1035 itself is the exception: there 1035 carries
 * the disable bit the read already decodes, so the write takes that polarity and both sides agree.
 * ✅ Verified live on a HomeBase-attached T8400 reporting 1035="0" while on and the eufy app enabled.
 * Only that type was measured — other indoor types reporting 1035 keep the enable bit until one is captured
 * (#304 reports a T8030-attached T8410, type 31, whose 1035 reads as an enable bit).
 */
function isEnableBitPolarity(ctx: CommandContext): boolean {
  const t = ctx.deviceType;
  if (t === undefined) return false;
  if (t === DeviceType.INDOOR_CAMERA && ctx.paramIds.has(CAMERA_CMD.CAMERA_ENABLE)) return false;
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

/** T8410 reports an enable bit on HomeBase 3; its wrapped command carries a disable bit. */
function isT8410HomeBase3(ctx: AvailabilityContext): boolean {
  return ctx.model === "T8410" && ctx.stationSerial?.startsWith("T8030") === true;
}

/** A device that reports its night vision on 2002 and not on 1277. */
function readsNightVisionOn2002(ctx: AvailabilityContext): boolean {
  return ctx.paramIds?.has(2002) === true && !ctx.paramIds.has(CAMERA_CMD.NIGHT_VISION_TYPE);
}

/**
 * A privacy-mode power write is reflected only where the read observes it: on 6250 where the product's
 * bundle reads it there, else on a reported 2001. The HomeBase-attached S350 ({@link hasPrivacyPower})
 * does not reflect it.
 */
function hasUnreflectedPower(ctx: CommandContext): boolean {
  if (POWER_WIRE(ctx) !== CAMERA_CMD.PRIVACY_MODE) return false;
  return (
    hasPrivacyPower(ctx) || !(ctx.things ? readsPower(CAMERA_CMD.PRIVACY_MODE, false)(ctx) : ctx.paramIds.has(2001))
  );
}

/**
 * Whether this camera is powered through the privacy burst: an S350 riding a HomeBase, the only topology run.
 * A standalone S350 stays on the auto-sealed 1035, which a keyless session can still send.
 */
function hasPrivacyPower(ctx: CommandContext): boolean {
  return ctx.deviceType === DeviceType.INDOOR_PT_CAMERA_S350 && ctx.homeBaseAttached === true;
}

/**
 * Camera power on the wire {@link POWER_WIRE} picks: 1035 with the family polarity, or privacy mode
 * (6250 `{switch}`, 6090 `{value}`) carrying the inverse. The 6250 envelope keeps mValue3=0 and the camera
 * channel. The HomeBase-attached S350 ({@link hasPrivacyPower}) takes the same id as {@link privacyCommand}'s burst.
 */
function powerCommand(on: boolean, ctx: CommandContext): Command {
  const wire = POWER_WIRE(ctx);
  if (wire === CAMERA_CMD.PRIVACY_MODE && hasPrivacyPower(ctx)) return privacyCommand(!on, ctx.channel);
  if (wire === CAMERA_CMD.PRIVACY_MODE)
    return setPayload(CAMERA_CMD.PRIVACY_MODE, { switch: on ? 0 : 1 }, ctx, 0, undefined, "auto");
  if (wire === CAMERA_CMD.PRIVACY_MODE_STATUS)
    return setJson(CAMERA_CMD.PRIVACY_MODE_STATUS, { value: on ? 0 : 1 }, ctx);
  return setScalar(CAMERA_CMD.CAMERA_ENABLE, powerValue(on, ctx), ctx, "auto");
}

/** Privacy mode: the multi-frame burst the sink plays. */
function privacyCommand(enabled: boolean, channel: number): Command {
  return { kind: "p2p-privacy-burst", enabled, channel };
}

/**
 * A camera-codec device whose product description, when fetched, lists one of `identifiers`: a video
 * lock is camera codec too, and its description leaves out the settings it does not have.
 */
const cameraThing =
  (...identifiers: string[]) =>
  (ctx: AvailabilityContext): boolean =>
    isCameraCodec(ctx) && identifiers.some((identifier) => described(identifier)(ctx));

/**
 * The param one identifier is written on, per product, as its settings bundle (the per-product code the
 * description's `profile` names, corpus 2026-11-13) builds it. `groups` maps a wire to the product codes
 * sending it: `1045` on every topology, `6014/1045` standalone / HomeBase-attached (the bundle's
 * `getConnectType`), `-` nothing; `CODE__vN` where the bundle builds the resolved variant differently.
 * An unlisted product sends `fallback`. `undefined` is no wire. A station-only eufyCam (T811x, T814x,
 * T816x) is never standalone, so it is listed only where its wire differs from the fallback's attached arm.
 */
function bundleWires(identifier: string, fallback: string, groups: Readonly<Record<string, string>>) {
  const arm = bundleArm(identifier, fallback, groups);
  return (ctx: AvailabilityContext): number | undefined => {
    const wire = arm(ctx);
    return wire === "-" ? undefined : Number(wire);
  };
}

/** The {@link bundleWires} arm this device's product and topology select, as the table states it. */
function bundleArm(identifier: string, fallback: string, groups: Readonly<Record<string, string>>) {
  const table = new Map<string, string>();
  for (const [wire, codes] of Object.entries(groups)) for (const code of codes.split(" ")) table.set(code, wire);
  return (ctx: AvailabilityContext): string => {
    const model = ctx.model ?? "";
    const variant = ctx.things?.properties[identifier]?.identifier.slice(identifier.length) ?? "";
    const arms = (table.get(model + variant) ?? table.get(model) ?? fallback).split("/");
    return arms[ctx.homeBaseAttached === true ? arms.length - 1 : 0];
  };
}

/** A camera member offered where its identifier is described and the product's bundle writes it. */
const offers =
  (identifier: string, wire: (ctx: AvailabilityContext) => number | undefined) =>
  (ctx: AvailabilityContext): boolean =>
    cameraThing(identifier)(ctx) && wire(ctx) !== undefined;

/**
 * `camera_on_off` as each product's bundle writes it (`parse` of the parser it registers, else its inline
 * case when that answers nothing): 1035, or privacy mode. Not built here: the T84A1/T81A0 `param_data` wire.
 */
const POWER_WIRE = bundleWires("camera_on_off", "1035", {
  "1035/6250": "T6310 T8352 T8354 T8400 T8401 T8410 T8411 T8416 T8417 T8419 T8441 T8442 T85M0 T85V0 T8W11 T8W11C",
  "6250": "T8162 T8172 T817L",
  "6250/1035": "T8110 T8110E T814X",
  "6090/6250": "T8410C T8414",
  "1035/-": "T8452 T8453",
  "-/1035": "T81A0",
  "-": "T7401 T84A1 T8790",
});

/**
 * `camera_on_off` as each product's bundle reads it back (`parseCommandToModel` of the parser it registers,
 * else its inline case), in the {@link bundleWires} form. `+` joins params one parser reads alike, the last
 * one reported winning; `>` orders params a product parser reads over its base parser's, or one param the
 * parser prefers when reported. 1035, 6250 and 99904 read "0" as on, 2001 "true" and 1131 "1"; a param never
 * reported leaves the description default.
 */
const POWER_READ = bundleArm("camera_on_off", "1035", {
  "6250": "T8162 T817L",
  "6250/1035": "T8110 T8110E T814X",
  "1035/6250": "T8416 T8417 T8419 T85M0 T85V0 T8W11 T8W11C",
  "2001/6250>1035": "T8400 T8401 T8410 T8410C T8411 T8414",
  "2001+1131/6250+1131": "T8441 T8442",
  "2001": "T8420X",
  "1035+6250": "T6310 T8352 T8354",
  "6250>1035": "T8172",
  "2001+1035": "T8422 T8424",
  "99904>1035/1035>99904": "T8200X T8201X T8210 T8210C T8220 T8221 T8222",
  "2001>99904>1035/2001>1035>99904": "T8200 T8201 T8202",
  "1035>99904": "T8203 T8213 T8214 T8217 T8223 T8224",
  "99904>1035": "T8420",
});

/**
 * Whether this device reads its power state from `param`: per {@link POWER_READ} once described, from the
 * first `>` rank the device reported a param of, else `undescribed`. A record names a station serial only
 * for an attached device, which places it before a live context states the topology.
 */
const readsPower =
  (param: number, undescribed: boolean) =>
  (ctx: AvailabilityContext): boolean => {
    if (!ctx.things) return undescribed;
    const arm = POWER_READ({ ...ctx, homeBaseAttached: ctx.homeBaseAttached ?? ctx.stationSerial !== undefined });
    const ranks = arm.split(">").map((rank) => rank.split("+").map(Number));
    return (ranks.find((rank) => rank.some((p) => ctx.paramIds?.has(p))) ?? ranks.flat()).includes(param);
  };

/** Power, privacy and the on/off verbs. */
const cameraSwitch = offers("camera_on_off", POWER_WIRE);

/**
 * Bundle-only frames (6090 here; 1026, 1020, 1023, 1286 and 2735 below) stay `unverifiedFor` until a device
 * answers one.
 */
const privacyStatusPower = (ctx: AvailabilityContext): boolean => POWER_WIRE(ctx) === CAMERA_CMD.PRIVACY_MODE_STATUS;

/**
 * `led_on_off`. 1716 rides the `1350` envelope `{light_enable}` with its default mValue3, so it stays
 * level-2 only; 1045 is level-1 int+string.
 */
const LED_WIRE = bundleWires("led_on_off", "6014/1045", {
  "1045": "T8028 T8420 T8423 T8452 T8453",
  "1716": "T8210 T8210C T8213 T8214 T8220 T8221 T8222 T8223 T8224",
  "1026": "T8200 T8200X T8201 T8201X T8202",
  "6014": "T8420X T8441 T8442",
  "6014/-": "T8422 T8424 T8531 T85V0",
  "-": "T81A0 T84A1 T8790",
});

/** A C30/C31 or a video lock has reported no 1716, so its LED is read on 1045 whatever it is written on. */
const doorbellLed = (ctx: AvailabilityContext): boolean => hasCapability(ctx, "doorbell") && !isUntriedDoorbell(ctx);

/** Status LED on the wire {@link LED_WIRE} picks. */
function statusLedCommand(on: boolean, ctx: CommandContext): Command {
  const value = on ? 1 : 0;
  switch (LED_WIRE(ctx)) {
    case CAMERA_CMD.DOORBELL_LED:
      return setPayload(CAMERA_CMD.DOORBELL_LED, { light_enable: value }, ctx);
    case CAMERA_CMD.IC_LED_STATUS:
      return setJson(CAMERA_CMD.IC_LED_STATUS, { value }, ctx);
    case CAMERA_CMD.DOORBELL_LED_NIGHT:
      return setJson(CAMERA_CMD.DOORBELL_LED_NIGHT, { status: value }, ctx);
    default:
      return setScalar(CAMERA_CMD.DEV_LED_SWITCH, value, ctx, "int-string");
  }
}

/**
 * `notification_type`: 6020 standalone, 1289 attached. Not built here: the attached doorbells' 1710
 * object (it carries two other settings), the wired doorbells' 1030 and 6020 `{style}`, the 6020
 * `{enable,value,status}` and `{value,notification_style}` payloads, and 6338 `param_data`.
 */
const NOTIFICATION_WIRE = bundleWires("notification_type", "6020/1289", {
  "6020": "T8122 T8123 T8124 T8124R T8130 T8131 T817L T8441 T8442",
  "6020/-": "T8150 T8151 T8214 T8223 T8224 T8420X T8422 T8423 T8424 T8425 T8426 T8452 T8453 T85M0 T85V0",
  "-":
    "T8203 T8210 T8210C T8213 T8220 T8221 T8222 T8530 T8200 T8201 T8202 T8200X T8201X T86P2 T8W11 T8531 " +
    "T7400 T7401 T81A0 T84A1 T8790",
});

/**
 * `live_streaming_resolution`: 2730, or 1020 `{quality}`. Not built here: 1705, which the doorbell's
 * `setVideoQuality` owns as a composite, and 1205 `param_data`.
 */
const STREAMING_WIRE = bundleWires("live_streaming_resolution", "2730", {
  "1020": "T8150 T8151 T8200 T8200X T8201 T8201X T8202 T8420X T8422 T8423 T8424 T8441 T8442 T8452 T8453 T8W11",
  "1020/2730": "T8400 T8401 T8410 T8410C T8411 T8414 T8W11C",
  "1020/-": "T8122 T8123 T8124 T8124R T8130 T8131 T8134 T8B00 T8419 T86P2 T8W11C__v1",
  "2730/-": "T85M0 T85V0",
  "-": "T8140 T8142 T8160 T8161 T8203 T8210 T8210C T8213 T8220 T8221 T8222 T8531 T81A0 T84A1 T8530 T8790",
});

/**
 * The options a resolution identifier lists on this product, wire value (`associatedValue`) → its label,
 * as the resolved description gives them: the values differ per wire and product (2K is 1 on a 1286
 * product, 3 on a 2731 one). `undefined` where a listed wire value is missing or repeats.
 */
const listedOptions =
  (identifier: string) =>
  (ctx: AvailabilityContext): Record<number, string> | undefined => {
    const members = ctx.things?.properties[identifier]?.members ?? [];
    const options = Object.fromEntries(members.map((m) => [Number(m.wireValue), m.desc.trim()]));
    const listed = Object.keys(options);
    return listed.length && listed.length === members.length && !listed.includes("NaN") ? options : undefined;
  };
const recordingOptions = listedOptions("record_resolution");

/** `record_resolution`: 2731, 1023 `{quality}` or 1286 `{record_quality}`. Not built here: 1286 `param_data`. */
const RECORDING_WIRE = bundleWires("record_resolution", "2731", {
  "1023":
    "T8123 T8124 T8124R T8131 T8134 T8150 T8151 T8200 T8200X T8201 T8201X T8202 T8422 T8424 T8441 T8442 T8452 " +
    "T8453 T8B00 T8W11",
  "1286": "T8123__v1 T8124__v1 T8124R__v1 T8131__v1 T8134__v1 T8B00__v1 T8140 T8142 T8160 T8161 T8210 T8210C",
  "1023/2731": "T8400 T8401 T8410 T8410C T8411 T8414 T8419 T8423 T8W11C",
  "2731/1286": "T8531 T85V0",
  "1023/1286": "T86P2",
  "-": "T81A0 T84A1 T8530 T8790",
});

/** `anti_theft_detection_switch`: 1015, the v3 parser 2735. */
const ANTI_THEFT_WIRE = bundleWires("anti_theft_detection_switch", "1015", { "2735": "T8172" });

/** `watermark_set`: 1214. Not built here: 9210's encoded `osd_value` and 1214 `param_data`. */
const WATERMARK_WIRE = bundleWires("watermark_set", "1214", {
  "-": "T8110 T8110E T814X T81A0 T84A1 T7400 T7401 T8530 T8790",
});

/**
 * How this camera is powered, as every media egress needs to be told: a battery device is streamed
 * under a budget, a wired one unbounded. Read off the resolved capabilities, except that a confirmed
 * mains-only model (see `cameraPowerTier` in battery.ts) is wired even with `battery` resolved. Given
 * to EVERY egress, since any of them may be the call that creates the shared source.
 */
function poweredOf(ctx: CommandContext): "wired" | "battery" {
  return cameraPowerTier(ctx.model, ctx.capabilities ?? new Set());
}

/**
 * The param an enablement write will be reflected under on THIS device, and the raw value to expect there.
 *
 * Written wire and reported wire are not necessarily the same one. Scalar power is written on
 * {@link CAMERA_CMD.CAMERA_ENABLE}, but the standalone indoor/outdoor cameras report their state under the
 * `2001` read alias and never the param that was written — measured on one account, 5 cameras report the
 * enablement param and never `2001`, 3 report `2001` and never the enablement param, and none reported both.
 * So the readback follows a reported param the getter reads on this device, the written one where it is
 * among them: `2001` reads "true" as on, 1035 takes the write polarity, the others read inverted or direct
 * as their read alias states. T8410/HomeBase 3 retains a useful startup enable bit, but it does not reliably
 * reflect the privacy write; `readReflectsWrite` withholds the readback there.
 *
 * `undefined` where a device reported no param the getter reads, or where `readReflectsWrite` says its
 * read does not follow the write.
 */
function enablementReflection(
  on: boolean,
  ctx: CommandContext,
): { param: number; expected: boolean | number; observed: boolean } | undefined {
  const m = CAMERA_MEMBERS.enabled;
  if (!m.readReflectsWrite(ctx)) return undefined;
  const reads = [
    { paramType: CAMERA_CMD.CAMERA_ENABLE, invert: true, available: m.readAvailable },
    ...m.readAliases,
  ].filter((r) => ctx.paramIds.has(r.paramType) && r.available(ctx));
  const read = reads.find((r) => r.paramType === POWER_WIRE(ctx)) ?? reads[0];
  if (!read) return undefined;
  const expected =
    read.paramType === CAMERA_CMD.CAMERA_ENABLE
      ? powerValue(on, ctx)
      : read.paramType === 2001
        ? on
        : Number(on !== read.invert);
  return { param: read.paramType, expected, observed: on };
}

/**
 * Refuse a media pull where a reliable `enabled` reading is false.
 *
 * `undefined` is permissive: a camera that never reported its state is not a camera known to be off.
 */
function refuseWhenDisabled(ctx: CommandContext, read: (name: string) => { value: unknown } | undefined): void {
  if (CAMERA_MEMBERS.enabled.readReflectsWrite(ctx) && read("enabled")?.value === false)
    throw new CameraDisabledError(ctx.name ?? ctx.serial);
}

/** Reject an unavailable optical view or output size before requesting media. */
function refuseUnsupportedSelection(media: MediaProvider, opts?: MediaSourceSelection): void {
  const view = opts?.view ?? 0;
  if (!(media.views ?? [0]).includes(view)) throw new RangeError(`camera: unsupported optical view ${view}`);
  if (opts?.outputResolution !== undefined && !media.outputResolutions?.includes(opts.outputResolution))
    throw new RangeError(`camera: unsupported output resolution ${opts.outputResolution}`);
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
  /** Reads the latest cached report and exposes no setter. */
  wifiRssi: {
    param: CAMERA_CMD.WIFI_RSSI,
    type: "number",
    kind: "scalar",
    provenance: "apk",
    description: "Camera-reported Wi-Fi signal; physical units and a quality scale are unspecified.",
  },
  /**
   * The default READ is the *disable*-bit convention (1035 "0" ⇒ ON, 2001 direct); the WRITE polarity is
   * family-dependent — see `powerValue` / `isEnableBitPolarity`. Battery/solo cams report the state under
   * 1035, standalone indoor/outdoor cams under 2001 OPEN_DEVICE with direct polarity, so 2001 is a
   * read-alias. Both verified live, and the write polarity is confirmed against the app's own frames.
   *
   * T8410 on HomeBase 3 reports 1035 as an enable bit ("1" ⇒ ON). That reported state does not reliably
   * reflect the privacy command. `readReflectsWrite` states this distinction.
   *
   * A described product reads the params {@link POWER_READ} names, 6250 among them, and the description's
   * default until one is reported. Without a description it reads 1035 or 2001, never 6250.
   */
  enabled: {
    param: CAMERA_CMD.CAMERA_ENABLE,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    thing: ["camera_on_off"],
    thingDefault: true,
    available: cameraSwitch,
    unverifiedFor: privacyStatusPower,
    invert: true,
    invertFor: (ctx) => (isT8410HomeBase3(ctx) ? false : undefined),
    readAvailable: readsPower(CAMERA_CMD.CAMERA_ENABLE, true),
    readAliases: [
      { paramType: 2001, invert: false, available: readsPower(2001, true) },
      { paramType: CAMERA_CMD.PRIVACY_MODE, invert: true, available: readsPower(CAMERA_CMD.PRIVACY_MODE, false) },
      { paramType: 99904, invert: true, available: readsPower(99904, false) },
      { paramType: 1131, invert: false, available: readsPower(1131, false) },
    ],
    readReflectsWrite: (ctx) => !hasUnreflectedPower(ctx),
    description:
      "Camera enabled. Family-dependent wire param: 1035 CMD_DEVS_SWITCH (enable bit on T8410/HomeBase 3, " +
      "disable bit on battery/solo cams), 2001 OPEN_DEVICE (standalone indoor/outdoor) or 6250 privacy, as the " +
      "product's bundle reads it; the description's default until reported. Reported on/off state; " +
      "unreflectedMembers identifies commands whose effect this report does not reliably reflect.",
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
    available: cameraThing("rotate_image_180_on_off"),
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
    available: offers("watermark_set", WATERMARK_WIRE),
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
    available: cameraThing("sound_detection_status"),
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
    available: cameraThing("sound_detection_sensitivity"),
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
    available: cameraThing("sound_detection_type"),
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
    thing: ["notification_type"],
    provenance: "apk",
    available: offers("notification_type", NOTIFICATION_WIRE),
    description:
      "How much a detection push carries: text only, a thumbnail, or text then a thumbnail. Standalone " +
      "on CMD_INDOOR_PUSH_NOTIFY_TYPE 6020 in the 1700 wrapper, read back on the cloud param; " +
      "HomeBase-attached on SET_PUSH_EFFECT 1289 " +
      "{notification_style}, from the product's bundle. A value outside the enum is REJECTED, not " +
      "clamped: every neighbouring value is a real style, so a bad one would silently select the wrong notification.",
    write: (v, ctx) => {
      const style = coerceEnumValue(NotificationStyle, v);
      if (style == null) return undefined;
      return NOTIFICATION_WIRE(ctx) === CAMERA_CMD.PUSH_EFFECT
        ? setPayload(CAMERA_CMD.PUSH_EFFECT, { notification_style: style }, ctx)
        : setJson(CAMERA_CMD.PUSH_NOTIFY_TYPE, { value: style, transaction: String(Date.now()) }, ctx);
    },
  },
  /** Modes come from the thing description (`thing`); unlisted values read as `undefined`. */
  nightVision: {
    param: CAMERA_CMD.NIGHT_VISION_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: { 0: "Off", 1: "Infrared", 2: "Full Color", 3: "Infrared On" },
    thing: ["nightvision_type_new", "nightvision_type"],
    provenance: "verified",
    available: cameraThing("nightvision_type_new", "nightvision_type"),
    readAvailable: (ctx) => !readsNightVisionOn2002(ctx),
    readAliases: [{ paramType: 2002, available: readsNightVisionOn2002 }],
    coerce: (raw) => (raw === "true" ? 1 : raw === "false" ? 0 : Number(raw)),
    description:
      "Night-vision mode: 0 = off, 1 = infrared by light level, 2 = full colour, 3 = infrared held on. " +
      "Written on 1277 (1350 SET_PAYLOAD, night_sion), or on 1013 as a bare [channel][value] when the device reports 2002.",
    write: (v, ctx) => {
      const nv = coerceEnumValue(NightVision, v);
      if (nv == null) return undefined;
      if (readsNightVisionOn2002(ctx)) return setScalar(CAMERA_CMD.IC_NIGHT_VISION_TYPE, nv, ctx, "int-pair");
      if (nv === NightVision.InfraredOn)
        throw new Error("nightVision: Infrared On has no verified write on this model");
      return setPayload(CAMERA_CMD.NIGHT_VISION_TYPE, { channel: ctx.channel, night_sion: nv }, ctx, 0, 0, "auto");
    },
  },
  /**
   * Live-view quality, the pair to {@link CAMERA_MEMBERS.recordingQuality} and a different setting on a
   * different wire: changing one leaves the other's parameter untouched.
   *
   * The READ is 1020, which reports the resolved tier as a plain integer, while the WRITE rides 2730's
   * `1350` payload. They are two ids for one setting because 2730 carries a per-mode config and 1020
   * carries the tier in force; the tier is what this property means. 1020 is also the name the param
   * dictionary already gives that id, and `Device` keys state by NAME — a member claiming 2730 under
   * this name would collide with it on a device reporting both.
   *
   * `transaction` is part of the frame that was captured, so it is sent. The recording sibling's own
   * confirmed frame carries no such field; neither is inferred from the other. The options and their
   * labels are the ones the description lists.
   */
  streamingQuality: {
    param: 1020,
    type: "number",
    kind: "enum",
    enumValues: STREAMING_QUALITY_TIERS,
    thing: ["live_streaming_resolution"],
    provenance: "apk",
    available: offers("live_streaming_resolution", STREAMING_WIRE),
    unverifiedFor: (ctx) => STREAMING_WIRE(ctx) === CAMERA_CMD.STREAMING_QUALITY,
    args: [{ name: "quality", kind: "enum", description: "A tier, or the name it maps to. 0 is Auto." }],
    ...accepts<StreamingQualityName>(),
    description:
      "Live-view quality as a tier, 0 = Auto (1020; the write rides 2730 " +
      "APP_CMD_MULTI_CAM_SET_VIDEO_QUALITY, or 1020 itself where the product's bundle sends it). Distinct from recordingQuality, which is what gets stored. " +
      "All four tiers wire-verified live on a T8170 and read back on 1020. Sent from this SDK to a " +
      "standalone T8170 and T8171, tier 1 holds the live stream at 1280x720 and tier 0 restores the " +
      "camera's own resolution ladder — see CAMERA_CMD.STREAMING_QUALITY_SET. A value outside the tier set is REJECTED, not " +
      "clamped: every tier in range is a real quality, so a bad one would silently pick another.",
    write: (v, ctx) => {
      const q = optionOf(v, STREAMING_QUALITY_TIERS);
      if (q == null) return undefined;
      return STREAMING_WIRE(ctx) === CAMERA_CMD.STREAMING_QUALITY
        ? setJson(CAMERA_CMD.STREAMING_QUALITY, { quality: q }, ctx)
        : setPayload(
            CAMERA_CMD.STREAMING_QUALITY_SET,
            { channel: 0, mode: 0, primary_view: 0, quality: q, transaction: String(Date.now()) },
            ctx,
            0,
            undefined,
            "auto",
          );
    },
  },
  /**
   * `type` is how the value is STORED, and 2731 stores the whole config — the ACTIVE tier is lifted out
   * of it by `decode`, so the getter answers a tier while the schema stays honest. The setter
   * takes a resolution NAME as well as the tier the getter answers.
   */
  recordingQuality: {
    param: CAMERA_CMD.RECORDING_QUALITY_SET,
    type: "string",
    provenance: "apk",
    available: offers("record_resolution", RECORDING_WIRE),
    unverifiedFor: (ctx) => RECORDING_WIRE(ctx) !== CAMERA_CMD.RECORDING_QUALITY_SET,
    decode: (raw, _codec, ctx) => decodeRecordingQualityTier(raw, recordingOptions(ctx) ?? RECORDING_QUALITY_TIERS),
    decodedKind: "enum",
    decodedValues: Object.keys(RECORDING_QUALITY_TIERS).map(Number),
    enumValues: RECORDING_QUALITY_TIERS,
    enumValuesFor: recordingOptions,
    description:
      "RECORDING quality as a tier (2731) — distinct from streamingQuality, which is the live view. " +
      "The device reports the whole config — " +
      "`{cur_mode, mode_<n>:{quality}}`, read live off a T8170 — and the ACTIVE mode's tier is lifted out " +
      "of it on read. ✅ write wire verified live (T8425): 1350 SET_PAYLOAD " +
      "{channel, mode:0, primary_view:0, quality:N}. Tier→label in RECORDING_QUALITY_TIERS / resolveRecordingQuality, " +
      "or as the product's description lists them. Where the product's bundle sends them instead: 1023 {quality} in the 1700 " +
      "wrapper, or 1286 {record_quality} in the 1350 envelope.",
    args: [{ name: "quality", kind: "enum", description: "A tier; the resolution name it maps to is accepted too." }],
    ...accepts<RecordingQualityName>(),
    write: (v, ctx) => {
      const q = optionOf(v, recordingOptions(ctx) ?? RECORDING_QUALITY_TIERS);
      if (q == null) return undefined;
      const wire = RECORDING_WIRE(ctx);
      if (wire === CAMERA_CMD.VIDEO_RECORD_QUALITY) return setJson(wire, { quality: q }, ctx);
      if (wire === CAMERA_CMD.SET_RECORD_QUALITY) return setPayload(wire, { record_quality: q }, ctx);
      return setPayload(
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
    available: (ctx: AvailabilityContext) =>
      offers("anti_theft_detection_switch", ANTI_THEFT_WIRE)(ctx) &&
      (ANTI_THEFT_WIRE(ctx) === CAMERA_CMD.NEW_EAS_SWITCH || hasReportedEasSwitch(ctx)),
    unverifiedFor: (ctx) => ANTI_THEFT_WIRE(ctx) === CAMERA_CMD.NEW_EAS_SWITCH,
    description:
      "Anti-theft detection on/off (1015 APP_CMD_EAS_SWITCH; the app parses it as " +
      "anti_theft_detection_switch). Adaptive scalar {value:0|1}, or 2735 APP_CMD_NEW_EAS_SWITCH {value} " +
      "in the 1350 envelope where the product's bundle sends it.",
    write: (v, ctx) =>
      ANTI_THEFT_WIRE(ctx) === CAMERA_CMD.NEW_EAS_SWITCH
        ? setPayload(CAMERA_CMD.NEW_EAS_SWITCH, { value: asBool(v) ? 1 : 0 }, ctx)
        : setScalar(CAMERA_CMD.EAS_SWITCH, asBool(v) ? 1 : 0, ctx, "auto"),
  },

  /**
   * Privacy mode — the product's `camera_on_off` privacy wire, written with the inverse of power, so it
   * exists only where the bundle sends one. Nothing reports it back, so it is a setter with no getter.
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
    available: (ctx: AvailabilityContext) => cameraSwitch(ctx) && POWER_WIRE(ctx) !== CAMERA_CMD.CAMERA_ENABLE,
    unverifiedFor: privacyStatusPower,
    description:
      "Privacy mode: camera power written inverted, on the product's privacy wire (6250, or 6090 standalone).",
    write: (v, ctx) => powerCommand(!asBool(v), ctx),
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
    provenance: "apk",
    available: offers("led_on_off", LED_WIRE),
    unverifiedFor: (ctx) => LED_WIRE(ctx) === CAMERA_CMD.DOORBELL_LED_NIGHT,
    readAvailable: (ctx) => !doorbellLed(ctx),
    readAliases: [{ paramType: CAMERA_CMD.DOORBELL_LED, available: doorbellLed }],
    requiresRead: true,
    description: "Camera status LED. Video doorbells report the same state under their button-ring LED parameter.",
    write: (v, ctx) => statusLedCommand(asBool(v), ctx),
  },

  views: provided(
    "media",
    (m) => m.views && (() => m.views!),
    "Optical view identifiers supported by this camera's media route.",
  ),

  outputResolutions: provided(
    "media",
    (m) => m.outputResolutions && (() => m.outputResolutions!),
    "Output sizes supported by this camera's live media route; omission preserves its default output.",
  ),

  /**
   * Media is not a property: it returns DATA rather than moving state, its options are richer than a
   * value, and it exists only on a device bound to a provider. Each is declared once, with its
   * signature taken FROM {@link MediaProvider} — so a change there is a compile error here, not a drift.
   *
   * Every pull is refused where a reliable {@link CAMERA_MEMBERS.enabled} reads false, with {@link CameraDisabledError} —
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
    (m, { ctx }) => isCameraCodec(ctx) && m.snapshotStored && (() => m.snapshotStored!()),
    "Latest validated push thumbnail retained in memory.",
    ["snapshot"],
  ),
  snapshotLive: provided(
    "media",
    (m, { ctx, read }) =>
      isCameraCodec(ctx) &&
      (async (opts?: Parameters<MediaProvider["snapshotLive"]>[0]) => {
        refuseWhenDisabled(ctx, read);
        refuseUnsupportedSelection(m, opts);
        return m.snapshotLive({ powered: poweredOf(ctx), ...opts });
      }),
    "Fresh still decoded from a short live burst.",
  ),
  live: provided(
    "media",
    (m, { ctx, read }) =>
      async (opts?: Parameters<MediaProvider["live"]>[0]) => {
        refuseWhenDisabled(ctx, read);
        refuseUnsupportedSelection(m, opts);
        return m.live({ powered: poweredOf(ctx), ...opts });
      },
    "Open a managed live stream.",
  ),
  record: provided(
    "media",
    (m, { ctx, read }) =>
      isCameraCodec(ctx) &&
      (async (...args: Parameters<MediaProvider["record"]>) => {
        refuseWhenDisabled(ctx, read);
        return m.record(...args);
      }),
    "Record N seconds → an mp4/h264 buffer.",
  ),
  /** The T8530 serves its live feed as a Readable too. */
  openReadable: provided(
    "media",
    (m, { ctx, read }) =>
      (isCameraCodec(ctx) || isVideoSmartLock(ctx)) &&
      m.openReadable &&
      (async (opts?: Parameters<NonNullable<MediaProvider["openReadable"]>>[0]) => {
        refuseWhenDisabled(ctx, read);
        refuseUnsupportedSelection(m, opts);
        return m.openReadable!({ powered: poweredOf(ctx), ...opts });
      }),
    "Open a node:stream Readable of the live feed.",
  ),
  recordFragments: provided(
    "media",
    (m, { ctx, read }) =>
      isCameraCodec(ctx) &&
      m.recordFragments &&
      ((opts?: Parameters<NonNullable<MediaProvider["recordFragments"]>>[0]) => {
        refuseWhenDisabled(ctx, read);
        return m.recordFragments!({ powered: poweredOf(ctx), ...opts });
      }),
    "Continuous fragmented-MP4 (CMAF) recording.",
  ),
  /** A T8530 is offered the download behind a HomeBase 3 alone. */
  downloadRecording: provided(
    "media",
    (m, { ctx }) =>
      (isCameraCodec(ctx) || (isVideoSmartLock(ctx) && ctx.stationSerial?.startsWith("T8030") === true)) &&
      m.downloadRecording &&
      ((opts: Parameters<NonNullable<MediaProvider["downloadRecording"]>>[0]) => m.downloadRecording!(opts)),
    "Download a recording the station holds → H.264 or H.265 and AAC elementary streams.",
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
    (m, { ctx }) =>
      isCameraCodec(ctx) &&
      m.talkback &&
      ctx.paramIds.has(AUDIO_CMD.AUDIO_SPEAKER) &&
      ((opts?: Parameters<NonNullable<MediaProvider["talkback"]>>[0]) =>
        m.talkback!({ powered: poweredOf(ctx), ...opts })),
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
  /** The sound (3105) and crying (3104) pushes, each claimed on the product's thing property for it. */
  events: [
    {
      source: "push",
      match: IndoorPushEvent.SOUND_DETECTION,
      emit: "soundDetected",
      claim: { things: ["sound_detection_status", "sound_detection_type"] },
    },
    {
      source: "push",
      match: IndoorPushEvent.CRYING_DETECTION,
      emit: "cryingDetected",
      claim: { things: ["notification_ai_crying_switch", "sound_detection_type"] },
    },
  ],
  /** Only the no-argument power verbs, which carry no value for a member to hold. */
  actions({ ctx, sink }: MemberDeps): CapabilityActions {
    if (!cameraSwitch(ctx) || privacyStatusPower(ctx)) return {};
    return {
      on: () => sink.dispatch(powerCommand(true, ctx)),
      off: () => sink.dispatch(powerCommand(false, ctx)),
    };
  },
};
