import { enumLabels, isStationSerial, jsonObject } from "../../core/util.js";
import { DeviceType } from "../device-types.js";
import { describeDevice, setJsonRaw, setPayload, setStationScalar } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CapabilityStateReader, CommandContext, InboundSignal } from "./types.js";
import { CusPushAlarmType, CusPushEvent } from "../push-events.js";
import { observeCommand, reflectCommand, type Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";

/** The station broadcast channel the HomeBase's own controls ride (not a device channel). */
const STATION_CHANNEL = 255;

/**
 * The guard modes a house is armed in, and the modes the alarm-delay write (cmd 1255) takes a `mode_id` for.
 * `ArmingMode` is both the const value-object (`ArmingMode.home`) and the union type of its values.
 */
export const ArmingMode = {
  /** Armed — full protection, nobody home (wire value 0). */
  away: "away",
  /** Armed for occupancy — reduced/perimeter protection while home (wire value 1). */
  home: "home",
  /** Disarmed — no alarms; sensors still report state (wire value 63). */
  disarmed: "disarmed",
} as const;
export type ArmingMode = (typeof ArmingMode)[keyof typeof ArmingMode];

/**
 * The P2P **feature-command ids** this arming capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const ARMING_CMD = {
  /**
   * Guard/arming mode (app `GUARD_MODE`), the same id as the read param. Written per station by
   * {@link armingModeCommand}, the `1350` envelope or the direct frame.
   */
  SET_ARMING: 1224,
  /** The station's guard-mode notify: its first int32 is the mode it now holds, which the app lands on 1224. */
  ALARM_MODE: 1151,
  /**
   * One guard mode's per-device action table (app `CMD_SET_ALL_ACTION`), which carries the alarm delays
   * and each device's actions in that mode. A **bare
   * JSON frame, no `1350`/`1700` envelope** — outer P2P cmd IS `1255` itself, station channel 255,
   * plaintext `{account_id, count_down_alarm:{channel_list,delay_time},
   * count_down_arm:{channel_list,delay_time}, devices:[{action,device_channel}], mode_id,
   * siren_sensor_action:[{action,device_channel}]}`.
   *
   * A settings WRITE, not a countdown-state echo: an arm→exit-delay→disarm cycle sends nothing on this
   * cmd, while every edit of the app's "Alarm Delay" screen does.
   *
   * **Why `setAlarmDelayConfig` takes the FULL config, not just a duration**: `channelList` identifies
   * WHICH sensor channels get the delay (45s on one sensor is
   * `channel_list:[<that sensor's channel>], delay_time:45`) — it is not a simple on/off. The
   * corresponding GET command (`1310`/inner cmd `40003`, sent by the app right before editing) replies
   * `{count:0,data:null}` — genuinely empty — so the app does NOT read the current
   * config this way; a T8010 reports it on its own params instead, see below. Without a working GET,
   * safely PATCHING just one channel in or out of an existing list isn't possible without risking
   * clobbering the rest — so
   * this ships as a caller-supplies-everything write instead of guessing a merge.
   * `devices`/`siren_sensor_action` are even less understood (raw per-device action codes, meaning
   * unknown) and MUST come from a value independently read for the target mode —
   * see `AlarmDelayConfig`'s field docs.
   *
   * On a T8010 the app writes the same command for the Device Control screen: header channel 0, the
   * whole table of the mode `{mode_id, devices, count_down_alarm, count_down_arm}`, acked by an all-zero
   * 1255 reply. The T8010 reports each table on its own params, Home on 1157 and Away on 1158, and the
   * reported table follows a write within 15 s. See {@link DEVICE_NOTIFY_FLAG}.
   */
  SET_ALL_ACTION: 1255,
} as const;

/**
 * The push-notification flag of a device's `action` in a mode's table, where `action` is
 * `(mode_id << 24) | flags`. The app's Notification checkbox sets and clears this bit alone, on cameras
 * (9/1) and sensors (8/0) alike; the other flags are not identified and are carried through unchanged.
 */
