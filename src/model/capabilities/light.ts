import { asBool, clamp } from "../../core/util.js";
import { DeviceType } from "../device-types.js";
import { WALL_LIGHT_TYPES } from "../device-family.js";
import { setScalar, setJson, setPayload, describeDevice } from "./access.js";
import type { CapabilityModule, CapabilityActions, CommandContext } from "./types.js";
import { propertiesOf, type Members, type Surface, type MemberDeps } from "./members.js";
import type { Command } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this light capability drives. Capability-owned wire vocabulary —
 * the transport forwards `cmd.param` opaquely and never names them (full id→name catalog in the
 * generated `transport/p2p/commands.ts`).
 */
export const LIGHT_CMD = {
  /** Spotlight momentary on/off; `{time,type,value}` under 1700. ✅ Verified via P2P state readback (3/3). */
  FLOODLIGHT_SWITCH: 1400,
  /**
   * Spotlight brightness 1..100. ✅ SOLVED & verified live (T8425 + T8124): direct-binary command,
   * 136-byte struct `[u32 ch][u32 value][account_id pad→128]` (value = raw 1..100), NOT a JSON wrapper.
   */
  SPOTLIGHT_BRIGHTNESS: 1401,
  /** Spotlight master enable — distinct from the on/off switch. ✅ Verified live T8124 (same 136-byte direct-binary struct as brightness). */
  SPOTLIGHT_ENABLE: 1403,
  /** Spotlight color temperature 0=warm..100=cool. ✅ Verified live T8124 (only tunable-white spotlights respond; T8425 is white-only). */
  SPOTLIGHT_COLOR_TEMP: 1410,
  /**
   * Auto-spotlight = "motion-activated light" — light up when motion fires. ✅ Wire reversed from a live
   * OUTBOUND P2P capture + replay-verified on T8425 (ch3, 2026-07-13, ON+OFF): the real command
   * is **cmd 1422**, carried in a `1350` SET_PAYLOAD envelope on the DEVICE channel (mChannel = device
   * channel, mValue3 0), with a COMPOSITE payload — NOT a bare bool:
   *   `{brightness:0..100, enable:0|1, latitude:"", longtitude:"" (sic), mode:1, schedule:[], sunset2rise:0, time}`
   * `enable` is the on/off; `time` = auto-off seconds; `mode`/`schedule`/`sunset2rise` are the scheduling
   * knobs. See {@link AutoSpotlightOptions}.
   * NB: the app-JS constant `APP_CMD_SET_LIGHT_CTRL_PIR_SWITCH` (1408) is a RED HERRING for this device —
   * the T8425 never emits 1408; three 1408 wire attempts all no-op'd. (No `1408` constant is defined — it's
   * dead; do not add one.)
   */
  MOTION_ACTIVATE_LIGHT: 1422,
} as const;

/**
 * Tunables for the "motion-activated light" (auto-spotlight): the spotlight lights up when the camera
 * detects motion. The device takes the WHOLE config on every write — there's no isolated on/off — so
 * these carry the scheduling knobs alongside the enable flag. Defaults mirror the app's; the current
 * values can't be read back, so any field left unset is written as its default rather than preserved.
 */
export type AutoSpotlightOptions = {
  /** Spotlight brightness 1..100 when it triggers (default 50). */
  brightness?: number;
  /** Auto-off timer in seconds after the light triggers (default 30). */
  time?: number;
  /** Scheduling mode (default 1). */
  mode?: number;
};

/**
 * Bound spotlight / floodlight controls — the object returned by `dev.light()`.
 *
 * The reads and their setters are DERIVED from `LIGHT_MEMBERS`: one declaration per feature gives
 * the getter, the setter, its argument type and its description. Only what a member table cannot state
 * is written out below.
 */
export type LightActions = Surface<typeof LIGHT_MEMBERS> & {
  /** Turn the light on. Throws if this model's switch wire is unverified. */
  on(): Promise<void>;
  /** Turn the light off. Throws if this model's switch wire is unverified. */
  off(): Promise<void>;
  /**
   * Enable/disable the **motion-activated light** (auto-spotlight): the spotlight lights up when the
   * camera detects motion.
   *
   * ⚠️ This is a COMPOSITE write, and it is WRITE-ONLY: the setting is not reported back in the device's
   * params, so the current config cannot be read and merged. Calling it with just `on` re-sends the
   * DEFAULT brightness/auto-off/mode ({@link AutoSpotlightOptions}), overwriting whatever the user set.
   * To preserve their config, pass the current values in `opts`. That is why this is a method and not a
   * member — the caller must own the composite.
   */
  setAutoSpotlight(on: boolean, opts?: AutoSpotlightOptions): Promise<void>;
};

