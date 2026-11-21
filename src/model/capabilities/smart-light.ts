import type { CapabilityModule, InboundSignal, CapabilityEvent, DecodedState, CapabilityActions } from "./types.js";
import type { Command } from "../../core/contracts.js";
import { method, propertiesOf, type Members, type Surface, type MemberDeps } from "./members.js";
import { asBool, clamp } from "../../core/util.js";

/**
 * `smart_light` — the `eufy_life` smart-lighting line's baseline (e.g. T8L02 "Permanent Outdoor
 * Lights"). Distinct from the `light` capability (camera floodlight/spotlight control) — this is a
 * different product line on a different transport family (`Codec: "light"`, its own secure-MQTT "DP"
 * TLV wire), not a camera accessory.
 *
 * **Write path (cmd `0x0201` / `0x0206` / `0x020D`):**
 *  - `on`/`off`/`setBrightness` (`setDeviceInfoPayloadData`) — WIRE-CONFIRMED, toggled and dimmed a
 *    real device, and the device's own status report echoes back the brightness that was written.
 *  - `setEffect(lightId)` (`setLightEffectParamsV2PayloadData`) — WIRED. The frame is built from the
 *    fetched gallery-effect catalog entry (layer header/trailer byte-exact vs. real captures); its
 *    per-layer **colours** run through an RGBCW 5-channel approximation of the device's on-device
 *    mixing engine (EXACT on pure primaries, a small mean error on mixed colours). The catalog fetch +
 *    frame serialization happen in the transport (via an injected resolver), keeping this module
 *    transport-neutral.
 *  - `setColor(color)` (`setLightEffectParamsPayloadData`) — WIRE-CONFIRMED on T8L02. This plain
 *    custom-colour path is distinct from gallery effects and preserves configured brightness. The
 *    device does not report authoritative RGB state, so no current-colour getter is exposed.
 *
 * **Read path — TWO inbound frames.** The device pushes an unsolicited `0x0204` status report after
 * every change, and answers a `0x0200` `get_device_info` request with a `0x0A00` reply. They carry the
 * same state but are NOT interchangeable: field widths differ, the reply prefixes a status byte, and
 * the effect mode moves between tags (see {@link FRAME_LAYOUTS}). Both feed the typed getters via
 * `decodeState` and surface as a `smartLightState` event.
 *
 * **The read leg's tag numbers mean DIFFERENT things from the write leg's.** Both run over
 * `0xa1`-`0xae` with unrelated mappings: outbound `a1` is a timestamp and `a2` an account id, while
 * inbound `a1` is power and `a2` brightness. Decoding one leg with the other's table yields plausible,
 * wrong values rather than an error — keep the two tables apart.
 */

/**
 * The MQTT dispatch id (`mqttCmdCode`) the SDK sends on for the T8L0x light family — CONFIRMED fixed
 * for this family. Capability-owned wire vocabulary, per this repo's convention.
 */
const LIGHT_MQTT_CMD = 17;

/**
 * The envelope `head.cmd` a device→app message carries. The two directions
 * use **different** dispatch ids: {@link LIGHT_MQTT_CMD} is outbound only, this one inbound only.
 */
const LIGHT_MQTT_REPORT_CMD = 16;

/**
 * T8L0x feature-command ids (`getThingCmdCode` in the app's `T8L02Handle.mix.js` handler module). The
 * low byte is the frame's `cmdLo`, the high byte its `cmdHi`.
 */
const LIGHT_CMD = {
  /** `getDeviceInfoPayloadData` — request a full status report. */
  GET_DEVICE_INFO: 0x0200,
  /** `setDeviceInfoPayloadData` — on/off (tag 0xa3) + brightness (tag 0xa4). */
  SET_DEVICE_INFO: 0x0201,
  /** The device→app status report (`event_device_status_notify`), sent unsolicited. */
  DEVICE_STATUS_REPORT: 0x0204,
  /** `setLightEffectParamsPayloadData` — apply one plain custom colour to evidenced segments. */
  SET_LIGHT_EFFECT_PARAMS: 0x0206,
  /** The device's answer to {@link LIGHT_CMD.GET_DEVICE_INFO}. */
  GET_DEVICE_INFO_REPLY: 0x0a00,
  /** `setLightEffectParamsV2PayloadData` — select a gallery effect by catalog id. WIRED (see doc). */
  SET_LIGHT_EFFECT_PARAMS_V2: 0x020d,
} as const;