const DEVICE_NOTIFY_FLAG = 0x08;

/**
 * The guard modes whose device notification is read and written. `custom1` (wire 3) is reported on a
 * standalone camera's own param 1148.
 */
export type DeviceNotificationMode = "home" | "away" | "custom1";

/**
 * The standalone cameras that take their own Device Control write: cmd 1255 to the camera itself with only
 * its own entry `{mode_id, devices:[{device_channel, action}]}`, the new flags reported back after it.
 * A T8400, T8442 and T8410 do not acknowledge it and keep their flags, so they are read only.
 */
const STANDALONE_ACTION_MODELS: ReadonlySet<string> = new Set(["T8170", "T8171"]);

/**
 * The serial prefixes the app counts as platform V2: a guard-mode write to one of them is the `1350`
 * set-payload envelope, to any other device the direct frame (see {@link armingCommand}).
 */
const PLATFORM_V2_PREFIXES = [
  "T8419",
  "T8416",
  "T8417",
  "T8W11",
  "T8124R",
  "T8170",
  "T8171",
  "T8214",
  "T8223",
  "T8224",
  "T8425",
  "T8426",
  "T8531",
  "T85V0",
  "T8600",
  "T86P2",
  "T8134",
  "T8B00",
];

/** Whether the app counts the device as platform V2: its serial prefix, or its device type. */
function isPlatformV2(ctx: CommandContext): boolean {
  return (
    PLATFORM_V2_PREFIXES.some((p) => ctx.serial?.startsWith(p)) ||
    ctx.deviceType === DeviceType.INDOOR_PT_CAMERA_S350 ||
    ctx.deviceType === DeviceType.INDOOR_8W11
  );
}

/** The standalone cameras whose own flags are read: the two above plus the three that stay read only. */
const STANDALONE_READ_MODELS: ReadonlySet<string> = new Set([...STANDALONE_ACTION_MODELS, "T8400", "T8442", "T8410"]);

/**
 * A device's own flags for `mode`, as its params report them: Home on 1225, Away on 1239, custom1 on 1148,
 * plain flags without the `mode_id << 24` the write carries. Every device reports these, standalone or
 * attached; a standalone camera has no table, so they are its only source.
 */
