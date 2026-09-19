import { asBool } from "../../core/util.js";
import { CusPushEvent, DoorbellPushEvent, HB3PairedDevicePushEvent, IndoorPushEvent } from "../push-events.js";
import { describeDevice, setJson, setJsonRaw, setPayload, setScalar } from "./access.js";
import { propertiesOf, type Members, type Surface, type MemberDeps } from "./members.js";
import { DeviceType } from "../device-types.js";
import type {
  CapabilityActions,
  CapabilityModule,
  CapabilityStateReader,
  CommandContext,
  DecodedState,
  EventClaim,
  InboundSignal,
} from "./types.js";
import type { ParamValue } from "../types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this motion capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const MOTION_CMD = {
  /**
   * Motion / PIR detection on-off (app `CAMERA_PIR`). ✅ Wire reversed from a
   * live outbound capture + replay-verified on T8425 (ch3): the direct-binary 136-byte struct
   * `[u32 ch][u32 value][account_id pad128]`, signCode 8 — SAME shape as watermark 1214. 1 = on, 0 = off.
   */
  CAMERA_PIR: 1011,
  /**
   * Motion sensitivity (app `SET_MOTION_DETECTION_SENSITIVITY_DOORBELL`, despite the name NOT
   * doorbell-specific — see below). ✅ Wire captured live on a T8170 ( 2026-07-23,
   * confirmed exchange), moving the sensitivity slider twice: `1350`
   * SET_PAYLOAD, cmd 1276, mChannel `<deviceCh>`, explicit mValue3:0, `payload:{sensitivity:<int>,
   * channel:<deviceCh>}`. Two real values captured: slider position 0 → `sensitivity:1`, slider
   * position 6 → `sensitivity:7` — the wire is **1-indexed**, one higher than the app UI's 0-indexed
   * display. Captured on a T8170; no other model is assumed to share it.
   */
  MOTION_SENSITIVITY: 1276,
  /**
   * PIR sensitivity on a standalone motion **sensor** (app `APP_CMD_MOTION_SENSOR_SET_PIR_SENSITIVITY`).
   * The same user-facing setting as {@link MOTION_SENSITIVITY}, under a DIFFERENT id — a camera takes
   * 1276, a sensor takes this. ✅ Captured live 2026-08-03 on a T8910: the app sent 1609 as a
   * direct-binary 136-byte frame on the sensor's channel, and the value reads back on the cloud param
   * of the same id. Sending a camera's 1276 to a sensor is a fire-and-forget no-op that looks like a
   * success, which is why the two are kept apart rather than merged.
   *
   * ⚠️ The value is NOT the app's slider index. Its picker offers five steps (low → high, annotated
   * with a detection distance), while two sensors on one account read 8 and 37 — so the mapping from
   * a step to this number is unknown, and no range can be validated beyond rejecting below 1. A caller
   * setting this is passing through a raw device value, not choosing a documented level.
   *
   * A change applies after about a minute, or immediately if the sensor is triggered — the app says so
   * on the same screen, and the same wake behaviour governs every write to a sensor.
   */
  SENSOR_PIR_SENSITIVITY: 1609,
  /**
   * Enter a motion sensor's **user test mode** (app `APP_CMD_MOTION_SENSOR_ENTER_USER_TEST_MODE`).
   *
   * ✅ Decrypted from the app's own frame and replayed live on a T8910 (2026-08-03): a `1350`
   * SET_PAYLOAD whose payload carries the sensor's channel — `{"cmd":1613,"payload":{"channel":<ch>}}`.
   * The channel MUST be in the payload; passing it only as the envelope's `mChannel` with an empty
   * payload is refused with `-1`. The station acknowledges with `0` and confirms by reporting
   * {@link SENSOR_WORK_MODE} `1`.
   */
  SENSOR_ENTER_TEST_MODE: 1613,
  /**
   * Leave a motion sensor's user test mode (app `APP_CMD_MOTION_SENSOR_EXIT_USER_TEST_MODE`).
   *
   * ✅ Replayed live on a T8910, confirmed by {@link SENSOR_WORK_MODE} reporting `0`. NOT the same
   * shape as its {@link SENSOR_ENTER_TEST_MODE} counterpart: this is a direct-binary frame with the id
   * as the outer command, and each is refused in the other's shape.
   */
  SENSOR_EXIT_TEST_MODE: 1610,
  /**
   * The mode a motion sensor reports it is in (app `APP_CMD_MOTION_SENSOR_WORK_MODE`), inbound only —
   * `1` while test mode is on, `0` once it is left. Never present in the cloud record; it exists only
   * on the P2P path.
   */
  SENSOR_WORK_MODE: 1612,
  /**
   * AI detection TYPE — which classifications trigger a detection (person / pet / vehicle / …).
   * From the app's own JS parser (command_schema.json): `1350` SET_PAYLOAD, inner cmd `AI_DETECT_TYPE`
   * (1298), `payload:{ai_detect_type:<bitmask>, channel:<deviceCh>}` — same envelope shape as the
   * ✅-verified night-vision (1277). 1298 holds the detailed BITMASK. ✅ Bits decoded live + confirmed
   * vs the app (see {@link AiDetectType} / {@link encodeAiDetectType}). ✅ WRITE HW-verified live on
   * T8124 (each write landed byte-exact + read back: 0x30003 → 0x8 → 0x3000b).
   */
  AI_DETECT_TYPE: 1298,
  /**
   * Notification **snooze** — temporarily silence motion/detection notifications for N seconds. ✅ WIRE
   * CONFIRMED on a T8170 (2026-07-23,
   * app force-relaunched to guarantee a fresh handshake): a **bare JSON frame, NOT a `1350`/`1700`
   * envelope** — outer P2P cmd IS `1271` itself, plaintext exactly `{account_id,...}` (see
   * {@link module:./intent setJsonRaw}). Three real writes captured on the device channel (ch2):
   * `{snooze_time:21600,chime_onoff:0,homebase_onoff:1,motion_notify_onoff:1,startTime:1784794716}`,
   * `{snooze_time:0}` (clearing/cancelling — the bare shape, no extra fields), and
   * `{snooze_time:3600,chime_onoff:0,homebase_onoff:0,motion_notify_onoff:1,startTime:1784794730}`.
   * Confirms `command_schema.json`'s field names exactly; it is a real P2P frame, not the cloud-only
   * HTTP path a `paramValue = base64(JSON.stringify(payload))` shape might suggest.
   * `chime_onoff`/`homebase_onoff`/`motion_notify_onoff` meanings are NOT independently verified
   * (only observed alongside 2 different snooze picks) — `setSnoozeTime` ships the exact 2nd-capture
   * values as fixed defaults rather than exposing them, since their semantics aren't confirmed enough
   * to make configurable without risking a wrong guess on a fire-and-forget write.
   */
  SNOOZE_TIME: 1271,
  /**
   * Use AI classification ONLY at night (app `APP_CMD_BAT_DOORBELL_SET_ONLY_USE_AI_AT_NIGHT`).
   * `1350` SET_PAYLOAD, inner cmd 1719, `payload:{only_ai:0|1}`, mValue3 0. The envelope's mChannel is
   * the DEVICE channel — which is set by NOT passing `setPayload`'s explicit-channel arg, and is
   * independent of what keys the payload carries. (Contrast 1277/1298, which DO carry a `channel`
   * payload key AND pass mChannel 0 explicitly; the two are separate choices, not linked.)
   *
   * ⚠️ Replay + readback confirmed on a HomeBase-attached T8425 (1719 `0`→`1`→`0`), NOT byte-captured.
   * Provenance is `apk`, not `verified`: a divergent-but-also-accepted frame can't be ruled out.
   */
  HUMAN_ONLY_AT_NIGHT: 1719,
  /**
   * Loitering detection (app `APP_CMD_DUALCAM_SET_RADAR_WD_SWITCH`) — alert on lingering, not passing.
   * `1350` SET_PAYLOAD, inner cmd 2706, `payload:{radar_wd_switch:0|1}`, mValue3 0, mChannel = device
   * channel. Observed on the T8214 doorbell only.
   *
   * **READ is object-OR-scalar.** The app reads it as
   * `typeof v === "object" ? v.radar_wd_switch : v`, so the stored value may be a JSON object
   * `{radar_wd_switch,…}` OR a bare scalar — a plain bool coercion reports `false` for the object
   * form, so a feature that is on reads as off.
   * Decoded by {@link decodeRadarWdSwitch} to match the app.
   *
   * ⚠️ Replay + readback confirmed on a T8214 (2706 `0`→`1`→`0`), NOT byte-captured. Provenance `apk`.
   */
  LOITERING_DETECTION: 2706,
  /**
   * Detection sensitivity on the inverted seven-step camera scale (app `APP_CMD_SET_PIRSENSITIVITY`).
   * Reported by nine camera families but only accepted by the one whose reported value falls on its
   * seven-step ladder, which is how the scale is resolved without consulting the model.
   */
  CAMERA_PIR_SENSITIVITY: 1210,
  /**
   * Detection sensitivity an indoor camera reports AND accepts (app `INDOOR_MOTION_DETECTION_SENSITIVITY`),
   * as a `1700` control payload carrying an index rather than the `1350` envelope its siblings take.
   */
  INDOOR_SENSITIVITY_INDEX: 6041,
  /**
   * Detection sensitivity a solo camera REPORTS (app `SET_MOTION_DETECTION_SENSITIVITY_SOLO`). It does
   * not accept writes on this id — the write goes to {@link MOTION_SENSITIVITY}, which is why a scale
   * carries a read id and a write id separately.
   */
  SOLO_SENSITIVITY: 6070,
} as const;

