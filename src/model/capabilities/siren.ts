import { DeviceType } from "../device-types.js";
import { coerceEnumValue, enumLabels } from "../../core/util.js";
import { HOMEBASE_TYPES, isHomeBase } from "../device-family.js";
import { hasReportedEasSwitch } from "./camera.js";
import { setPayload, setStationScalar } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The siren's **state-backed param ids** — each is a param the device reports (and some are also
 * writable). Named `SIREN_PARAM` vs `SIREN_CMD` below (momentary triggers with no reported state) so
 * the split the code implements is explicit. Surveyed + write-captured on a real T90R0
 * (`SIREN_SENSOR_E20`, 2026-08-03).
 */
export const SIREN_PARAM = {
  /** Whether the siren is sounding (app `APP_CMD_DEV_RING_STATUS`). 1 = sounding, 0 = silent. */
  RING_STATUS: 61008,
  /** Alarm volume as a device level (app `APP_CMD_SIREN_SENSOR_SET_ALARM_VOL`). See {@link SirenVolume}. */
  ALARM_VOLUME: 1825,
  /** Seconds an alarm sounds before stopping itself (app `APP_CMD_DEV_ALARM_TIMEOUT`). */
  ALARM_TIMEOUT: 61006,
  /** Do-not-disturb (app `APP_CMD_SENSOR_NOT_DISTURB`). */
  NOT_DISTURB: 1828,
} as const;

/**
 * The siren's **write-only command ids**. Momentary actions install only when their family-specific
 * reported evidence and topology gates hold.
 */
export const SIREN_CMD = {
  /** Sound the siren briefly as a test (app `APP_CMD_SIREN_SENSOR_ALARM_TEST`). */
  ALARM_TEST: 1826,
  /** Manually stop a sounding alarm (app `APP_CMD_SIREN_SENSOR_MANUAL_STOP_ALARM`). */
  MANUAL_STOP: 1871,
  /** Station-family HomeBase duration alarm, verified live on T8010 and T8030 (app `SET_TONE_FILE`). */
  HOMEBASE_TONE: 1201,
  /** HomeBase alarm volume percentage (app `CMD_SET_HUB_SPK_VOLUME`). */
  HUB_SPK_VOLUME: 1235,
  /** HomeBase alarm-tone selection (app `APP_CMD_HUB_ALARM_TONE`). */
  HUB_ALARM_TONE: 1281,
  /** Attached-camera duration alarm, verified live on T8114 and T8210 (app `SET_DEVS_TONE_FILE`). */
  CAMERA_TONE: 1202,
} as const;

/** The station broadcast channel used by the station-family HomeBase alarm command. */
const STATION_CHANNEL = 255;

/**
 * Siren alarm volume — a small device level 1-3 (Low/Mid/High), NOT a percentage. Pass a value to
 * `setVolume`.
 */
export const SirenVolume = { Low: 1, Mid: 2, High: 3 } as const;
/** A siren volume level — the value side of {@link SirenVolume}. */
export type SirenVolumeValue = (typeof SirenVolume)[keyof typeof SirenVolume];

/**
 * The alarm-duration presets the app offers, in seconds (1/5/10/15 minutes). These are the only
 * values captured, so `setAlarmDuration` accepts exactly these (rejecting others),
 * the same way the arming capability makes its delay presets the parameter type.
 */
export const SirenAlarmDuration = { Min1: 60, Min5: 300, Min10: 600, Min15: 900 } as const;
/** A siren alarm duration in seconds — the value side of {@link SirenAlarmDuration}. */
export type SirenAlarmDurationValue = (typeof SirenAlarmDuration)[keyof typeof SirenAlarmDuration];

/** HomeBase alarm tone options, 1-indexed; both options were confirmed on a T8030. */
export const HubAlarmTone = { Tone1: 1, Tone2: 2 } as const;
/** A HomeBase alarm tone option. */
export type HubAlarmToneValue = (typeof HubAlarmTone)[keyof typeof HubAlarmTone];

/**
 * Bound siren controls — the object returned by `dev.siren()`.
 *
 * Everything is derived from `SIREN_MEMBERS`. Each optional member is installed only for the exact
 * standalone-siren, HomeBase, or camera evidence that proves its wire contract.
 */
export type SirenActions = Surface<typeof SIREN_MEMBERS>;