function ownAction(read: CapabilityStateReader, mode: DeviceNotificationMode): number | undefined {
  const value = Number(read(`${mode}Action`)?.value);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** One mode's action table as reported; every field beside `devices` is carried through untouched. */
type ActionTable = Record<string, unknown> & { devices: { device_channel: number; action: number }[] };

/** The reported action table of `mode`, or `undefined` when the station reports none. */
function actionTable(read: CapabilityStateReader, mode: DeviceNotificationMode): ActionTable | undefined {
  const value = read(`${mode}ActionTable`)?.value;
  return value && typeof value === "object" && Array.isArray((value as ActionTable).devices)
    ? (value as ActionTable)
    : undefined;
}

/**
 * Guard-mode name → the `mode_type` integer a station reports on 1224, the V6 app's own names and integers
 * (`SecurityGuardConstants`). The `armingMode` getter's labels; {@link ArmingMode} names the three written.
 */
const ARMING_MODE_WIRE = {
  away: 0,
  home: 1,
  schedule: 2,
  custom1: 3,
  custom2: 4,
  custom3: 5,
  off: 6,
  geo: 47,
  disarmed: 63,
} as const;

/**
 * The `armingMode` PropertySpec's `enumValues` (wire int → label) — derived from
 * `ARMING_MODE_WIRE` instead of hand-listed a second time, so the two can't drift out of sync.
 */
const ARMING_MODE_LABELS: Record<number, string> = enumLabels(ARMING_MODE_WIRE);

/** How long the app waits for the station's answer to a guard-mode write, per device and never resent. */
const ARMING_ANSWER_MS = 6_000;

/**
 * Build the {@link ARMING_CMD.SET_ARMING} write intent, awaited {@link ARMING_ANSWER_MS}. A platform-V2
 * device ({@link isPlatformV2}) takes the `1350` set-payload envelope `{mode_type, user_name}`, `user_name`
 * being `ctx.accountName`, the account's nick name; it throws without one. Any other device takes the
 * direct frame: outer command 1224 itself, body `u32 LE mode_type ‖ admin account id zero-padded to 128
 * bytes`, on the station broadcast channel 255 for a station serial, else on the device's own channel. A write
 * answered with success lands the mode on 1224 and announces `armingModeChanged`, as the app applies it locally.
 * @internal
 */
export function armingModeCommand(mode: ArmingMode, ctx: CommandContext): Command {
  const value = ARMING_MODE_WIRE[mode];
  if (!isPlatformV2(ctx)) {
    const channel = isStationSerial(ctx.serial ?? "") ? STATION_CHANNEL : ctx.channel;
    return applied(setStationScalar(ARMING_CMD.SET_ARMING, value, channel, ARMING_ANSWER_MS), value);
  }
  if (!ctx.accountName) {
    throw new Error(`arming: missing account identity (user_name) [${describeDevice(ctx)}]`);
  }
  const payload = { mode_type: value, user_name: ctx.accountName };
  return applied(setPayload(ARMING_CMD.SET_ARMING, payload, ctx, 0, undefined, ARMING_ANSWER_MS), value);
}

/** The event a moved 1224 announces, on a write's answer or the station's notify. */
const MODE_CHANGED = "armingModeChanged";

/** `cmd` with the mode it leaves on 1224 and the event a moved mode announces. */
function applied(cmd: Command, value: number): Command {
  return observeCommand(reflectCommand(cmd, { param: ARMING_CMD.SET_ARMING, raw: String(value) }), {
    event: MODE_CHANGED,
  });
}

/**
 * The serial prefixes the app never arms with its house: SmartDrop, locks other than the T8531 and T85V0, the
 * T8021, safes, trackers and chimes.
 */
const UNARMED_PREFIXES = [
  "T8790",
  "T8510",
  "T8520",
  "T8500",
  "T8501",
  "T8503",
  "T8502",
  "T8504",
  "T8530",
  "T8506",
  "T85L0",
  "T85D0",
  "T85D2",
  "T85F0",
  "T85F1",
  "T85P0",
  "T85P1",
  "T8021",
  "T7400",
  "T7401",
  "T7402",
  "T87B0",
  "T87B1",
  "T87B2",
  "T87B4",
  "T87B5",
  "T8740",
  "T8028",
  "T8026",
];

/**
 * Whether the app arms `device` with its house when the house's config names no station: a station or a
 * device that is its own, of the `eufy_security` category, not shared to this account as a guest
 * (`memberType` 0), and not one of the {@link UNARMED_PREFIXES}. @internal
 */
export function armedWithHouse(device: Pick<EufyDevice, "sn" | "stationSn" | "category" | "memberType">): boolean {
  return (
    (isStationSerial(device.sn) || device.stationSn === device.sn) &&
    device.category === "eufy_security" &&
    device.memberType !== 0 &&
    !UNARMED_PREFIXES.some((p) => device.sn.startsWith(p))
  );
}

/** The `arm_status` the house's cloud config takes for each {@link ArmingMode}. @internal */
export const HOUSE_ARM_STATUS: Record<ArmingMode, number> = { home: 1, away: 2, disarmed: 3 };

/**
 * A station's guard mode `wire` as its `armingMode` label, and that mode's arm delay in seconds as the app reads
 * it for the house result: param 1171 (home) or 1172 (away), else 0; on a T9000 the `count_down_arm.delay_time`
 * of its `arming_get_alarm_away_mode` property for away, `arming_get_alarm_home_mode` for any other. @internal
 */
export function houseArmingState(
  wire: number,
  sn: string,
  raw: (param: number) => string | undefined,
  thing: (identifier: string) => string | undefined,
): { mode: string; armDelay: number } {
  const delay = sn.startsWith("T9000")
    ? (
        jsonObject(thing(`arming_get_alarm_${wire === 0 ? "away" : "home"}_mode`))?.count_down_arm as
          Record<string, unknown> | undefined
      )?.delay_time
    : wire === 1 || wire === 0
      ? raw(wire === 1 ? 1171 : 1172)
      : undefined;
  const armDelay = Number.parseInt(String(delay), 10);
  return { mode: ARMING_MODE_LABELS[wire] ?? String(wire), armDelay: Number.isNaN(armDelay) ? 0 : armDelay };
}

/**
 * Alarm-delay durations the app's OWN picker UI offers — `AlarmDelaySeconds` is both the const
 * value-object (`AlarmDelaySeconds.sec45`) and the union type of its values, so callers pass the
 * named constant: `{delaySeconds: AlarmDelaySeconds.sec45}`.
 *
 * **NOT a wire constraint** — the device itself does NOT validate against this list: `50` (off this
 * list) is accepted. Typed as a closed set anyway
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
  /** Raw per-device action code. Meaning unknown — pass through verbatim from a
   * value read for this exact mode, never invented. */
  action: number;
};