/**
 * AI detection type bits — the `ai_detect_type` bitmask, decoded on-device and cross-checked against
 * the app. `enabledBase` (0x30000) is the "AI detection on" flag, set on every camera and always OR'd
 * into a value. `humanRecognition` (face) and `humanDetection` always co-occur in observed data; the app
 * lists them in this order. (Some indoor cams set extra high bits — sound/crying — not modelled here.)
 */
export const AiDetectType = {
  /** "AI detection enabled" base — always present in a valid value. */
  enabledBase: 0x30000,
  humanRecognition: 0x1,
  humanDetection: 0x2,
  vehicle: 0x4,
  pet: 0x8,
} as const;

/**
 * Evidence a device is in the population that issues the AI-detection ids at all: it is a camera.
 *
 * 3101-3110 are drawn from the doorbell, indoor and HB3-paired vocabularies, every one of them a
 * camera family. A standalone motion sensor binds this capability — it IS motion detection by device
 * type — but announces itself under {@link CusPushEvent.MOTION_SENSOR_PIR}, and reports no AI
 * classification of any kind.
 */
const CAMERA_AI_CLAIM: EventClaim = { codecs: ["camera"] };

/**
 * Evidence a device classifies vehicles: it reports the AI-detection-type bitmask that HAS a vehicle
 * bit ({@link AiDetectType} bit2, decoded live and confirmed against the app).
 *
 * The push id cannot carry this. 3107 is `VEHICLE_DETECTION` in the doorbell, indoor and
 * HB3-paired vocabularies alike — the integer is the vendor's meaning for the classification, not a
 * statement that a given unit performs it. The type parameter is the one signal a unit reports about
 * itself, so its absence is the only honest evidence available, and it is the same bar the typed read
 * of that bitmask already answers to. A camera that starts reporting the parameter starts announcing
 * the event with it.
 */
