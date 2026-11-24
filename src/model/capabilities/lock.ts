import {
  isBluetoothLock,
  isClassicWifiLock,
  isSmartDrop,
  isVideoSmartLock,
  settingsOverMqttWhenStandalone,
} from "../device-family.js";
import { u16le } from "../../core/util.js";
import { LockPushEvent } from "../push-events.js";
import { describeDevice } from "./access.js";
import { thingWrite } from "./bundle.js";
import { method, propertiesOf, provided, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext, InboundSignal } from "./types.js";
import type { Command, CommandSink, AutoLockSnapshot, MediaProvider } from "../../core/contracts.js";

/**
 * Bound lock controls — the object returned by `dev.lock()`.
 *
 * Everything is DERIVED from `LOCK_MEMBERS`. `lock`/`unlock` drive every lock-family actuator over the
 * wire its family takes: the shared `ff09` frame on the T8531 video smart lock and the T85D0 garage door,
 * the T8530 video lock's own `set-payload`, the keyed-payload envelope on the classic Wi-Fi lock (the
 * `T8520`-range unit that never negotiates a session key), and the station's door-lock pass-through on the
 * Bluetooth lock. This module emits ONE transport-neutral intent per
 * wire (identity fields only, no wire bytes, no cipher, no routing key) and names no transport: the command
 * sink routes P2P vs MQTT by the device's topology, and the chosen transport's command router builds the
 * frame + envelope and re-resolves its own routing tail.
 * Which pipe it is does not reach `dev.lock()` — its surface is identical either way, the same way
 * P2P-vs-cloud is hidden for live media.
 *
 * Classic Wi-Fi lock: it answers every command with a result code (0 = done), so on it the two reject on a refusal or an unanswered command as well as on missing identity.
 */
export type LockActions = Surface<typeof LOCK_MEMBERS>;

/** Native video-lock command vocabulary, sent to its station under the station's member account. */
const VIDEO_LOCK_CMD = { ACTUATE: 1961, STATUS: 1955, NOTIFY: 1351 } as const;

/**
 * Opens a SmartDrop lid with `SET_PAYLOAD` 2100 at level 2, the only direction its wire has; the lid does not
 * open on the same frame at level 1.
 */
function openLid(ctx: CommandContext, sink: CommandSink): Promise<void> {
  return sink.dispatch({
    kind: "set-payload",
    cmd: 2100,
    payload: { isOpen: 1, userIndex: 0 },
    channel: ctx.channel,
    mValue3: 0,
  });
}

/**
 * The actuation intent, or a refusal naming what is missing. Identity is a genuine precondition — the
 * frame carries the member fields — and a generated "not a valid value" message would misreport it. Only the
 * `ff09` frame needs an admin id (its key is built from it); the video lock's and the keyed payload's `userId`
 * is left out on a member stating none, as the app's Gson does, and the pass-through keys with the user's own id.
 */
