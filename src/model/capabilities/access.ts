import type { Capability } from "../types.js";
import type { ActionSpec, AvailabilityContext, CommandContext, CapabilityStateReader } from "./types.js";
import type { Command, ScalarForm } from "../../core/contracts.js";

/**
 * Capability param access — the shared surface capability modules use to WRITE a param (the
 * command-intent builders) and to READ one (the typed read extractors at the bottom of this file).
 *
 * **Write:** a capability states *what* to change (param id + already-polarity-resolved value) and,
 * when the firmware pins it, *which wire form* the data takes. It never picks an encryption level or
 * assembles a P2P frame: the transport resolver ({@link module:index} `resolveScalar`) does that,
 * session-first for `"auto"`. Adding or changing a capability = call these helpers; the transport
 * stays untouched.
 *
 * **Read:** the `readNum`/`readBool`/`readStr` extractors narrow a live property to a typed value for
 * the fluent read getters (`dev.battery()?.level`) — the dual of the write builders.
 *
 * @module model/capabilities/access
 * ## `ScalarForm`
 * - `"auto"` — a scalar int whose encryption level the **session** decides: L2 direct-binary when a
 *   level-2 key is negotiated, else L1 int-string. Correct for params that are the same bytes either
 *   way (camera power 1035 — verified live on standalone T8410 = L1 and HomeBase T8114 = L2).
 * - `"int-string"` — force the L1 int+string frame. For params the firmware only accepts as level-1
 *   even on a HomeBase (status LED 1045; the Cam2C/2/3 floodlight switch 1400).
 * - `"direct-binary"` — force the L2 binary "direct" frame (spotlight brightness/color-temp/enable).
 *
 * ({@link ScalarForm} is declared in `./types` to keep the Command union self-contained.)
 */

/**
 * Set a scalar (integer) param. `form` defaults to `"auto"` — let the session decide the level.
 * Pass an explicit form only when the firmware pins the wire (see {@link ScalarForm}).
 */
export function setScalar(param: number, value: number, ctx: CommandContext, form: ScalarForm = "auto"): Command {
  return { kind: "set-param", param, value, form, channel: ctx.channel };
}

/**
 * Set a param carried as a JSON control-payload (`{commandType:param, data}` under the 1700 wrapper).
 * The transport picks L1 (standalone, ECB) vs L2 (HomeBase, GCM) by session — the capability just
 * describes the payload.
 */
export function setJson(param: number, data: Record<string, unknown>, ctx: CommandContext): Command {
  return { kind: "set-json", param, data, channel: ctx.channel };
}

/**
 * Set a param carried as BARE JSON, no envelope at all — the wire's outer P2P command IS `cmd`
 * itself, GCM signCode 8, plaintext exactly `{account_id,...data}` (the sink injects `account_id`).
 * Distinct from {@link setJson}, which always wraps in the `1700` CONTROL_PAYLOAD `{commandType,data}`
 * shape. Reversed from a live capture of the app's own SET_SNOOZE_TIME (1271) frame.
 *
 * `channel` overrides the device channel — pass it for a station-scoped bare write (e.g. the
 * alarm-delay config 1255, which rides the station broadcast channel 255, not `ctx.channel`).
 */
export function setJsonRaw(cmd: number, data: Record<string, unknown>, ctx: CommandContext, channel?: number): Command {
  return { kind: "set-json-raw", cmd, data, channel: channel ?? ctx.channel };
}