const VEHICLE_CLAIM: EventClaim = { ...CAMERA_AI_CLAIM, reads: ["aiDetectType"] };

/**
 * Evidence a device classifies dogs: it hangs off a station.
 *
 * 3108/3109/3110 are declared in {@link HB3PairedDevicePushEvent} and in no other family's
 * vocabulary, so a unit that stands alone is not in the population that issues them. Attachment to
 * ANY station is the gate rather than to a HomeBase 3 specifically: the coarser test keeps the event
 * on an attached camera whose station generation is not established, which is the direction that
 * cannot lose a real detection.
 */
const DOG_CLAIM: EventClaim = { ...CAMERA_AI_CLAIM, homeBaseAttached: true };

/** Bound motion controls — the object returned by `dev.motion()`. */
export type MotionActions = Surface<typeof MOTION_MEMBERS> & {
  /** How many steps this device's picker offers, or `undefined` when its scale is not known. */
  sensitivitySteps(): number | undefined;
  /**
   * Current detection-sensitivity step, 1 being the least sensitive.
   *
   * Resolved through the same scale the write uses, because the id a device reports this on differs
   * between scales and several devices report more than one of them — so a caller reading the raw
   * param would have to know which one counts, and in which direction. `undefined` when the device has
   * not reported yet, or reports a value no known ladder contains.
   */
  sensitivityStep(): number | undefined;
  /**
   * Set the detection-sensitivity step, from 1 (least sensitive) up to `sensitivitySteps`.
   *
   * A step, not a device value: the five device families this is captured on use four different
   * command ids, three frame shapes and two opposite numeric directions, so a raw number means the
   * opposite thing depending on what it is sent to. Step 1 is always the least sensitive.
   *
   * Rejects a step outside the device's own range, and throws for a model whose scale has not been
   * captured — a wrong id is a fire-and-forget no-op that would otherwise look like it worked.
   */
  setSensitivityStep(step: number): Promise<void>;
};

/**
 * One detection-sensitivity scale: the param it is reported on, the wire it is written to, and the
 * value per step with the LEAST sensitive first.
 *
 * `readParam` is not always `writeId`: a solo camera reports 6070 and accepts 1276.
 */
interface SensitivityScale {
  readParam: number;
  readProperty: string;
  writeId: number;
  form: "payload" | "direct" | "control";
  ladder: readonly number[];
}

/**
 * The scales, recognised by what a device REPORTS rather than by its model.
 *
 * Keying this on model would mean editing the SDK for every new device, which is the opposite of what
 * an SDK is for. Each entry instead states the evidence that identifies it, so a device nobody has
 * seen is driven correctly the moment it reports a scale already described here.
 *
 * Order matters, and the first two entries are why. A T8114 and a doorbell report the SAME three ids
 * (1276, 1210, 6041) yet accept different ones, so presence alone cannot separate them — but their
 * VALUES can: a T8114's 1210 always holds one of its seven ladder values, while a doorbell's holds
 * something outside it. So a scale whose ladder is distinctive is matched on the value, and only then
 * do the identity-ladder scales fall back to which id is present at all.
 *
 * ✅ Every ladder captured live 2026-08-03 from the app sweeping its own picker step by step.
 *
 * KNOWN GAP. The app's own parser carries a FOURTH camera table for this setting — three sparse steps
 * emitting 1, 3 and 5 — and those values sit INSIDE the identity ladder below, so a device on it would
 * be resolved here as a five-step scale and would accept steps 2 and 4 that its picker never emits.
 * Being a fire-and-forget write, that would look like it worked. It is left unhandled deliberately: no
 * device class in the disassembled app instantiates that table for sensitivity (only for a recording
 * setting), so it is either dead code or belongs to a module absent from the artifact — and nothing
 * observable would separate such a device from the identity scale anyway, since both are read and
 * written on the same id. Closing it needs a capture from a device actually on it.
 */
