import { enumLabels } from "../../core/util.js";
import { describeDevice, setJsonRaw, setPayload } from "./access.js";
import { accepts, method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";
import { CusPushEvent } from "../push-events.js";
import type { Command } from "../../core/contracts.js";

/** The station broadcast channel the HomeBase's own controls ride (not a device channel). */
const STATION_CHANNEL = 255;

/**
 * The guard modes `setMode` can SET — every mode a station reports, all nine confirmed against real
 * hardware. `ArmingMode` is both the const value-object (`ArmingMode.home`) and the union type of its
 * values, so callers pass the named constant: `setMode(ArmingMode.home)`.
 *
 * The domain of `setMode` (cmd 1224) alone. The alarm-delay write (cmd 1255) carries its own mode integer
 * on a separate wire and takes {@link AlarmDelayMode}, which stays NARROWER — evidence for one command is
 * not evidence for the other, and 1255 still has no capture beyond its byte-captured three.
 *
 * A mode belongs here only once its write is confirmed against real hardware, because a fire-and-forget
 * wire makes a wrong mode look exactly like success; `ARMING_MODE_WIRE` carries the per-value evidence.
 * The union is also what `ARMING_MODE_WIRE` is keyed by, so the table cannot name a mode this does not.
 */
export const ArmingMode = {
  /** Armed — full protection, nobody home (wire value 0). */
  away: "away",
  /** Armed for occupancy — reduced/perimeter protection while home (wire value 1). */
  home: "home",
  /** Scheduled — the station follows the timetable configured in the app (wire value 2). */
  schedule: "schedule",
  /** Custom 1 — a user-defined posture configured in the app (wire value 3). */
  custom1: "custom1",
  /** Custom 2 — a user-defined posture configured in the app (wire value 4). */
  custom2: "custom2",
  /** Custom 3 — a user-defined posture configured in the app (wire value 5). */
  custom3: "custom3",
  /** Off — the station's alarm system is switched off entirely (wire value 6). */
  off: "off",
  /** Geofenced — the station follows the app's location-based rules (wire value 47). */
  geo: "geo",
  /** Disarmed — no alarms; sensors still report state (wire value 63). */
  disarmed: "disarmed",
} as const;
export type ArmingMode = (typeof ArmingMode)[keyof typeof ArmingMode];

/**
 * The modes the alarm-delay write (cmd 1255) accepts a `mode_id` for — the three guard modes whose wire
 * integer is byte-captured.
 *
 * A domain of its own, because the two mode integers ride different commands: `setMode` writes `mode_type`
 * on cmd 1224, and cmd 1255 carries `mode_id`. Neither wire validates the integer, so each union IS its
 * command's gate, and evidence for one is not evidence for the other. `custom1` is confirmed on 1224 only;
 * 1255 has no capture carrying mode 3, and no known GET to read one back — the app's own replies
 * `{count:0,data:null}` — so it is absent here. Narrower than {@link ArmingMode} by exactly that value.
 */
export const AlarmDelayMode = {
  /** Armed — full protection, nobody home (wire value 0). */
  away: "away",
  /** Armed for occupancy — reduced/perimeter protection while home (wire value 1). */
  home: "home",
  /** Disarmed — no alarms; sensors still report state (wire value 63). */
  disarmed: "disarmed",
} as const;
export type AlarmDelayMode = (typeof AlarmDelayMode)[keyof typeof AlarmDelayMode];

/**
 * The P2P **feature-command ids** this arming capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const ARMING_CMD = {
  /**
   * Guard/arming mode (app `GUARD_MODE`). ✅ Wire ENVELOPE verified live on a T8030 (
   * 2026-07-23), cycling Away→Disarmed→Home in the
   * real app: `1350` SET_PAYLOAD, cmd 1224 (SAME id as the read param), mChannel 0, explicit
   * mValue3:0, `payload:{mode_type:<int>, user_name:<string>}`.
   *
   * ⚠️ Only 3 of the 9 modes were exercised in that capture — `mode_type` 0 (away), 63 (disarmed), 1
   * (home), all confirmed byte-exact. Re-confirmed live 2026-08-05: each reported its own MODE_SWITCH push
   * within ~5s of the write. The remaining six are live confirmations rather than captures — `custom1` 3
   * first, then `schedule` 2, `custom2` 4, `custom3` 5, `off` 6 and `geo` 47 — each sent as this exact
   * frame and each observed to bring MODE_SWITCH back, so all nine are settable. `ARMING_MODE_WIRE` has
   * the per-value evidence and the dates.
   *
   * The ENCRYPTION LEVEL is the session's to pick (`"auto"`), not this command's: the T8030 the envelope
   * was captured on holds a level-2 key and seals it level-2, while an own-session camera that never
   * negotiates one carries the same envelope level-1. See `armingCommand`.
   */
  SET_ARMING: 1224,
  /**
   * The per-mode alarm/arm-delay configuration write. ✅ WIRE CAPTURED live on a T8030 (
   * 2026-07-23, both directions): a **bare
   * JSON frame, no `1350`/`1700` envelope** — outer P2P cmd IS `1255` itself, station channel 255,
   * plaintext `{account_id, count_down_alarm:{channel_list,delay_time},
   * count_down_arm:{channel_list,delay_time}, devices:[{action,device_channel}], mode_id,
   * siren_sensor_action:[{action,device_channel}]}`.
   *
   * **Disambiguated from a live-countdown-state echo** (2026-07-23): a full arm→wait-through-exit-
   * delay→disarm cycle produced ZERO traffic on this cmd, while every edit of the app's "Alarm Delay"
   * screen did — so this is a genuine settings WRITE, not a realtime push.
   *
   * **Why `setAlarmDelayConfig` takes the FULL config, not just a duration**: `channelList` identifies
   * WHICH sensor channels get the delay (confirmed: setting 45s on one specific sensor produced
   * `channel_list:[<that sensor's channel>], delay_time:45`) — it is not a simple on/off. The
   * corresponding GET command (`1310`/inner cmd `40003`, sent by the app right before editing) always
   * replied `{count:0,data:null}` in every capture — genuinely empty, not a decrypt failure (confirmed
   * via the same bidirectional decrypt this finding used) — so the app does NOT read the current
   * config this way; how it does is still unknown. Without a working GET, safely PATCHING just one
   * channel in or out of an existing list isn't possible without risking clobbering the rest — so
   * this ships as a caller-supplies-everything write instead of guessing a merge.
   * `devices`/`siren_sensor_action` are even less understood (raw per-device action codes, meaning
   * unconfirmed) and MUST come from a value independently read/captured for the target mode —
   * see `AlarmDelayConfig`'s field docs.
   */
  ALARM_DELAY_CONFIG: 1255,
} as const;

