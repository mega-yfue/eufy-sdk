import { coerceEnumValue, enumLabels, isStationSerial } from "../../core/util.js";
import { HOMEBASE_TYPES, isHomeBase } from "../device-family.js";
import { setPayload, setStationScalar } from "./access.js";
import { bundled, thingWrite } from "./bundle.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The siren's **state-backed param ids** — each is a param the device reports (and some are also
 * writable). Named `SIREN_PARAM` vs `SIREN_CMD` below (momentary triggers with no reported state) so
 * the split the code implements is explicit.
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
  /** HomeBase alarm volume percentage (app `CMD_SET_HUB_SPK_VOLUME`). */
  HUB_SPK_VOLUME: 1235,
  /** HomeBase alarm-tone selection (app `APP_CMD_HUB_ALARM_TONE`). */
  HUB_ALARM_TONE: 1281,
} as const;

/** The station broadcast channel the HomeBase alarm volume rides. */
const STATION_CHANNEL = 255;

/**
 * Siren alarm volume — a small device level 1-3 (Low/Mid/High), NOT a percentage. Pass a value to
 * `setVolume`.
 */
export const SirenVolume = { Low: 1, Mid: 2, High: 3 } as const;
/** A siren volume level — the value side of {@link SirenVolume}. */
export type SirenVolumeValue = (typeof SirenVolume)[keyof typeof SirenVolume];

/** `sensor_alarm_timeout` as each product's settings bundle writes and reads it. */
const ALARM_TIMEOUT = bundled(["sensor_alarm_timeout"], SIREN_PARAM.ALARM_TIMEOUT, true);

/** HomeBase alarm tone options, 1-indexed. */
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

/**
 * The live view's alarm (`AlarmActionHandler`): `set_alarm_type` written with Gson's `AlarmModel(open, type)`, the
 * `AlarmType` sound only (0) on a camera, HomeBase sound (3) on a station, as the product's settings bundle sends it.
 * `undefined` where the description lists no `set_alarm_type`, the bundle frames none, or on a sensor-codec siren,
 * which has no live view.
 */
function liveAlarm(open: boolean, ctx: CommandContext): Command | undefined {
  if (isSensorCodec(ctx) || !ctx.things?.properties.set_alarm_type) return undefined;
  return thingWrite("set_alarm_type", JSON.stringify({ open, type: isStationSerial(ctx.serial ?? "") ? 3 : 0 }), ctx);
}

/** The stop: a standalone siren's manual stop, else the live view's alarm closed. */
function stopAlarm(ctx: CommandContext): Command | undefined {
  return isEvidencedStandaloneSiren(ctx) ? sirenPayload(SIREN_CMD.MANUAL_STOP, {}, ctx) : liveAlarm(false, ctx);
}

/**
 * A siren write: `1350` SET_PAYLOAD on the device channel with `mValue3` 0, the app's frame.
 * The `transaction` stamp is part of that frame; the sink injects `account_id`.
 */
function sirenPayload(cmd: number, body: Record<string, number>, ctx: CommandContext): Command {
  return setPayload(cmd, { ...body, transaction: String(Date.now()) }, ctx, 0);
}