function actuate(engage: boolean, ctx: CommandContext, sink: CommandSink): Promise<void> {
  const kind = isVideoSmartLock(ctx)
    ? undefined
    : isClassicWifiLock(ctx)
      ? "keyed-payload-actuate"
      : isBluetoothLock(ctx)
        ? "doorlock-pass-through-actuate"
        : "ff09-actuate";
  if (!ctx.shortUserId || (!kind && !ctx.accountName) || (kind === "ff09-actuate" && !ctx.adminUserId)) {
    return Promise.reject(
      new Error(
        `lock: missing member identity (short_user_id, user name on video locks, admin_user_id on ff09 locks) [${describeDevice(ctx)}]`,
      ),
    );
  }
  if (!kind) {
    return sink.dispatch({
      kind: "set-payload",
      cmd: VIDEO_LOCK_CMD.ACTUATE,
      channel: ctx.channel,
      mValue3: 0,
      stationAccount: true,
      payload: {
        shortUserId: ctx.shortUserId,
        slOperation: engage ? 1 : 0,
        userId: ctx.adminUserId,
        userName: ctx.accountName,
      },
    });
  }
  const identity = {
    engage,
    username: ctx.accountName ?? "",
    shortUserId: ctx.shortUserId,
    deviceSn: ctx.serial ?? "",
  };
  if (kind === "ff09-actuate" && ownStation(ctx))
    return sink.dispatch(
      serviceWrite(35, 6018, [
        tlv(0xa3, Buffer.from([engage ? 0 : 1])),
        tlv(0xa4, Buffer.from(identity.username, "utf8")),
        tlv(0xa5, Buffer.from(ctx.shortUserId, "hex")),
      ]),
    );
  if (kind === "doorlock-pass-through-actuate") return sink.dispatch({ kind, ...identity });
  if (kind === "keyed-payload-actuate") return sink.dispatch({ kind, adminUserId: ctx.adminUserId, ...identity });
  return sink.dispatch({ kind, adminUserId: ctx.adminUserId!, ...identity });
}

/**
 * A lock that is its own station and whose settings go over secure MQTT: the app sends its lock/unlock and auto-lock
 * through the lock's own MQTT settings service ({@link serviceWrite}), not as an `ff09-*` intent.
 */
const ownStation = (ctx: CommandContext): boolean =>
  !(ctx.homeBaseAttached ?? ctx.stationSerial !== undefined) && settingsOverMqttWhenStandalone(ctx.model);

const tlv = (tag: number, value: Buffer) => ({ tag, value });

/**
 * A write through the lock's own MQTT settings service: `ff09` opcode `cmdCode` under `apiCommand`, its result awaited
 * 20 s, once; `preserve` the settings read tags whose bytes follow `fields`.
 */
function serviceWrite(
  cmdCode: number,
  apiCommand: number,
  fields: { tag: number; value: Buffer }[],
  preserve?: (number | Buffer)[],
): Command {
  return {
    kind: "mqtt-dp",
    mqttCmdCode: 9,
    cmdCode,
    fields,
    subVersion: 3,
    functionType: 2,
    encrypt: true,
    lockService: true,
    apiCommand,
    ...(preserve && { preserve }),
    timeoutS: 20,
  };
}

/** A SmartDrop lid opens only standalone and never engages. Other lock families retain their controls. */
function actuationAvailable(ctx: CommandContext, engage: boolean): boolean {
  return !isSmartDrop(ctx) || (!engage && ctx.stationSerial === undefined);
}

/**
 * The T8530's auto-lock writes, as its auto-lock screen sends them over its settings read (1958 over 1959): paramType
 * 6500 with `isAutoLock` and `autoLockTime` (the read's delay where none is given), then for a schedule paramType 6501
 * with `isSchedule` and `scheduleStart`/`scheduleEnd`, each hour and minute as two lowercase hex digits.
 */
function videoLockAutoLock(
  ctx: CommandContext,
  enabled: boolean,
  delaySeconds?: number,
  schedule?: Pick<AutoLockSnapshot, "isSchedule" | "scheduleStartTime" | "scheduleEndTime">,
): Command {
  const write = (paramType: number, param: Record<string, unknown>) =>
    thingWrite("smart_lock_set_setting_params", JSON.stringify({ paramType, param }), ctx)!;
  const hex = (t: [number, number]) => t.map((n) => n.toString(16).padStart(2, "0")).join("");
  const autoLock = write(6500, { isAutoLock: enabled ? 1 : 0, autoLockTime: delaySeconds });
  if (!schedule) return autoLock;
  const window = { isSchedule: schedule.isSchedule ? 1 : 0, scheduleStart: hex(schedule.scheduleStartTime) };
  return { ...autoLock, next: write(6501, { ...window, scheduleEnd: hex(schedule.scheduleEndTime) }) };
}