/**
 * Manual spotlight brightness range. `0` would read as "off", so the device wants a positive level.
 * Every clamp and the published argument range read from here — a second copy of a range stays
 * individually valid while drifting from the one actually enforced.
 */
const BRIGHTNESS_MIN = 1;
const BRIGHTNESS_MAX = 100;

/**
 * Build the SET_PAYLOAD command for the motion-activated light (1422). The device wants the FULL composite
 * config every time (see {@link AutoSpotlightOptions}); `enable` is the on/off. The captured frame sends
 * mChannel = device channel + mValue3 0 with no channel inside the payload — so `setPayload(..., 0)` leaves
 * `channel` at ctx.channel. Vendor's key `longtitude` is misspelled on the wire; we match it exactly.
 */
function autoSpotlightCommand(on: boolean, ctx: CommandContext, opts: AutoSpotlightOptions = {}): Command {
  return setPayload(
    LIGHT_CMD.MOTION_ACTIVATE_LIGHT,
    {
      brightness: clamp(Number(opts.brightness ?? 50), BRIGHTNESS_MIN, BRIGHTNESS_MAX),
      enable: on ? 1 : 0,
      latitude: "",
      longtitude: "",
      mode: opts.mode ?? 1,
      schedule: [],
      sunset2rise: 0,
      time: opts.time ?? 30,
    },
    ctx,
    0,
    undefined,
    "auto",
  );
}

/**
 * `light` — floodlight / spotlight / status LED. Switch is param 1400, brightness 1401.
 *
 * ## Command variance (absorbed here, not by the consumer)
 * The consumer calls `device.light.on()` / `.setBrightness(50)` and never learns the wire. This
 * module emits transport-neutral intents (`setJson` / `setScalar`); the transport resolver picks the
 * encryption level. The one thing it DOES decide is the switch's *frame shape* — a firmware trait
 * that is not session-derivable: JSON control-payload vs int+string, from {@link lightSwitchWire}
 * (in `../device-family`, shared with other capabilities).
 */

/**
 * The floodlight/spotlight **switch** (1400) frame SHAPE for a device family, or `undefined` when the
 * model's wire form is unknown (don't guess — the caller throws). This is a SEMANTIC per-family fact
 * of the light switch, so it lives here in the `light` capability (composed off `DeviceType`), not in
 * the shared family classifier. Provisional split, to be confirmed against the decompiled V6 app /
 * a confirmed exchange:
 *  - `"json"`: JSON control-payload (`{commandType:1400,data:{time,type,value}}` under 1700) —
 *    FLOODLIGHT_8425, wall-light cams, indoor pan/tilt (31/35) and CAMERA_4G_S330.
 *  - `"int-string"`: level-1 int+string — indoor/outdoor 1080p/2K siblings, outdoor-PT/solo-E30,
 *    and the Cam2C/Cam2/Cam3 families.
 * NOTE: this is FRAME SHAPE only, not encryption LEVEL. The level (L1 vs L2) is a runtime topology
 * trait resolved at send time — never fixed by family here. The switch shape happens to be L1 for
 * both branches; brightness/colorTemp (below) are a separate, pinned case.
 * The switch WIRE is a vendor-family trait no reported param distinguishes (a T8425 and a T8442
 * both report 1400 yet send it differently — T8442 confirmed int-string by live capture).
 */
function lightSwitchWire(ctx: CommandContext): "json" | "int-string" | undefined {
  const t = ctx.deviceType;
  if (t === undefined) return undefined;
  if (LIGHT_SWITCH_JSON_TYPES.has(t)) return "json";
  if (LIGHT_SWITCH_INT_STRING_TYPES.has(t)) return "int-string";
  return undefined;
}

/**
 * DeviceTypes whose floodlight switch (1400) uses the JSON control-payload wire. The wall-light cams
 * are the whole {@link WALL_LIGHT_TYPES} family (reused from the classifier so a new wall-light model
 * is picked up in one place); the rest are individually wire-confirmed members, not whole families.
 */
const LIGHT_SWITCH_JSON_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.FLOODLIGHT_CAMERA_8425,
  ...WALL_LIGHT_TYPES,
  DeviceType.INDOOR_PT_CAMERA,
  DeviceType.INDOOR_PT_CAMERA_1080,
  DeviceType.CAMERA_4G_S330,
]);

/** DeviceTypes whose floodlight switch (1400) uses the level-1 int+string wire. */
const LIGHT_SWITCH_INT_STRING_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.FLOODLIGHT_CAMERA_8423,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P_NO_LIGHT,
  DeviceType.INDOOR_OUTDOOR_CAMERA_2K,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P,
  DeviceType.OUTDOOR_PT_CAMERA,
  DeviceType.SOLO_CAMERA_E30,
  DeviceType.CAMERA2C,
  DeviceType.CAMERA2,
  DeviceType.CAMERA2_PRO,
  DeviceType.CAMERA2C_PRO,
  DeviceType.CAMERA3,
  DeviceType.CAMERA3C,
]);

