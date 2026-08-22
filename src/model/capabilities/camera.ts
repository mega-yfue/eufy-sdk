import { asBool, coerceEnumValue } from "../../core/util.js";
import { DeviceType } from "../device-types.js";
import { isIndoorCamera, isIndoorCamMini, isIndoorPanTiltS350, isOutdoorPanTilt } from "../device-family.js";
import { setScalar, setPayload, hasCapability } from "./access.js";
import { AUDIO_CMD } from "./audio.js";
import { accepts, propertiesOf, provided, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CapabilityActions, CommandContext } from "./types.js";
import type { Command, CommandSink, MediaProvider } from "../../core/contracts.js";

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
   * Video / streaming quality (resolution). ✅ Wire confirmed on T8425 ch3:
   * `1350` SET_PAYLOAD, inner cmd 2731, `payload:{channel:0, mode:0, primary_view:0, quality:N}`,
   * mValue3:0, on the device channel. quality enum 1/2/3 (low/mid/high, exact labels TBC).
   */
  VIDEO_QUALITY_SET: 2731,
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
 * Video record-quality resolution names. The underlying value is a quality TIER (1/2/3) that maps to a
 * resolution label ({@link VIDEO_QUALITY_TIERS}). Only tiers verified on a real device are listed;
 * grow this as models are confirmed. (The label is potentially model-specific — a 2K cam's tier 3 would
 * be "2K HD", not "3K HD" — but every cam verified so far shares the same tiers, so there is no per-model
 * map yet: add one, keyed by model in the resolvers below, the first time a model actually diverges.)
 */
export const VideoQuality = {
  HD720: "HD (720P)",
  FullHD1080: "Full HD (1080P)",
  HD3K: "3K HD",
} as const;
/** A video-quality resolution name — the value side of {@link VideoQuality}. */
export type VideoQualityName = (typeof VideoQuality)[keyof typeof VideoQuality];

/** Quality tier → resolution label. Tiers confirmed on a real device: 1=720P, 2=1080P, 3=3K HD. */
export const VIDEO_QUALITY_TIERS: Readonly<Record<number, string>> = {
  1: "HD (720P)",
  2: "Full HD (1080P)",
  3: "3K HD",
};

/** Resolve a raw `quality` tier value to its resolution label — or `undefined`. */
export function resolveVideoQuality(value: number): string | undefined {
  return VIDEO_QUALITY_TIERS[value];
}

/** Inverse: the raw `quality` tier value for a resolution NAME — or `undefined` if not a known tier. */
export function resolveVideoQualityValue(name: string): number | undefined {
  const hit = Object.entries(VIDEO_QUALITY_TIERS).find(
    ([, label]) => label.toLowerCase() === name.trim().toLowerCase(),
  );
  return hit ? Number(hit[0]) : undefined;
}

/**
 * Resolve a `setVideoQuality` argument — a resolution NAME ({@link VideoQuality}) OR a raw tier — to a
 * valid tier value, else `undefined`. Unlike a bare `Number()`, this rejects a value that isn't a real
 * tier (0, negative, out of range): the write is fire-and-forget, so an out-of-range quality value
 * would look like it worked while doing nothing. A numeric string ("2") is a raw tier; a non-numeric
 * string is looked up as a resolution name; a boolean is not a tier.
 */
export function resolveVideoQualityTier(value: number | string | boolean): number | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return resolveVideoQualityValue(value);
  const tier = Number(value);
  return Number.isInteger(tier) && VIDEO_QUALITY_TIERS[tier] != null ? tier : undefined;
}

/**
 * Lift the ACTIVE tier out of the quality config the device reports.
 *
 * 2731 is not a scalar: a T8170 reports `{cur_mode:0, mode_0:{quality:3}, mode_1:{quality:3}}` — one
 * entry per capture mode, with `cur_mode` selecting which is live. Read as a bare number it coerced to
 * a non-numeric string and the getter answered the whole object, typed as though it were a tier.
 *
 * A device that reports a plain tier is still read (some models may); anything else — an unknown shape,
 * a mode with no entry, a tier not in {@link VIDEO_QUALITY_TIERS} — is `undefined` rather than a guess.
 */
