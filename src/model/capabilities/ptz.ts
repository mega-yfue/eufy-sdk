import { DeviceType } from "../device-types.js";
import { setJson, setPayload } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, InboundSignal, CapabilityEvent, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this pan-tilt capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`). Distinct from the {@link PTZ_ROTATE} direction map below (which is
 * `rotate_type` 1..4, not a command id).
 *
 * Ids + envelopes are taken from the V6 app's own command builders (the `Set*Parser`/`*PositionsParser`
 * classes in the decompiled JS), which is this project's wire ground truth — NOT a third-party
 * catalogue, whose PTZ labels are known-wrong here (one labels 6038 a rotate; the app sends it as a
 * span-cruise preview).
 */
export const PTZ_CMD = {
  /** Rotate. App `SetPtz…`/`INDOOR_ROTATE`: 1700 wrapper, `{cmd_type,rotate_type,zoom}`. */
  PTZ_ROTATE: 6030,
  /** Digital zoom. App `SetPictureZoomParser` (`COMMAND_DUAL_CAMERA_ZOOM`): 1350 SET_PAYLOAD sub-command,
   * payload `{x,y,w,h,offset,orgZoom,dstZoom}`. Also the inbound `1351` zoom-notify `cmd`. */
  PTZ_ZOOM: 6203,
  /** Go to a stored preset — AND the save-preset frame (identical bytes; the camera moves vs creates
   * by whether the slot is occupied). App `SetPresetPositionsParser` (`COMMAND_INDOOR_SPAN_CRUISE_POINT`):
   * 1700 wrapper, `{settingstate:0, value:<presetId>}`. */
  PTZ_PRESET_GOTO: 6032,
  /** Capture the camera's current frame as a preset's thumbnail. App `COMMAND_APP_SPAN_PTZ_PIC`: 1700
   * wrapper, `{value:<presetId>}`. The app sends this right before the 6032 save when creating a preset. */
  PTZ_PRESET_PIC: 6097,
  /** Delete a stored preset. App `DeletePresetPositionsParser` (`COMMAND_INDOOR_SPAN_CRUISE_DELETE`):
   * 1700 wrapper, `{value:<presetId>}`. */
  PTZ_PRESET_DELETE: 6033,
  /** List stored presets. App `QueryPresetPositionsParser` (`COMMAND_INDOOR_SPAN_CRUISE_QUERY`): 1700
   * request whose reply is a `1351` notify carrying `{points:[…]}`. */
  PTZ_PRESET_QUERY: 6034,
  /** Preview a stored preset — move to it transiently (the app uses this to show a preset before
   * committing a default). App `COMMAND_INDOOR_SPAN_CRUISE_PREVIEW`: 1700 wrapper, `{value:<presetId>}`. */
  PTZ_PRESET_PREVIEW: 6035,
  /** Mark a stored preset as the default/home position. App `DefaultPresetPositionsParser`
   * (`COMMAND_APP_SET_DEFAULT_POSITION`): 1350 SET_PAYLOAD, payload `{index:<presetId>, settingstate}`.
   * A compound builder — the app follows it with PREVIEW (6035) + PTZ_PIC (6097) to refresh the
   * thumbnail; the default-set itself is this frame. */
  PTZ_SET_DEFAULT_POSITION: 6242,
  /** How fast a rotate STEP travels. 1700 wrapper, `{value:1|3|5}`. Observed live: the app's
   * Slow/Mid/Fast control on an indoor pan-tilt writes 1 / 3 / 5 and nothing else moves. The id sits
   * inside the smart lock's `601x` block, so the shared param dictionary labels it `lockParam` — an id
   * reused across product lines, and the camera's meaning is the observed one. */
  PTZ_ROTATE_SPEED: 6015,
} as const;

/**
 * Inbound P2P **frame command ids** {@link CapabilityModule.decodeEvent} matches on — the wrapper carrying the PTZ
 * status, distinct from the {@link PTZ_CMD} feature ids that ride *inside* it. Named capability-local
 * (not imported from the transport's `P2P_ENVELOPE`): `model/` and `transport/` share no wire
 * vocabulary, and the frame→event decode is a model concern.
 */
const PTZ_FRAME = {
  /** SoloCam JSON status wrapper — `{cmd, payload}`. */
  NOTIFY_PAYLOAD: 1351,
  /** Indoor-PT binary position stream wrapper. */
  CONTROL_PAYLOAD: 1700,
} as const;

/**
 * Optional digital-zoom crop window for `zoom`. The app's `SetPictureZoomParser`
 * carries a region alongside the target factor; when `offset` is false the region is ignored and the
 * zoom is centred (x/y/w/h sent as 0). Coordinates are the app's own normalised values — pass them
 * through only when mirroring a captured region.
 */
export type ZoomRegion = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** When true, the x/y/w/h crop is applied; when false (default) the zoom is centred. */
  offset?: boolean;
  /** The zoom factor the region is relative to (app default 0). */
  orgZoom?: number;
};

/** One stored PTZ preset, as returned by `list`. Shape follows the app's
 * `query_preset_positions` reply `points[]`; fields beyond `id` vary by model, so the raw entry is
 * preserved. */
export type PtzPreset = {
  /** The preset id used by `goto` / `delete`. */
  id: number;
  /** The raw reply entry, for fields (name/thumbnail/coordinates) that vary by model. */
  raw: Record<string, unknown>;
};

/** A preset's thumbnail, as returned by `image`. Follows the app's
 * `get_preset_position_pic` reply `{data, index}`. */
export type PtzPresetImage = {
  /** The preset id the image belongs to (`-1` if the reply omitted it). */
  index: number;
  /** The thumbnail image payload as the camera delivers it (a base64-encoded JPEG). */
  data: string;
};

/**
 * The preset sub-API — everything that acts on a stored PTZ preset, grouped under `dev.ptz().preset()`.
 * The write verbs are always present; the read verbs (`list`/`image`) are request/reply over P2P and so
 * present only when the device is bound to a live client — call them with `?.`.
 *
 * The `id`-taking write verbs are **fire-and-forget** (P2P sends no ack): referencing an empty slot is
 * a **silent no-op** — the camera ignores it and no error surfaces here. Only `save(id)` populates a
 * slot; `goto`/`preview`/`setDefault`/`delete` on an unpopulated `id` do nothing. Check `list?()` first
 * if the id might not exist.
 */
export type PtzPresetActions = {
  /** Move to the stored preset `id`. No-op if `id` isn't a saved preset (see the type note). */
  goto(id: number): Promise<void>;
  /** Preview the stored preset `id` — move to it transiently (the app's pre-default preview). No-op if
   * `id` isn't a saved preset. */
  preview(id: number): Promise<void>;
  /** Save the camera's current position into preset `id` (thumbnail + save). Creates the preset when
   * the slot is empty, overwrites it when occupied. */
  save(id: number): Promise<void>;
  /** Promote a preset to the default/home position. Sets the default to the preset the camera is
   * **currently parked on**, so the sequence is `preview(id)` → wait for the pan to finish →
   * `setDefault(id)`; sent with the camera elsewhere it has no effect. */
  setDefault(id: number): Promise<void>;
  /** Delete the stored preset `id`. No-op if `id` isn't a saved preset. */
  delete(id: number): Promise<void>;
  /** List the stored presets. Present only when the device is bound to a live client, so call with `?.`. */
  list?(opts?: { timeoutMs?: number }): Promise<PtzPreset[]>;
  /** Fetch preset `id`'s thumbnail. Present only when the device is bound to a live client, so call with
   * `?.`. Resolves `undefined` when the reply carried no image data — typically nothing stored for that
   * preset. A reply that never arrives rejects instead. */
  image?(id: number, opts?: { timeoutMs?: number }): Promise<PtzPresetImage | undefined>;
};

/**
 * Bound pan/tilt/zoom (PTZ) controls — the object returned by `dev.ptz()`. Movement is
 * command-driven (the camera has no "go to angle X" write; it steps in a direction). Preset operations
 * are grouped under {@link PtzPresetActions} via `preset()` (e.g. `dev.ptz().preset().goto(3)`).
 */
export type PtzActions = Surface<typeof PTZ_MEMBERS>;

/**
 * Rotate direction. `PtzDirection` is both the const value-object (`PtzDirection.left`) and the
 * union type of its values, so callers use the named constant: `rotate(PtzDirection.left)`.
 */
export const PtzDirection = {
  /** Pan left (one step). */
  left: "left",
  /** Pan right (one step). */
  right: "right",
  /** Tilt up (one step). */
  up: "up",
  /** Tilt down (one step). */
  down: "down",
} as const;
export type PtzDirection = (typeof PtzDirection)[keyof typeof PtzDirection];

/** Pan-tilt rotate direction → `rotate_type` (the on-wire code). Not re-exported by the barrel —
 * stays internal to the capability. Confirmed on hardware (T8425): 1=left, 2=right, 3=up, 4=down. */
export const PTZ_ROTATE = { left: 1, right: 2, up: 3, down: 4 } as const;

/** Reported params that prove a second (telephoto) lens — the digital zoom (a dual-camera command)
 * exists only on these. `6204` = the dual-lens `calibration_data`, `6205` = the dual-cam video-type
 * setting. A dual-lens SoloCam (T8170/S340) reports them; a single-lens PT cam (T8171) reports none,
 * so `zoom()` is gated off there — EXCEPT the params can lag/never sync on a real unit: confirmed live
 * on BOTH a T8170 and a T8425 (Floodlight cam) that report neither 6204 nor 6205, yet the raw zoom
 * command works on both. Two independent confirmations makes this look like a general property of the
 * evidence params, not a one-off — treat any future zoom-model addition here the same way. Same trust
 * pattern as the module's own PTZ detection ("trust the deviceType" comment above): each listed model
 * is dual-lens BY DEFINITION, so a direct model-code match is authoritative evidence too, independent
 * of whatever the cloud happened to sync for this device. */
const ZOOM_EVIDENCE_PARAMS = [6204, 6205];
const ZOOM_MODEL_HINT = /^T8170\b|^T8425\b|S340/i;

/** True when this device has zoom evidence — either the dual-lens params, or a model code known to be
 * dual-lens by definition (see {@link ZOOM_MODEL_HINT}'s doc note on why params alone aren't enough). */
function hasZoomEvidence(ctx: CommandContext): boolean {
  return ZOOM_EVIDENCE_PARAMS.some((p) => ctx.paramIds.has(p)) || (!!ctx.model && ZOOM_MODEL_HINT.test(ctx.model));
}

/**
 * Pan-tilt rotate as a transport-neutral {@link Command}. CONFIRMED wire command (captured on
 * T8425 ch3 during live-view): `{"commandType":6030,"data":{"cmd_type":1,"rotate_type":1..4,
 * "zoom":1.0}}` under the generic control wrapper `1700` on the camera channel. `cmd_type:1` =
 * move; `zoom` defaults to 1.0.
 *
 * Emitted as a `set-json` intent — the capability names only the param + payload; the transport
 * resolver picks the encryption level by topology (standalone → L1, HomeBase → L2). A PT cam can be
 * either, so the level is NOT fixed here.
 */
export function rotateCommand(direction: PtzDirection, ctx: CommandContext, zoom = 1.0): Command {
  return setJson(PTZ_CMD.PTZ_ROTATE, { cmd_type: 1, rotate_type: PTZ_ROTATE[direction], zoom }, ctx);
}

/**
 * Digital-zoom as a transport-neutral {@link Command}. The V6 app's `SetPictureZoomParser` builds a
 * `SET_PAYLOAD` (1350) sub-command `COMMAND_DUAL_CAMERA_ZOOM` with the crop-window payload
 * `{x,y,w,h,offset,orgZoom,dstZoom}`; the region collapses to zeros unless `offset` is set. `dstZoom`
 * is the target factor. `mValue3:0` — verified byte-exact against a live capture of the real app's own
 * pinch-zoom gesture; NOT `mValue3:cmd` like the general `SET_PAYLOAD` default (see `setPayload`'s doc).
 */
export function zoomCommand(dstZoom: number, ctx: CommandContext, region?: ZoomRegion): Command {
  const r = region ?? {};
  const offset = r.offset ?? false;
  return setPayload(
    PTZ_CMD.PTZ_ZOOM,
    {
      x: offset ? (r.x ?? 0) : 0,
      y: offset ? (r.y ?? 0) : 0,
      w: offset ? (r.w ?? 0) : 0,
      h: offset ? (r.h ?? 0) : 0,
      offset,
      orgZoom: r.orgZoom ?? 0,
      dstZoom,
    },
    ctx,
    0,
  );
}

/**
 * Go-to-preset as a transport-neutral {@link Command}. The V6 app's `SetPresetPositionsParser` builds
 * a 1700-wrapper sub-command `COMMAND_INDOOR_SPAN_CRUISE_POINT` with `{settingstate:0, value:<id>}`
 * (the app follows it with a query + thumbnail fetch; the move itself is this frame).
 */
export function gotoPresetCommand(id: number, ctx: CommandContext): Command {
  return setJson(PTZ_CMD.PTZ_PRESET_GOTO, { settingstate: 0, value: id }, ctx);
}

/**
 * Delete-preset as a transport-neutral {@link Command}. The V6 app's `DeletePresetPositionsParser`
 * builds a 1700-wrapper sub-command `COMMAND_INDOOR_SPAN_CRUISE_DELETE` with `{value:<id>}`.
 */
export function deletePresetCommand(id: number, ctx: CommandContext): Command {
  return setJson(PTZ_CMD.PTZ_PRESET_DELETE, { value: id }, ctx);
}

/**
 * Preview-preset as a transport-neutral {@link Command}. The V6 app's `COMMAND_INDOOR_SPAN_CRUISE_PREVIEW`
 * sub-command carries `{value:<id>}`; the app moves the camera to preset `id` to preview it (decoded on
 * a T8170 SoloCam: `{"commandType":6035,"data":{"value":3}}`).
 */
export function previewPresetCommand(id: number, ctx: CommandContext): Command {
  return setJson(PTZ_CMD.PTZ_PRESET_PREVIEW, { value: id }, ctx);
}

/**
 * Capture-current-frame-as-thumbnail as a transport-neutral {@link Command}. The V6 app's
 * `COMMAND_APP_SPAN_PTZ_PIC` sub-command carries `{value:<id>}`; the app emits it immediately before
 * the 6032 save when creating a preset (see {@link savePresetCommand}).
 */
export function presetPicCommand(id: number, ctx: CommandContext): Command {
  return setJson(PTZ_CMD.PTZ_PRESET_PIC, { value: id }, ctx);
}

/**
 * Save the camera's CURRENT position into preset `id`, as the two frames the V6 app emits to create a
 * preset (decoded on a T8170 SoloCam): `COMMAND_APP_SPAN_PTZ_PIC {value:id}` (thumbnail) then
 * `COMMAND_INDOOR_SPAN_CRUISE_POINT {settingstate:0, value:id}` (save). The save frame is byte-identical
 * to {@link gotoPresetCommand}; the camera creates vs moves by whether slot `id` is occupied.
 */
export function savePresetCommand(id: number, ctx: CommandContext): [Command, Command] {
  return [presetPicCommand(id, ctx), setJson(PTZ_CMD.PTZ_PRESET_GOTO, { settingstate: 0, value: id }, ctx)];
}

/**
 * Promote a stored preset to the default/home position, as a transport-neutral {@link Command}. The V6
 * app's `DefaultPresetPositionsParser` builds a 1350 SET_PAYLOAD `COMMAND_APP_SET_DEFAULT_POSITION`
 * `{index:<presetId>, settingstate:0}`.
 *
 * 6242 sets the default to the preset the camera is **currently parked on**. To move the default, park
 * the camera on `presetId` first — `preview(presetId)`, let the pan finish, then `setDefault(presetId)`.
 * Sent while the camera is elsewhere, it has no effect. The parser is topology-agnostic; the router
 * picks the encryption level (L1/L2) by topology.
 */
export function setDefaultPositionCommand(presetId: number, ctx: CommandContext): Command {
  return setPayload(PTZ_CMD.PTZ_SET_DEFAULT_POSITION, { index: presetId, settingstate: 0 }, ctx);
}

/**
 * Parse a `query_preset_positions` reply (`{points:[…]}`) into {@link PtzPreset}s. Mirrors the app's
 * `query_preset_positions_parse_payload`, which reads the reply's `points` array. The id field is
 * `index` — confirmed live on a T8171 SoloCam, whose reply entries are
 * `{index, enable, zoom, isdefault}` (8 slots, `enable:0` = empty). `id`/`value` are accepted as
 * fallbacks for other models; the full entry is preserved as `raw`.
 */
export function parsePresetPoints(reply: Record<string, unknown> | undefined): PtzPreset[] {
  const points = reply?.points;
  if (!Array.isArray(points)) return [];
  const out: PtzPreset[] = [];
  for (const p of points) {
    if (typeof p !== "object" || p === null) continue;
    const rec = p as Record<string, unknown>;
    const rawId = rec.index ?? rec.id ?? rec.value;
    const id = typeof rawId === "number" ? rawId : Number(rawId);
    if (!Number.isFinite(id)) continue;
    out.push({ id, raw: rec });
  }
  return out;
}

/**
 * Parse a `get_preset_position_pic` reply into a {@link PtzPresetImage}. Mirrors the app's
 * `get_preset_position_pic_parse_payload`, which reads `{data, index}` off the notify (`data` = the
 * thumbnail, `index` defaults to `-1`). Returns `undefined` when the reply carries no image.
 */
// `data` encoding is base64 JPEG, same as the CMD_DATABASE_IMAGE payload; JS-grounded, not yet
// wire-captured for this sub-command.
export function parsePresetImage(reply: Record<string, unknown> | undefined): PtzPresetImage | undefined {
  const data = reply?.data;
  if (typeof data !== "string" || data.length === 0) return undefined;
  const rawIndex = reply?.index;
  const index = typeof rawIndex === "number" ? rawIndex : Number.isFinite(Number(rawIndex)) ? Number(rawIndex) : -1;
  return { index, data };
}

/** True for a valid pan-tilt direction string. */
function isDirection(v: unknown): v is PtzDirection {
  return v === "left" || v === "right" || v === "up" || v === "down";
}

/**
 * Every `ptz` feature, declared once.
 *
 * Movement is command-driven, so almost every entry is a `method`: `rotate` takes a direction plus an
 * optional speed, the four compass verbs take nothing, `preset()` returns a whole sub-API, and `zoom`
 * is gated on the device having a second lens. `rotationSpeed` is the one value member — the camera's
 * own step speed, which it stores. There is no position member: no device reports where it is pointed
 * as a parameter. Position arrives only while the camera moves, as the `ptzNotify` event {@link PTZ}
 * decodes from a live frame.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const PTZ_MEMBERS = {
  /**
   * How fast a rotate STEP travels, on the app's own three-position control: `1` slow, `3` mid, `5`
   * fast. A `scalar` rather than an enum — the endpoints and the midpoint are observed, so 2 and 4 are
   * a prediction of the scale's shape and the wire is not known to reject them.
   *
   * Not the same thing as `rotate`'s `zoom` argument, which scales one step's SIZE rather than its
   * speed.
   *
   * The parameter is **absent until first written**: a camera whose speed has never been set reports
   * no `6015` at all, so the getter is installed only once the value exists — an absent reading is "not
   * configured", never "unsupported".
   */
  rotationSpeed: {
    param: PTZ_CMD.PTZ_ROTATE_SPEED,
    type: "number",
    kind: "scalar",
    provenance: "verified",
    description:
      "Pan/tilt rotate speed: 1 = slow, 3 = mid, 5 = fast (PTZ_ROTATE_SPEED 6015). ✅ Write confirmed " +
      "live on a T8410 (mains, standalone): the app's Slow/Mid/Fast control identified 1/3/5, then 1 " +
      "and 5 were sent consecutively through this member and read back on the cloud param. 2 and 4 " +
      "are the scale's shape, not observed values. Absent until first written.",
    write: (v, ctx) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
      return setJson(PTZ_CMD.PTZ_ROTATE_SPEED, { value: n }, ctx);
    },
  },

  /** Rotate a step in a direction; `zoom` scales the step size (1.0 = the default step). */
  rotate: method(
    ({ ctx, sink }) =>
      (direction: PtzDirection, zoom = 1.0): Promise<void> =>
        sink.dispatch(rotateCommand(direction, ctx, zoom)),
    "Rotate a step in a direction.",
  ),
  /** Rotate one step left. */
  left: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(rotateCommand("left", ctx)),
    "Rotate left.",
  ),
  /** Rotate one step right. */
  right: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(rotateCommand("right", ctx)),
    "Rotate right.",
  ),
  /** Rotate one step up. */
  up: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(rotateCommand("up", ctx)),
    "Rotate up.",
  ),
  /** Rotate one step down. */
  down: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(rotateCommand("down", ctx)),
    "Rotate down.",
  ),

  /**
   * Zoom rides a SECOND (telephoto) lens, so it is offered only where the device shows zoom evidence —
   * otherwise `dev.ptz()?.zoom` would be a silent no-op on a single-lens pan-tilt camera.
   */
  zoom: method(
    ({ ctx, sink }) =>
      (dstZoom: number, region?: ZoomRegion): Promise<void> =>
        sink.dispatch(zoomCommand(dstZoom, ctx, region)),
    "Zoom the telephoto lens.",
    hasZoomEvidence,
  ),

  /**
   * The preset sub-API. Write verbs dispatch through the sink; the READ verbs (`list`/`image`) are P2P
   * request/reply and exist only when bound to a media provider — the transport stays
   * capability-agnostic (it runs a generic control-payload query and resolves the correlated notify)
   * while this module owns the sub-command id and the reply parsing.
   *
   * `answers` because calling it performs nothing: it hands back the namespace the verbs live on. Offering
   * it as a control would produce one that returns an object and does nothing.
   */
  preset: {
    ...method(
      ({ ctx, sink, media }) =>
        (): PtzPresetActions => {
          const p: PtzPresetActions = {
            goto: (id: number) => sink.dispatch(gotoPresetCommand(id, ctx)),
            preview: (id: number) => sink.dispatch(previewPresetCommand(id, ctx)),
            save: async (id: number) => {
              for (const cmd of savePresetCommand(id, ctx)) await sink.dispatch(cmd);
            },
            setDefault: (id: number) => sink.dispatch(setDefaultPositionCommand(id, ctx)),
            delete: (id: number) => sink.dispatch(deletePresetCommand(id, ctx)),
          };
          if (media?.p2pControlQuery) {
            p.list = async (opts) =>
              parsePresetPoints(await media.p2pControlQuery!(PTZ_CMD.PTZ_PRESET_QUERY, { value: 0 }, opts));
            p.image = async (id, opts) =>
              parsePresetImage(await media.p2pControlQuery!(PTZ_CMD.PTZ_PRESET_PIC, { value: id }, opts));
          }
          return p;
        },
      "The preset sub-API: goto/preview/save/setDefault/delete, plus list/image when bound.",
    ),
    answers: true,
  },
} as const satisfies Members;

export const PTZ: CapabilityModule = {
  capability: "ptz",
  description:
    "Pan/tilt (PTZ) control. Movement is command-driven and rotate speed is stored; position arrives " +
    "as a live event.",
  /**
   * The intent route for the movement verbs — kept alongside the member table because these are
   * ARGUMENT-TAKING verbs, not property writes: `rotate` takes a direction, the preset verbs take an id.
   * A member's `write` moves one named value, so it cannot name them, and dropping this would silently
   * remove `setProperty("gotoPreset", 2)` from the low-level path. Each case delegates to the same
   * builder the fluent method uses, so the two cannot drift. Zoom carries the same dual-lens gate the
   * fluent `zoom` member does.
   */
  buildCommand(action: string, value: boolean | number | string, ctx: CommandContext): Command | undefined {
    if (action === "rotate" && isDirection(value)) return rotateCommand(value, ctx);
    if (typeof value === "number") {
      if (action === "zoom") return hasZoomEvidence(ctx) ? zoomCommand(value, ctx) : undefined;
      if (action === "gotoPreset") return gotoPresetCommand(value, ctx);
      if (action === "previewPreset") return previewPresetCommand(value, ctx);
      if (action === "deletePreset") return deletePresetCommand(value, ctx);
      if (action === "setDefaultPosition") return setDefaultPositionCommand(value, ctx);
    }
    return undefined;
  },
  members: PTZ_MEMBERS,
  properties: propertiesOf(PTZ_MEMBERS),
  // SoloCam proves PT via reported preset params (6090/6091/6092/6210) and a rotate command surface
  // (1029); Indoor-PT (deviceType 31/35/111 + C220 range 10008-10011) reports NO PT param, so the
  // vendor deviceType is the only honest signal; explicit PT/S340/S350 model names also prove it.
  // OUTDOOR_PT_CAMERA (48, e.g. SoloCam S340 / T8170) is pan-tilt by definition but a live unit can
  // report none of the preset params — trust the deviceType. The rotating SoloCam solar variant
  // T8124R shares deviceType 62 with the FIXED T8124 base, so its model code is the only honest
  // signal that separates the two. Match ONLY confirmed rotating model codes here — do NOT widen to
  // a `T81\d\dR` wildcard: the "R = rotating" reading is unverified for other models, and an
  // over-broad hint would false-positive a future non-PT model, the same class of bug as a mislabel.
  detection: {
    evidenceParams: [1029, 6090, 6091, 6092, 6210],
    deviceTypes: [
      DeviceType.OUTDOOR_PT_CAMERA,
      DeviceType.INDOOR_PT_CAMERA,
      DeviceType.INDOOR_PT_CAMERA_1080,
      DeviceType.CAMERA_4G_S330,
      DeviceType.INDOOR_PT_CAMERA_C220,
      DeviceType.INDOOR_PT_CAMERA_C210,
      DeviceType.INDOOR_PT_CAMERA_C220_V2,
      DeviceType.INDOOR_PT_CAMERA_C220_V3,
      // T8425 has its own dedicated deviceType (47), distinct from OUTDOOR_PT_CAMERA (48) — easy to
      // miss since the name doesn't say "PT". Was omitted here despite T8425 being the hardware that
      // grounded the rotate_type wire mapping (see PTZ_ROTATE's doc comment) — confirmed live it has
      // no PTZ capability without this, on a real owned unit.
      DeviceType.FLOODLIGHT_CAMERA_8425,
    ],
    modelHints: [/pan.?tilt|\bpt\b|S3[45]0|indoor.?pt/i],
  },
  emits: ["ptzNotify"],
  /**
   * Surface PTZ status the camera streams back while it moves. Two wire shapes (both prove pan-tilt):
   *  - SoloCam: `CMD_NOTIFY_PAYLOAD` (1351) JSON `{cmd, payload}` with cmd 6030 (rotate) / 6203 (zoom).
   *  - Indoor PT: `CMD_DOORBELL_SET_PAYLOAD` (1700) binary 24-byte records of float `(pan, tilt)`
   *    (non-zero while moving; a fixed camera sends zeros).
   * `stationSn` is added by the barrel, so it is NOT included in the returned payload.
   */
  decodeEvent(signal: InboundSignal): CapabilityEvent | null {
    if (signal.source !== "p2p-frame") return null; // PTZ status is a live P2P frame only
    const f = signal;
    // JSON notify (SoloCam): cmd 6030 rotate / 6203 zoom.
    if (
      f.commandId === PTZ_FRAME.NOTIFY_PAYLOAD &&
      f.json &&
      typeof f.json.cmd === "number" &&
      (f.json.cmd === PTZ_CMD.PTZ_ROTATE || f.json.cmd === PTZ_CMD.PTZ_ZOOM)
    ) {
      return {
        event: "ptzNotify",
        payload: { kind: f.json.cmd === PTZ_CMD.PTZ_ZOOM ? "zoom" : "rotate", payload: f.json.payload },
      };
    }
    // Binary position stream (Indoor PT): 1700 with 24-byte records of float (pan, tilt) after a
    // 4-byte header. Emit only when a coordinate is non-zero (a fixed camera streams all-zero).
    if (f.commandId === PTZ_FRAME.CONTROL_PAYLOAD && f.data && f.data.length >= 28) {
      const coords: Array<[number, number]> = [];
      for (let o = 4; o + 24 <= f.data.length; o += 24) {
        const pan = f.data.readFloatLE(o + 12);
        const tilt = f.data.readFloatLE(o + 16);
        if (Number.isFinite(pan) && Number.isFinite(tilt) && Math.abs(pan) <= 2 && Math.abs(tilt) <= 2) {
          coords.push([pan, tilt]);
        }
      }
      if (coords.some(([p, t]) => p !== 0 || t !== 0)) {
        return { event: "ptzNotify", payload: { kind: "position", coords } };
      }
    }
    return null;
  },
};