/**
 * Resolve the on/off switch command for a device — a JSON control-payload OR a level-1 int+string
 * scalar — or `undefined` if this model's spotlight wire format is unknown (don't guess; let the
 * caller throw). The family→shape mapping is owned by {@link lightSwitchWire}.
 */
function switchCommand(on: boolean, ctx: CommandContext): Command | undefined {
  switch (lightSwitchWire(ctx)) {
    case "json":
      return setJson(LIGHT_CMD.FLOODLIGHT_SWITCH, { time: 0, type: 2, value: on ? 1 : 0 }, ctx);
    case "int-string":
      // Firmware pins these families to the level-1 int+string frame for 1400.
      return setScalar(LIGHT_CMD.FLOODLIGHT_SWITCH, on ? 1 : 0, ctx, "int-string");
    default:
      return undefined; // unknown model wire format — don't guess
  }
}

/**
 * A brightness/color-temp/master-enable intent. Forced to the level-2 `"direct-binary"` frame — the
 * only form captured for these params.
 *
 * TODO(L2-on-standalone): direct-binary needs a level-2 GCM key — standalone indoor/solo/outdoor-PT
 * cams never negotiate one, so these silently fail there (same class as the camera-power bug). Not
 * `"auto"`-downgraded: the level-1 wire for brightness/colorTemp is unconfirmed. Tracked in README
 * "Control-command encryption level".
 */
function directBinary(param: number, value: number, ctx: CommandContext): Command {
  return setScalar(param, value, ctx, "direct-binary");
}

/** DeviceTypes whose spotlight master enable (1403) takes the level-1 int+string frame instead. */
const SPOTLIGHT_ENABLE_INT_STRING_TYPES: ReadonlySet<number> = new Set<number>([DeviceType.FLOODLIGHT_CAMERA_8423]);

/** The master-enable write in the frame this device takes: int+string where listed, else direct-binary. */
function spotlightEnableCommand(on: boolean, ctx: CommandContext): Command {
  const value = on ? 1 : 0;
  if (ctx.deviceType !== undefined && SPOTLIGHT_ENABLE_INT_STRING_TYPES.has(ctx.deviceType)) {
    return setScalar(LIGHT_CMD.SPOTLIGHT_ENABLE, value, ctx, "int-string");
  }
  return directBinary(LIGHT_CMD.SPOTLIGHT_ENABLE, value, ctx);
}

/**
 * The switch frame, or a throw naming the device whose frame shape is unconfirmed.
 *
 * The refusal reason is the model, not the value, and a generated "not a valid value" cannot say that —
 * so the write throws it and `bindMembers` converts it, which keeps the derived `set` and the `on`/`off`
 * verbs beside it refusing with one message instead of two contradictory ones.
 */
function switchFrame(on: boolean, ctx: CommandContext): Command {
  const cmd = switchCommand(on, ctx);
  if (!cmd) throw new Error(`light: unknown spotlight switch wire format — confirm it [${describeDevice(ctx)}]`);
  return cmd;
}