/** Reported HomeBase alarm params that prove the alarm-output configuration surface. */
const HUB_ALARM_EVIDENCE = [SIREN_CMD.HUB_ALARM_TONE, 1282] as const;

/** Whether this bound device uses the station-family manual HomeBase alarm wire (verified on T8010 and T8030). */
function isStationAlarmOutput(ctx: CommandContext): boolean {
  return ctx.deviceType === DeviceType.STATION || ctx.deviceType === DeviceType.HB3;
}

/** Whether a station-family HomeBase also reports an alarm-output configuration parameter. */
function isEvidencedStationAlarm(ctx: CommandContext): boolean {
  return isStationAlarmOutput(ctx) && HUB_ALARM_EVIDENCE.some((param) => ctx.paramIds.has(param));
}

/** Whether an attached camera reports the EAS slot verified with its own manual alarm output. */
function isEvidencedAttachedCamera(ctx: CommandContext): boolean {
  return ctx.codec === "camera" && ctx.homeBaseAttached === true && hasReportedEasSwitch(ctx);
}

/** Whether a model-side record or bound context reports a specific parameter. */
function reportsParam(
  source: { params?: Record<number, string>; paramIds?: ReadonlySet<number> },
  param: number,
): boolean {
  return source.paramIds?.has(param) === true || Object.hasOwn(source.params ?? {}, param);
}

/** Whether reported volume plus state or timeout proves a standalone siren command surface. */
function hasStandaloneSirenEvidence(source: {
  params?: Record<number, string>;
  paramIds?: ReadonlySet<number>;
}): boolean {
  return (
    reportsParam(source, SIREN_PARAM.ALARM_VOLUME) &&
    (reportsParam(source, SIREN_PARAM.RING_STATUS) || reportsParam(source, SIREN_PARAM.ALARM_TIMEOUT))
  );
}

/** Whether this context belongs to the sensor codec used by standalone sirens. */
function isSensorCodec(ctx: AvailabilityContext): boolean {
  return ctx.codec === "sensor";
}

/** Whether a sensor-codec device reports the combined standalone siren evidence. */
function isEvidencedStandaloneSiren(ctx: CommandContext): boolean {
  return isSensorCodec(ctx) && hasStandaloneSirenEvidence(ctx);
}

/** Build the station-family HomeBase duration command, requiring the acting username carried by the wire. */
function homeBaseAlarm(seconds: number, ctx: CommandContext): Command {
  if (!ctx.accountName) throw new Error("station-family HomeBase alarm output requires the acting account name");
  return setPayload(
    SIREN_CMD.HOMEBASE_TONE,
    { time_out: seconds, user_name: ctx.accountName },
    ctx,
    0,
    STATION_CHANNEL,
  );
}

/** Build the attached-camera int-plus-string duration command for its own bound device channel. */
function cameraAlarm(seconds: number, ctx: CommandContext): Command {
  return {
    kind: "p2p-int-string",
    cmd: SIREN_CMD.CAMERA_TONE,
    value: seconds,
    valueSub: ctx.channel,
    channel: ctx.channel,
  };
}

/** Alarm-output protocol families admitted by runtime evidence. */
type AlarmOutputFamily = "homebase" | "camera" | "standalone";

/** Classify only the alarm-output families whose runtime evidence admits a command. */
function alarmOutputFamily(ctx: CommandContext): AlarmOutputFamily | undefined {
  if (isEvidencedStationAlarm(ctx)) return "homebase";
  if (isEvidencedAttachedCamera(ctx)) return "camera";
  if (isEvidencedStandaloneSiren(ctx)) return "standalone";
  return undefined;
}

/** Build the exact duration command for a verified manually triggered alarm-output family. */
function triggerAlarm(seconds: number, ctx: CommandContext): Command {
  const family = alarmOutputFamily(ctx);
  if (family === "homebase") return homeBaseAlarm(seconds, ctx);
  if (family === "camera") return cameraAlarm(seconds, ctx);
  throw new Error("manual alarm trigger has no verified wire for this device family");
}