/**
 * The FULL per-mode alarm/arm-delay configuration the device accepts as one write — see the
 * `setAlarmDelayConfig` doc for why this is a caller-supplies-everything shape rather than a simple
 * `setEntryDelay(seconds)` toggle.
 */
export type AlarmDelayConfig = {
  /** Per-sensor ENTRY/alarm delay — the app's "Alarm Delay" UI setting. A delay
   * set on one sensor lands as that sensor's channel plus the chosen duration. */
  countDownAlarm: AlarmDelayCountdown;
  /** A second, distinct countdown carried alongside `countDownAlarm`. It stays empty across a
   * `countDownAlarm` edit; its own trigger condition is unknown. */
  countDownArm: AlarmDelayCountdown;
  /** Every device's participation + action for THIS mode. Unknown semantics (the action code's
   * meaning is unknown) — it is unchanged by a `countDownAlarm`-only edit within the same
   * mode, so pass through exactly what was read back for that mode; never invent a value. */
  devices: AlarmDelayDeviceAction[];
  /** Siren behavior per device for this mode. Same caveat as `devices`. */
  sirenSensorAction: AlarmDelayDeviceAction[];
};

/**
 * Build the alarm-delay `cmd 1255` write intent. Bare JSON, no envelope (`setJsonRaw`) — see
 * the full config. Pinned to the station broadcast channel (255), NOT
 * `ctx.channel` (which resolves to 0 for a station context) — the frame rides channel
 * 255 explicitly, same as every other station-scoped bare/scalar write in the router.
 */
function alarmDelayCommand(mode: ArmingMode, config: AlarmDelayConfig, ctx: CommandContext): Command {
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
  return setJsonRaw(ARMING_CMD.SET_ALL_ACTION, data, ctx, STATION_CHANNEL);
}

/**
 * A standalone camera's one-entry table for `mode`, built from its own reported flags: what the app sends it.
 * `undefined` where the camera reports none for that mode.
 */
function ownTable(read: CapabilityStateReader, mode: DeviceNotificationMode, channel: number): ActionTable | undefined {
  const flags = ownAction(read, mode);
  if (flags === undefined) return undefined;
  const wire = ARMING_MODE_WIRE[mode];
  return { mode_id: wire, devices: [{ device_channel: channel, action: (wire << 24) | flags }] };
}

/** How long a reported action table may lag a write before it is trusted again: it follows within 15 s. */
const ACTION_TABLE_LAG_MS = 15_000;

/**
 * One device's notification flag in `table` changed, or `undefined` when `table` does not list `channel`,
 * since only the table states the entry's other flags. `account_id` is dropped: the sink injects the
 * acting account's.
 */
