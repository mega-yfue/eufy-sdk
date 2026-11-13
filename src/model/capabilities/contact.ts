import { CusPushEvent } from "../push-events.js";
import { coerceEnumValue, enumLabels } from "../../core/util.js";
import { setScalar, setPayload } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityEvent, CapabilityModule, InboundSignal } from "./types.js";

/**
 * The entry sensor's own **command/param ids** — its built-in alarm buzzer (sounds when the door
 * opens while armed), separate from the open/close contact read. Both write wires were captured live
 * on a T90E0 (2026-08-03).
 */
export const CONTACT_CMD = {
  /** Alarm sound/tone selection (app `APP_CMD_ALARM_SOUND_TYPE`). See {@link EntryAlarmTone}. */
  ALARM_SOUND_TYPE: 1507,
  /** Alarm volume (app `APP_CMD_ALARM_VOLUME_VALUE`). A device level 1-26, not a percentage. */
  ALARM_VOLUME: 1508,
} as const;

/**
 * The entry sensor's built-in alarm tone: silent, or one of four chimes. Pass a value to
 * `setAlarmSoundType`.
 */
export const EntryAlarmTone = {
  /** Silent — no alarm tone. */
  None: 0,
  Water: 1,
  Classic: 2,
  Light: 3,
  Ding: 4,
} as const;
/** An entry-sensor alarm tone — the value side of {@link EntryAlarmTone}. */
export type EntryAlarmToneValue = (typeof EntryAlarmTone)[keyof typeof EntryAlarmTone];

/** Alarm volume bounds observed on the app's slider (min → max). */
const ALARM_VOLUME_MIN = 1;
const ALARM_VOLUME_MAX = 26;

/**
 * The station's unsolicited sensor-status notify — inner `cmd` of a P2P notify frame. Named
 * `APP_CMD_SENSOR_STATUS` in the V6 app; it carries a `params` array of
 * `{dev_type, param_type, param_value}` for one attached sensor, and the station volunteers it on an
 * IDLE session with no subscription, stream or stimulus.
 *
 * ✅ Verified live on a T8900 behind a T8010 (2026-08-03): five door movements across four sessions
 * produced this notify **1994/2032/2163/2623/2671 ms BEFORE** the matching FCM push, over a
 * LAN-direct session. Polarity locked by anti-correlation with the push's own value field.
 */
const SENSOR_STATUS_CMD = 1829;

/** Contact state inside the notify's param array — the same id the cloud record uses. */
const CONTACT_PARAM = 1550;

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
 * Normalise a raw contact value to `{ open }`, or `{}` when the signal didn't carry one.
 *
 * Both inbound sources encode the state as a string that is `"1"` for open, and the V6 app treats
 * anything else — including absent — as closed (`CusPushMode.isSensorOpen()` is literally
 * `"1".equals(e)`). Confirmed against hardware: a T8900 driven through three open/close cycles emitted
 * `"1"`/`"0"` matching the physical state each time.
 *
 * An absent value yields no field at all rather than `false`, so "closed" stays distinguishable from
 * "this signal said nothing about the contact".
 */
function contactOpen(raw: unknown): Record<string, unknown> {
  return raw == null || raw === "" ? {} : { open: String(raw) === "1" };
}

/**
 * Bound entry-sensor controls — the object returned by `dev.contact()`.
 *
 * Everything is DERIVED from `CONTACT_MEMBERS`. The open/close read is the headline; the entry
 * sensor also carries a built-in alarm buzzer whose tone and volume are writable, each setter present
 * only when the device reports the backing param.
 */
export type ContactActions = Surface<typeof CONTACT_MEMBERS>;