/**
 * Guard-mode name → the wire's `mode_type` integer, for every mode a station may REPORT. Fixed (not
 * model-dependent) — the single source of truth {@link ARMING_MODE_LABELS} (the `armingMode`
 * PropertySpec's `enumValues`) derives from.
 *
 * Read and write are the same nine as of the confirmations below, so this table is the whole domain in
 * both directions — {@link SETTABLE_MODES} and {@link ARMING_MODE_LABELS} are both derived from it rather
 * than listed again. {@link AlarmDelayMode}, the domain cmd 1255 takes, is a SEPARATE decision on a
 * separate wire and stays at its byte-captured three: never widen it because `setMode` gained a mode.
 *
 * **The names and integers are the V6 app's own** (`SecurityGuardConstants`, mirrored by `GuardConstant`),
 * so the mapping is APK ground truth rather than a borrowed label. Provenance for a NAME was never
 * authority for a WRITE, which is why the write side was confirmed value by value:
 *
 * ✅ WIRE-CAPTURED (byte-exact, a T8030 2026-07-23; all three re-confirmed live 2026-08-05, each reporting
 * its own MODE_SWITCH push within ~5s): `away` 0, `home` 1, `disarmed` 63.
 * ✅ CONFIRMED LIVE, not byte-captured (a T8030 2026-09-12): `custom1` 3 — accepted and reporting its own
 * MODE_SWITCH push within the convergence window on each of two writes, cycling custom1→home→custom1.
 * ✅ CONFIRMED LIVE, not byte-captured (2026-09-13): `schedule` 2, `custom2` 4, `custom3` 5, `off` 6,
 * `geo` 47 — the five that had no capture behind them, each sent as exactly this frame and each observed
 * to bring MODE_SWITCH back. That observation is the evidence rather than an inference from it: the client
 * emits `armingModeChanged` only once its own bounded readback has CONVERGED on the mode asked for, so a
 * station that ignored the write would have produced silence instead.
 *
 * A live confirmation is the same frame `setMode` builds, differing only in `mode_type` — so what it
 * establishes is that this command carries that integer, not that some other command exists.
 */
