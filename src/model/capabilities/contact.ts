import { CusPushEvent } from "../push-events.js";
import { asBool, coerceEnumValue, enumLabels } from "../../core/util.js";
import { setScalar, setPayload } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityEvent, CapabilityModule, InboundSignal } from "./types.js";

/**
 * The entry sensor's own command/param ids, each the app's own (`APP_CMD_*` in the product's settings
 * bundle) and reported by a real sensor.
 */
export const CONTACT_CMD = {
  /** Contact state (`APP_CMD_ENTRY_SENSOR_STATUS`, identifier `sensor_door_status`). */
  STATUS: 1550,
  /** Removed from its mount (`APP_CMD_DEV_DISASSEMBLE`, identifier `sensor_disassemble_status`). */
  TAMPER: 61015,
  /** Bypassed by the alarm (`APP_CMD_DEV_ENTRY_BYPASS`, identifier `sensor_door_bypass_status`). */
  BYPASS: 61016,
  /** Left-open alert (`APP_CMD_SENSOR_OPEN_STATUS_ALERT`, identifier `sensor_door_open_status_alert_config`). */
  OPEN_ALERT: 1290,
  /** Daily state check (`APP_CMD_SENSOR_DOOR_DAILY_CHECK`, identifier `sensor_door_daily_check_status_config`). */
  DAILY_CHECK: 1291,
  /** Alarm tone (`APP_CMD_ALARM_SOUND_TYPE`, identifier `device_alarm_sound_type`). */
  ALARM_SOUND_TYPE: 1507,
  /** Alarm volume (`APP_CMD_ALARM_VOLUME_VALUE`, identifier `alarm_volume_value`). */
  ALARM_VOLUME: 1508,
} as const;

/**
 * The station's unsolicited sensor-status notify — inner `cmd` of a P2P notify frame
 * (`APP_CMD_DEV_SENSOR_NOTIFY`). It carries a `params` array of `{dev_type, param_type, param_value}` for
 * one attached sensor, volunteered on an IDLE session with no subscription, stream or stimulus.
 *
 * Verified live on a T8900 behind a T8010: five door movements across four sessions produced this
 * notify 2 to 2.7 s BEFORE the matching FCM push, over a LAN-direct session. Polarity locked by
 * anti-correlation with the push's own value field.
 */
const SENSOR_STATUS_CMD = 1829;

/** The left-open alert delays the app offers, in minutes (`sensor_door_open_status_alert_config`). */
const OPEN_ALERT_MINUTES = [5, 10, 15, 30, 60] as const;

/** The alarm tones, by wire value, as the product's description labels them (`device_alarm_sound_type`). */
const ALARM_TONES = { None: 0, Water: 1, Classics: 2, Light: 3, Ding: 4 } as const;

/** Alarm volume bounds (`alarm_volume_value`: min 1, max 26, a device level, not a percentage). */
const ALARM_VOLUME_MIN = 1;
const ALARM_VOLUME_MAX = 26;

/**
 * Whether the product's description lists `identifier`. With no description fetched the member stays,
 * so a missing cloud reply never hides what the device reports.
 */
const described =
  (identifier: string) =>
  (ctx: AvailabilityContext): boolean =>
    !ctx.things || identifier in ctx.things.properties;

/**
 * Read one param out of a sensor-status notify, or `undefined` when this signal isn't one / doesn't
 * carry that param. Structural throughout: the frame shape is {@link InboundSignal}'s `p2p-frame`
 * arm, so nothing here names a transport.
 */
function statusParam(signal: InboundSignal, paramType: number): string | undefined {
  if (signal.source !== "p2p-frame" || signal.json?.cmd !== SENSOR_STATUS_CMD) return undefined;
  const params = (signal.json.payload as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(params)) return undefined;
  const hit = params.find((p) => (p as { param_type?: number })?.param_type === paramType) as
    { param_value?: unknown } | undefined;
  return hit?.param_value == null ? undefined : String(hit.param_value);
}

/**
 * Normalise a raw contact value to `{ open }`, or `{}` when the signal didn't carry one. `"1"` is open,
 * anything else closed, as the app's `CusPushMode.isSensorOpen()` (`"1".equals(e)`) and the bundle's
 * `asBoolean` read it; confirmed on a T8900 through three open/close cycles. An absent value yields no
 * field, so "closed" stays distinguishable from "this signal said nothing about the contact".
 */
function contactOpen(raw: unknown): Record<string, unknown> {
  return raw == null || raw === "" ? {} : { open: String(raw) === "1" };
}

/**
 * A left-open alert or daily-check config as the sensor stores it: base64 of a JSON object
 * (`{door_enable, door_time_point}` / `{door_enable, door_time_interval}`), or `undefined` when it is not.
 */