const SENSITIVITY_SCALES: readonly SensitivityScale[] = [
  /** Standalone PIR sensor: five steps counting DOWN. */
  {
    readParam: MOTION_CMD.SENSOR_PIR_SENSITIVITY,
    readProperty: "sensorPirSensitivity",
    writeId: MOTION_CMD.SENSOR_PIR_SENSITIVITY,
    form: "direct",
    ladder: [80, 53, 37, 18, 8],
  },
  /** A camera family whose seven steps also count down, on an id others report but do not use. */
  {
    readParam: MOTION_CMD.CAMERA_PIR_SENSITIVITY,
    readProperty: "pirSensitivityRaw",
    writeId: MOTION_CMD.CAMERA_PIR_SENSITIVITY,
    form: "direct",
    ladder: [192, 118, 72, 46, 30, 20, 14],
  },
  /** Solo cameras: report their own id, accept the shared one in a payload envelope, seven rising steps. */
  {
    readParam: MOTION_CMD.SOLO_SENSITIVITY,
    readProperty: "soloSensitivity",
    writeId: MOTION_CMD.MOTION_SENSITIVITY,
    form: "payload",
    ladder: [1, 2, 3, 4, 5, 6, 7],
  },
  /** Reports the setting on the id it also accepts, five rising steps. */
  {
    readParam: MOTION_CMD.MOTION_SENSITIVITY,
    readProperty: "motionSensitivity",
    writeId: MOTION_CMD.MOTION_SENSITIVITY,
    form: "payload",
    ladder: [1, 2, 3, 4, 5],
  },
  /** Indoor cameras: a control-payload wrapper carrying an index, five rising steps. */
  {
    readParam: MOTION_CMD.INDOOR_SENSITIVITY_INDEX,
    readProperty: "indoorSensitivity",
    writeId: MOTION_CMD.INDOOR_SENSITIVITY_INDEX,
    form: "control",
    ladder: [1, 2, 3, 4, 5],
  },
];

/**
 * Whether a scale's ladder is its own fingerprint — a value from it identifies the scale, because no
 * other scale here contains those numbers. An identity ladder (1..N) is shared, so it identifies
 * nothing and its scale is matched on which id the device reports instead.
 */
function isDistinctive(scale: SensitivityScale): boolean {
  return scale.ladder.some((v) => v > scale.ladder.length);
}

/**
 * The scale a device is on, from the params it reports. `undefined` when it reports none of them, or
 * reports only ids whose value contradicts every scale that claims them.
 *
 * A distinctive ladder is matched on the reported VALUE, so a device that merely mirrors someone
 * else's id is not mistaken for it. The rest match on the id being present at all.
 */
function scaleFor(ctx: CommandContext, read?: CapabilityStateReader): SensitivityScale | undefined {
  const value = (scale: SensitivityScale) => read?.(scale.readProperty)?.value;
  for (const scale of SENSITIVITY_SCALES) {
    if (!isDistinctive(scale)) continue;
    const v = value(scale);
    if (v !== undefined && v !== null && scale.ladder.includes(Number(v))) return scale;
  }
  return SENSITIVITY_SCALES.find((scale) => !isDistinctive(scale) && ctx.paramIds.has(scale.readParam));
}

/** Named AI detection types, for {@link encodeAiDetectType} / {@link decodeAiDetectType}. */
export interface AiDetectFlags {
  humanRecognition?: boolean;
  humanDetection?: boolean;
  vehicle?: boolean;
  pet?: boolean;
}

/** Encode named detection types → the `ai_detect_type` bitmask (always includes the enabled base). */
export function encodeAiDetectType(flags: AiDetectFlags): number {
  let v = AiDetectType.enabledBase;
  if (flags.humanRecognition) v |= AiDetectType.humanRecognition;
  if (flags.humanDetection) v |= AiDetectType.humanDetection;
  if (flags.vehicle) v |= AiDetectType.vehicle;
  if (flags.pet) v |= AiDetectType.pet;
  return v;
}

/** Decode an `ai_detect_type` bitmask → which detection types are on. */
export function decodeAiDetectType(value: number): AiDetectFlags {
  return {
    humanRecognition: !!(value & AiDetectType.humanRecognition),
    humanDetection: !!(value & AiDetectType.humanDetection),
    vehicle: !!(value & AiDetectType.vehicle),
    pet: !!(value & AiDetectType.pet),
  };
}

/**
 * Build the `SET_SNOOZE_TIME` (1271) JSON body (see `MOTION_CMD.SNOOZE_TIME` for the capture
 * citation). `seconds<=0` sends the bare captured "clear" shape (`{snooze_time:0}`, no extra fields —
 * matches the real clear/cancel frame byte-for-byte). A positive duration sends the exact
 * `chime_onoff`/`homebase_onoff`/`motion_notify_onoff` VALUES from the live capture's 2nd real write
 * (fixed, not exposed as options — their semantics aren't independently confirmed enough to make
 * configurable without risking a wrong guess on a fire-and-forget write) plus a fresh `startTime`
 * (the app sends "now", not the original capture's timestamp).
 */