/** A T8530's 1959 settings read as its auto-lock snapshot, each field the app's default where the read has none. */
function videoLockSnapshot(read: Record<string, unknown>): AutoLockSnapshot {
  const time = (v: unknown, d: string): [number, number] => {
    const t = typeof v === "string" && v.length === 4 ? v : d;
    return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2), 16)];
  };
  return {
    enabled: Number(read.isAutoLock ?? 0) === 1,
    delaySeconds: Number(read.autoLockTime ?? 30),
    isSchedule: Number(read.isSchedule ?? 0) === 1,
    scheduleStartTime: time(read.scheduleStart, "1700"),
    scheduleEndTime: time(read.scheduleEnd, "0600"),
  };
}

/** Live status read; unknown states remain unknown and device refusals reject. */
async function refreshStatus(
  query: NonNullable<MediaProvider["p2pQuery"]>,
  timezone: string,
): Promise<boolean | undefined> {
  const payload = await query(VIDEO_LOCK_CMD.STATUS, {
    payload: { timezone },
  });
  if (payload.code !== 0) throw new Error(`lock.refreshStatus: device result ${String(payload.code)}`);
  return nativeState(payload.slState);
}

/** Only the two settled states ("3", "4") carry a boolean. */
function nativeState(raw: unknown): boolean | undefined {
  if (raw === "3") return false;
  if (raw === "4") return true;
  return undefined;
}

/** Successful video-lock status reports, attributed by the resolved device type. */
function nativeReport(signal: InboundSignal): Record<string, unknown> | undefined {
  if (
    signal.source !== "p2p-frame" ||
    !isVideoSmartLock(signal) ||
    signal.commandId !== VIDEO_LOCK_CMD.NOTIFY ||
    signal.json?.cmd !== VIDEO_LOCK_CMD.STATUS
  )
    return undefined;
  const report = signal.json.payload as Record<string, unknown> | undefined;
  return report?.code === 0 ? report : undefined;
}

/**
 * Whether the device speaks the `ff09` settings frames at all. The classic Wi-Fi lock actuates over its
 * own keyed envelope and never negotiates the session key those frames ride on, so a settings write
 * aimed at it can only time out — the members are withheld there rather than offered and failing. The
 * Bluetooth lock is withheld too: on the one unit tried, its T8021 bridge's session held only the set-payload
 * key, so the SDK refused the settings frame before sending it. Whether the lock would accept a settings frame
 * at all is untested.
 */
const speaksFf09Settings = (ctx: CommandContext): boolean =>
  !isClassicWifiLock(ctx) && !isBluetoothLock(ctx) && !isSmartDrop(ctx);

/**
 * Every `lock` feature, declared once. The lock's settings are its described things (`smart_lock_*`), written as
 * its bundle and its own settings screen send them.
 *
 * Exported but NOT published: each entry states its wire id and its gate,
 * which the reference site does not carry.
 * @internal
 */