function withDeviceNotification(table: ActionTable | undefined, channel: number, on: boolean): ActionTable | undefined {
  if (!table?.devices.some((d) => d.device_channel === channel)) return undefined;
  const { account_id: _account, ...rest } = table;
  const devices = table.devices.map((d) =>
    d.device_channel === channel
      ? { ...d, action: on ? d.action | DEVICE_NOTIFY_FLAG : d.action & ~DEVICE_NOTIFY_FLAG }
      : d,
  );
  return { ...rest, devices };
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
 * Exported but NOT published: each entry states its wire id and its gate,
 * which the reference site does not carry.
 * @internal
 */
export const ARMING_MEMBERS = {
  /**
   * The guard mode the station reports on 1224, one of the nine {@link ARMING_MODE_WIRE} labels. Read only:
   * a mode is written for a whole house, by `setHouseMode`. Claims `arming_selected_mode`, which the
   * products' bundles read from 1224, so nothing writes it per device.
   */
  mode: {
    param: ARMING_CMD.SET_ARMING,
    property: "armingMode",
    type: "enum",
    kind: "enum",
    enumValues: ARMING_MODE_LABELS,
    thing: ["arming_selected_mode"],
    observation: { event: MODE_CHANGED, reflects: () => undefined },
    description: "Guard mode (param 1224 = GUARD_MODE): away/home/schedule/custom1/custom2/custom3/off/geo/disarmed.",
  },

  /**
   * Write the FULL per-mode alarm/arm-delay configuration. The device accepts the whole config as one
   * write, not a single duration field, so a partial update is not possible. An expert/advanced API: the
   * caller is responsible for supplying `devices`/`sirenSensorAction` (and the `countDownAlarm`/
   * `countDownArm` entries they are NOT changing) from a value they have independently read for
   * this mode — there is no known GET to fetch it automatically, and a wrong guess here can silently
   * misconfigure which sensors arm/trigger for real.
   *
   * Takes an {@link ArmingMode}: the frame carries its integer in `mode_id` with no runtime validation and
   * no readback.
   */
  setAlarmDelayConfig: method(
    ({ ctx, sink }) =>
      (mode: ArmingMode, config: AlarmDelayConfig): Promise<void> => {
        try {
          return sink.dispatch(alarmDelayCommand(mode, config, ctx));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    "Write the full per-mode alarm/arm-delay configuration.",
  ),

  /**
   * Whether the device on `channel` sends a push notification in `mode`: its {@link DEVICE_NOTIFY_FLAG}
   * in the action table the station reports for that mode. `undefined` where the station reports no table
   * or the table does not list `channel`. A standalone camera answers from its own 1225/1239/1148 flags,
   * for its own channel only. A device's channel is `EufyDevice.channel`.
   */
  deviceNotification: method(
    ({ ctx, read }) =>
      (mode: DeviceNotificationMode, channel: number): boolean | undefined => {
        const action =
          ctx.model === "T8010"
            ? actionTable(read, mode)?.devices.find((d) => d.device_channel === channel)?.action
            : channel === ctx.channel
              ? ownAction(read, mode)
              : undefined;
        return typeof action === "number" ? (action & DEVICE_NOTIFY_FLAG) !== 0 : undefined;
      },
    "Whether the device on a channel sends a push notification in a guard mode (home/away/custom1).",
    (ctx) => ctx.model === "T8010" || STANDALONE_READ_MODELS.has(ctx.model ?? ""),
  ),

  /**
   * Turn the push notification of the device on `channel` on or off in `mode` (cmd
   * {@link ARMING_CMD.SET_ALL_ACTION}): the station's reported table written back with that one flag
   * changed. A standalone camera is sent a one-entry `{mode_id, devices}` table built from its own flags,
   * for its own channel only. Rejects, sending nothing, where the table does not list `channel`. A write
   * builds on the last one sent for that mode until the device reports a table (`${mode}Action` on a
   * standalone camera) 15 s after it, so a second write does not revert it; a write whose dispatch
   * rejects is not built on.
   */
  setDeviceNotification: method(
    ({ ctx, sink, read }) => {
      const sent = new Map<DeviceNotificationMode, { table: ActionTable; at: number }>();
      return (mode: DeviceNotificationMode, channel: number, on: boolean): Promise<void> => {
        const last = sent.get(mode);
        const reported = ctx.model === "T8010" ? `${mode}ActionTable` : `${mode}Action`;
        const observed = read(reported)?.ts ?? 0;
        const base =
          last && observed < last.at + ACTION_TABLE_LAG_MS
            ? last.table
            : ctx.model === "T8010"
              ? actionTable(read, mode)
              : ownTable(read, mode, ctx.channel);
        const table = withDeviceNotification(base, channel, on);
        if (!table) {
          return Promise.reject(
            new Error(`arming: no ${mode} action table lists channel ${channel} [${describeDevice(ctx)}]`),
          );
        }
        sent.set(mode, { table, at: Date.now() });
        return sink.dispatch(setJsonRaw(ARMING_CMD.SET_ALL_ACTION, table, ctx, 0)).catch((err: unknown) => {
          if (sent.get(mode)?.table === table) {
            if (last) sent.set(mode, last);
            else sent.delete(mode);
          }
          throw err;
        });
      };
    },
    "Turn the push notification of the device on a channel on or off in a guard mode (home/away/custom1).",
    (ctx) => ctx.model === "T8010" || STANDALONE_ACTION_MODELS.has(ctx.model ?? ""),
  ),
} as const satisfies Members;

/** `"stopped"` when the push's `type` is a stop code, otherwise `"triggered"`. */
function decodeAlarmPhase(signal: InboundSignal): Record<string, unknown> {
  const type = signal.source === "push" ? signal.payload?.["type"] : undefined;
  return type === CusPushAlarmType.HUB_STOP_BY_APP ? { phase: "stopped" } : {};
}

/**
 * `arming` — guard/arming mode. `armingMode` (see {@link ARMING_CMD.SET_ARMING}) reads the station's mode;
 * a house's stations are armed together, see {@link armingModeCommand}.
 */
export const ARMING: CapabilityModule = {
  capability: "arming",
  description: "Station/device guard (arming) mode.",
  members: ARMING_MEMBERS,
  properties: propertiesOf(ARMING_MEMBERS),
  // A reported guard-mode param is the proof; every station-codec device also owns an
  // arming surface as part of its baseline.
  detection: { evidenceParams: [ARMING_CMD.SET_ARMING], codecs: ["station"] },
  ownedByStation: true,
  emits: [MODE_CHANGED],
  /**
   * Station-scoped push events. The hub reports the alarm lifecycle on the generic `CusPushEvent`
   * channel, so these ids are shared with other families and resolve by capability (see the barrel's
   * event index).
   *
   * The alarm ids carry a `phase` so one event name covers the whole lifecycle: the countdown push a
   * static `"delayed"`, the alarm push a `"triggered"` or `"stopped"` read from its alarm type (see
   * {@link decodeAlarmPhase}). The mode-switch push changes no state in the app, which only refreshes its
   * view from what it holds; `armingModeChanged` announces 1224 moving, on a write's answer or on the
   * station's {@link ARMING_CMD.ALARM_MODE} notify.
   */
  events: [
    {
      source: "push",
      match: CusPushEvent.ALARM,
      emit: "alarm",
      payload: { phase: "triggered" },
      derive: decodeAlarmPhase,
    },
    { source: "push", match: CusPushEvent.ALARM_DELAY, emit: "alarm", payload: { phase: "delayed" } },
  ],
  /** The station's {@link ARMING_CMD.ALARM_MODE} notify, landed on 1224 as the app does. */
  decodeState(signal) {
    if (signal.source !== "p2p-frame" || signal.commandId !== ARMING_CMD.ALARM_MODE) return null;
    if (!signal.data || signal.data.length < 4) return null;
    return { params: { [ARMING_CMD.SET_ARMING]: String(signal.data.readInt32LE(0)) } };
  },
};
