import { asBool, coerceEnumValue } from "../../core/util.js";
import { IndoorPushEvent } from "../push-events.js";
import { isVideoSmartLock } from "../device-family.js";
import { setScalar, setJson, isCameraCodec } from "./access.js";
import { described } from "./thing-description.js";
import { bundled, bundleEntry, thingReadback } from "./bundle.js";
import { AUDIO_CMD } from "./audio.js";
import { cameraPowerTier } from "./battery.js";
import { propertiesOf, provided, type Members, type Surface, type MemberDeps } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CapabilityActions, CommandContext } from "./types.js";
import { CameraDisabledError, type MediaProvider, type MediaSourceSelection } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this camera capability drives (direct-binary switches + `1350`
 * SET_PAYLOAD sub-commands). These are the capability's own wire vocabulary — the transport carries
 * `cmd.param` opaquely and never names them (the full 541-entry id→name catalog lives in the generated
 * `transport/p2p/commands.ts`). Each entry notes its app `CommandType` name.
 */
export const CAMERA_CMD = {
  /** Camera-reported Wi-Fi signal (app `CMD_GET_WIFI_RSSI`). */
  WIFI_RSSI: 1142,
  /** Camera on/off (app `CMD_DEVS_SWITCH`). */
  CAMERA_ENABLE: 1035,
  /** Camera power as privacy mode in the `1350` envelope, `{switch}` 1 = privacy on (app `COMMAND_APP_PRIVACY`). */
  PRIVACY_MODE: 6250,
  /** Standalone power as privacy mode in the `1700` wrapper, `{value}` 1 = privacy on (app `COMMAND_INDOOR_PRIVACY_MODE_STATUS`). */
  PRIVACY_MODE_STATUS: 6090,
  /** Standalone status LED in the `1700` wrapper, `{value:0|1}` (app `IC_LED_STATUS`). */
  IC_LED_STATUS: 6014,
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
  /** Camera status LED (app `CMD_DEV_LED_SWITCH`). */
  DEV_LED_SWITCH: 1045,
  /**
   * Rotate the image 180° on/off. Direct param, value 0 = normal, 1 = flipped. The app's constant is
   * `INDOOR_ROTATE_IMAGE`, but it is NOT indoor-only — outdoor cameras take it too, so the misleading
   * "indoor" is dropped. App parser: `{cmd:1207, params:{enable:0|1}}`.
   */
  ROTATE_IMAGE: 1207,
  /**
   * On-screen watermark / OSD overlay (app `CMD_SET_DEVS_OSD`):
   * a **3-value enum**, not a bool — 0 = off, 1 = timestamp, 2 = timestamp + logo. Direct-binary
   * `[channel][value]`. (Labels/enum in {@link Watermark}.)
   */
  SET_DEVS_OSD: 1214,
  /** Video-doorbell status LED in the `1350` envelope, `{light_enable}` (app `CMD_BAT_DOORBELL_SET_LED_ENABLE`). */
  DOORBELL_LED: 1716,
  /** Night-vision mode in the `1350` envelope, `{night_sion, channel}` (app `NIGHT_VISION_TYPE`). */
  NIGHT_VISION_TYPE: 1277,
  /** Night-vision mode as a bare `[channel][value]` pair (app `IC_NIGHT_VISION_TYPE`). */
  IC_NIGHT_VISION_TYPE: 1013,
  /** Push-notification style in the `1700` wrapper, `{value}` (app `CMD_INDOOR_PUSH_NOTIFY_TYPE`). */
  PUSH_NOTIFY_TYPE: 6020,
  /**
   * **Sound detection** switch — whether the camera triggers on what it hears, beside the motion
   * trigger it triggers on what it sees.
   *
   * Wire: the `1700` CONTROL_PAYLOAD wrapper, plaintext `{"commandType":6043,"data":{"status":0|1}}`,
   * reported back on the cloud param.
   */
  SOUND_DETECTION: 6043,
  /**
   * How loud a sound has to be to trigger {@link CAMERA_CMD.SOUND_DETECTION} — the app's three-position
   * control writes `1` lowest, `3` mid, `5` highest.
   *
   * Wire: `{"commandType":6044,"data":{"index":N}}` in the `1700`
   * wrapper. The payload field is `index`, NOT the `value` its neighbours use — each of these
   * commands names its field differently, so there is no generic setter for the family.
   */
  SOUND_DETECTION_SENSITIVITY: 6044,
  /**
   * WHICH sounds trigger {@link CAMERA_CMD.SOUND_DETECTION} — all sound, or crying alone.
   *
   * Wire: `{"commandType":6046,"data":{"type":N}}` in the `1700` wrapper, reported back on the cloud
   * param. (Values in {@link SoundDetectionType}.)
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
   * Wire: `1350` SET_PAYLOAD, inner cmd 2731,
   * `payload:{channel:0, mode:0, primary_view:0, quality:N}`, mValue3 0, on the device channel. Tiers
   * 1/2/3, named in {@link RECORDING_QUALITY_TIERS} — no tier 0 on this wire, where streaming has one.
   * That is a fact about 2731, not about recording everywhere. A
   * doorbell has no recording-quality setting at all, and its live-view quality rides neither 2730 nor
   * 2731 but 1705, on a domain of its own (5 = Auto, 6/7/8 = Low/Medium/High).
   */
  RECORDING_QUALITY_SET: 2731,
  /**
   * LIVE-VIEW quality — a separate setting from {@link CAMERA_CMD.RECORDING_QUALITY_SET}, and the app's
   * names for the two invert what they suggest: 2730 is `multicamSetVideoQuailty` and drives the
   * Streaming Quality picker, while 2731 is `multicamSetRecordQuailty` and drives Recording Quality.
   * Changing one leaves the other's parameter untouched.
   *
   * Unlike recording it offers a tier 0, `Auto`. Wire: the `1350`
   * SET_PAYLOAD envelope, signCode 8, plaintext `{"cmd":2730,"payload":{"transaction":"<epoch ms>",
   * "quality":N,"channel":0,"mode":0,"primary_view":0},"account_id":…}`, reported back on parameter
   * 1020; the station echoes the same payload back as a `1351`
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

// Wire: CMD_INDOOR_DET_SET_SOUND_DETECT_TYPE 6046, reported back on the cloud param.
export const SoundDetectionType = {
  /** Crying alone triggers a detection. */
  Crying: 1,
  /** Any sound loud enough for the sensitivity triggers a detection. */
  AllSound: 2,
} as const;
/** A sound-detection type — the value side of {@link SoundDetectionType}. */
export type SoundDetectionTypeValue = (typeof SoundDetectionType)[keyof typeof SoundDetectionType];

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