/**
 * Every `light` feature, declared once. The property schema, the typed getters, the derived setters,
 * the intent routes and the descriptions all come out of this table.
 *
 * Auto-spotlight (1422) is deliberately absent: it is a COMPOSITE write — brightness, auto-off, mode
 * and enable sent together — and WRITE-ONLY, so a plain toggle would re-send hardcoded defaults and
 * clobber whatever the user set. It stays the explicit `setAutoSpotlight(on, opts)` method, where the
 * composite is visible at the call site.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LIGHT_MEMBERS = {
  /**
   * Whether the lamp is lit RIGHT NOW — the momentary switch, not a setting. Measured on a T8170: 1400
   * goes to `1` when a client lights the spotlight and back to `0` when that client stops, so the value
   * tracks whoever is streaming rather than a preference anyone set. The vendor app lights the lamp for a
   * live view and drops it on quitting.
   *
   * So it reads on whenever any client is watching. The setting a user changes and expects to persist
   * is {@link spotlightEnabled}.
   *
   * The switch refuses for a reason a value check cannot give — this model's frame SHAPE is unconfirmed —
   * so `switchFrame` throws that reason and `bindMembers` turns it into the rejection, rather than
   * letting the generated "not a valid value" blame a boolean that was never the problem.
   */
  isOn: {
    param: LIGHT_CMD.FLOODLIGHT_SWITCH,
    property: "light",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "Light on/off (1400) — lit right now, not a setting: it follows whichever client is streaming. " +
      "Verified via P2P state readback (3/3); session-scoped behaviour measured live on a T8170.",
    write: (v, ctx) => switchFrame(asBool(v), ctx),
    writeAs: "set",
    aliases: { on: true, off: false },
  },
  /**
   * Manual level for the spotlight, 1-100 — the floor is 1 rather than 0 because a 0 reads as "off" and
   * that is `isOn`'s job. The write is pinned to the level-2 direct-binary frame (`directBinary`),
   * the only shape captured for it, so a standalone camera that never negotiates a level-2 key cannot
   * set it even though the getter reads fine.
   */
  brightness: {
    param: LIGHT_CMD.SPOTLIGHT_BRIGHTNESS,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    min: BRIGHTNESS_MIN,
    max: BRIGHTNESS_MAX,
    description: "Manual brightness, range 1-100 (1401). Verified live (T8425 + T8124).",
    write: (v, ctx) => directBinary(LIGHT_CMD.SPOTLIGHT_BRIGHTNESS, Number(v), ctx),
  },
  /**
   * Warm-to-cool on a 0-100 scale — a `scalar`, not a percentage or a mired value, since 0 is one end
   * of a range rather than "none". `writeOnly`, so there is a setter and no getter at all: the device
   * accepts the setting and never reports it back.
   * Only tunable-white spotlights respond; a white-only model accepts the frame and does nothing.
   */
  colorTemp: {
    param: LIGHT_CMD.SPOTLIGHT_COLOR_TEMP,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    writeOnly: true,
    min: 0,
    max: 100,
    description: "Colour temperature, 0 (warm) to 100 (cool). Not reported back, so it is write-only.",
    write: (v, ctx) => directBinary(LIGHT_CMD.SPOTLIGHT_COLOR_TEMP, Number(v), ctx),
  },
  /**
   * The master enable, one level above {@link isOn}: this decides whether the spotlight may light at all,
   * where `isOn` is the momentary switch. `writeAs` names the setter `setEnabled` rather than the
   * `setSpotlightEnabled` the key would derive, since the capability is already the spotlight.
   *
   * Reported, so it is a read as well as a write. ✅ Verified live on a T8170: the cloud device list
   * carries 1403, and its value tracks the vendor app's spotlight setting in both directions — `1` to `0`
   * when the setting is switched off, `0` to `1` when it is switched back on, so the polarity is direct
   * and 1 means enabled. The poll reports a param only when its PREVIOUS value differed, so the id is in
   * the record rather than newly appearing. The param dictionary names it `floodlightTotalSwitch`
   * (`app:FLOODLIGHT_TOTAL_SWITCH`) and lists the T8170 among its models.
   *
   * This is the switch a user changes and expects to STAY changed. {@link isOn} is a different fact:
   * the lamp being lit right now, driven by whichever
   * client is streaming — the vendor app lights it for a live view and drops it on quitting.
   */
  spotlightEnabled: {
    param: LIGHT_CMD.SPOTLIGHT_ENABLE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "The spotlight master switch, distinct from the on/off above — whether the spotlight may light at " +
      "all. Read verified live on a T8170 (param 1403, direct polarity: 1 = enabled).",
    write: (v, ctx) => spotlightEnableCommand(asBool(v), ctx),
    writeAs: "setEnabled",
  },
} as const satisfies Members;

export const LIGHT: CapabilityModule = {
  capability: "light",
  description: "Floodlight / spotlight manual switch and brightness.",
  members: LIGHT_MEMBERS,
  properties: propertiesOf(LIGHT_MEMBERS),
  // `light` = a real SPOTLIGHT, detected only from genuine spotlight params — NOT 1045 (that's the
  // status LED, on every camera; it belongs to `camera`). Params: floodlight switch 1400, spotlight
  // brightness/enable 1401/1403, indoor-spot enable/bright 6080/6082. Plus explicit light model names.
  detection: {
    evidenceParams: [1400, 1401, 1403, 6080, 6082, 1413],
    modelHints: [/floodlight|wall.?light|spot.?light|search.?light/i],
  },
  /**
   * Only what the member table cannot express: `on`/`off` as no-argument verbs over the same wire as the
   * derived `set`, and the write-only auto-spotlight composite. The verbs stay UNDESCRIBED on purpose —
   * `set` is the method that takes the value, and describing all three would offer one state as three
   * controls. `async` is what turns `switchFrame`'s throw into the rejection a `Promise<void>`
   * caller expects, the same shape the derived setter gets from `bindMembers`.
   */
  actions({ ctx, sink }: MemberDeps): CapabilityActions {
    const dispatchSwitch = async (on: boolean): Promise<void> => sink.dispatch(switchFrame(on, ctx));
    return {
      on: () => dispatchSwitch(true),
      off: () => dispatchSwitch(false),
      setAutoSpotlight: (on: boolean, opts?: AutoSpotlightOptions) =>
        sink.dispatch(autoSpotlightCommand(asBool(on), ctx, opts)),
    };
  },
};