/**
 * `get_device_info`'s `a3` request bitmask. `0x1FFF` (13 bits) = every field — the app's own default,
 * sent when a device screen opens.
 */
const GET_DEVICE_INFO_ALL = 0x1fff;

/** Request-frame tag carrying {@link GET_DEVICE_INFO_ALL}. */
const REQUEST_STATUS_TAG = 0xa3;

/** Write-frame tags on `setDeviceInfoPayloadData`. */
const WRITE_TAG = { IS_ON: 0xa3, LEVEL: 0xa4 } as const;

/**
 * Param ids these reports land on, in the `eufy_life` namespace (see `model/life-params.ts`, which
 * names the same ids for the param dictionary). Declared once here because each id is referenced from
 * four places — the tag map, the boolean set, the property specs and the event payload.
 */
const LIGHT_PARAM = {
  POWER: 161,
  BRIGHTNESS: 162,
  LENGTH: 163,
  EFFECT_ID: 164,
  COLOR_GRADIENT: 165,
  CLOUD_EFFECT_ID: 166,
  EFFECT_MODE: 167,
} as const;

const COMMON_TAGS: ReadonlyMap<number, number> = new Map([
  [0xa1, LIGHT_PARAM.POWER],
  [0xa2, LIGHT_PARAM.BRIGHTNESS],
  [0xa3, LIGHT_PARAM.LENGTH],
  [0xa4, LIGHT_PARAM.EFFECT_ID],
  [0xa5, LIGHT_PARAM.COLOR_GRADIENT],
  [0xa6, LIGHT_PARAM.CLOUD_EFFECT_ID],
]);

/**
 * Largest byte width a numeric field is read at. Widths vary per frame (`a3`/`a4` are 1+4 bytes on the
 * notify and 2+2 on the get-reply), so the value is read as a little-endian integer of whatever width
 * it arrives at; anything wider is a shape this isn't reversed for and is skipped.
 */
const MAX_NUMERIC_LEN = 4;

/**
 * How each inbound frame is laid out, keyed by its frame command.
 *
 * Both carry the same state, under partly different tags — the app's own parser calls this its
 * `isEvent` branch. On the unsolicited notify `0xa7` is the effect mode; in the answer to
 * `get_device_info` `0xa7` is instead a per-LED-segment bit array and the mode moves to `0xa8`.
 * Decoding one frame with the other's table silently reports a bitmap as a mode.
 *
 * Unmapped tags are walked over and skipped: the LED bit array has no evidenced element order, and
 * `0xa9` differs in width between the two frames with no confirmed meaning in either.
 */
const FRAME_LAYOUTS: ReadonlyMap<number, { modeTag: number }> = new Map([
  [LIGHT_CMD.DEVICE_STATUS_REPORT, { modeTag: 0xa7 }],
  [LIGHT_CMD.GET_DEVICE_INFO_REPLY, { modeTag: 0xa8 }],
]);

/** Param ids whose reported value is a flag, surfaced as `"1"`/`"0"` so the `bool` spec decodes it. */
const BOOL_PARAMS: ReadonlySet<number> = new Set([LIGHT_PARAM.POWER, LIGHT_PARAM.COLOR_GRADIENT]);

/**
 * Map a decoded DP frame's tags to param values, or `undefined` if this isn't a frame we read.
 *
 * Scoped by the envelope's dispatch id and the frame command. The transport has already unwrapped and
 * validated the framing, so all that is left here is which tag means what — a field whose width isn't
 * the numeric it should be is skipped rather than truncated to a plausible value.
 */