/** `camera_on_off` as each product's settings bundle writes and reads it. */
const POWER = bundled(["camera_on_off"], CAMERA_CMD.CAMERA_ENABLE);

/** Power, privacy and the on/off verbs. */
const cameraPower = (ctx: AvailabilityContext): boolean => isCameraCodec(ctx) && POWER.available(ctx);

/** Where the product's bundle powers the camera through privacy mode rather than 1035. */
const privacyPower = (ctx: AvailabilityContext): boolean =>
  Object.values(bundleEntry("camera_on_off", ctx)?.write ?? {}).some(
    (f) => (f.subCmd ?? f.cmd) !== CAMERA_CMD.CAMERA_ENABLE,
  );

/** `led_on_off` as each product's settings bundle writes and reads it. */
const LED = bundled(["led_on_off"], CAMERA_CMD.DEV_LED_SWITCH);

/** `notification_type` as each product's settings bundle writes and reads it. */
const NOTIFICATION = bundled(["notification_type"], CAMERA_CMD.PUSH_NOTIFY_TYPE, true);

/** `nightvision_type_new`, else `nightvision_type`, as each product's settings bundle writes and reads it. */
const NIGHT_VISION = bundled(["nightvision_type_new", "nightvision_type"], CAMERA_CMD.NIGHT_VISION_TYPE, true);

/**
 * A camera-codec device whose product description, when fetched, lists one of `identifiers`: a video
 * lock is camera codec too, and its description leaves out the settings it does not have.
 */
const cameraThing =
  (...identifiers: string[]) =>
  (ctx: AvailabilityContext): boolean =>
    isCameraCodec(ctx) && identifiers.some((identifier) => described(identifier)(ctx));