function snoozePayload(seconds: number): Record<string, unknown> {
  if (seconds <= 0) return { snooze_time: 0 };
  return {
    snooze_time: Math.round(seconds),
    startTime: Math.floor(Date.now() / 1000),
    chime_onoff: 0,
    homebase_onoff: 0,
    motion_notify_onoff: 1,
  };
}

/**
 * Read the active snooze duration out of the reported `MOTION_CMD.SNOOZE_TIME` value.
 *
 * 1271 reports the whole snooze config, not a bare duration — the same `{snooze_time,startTime,…}` shape
 * `snoozePayload` writes, delivered base64+json and decoded to an object on ingest. The seconds are
 * one field inside it, which no `bool`/`number`/`string` narrowing of the stored value can reach: the
 * property's own type describes the config, so the duration is derived here instead. `undefined` when the
 * device has not reported one, or reports a shape without a numeric `snooze_time`.
 */
function decodeSnoozeSeconds(raw: ParamValue | undefined): number | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const seconds = (raw as Record<string, unknown>).snooze_time;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Build the `snoozeTime` write, or `undefined` if `value` isn't a valid duration. Shared by
 * `buildCommand` and `actions().setSnoozeTime` so the two can't drift — a non-finite value (`NaN`/
 * `Infinity`) would otherwise serialize as `null` on this fire-and-forget wire and look like it
 * worked, and a negative would silently take the `seconds<=0` "clear" branch instead of being
 * refused.
 */
function snoozeCommand(value: unknown, ctx: CommandContext): Command | undefined {
  const v = Number(value);
  return Number.isFinite(v) && v >= 0 ? setJsonRaw(MOTION_CMD.SNOOZE_TIME, snoozePayload(v), ctx) : undefined;
}

/**
 * Build the sensitivity write for a step on a resolved scale, or `undefined` when the step is not one
 * that scale offers.
 *
 * The frame shape comes from the device's scale, not from the value: an indoor camera takes a
 * control-payload carrying an index, a doorbell or solo camera a `1350` payload naming the setting, a
 * T8114 or a PIR sensor a direct scalar. Shared by the property write and the fluent call so the two
 * cannot drift.
 */
function sensitivityCommand(step: unknown, scale: SensitivityScale, ctx: CommandContext): Command | undefined {
  const n = Number(step);
  if (!Number.isInteger(n) || n < 1 || n > scale.ladder.length) return undefined;
  const value = scale.ladder[n - 1]!;
  if (scale.form === "direct") return setScalar(scale.writeId, value, ctx, "direct-binary");
  if (scale.form === "control") return setJson(scale.writeId, { index: value }, ctx);
  return setPayload(scale.writeId, { sensitivity: value, channel: ctx.channel }, ctx, 0, undefined, "auto");
}

/**
 * The value the app puts in the exit frame's value slot, replayed byte-for-byte.
 *
 * Its meaning is unknown: the slot holds `00 30 30 30` where the sibling sensitivity command carries a
 * plain integer, and the account-id field that follows is unaffected. Replaying the observed bytes is
 * verified to work; a plain `0` returns the same result code but was only ever sent to a sensor
 * already out of the mode, so it is not known to work and is not what ships.
 */
const EXIT_TEST_MODE_VALUE = 0x30303000;

/**
 * Reject a write on a device family its wire was never captured on.
 *
 * The two families do not share this capability's wire vocabulary: the one setting captured on both
 * answers a different id on each (see `MOTION_CMD.SENSOR_PIR_SENSITIVITY`), and the test-mode
 * pair exists only on sensors. Since P2P writes are fire-and-forget, a frame sent to the wrong family
 * is silently dropped while the call reports success — so an unverified pairing throws instead.
 */
function requireFamily(action: string, ctx: CommandContext, verifiedOn: "camera" | "sensor"): void {
  const isSensor = ctx.codec === "sensor";
  if (isSensor === (verifiedOn === "sensor")) return;
  throw new Error(
    `motion: ${action} write wire is verified only on a ${verifiedOn}, not this device [${describeDevice(ctx)}]`,
  );
}

/**
 * Decode a `radar_wd_switch` (2706, loitering) read the way the app does:
 * `typeof v === "object" ? v.radar_wd_switch : v`. The device may store it as a JSON object
 * `{radar_wd_switch,…}` OR a bare scalar, so a plain bool coercion mis-reads the object form as
 * `false` (see `MOTION_CMD.LOITERING_DETECTION`). Returns `undefined` for an unreadable value
 * rather than guessing.
 * @internal
 */
export function decodeRadarWdSwitch(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string" || raw === "") return undefined;
  const s = raw.trim();
  if (s.startsWith("{")) {
    try {
      const v = (JSON.parse(s) as { radar_wd_switch?: unknown }).radar_wd_switch;
      return v === undefined ? undefined : asBool(v);
    } catch {
      return undefined;
    }
  }
  return asBool(s);
}