function reportFrom(signal: InboundSignal): Record<number, string> | undefined {
  if (signal.source !== "mqtt" || !signal.frame) return undefined;
  const { envelopeCmd, cmd, fields } = signal.frame;
  if (envelopeCmd !== LIGHT_MQTT_REPORT_CMD) return undefined;
  const layout = FRAME_LAYOUTS.get(cmd);
  if (!layout) return undefined;

  const params: Record<number, string> = {};
  for (const { tag, value } of fields) {
    const param = tag === layout.modeTag ? LIGHT_PARAM.EFFECT_MODE : COMMON_TAGS.get(tag);
    if (param === undefined || value.length === 0 || value.length > MAX_NUMERIC_LEN) continue;
    const n = value.readUIntLE(0, value.length);
    params[param] = BOOL_PARAMS.has(param) ? (n === 1 ? "1" : "0") : String(n);
  }
  return Object.keys(params).length ? params : undefined;
}

/**
 * Brightness range the level byte carries. The clamp and the published argument range read from here —
 * a second copy of a range stays individually valid while drifting from the one actually enforced.
 */
const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 100;

/** `on`/`off`/`set` (isOn) and `setBrightness` (level) — `setDeviceInfoPayloadData`. */
function deviceInfoCommand(opts: { isOn?: boolean; level?: number }): Command {
  const fields: Array<{ tag: number; value: Buffer }> = [];
  if (opts.isOn !== undefined) fields.push({ tag: WRITE_TAG.IS_ON, value: Buffer.from([opts.isOn ? 1 : 0]) });
  if (opts.level !== undefined) {
    fields.push({
      tag: WRITE_TAG.LEVEL,
      value: Buffer.from([clamp(Math.round(opts.level), BRIGHTNESS_MIN, BRIGHTNESS_MAX)]),
    });
  }
  return { kind: "mqtt-dp", mqttCmdCode: LIGHT_MQTT_CMD, cmdCode: LIGHT_CMD.SET_DEVICE_INFO, fields };
}

/**
 * Ask the device for a full status report (`get_device_info`). The transport prepends the frame's
 * timestamp + account id, so only the request bitmask is supplied here.
 */
function requestStateCommand(): Command {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(GET_DEVICE_INFO_ALL, 0);
  return {
    kind: "mqtt-dp",
    mqttCmdCode: LIGHT_MQTT_CMD,
    cmdCode: LIGHT_CMD.GET_DEVICE_INFO,
    fields: [{ tag: REQUEST_STATUS_TAG, value }],
  };
}

/**
 * Select a gallery effect by catalog id (`setLightEffectParamsV2PayloadData`). The catalog fetch and the
 * layer serialization happen in the transport behind this intent; the companion command is the
 * brightness frame that follows when the catalog entry carries an overall level.
 */
function presetCommand(lightId: number): Command {
  return {
    kind: "mqtt-dp-preset",
    mqttCmdCode: LIGHT_MQTT_CMD,
    cmdCode: LIGHT_CMD.SET_LIGHT_EFFECT_PARAMS_V2,
    companionCmdCode: LIGHT_CMD.SET_DEVICE_INFO,
    presetId: lightId,
  };
}

/**
 * Models whose `0x020D` light-effect frame encoding is reverse-engineered. Every device in
 * the line HAS light effects — this gates what has been CONFIRMED, not what the hardware offers. The
 * effect frame is **per-family**: across the `T8L0x` line the layer blobs differ (extra trailing
 * fields, colour fields at different widths) and the RGBCW mixing constants were derived from
 * T8L02 alone. `setEffect` is gated to these; on any other family member it throws rather
 * than send T8L02's bytes (a fire-and-forget wire makes a mis-packed frame look like success).
 * on/off/brightness are the shared `setDeviceInfoPayloadData` frame and are NOT gated.
 *
 * Keys are normalized T-codes: `ctx.model` carries the cloud record's `device_model` verbatim, while
 * the registry that classified the device as a light looked that model up as `trim().toUpperCase()`.
 */