const ARMING_MODE_WIRE: Record<ArmingMode, number> = {
  away: 0,
  home: 1,
  schedule: 2,
  custom1: 3,
  custom2: 4,
  custom3: 5,
  off: 6,
  geo: 47,
  disarmed: 63,
};

/**
 * The `armingMode` PropertySpec's `enumValues` (wire int → label) — derived from
 * `ARMING_MODE_WIRE` instead of hand-listed a second time, so the two can't drift out of sync.
 */
const ARMING_MODE_LABELS: Record<number, string> = enumLabels(ARMING_MODE_WIRE);

/**
 * The SETTABLE mode a caller named, from EITHER vocabulary: the name (`"away"`) or the wire integer the
 * `mode` getter answers (`0`). A mode the station can report but not accept resolves to nothing, and the
 * derived setter refuses it.
 *
 * The getter's value has to be settable back. Matching names alone made `setMode(dev.arming().mode)`
 * refuse every time, with a generated message that listed as valid exactly the integer it had just
 * rejected — the getter publishes {@link ARMING_MODE_LABELS}, keyed by wire value, as its own domain.
 */
function armingModeOf(v: boolean | number | string): ArmingMode | undefined {
  const name = String(v);
  if (name in ArmingMode) return name as ArmingMode;
  const wire = Number(v);
  return (Object.values(ArmingMode) as ArmingMode[]).find((m) => ARMING_MODE_WIRE[m] === wire);
}

/**
 * Build the {@link ARMING_CMD.SET_ARMING} write intent, or throw if the context has no account
 * identity. `user_name` — the real app's own capture showed a MASKED value (`"max***"`, presumably
 * the app's own privacy-display truncation of the account's email local-part), not the unmasked
 * acting name `ctx.accountName` carries. Untested whether the device validates this field strictly;
 * sending the acting name as it stands is the more correct choice regardless — it's almost certainly
 * just attribution (e.g. "who armed the system" in event history), not a value the device checks
 * against anything.
 *
 * `"auto"` on both counts `setPayload` names: `mValue3` is passed 0 explicitly, so both seals carry the
 * byte-identical JSON the T8030 capture recorded; and every device carrying `arming` is its own station
 * or a HomeBase, the former being exactly the case that may hold no key. A T8410's session is level-1 —
 * the same fact `access.ts` records beside camera power 1035, verified live on that model — so pinned
 * level-2 made the one control a standalone camera most needs the one it could not be sent.
 */
function armingCommand(mode: ArmingMode, ctx: CommandContext): Command {
  if (!ctx.accountName) {
    throw new Error(`arming: missing account identity (user_name) [${describeDevice(ctx)}]`);
  }
  return setPayload(
    ARMING_CMD.SET_ARMING,
    { mode_type: ARMING_MODE_WIRE[mode], user_name: ctx.accountName },
    ctx,
    0,
    undefined,
    "auto",
  );
}

/**
 * Alarm-delay durations the app's OWN picker UI offers — `AlarmDelaySeconds` is both the const
 * value-object (`AlarmDelaySeconds.sec45`) and the union type of its values, so callers pass the
 * named constant: `{delaySeconds: AlarmDelaySeconds.sec45}`.
 *
 * **NOT a wire constraint** — the device itself does NOT validate against this list: a live test sent
 * `50` (off this list) and the app reflected it correctly, no rejection. Typed as a closed set anyway
 * so `setAlarmDelayConfig` callers get the same choices a human editing the same setting in the app
 * would see, rather than an arbitrary int that could silently diverge from every value the real UI
 * can actually produce.
 */
export const AlarmDelaySeconds = {
  off: 0,
  sec15: 15,
  sec30: 30,
  sec45: 45,
  sec60: 60,
  min3: 180,
  min5: 300,
} as const;
export type AlarmDelaySeconds = (typeof AlarmDelaySeconds)[keyof typeof AlarmDelaySeconds];

/** One `channelList`+`delaySeconds` countdown pair — see {@link AlarmDelayConfig}. */
export type AlarmDelayCountdown = {
  /** Device channels this countdown applies to. */
  channelList: number[];
  /** Delay duration — one of {@link AlarmDelaySeconds}, shared across every channel in `channelList`. */
  delaySeconds: AlarmDelaySeconds;
};