/**
 * Set a param carried in the `SET_PAYLOAD` (1350) envelope — `{account_id,cmd,mChannel,mValue3:cmd,
 * payload}`, GCM signCode 8 — NOT the bare `{commandType,data}` 1700 wrapper `setJson` uses. The wire
 * eufy uses for a few doorbell controls (status-LED 1716 `{light_enable}`). Level-2 by default; the
 * sink resolves the session/account_id and replays the frame.
 *
 * ## When this envelope takes `form: "auto"`
 *
 * Left at the default the frame is level-2 ONLY, and on a station holding no level-2 key that does not
 * fail — it WAITS: the transport spends the full level-2 grace, re-prompts, spends it again, and only
 * then throws. Every caller with a shorter bound sees a hang rather than a refusal, so a control on a
 * device that may be its own keyless station is effectively unreachable. `"auto"` hands the choice to
 * the session (`sendBySessionLevel`), which seals level-2 wherever a key exists — unchanged for a
 * HomeBase — and level-1 where none does.
 *
 * Two conditions, and BOTH have to hold:
 *
 *  1. **`mValue3` is passed explicitly as 0.** The level-1 form of this envelope writes `mValue3:0`
 *     itself, while the level-2 form defaults it to the sub-command — so a command that passes 0 sends
 *     byte-identical JSON either way and `"auto"` only changes the seal. A command that OMITS `mValue3`
 *     would send a DIFFERENT object at level 1 than the one captured at level 2; that is a new wire
 *     needing its own evidence, not a downgrade, and it stays pinned until something captures it.
 *  2. **The device can be its own station.** A camera or doorbell may be standalone; a HomeBase, and an
 *     accessory whose session IS its HomeBase's, always holds a key. Where a key is structurally
 *     guaranteed, staying pinned is the honest behaviour: a keyless station there is an anomaly, and
 *     throwing says so where a silently-ignored level-1 frame would look like success.
 */
export function setPayload(
  cmd: number,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  mValue3?: number,
  channel?: number,
  form?: ScalarForm,
): Command {
  // `channel` overrides the envelope's mChannel (default = the device channel). Some commands send
  // mChannel 0 and carry the device channel INSIDE the payload instead (e.g. night vision 1277).
  return { kind: "set-payload", cmd, payload, channel: channel ?? ctx.channel, mValue3, form };
}

/**
 * Set a station-scoped scalar (132-byte body, no channel field) on an EXPLICIT channel — for the
 * HomeBase's own controls on the station broadcast channel 255 (alarm/speaker volume 1235). Level-2
 * only, unless `form` is `"auto"`, which seals it at the session's own level.
 */
export function setStationScalar(cmd: number, value: number, channel: number, form?: "auto"): Command {
  return { kind: "p2p-station-scalar", cmd, value, channel, ...(form ? { form } : {}) };
}

/**
 * A one-line device descriptor for error messages — carries every identifier needed to reproduce or
 * triage from a log later (deviceType, model T-code, full serial, channel, codec), so a "capability
 * detected but this device's wire is unknown / unsupported" throw is self-contained instead of naming
 * a bare `deviceType`.
 */
export function describeDevice(ctx: CommandContext): string {
  return (
    `deviceType=${ctx.deviceType ?? "?"} model=${ctx.model ?? "?"} serial=${ctx.serial ?? "?"} ` +
    `channel=${ctx.channel} codec=${ctx.codec}`
  );
}

// ── shared family / capability gates (used by capability modules to route commands per device) ──

/** True for a camera-codec device (a camera or a doorbell) — the video / two-way-audio family. */
export function isCameraCodec(ctx: AvailabilityContext): boolean {
  return ctx.codec === "camera";
}

/** True for a station/hub codec (a HomeBase OR an NVR — use `isHomeBase` from device-family to exclude NVRs). */
export function isStationCodec(ctx: AvailabilityContext): boolean {
  return ctx.codec === "station";
}

/** True when the device's RESOLVED capability set includes `cap` — the same gate `buildCommand` authorizes on. */
export function hasCapability(ctx: AvailabilityContext, cap: Capability): boolean {
  return ctx.capabilities?.has(cap) === true;
}

// ── action descriptions (what a write accepts, carried by the write itself) ──

/**
 * Where an {@link ActionSpec} hangs off the method it describes. A symbol so it cannot collide with an
 * action name and never appears in a caller's enumeration of the action object.
 */