/** Build the verified stop command without sharing wire forms across alarm-output families. */
function stopAlarm(ctx: CommandContext): Command {
  const family = alarmOutputFamily(ctx);
  if (family === "homebase") return homeBaseAlarm(0, ctx);
  if (family === "camera") return cameraAlarm(0, ctx);
  if (family === "standalone") return sirenPayload(SIREN_CMD.MANUAL_STOP, {}, ctx);
  throw new Error("manual alarm stop has no verified wire for this device family");
}

/** Reject malformed durations before a fire-and-forget alarm command reaches hardware. */
function validateTriggerDuration(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`trigger duration ${String(seconds)} is not a positive safe whole-number duration in seconds`);
  }
  return seconds;
}

/**
 * A siren write: `1350` SET_PAYLOAD on the device channel with `mValue3` 0, the app's captured frame.
 * The `transaction` stamp is part of that frame; the sink injects `account_id`.
 *
 * Level-2 only, though the `mValue3` 0 would allow `"auto"`: every device reaching this is a HomeBase or
 * an accessory whose session IS its HomeBase's, so a key is structurally there. Throwing on a keyless
 * one names a real anomaly where a silently-ignored level-1 frame would read as success. See
 * `setPayload`'s two conditions.
 */
function sirenPayload(cmd: number, body: Record<string, number>, ctx: CommandContext): Command {
  return setPayload(cmd, { ...body, transaction: String(Date.now()) }, ctx, 0);
}