export const LOCK_MEMBERS = {
  /**
   * The lock's own state, on param 6000: "4" = locked, "3" = unlocked.
   * `writtenElsewhere` points at the `lock`/`unlock` methods — a single `write` cannot express two
   * verbs that carry no value.
   */
  locked: {
    param: 6000,
    type: "bool",
    kind: "boolean",
    writtenElsewhere: true,
    coerce: (raw) => String(raw).trim() === "4",
    description: "Lock state, true=locked (param 6000, 4=locked, 3=unlocked).",
  },
  /**
   * Cell charge as a percentage, on param 1101 or smart-lock param 6001. Named `battery`
   * within this capability rather than deferring to the `battery` capability: a lock resolves as a lock,
   * so the accessor is `dev.lock().battery`.
   */
  battery: {
    param: 1101,
    readAliases: [{ paramType: 6001 }],
    type: "number",
    unit: "%",
    kind: "percent",
    description: "Lock battery level 0-100 (param 1101, alias 6001).",
  },

  /**
   * Lock the deadbolt/door. Resolves after sending, without confirming physical state — except on the
   * classic Wi-Fi lock, which answers: there it rejects on a device refusal or no reply as well.
   */
  lock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        actuate(true, ctx, sink),
    "Lock the deadbolt/door.",
    (ctx) => actuationAvailable(ctx, true),
  ),
  /**
   * Unlock the deadbolt/door, or open a SmartDrop lid. Resolves after sending, without confirming physical
   * state — except on the classic Wi-Fi lock, which answers: there it rejects on a device refusal or no
   * reply as well.
   */
  unlock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        isSmartDrop(ctx) ? openLid(ctx, sink) : actuate(false, ctx, sink),
    "Unlock the deadbolt/door.",
    (ctx) => actuationAvailable(ctx, false),
  ),

  /**
   * Read-modify-write the auto-lock setting: the transport GETs the device's current settings, changes
   * only `enabled` (+ `delaySeconds` if given — otherwise the current delay is preserved), and writes the
   * rest back verbatim. Works on both the T8531 video lock and the T85D0 garage/lock, which share the
   * identical settings frame. `schedule`, as `getAutoLockState` reads it, is written only on a lock that is its own
   * station, in the same frame, as its auto-lock screen sends it, and on the T8530 ({@link videoLockAutoLock}).
   *
   * **Unlike `lock`/`unlock` this can reject on a device TIMEOUT**, not just missing identity — the GET
   * step is a genuine precondition, so this one is not fire-and-forget.
   */
  setAutoLock: method(
    ({ ctx, sink }) =>
      (
        enabled: boolean,
        delaySeconds?: number,
        schedule?: Pick<AutoLockSnapshot, "isSchedule" | "scheduleStartTime" | "scheduleEndTime">,
      ): Promise<void> => {
        const times = schedule ? [schedule.scheduleStartTime, schedule.scheduleEndTime] : [];
        if (
          times.some(([h, m]) => !(Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60))
        )
          return Promise.reject(new Error(`lock.setAutoLock: schedule times must be [hour 0-23, minute 0-59]`));
        if (isVideoSmartLock(ctx)) return sink.dispatch(videoLockAutoLock(ctx, enabled, delaySeconds, schedule));
        if (!ctx.adminUserId) {
          return Promise.reject(
            new Error(`lock.setAutoLock: missing member identity (admin_user_id) [${describeDevice(ctx)}]`),
          );
        }
        // Its settings frame (paramType 0): enable, delay, the schedule flag, start and end ([hour, minute]) and the
        // door-state check, each the lock's own read where not given.
        if (ownStation(ctx)) {
          const delay = delaySeconds === undefined ? 0xa2 : u16le(delaySeconds);
          const window = schedule
            ? [Buffer.from([schedule.isSchedule ? 1 : 0]), ...times.map((t) => Buffer.from(t))]
            : [0xa3, 0xa4, 0xa5];
          return sink.dispatch(
            serviceWrite(
              52,
              6015,
              [tlv(0xa3, Buffer.from([0])), tlv(0xa4, Buffer.from([enabled ? 1 : 0]))],
              [delay, ...window, 0xb4],
            ),
          );
        }
        if (schedule)
          return Promise.reject(new Error(`lock.setAutoLock: no schedule write on this lock [${describeDevice(ctx)}]`));
        return sink.dispatch({
          kind: "ff09-autolock",
          adminUserId: ctx.adminUserId,
          deviceSn: ctx.serial ?? "",
          enabled,
          delaySeconds,
        });
      },
    "Read-modify-write the auto-lock setting, preserving the fields it does not change.",
    speaksFf09Settings,
  ),

  /** Read the current device-reported state; undefined means no settled locked/unlocked state. */
  refreshStatus: {
    ...provided(
      "media",
      (media, { ctx }) => {
        const query = media.p2pQuery?.bind(media);
        const timezone = ctx.timezone;
        return isVideoSmartLock(ctx) && timezone && query ? () => refreshStatus(query, timezone) : undefined;
      },
      "Read the current lock state from the device.",
    ),
    answers: true,
  },

  /**
   * Read the device's current auto-lock settings via a live `GET_SETTINGS` round-trip — the SAME read
   * `setAutoLock` does internally, exposed standalone with no write attached. Works over BOTH transports; on the
   * T8530 it is its 1959 settings read ({@link videoLockSnapshot}).
   * A genuine request/reply query, not a passive property, so it always talks to the device.
   *
   * `answers` for that reason: the returned snapshot IS the point, so it is not a control to offer even
   * though it takes no arguments — offering it as one would run a round-trip and discard the answer.
   */
  getAutoLockState: {
    ...provided(
      "ff09Settings",
      (f, { ctx, media }) => {
        const query = media?.p2pQuery?.bind(media);
        if (isVideoSmartLock(ctx)) return query && (() => query(1959).then(videoLockSnapshot));
        return isSmartDrop(ctx) || isBluetoothLock(ctx)
          ? undefined
          : (): Promise<AutoLockSnapshot> => f.getAutoLockState();
      },
      "Read the current auto-lock settings via a live round-trip.",
    ),
    answers: true,
  },
} as const satisfies Members;