/**
 * `motion` — PIR / motion detection. `motionDetection` (1011), `motionSensitivity` (see
 * `MOTION_CMD.MOTION_SENSITIVITY`), and `snoozeTime` (see `MOTION_CMD.SNOOZE_TIME`) are
 * all verified: read AND write.
 */
/**
 * Every `motion` feature, declared once — the property schema, the typed getters, the derived setters,
 * the intent routes and the descriptions all come out of this table.
 *
 * The four raw sensitivity params are read-only members: each family reports its ladder under a
 * DIFFERENT id and two of them run inverted, so the meaningful value is the STEP, resolved across
 * all four by the methods in `actions()`. They stay in the schema because the device reports them and a
 * diagnosis may want the raw number.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const MOTION_MEMBERS = {
  /**
   * The master motion/PIR switch. `writeAs` names the setter `setDetection` rather than the
   * `setDetectionEnabled` the key would derive. The write calls `requireFamily` first, because
   * this frame is captured on cameras only and a P2P write is fire-and-forget — sent to a sensor it
   * would be dropped silently while the call reported success, so it throws instead.
   */
  detectionEnabled: {
    param: 1011,
    property: "motionDetection",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description: "Motion/PIR detection enabled (verified: param 1011 = CAMERA_PIR).",
    write: (v, ctx) => {
      requireFamily("motionDetection", ctx, "camera");
      return setScalar(MOTION_CMD.CAMERA_PIR, asBool(v) ? 1 : 0, ctx, "direct-binary");
    },
    writeAs: "setDetection",
  },
  /**
   * First of the four raw sensitivity params, all `unexposed`: reported, so they stay in the schema and
   * answer through `getProperty` for a diagnosis, but given no typed getter because a raw number here
   * means nothing on its own — each family reports its ladder under a different id and two run
   * inverted. The meaningful value is the STEP, resolved across all four by `sensitivityStep()` in
   * `actions()`. This id is both the read and the write for the five-step rising scale.
   */
  motionSensitivity: {
    param: MOTION_CMD.MOTION_SENSITIVITY,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    unexposed: true,
    description:
      "Motion sensitivity, raw wire value (1-indexed; the app's own picker UI is 0-indexed — see " +
      "MOTION_CMD.MOTION_SENSITIVITY). ✅ Write wire-confirmed live on T8170 (observed 1 and 7).",
  },
  /**
   * 1298 holds the detailed AI-type BITMASK (live-observed: `0x30000` enabled-base | type bits, e.g. a
   * T8425 reads `0x3000f`). Cams also report 1299 (`hbAiDetectType`) but that is a separate, simpler
   * value (1) — NOT this bitmask, so 1298 is the read/write id.
   */
  aiDetectType: {
    param: MOTION_CMD.AI_DETECT_TYPE,
    type: "number",
    kind: "bitfield",
    provenance: "verified",
    description:
      "AI detection type bitmask — which classes trigger detection. ✅ Bits decoded live + confirmed " +
      "vs the app: 0x30000 = enabled base, bit0 = human recognition, bit1 = human detection, bit2 = " +
      "vehicle, bit3 = pet (see AiDetectType / encodeAiDetectType). ✅ WRITE HW-verified live on T8124 " +
      "(1350 SET_PAYLOAD, {ai_detect_type, channel}): each write landed byte-exact + read back " +
      "(0x30003 → 0x8 → 0x3000b).",
    write: (v, ctx) => {
      requireFamily("aiDetectType", ctx, "camera");
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return undefined;
      return setPayload(MOTION_CMD.AI_DETECT_TYPE, { ai_detect_type: n, channel: ctx.channel }, ctx, 0, 0, "auto");
    },
  },
  /**
   * The raw sensitivity a solo camera REPORTS — and only reports: its scale writes to
   * `MOTION_CMD.MOTION_SENSITIVITY` instead, which is why `SensitivityScale` carries a read id and
   * a write id separately. `unexposed` like its three siblings; read the resolved step instead.
   */
  soloSensitivity: {
    param: MOTION_CMD.SOLO_SENSITIVITY,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    unexposed: true,
    description: "Raw sensitivity a solo camera reports (verified: param 6070).",
  },
  /**
   * The raw sensitivity an indoor camera reports, on the one id whose write takes a `1700` control
   * payload carrying an index rather than the `1350` envelope its siblings use — a frame-shape
   * difference `sensitivityCommand` resolves from the scale. `unexposed` like its three siblings.
   */
  indoorSensitivity: {
    param: MOTION_CMD.INDOOR_SENSITIVITY_INDEX,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    unexposed: true,
    description: "Raw sensitivity an indoor camera reports (verified: param 6041).",
  },
  /**
   * The raw sensitivity on the INVERTED seven-step camera scale — a HIGHER number is LESS sensitive, so
   * this is the member where reading the number as a level gets the direction backwards. Nine camera
   * families report 1210 and only the one whose value lands on that ladder accepts it, which is how
   * `scaleFor` tells them apart without consulting the model. `unexposed`; read the step instead.
   */
  pirSensitivityRaw: {
    param: MOTION_CMD.CAMERA_PIR_SENSITIVITY,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    unexposed: true,
    description: "Raw sensitivity reported on the inverted seven-step scale (verified: param 1210).",
  },
  /**
   * The raw sensitivity a standalone PIR sensor reports, on its own inverted five-step ladder — the
   * sensor-side counterpart to the camera's 1276, kept apart because sending a camera's id to a sensor
   * is a fire-and-forget no-op that looks like success. The number is not the app's picker index (see
   * `MOTION_CMD.SENSOR_PIR_SENSITIVITY`), which is exactly why it is `unexposed`.
   */
  sensorPirSensitivity: {
    param: MOTION_CMD.SENSOR_PIR_SENSITIVITY,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    unexposed: true,
    description: "Raw sensitivity a standalone PIR sensor reports (verified: param 1609, inverted ladder).",
  },
  /**
   * A standalone motion sensor's user test mode — the ONLY state in which such a sensor reports
   * detections over P2P; outside it, detections arrive on the push path. `realtime` is deliberately NOT
   * set: the id never appears in the cloud record, so the getter arrives only once the station has
   * reported it.
   *
   * The write is the one asymmetric pair here — enter is a `1350` payload carrying the channel, leave is
   * a direct-binary frame, and each is refused in the other's shape. Sensor-family only; a camera
   * throws via `requireFamily`.
   */
  testMode: {
    param: MOTION_CMD.SENSOR_WORK_MODE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "Whether a standalone motion sensor is in the app's user test mode — the only state in which it " +
      "reports detections over P2P. ✅ Observed live on a T8910 both ways. P2P-only: the cloud record " +
      "never carries this id, so it is present once the station has reported it and absent before that.",
    write: (v, ctx) => {
      requireFamily("setTestMode", ctx, "sensor");
      return asBool(v)
        ? setPayload(MOTION_CMD.SENSOR_ENTER_TEST_MODE, { channel: ctx.channel }, ctx)
        : setScalar(MOTION_CMD.SENSOR_EXIT_TEST_MODE, EXIT_TEST_MODE_VALUE, ctx, "direct-binary");
    },
  },
  /**
   * Seconds of notification silence remaining, `0` for none — and the reason this member has both a
   * `type: "string"` and a `decode`: the device reports the whole snooze CONFIG, so the stored property
   * describes the blob while `decodeSnoozeSeconds` lifts the duration out of it on read. The
   * `decode`'s return type is what a caller gets, so the getter answers a number.
   *
   * Writing a positive duration re-sends the capture's fixed companion fields rather than exposing them
   * (`snoozePayload`); writing 0 sends the bare clear shape. Camera-family only.
   */
  snoozeTime: {
    param: MOTION_CMD.SNOOZE_TIME,
    type: "string",
    provenance: "verified",
    min: 0,
    decode: (raw) => decodeSnoozeSeconds(raw as ParamValue | undefined),
    decodedKind: "seconds",
    description:
      "Active snooze window in seconds, 0 = none. The device reports the whole snooze CONFIG base64+json; " +
      "the duration is lifted out of it on read.",
    write: (v, ctx) => {
      requireFamily("snoozeTime", ctx, "camera");
      return snoozeCommand(v, ctx);
    },
  },
  /**
   * Not every model offers it, and one that does not accepts the frame without acting on it — so the
   * write is offered only where the device reports the id, and the surface says it is optional.
   */
  humanOnlyAtNight: {
    param: MOTION_CMD.HUMAN_ONLY_AT_NIGHT,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description:
      "Restrict AI classification to night-time only (1719). ⚠️ Replay + readback confirmed on a " +
      "HomeBase-attached T8425, not byte-captured.",
    requires: [MOTION_CMD.HUMAN_ONLY_AT_NIGHT],
    write: (v, ctx) => {
      requireFamily("humanOnlyAtNight", ctx, "camera");
      return setPayload(MOTION_CMD.HUMAN_ONLY_AT_NIGHT, { only_ai: asBool(v) ? 1 : 0 }, ctx, 0, undefined, "auto");
    },
  },
  /**
   * The app reads it as `typeof v === "object" ? v.radar_wd_switch : v`, so the stored value may be a
   * JSON object OR a bare scalar — a plain bool coercion reports `false` for the object form.
   */
  loiteringDetection: {
    param: MOTION_CMD.LOITERING_DETECTION,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    coerce: (raw) => decodeRadarWdSwitch(raw) ?? false,
    description:
      "Loitering detection — alert on lingering rather than passing (2706). Observed on the T8214 " +
      "doorbell only; the read is object-OR-scalar, matching the app's own decode.",
    requires: [MOTION_CMD.LOITERING_DETECTION],
    write: (v, ctx) => {
      requireFamily("loiteringDetection", ctx, "camera");
      return setPayload(
        MOTION_CMD.LOITERING_DETECTION,
        { radar_wd_switch: asBool(v) ? 1 : 0 },
        ctx,
        0,
        undefined,
        "auto",
      );
    },
  },
} as const satisfies Members;