function decodeVideoQualityTier(raw: unknown): number | undefined {
  if (typeof raw === "number" || typeof raw === "string") return resolveVideoQualityTier(raw);
  if (typeof raw !== "object" || raw === null) return undefined;
  const cfg = raw as Record<string, unknown>;
  const mode = cfg[`mode_${Number(cfg.cur_mode) || 0}`];
  const quality = typeof mode === "object" && mode !== null ? (mode as Record<string, unknown>).quality : undefined;
  return typeof quality === "number" ? resolveVideoQualityTier(quality) : undefined;
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
 * NOTE: this is polarity only (which value = ON). The WIRE LEVEL (L1 vs L2) is NOT decided here nor
 * by family — it is a runtime *topology* trait resolved at send time (standalone ⇒ L1, HomeBase ⇒
 * L2). A device can be either, so power is emitted `"auto"` and the transport picks.
 *
 * Indoor cams flip — but NOT the mini or the S350 family, which use the separate 6250 envelope and so
 * never reach this 1035 polarity decision at all (see {@link usesSeparatePowerEnvelope}).
 *
 * TODO(verify): polarity per family must be confirmed against the V6 app itself or a confirmed
 * TCP capture (NOT a pre-v6 third-party catalogue). Current split is provisional until a live capture confirms it.
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

/**
 * True for the camera families whose power on/off does NOT ride `CMD_DEVS_SWITCH` (1035) at all —
 * indoor-cam mini, the S350 indoor pan/tilt family, and outdoor pan/tilt. In the V6 app these ride
 * the privacy (`COMMAND_APP_PRIVACY` 6250) envelope instead, INVERTED (privacy-on = camera-off), so
 * `powerCommand` maps their power to the privacy burst rather than a 1035 frame the firmware drops.
 * Grounded in the decompiled V6 parsers (`CameraOnOffParser`, `extracted_js/`): the HomeBase branch
 * of camera on/off is `COMMAND_APP_PRIVACY` inverted.
 *
 * NOTE: the privacy burst is a level-2 (HomeBase) wire; a STANDALONE device in one of these families
 * never negotiates a level-2 key, so power there throws (no L2 key) — honest, since the V6 standalone
 * wire for these families is not yet captured. Battery/solo + the 1035 families are unaffected.
 */
function usesSeparatePowerEnvelope(ctx: CommandContext): boolean {
  return isIndoorCamMini(ctx) || isIndoorPanTiltS350(ctx) || isOutdoorPanTilt(ctx);
}

/** Raw 1035 value for a desired power state, honouring the family polarity. */
function powerValue(on: boolean, ctx: CommandContext): number {
  return isEnableBitPolarity(ctx) ? (on ? 1 : 0) : on ? 0 : 1;
}

/**
 * Camera power on/off. Two wires, family-selected — mirroring the V6 app's `CameraOnOffParser`:
 *  - **1035 `CMD_DEVS_SWITCH`** (battery/solo, indoor-non-mini, floodlight 8422/24). The capability
 *    supplies param + polarity-resolved value; `"auto"` lets the transport pick the encryption level
 *    by session — standalone cams (e.g. T8410) get level-1 int-string (no level-2 key), HomeBase cams
 *    get level-2 direct-binary. Live-verified: T8410 standalone = L1, T8114 HomeBase = L2.
 *  - **6250 privacy envelope, INVERTED** (mini / S350 / outdoor-PT — see {@link usesSeparatePowerEnvelope}).
 *    Power-on = privacy-off. Reuses the live-verified {@link privacyCommand} burst (T8419). Level-2
 *    only, so a standalone device in these families throws downstream (no L2 key) — the honest state
 *    until their standalone wire is captured.
 */
function powerCommand(on: boolean, ctx: CommandContext): Command {
  if (usesSeparatePowerEnvelope(ctx)) return privacyCommand(!on, ctx.channel);
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
 */
function statusLedCommand(on: boolean, ctx: CommandContext): Command {
  if (hasCapability(ctx, "doorbell")) return setPayload(CAMERA_CMD.DOORBELL_LED, { light_enable: on ? 1 : 0 }, ctx);
  return setScalar(CAMERA_CMD.DEV_LED_SWITCH, on ? 1 : 0, ctx, "int-string");
}

/**
 * How this camera is powered, as every media egress needs to be told: a battery device is streamed
 * under a budget, a wired one unbounded. A runtime fact off the resolved capabilities, never a model
 * trait — and given to EVERY egress, since any of them may be the call that creates the shared source.
 */
function poweredOf(ctx: CommandContext): "wired" | "battery" {
  return ctx.capabilities?.has("battery") ? "battery" : "wired";
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
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const CAMERA_MEMBERS = {
  /**
   * The READ is the *disable*-bit convention (1035 "0" ⇒ ON, 2001 direct); the WRITE polarity is
   * family-dependent — see `powerValue` / `isEnableBitPolarity`. Battery/solo cams report
   * the state under 1035, standalone indoor/outdoor cams (T8400/T8410/T8442) under 2001 OPEN_DEVICE
   * with direct polarity, so 2001 is a read-alias. Both verified live (T8114 1035=0 → ON; T8410
   * 2001=false → OFF). The S350/outdoor-PT privacy form (6250) is a separate wire and is not aliased
   * here until its polarity is captured.
   *
   * On the families {@link usesSeparatePowerEnvelope} covers, the WRITE goes to the privacy envelope while
   * this read still observes 1035/2001 — so `setEnabled(false)` succeeds without moving this value, and the
   * value reads as ON for a camera that is off. `readReflectsWrite` declares that, which puts those devices
   * in `unreflectedMembers(dev.camera())` so a caller can decline to act on the value instead of acting on a
   * wrong one.
   *
   * Aliasing 6250 here would fix it properly, and it IS reported on those families (T8170 and T8171 each
   * returned 6250="0" alongside 1035="0" while streaming). That is one polarity seen once; the privacy-on
   * reading is not captured, so the mapping stays unverified rather than guessed.
   */
  enabled: {
    param: CAMERA_CMD.CAMERA_ENABLE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    invert: true,
    readAliases: [{ paramType: 2001, invert: false }],
    readReflectsWrite: (ctx) => !usesSeparatePowerEnvelope(ctx),
    description:
      "Camera enabled. Family-dependent wire param: 1035 CMD_DEVS_SWITCH (disable bit, battery/" +
      "solo cams) or 2001 OPEN_DEVICE (standalone indoor/outdoor). Reliable on/off status source " +
      "(a live-stream probe is not).",
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
   * logo, so a caller offering a plain switch loses a state the device has. `coerceEnumValue` refuses
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
   * Three modes, and `FullColor` is the one to check for: a model without a spotlight or starlight
   * sensor omits it, and the wire accepts the value regardless — so offer the option from the device's
   * own reported set rather than assuming all three. `coerceEnumValue` rejects a value outside
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
        : setPayload(CAMERA_CMD.NIGHT_VISION_TYPE, { channel: ctx.channel, night_sion: nv }, ctx, 0, 0);
    },
  },
  /**
   * `type` is how the value is STORED, and 2731 stores the whole config — the tier a caller wants is
   * lifted out of it by `decode`, so the getter answers a tier while the schema stays honest. The setter
   * takes a resolution NAME as well as the tier the getter answers.
   */
  videoQuality: {
    param: CAMERA_CMD.VIDEO_QUALITY_SET,
    type: "string",
    provenance: "verified",
    decode: (raw) => decodeVideoQualityTier(raw),
    decodedKind: "enum",
    decodedValues: Object.keys(VIDEO_QUALITY_TIERS).map(Number),
    description:
      "Video record quality (2731) as a resolution tier. The device reports the whole config — " +
      "`{cur_mode, mode_<n>:{quality}}`, read live off a T8170 — and the ACTIVE mode's tier is lifted out " +
      "of it on read. ✅ write wire verified live (T8425): 1350 SET_PAYLOAD " +
      "{channel:0, mode:0, primary_view:0, quality:N}. Tier→label in VIDEO_QUALITY_TIERS / resolveVideoQuality " +
      "(verified on T8425; add a per-model map if a model's tiers ever diverge).",
    args: [{ name: "quality", kind: "enum", description: "A tier; the resolution name it maps to is accepted too." }],
    ...accepts<VideoQualityName>(),
    write: (v, ctx) => {
      const q = resolveVideoQualityTier(v);
      return q == null
        ? undefined
        : setPayload(CAMERA_CMD.VIDEO_QUALITY_SET, { channel: 0, mode: 0, primary_view: 0, quality: q }, ctx, 0);
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
   * Being write-only, it is named by `unobservableMembers(dev.camera())`, so a caller can tell "this camera
   * is not in privacy mode" from "this camera cannot say" rather than reading both as `undefined`. That
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
   */
  snapshotStored: provided(
    "media",
    (m) => m.snapshotStored && (() => m.snapshotStored!()),
    "Latest validated push thumbnail retained in memory.",
    ["snapshot"],
  ),
  snapshotLive: provided(
    "media",
    (m, { ctx }) =>
      (opts?: Parameters<MediaProvider["snapshotLive"]>[0]) =>
        m.snapshotLive({ powered: poweredOf(ctx), ...opts }),
    "Fresh still decoded from a short live burst.",
  ),
  live: provided(
    "media",
    (m, { ctx }) =>
      (opts?: Parameters<MediaProvider["live"]>[0]) =>
        m.live({ powered: poweredOf(ctx), ...opts }),
    "Open a managed live stream.",
  ),
  record: provided("media", (m) => m.record, "Record N seconds → an mp4/h264 buffer."),
  openReadable: provided(
    "media",
    (m, { ctx }) =>
      m.openReadable &&
      ((opts?: Parameters<NonNullable<MediaProvider["openReadable"]>>[0]) =>
        m.openReadable!({ powered: poweredOf(ctx), ...opts })),
    "Open a node:stream Readable of the live feed.",
  ),
  recordFragments: provided(
    "media",
    (m, { ctx }) =>
      m.recordFragments &&
      ((opts?: Parameters<NonNullable<MediaProvider["recordFragments"]>>[0]) =>
        m.recordFragments!({ powered: poweredOf(ctx), ...opts })),
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
    (m, { ctx }) =>
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
  /** Only the no-argument power verbs, which carry no value for a member to hold. */
  actions(ctx: CommandContext, sink: CommandSink): CapabilityActions {
    return {
      on: () => sink.dispatch(powerCommand(true, ctx)),
      off: () => sink.dispatch(powerCommand(false, ctx)),
    };
  },
};