/**
 * The `locked` boolean a `lockState` push carries, derived from which `LockPushEvent` fired: the seven
 * `*_LOCK` actions (262..268) → `true`, the six `*_UNLOCK` actions (257..261 + 269) → `false`. The rest
 * of the 257..771 range — alarms, low-power, offline/online, OTA/status — is not a lock transition and
 * contributes no `locked` field, so a consumer reads state only from an event that actually carries one.
 */
function decodeLockTransition(signal: InboundSignal): Record<string, unknown> {
  if (signal.source !== "push" || signal.eventType === undefined) return {};
  const e = signal.eventType;
  if (e >= LockPushEvent.MANUAL_LOCK && e <= LockPushEvent.TEMPORARY_PW_LOCK) return { locked: true };
  const unlocked =
    (e >= LockPushEvent.MANUAL_UNLOCK && e <= LockPushEvent.APP_UNLOCK) || e === LockPushEvent.TEMPORARY_PW_UNLOCK;
  return unlocked ? { locked: false } : {};
}

/**
 * `lock` — smart lock. `locked` reports lock state via param 6000 (4=locked, 3=unlocked);
 * a device that reports no stable state param carries its transitions on the `lockState` event instead,
 * whose payload names the decoded `locked`.
 */
export const LOCK: CapabilityModule = {
  capability: "lock",
  description: "Smart-lock locked/unlocked state and battery.",
  members: LOCK_MEMBERS,
  properties: propertiesOf(LOCK_MEMBERS),
  decodeState(signal) {
    const report = nativeReport(signal);
    if (!report) return null;
    const params: Record<number, string> = {};
    if (nativeState(report.slState) !== undefined) params[6000] = String(report.slState);
    if (report.slBattery !== undefined) params[6001] = String(report.slBattery);
    return { params };
  },
  /**
   * The app offers a lock where the product's thing description lists `smart_lock_onoff_status`, video
   * locks and the SmartDrop lid included. Without a description, the lock codec or a reported 6000 is the
   * evidence. Never the device's name: that is what its owner typed.
   */
  detection: {
    detect: (record, codec) =>
      record.things
        ? "smart_lock_onoff_status" in record.things.properties
        : codec === "lock" || Object.hasOwn(record.params ?? {}, 6000),
  },
  // Inbound FCM lock events (LockPushEvent 257..771: (un)lock actions + alarms) → one "lockState", whose
  // payload carries a decoded `locked` boolean for the (un)lock actions (see decodeLockTransition).
  events: [{ source: "push", match: [257, 771], emit: "lockState", derive: decodeLockTransition }],
};