/**
 * Every audible alarm-output feature, declared once. Standalone sirens expose observed state,
 * configuration, test, and stop; evidenced HomeBases expose alarm configuration plus trigger/stop;
 * verified attached cameras expose trigger/stop only.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const SIREN_MEMBERS = {
  /**
   * Authoritative sounding state reported by a standalone siren. HomeBase and camera command
   * acknowledgements do not install or update this read.
   */
  active: {
    param: SIREN_PARAM.RING_STATUS,
    property: "siren",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    available: isSensorCodec,
    description:
      "Whether the siren is sounding (61008 APP_CMD_DEV_RING_STATUS). ✅ Confirmed boolean: a live " +
      "test on a T90R0 pushed 1 (sounding) then 0 (silent).",
  },
  /**
   * Rejected, not clamped, outside the 1-3 set: the write is fire-and-forget, so an out-of-range level
   * would look like it worked.
   */
  volume: {
    param: SIREN_PARAM.ALARM_VOLUME,
    property: "sirenVolume",
    type: "number",
    kind: "scalar",
    provenance: "verified",
    available: isSensorCodec,
    requires: [SIREN_PARAM.ALARM_VOLUME],
    enumValues: enumLabels(SirenVolume),
    args: [{ name: "level", kind: "scalar", description: "A device level 1-3 (Low/Mid/High), not a percentage." }],
    description:
      "Alarm volume (1825 APP_CMD_SIREN_SENSOR_SET_ALARM_VOL), a device level 1-3 (Low/Mid/High), NOT " +
      "a percentage. Write verified live on a T90R0 (1350 SET_PAYLOAD {volume}).",
    write: (v, ctx) => {
      const level = coerceEnumValue(SirenVolume, v);
      return level === undefined ? undefined : sirenPayload(SIREN_PARAM.ALARM_VOLUME, { volume: level }, ctx);
    },
  },
  /** Only the four captured presets are accepted: no capture supports an arbitrary duration. */
  alarmDuration: {
    param: SIREN_PARAM.ALARM_TIMEOUT,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "verified",
    available: isSensorCodec,
    requires: [SIREN_PARAM.ALARM_TIMEOUT],
    enumValues: enumLabels(SirenAlarmDuration),
    args: [{ name: "seconds", kind: "seconds", description: "One of the app's presets: 60/300/600/900." }],
    description:
      "How long an alarm sounds before stopping itself (61006 APP_CMD_DEV_ALARM_TIMEOUT), seconds. " +
      "Write verified live on a T90R0 (1350 SET_PAYLOAD {value}); app presets 60/300/600/900.",
    write: (v, ctx) => {
      const seconds = coerceEnumValue(SirenAlarmDuration, v);
      return seconds === undefined ? undefined : sirenPayload(SIREN_PARAM.ALARM_TIMEOUT, { value: seconds }, ctx);
    },
  },
  /**
   * Read-only: `apk` provenance means the id comes from the disassembled app and the only live evidence
   * is a T90R0 reporting 0, which fixes neither the polarity's other value nor a write frame. Typed
   * `bool` on the app's own naming; do not add a setter until a toggle is captured.
   */
  doNotDisturb: {
    param: SIREN_PARAM.NOT_DISTURB,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    available: isSensorCodec,
    description: "Do-not-disturb (1828 APP_CMD_SENSOR_NOT_DISTURB). Observed 0 on a T90R0.",
  },

  /** HomeBase alarm volume is a percentage on a station-scalar wire, unlike standalone level 1-3. */
  alarmVolume: {
    param: SIREN_CMD.HUB_SPK_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: isHomeBase,
    requires: HUB_ALARM_EVIDENCE,
    min: 0,
    max: 100,
    description: "HomeBase alarm volume 0..100 (1235 CMD_SET_HUB_SPK_VOLUME). Verified audible on a T8030.",
    write: (v) => setStationScalar(SIREN_CMD.HUB_SPK_VOLUME, Number(v), STATION_CHANNEL),
  },
  /** HomeBase alarm tone keeps its independently verified two-option domain. */
  alarmTone: {
    param: SIREN_CMD.HUB_ALARM_TONE,
    property: "hubAlarmTone",
    type: "number",
    kind: "enum",
    enumValues: enumLabels(HubAlarmTone),
    provenance: "verified",
    available: isHomeBase,
    requires: HUB_ALARM_EVIDENCE,
    args: [{ name: "tone", kind: "enum", description: "One of the app's alarm tones (1-indexed)." }],
    description:
      "HomeBase alarm tone selection (1281 APP_CMD_HUB_ALARM_TONE; 1350 SET_PAYLOAD {type}, mValue3 0). " +
      "Wire verified live on a T8030.",
    write: (v, ctx) => {
      const tone = coerceEnumValue(HubAlarmTone, v);
      return tone === undefined ? undefined : setPayload(SIREN_CMD.HUB_ALARM_TONE, { type: tone }, ctx, 0);
    },
  },

  /** Sound a standalone siren briefly using its dedicated installation-test wire. */
  test: {
    action: (ctx) => sirenPayload(SIREN_CMD.ALARM_TEST, {}, ctx),
    available: isEvidencedStandaloneSiren,
    description: "Sound the siren briefly as a test.",
  },
  /** Trigger a verified station-family HomeBase or evidenced attached-camera alarm for a bounded duration. */
  trigger: {
    ...method(
      ({ ctx, sink }) =>
        async (seconds: number) => {
          await sink.dispatch(triggerAlarm(validateTriggerDuration(seconds), ctx));
        },
      "Trigger the alarm for a positive whole-number duration in seconds.",
      (ctx) => isEvidencedStationAlarm(ctx) || isEvidencedAttachedCamera(ctx),
    ),
    args: [{ name: "seconds", kind: "seconds", min: 1, description: "A positive whole-number duration." }],
  },
  /** Stop a verified alarm-output family through its own wire contract. */
  stop: method(
    ({ ctx, sink }) =>
      () =>
        sink.dispatch(stopAlarm(ctx)),
    "Manually stop a sounding alarm.",
    (ctx) => alarmOutputFamily(ctx) !== undefined,
  ),
} as const satisfies Members;

/**
 * `siren` — audible alarm output across independently verified standalone siren, HomeBase, and camera
 * families. Member installation preserves each family's state evidence, units, and wire contract.
 */
export const SIREN: CapabilityModule = {
  capability: "siren",
  description: "Audible alarm output with evidence-bounded state, configuration, test, trigger, and stop members.",
  members: SIREN_MEMBERS,
  properties: propertiesOf(SIREN_MEMBERS),
  /** Detection uses reported evidence and topology; no model string or device type admits a wire. */
  detection: {
    detect: (record, codec) => {
      const homeBase = record.deviceType !== undefined && HOMEBASE_TYPES.has(record.deviceType);
      const homeBaseAlarm = homeBase && HUB_ALARM_EVIDENCE.some((param) => Object.hasOwn(record.params ?? {}, param));
      const attachedCameraAlarm = codec === "camera" && !!record.parentSn && hasReportedEasSwitch(record);
      const standaloneSiren = codec === "sensor" && hasStandaloneSirenEvidence(record);
      return homeBaseAlarm || attachedCameraAlarm || standaloneSiren;
    },
  },
};