const ACTION_SPEC = Symbol("eufy.actionSpec");

/**
 * Attach a description to an action, at the one place the action is declared.
 *
 * The alternative — a table of descriptions beside `actions()` — restates every method name, which is
 * one rename away from describing a method that no longer exists. Here the object key IS the name, so
 * the two cannot come apart. The description is then readable only off a BUILT action object.
 *
 * See {@link ActionSpec} for what may be described — the value-taking method rather than its aliases,
 * and only a wire confirmed on real hardware.
 */
export function describedAction<F extends (...args: never[]) => unknown>(spec: ActionSpec, fn: F): F {
  return Object.defineProperty(fn, ACTION_SPEC, { value: spec }) as F;
}

/** The {@link ActionSpec} attached to a built action, or `undefined` for one nothing describes. */
export function actionSpecOf(fn: unknown): ActionSpec | undefined {
  return typeof fn === "function" ? (fn as unknown as Record<symbol, ActionSpec | undefined>)[ACTION_SPEC] : undefined;
}

/**
 * `vacuum_clean` → `vacuumClean`, `smart_light` → `smartLight` — the fluent accessor name a capability
 * is reached under.
 *
 * Lives here because two callers need the same answer: the barrel installs the accessors under these
 * names, and the manifest publishes them, so a described capability names the accessor its object
 * lives on. A second copy would be a rename away from naming an accessor that doesn't exist.
 * @internal
 */
export function camelCase(cap: Capability): string {
  return cap.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── read extractors (the read dual of the write-intent builders above) ──

/**
 * Narrow a capability's live property to a typed value for a fluent read getter (`dev.battery()?.level`).
 * The value already arrives runtime-coerced to its `PropertySpec.type` (`device.ts` `coerceByType`), so
 * this only guards the runtime type — returning `undefined` on a mismatch (or a missing/unbound reader)
 * rather than lie-casting. Read a numeric property, or `undefined` when absent / not a number.
 */
export function readNum(read: CapabilityStateReader | undefined, name: string): number | undefined {
  const v = read?.(name)?.value;
  return typeof v === "number" ? v : undefined;
}

/** Read a boolean property by name, or `undefined` when absent / not a boolean. */
export function readBool(read: CapabilityStateReader | undefined, name: string): boolean | undefined {
  const v = read?.(name)?.value;
  return typeof v === "boolean" ? v : undefined;
}

/** Read a string property by name, or `undefined` when absent / not a string. */
export function readStr(read: CapabilityStateReader | undefined, name: string): string | undefined {
  const v = read?.(name)?.value;
  return typeof v === "string" ? v : undefined;
}

/**
 * Build a Tuya DP write intent — the clean-line wire for a single data-point value.
 * Named for the wire mechanism (the AIoT "Tuya DP" protocol), not the capability that first
 * uses it, so it is open to any future Tuya-DP device.
 */
export function aiotDp(dp: number, value: boolean | number | string): Command {
  return { kind: "aiot-dp", dp, value };
}

/**
 * Pick a capability's OWN data points out of a realtime report, for its `decodeState`.
 *
 * The transport unwraps the report's envelope into `id → value` without knowing what any id means;
 * this is the other half — each capability names the ids it owns, so one clean-line module never
 * claims another's points off the same message. `undefined` when the report carries none of them,
 * which is what a `decodeState` returns to say "not mine".
 *
 * Values pass through untouched. A structured point stays the base64 its device sent, for the read
 * getter to decode once a codec is in scope.
 */
export function pickDpParams(
  report: Record<number, string> | undefined,
  ids: readonly number[],
): Record<number, string> | undefined {
  if (!report) return undefined;
  const out: Record<number, string> = {};
  for (const id of ids) if (report[id] !== undefined) out[id] = report[id];
  return Object.keys(out).length ? out : undefined;
}
