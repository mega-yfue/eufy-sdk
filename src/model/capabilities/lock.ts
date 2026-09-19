import { asBool } from "../../core/util.js";
import { describeDevice } from "./access.js";
import { method, propertiesOf, provided, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command, CommandSink, AutoLockSnapshot } from "../../core/contracts.js";

/**
 * Setting-id selectors for the compact `ff09-setting-toggle` write — this capability's OWN wire
 * vocabulary, named not inlined per the capability wire-id convention, so `setRainMode`
 * below references `LOCK_SETTING_ID.RAIN_MODE` and this module's own spec can import it too, instead
 * of a bare `7` at either call site.
 *
 * Unlike a normal capability id (owned by exactly one layer, crossing into `transport/` only as an
 * opaque number), this value is a GENUINE duplicate of `transport/ff09.ts`'s `FF09_SETTING_ID.RAIN_MODE`
 * — the capability↔transport decorrelation rule (`model/` never imports `transport/`) leaves no way to
 * share one source of truth across the boundary, and no test can cross-check them without violating
 * that same rule (`guard:decorrelation` forbids any `transport/` import under `src/model`, including
 * tests). If a future capture revises this id, BOTH copies must be updated by hand.
 */
export const LOCK_SETTING_ID = {
  /** One-touch lock toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ONE_TOUCH_LOCK: 1,
  /** Scramble-passcode toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  SCRAMBLE_PASSCODE: 3,
  /** Wifi-status toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  WIFI_STATUS: 5,
  /** Event-log-enable toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ENABLE_LOG: 6,
  /** Rain Mode toggle on the T8531 video lock. Verified live 2026-07-18. */
  RAIN_MODE: 7,
  /** Privacy-mode toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  PRIVACY_MODE: 9,
  /** One-touch rear-lock toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ONE_TOUCH_REAR_LOCK: 11,
} as const;

/**
 * Bound lock controls — the object returned by `dev.lock()`.
 *
 * Everything is DERIVED from `LOCK_MEMBERS`. `lock`/`unlock` and the setting toggles drive any
 * lock-family actuator — currently the T8531 video smart lock and the T85D0 garage door, which share one
 * actuation frame. This module emits ONE transport-neutral intent (identity fields only, no wire bytes,
 * no cipher, no routing key) and names no transport: the command sink routes P2P vs MQTT by the device's
 * topology, and the chosen transport's command router builds the frame + envelope and re-resolves its own
 * routing tail. Which pipe it is does not reach `dev.lock()` — its surface is identical either way,
 * the same way P2P-vs-cloud is hidden for live media.
 */
export type LockActions = Surface<typeof LOCK_MEMBERS>;

/**
 * The actuation intent, or a refusal naming what is missing. Identity is a genuine precondition — the
 * frame carries the member fields — and a generated "not a valid value" message would misreport it.
 */
function actuate(engage: boolean, ctx: CommandContext, sink: CommandSink): Promise<void> {
  if (!ctx.adminUserId || !ctx.shortUserId) {
    return Promise.reject(
      new Error(`lock: missing member identity (admin_user_id/short_user_id) [${describeDevice(ctx)}]`),
    );
  }
  return sink.dispatch({
    kind: "ff09-actuate",
    engage,
    adminUserId: ctx.adminUserId,
    username: ctx.accountName ?? "",
    shortUserId: ctx.shortUserId,
    deviceSn: ctx.serial ?? "",
  });
}

/** The compact single-setting write (`ff09-setting-toggle`), or a refusal naming the missing identity. */
function settingToggle(settingId: number, name: string, enabled: boolean, ctx: CommandContext, sink: CommandSink) {
  if (!ctx.adminUserId) {
    return Promise.reject(new Error(`lock.${name}: missing member identity (admin_user_id) [${describeDevice(ctx)}]`));
  }
  return sink.dispatch({
    kind: "ff09-setting-toggle",
    adminUserId: ctx.adminUserId,
    deviceSn: ctx.serial ?? "",
    settingId,
    value: enabled,
  });
}

/**
 * Whether the device is reachable over P2P — the topology fact that decides which lock settings exist.
 * The compact toggles are only known on the P2P video lock; the MQTT garage door does not expose them in
 * the app, so offering them there would guess a frame shape that likely does not exist.
 */
const overP2p = (ctx: AvailabilityContext): boolean => ctx.hasP2p === true;

/**
 * Every `lock` feature, declared once.
 *
 * The six toggles after `setRainMode` share its confirmed frame SHAPE and are grounded in the app's own
 * JS, but none has been captured against a real device — so each is `unverified`: DECLARED, so the
 * capability documents what the lock has, and NOT installed, because a fire-and-forget write that is
 * wrong looks exactly like success. A caller sees them as optional and learns at compile time that they
 * are not settable yet; promoting one is a single edit once a capture lands.
 *
 * They carry no `param`: a setting id is not a param id, nothing reports these back, and declaring one
 * would put a wire number where the schema expects a reported value.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LOCK_MEMBERS = {
  /**
   * The lock's own state, verified on param 6000: "4" = locked, "3" = unlocked.
   * `writtenElsewhere` points at the `lock`/`unlock` methods — a single `write` cannot express two
   * verbs that carry no value.
   */
  locked: {
    param: 6000,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    writtenElsewhere: true,
    coerce: (raw) => String(raw).trim() === "4",
    description: "Lock state, true=locked (verified: param 6000, 4=locked, 3=unlocked).",
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
    provenance: "verified",
    description: "Lock battery level 0-100 (verified: param 1101, alias 6001).",
  },
  /**
   * Link quality in dBm as the lock measures it, on the shared param 1141. Both actuation methods here
   * are fire-and-forget, so a weak link is silent rather than an error.
   */
  rssi: {
    param: 1141,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "verified",
    description: "Lock signal strength (verified: param 1141 = RSSI).",
  },

  /** Lock the deadbolt/door. Fire-and-forget — rejects only on missing member identity, never on a device timeout. */
  lock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        actuate(true, ctx, sink),
    "Lock the deadbolt/door.",
  ),
  /** Unlock the deadbolt/door. Fire-and-forget — rejects only on missing member identity. */
  unlock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        actuate(false, ctx, sink),
    "Unlock the deadbolt/door.",
  ),

  /**
   * Read-modify-write the auto-lock setting: the transport GETs the device's current settings, changes
   * only `enabled` (+ `delaySeconds` if given — otherwise the current delay is preserved), and writes the
   * rest back verbatim. Works on both the T8531 video lock and the T85D0 garage/lock, which share the
   * identical settings frame; confirmed on-device in both directions on both families.
   *
   * **Unlike `lock`/`unlock` this can reject on a device TIMEOUT**, not just missing identity — the GET
   * step is a genuine precondition, so this one is not fire-and-forget.
   */
  setAutoLock: method(
    ({ ctx, sink }) =>
      (enabled: boolean, delaySeconds?: number): Promise<void> => {
        if (!ctx.adminUserId) {
          return Promise.reject(
            new Error(`lock.setAutoLock: missing member identity (admin_user_id) [${describeDevice(ctx)}]`),
          );
        }
        return sink.dispatch({
          kind: "ff09-autolock",
          adminUserId: ctx.adminUserId,
          deviceSn: ctx.serial ?? "",
          enabled,
          delaySeconds,
        });
      },
    "Read-modify-write the auto-lock setting, preserving the fields it does not change.",
  ),

  /**
   * Toggle Rain Mode — a pure blind write, unlike `setAutoLock`: the compact frame carries only this one
   * field, so there is no GET pass and it is fire-and-forget. Confirmed on-device end-to-end in both
   * directions, with the app UI reflecting the new state afterward. P2P video lock only.
   */
  setRainMode: method(
    ({ ctx, sink }) =>
      (enabled: boolean): Promise<void> =>
        settingToggle(LOCK_SETTING_ID.RAIN_MODE, "setRainMode", enabled, ctx, sink),
    "Toggle Rain Mode.",
    overP2p,
  ),

  /**
   * Lock the door by a single touch on the pad, with no code. First of the six compact toggles: all
   * `unverified` (frame shape read out of the app's JS, never captured), so no setter is installed and
   * `setOneTouchLock` lands optional on the surface — a caller learns at compile time. `writeOnly` too:
   * nothing reports the setting back, so there is no getter either.
   */
  oneTouchLock: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "One-touch locking (setting-id 1). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ONE_TOUCH_LOCK, v, ctx),
  },
  /**
   * Pad anti-shoulder-surfing: the lock asks for extra random digits around the real code so a watcher
   * cannot read it off worn keys. Same `unverified` + `writeOnly` + P2P-only standing as its five
   * siblings — declared so the capability documents the lock, not installed.
   */
  scramblePasscode: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description:
      "Scramble the passcode entry pad (setting-id 3). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.SCRAMBLE_PASSCODE, v, ctx),
  },
  /**
   * Whether the lock reports its Wi-Fi status — a reporting toggle, not the radio itself, on the app's
   * own naming. Same `unverified` + `writeOnly` + P2P-only standing as its five siblings; treat the
   * meaning as the app's label until a capture pins the behaviour.
   */
  wifiStatus: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Wi-Fi status reporting (setting-id 5). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.WIFI_STATUS, v, ctx),
  },
  /**
   * Whether the lock records its own event history on-device. Same `unverified` + `writeOnly` +
   * P2P-only standing as its five siblings — the frame shape comes from the app's JS and has never been
   * driven against hardware.
   */
  logEnabled: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Event-log recording (setting-id 6). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ENABLE_LOG, v, ctx),
  },
  /**
   * The lock's own privacy mode — unrelated to the camera capability's privacy burst, which is a
   * different device, a different wire and a different meaning. Same `unverified` + `writeOnly` +
   * P2P-only standing as its five siblings.
   */
  privacyMode: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Lock privacy mode (setting-id 9). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.PRIVACY_MODE, v, ctx),
  },
  /**
   * The rear-deadbolt counterpart to `oneTouchLock`, on a lock that has a second bolt — so a model with
   * one bolt has nothing for it to drive. Last of the six compact toggles and shares their standing
   * exactly: `unverified`, `writeOnly`, P2P-only, no setter installed.
   */
  oneTouchRearLock: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "One-touch rear locking (setting-id 11). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ONE_TOUCH_REAR_LOCK, v, ctx),
  },

  /**
   * Read the device's current auto-lock settings via a live `GET_SETTINGS` round-trip — the SAME read
   * `setAutoLock` does internally, exposed standalone with no write attached. Works over BOTH transports.
   * A genuine request/reply query, not a passive property, so it always talks to the device.
   *
   * `answers` for that reason: the returned snapshot IS the point, so it is not a control to offer even
   * though it takes no arguments — offering it as one would run a round-trip and discard the answer.
   */
  getAutoLockState: {
    ...provided(
      "ff09Settings",
      (f) => (): Promise<AutoLockSnapshot> => f.getAutoLockState(),
      "Read the current auto-lock settings via a live round-trip.",
    ),
    answers: true,
  },
} as const satisfies Members;