const CONFIRMED_EFFECT_MODELS: ReadonlySet<string> = new Set(["T8L02"]);

/** Models whose plain custom-colour frame encoding is confirmed. */
const CONFIRMED_COLOR_MODELS: ReadonlySet<string> = new Set(["T8L02"]);

/** Largest segment count representable by `[count, ...positions]` in a one-byte-length DP field. */
const MAX_COLOR_SEGMENTS = 254;

/** Normalize a cloud `device_model` the way the model registry keys its rows, for a gate lookup. */
const modelKey = (model: string | undefined): string => (model ?? "").trim().toUpperCase();

/** Integer RGB input for `SmartLightActions.setColor`; each channel must be in 0..255. */
export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/** Build semantic custom-colour intent after all evidence and value checks have passed. */
function colorCommand(color: RgbColor, segmentCount: number): Command {
  return {
    kind: "mqtt-dp-color",
    mqttCmdCode: LIGHT_MQTT_CMD,
    cmdCode: LIGHT_CMD.SET_LIGHT_EFFECT_PARAMS,
    ...color,
    segmentCount,
  };
}

/**
 * Bound `smart_light` controls — the object returned by `dev.smartLight()`.
 *
 * The reads, their setters, the state request and the effect write are DERIVED from
 * `SMART_LIGHT_MEMBERS`: one declaration per feature gives the getter, the setter, its argument
 * type and its description. Only the no-argument power verbs are written out below.
 */
export type SmartLightActions = Surface<typeof SMART_LIGHT_MEMBERS> & {
  /** Turn the light on. */
  on(): Promise<void>;
  /** Turn the light off. */
  off(): Promise<void>;
};

/**
 * Every `smart_light` feature, declared once. The property schema, the typed getters, the derived
 * setters, the intent routes and the descriptions all come out of this table.
 *
 * Every read is `realtime`: this line has no pollable cloud param to gate a getter on — state arrives
 * only over the light's own MQTT wire — so the capability's own detection is the evidence, and each
 * getter reads `undefined` until the first report lands.
 *
 * Exported but NOT published: each entry states its wire id and its gate,
 * which the reference site does not carry.
 * @internal
 */