/** One device's participation entry in {@link AlarmDelayConfig.devices} / `.sirenSensorAction`. */
export type AlarmDelayDeviceAction = {
  deviceChannel: number;
  /** Raw per-device action code. Meaning NOT independently confirmed — pass through verbatim from a
   * value read/captured for this exact mode, never invented. */
  action: number;
};

/**
 * The FULL per-mode alarm/arm-delay configuration the device accepts as one write — see the
 * `setAlarmDelayConfig` doc for why this is a caller-supplies-everything shape rather than a simple
 * `setEntryDelay(seconds)` toggle.
 */
export type AlarmDelayConfig = {
  /** Per-sensor ENTRY/alarm delay — the app's "Alarm Delay" UI setting. Confirmed on-device: a delay
   * set on one sensor lands as that sensor's channel plus the chosen duration. */
  countDownAlarm: AlarmDelayCountdown;
  /** A second, distinct countdown carried alongside `countDownAlarm`. It stayed empty across every
   * observed `countDownAlarm` edit, so its own trigger condition is UNCONFIRMED. */
  countDownArm: AlarmDelayCountdown;
  /** Every device's participation + action for THIS mode. UNCONFIRMED semantics (the action code's
   * meaning is unknown) — it stayed identical across every `countDownAlarm`-only edit within the same
   * mode, so pass through exactly what was read back for that mode; never invent a value. */
  devices: AlarmDelayDeviceAction[];
  /** Siren behavior per device for this mode. Same caveat as `devices`. */
  sirenSensorAction: AlarmDelayDeviceAction[];
};

/**
 * Build the alarm-delay `cmd 1255` write intent. Bare JSON, no envelope (`setJsonRaw`) — see
 * the full config. Pinned to the station broadcast channel (255), NOT
 * `ctx.channel` (which resolves to 0 for a station context) — the capture put this frame on channel
 * 255 explicitly, same as every other station-scoped bare/scalar write in the router.
 *
 * Throws if `mode` is not an {@link AlarmDelayMode}.
 */
function alarmDelayCommand(mode: AlarmDelayMode, config: AlarmDelayConfig, ctx: CommandContext): Command {
  if (!Object.values(AlarmDelayMode).includes(mode)) {
    throw new Error(
      `setAlarmDelayConfig: ${JSON.stringify(mode)} is not a valid value ` +
        `(must be one of ${Object.values(AlarmDelayMode).join("/")})`,
    );
  }
  const data = {
    mode_id: ARMING_MODE_WIRE[mode],
    count_down_alarm: {
      channel_list: config.countDownAlarm.channelList,
      delay_time: config.countDownAlarm.delaySeconds,
    },
    count_down_arm: { channel_list: config.countDownArm.channelList, delay_time: config.countDownArm.delaySeconds },
    devices: config.devices.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
    siren_sensor_action: config.sirenSensorAction.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
  };
  return setJsonRaw(ARMING_CMD.ALARM_DELAY_CONFIG, data, ctx, STATION_CHANNEL);
}

/**
 * Bound guard-mode controls — the object returned by `dev.arming()`.
 *
 * Everything is DERIVED from `ARMING_MEMBERS`. `setMode` is the mode member's own derived setter;
 * `setAlarmDelayConfig` is a `method` because it takes TWO arguments (a mode and a whole config),
 * which no value setter can express.
 */
export type ArmingActions = Surface<typeof ARMING_MEMBERS>;