export const MOTION: CapabilityModule = {
  capability: "motion",
  description: "Passive-infrared / motion detection switch and sensitivity (live state via push).",
  members: MOTION_MEMBERS,
  properties: propertiesOf(MOTION_MEMBERS),
  /**
   * Only the sensitivity STEP, which no member can hold: the five families this is captured on report
   * their ladder under four different ids and two of them run inverted, so the step is resolved across
   * all of them rather than read off one param.
   *
   * Every camera-only wire in the member table refuses on a standalone sensor through
   * `requireFamily`, in the one place the wire is now declared — so the property path and the
   * fluent setter are guarded by the same check instead of two copies of it.
   */
  actions({ ctx, sink, read }: MemberDeps): CapabilityActions {
    return {
      sensitivitySteps: () => scaleFor(ctx, read)?.ladder.length,
      sensitivityStep: () => {
        const scale = scaleFor(ctx, read);
        const raw = scale && read?.(scale.readProperty)?.value;
        const at = raw === undefined || raw === null ? -1 : (scale?.ladder.indexOf(Number(raw)) ?? -1);
        return at < 0 ? undefined : at + 1;
      },
      setSensitivityStep: (step: number) => {
        const scale = scaleFor(ctx, read);
        if (!scale) {
          return Promise.reject(
            new Error(`motion: no captured sensitivity scale for this device [${describeDevice(ctx)}]`),
          );
        }
        const cmd = sensitivityCommand(step, scale, ctx);
        return cmd
          ? sink.dispatch(cmd)
          : Promise.reject(
              new Error(`motion: sensitivity step ${JSON.stringify(step)} must be 1..${scale.ladder.length}`),
            );
      },
    };
  },

  /**
   * Land the sensor's own work-mode report as readable state.
   *
   * The station answers a test-mode write with `{cmd:1612,payload:{workmode:n}}`, which is a bare
   * value rather than the `params` array the transport unwraps generically — so without this the mode
   * is announced on the wire and never reaches `testMode`. Reported as the same id
   * the property declares, so the read installs on the evidence the device itself provided.
   */
  decodeState(signal: InboundSignal): DecodedState | null {
    if (signal.source !== "p2p-frame" || signal.json?.cmd !== MOTION_CMD.SENSOR_WORK_MODE) return null;
    const mode = (signal.json.payload as { workmode?: unknown } | undefined)?.workmode;
    return mode == null ? null : { params: { [MOTION_CMD.SENSOR_WORK_MODE]: String(mode) } };
  },
  /**
   * A reported PIR switch (1011) proves it; glass-break is an acoustic motion-class event; every
   * camera-codec device has motion in its baseline surface; and a standalone motion sensor IS the
   * capability by device type — it reports no 1011, so evidence alone would miss the one device class
   * named after the feature.
   */
  detection: {
    evidenceParams: [1011],
    modelHints: [/glass/i],
    codecs: ["camera"],
    deviceTypes: [DeviceType.MOTION_SENSOR, DeviceType.PIR_SENSOR_E20],
  },
  /**
   * Inbound FCM motion pushes → `"motion"`: 3101 is camera-family AI motion
   * (`DoorbellPushEvent`/`IndoorPushEvent.MOTION_DETECTION`), 14 is a standalone PIR motion sensor
   * (`CusPushEvent.MOTION_SENSOR_PIR`) — verified live on a T8910.
   *
   * Inbound detection pushes. Each kind gets its OWN event name rather than one `motion` event with a
   * discriminator: they are separate detections, the same shape the existing pet/package events follow.
   *
   * The camera families share these ids (indoor, doorbell and hub-paired all use the same integers for
   * the same meaning), so one row per id covers every family.
   */
  events: [
    { source: "push", match: DoorbellPushEvent.MOTION_DETECTION, emit: "motion" },
    { source: "push", match: CusPushEvent.MOTION_SENSOR_PIR, emit: "motion" },
    { source: "push", match: IndoorPushEvent.CRYING_DETECTION, emit: "cryingDetected", claim: CAMERA_AI_CLAIM },
    { source: "push", match: IndoorPushEvent.SOUND_DETECTION, emit: "soundDetected", claim: CAMERA_AI_CLAIM },
    { source: "push", match: IndoorPushEvent.PET_DETECTION, emit: "petDetection", claim: CAMERA_AI_CLAIM },
    { source: "push", match: DoorbellPushEvent.VEHICLE_DETECTION, emit: "vehicleDetected", claim: VEHICLE_CLAIM },
    { source: "push", match: HB3PairedDevicePushEvent.DOG_DETECTION, emit: "dogDetected", claim: DOG_CLAIM },
    {
      source: "push",
      match: HB3PairedDevicePushEvent.DOG_LICK_DETECTION,
      emit: "dogDetected",
      payload: { kind: "lick" },
      claim: DOG_CLAIM,
    },
    {
      source: "push",
      match: HB3PairedDevicePushEvent.DOG_POOP_DETECTION,
      emit: "dogDetected",
      payload: { kind: "poop" },
      claim: DOG_CLAIM,
    },
  ],
};