/** `live_streaming_resolution`, `record_resolution`, `watermark_set` and `anti_theft_detection_switch` as each product's settings bundle sends them. */
const STREAMING = bundled(["live_streaming_resolution"], 1020, true);
const RECORDING = bundled(["record_resolution"], CAMERA_CMD.RECORDING_QUALITY_SET, true);
const WATERMARK = bundled(["watermark_set"], CAMERA_CMD.SET_DEVS_OSD, true);
const ANTI_THEFT = bundled(["anti_theft_detection_switch"], CAMERA_CMD.EAS_SWITCH);

/**
 * How this camera is powered, as every media egress needs to be told: a battery device is streamed
 * under a budget, a wired one unbounded. Read off the resolved capabilities, except that a
 * mains-only model (see `cameraPowerTier` in battery.ts) is wired even with `battery` resolved. Given
 * to EVERY egress, since any of them may be the call that creates the shared source.
 */
function poweredOf(ctx: CommandContext): "wired" | "battery" {
  return cameraPowerTier(ctx.model, ctx.capabilities ?? new Set());
}

/**
 * The param an enablement write is reflected under on THIS device, and the raw value to expect there: the
 * first param its getter reads that the device reported, valued as the product's bundle reads it.
 * `undefined` where the device reported none.
 */
function enablementReflection(
  on: boolean,
  ctx: CommandContext,
): { param: number; expected: string; observed: boolean } | undefined {
  const m = CAMERA_MEMBERS.enabled;
  const read = [{ paramType: m.param, available: m.readAvailable }, ...m.readAliases].find(
    (r) => ctx.paramIds.has(r.paramType) && r.available(ctx),
  );
  const readback = read && thingReadback("camera_on_off", on ? "1" : "0", ctx, read.paramType);
  return readback && { param: readback.param, expected: readback.raw, observed: on };
}

/**
 * Refuse a media pull where the `enabled` reading is false.
 *
 * `undefined` is permissive: a camera that never reported its state is not a camera known to be off.
 */