/**
 * The compact toggle as a `Command` for the member `write` path, which supplies no sink. Identity is
 * re-checked by the transport; a member write cannot carry a bespoke refusal, and these are all
 * `unverified` so none is installed today.
 */
function settingToggleCommand(settingId: number, enabled: boolean | number | string, ctx: CommandContext): Command {
  return {
    kind: "ff09-setting-toggle",
    adminUserId: ctx.adminUserId ?? "",
    deviceSn: ctx.serial ?? "",
    settingId,
    value: asBool(enabled),
  };
}

/**
 * `lock` — smart lock. `locked` reports lock state via verified param 6000 (4=locked, 3=unlocked),
 * and `battery` reports charge percentage via param 1101 or smart-lock alias 6001.
 */
export const LOCK: CapabilityModule = {
  capability: "lock",
  description: "Smart-lock locked/unlocked state and battery.",
  members: LOCK_MEMBERS,
  properties: propertiesOf(LOCK_MEMBERS),
  // Lock state is reported via param 6000 (verified: 4=locked, 3=unlocked); the model name (lock/safe) is a
  // signal, and every lock-codec device has the lock capability as its baseline.
  detection: { evidenceParams: [6000], modelHints: [/lock/i, /safe/i], codecs: ["lock"] },
  // Inbound FCM lock events (LockPushEvent 257..771: (un)lock actions + alarms) → one "lockState".
  events: [{ source: "push", match: [257, 771], emit: "lockState" }],
};