export const SMART_LIGHT_MEMBERS = {
  /**
   * On/off for the whole run of lights. `writeAs` names the setter `set` rather than `setPower`, and the
   * `on`/`off` verbs beside it in `actions()` reach the same frame. `realtime` like every read here:
   * there is no pollable cloud param, so the getter answers `undefined` until the first MQTT report —
   * `refreshState` is how a caller populates it on demand. Note the READ tag (0xa1) and the WRITE tag
   * (0xa3) differ; the two legs' tag maps are unrelated.
   */
  power: {
    param: LIGHT_PARAM.POWER,
    property: "lightPower",
    type: "bool",
    kind: "boolean",
    realtime: true,
    description: "Power state, DP tag 0xa1, as the app's own report parser reads it.",
    write: (v) => deviceInfoCommand({ isOn: asBool(v) }),
    writeAs: "set",
    aliases: { on: true, off: false },
  },
  /**
   * The CONFIGURED level, not the live output: it persists across an off, so reading a non-zero
   * brightness says nothing about whether the lights are lit — pair it with `power`. 0 is a legal level
   * here (unlike the camera spotlight's 1-100), and the write clamps into 0-100 rather than refusing.
   * `realtime`, so `undefined` until the first report.
   */
  brightness: {
    param: LIGHT_PARAM.BRIGHTNESS,
    property: "lightBrightness",
    type: "number",
    unit: "%",
    kind: "percent",
    realtime: true,
    min: BRIGHTNESS_MIN,
    max: BRIGHTNESS_MAX,
    description:
      "Brightness 0-100, DP tag 0xa2. Persists across off — it is the configured level, not the live " +
      "output, as the app's own report parser reads it.",
    write: (v) => deviceInfoCommand({ level: Number(v) }),
  },
  /**
   * How many individually addressable segments the installed run has — a physical fact of the strip,
   * which is why it is read-only. A bare `scalar` with no unit: the wire says how many, not how long.
   * `realtime`, so `undefined` until the first report.
   */
  lightLength: {
    param: LIGHT_PARAM.LENGTH,
    type: "number",
    kind: "scalar",
    realtime: true,
    description: "Addressable segment count, DP tag 0xa3.",
  },
  /**
   * The gallery effect SELECTED — an `identifier`, not an enum, because it names an entry in a catalog
   * that only exists at runtime, so there is no option set to publish. Distinct from `cloudEffectId`,
   * which is the one actually running. Written by `setEffect`, whose gate is the model rather than a
   * value. `realtime`, so `undefined` until the first report.
   */
  effectId: {
    param: LIGHT_PARAM.EFFECT_ID,
    property: "lightEffectId",
    type: "number",
    kind: "identifier",
    realtime: true,
    description: "Selected gallery effect id, DP tag 0xa4.",
  },
  /**
   * Whether the run blends between an effect's colours rather than stepping between them. Read-only:
   * the report parser establishes the flag, but no write frame for it has been reversed, so no setter
   * is offered. One of the two params surfaced as `"1"`/`"0"` so the `bool` narrowing reads it.
   * `realtime`, so `undefined` until the first report.
   */
  colorGradient: {
    param: LIGHT_PARAM.COLOR_GRADIENT,
    property: "lightColorGradient",
    type: "bool",
    kind: "boolean",
    realtime: true,
    description: "Colour-gradient switch, DP tag 0xa5.",
  },
  /**
   * The effect actually RUNNING, `0` when none is — so this, not `effectId`, is the read that answers
   * "is an effect playing". An `identifier` for the same reason as its sibling: the catalog it indexes
   * is fetched at runtime. Read-only; `setEffect` drives the selection. `realtime`, so `undefined`
   * until the first report.
   */
  cloudEffectId: {
    param: LIGHT_PARAM.CLOUD_EFFECT_ID,
    property: "lightCloudEffectId",
    type: "number",
    kind: "identifier",
    realtime: true,
    description: "Running gallery effect id (0 when off), DP tag 0xa6.",
  },
  /**
   * Reported in every status frame, so it belongs in the schema and answers through `getProperty` — but
   * given no typed getter: the app's own parser reads 0xa7 differently on the notify and on the
   * get-reply, and no capture settles which value means what.
   */
  lightEffectMode: {
    param: LIGHT_PARAM.EFFECT_MODE,
    type: "number",
    kind: "scalar",
    unexposed: true,
    description:
      "Effect mode, DP tag 0xa7. Reported, but its value space is not evidenced — no typed getter, " +
      "and a bare mode index rather than a named set, since the options it selects among are unknown.",
  },

  /**
   * A request, not a state: reports are pushed on change with no periodic heartbeat, so this is how a
   * caller populates the getters on demand. The reply arrives asynchronously and does not resolve here.
   */
  refreshState: {
    action: () => requestStateCommand(),
    description: "Ask the device to report its current state; the reply refreshes the reads.",
  },

  /**
   * Gated on the MODEL, not on a value, and carrying no description: it refuses off the confirmed list
   * for a reason a generated message cannot give, and its id names an entry in a catalog that only
   * exists at runtime, so a generated control would have no domain to offer. Neither is a property
   * write, so it keeps its own signature.
   */
  setEffect: method(
    ({ ctx, sink }) =>
      (lightId: number): Promise<void> =>
        CONFIRMED_EFFECT_MODELS.has(modelKey(ctx.model))
          ? sink.dispatch(presetCommand(lightId))
          : Promise.reject(
              new Error(
                `light-effect write is verified only on ${[...CONFIRMED_EFFECT_MODELS].join(", ")}; ` +
                  `model ${ctx.model ?? "unknown"} uses a per-family effect-frame encoding that isn't reverse-engineered — ` +
                  `refusing to send the captured SKU's bytes (on/off/brightness still work)`,
              ),
            ),
    "Select a light-effect gallery entry by its catalog id. Colours are an RGBCW approximation, exact on primaries.",
  ),

  /**
   * Plain custom colour, distinct from the gallery-effect wire. The frame addresses every reported
   * segment, so a current positive segment count is mandatory and no family-wide length is guessed.
   * Completion acknowledges transport publication only; the device reports no authoritative RGB.
   */
  setColor: method(
    ({ ctx, sink, read }) =>
      (color: RgbColor): Promise<void> => {
        if (!CONFIRMED_COLOR_MODELS.has(modelKey(ctx.model))) {
          return Promise.reject(
            new Error(
              `custom-colour write is verified only on ${[...CONFIRMED_COLOR_MODELS].join(", ")}; ` +
                `model ${ctx.model ?? "unknown"} has no confirmed 0x0206 frame encoding`,
            ),
          );
        }
        const segmentCount = read("lightLength")?.value;
        if (
          typeof segmentCount !== "number" ||
          !Number.isInteger(segmentCount) ||
          segmentCount < 1 ||
          segmentCount > MAX_COLOR_SEGMENTS
        ) {
          return Promise.reject(
            new Error(`custom-colour write requires a reported integer segment count in 1..${MAX_COLOR_SEGMENTS}`),
          );
        }
        const channels = color && [color.red, color.green, color.blue];
        if (!channels || channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
          return Promise.reject(new Error("custom-colour RGB channels must be integers in 0..255"));
        }
        return sink.dispatch(colorCommand(color, segmentCount));
      },
    "Set one plain RGB colour across all reported segments on T8L02 lights. Preserves configured brightness; completion acknowledges publication, not observed colour.",
    (ctx) => CONFIRMED_COLOR_MODELS.has(modelKey(ctx.model)),
  ),
} as const satisfies Members;