function refuseWhenDisabled(ctx: CommandContext, read: (name: string) => { value: unknown } | undefined): void {
  if (read("enabled")?.value === false) throw new CameraDisabledError(ctx.name ?? ctx.serial);
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
 * `EufyMega.reboot(sn)` (the station-scalar RESTART_HUB) rather than guessed at here.
 *
 * Exported but NOT published: each entry states its wire id and its gate,
 * which the reference site does not carry.
 * @internal
 */
export const CAMERA_MEMBERS = {
  /** Reads the latest cached report and exposes no setter. */
  wifiRssi: {
    param: CAMERA_CMD.WIFI_RSSI,
    type: "number",
    kind: "scalar",
    description: "Camera-reported Wi-Fi signal; physical units and a quality scale are unspecified.",
  },
  /** Read where and as the product's bundle reads it; the description's default until reported. */
  enabled: {
    type: "bool",
    kind: "boolean",
    ...POWER,
    thingDefault: true,
    description:
      "Camera enabled, written and read as the product's settings bundle does; the description's default " +
      "until reported.",
    observation: {
      event: "cameraEnabledChanged",
      reflects: (value, ctx) => enablementReflection(asBool(value), ctx),
      timeoutMs: 20_000,
    },
    aliases: { on: true, off: false },
  },
  /**
   * A 180° rotation for a ceiling or upside-down mount, not a mirror — the app's own constant calls it
   * `INDOOR_ROTATE_IMAGE` but it is not indoor-only. The wire is read out of the app
   * parser and the write has not been driven on hardware, so treat a silent no-op as possible and
   * confirm by re-reading rather than by trusting the dispatch.
   */
  imageFlipped: {
    param: CAMERA_CMD.ROTATE_IMAGE,
    type: "bool",
    kind: "boolean",
    available: cameraThing("rotate_image_180_on_off"),
    description:
      "Rotate the image 180° (ROTATE_IMAGE 1207): false = normal, true = flipped. " +
      "For ceiling/upside-down mounts. Write is a direct param; wire from the app parser (unverified live).",
    write: (v, ctx) => setScalar(CAMERA_CMD.ROTATE_IMAGE, asBool(v) ? 1 : 0, ctx, "auto"),
  },
  /** Three values on the products whose bundle writes three (0 off, 1 timestamp, 2 timestamp and logo). */
  watermark: {
    type: "enum",
    kind: "scalar",
    ...WATERMARK,
    description: "On-screen watermark/OSD overlay, as the product's settings bundle writes and reads it.",
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
    available: cameraThing("sound_detection_status"),
    description: "Trigger on sound as well as motion (SOUND_DETECTION 6043, 1700 control-payload {status:0|1}).",
    write: (v, ctx) => setJson(CAMERA_CMD.SOUND_DETECTION, { status: asBool(v) ? 1 : 0 }, ctx),
  },
  /**
   * How loud a sound must be to trigger: `1` lowest, `3` mid, `5` highest, on the app's own
   * three-position control. A `scalar` rather than an enum — the app writes the endpoints and the
   * midpoint, so 2 and 4 are a prediction of the scale's shape rather than values the wire is known to
   * take. Independent of {@link CAMERA_MEMBERS.soundDetection}: the camera stores it whether sound
   * detection is on or off.
   */
  soundDetectionSensitivity: {
    param: CAMERA_CMD.SOUND_DETECTION_SENSITIVITY,
    type: "number",
    kind: "scalar",
    available: cameraThing("sound_detection_sensitivity"),
    description:
      "Sound-detection sensitivity: 1 = lowest, 3 = mid, 5 = highest (SOUND_DETECTION_SENSITIVITY " +
      "6044). 2 and 4 are the scale's shape, not values the app writes.",
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
    available: cameraThing("sound_detection_type"),
    description: "Which sounds trigger a detection: crying alone, or any sound (SOUND_DETECTION_TYPE 6046).",
    write: (v, ctx) => {
      const type = coerceEnumValue(SoundDetectionType, v);
      return type == null ? undefined : setJson(CAMERA_CMD.SOUND_DETECTION_TYPE, { type }, ctx);
    },
  },
  /** Offered with the styles the product's bundle writes. */
  notificationStyle: {
    type: "enum",
    kind: "scalar",
    ...NOTIFICATION,
    description:
      "How much a detection push carries: text only, a thumbnail, or text then a thumbnail, written and " +
      "read as the product's settings bundle does.",
  },
  /** Modes are the ones the product's bundle reads; only those it writes are accepted. */
  nightVision: {
    type: "enum",
    kind: "scalar",
    ...NIGHT_VISION,
    description:
      "Night-vision mode as the app's own value for the product (its description names each), written and " +
      "read as the product's settings bundle does.",
  },
  /**
   * Live-view quality as the app's own value for the product, the pair to
   * {@link CAMERA_MEMBERS.recordingQuality}: read where the product's bundle reads it and written as it
   * sends it.
   */
  streamingQuality: {
    type: "number",
    kind: "scalar",
    ...STREAMING,
    description:
      "Live-view quality as the app's value for the product (its description names each), written and read " +
      "as the product's settings bundle does. Distinct from recordingQuality, which is what gets stored.",
  },
  /** The stored quality as the app's own value, read off the product's config (2731, 1023, 1286). */
  recordingQuality: {
    type: "number",
    kind: "scalar",
    ...RECORDING,
    description:
      "Recording quality as the app's value for the product (its description names each), written and read " +
      "as the product's settings bundle does — distinct from streamingQuality, the live view.",
  },
  /** Written and read as the product's bundle does (1015, or 2735 in the 1350 envelope). */
  antiTheftDetection: {
    type: "bool",
    kind: "boolean",
    ...ANTI_THEFT,
    description: "Anti-theft detection on/off, as the product's settings bundle writes and reads it.",
  },

  /**
   * Privacy mode: camera power written inverted, where the product's bundle powers the camera through it.
   * Nothing reports it back, so it is a setter with no getter, named by `unobservableMembers`.
   */
  privacy: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    available: (ctx: AvailabilityContext) => cameraPower(ctx) && privacyPower(ctx),
    description: "Privacy mode: camera power written inverted, on the product's privacy wire.",
    write: (v, ctx) => POWER.write(!asBool(v), ctx),
  },
  /** Written and read as the product's bundle does. */
  statusLed: {
    type: "bool",
    kind: "boolean",
    ...LED,
    requiresRead: true,
    description: "Camera status LED, written and read as the product's settings bundle does.",
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
    if (!cameraPower(ctx)) return {};
    return {
      on: () => sink.dispatch(POWER.write(true, ctx)!),
      off: () => sink.dispatch(POWER.write(false, ctx)!),
    };
  },
};