/**
 * Every `contact` feature, declared once. `contact` (1550) and `lastSeen` (1551) are verified reads;
 * the built-in alarm tone (1507) and volume (1508) are verified writes captured live on a T90E0.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const CONTACT_MEMBERS = {
  /**
   * The headline read: `true` when the door or window is open. Polarity is the V6 app's own
   * `"1".equals(e)` — see `contactOpen`, which normalises every inbound source through one
   * predicate so the poll, the push and the station notify cannot disagree about what open means.
   * Reporting 1550 is also this capability's detection evidence, so a device with this getter is
   * confirmed to be a contact sensor.
   */
  open: {
    param: CONTACT_PARAM,
    property: "contact",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description: "Contact state, true=open (verified: param 1550 entry-sensor contact).",
  },
  /**
   * Unix seconds at which the sensor last checked in — the liveness read beside the contact state, and
   * the way to tell a genuinely closed door from a sensor that stopped reporting. A `timestamp` kind
   * takes no `unit`: it is an instant, not a duration.
   */
  lastSeen: {
    param: 1551,
    type: "number",
    kind: "timestamp",
    provenance: "verified",
    description: "Last-seen unix timestamp, seconds (verified: param 1551).",
  },
  /**
   * Link quality to whichever radio the sensor is paired over, in dBm as the device measures it. The
   * same param 1141 the other sub-1G sensors report on, so the number is comparable across them —
   * unlike a bars mapping, which this SDK never applies.
   */
  rssi: {
    param: 1141,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "verified",
    description: "Sub-1G/Wi-Fi signal strength (verified: param 1141 = RSSI).",
  },
  /**
   * Rejected, not clamped, outside the tone enum: a fire-and-forget write of a bogus tone would look like
   * it worked. The wire is a direct-binary scalar `[ch][value][acct]` at signCode 8 — the app's own
   * captured frame.
   */
  alarmSoundType: {
    param: CONTACT_CMD.ALARM_SOUND_TYPE,
    type: "enum",
    kind: "enum",
    enumValues: enumLabels(EntryAlarmTone),
    provenance: "verified",
    requires: [CONTACT_CMD.ALARM_SOUND_TYPE],
    args: [{ name: "tone", kind: "enum", description: "Silent (0) or one of the four chimes." }],
    description:
      "Entry-sensor alarm tone (1507): 0=None,1=Water,2=Classic,3=Light,4=Ding. Write verified live " +
      "on a T90E0 (direct-binary [ch][value][acct]). See CONTACT_CMD.ALARM_SOUND_TYPE.",
    write: (v, ctx) => {
      const tone = coerceEnumValue(EntryAlarmTone, v);
      return tone === undefined ? undefined : setScalar(CONTACT_CMD.ALARM_SOUND_TYPE, tone, ctx, "auto");
    },
  },
  /**
   * `1350` SET_PAYLOAD, `mChannel` = the device channel, `mValue3` 0, payload carrying the channel and a
   * transaction stamp — the byte-shape of the app's own captured frame. Out of range is refused rather
   * than clamped: the app's slider has no values outside it, so one is a caller error, not a nudge.
   *
   * Level-2 only, though the `mValue3` 0 would allow `"auto"`: an entry sensor's session IS its
   * HomeBase's, which always holds a key — the second of `setPayload`'s two conditions, not an oversight
   * of the first.
   */
  alarmVolume: {
    param: CONTACT_CMD.ALARM_VOLUME,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    requires: [CONTACT_CMD.ALARM_VOLUME],
    min: ALARM_VOLUME_MIN,
    max: ALARM_VOLUME_MAX,
    args: [
      {
        name: "level",
        kind: "scalar",
        min: ALARM_VOLUME_MIN,
        max: ALARM_VOLUME_MAX,
        description: "A device level, not a percentage.",
      },
    ],
    description:
      "Entry-sensor alarm volume (1508), a device level 1-26 (NOT a percentage). Write verified live " +
      "on a T90E0 (1350 SET_PAYLOAD {channel,volume,transaction}). See CONTACT_CMD.ALARM_VOLUME.",
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

/**
 * `contact` — entry/door-window sensor. `contact` (1550) and `lastSeen` (1551) are verified; the
 * built-in alarm tone (1507) and volume (1508) are verified writes captured live on a T90E0.
 */
export const CONTACT: CapabilityModule = {
  capability: "contact",
  description: "Entry (door/window) sensor: contact state, last-seen, and the built-in alarm tone/volume.",
  members: CONTACT_MEMBERS,
  properties: propertiesOf(CONTACT_MEMBERS),
  /** A reported entry-sensor contact param (1550) is the verified proof of a contact sensor. */
  detection: { evidenceParams: [1550] },
  /**
   * Inbound `contactState`: the contact param (1550) changing on a cloud poll (open/closed), AND the FCM
   * door-sensor push (`CusPushEvent.DOOR_SENSOR` = 3) — verified live on a T8900 (both fire).
   *
   * Both sources carry the state under a different key, so each normalises to `open`: the poll's `to` is
   * the 1550 param value, and the push's is the wire's single-letter `e`. Polarity for the push is the
   * V6 app's own `CusPushMode.isSensorOpen()`, which is exactly `"1".equals(e)` — anything else,
   * including absent, is closed — read under its `a == PUSH_DOOR_SENSOR_EVT` branch to choose the
   * "sensor is opened" vs "sensor is closed" notification string.
   */
  events: [
    {
      source: "poll",
      match: 1550,
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
   * The contact is a settled state reported by three transports, so one door movement would otherwise
   * be announced up to three times — the station notify, then the same value as an FCM push ~2 s
   * later, then again on the next cloud poll.
   */
  stateEvents: [{ event: "contactState", field: "open" }],
  /**
   * The station's own notify — the fastest contact signal there is, and the only one that needs no
   * cloud at all (see {@link SENSOR_STATUS_CMD} for the measured lead over the push).
   *
   * A declarative `events` row can't express this: those match a push event id or a poll param id,
   * while the state here is nested inside a frame's `params` array under an inner command id. Hence
   * the decode hook, which is the documented escape hatch for exactly that.
   *
   * Emits nothing when the notify carries no contact param, so a status frame reporting only battery
   * or signal strength doesn't fabricate a contact event.
   */
  decodeEvent(signal: InboundSignal): CapabilityEvent | null {
    const raw = statusParam(signal, CONTACT_PARAM);
    if (raw === undefined) return null;
    return { event: "contactState", payload: contactOpen(raw) };
  },
};