export const SMART_LIGHT: CapabilityModule = {
  capability: "smart_light",
  line: "life",
  description:
    "eufy_life smart-lighting: T8L02 Permanent Outdoor Lights and similar (on/off/brightness/custom colour/effect).",
  members: SMART_LIGHT_MEMBERS,
  properties: propertiesOf(SMART_LIGHT_MEMBERS),
  detection: { codecs: ["light"] },
  /**
   * Ask for a state snapshot as soon as this device's realtime channel is up, so the typed getters are
   * populated at connect rather than only after the first write — reports are pushed on change, with
   * no periodic heartbeat to wait for.
   */
  realtimeInit(): Command[] {
    return [requestStateCommand()];
  },
  decodeState(signal: InboundSignal): DecodedState | null {
    const params = reportFrom(signal);
    return params ? { params } : null;
  },
  emits: ["smartLightState"],
  /**
   * Surface a status report as one `smartLightState` event carrying every field it decoded. Fails
   * closed (returns `null`, never throws) on any shape mismatch.
   */
  decodeEvent(signal: InboundSignal): CapabilityEvent | null {
    const params = reportFrom(signal);
    if (!params) return null;
    const num = (id: number): number | undefined => (params[id] === undefined ? undefined : Number(params[id]));
    const bool = (id: number): boolean | undefined => (params[id] === undefined ? undefined : params[id] === "1");
    return {
      event: "smartLightState",
      payload: {
        power: bool(LIGHT_PARAM.POWER),
        brightness: num(LIGHT_PARAM.BRIGHTNESS),
        lightLength: num(LIGHT_PARAM.LENGTH),
        effectId: num(LIGHT_PARAM.EFFECT_ID),
        colorGradient: bool(LIGHT_PARAM.COLOR_GRADIENT),
        cloudEffectId: num(LIGHT_PARAM.CLOUD_EFFECT_ID),
      },
    };
  },
  /** Only the no-argument power verbs, which carry no value for a member to hold. */
  actions({ sink }: MemberDeps): CapabilityActions {
    return {
      on: () => sink.dispatch(deviceInfoCommand({ isOn: true })),
      off: () => sink.dispatch(deviceInfoCommand({ isOn: false })),
    };
  },
};