function config(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Minutes since midnight as `HH:MM`, the app's own conversion for the daily check. */
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `HH:MM` as minutes since midnight, or `undefined` for anything else. */
function minutesOf(time: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return undefined;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

/** Bound entry-sensor controls — the object returned by `dev.contact()`, derived from `CONTACT_MEMBERS`. */
export type ContactActions = Surface<typeof CONTACT_MEMBERS>;

/**
 * Every `contact` feature, declared once, each on the identifier the product's thing description names
 * and the param the app's settings bundle reads it from.
 *
 * Exported but NOT published: each entry states its wire id and its evidence, which the reference site
 * does not carry.
 * @internal
 */
export const CONTACT_MEMBERS = {
  /**
   * The headline read: `true` when the door or window is open. Every inbound source normalises through
   * `contactOpen`, so the poll, the push and the station notify cannot disagree about what open means.
   * Reporting 1550 is also this capability's detection evidence.
   */
  open: {
    param: CONTACT_CMD.STATUS,
    property: "contact",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description: "Contact state, true=open (1550, sensor_door_status).",
  },
  /** The sensor was removed from its mount. Reported by a T8900; the meaning of a set value is the product bundle's. */
  tampered: {
    param: CONTACT_CMD.TAMPER,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Removed from its mount (61015, sensor_disassemble_status).",
  },
  /** The alarm currently skips this sensor. Reported by a T8900; the meaning of a set value is the product bundle's. */
  bypassed: {
    param: CONTACT_CMD.BYPASS,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Bypassed by the alarm (61016, sensor_door_bypass_status).",
  },
  /**
   * The left-open alert config, whole as the sensor stores it (base64 JSON). Its two fields are the
   * members below; both are set together by `setOpenAlert`, since one frame carries both.
   */
  openAlertConfig: {
    param: CONTACT_CMD.OPEN_ALERT,
    type: "string",
    kind: "text",
    provenance: "verified",
    unexposed: true,
    writtenElsewhere: true,
    description: "Left-open alert config, base64 JSON {door_enable,door_time_point} (1290).",
  },
  /** Whether a notification fires when the door stays open longer than {@link CONTACT_MEMBERS.openAlertMinutes}. */
  openAlert: {
    readsFrom: "openAlertConfig",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    decode: (raw) => {
      const c = config(raw);
      return c === undefined ? undefined : asBool(c.door_enable);
    },
    description: "Left-open alert on (1290 door_enable). Set with setOpenAlert.",
  },
  /** How long the door may stay open before the alert fires: one of 5, 10, 15, 30 or 60 minutes. */
  openAlertMinutes: {
    readsFrom: "openAlertConfig",
    type: "number",
    kind: "scalar",
    provenance: "verified",
    decode: (raw) => {
      const n = Number(config(raw)?.door_time_point);
      return Number.isInteger(n) ? n : undefined;
    },
    description: "Left-open alert delay, minutes: 5, 10, 15, 30 or 60 (1290 door_time_point).",
  },
  /** The daily state check config, whole (base64 JSON); its fields are the members below. */
  dailyCheckConfig: {
    param: CONTACT_CMD.DAILY_CHECK,
    type: "string",
    kind: "text",
    provenance: "verified",
    unexposed: true,
    writtenElsewhere: true,
    description: "Daily check config, base64 JSON {door_enable,door_time_interval} (1291).",
  },
  /** Whether the sensor's state is notified at each of {@link CONTACT_MEMBERS.dailyCheckTimes}. */
  dailyCheck: {
    readsFrom: "dailyCheckConfig",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    decode: (raw) => {
      const c = config(raw);
      return c === undefined ? undefined : asBool(c.door_enable);
    },
    description: "Daily state check on (1291 door_enable). Set with setDailyCheck.",
  },
  /** The times of day the state is notified, `HH:MM` comma-separated in the order the sensor holds them. */
  dailyCheckTimes: {
    readsFrom: "dailyCheckConfig",
    type: "string",
    kind: "text",
    provenance: "verified",
    decode: (raw) => {
      const times = config(raw)?.door_time_interval;
      return Array.isArray(times) ? times.map((t) => hhmm(Number(t) || 0)).join(",") : undefined;
    },
    description: "Daily check times, HH:MM comma-separated (1291 door_time_interval, minutes since midnight).",
  },
  /**
   * Turn the left-open alert on or off, with its delay. One frame carries both: `1350` SET_PAYLOAD,
   * sub-command 1290, `{door_enable, door_time_point}` — the product's settings bundle's own frame.
   * Verified live on a T8900: param 1290 read back the written value and the app showed it.
   */
  setOpenAlert: method(
    ({ ctx, sink }) =>
      async (on: boolean, minutes: (typeof OPEN_ALERT_MINUTES)[number]): Promise<void> => {
        if (!(OPEN_ALERT_MINUTES as readonly number[]).includes(minutes)) {
          throw new Error(`openAlertMinutes: ${String(minutes)} is not one of ${OPEN_ALERT_MINUTES.join(", ")}`);
        }
        await sink.dispatch(
          setPayload(CONTACT_CMD.OPEN_ALERT, { door_enable: asBool(on) ? 1 : 0, door_time_point: minutes }, ctx, 0),
        );
      },
    "Set the left-open alert and its delay (5, 10, 15, 30 or 60 minutes), which share one wire.",
  ),
  /**
   * Turn the daily state check on or off, with its times of day. One frame carries both: `1350`
   * SET_PAYLOAD, sub-command 1291, `{door_enable, door_time_interval}` with each time as minutes since
   * midnight — the product's settings bundle's own frame.
   * Verified live on a T8900: param 1291 read back the written times and the app showed them.
   */
  setDailyCheck: method(
    ({ ctx, sink }) =>
      async (on: boolean, times: readonly string[]): Promise<void> => {
        const minutes = times.map(minutesOf);
        if (minutes.some((m) => m === undefined)) {
          throw new Error(`dailyCheckTimes: ${times.join(",")} must all be HH:MM`);
        }
        await sink.dispatch(
          setPayload(CONTACT_CMD.DAILY_CHECK, { door_enable: asBool(on) ? 1 : 0, door_time_interval: minutes }, ctx, 0),
        );
      },
    "Set the daily state check and its times of day (HH:MM), which share one wire.",
  ),
  /**
   * The built-in alarm tone, offered where the product's description lists it: a sensor may report the
   * param while the app offers no such setting on it. Rejected, not clamped, outside the listed tones.
   * Write: a direct-binary scalar `[ch][value][acct]` at signCode 8, captured live on a T90E0.
   */
  alarmSoundType: {
    param: CONTACT_CMD.ALARM_SOUND_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: enumLabels(ALARM_TONES),
    thing: ["device_alarm_sound_type"],
    provenance: "verified",
    available: described("device_alarm_sound_type"),
    args: [{ name: "tone", kind: "enum", description: "Silent (0) or one of the four tones." }],
    description: "Alarm tone (1507, device_alarm_sound_type): 0=None,1=Water,2=Classics,3=Light,4=Ding.",
    write: (v, ctx) => {
      const tone = coerceEnumValue(ALARM_TONES, v);
      return tone === undefined ? undefined : setScalar(CONTACT_CMD.ALARM_SOUND_TYPE, tone, ctx, "auto");
    },
  },
  /**
   * The built-in alarm volume, a device level 1-26, offered where the product's description lists it.
   * Write: `1350` SET_PAYLOAD with `mChannel` the device channel, `mValue3` 0, payload `{channel, volume,
   * transaction}` — the app's own captured frame on a T90E0. Out of range is refused, not clamped.
   */
  alarmVolume: {
    param: CONTACT_CMD.ALARM_VOLUME,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    available: described("alarm_volume_value"),
    min: ALARM_VOLUME_MIN,
    max: ALARM_VOLUME_MAX,
    args: [
      { name: "level", kind: "scalar", min: ALARM_VOLUME_MIN, max: ALARM_VOLUME_MAX, description: "A device level." },
    ],
    description: "Alarm volume (1508, alarm_volume_value), a device level 1-26, not a percentage.",
    write: (v, ctx) => {
      const level = Number(v);
      return Number.isInteger(level) && level >= ALARM_VOLUME_MIN && level <= ALARM_VOLUME_MAX
        ? setPayload(
            CONTACT_CMD.ALARM_VOLUME,
            { channel: ctx.channel, volume: level, transaction: String(Date.now()) },
            ctx,
            0,
          )
        : undefined;
    },
  },
} as const satisfies Members;

/** `contact` — entry (door/window) sensor. */
export const CONTACT: CapabilityModule = {
  capability: "contact",
  description:
    "Entry (door/window) sensor: contact state, tamper and bypass, the left-open alert and the " +
    "daily state check, and the built-in alarm where the product has one.",
  members: CONTACT_MEMBERS,
  properties: propertiesOf(CONTACT_MEMBERS),
  /** A reported entry-sensor contact param (1550) is the verified proof of a contact sensor. */
  detection: { evidenceParams: [CONTACT_CMD.STATUS] },
  /**
   * Inbound `contactState`: the contact param changing on a cloud poll, and the FCM door-sensor push
   * (`CusPushEvent.DOOR_SENSOR`), whose state is the single-letter `e` — both verified live on a T8900.
   */
  events: [
    {
      source: "poll",
      match: CONTACT_CMD.STATUS,
      emit: "contactState",
      derive: (s) => contactOpen(s.source === "poll" ? s.to : undefined),
    },
    {
      source: "push",
      match: CusPushEvent.DOOR_SENSOR,
      emit: "contactState",
      derive: (s) => contactOpen(s.source === "push" ? s.payload?.["e"] : undefined),
    },
  ],
  /**
   * One door movement reaches the SDK up to three times — the station notify, the same value as a push
   * ~2 s later, then again on the next poll — so `contactState` is announced on a change only.
   */
  stateEvents: [{ event: "contactState", field: "open" }],
  /**
   * The station's own notify, the fastest contact signal and the only one that needs no cloud. A
   * declarative `events` row matches a push id or a poll param, not a param nested in a frame's
   * `params` array under an inner command, hence the decode hook. A notify without the contact param
   * (battery or signal only) emits nothing.
   */
  decodeEvent(signal: InboundSignal): CapabilityEvent | null {
    const raw = statusParam(signal, CONTACT_CMD.STATUS);
    if (raw === undefined) return null;
    return { event: "contactState", payload: contactOpen(raw) };
  },
};