/**
 * Every audible alarm-output feature, declared once. Standalone sirens expose observed state,
 * configuration, test, and stop; evidenced HomeBases expose alarm configuration; a device whose description
 * lists `set_alarm_type` exposes the live view's trigger/stop.
 *
 * Exported but NOT published: each entry states its wire id and its gate,
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
    available: isSensorCodec,
    description: "Whether the siren is sounding (61008 APP_CMD_DEV_RING_STATUS): 1 = sounding, 0 = silent.",
  },
  /**
   * The levels the product's description lists (`audio_alert_volume`), else 1-3. Rejected, not clamped,
   * outside them: the write is fire-and-forget, so an out-of-range level would look like it worked.
   */
  volume: {
    param: SIREN_PARAM.ALARM_VOLUME,
    property: "sirenVolume",
    type: "number",
    kind: "scalar",
    available: isSensorCodec,
    requires: [SIREN_PARAM.ALARM_VOLUME],
    enumValues: enumLabels(SirenVolume),
    thing: ["audio_alert_volume"],
    args: [{ name: "level", kind: "scalar", description: "A device level 1-3 (Low/Mid/High), not a percentage." }],
    description:
      "Alarm volume (1825 APP_CMD_SIREN_SENSOR_SET_ALARM_VOL), a device level 1-3 (Low/Mid/High), NOT " +
      "a percentage. Write: 1350 SET_PAYLOAD {volume}.",
    write: (v, ctx) => {
      const level = coerceEnumValue(SirenVolume, v);
      return level === undefined ? undefined : sirenPayload(SIREN_PARAM.ALARM_VOLUME, { volume: level }, ctx);
    },
  },
  /** The app's UI value for `sensor_alarm_timeout` (the description names each); absent where it lists none. */
  alarmDuration: {
    type: "enum",
    kind: "scalar",
    ...ALARM_TIMEOUT,
    description:
      "How long an alarm sounds before stopping itself, as the app's own value for the product (its " +
      "description names each), written and read as the product's settings bundle does.",
  },
  /**
   * Read-only: the id comes from the app, which fixes neither the polarity nor a write frame. Typed
   * `bool` on the app's own naming; do not add a setter until a toggle is captured.
   */
  doNotDisturb: {
    param: SIREN_PARAM.NOT_DISTURB,
    type: "bool",
    kind: "boolean",
    available: isSensorCodec,
    description: "Do-not-disturb (1828 APP_CMD_SENSOR_NOT_DISTURB).",
  },

  /** HomeBase alarm volume is a percentage on a station-scalar wire, unlike standalone level 1-3. */
  alarmVolume: {
    param: SIREN_CMD.HUB_SPK_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    available: isHomeBase,
    requires: HUB_ALARM_EVIDENCE,
    min: 0,
    max: 100,
    description: "HomeBase alarm volume 0..100 (1235 CMD_SET_HUB_SPK_VOLUME).",
    write: (v) => setStationScalar(SIREN_CMD.HUB_SPK_VOLUME, Number(v), STATION_CHANNEL),
  },
  /** HomeBase alarm tones, the ones the product's description lists (`alarm_tones_mode`), else both. */
  alarmTone: {
    param: SIREN_CMD.HUB_ALARM_TONE,
    property: "hubAlarmTone",
    type: "number",
    kind: "enum",
    enumValues: enumLabels(HubAlarmTone),
    thing: ["alarm_tones_mode"],
    available: isHomeBase,
    requires: HUB_ALARM_EVIDENCE,
    args: [{ name: "tone", kind: "enum", description: "One of the app's alarm tones (1-indexed)." }],
    description: "HomeBase alarm tone selection (1281 APP_CMD_HUB_ALARM_TONE; 1350 SET_PAYLOAD {type}, mValue3 0).",
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
  /** Sound the alarm as the live view does: the bundle's `time_out` (30 s), no duration of the host's. */
  trigger: method(
    ({ ctx, sink }) =>
      () =>
        sink.dispatch(liveAlarm(true, ctx)!),
    "Sound the alarm as the app's live view does; it stops itself after the device's time-out.",
    (ctx) => liveAlarm(true, ctx) !== undefined,
  ),
  /** Stop a sounding alarm through its own wire. */
  stop: method(
    ({ ctx, sink }) =>
      () =>
        sink.dispatch(stopAlarm(ctx)!),
    "Manually stop a sounding alarm.",
    (ctx) => stopAlarm(ctx) !== undefined,
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
  /** Detection uses reported evidence and the description; no model string or device type admits a wire. */
  detection: {
    detect: (record, codec) => {
      const homeBase = record.deviceType !== undefined && HOMEBASE_TYPES.has(record.deviceType);
      const homeBaseAlarm = homeBase && HUB_ALARM_EVIDENCE.some((param) => Object.hasOwn(record.params ?? {}, param));
      const liveViewAlarm = codec !== "sensor" && !!record.things?.properties.set_alarm_type;
      const standaloneSiren = codec === "sensor" && hasStandaloneSirenEvidence(record);
      return homeBaseAlarm || liveViewAlarm || standaloneSiren;
    },
  },
};