/**
 * Every `arming` feature, declared once.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const ARMING_MEMBERS = {
  /**
   * Read and write are the same nine modes, so `enumValues` is the whole domain: `writeDomain` falls back
   * to it, and the derived setter, the refusal message and the offered argument all read from that one
   * declaration. A member states an `args` entry only where the two sides DIFFER. See
   * {@link ARMING_MODE_WIRE} for the per-value evidence.
   *
   * `armingCommand` may also throw synchronously (missing account identity) and `bindMembers` turns that
   * into a rejection, so the builder stays plain.
   *
   * The setter takes either vocabulary — see `armingModeOf` — because the getter answers the wire integer,
   * and a value a caller just read has to be one it can write back.
   *
   * MODE_SWITCH carries no value. Live qualification on a standalone camera showed that authoritative
   * readback requires a bounded cloud-list refresh, and that its P2P session must be reset after
   * convergence before a following mode write; an attached device must never reset its shared HomeBase.
   */
  mode: {
    param: ARMING_CMD.SET_ARMING,
    property: "armingMode",
    type: "enum",
    kind: "enum",
    enumValues: ARMING_MODE_LABELS,
    provenance: "verified",
    description:
      "Guard mode (verified: param 1224 = GUARD_MODE, read/write mechanism confirmed). Reads and SETS all " +
      "9 modes the app defines — away/home/schedule/custom1/custom2/custom3/off/geo/disarmed. Three are " +
      "byte-captured writes and six are live-confirmed (each sent and observed to report its own " +
      "MODE_SWITCH); see ARMING_MODE_WIRE in arming.ts for the per-value evidence.",
    observation: {
      event: "armingModeChanged",
      reflects: (value) => ({ param: ARMING_CMD.SET_ARMING, expected: ARMING_MODE_WIRE[armingModeOf(value)!] }),
      resetStandaloneSession: true,
      timeoutMs: 20_000,
    },
    write: (v, ctx) => {
      const mode = armingModeOf(v);
      return mode ? armingCommand(mode, ctx) : undefined;
    },
    ...accepts<ArmingMode>(),
  },

  /**
   * Write the FULL per-mode alarm/arm-delay configuration. The device accepts the whole config as one
   * write, not a single duration field, so a partial update is not possible. An expert/advanced API: the
   * caller is responsible for supplying `devices`/`sirenSensorAction` (and the `countDownAlarm`/
   * `countDownArm` entries they are NOT changing) from a value they have independently read/captured for
   * this mode — there is no known GET to fetch it automatically, and a wrong guess here can silently
   * misconfigure which sensors arm/trigger for real.
   *
   * Takes {@link AlarmDelayMode}, not {@link ArmingMode}: a delay is configurable only for a mode whose
   * integer is captured on THIS command, and `custom1` is confirmed on cmd 1224 only. The frame carries
   * that integer in `mode_id` with no readback, so a mode outside this union would be the same unverified
   * guess `setMode` refuses, and `alarmDelayCommand` refuses it at runtime.
   */
  setAlarmDelayConfig: method(
    ({ ctx, sink }) =>
      (mode: AlarmDelayMode, config: AlarmDelayConfig): Promise<void> => {
        try {
          return sink.dispatch(alarmDelayCommand(mode, config, ctx));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    "Write the full per-mode alarm/arm-delay configuration.",
  ),
} as const satisfies Members;

/**
 * `arming` — guard/arming mode. `armingMode` (see {@link ARMING_CMD.SET_ARMING}) has a verified read/write
 * MECHANISM, and all 9 modes it reports are now confirmed as writes — the {@link ArmingMode} union is the
 * whole set. See `ARMING_MODE_WIRE` for which three are byte-captured and which six are live-confirmed.
 * The alarm-delay write (cmd 1255) is unaffected and keeps its narrower {@link AlarmDelayMode}.
 */
export const ARMING: CapabilityModule = {
  capability: "arming",
  description: "Station/device guard (arming) mode.",
  members: ARMING_MEMBERS,
  properties: propertiesOf(ARMING_MEMBERS),
  // A reported guard-mode param is the verified proof; every station-codec device also owns an
  // arming surface as part of its baseline.
  detection: { evidenceParams: [ARMING_CMD.SET_ARMING], codecs: ["station"] },
  ownedByStation: true,
  /**
   * Station-scoped push events. The hub reports a guard-mode switch and the alarm lifecycle on the
   * generic `CusPushEvent` channel, so these ids are shared with other families and resolve by
   * capability (see the barrel's event index).
   *
   * The alarm ids carry a static `phase` so one event name covers the whole lifecycle, the same shape
   * `battery` uses for its threshold pushes. The mode-switch push is known to identify WHICH mode and
   * what triggered the change, but neither has been observed on the wire here, so this emits the bare
   * transition and refreshes the `mode` read rather than trusting a decoded field.
   */
  events: [
    {
      source: "push",
      match: CusPushEvent.MODE_SWITCH,
      emit: "armingModeChanged",
      refresh: { member: "mode" },
    },
    { source: "push", match: CusPushEvent.ALARM, emit: "alarm", payload: { phase: "triggered" } },
    { source: "push", match: CusPushEvent.ALARM_DELAY, emit: "alarm", payload: { phase: "delayed" } },
  ],
};
